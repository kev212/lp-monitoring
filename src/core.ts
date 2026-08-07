import { Connection, PublicKey } from '@solana/web3.js'
import { config } from './config.js'
import { getConnection, withValuationFallback } from './solana/connection.js'
import { loadWallet, getWallet } from './solana/wallet.js'
import { getDb } from './db/client.js'
import {
  loadKnownPositions,
  loadActivePositions,
  upsertPosition,
  updatePositionStatus,
  updatePositionBasisIfHigher,
  updatePositionPnl,
  updatePositionConfirmations,
  updatePeakPnl,
  updatePositionStrategy,
  updatePrecisionCurveBusy,
  updatePrecisionCurveState,
  updatePrecisionCurveRangeHalf,
  updatePrecisionCurveMovementLog,
  updatePrecisionCurveRecoveryUntil,
  updateDrawdownTpOverride,
  updateFlipModeBusy,
  updateFlipModeState,
  updateFlipModeRecoveryUntil,
  setFlipModePendingAdd,
  updateFlipModePendingAttempt,
  updateFlipModePendingAmount,
  clearFlipModePendingAdd,
  updateAutoRebalanceEnabled,
  updateRebalanceOorSince,
  updateRebalanceBusy,
  updateRebalanceState,
} from './meteora/discovery.js'
import {
  getAllPositionsForWallet,
  getPool,
  getPoolInfo,
} from './meteora/positions.js'
import { calculatePnlPercent, clearPnlCache, estimateExitValue, getQuoteCurrency, type ValuationResult } from './meteora/valuation.js'
import { fetchLpAgentPositions, type LpAgentPosition } from './lpagent.js'
import {
  acknowledgeExitCompletionNotification,
  executeExit,
  listPendingExitNotifications,
  reconcilePendingExits,
} from './meteora/exit.js'
import { reconcilePendingOpens } from './meteora/open.js'
import { executeRebalanceOpen } from './meteora/open.js'
import { isOorAbove, listRebalanceReopenIntents, persistRebalanceReopenIntent, rebalanceCloseDisposition, rebalanceTimerStatus, reconcilePendingRebalanceOpens } from './meteora/rebalance.js'
import { executeDirectionalPrecisionCurve, THRESHOLD_RATIO, THRESHOLD_MIN, RECOVERY_MS } from './meteora/precisionCurve.js'
import { calculateFlipProgressPct, executeFlipMode, retryPendingFlipAdd } from './meteora/flipMode.js'
import { evaluateTrigger, type BinData } from './risk/rules.js'
import { effectiveRiskSettings, getRiskSettings } from './risk/settings.js'
import {
  sendNotification,
  sendNotificationAsync,
  formatPositionDiscovered,
  formatExitStarted,
  formatExitSuccess,
  formatExitReconciled,
  formatExitFailed,
  formatBotStart,
  formatBotStop,
} from './telegram.js'
import type { PositionRow, BasisConfidence, QuoteCurrency, TriggerType, StrategyType } from './types.js'
import {
  getWalletOperation,
  reconcileDurableReshapeOperation,
  reconcileOrphanExitIntent,
  withDurableWalletOperation,
  withWalletExecutionLock,
} from './executionLock.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

let running = false
let exitCooldowns = new Map<string, number>()
let lastDiscoveryTime = 0
let monitorRetries = new Map<string, number>()
const pendingTriggers = new Map<string, { triggerType: TriggerType; timestamp: number; pnlAtTrigger: number }>()
const DISCOVERY_INTERVAL_MS = 1 * 60 * 1000 // 1 menit
const MAX_MONITOR_RETRIES = 5
const PRECISION_CURVE_COOLDOWN_MS = 5_000
const FLIP_MODE_RECOVERY_MS = 10_000
const LP_AGENT_GUARD_MIN_INTERVAL_MS = 12_500
const TRAILING_FAST_POLL_MS = 1_000
const TRAILING_RECHECK_DELAY_MS = 1_500
let lastLpAgentGuardAt = 0
const lastProcessedValuationAt = new Map<string, number>()
let lastExitRecoveryAt = 0

function lpAgentPnl(position: LpAgentPosition): number {
  return position.pnlPercentNative
}

function pnlFromValuation(
  valuation: ValuationResult,
  position: Pick<PositionRow, 'basisQuote' | 'flipModeEnabled' | 'flipModePendingAdd'>,
): { pnlPercent: number; source: string } {
  return calculatePnlPercent(
    valuation,
    position.basisQuote,
    position.flipModeEnabled || position.flipModePendingAdd,
  )
}

function formatQuoteLog(value: number, quoteCurrency: QuoteCurrency): string {
  return quoteCurrency === 'USDC'
    ? `${value.toFixed(2)} USDC`
    : `${value.toFixed(6)} SOL`
}

async function flushExitCompletionNotifications(): Promise<void> {
  for (const notification of listPendingExitNotifications()) {
    const delivered = await sendNotificationAsync(formatExitReconciled(notification))
    if (delivered) acknowledgeExitCompletionNotification(notification.executionId)
  }
}

function notifyOpenReconcileFailures(summary: { failed: number }): void {
  if (summary.failed <= 0) return
  console.log(`[open] reconciliation failed ${summary.failed} open attempt(s)`)
  sendNotification(
    `⚠️ <b>Open Reconciliation Failed</b>\n\n` +
    `${summary.failed} open attempt(s) did not finalize on-chain.\n` +
    `The opening position was removed from the active list.\n` +
    `Review the wallet before opening again.`
  )
}

export async function startBot(): Promise<void> {
  console.log('[app] starting monitoring-lp...')
  running = true

  loadWallet()
  const wallet = getWallet()
  const walletPubkey = wallet.publicKey
  const ownerStr = walletPubkey.toBase58()

  reconcileOrphanExitIntent(ownerStr)
  const reshapeRecovery = await reconcileDurableReshapeOperation(getConnection(), ownerStr)
  if (reshapeRecovery === 'review') console.log('[reshape] recovered transaction requires manual position review')
  await reconcilePendingExits(getConnection(), wallet)
  await flushExitCompletionNotifications()
  notifyOpenReconcileFailures(await reconcilePendingOpens(getConnection()))
  await reconcilePendingRebalanceOpens(getConnection(), wallet)
  const pendingRebalancePositions = new Set(listRebalanceReopenIntents().map(intent => intent.positionPubkey))
  for (const position of loadKnownPositions().filter(p => p.rebalanceBusy && p.status === 'closed' && !pendingRebalancePositions.has(p.positionPubkey))) {
    updateRebalanceBusy(position.positionPubkey, false)
    const pair = `${position.tokenXSymbol || position.tokenXMint.slice(0, 4)}/${position.tokenYSymbol || position.tokenYMint.slice(0, 4)}`
    console.log(`[rebalance] ${pair} | interrupted rebalance recovered; position closed with funds in wallet`)
    sendNotification(
      `⚠️ <b>Auto Rebalance Interrupted</b>\n\n` +
      `<b>${pair}</b>\n` +
      `Position was closed during a rebalance but the process stopped before reopening.\n` +
      `Funds are safe in the wallet. Reopen manually or wait for discovery to register a new position.`
    )
  }
  lastExitRecoveryAt = Date.now()
  const riskSettings = getRiskSettings()
  sendNotification(formatBotStart(walletPubkey.toBase58(), 0, riskSettings))
  // Balance will be fetched in first cycle

  await discoverInitialPositions(getConnection(), walletPubkey, ownerStr)
  await redetectStrategies(ownerStr)
  lastDiscoveryTime = Date.now() // start timer dari sini

  while (running) {
    try {
      const loopNow = Date.now()
      if (loopNow - lastExitRecoveryAt >= config.exitRecoveryPollMs) {
        lastExitRecoveryAt = loopNow
        await reconcilePendingExits(getConnection(), wallet)
        await reconcilePendingRebalanceOpens(getConnection(), wallet)
        await flushExitCompletionNotifications()
      }

      // Periodic discovery — every 5 menit
      const now = Date.now()
      if (now - lastDiscoveryTime >= DISCOVERY_INTERVAL_MS) {
        lastDiscoveryTime = now
        reconcileOrphanExitIntent(ownerStr)
        const reshapeRecovery = await reconcileDurableReshapeOperation(getConnection(), ownerStr)
        if (reshapeRecovery === 'review') {
          sendNotification('🚨 <b>Reshape Recovery Requires Review</b>\n\nA finalized partial Flip/Precision transaction was recovered after restart. The position was marked error to prevent duplicate wallet mutations.')
        }
        notifyOpenReconcileFailures(await reconcilePendingOpens(getConnection()))
        await discoverInitialPositions(getConnection(), walletPubkey, ownerStr)
      }

      // Skip monitoring kalo gak ada posisi aktif
      const activePositions = loadActivePositions()
      if (activePositions.length === 0) {
        // Gak ada posisi → tidur sampe discovery berikutnya
        const nextDiscovery = DISCOVERY_INTERVAL_MS - (Date.now() - lastDiscoveryTime)
        const nextExitRecovery = config.exitRecoveryPollMs - (Date.now() - lastExitRecoveryAt)
        await sleep(Math.max(Math.min(nextDiscovery, nextExitRecovery), 500))
        continue
      }

      await monitorCycle(getConnection(), walletPubkey, ownerStr)
      const riskSettings = getRiskSettings()
      const fastTrailingPosition = riskSettings.trailingEnabled
        && loadActivePositions().some(pos => pos.trailingActivated || pendingTriggers.has(pos.positionPubkey))
      await sleep(fastTrailingPosition ? TRAILING_FAST_POLL_MS : config.pollIntervalMs)
    } catch (err) {
      console.log(`[loop] cycle error: ${err instanceof Error ? err.message : 'unknown'}`)
      if (err instanceof Error && err.stack) {
        console.log(`[loop] stack: ${err.stack.split('\n').slice(0, 5).join('\n')}`)
      }
    }
  }
}

export function stopBot(): void {
  running = false
  sendNotification(formatBotStop())
}

async function discoverInitialPositions(connection: Connection, walletPubkey: PublicKey, ownerStr: string): Promise<void> {
  console.log('[discovery] scanning for DLMM positions...')
  const discovered = await getAllPositionsForWallet(connection, walletPubkey)
  const riskSettings = getRiskSettings()
  console.log(`[discovery] found ${discovered.length} positions`)

  for (const dp of discovered) {
    const existing = loadKnownPositions().find(p => p.positionPubkey === dp.positionPubkey)
    if (existing) {
      continue
    }

    try {
      // Use API metadata when present; mints and decimals are authoritative on-chain.
      let tokenXMint = dp.tokenXMint
      let tokenYMint = dp.tokenYMint
      let tokenXSymbol = dp.tokenXSymbol
      let tokenYSymbol = dp.tokenYSymbol

      if (!tokenXMint || !tokenYMint) {
        const pool = await getPool(connection, new PublicKey(dp.poolPubkey))
        tokenXMint = (pool.tokenX as any).publicKey?.toBase58?.() || (pool.lbPair as any).tokenXMint?.toBase58?.() || ''
        tokenYMint = (pool.tokenY as any).publicKey?.toBase58?.() || (pool.lbPair as any).tokenYMint?.toBase58?.() || ''
        const poolInfo = await getPoolInfo(dp.poolPubkey)
        if (!tokenXSymbol) tokenXSymbol = poolInfo.tokenXSymbol
        if (!tokenYSymbol) tokenYSymbol = poolInfo.tokenYSymbol
        if (!tokenXMint || !tokenYMint) {
          console.log(`[discovery] ${dp.positionPubkey.slice(0, 8)} — no token mints, skipping`)
          continue
        }
      }

      const quoteCurrency = getQuoteCurrency(tokenXMint, tokenYMint)
      if (!quoteCurrency) {
        console.log(`[discovery] ${dp.positionPubkey.slice(0, 8)} — unsupported quote, expected SOL or USDC`)
        continue
      }

      let currentValue = 0
      let finalBasis = 0
      let pnlPct = 0
      let val: Awaited<ReturnType<typeof estimateExitValue>> = null
      try {
        val = await estimateExitValue(dp.poolPubkey, ownerStr, dp.positionPubkey, quoteCurrency)
        currentValue = val?.estimatedExitQuote || 0
        finalBasis = val?.depositQuote || 0
        pnlPct = val?.pnlPercent || 0
      } catch {
        // Position remains discoverable; monitoring retries Meteora valuation.
      }

      const finalConfidence: BasisConfidence = finalBasis > 0 ? 'medium' : 'low'

      const finalTokenXSymbol = tokenXSymbol || tokenXMint.slice(0, 4)
      const finalTokenYSymbol = tokenYSymbol || tokenYMint.slice(0, 4)

      // --- Strategy detection from LP Agent deposit data ---
      let strategy: StrategyType = 'unknown'
      const tpPercent = riskSettings.tpPercent
      const slPercent = riskSettings.slPercent

      try {
        const lpAgentPositions = await fetchLpAgentPositions(ownerStr, true)
        if (lpAgentPositions) {
          const lpPos = lpAgentPositions.get(dp.positionPubkey)
          if (lpPos) {
            const input0 = lpPos.inputToken0
            const input1 = lpPos.inputToken1
            const mint0 = lpPos.token0
            const mint1 = lpPos.token1

            // Identify which token is SOL or USDC (the quote/native side)
            const mint0IsQuote = mint0 === SOL_MINT || mint0 === USDC_MINT
            const mint1IsQuote = mint1 === SOL_MINT || mint1 === USDC_MINT

            let quoteAmount = 0
            let tokenAmount = 0

            if (mint0IsQuote) {
              quoteAmount = Number(input0) || 0
              tokenAmount = Number(input1) || 0
            } else if (mint1IsQuote) {
              quoteAmount = Number(input1) || 0
              tokenAmount = Number(input0) || 0
            }

            if (quoteAmount > 0 && tokenAmount === 0) {
              strategy = 'single_side_quote'
            } else if (quoteAmount === 0 && tokenAmount > 0) {
              strategy = 'single_side_token'
            } else if (quoteAmount > 0 && tokenAmount > 0) {
              strategy = 'balanced'
            } else {
              strategy = 'unknown'
            }

            console.log(`[discovery] ${dp.positionPubkey.slice(0, 8)} | strategy: ${strategy} | quote=${quoteAmount} token=${tokenAmount} | SL: ${slPercent}% TP: ${tpPercent}%`)
          }
        }
      } catch {
        // LP Agent check failed, use defaults
      }

      let flipModeEnabled = false

      upsertPosition({
        positionPubkey: dp.positionPubkey,
        poolPubkey: dp.poolPubkey,
        tokenXMint,
        tokenYMint,
        tokenXSymbol: finalTokenXSymbol,
        tokenYSymbol: finalTokenYSymbol,
        owner: ownerStr,
        quoteCurrency,
        basisQuote: finalBasis,
        basisSolLegacy: val?.depositSol || 0,
        basisConfidence: finalConfidence,
        tpPercent,
        slPercent,
        status: finalBasis > 0 ? 'monitoring' : 'discovering',
        triggerConfirmations: 0,
        peakPnlPercent: 0,
        trailingActivated: false,
        lastPnlPercent: null,
        lastEstimatedExitQuote: null,
        lastEstimatedExitSolLegacy: null,
        lastSeenAt: Date.now(),
        strategy,
        flipModeEnabled,
      })

      sendNotification(formatPositionDiscovered(
        dp.positionPubkey, dp.poolPubkey, finalBasis, finalConfidence,
        finalTokenXSymbol,
        finalTokenYSymbol,
        currentValue, pnlPct, val?.pnlQuote || 0, quoteCurrency, val?.solUsdPrice || 0, ownerStr,
        val?.tokenXAmount, val?.tokenYAmount,
        val?.tokenXFees, val?.tokenYFees,
        strategy, slPercent, tpPercent,
        flipModeEnabled
      ))
      const isDupeDiscovery = loadKnownPositions().some(p => p.tokenXMint === tokenXMint && p.positionPubkey !== dp.positionPubkey)
      const dupMarkerDisc = isDupeDiscovery ? ' [DUPE-TOKEN]' : ''
      console.log(`[discovery] registered position ${dp.positionPubkey.slice(0, 8)}${dupMarkerDisc} strategy=${strategy} quote=${quoteCurrency} SL=${slPercent}% TP=${tpPercent}% basis=${formatQuoteLog(finalBasis, quoteCurrency)}${finalBasis > 0 ? '' : ' (pending)'}`)
    } catch (err) {
      console.log(`[discovery] failed on ${dp.positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
}

async function redetectStrategies(ownerStr: string): Promise<void> {
  const unknownPositions = loadKnownPositions().filter(p => p.strategy === 'unknown' && (p.status === 'monitoring' || p.status === 'discovering'))
  if (unknownPositions.length === 0) return

  console.log(`[strategy] redetecting ${unknownPositions.length} positions with unknown strategy...`)
  try {
    const lpAgentPositions = await fetchLpAgentPositions(ownerStr, true)
    if (!lpAgentPositions) {
      console.log('[strategy] LP Agent unavailable, skipping redetect')
      return
    }

    for (const pos of unknownPositions) {
      const lpPos = lpAgentPositions.get(pos.positionPubkey)
      if (!lpPos) {
        console.log(`[strategy] ${pos.positionPubkey.slice(0, 8)} — no LP Agent data, keeping unknown`)
        continue
      }

      const mint0IsQuote = lpPos.token0 === SOL_MINT || lpPos.token0 === USDC_MINT
      const mint1IsQuote = lpPos.token1 === SOL_MINT || lpPos.token1 === USDC_MINT

      let quoteAmount = 0
      let tokenAmount = 0
      if (mint0IsQuote) {
        quoteAmount = Number(lpPos.inputToken0) || 0
        tokenAmount = Number(lpPos.inputToken1) || 0
      } else if (mint1IsQuote) {
        quoteAmount = Number(lpPos.inputToken1) || 0
        tokenAmount = Number(lpPos.inputToken0) || 0
      }

      let strategy: StrategyType = 'unknown'

      if (quoteAmount > 0 && tokenAmount === 0) {
        strategy = 'single_side_quote'
      } else if (quoteAmount === 0 && tokenAmount > 0) {
        strategy = 'single_side_token'
      } else if (quoteAmount > 0 && tokenAmount > 0) {
        strategy = 'balanced'
      }

      updatePositionStrategy(pos.positionPubkey, strategy)
      console.log(`[strategy] ${pos.tokenXSymbol}/${pos.tokenYSymbol} → ${strategy}`)
    }
  } catch (err) {
    console.log(`[strategy] redetect error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

async function monitorSinglePosition(
  connection: Connection,
  walletPubkey: PublicKey,
  ownerStr: string,
  pos: PositionRow,
  tokenPositions: Map<string, number>,
): Promise<void> {
  if (pos.status === 'exiting') {
    if (pos.positionPubkey) {
      checkExitCooldown(pos.positionPubkey)
    }
    return
  }

  try {
    const riskSettings = getRiskSettings()
    const forceFreshValuation = (riskSettings.trailingEnabled && pos.trailingActivated) || pendingTriggers.has(pos.positionPubkey)
    const valuation = await estimateExitValue(pos.poolPubkey, ownerStr, pos.positionPubkey, pos.quoteCurrency, forceFreshValuation)
    if (!valuation) {
      const retryCount = (monitorRetries.get(pos.positionPubkey) || 0) + 1
      if (retryCount >= MAX_MONITOR_RETRIES) {
        monitorRetries.set(pos.positionPubkey, retryCount)
        try {
          const account = await withValuationFallback(connection => connection.getAccountInfo(new PublicKey(pos.positionPubkey)))
          if (!account) {
            updatePositionStatus(pos.positionPubkey, 'closed')
            monitorRetries.delete(pos.positionPubkey)
            lastProcessedValuationAt.delete(pos.positionPubkey)
            console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | position account absent on-chain — marked closed`)
            return
          }
        } catch (err) {
          console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | on-chain presence check failed: ${err instanceof Error ? err.message : 'unknown'}`)
        }
        console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | on-chain valuation unavailable ${retryCount}x — triggers paused`)
      } else {
        monitorRetries.set(pos.positionPubkey, retryCount)
        console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | on-chain valuation unavailable (${retryCount}/${MAX_MONITOR_RETRIES}) — triggers paused`)
      }
      return
    }
    monitorRetries.delete(pos.positionPubkey)

    const previousBasis = pos.basisQuote
    if (updatePositionBasisIfHigher(pos.positionPubkey, pos.quoteCurrency, valuation.depositQuote)) {
      pos.basisQuote = valuation.depositQuote
      if (pos.basisConfidence !== 'high') pos.basisConfidence = 'medium'
      console.log(`[basis] ${pos.positionPubkey.slice(0, 8)} | ${formatQuoteLog(previousBasis, pos.quoteCurrency)} -> ${formatQuoteLog(pos.basisQuote, pos.quoteCurrency)} from Meteora all-time deposits`)
    }

    if (pos.basisQuote <= 0) {
      updatePositionPnl(pos.positionPubkey, 0, valuation.estimatedExitQuote, pos.quoteCurrency)
      console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | deposit basis pending — PnL triggers paused | Value: ${formatQuoteLog(valuation.estimatedExitQuote, pos.quoteCurrency)}`)
      return
    }

    const { pnlPercent, source: pnlSource } = pnlFromValuation(valuation, pos)

    updatePositionPnl(pos.positionPubkey, pnlPercent, valuation.estimatedExitQuote, pos.quoteCurrency)

    // A cached quote must not satisfy multiple trigger confirmations.
    const isNewValuation = lastProcessedValuationAt.get(pos.positionPubkey) !== valuation.observedAt
    if (isNewValuation) lastProcessedValuationAt.set(pos.positionPubkey, valuation.observedAt)

    // ── PnL log ──
    const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
    const isDupe = (tokenPositions.get(pos.tokenXMint) || 0) > 1
    const dupMarker = isDupe ? ' [DUPE-TOKEN]' : ''
    const pnlSign = pnlPercent >= 0 ? '+' : ''
    const triggerInfo = pos.triggerConfirmations > 0
      ? `Conf: ${pos.triggerConfirmations}/${config.triggerConfirmations}`
      : 'Conf: 0'
    const effectiveTp = pos.drawdownTpOverrideActive
      ? riskSettings.ddLockTpPercent
      : riskSettings.tpPercent
    console.log(
      `[monitor] ${tokenLabel}${dupMarker} | ${pos.status} | PnL: ${pnlSign}${pnlPercent.toFixed(2)}% (${pnlSource})` +
      ` | Value: ${formatQuoteLog(valuation.estimatedExitQuote, pos.quoteCurrency)}` +
      ` | Withdrawn: ${formatQuoteLog(valuation.withdrawalQuote, pos.quoteCurrency)}` +
      ` | Basis: ${formatQuoteLog(pos.basisQuote, pos.quoteCurrency)}` +
      ` | SL: ${riskSettings.slPercent}% TP: +${effectiveTp}%${pos.drawdownTpOverrideActive ? ' (DD LOCK)' : ''}` +
      ` | Peak: ${pos.peakPnlPercent.toFixed(2)}%` +
      ` | ${triggerInfo}`
    )

    if (!isNewValuation) return

    const now = Date.now()
    const reshapeUnstable =
      pos.precisionCurveBusy ||
      (pos.precisionCurveRecoveryUntil ?? 0) > now ||
      pos.flipModeBusy ||
      pos.flipModePendingAdd ||
      (pos.flipModeRecoveryUntil ?? 0) > now

    // --- LP Agent Spike Guard ---
    let canTrustPeak = true
    if (pos.precisionCurveEnabled || pos.flipModeEnabled || pos.flipModePendingAdd) {
      // reshaped positions: skip spike guard
    } else if (pnlPercent > 0) {
      const spikeFromPeak = pnlPercent > pos.peakPnlPercent + 5
      const spikeFromLast = pos.lastPnlPercent !== null && (pnlPercent - pos.lastPnlPercent) > 5
      const activationCross = pos.lastPnlPercent !== null &&
        pos.lastPnlPercent < riskSettings.trailingActivationPct - 2 &&
        pnlPercent >= riskSettings.trailingActivationPct
      const suspiciousSpike = spikeFromPeak || spikeFromLast || activationCross

      if (suspiciousSpike && config.lpAgentApiKey) {
        const now = Date.now()
        if (now - lastLpAgentGuardAt >= LP_AGENT_GUARD_MIN_INTERVAL_MS) {
          lastLpAgentGuardAt = now
          try {
            const lpAgentPositions = await fetchLpAgentPositions(ownerStr)
            if (lpAgentPositions) {
              const lpPos = lpAgentPositions.get(pos.positionPubkey)
              if (lpPos) {
                const lpPnl = lpAgentPnl(lpPos)
                const delta = Math.abs(pnlPercent - lpPnl)
                if (delta > 3 && lpPnl < riskSettings.trailingActivationPct) {
                  console.log(`[peak-guard] ${tokenLabel} | blocked spike: on-chain=${pnlPercent.toFixed(2)}% vs lpagent=${lpPnl.toFixed(2)}% (delta=${delta.toFixed(1)}%)`)
                  canTrustPeak = false
                }
              }
            }
          } catch {
            console.log(`[peak-guard] ${tokenLabel} | suspicious spike ${pnlPercent.toFixed(2)}% — LP Agent unavailable, peak frozen`)
            canTrustPeak = false
          }
        } else {
          console.log(`[peak-guard] ${tokenLabel} | suspicious spike ${pnlPercent.toFixed(2)}% — LP Agent budget exhausted, peak frozen`)
          canTrustPeak = false
        }
      }
    }

    // Freeze peak during precision curve busy or recovery window
    if (pos.precisionCurveEnabled) {
      const recoveryUntil = pos.precisionCurveRecoveryUntil ?? 0
      if (pos.precisionCurveBusy || Date.now() < recoveryUntil) {
        canTrustPeak = false
      }
    }

    if (pos.flipModeEnabled || pos.flipModePendingAdd) {
      const recoveryUntil = pos.flipModeRecoveryUntil ?? 0
      if (pos.flipModeBusy || pos.flipModePendingAdd || Date.now() < recoveryUntil) {
        canTrustPeak = false
      }
    }

    // --- Trailing stop: track peak PnL ---
    let updatedPeak = pos.peakPnlPercent
    let trailingActive = riskSettings.trailingEnabled && pos.trailingActivated
    let peakOrTrailingChanged = false

    if (riskSettings.trailingEnabled && canTrustPeak && !trailingActive && pnlPercent >= riskSettings.trailingActivationPct) {
      trailingActive = true
      peakOrTrailingChanged = true
      console.log(`[trailing] activated for ${pos.positionPubkey.slice(0, 8)} at ${pnlPercent.toFixed(2)}%`)
    }

    if (riskSettings.trailingEnabled && canTrustPeak && pnlPercent > updatedPeak) {
      updatedPeak = pnlPercent
      peakOrTrailingChanged = true
    }

    if (riskSettings.trailingEnabled && canTrustPeak && pnlPercent <= 0) {
      updatedPeak = 0
      trailingActive = false
      peakOrTrailingChanged = true
    }

    if (!riskSettings.trailingEnabled && (pos.trailingActivated || pos.peakPnlPercent !== 0)) {
      updatedPeak = 0
      trailingActive = false
      peakOrTrailingChanged = true
    }

    if (peakOrTrailingChanged) {
      updatePeakPnl(pos.positionPubkey, updatedPeak, trailingActive)
      pos.peakPnlPercent = updatedPeak
      pos.trailingActivated = trailingActive
    }
    // --- end trailing ---

    // --- Drawdown TP lock ---
    if (!reshapeUnstable && !pos.drawdownTpOverrideActive && pnlPercent <= config.maxDrawdownThreshold) {
      pos.drawdownTpOverrideActive = true
      updateDrawdownTpOverride(pos.positionPubkey, true)
      console.log(`[drawdown] ${tokenLabel} | TP LOCKED to ${riskSettings.ddLockTpPercent}% (PnL ${pnlPercent.toFixed(2)}% <= ${config.maxDrawdownThreshold}%)`)
    }

    const binData: BinData = {
      upperBinId: valuation.upperBinId,
      poolActiveBinId: valuation.poolActiveBinId,
    }

    const flipHandled = await maybeRunFlipMode(pos, valuation.lowerBinId, valuation.upperBinId, valuation.poolActiveBinId)
    if (flipHandled) {
      pendingTriggers.delete(pos.positionPubkey)
      if (pos.triggerConfirmations > 0) updatePositionConfirmations(pos.positionPubkey, 0)
      return
    }

    const precisionHandled = await maybeRunPrecisionCurve(pos, valuation.lowerBinId, valuation.upperBinId, valuation.poolActiveBinId)
    if (precisionHandled) {
      pendingTriggers.delete(pos.positionPubkey)
      if (pos.triggerConfirmations > 0) updatePositionConfirmations(pos.positionPubkey, 0)
      return
    }

    if (reshapeUnstable) {
      pendingTriggers.delete(pos.positionPubkey)
      if (pos.triggerConfirmations > 0) updatePositionConfirmations(pos.positionPubkey, 0)
      console.log(`[monitor] ${tokenLabel} | reshape busy/recovery — PnL exits paused`)
      return
    }

    const rebalanceHandled = await maybeRunAutoRebalance(pos, valuation)
    if (rebalanceHandled) {
      pendingTriggers.delete(pos.positionPubkey)
      if (pos.triggerConfirmations > 0) updatePositionConfirmations(pos.positionPubkey, 0)
      return
    }

    const decision = evaluateTrigger(pos, pnlPercent, binData, effectiveRiskSettings(riskSettings, pos))
    if (decision.shouldTrigger && decision.triggerType) {
      let triggerType = decision.triggerType
      // LP Agent is diagnostic only; on-chain valuation remains authoritative.
      let lpAgentAtTrigger: LpAgentPosition | null = null
      try {
        const lpAgentPositions = await fetchLpAgentPositions(ownerStr)
        if (lpAgentPositions) {
          const lpPos = lpAgentPositions.get(pos.positionPubkey)
          if (lpPos) {
            lpAgentAtTrigger = lpPos
            const lpPnl = lpAgentPnl(lpPos)
            const diff = Math.abs(pnlPercent - lpPnl)
            if (diff > 3) {
              console.log(`[recheck] ${tokenLabel} | LP Agent delta: on-chain=${pnlPercent.toFixed(2)}% vs lpagent=${lpPnl.toFixed(2)}% (diff=${diff.toFixed(1)}%)`)
            }
          }
        }
      } catch {
        // Local trigger does not depend on LP Agent availability.
      }

      // --- Re-check with delay ---
      const recheckDelayMs = triggerType === 'TRAILING_STOP'
        ? TRAILING_RECHECK_DELAY_MS
        : config.recheckDelayMs
      let pending = pendingTriggers.get(pos.positionPubkey)

      if (!pending) {
        pending = {
          triggerType: decision.triggerType,
          timestamp: Date.now(),
          pnlAtTrigger: pnlPercent,
        }
        pendingTriggers.set(pos.positionPubkey, pending)
        console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} triggered at ${pnlPercent.toFixed(2)}% — waiting ${recheckDelayMs}ms for confirmation`)
        if (triggerType !== 'TRAILING_STOP') return
        await sleep(recheckDelayMs)
      }

      const elapsed = Date.now() - pending.timestamp
      if (elapsed < recheckDelayMs) {
        return
      }

      console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} re-check after ${(elapsed / 1000).toFixed(1)}s`)
      let verifiedPnlPct = pnlPercent
      let exitValuation = valuation
      try {
        clearPnlCache()
        const freshValuation = await estimateExitValue(pos.poolPubkey, ownerStr, pos.positionPubkey, pos.quoteCurrency, true)
        if (!freshValuation) throw new Error('fresh Meteora valuation unavailable')

        const latestPosition = loadKnownPositions().find(row => row.positionPubkey === pos.positionPubkey)
        if (!latestPosition) throw new Error('position disappeared during risk re-check')

        const freshPnlPct = pnlFromValuation(freshValuation, latestPosition).pnlPercent
        let recheckLpAgent = lpAgentAtTrigger
        if (!recheckLpAgent) {
          try {
            const freshLpPositions = await fetchLpAgentPositions(ownerStr)
            if (freshLpPositions) recheckLpAgent = freshLpPositions.get(pos.positionPubkey) || null
          } catch {
            // Diagnostic source is optional.
          }
        }
        if (recheckLpAgent) {
          const lpPnl = lpAgentPnl(recheckLpAgent)
          const delta = Math.abs(freshPnlPct - lpPnl)
          if (delta > 3) {
            console.log(`[recheck] ${tokenLabel} | DELTA ${delta.toFixed(1)}%: on-chain=${freshPnlPct.toFixed(2)}% vs lpagent=${lpPnl.toFixed(2)}%`)
          }
        }

        const latestRiskSettings = effectiveRiskSettings(getRiskSettings(), latestPosition)
        const freshDecision = evaluateTrigger(
          latestPosition,
          freshPnlPct,
          {
            upperBinId: freshValuation.upperBinId,
            poolActiveBinId: freshValuation.poolActiveBinId,
          },
          latestRiskSettings,
          false,
        )

        if (!freshDecision.shouldTrigger || !freshDecision.triggerType) {
          console.log(`[recheck] ${tokenLabel} | fresh Meteora PnL: ${freshPnlPct.toFixed(2)}% — ${decision.triggerType} no longer valid (was ${pending.pnlAtTrigger.toFixed(2)}%) — skip exit`)
          sendNotification(
            `⚠️ <b>Exit Skipped — PnL Re-check</b>\n\n` +
            `<b>${tokenLabel}</b>\n` +
            `Fresh Meteora PnL: <b>${freshPnlPct.toFixed(2)}%</b>\n` +
            `(was ${pending.pnlAtTrigger.toFixed(2)}% at trigger)\n` +
            `${decision.triggerType} no longer valid. Position safe.`
          )
          pendingTriggers.delete(pos.positionPubkey)
          updatePositionStatus(pos.positionPubkey, 'monitoring')
          updatePositionConfirmations(pos.positionPubkey, 0)
          return
        }

        triggerType = freshDecision.triggerType
        console.log(`[recheck] ${tokenLabel} | fresh Meteora PnL: ${freshPnlPct.toFixed(2)}% — ${triggerType} confirmed — proceeding with exit`)
        verifiedPnlPct = freshPnlPct
        exitValuation = freshValuation
      } catch (err) {
        console.log(`[recheck] ${tokenLabel} | re-check failed: ${err instanceof Error ? err.message : 'unknown'} — exit cancelled`)
        pendingTriggers.delete(pos.positionPubkey)
        updatePositionConfirmations(pos.positionPubkey, 0)
        return
      }
      pendingTriggers.delete(pos.positionPubkey)

      // --- Execute exit ---
      const estimatedPnl = exitValuation.pnlQuote
      sendNotification(
        formatExitStarted(
          pos.positionPubkey, triggerType, verifiedPnlPct, estimatedPnl,
          pos.basisQuote, exitValuation.estimatedExitQuote,
          pos.tokenXMint.slice(0, 4),
          pos.tokenYMint.slice(0, 4),
          pos.poolPubkey, exitValuation.solUsdPrice, pos.quoteCurrency
        )
      )

      const result = await executeExit(
        connection, getWallet(), pos.positionPubkey, pos.poolPubkey,
        pos.tokenXMint, pos.tokenYMint,
        triggerType, verifiedPnlPct,
        pos.quoteCurrency, pos.basisQuote, exitValuation.estimatedExitQuote
      )

      if (result.success) {
        const received = pos.quoteCurrency === 'USDC' ? result.usdcReceived : result.solReceived
        const rentRefund = pos.quoteCurrency === 'SOL' ? result.rentRefundSol : 0
        const adjReceived = received - rentRefund
        const finalTotalReturn = adjReceived + exitValuation.withdrawalQuote
        const finalPnlValue = finalTotalReturn - pos.basisQuote
        const finalPnl = pos.basisQuote > 0
          ? (finalPnlValue / pos.basisQuote) * 100
          : 0
        const delivered = await sendNotificationAsync(
          formatExitSuccess(
            pos.positionPubkey, received, finalPnl, finalPnlValue,
            rentRefund,
            pos.basisQuote, result.removeLiqSig || '',
            result.swapSig,
            pos.tokenXMint.slice(0, 4), pos.tokenYMint.slice(0, 4),
            pos.poolPubkey, exitValuation.solUsdPrice, ownerStr, pos.quoteCurrency
          )
        )
        if (delivered && result.executionId !== null) {
          acknowledgeExitCompletionNotification(result.executionId)
        }
      } else if (result.pendingRecovery) {
        sendNotification(
          `⏳ <b>Exit Pending Reconciliation</b>\n\n` +
          `<b>${pos.tokenXSymbol}/${pos.tokenYSymbol}</b>\n` +
          `Position: <code>${pos.positionPubkey}</code>\n` +
          `Reason: <code>${result.error || 'waiting for final chain state'}</code>\n\n` +
          `No duplicate transaction will be sent while this state is unresolved.`
        )
        updatePositionConfirmations(pos.positionPubkey, 0)
      } else {
        sendNotification(
          formatExitFailed(
            pos.positionPubkey, result.error || 'unknown error',
            pos.tokenXMint.slice(0, 4), pos.tokenYMint.slice(0, 4),
            pos.poolPubkey
          )
        )
        updatePositionConfirmations(pos.positionPubkey, 0)
      }
    } else if (decision.triggerType && !decision.shouldTrigger && decision.reason?.includes('awaiting confirmation')) {
      const count = (pos.triggerConfirmations || 0) + 1
      updatePositionConfirmations(pos.positionPubkey, count)
    } else {
      if ((pos.triggerConfirmations || 0) > 0) {
        updatePositionConfirmations(pos.positionPubkey, 0)
      }
    }
  } catch (err) {
    console.log(`[monitor] error on ${pos.positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

async function monitorCycle(connection: Connection, walletPubkey: PublicKey, ownerStr: string): Promise<void> {
  const positions = loadActivePositions()
  if (positions.length === 0) return

  const tokenPositions = new Map<string, number>()
  for (const p of positions) {
    tokenPositions.set(p.tokenXMint, (tokenPositions.get(p.tokenXMint) || 0) + 1)
  }

  const results = await Promise.allSettled(
    positions.map(pos =>
      monitorSinglePosition(
        connection,
        walletPubkey,
        ownerStr,
        pos,
        tokenPositions,
      )
    )
  )

  for (const r of results) {
    if (r.status === 'rejected') {
      console.log(`[monitor] cycle position error: ${r.reason?.message || String(r.reason)}`)
    }
  }
}

async function maybeRunFlipMode(
  pos: PositionRow,
  lowerBinId?: number,
  upperBinId?: number,
  poolActiveBinId?: number,
): Promise<boolean> {
  const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
  if (getWalletOperation(pos.owner)) {
    console.log(`[flip] ${tokenLabel} | durable wallet operation pending — reshape paused`)
    return true
  }

  if (pos.flipModePendingAdd) {
    if (pos.flipModeBusy) {
      console.log(`[flip] ${tokenLabel} | add-back retry already busy`)
      return true
    }

    updateFlipModeBusy(pos.positionPubkey, true)
    let result: Awaited<ReturnType<typeof retryPendingFlipAdd>>
    try {
      result = await withWalletExecutionLock(() => withDurableWalletOperation(
        pos.owner,
        'reshape',
        `flip-retry:${pos.positionPubkey}`,
        async () => {
          const outcome = await retryPendingFlipAdd(getConnection(), getWallet(), pos)
          const previousPending = BigInt(pos.flipModePendingTokenAmount || '0')
          const remaining = BigInt(outcome.tokenAmountRemaining || previousPending.toString())
          if (remaining < previousPending) {
            if (remaining === 0n) clearFlipModePendingAdd(pos.positionPubkey)
            else updateFlipModePendingAmount(pos.positionPubkey, remaining.toString(), outcome.error || null)
          }
          return outcome
        },
        outcome => outcome.success
          || BigInt(outcome.tokenAmountRemaining || pos.flipModePendingTokenAmount || '0') < BigInt(pos.flipModePendingTokenAmount || '0'),
      ))
    } catch (err) {
      updateFlipModeBusy(pos.positionPubkey, false)
      console.log(`[flip] ${tokenLabel} | add-back paused: ${err instanceof Error ? err.message : 'wallet busy'}`)
      return true
    }
    const remaining = BigInt(result.tokenAmountRemaining || '0')
    const attempted = BigInt(result.tokenAmountAttempted || '0')

    if (result.success) {
      if (remaining > 0n) {
        updateFlipModePendingAmount(
          pos.positionPubkey,
          remaining.toString(),
          `partial add-back succeeded, remaining=${remaining.toString()}`,
        )
        console.log(`[flip] ${tokenLabel} | partial add-back succeeded: attempted=${attempted} remaining=${remaining}`)
        sendNotification(
          `🔁 <b>Flip Mode Add-back Partial</b>\n\n` +
          `<b>${tokenLabel}</b>\n` +
          `Added: <code>${attempted.toString()}</code>\n` +
          `Remaining: <code>${remaining.toString()}</code>\n` +
          `Will retry remaining amount next cycle.\n` +
          `Add: ${result.addSignature ? `<a href="https://solscan.io/tx/${result.addSignature}">${result.addSignature.slice(0, 6)}..${result.addSignature.slice(-4)}</a>` : '-'}`
        )
        return true
      }

      clearFlipModePendingAdd(pos.positionPubkey)
      const progress = pos.flipModePendingProgressPct ?? pos.flipModeLastProgressPct
      const activeBin = result.activeBinId ?? pos.flipModePendingActiveBin ?? pos.flipModeLastActiveBin
      if (progress !== null && progress !== undefined && activeBin !== null && activeBin !== undefined) {
        updateFlipModeState(pos.positionPubkey, progress, activeBin, Date.now())
      }
      updateFlipModeRecoveryUntil(pos.positionPubkey, Date.now() + FLIP_MODE_RECOVERY_MS)
      console.log(`[flip] ${tokenLabel} | pending add-back complete: add=${result.addSignature || 'n/a'}`)
      sendNotification(
        `✅ <b>Flip Mode Add-back Complete</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Amount: <code>${attempted.toString()}</code>\n` +
        `Active bin: <b>${activeBin ?? '-'}</b>\n` +
        `Range: <b>${result.lowerBinId ?? '-'}-${result.upperBinId ?? '-'}</b>\n` +
        `Slippage: <b>${result.addSlippage ?? '-'}</b>\n` +
        `Add: ${result.addSignature ? `<a href="https://solscan.io/tx/${result.addSignature}">${result.addSignature.slice(0, 6)}..${result.addSignature.slice(-4)}</a>` : '-'}`
      )
      return true
    }

    const currentPending = BigInt(pos.flipModePendingTokenAmount || '0')
    if (remaining >= 0n && remaining < currentPending) {
      if (remaining === 0n) {
        clearFlipModePendingAdd(pos.positionPubkey)
        const progress = pos.flipModePendingProgressPct ?? pos.flipModeLastProgressPct
        const activeBin = result.activeBinId ?? pos.flipModePendingActiveBin ?? pos.flipModeLastActiveBin
        if (progress !== null && progress !== undefined && activeBin !== null && activeBin !== undefined) {
          updateFlipModeState(pos.positionPubkey, progress, activeBin, Date.now())
        }
        updateFlipModeRecoveryUntil(pos.positionPubkey, Date.now() + FLIP_MODE_RECOVERY_MS)
        console.log(`[flip] ${tokenLabel} | pending add-back complete after partial return: add=${result.addSignature || 'n/a'}`)
        sendNotification(
          `✅ <b>Flip Mode Add-back Complete</b>\n\n` +
          `<b>${tokenLabel}</b>\n` +
          `Amount: <code>${attempted.toString()}</code>\n` +
          `Add: ${result.addSignature ? `<a href="https://solscan.io/tx/${result.addSignature}">${result.addSignature.slice(0, 6)}..${result.addSignature.slice(-4)}</a>` : '-'}`
        )
        return true
      }

      updateFlipModePendingAmount(
        pos.positionPubkey,
        remaining.toString(),
        result.error || `partial add-back succeeded, remaining=${remaining.toString()}`,
      )
      console.log(`[flip] ${tokenLabel} | partial add-back persisted: pending ${currentPending} -> ${remaining}`)
      sendNotification(
        `🔁 <b>Flip Mode Add-back Partial</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Previous pending: <code>${currentPending.toString()}</code>\n` +
        `Remaining: <code>${remaining.toString()}</code>\n` +
        `Reason: <code>${result.error || 'partial add-back'}</code>\n\n` +
        `Bot will retry the remaining amount next cycle.`
      )
      return true
    }

    const nextAttempt = pos.flipModePendingAttempts + 1
    updateFlipModePendingAttempt(pos.positionPubkey, result.error || 'unknown error')
    console.log(`[flip] ${tokenLabel} | pending add-back retry ${nextAttempt} failed: ${result.error || 'unknown error'}`)
    if (nextAttempt === 1 || nextAttempt % 5 === 0) {
      sendNotification(
        `🔁 <b>Flip Mode Add-back Retrying</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Attempt: <b>${nextAttempt}</b>\n` +
        `Pending amount: <code>${pos.flipModePendingTokenAmount || '0'}</code>\n` +
        `Reason: <code>${result.error || 'unknown error'}</code>\n\n` +
        `Bot will keep retrying until add-back succeeds.`
      )
    }
    return true
  }

  if (!pos.flipModeEnabled) return false
  if (pos.flipModeBusy) {
    console.log(`[flip] ${tokenLabel} | busy — skip trigger evaluation this cycle`)
    return true
  }

  if (lowerBinId === undefined || upperBinId === undefined || poolActiveBinId === undefined) {
    console.log(`[flip] ${tokenLabel} | missing bin data — skip`)
    return false
  }

  if (poolActiveBinId < lowerBinId || poolActiveBinId > upperBinId) {
    return false
  }

  const progressPct = calculateFlipProgressPct(lowerBinId, upperBinId, poolActiveBinId)
  if (progressPct === null) return false

  const lastProgress = pos.flipModeLastProgressPct
  const nextTrigger = lastProgress === null
    ? config.flipModeInitialTriggerPct
    : lastProgress + config.flipModeRepeatStepPct

  if (progressPct < nextTrigger) return false

  console.log(`[flip] ${tokenLabel} | trigger progress=${progressPct.toFixed(2)}% next=${nextTrigger.toFixed(2)}% activeBin=${poolActiveBinId}`)
  sendNotification(
    `🔁 <b>Flip Mode — Starting</b>\n\n` +
    `<b>${tokenLabel}</b>\n` +
    `Progress: <b>${progressPct.toFixed(2)}%</b>\n` +
    `Trigger: <b>${nextTrigger.toFixed(2)}%</b>\n` +
    `Active bin: <b>${poolActiveBinId}</b>\n` +
    `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
    `Action: withdraw non-quote token liquidity, add back as BidAsk.`
  )

  updateFlipModeBusy(pos.positionPubkey, true)
  try {
    const result = await withWalletExecutionLock(() => withDurableWalletOperation(
      pos.owner,
      'reshape',
      `flip:${pos.positionPubkey}`,
      async () => {
        const outcome = await executeFlipMode(getConnection(), getWallet(), pos, progressPct)
        const outcomeActiveBin = outcome.activeBinId ?? poolActiveBinId
        if (outcome.success) {
          updateFlipModeState(pos.positionPubkey, progressPct, outcomeActiveBin, Date.now())
          updateFlipModeRecoveryUntil(pos.positionPubkey, Date.now() + FLIP_MODE_RECOVERY_MS)
        } else if (outcome.pendingAdd && outcome.tokenMint && outcome.tokenSide) {
          setFlipModePendingAdd(pos.positionPubkey, {
            tokenMint: outcome.tokenMint,
            tokenSide: outcome.tokenSide,
            tokenAmount: outcome.tokenAmount,
            progressPct,
            activeBin: outcomeActiveBin,
            error: outcome.error || 'add-back pending retry',
          })
        } else {
          updateFlipModeBusy(pos.positionPubkey, false)
        }
        return outcome
      },
      outcome => outcome.success || outcome.pendingAdd,
    ))
    const activeBin = result.activeBinId ?? poolActiveBinId

    if (result.success) {
      if (result.noop) {
        console.log(`[flip] ${tokenLabel} | no-op complete at progress=${progressPct.toFixed(2)}%`)
        sendNotification(
          `ℹ️ <b>Flip Mode — No-op</b>\n\n` +
          `<b>${tokenLabel}</b>\n` +
          `Progress: <b>${progressPct.toFixed(2)}%</b>\n` +
          `No token-only liquidity found.\n` +
          `Baseline updated; next trigger at <b>${(progressPct + config.flipModeRepeatStepPct).toFixed(2)}%</b>.`
        )
        return true
      }

      console.log(`[flip] ${tokenLabel} | complete: remove=${result.removeSignatures.at(-1) || 'n/a'} add=${result.addSignature || 'n/a'}`)
      sendNotification(
        `✅ <b>Flip Mode Complete</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Progress: <b>${progressPct.toFixed(2)}%</b>\n` +
        `Token side: <b>${result.tokenSide ?? '-'}</b>\n` +
        `Token amount: <code>${result.tokenAmount}</code>\n` +
        `Remove ranges: <b>${result.removeRanges.map(r => r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`).join(',') || '-'}</b>\n` +
        `Add range: <b>${result.addLowerBinId ?? '-'}-${result.addUpperBinId ?? '-'}</b>\n` +
        `Remove: ${result.removeSignatures.length > 0 ? `<a href="https://solscan.io/tx/${result.removeSignatures.at(-1)}">${result.removeSignatures.at(-1)!.slice(0, 6)}..${result.removeSignatures.at(-1)!.slice(-4)}</a>` : '-'}\n` +
        `Add: ${result.addSignature ? `<a href="https://solscan.io/tx/${result.addSignature}">${result.addSignature.slice(0, 6)}..${result.addSignature.slice(-4)}</a>` : '-'}`
      )
      return true
    }

    if (result.pendingAdd && result.tokenMint && result.tokenSide) {
      console.log(`[flip] ${tokenLabel} | add-back pending: amount=${result.tokenAmount} error=${result.error || 'unknown'}`)
      sendNotification(
        `🔁 <b>Flip Mode Add-back Pending</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Token amount: <code>${result.tokenAmount}</code>\n` +
        `Remove: ${result.removeSignatures.length > 0 ? `<a href="https://solscan.io/tx/${result.removeSignatures.at(-1)}">${result.removeSignatures.at(-1)!.slice(0, 6)}..${result.removeSignatures.at(-1)!.slice(-4)}</a>` : '-'}\n` +
        `Reason: <code>${result.error || 'unknown error'}</code>\n\n` +
        `Bot will keep retrying until BidAsk add-back succeeds.`
      )
      return true
    }

    updateFlipModeBusy(pos.positionPubkey, false)
    console.log(`[flip] ${tokenLabel} | not completed, will retry when trigger is still valid: ${result.error || 'unknown error'}`)
    sendNotification(
      `⚠️ <b>Flip Mode Not Completed</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Reason: <code>${result.error || 'unknown error'}</code>\n` +
      `No pending add-back was created. Bot will retry on the next valid cycle.`
    )
    return true
  } catch (err) {
    updateFlipModeBusy(pos.positionPubkey, false)
    const message = err instanceof Error ? err.message : 'unknown error'
    console.log(`[flip] ${tokenLabel} | error, will retry: ${message}`)
    sendNotification(
      `⚠️ <b>Flip Mode Retry Needed</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Reason: <code>${message}</code>\n` +
      `Bot will retry on the next valid cycle.`
    )
    return true
  }
}

async function maybeRunAutoRebalance(
  pos: PositionRow,
  valuation: ValuationResult,
): Promise<boolean> {
  const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`

  if (!pos.autoRebalanceEnabled) {
    if (pos.rebalanceOorSince !== null) updateRebalanceOorSince(pos.positionPubkey, null)
    return false
  }

  if (getWalletOperation(pos.owner)) {
    console.log(`[rebalance] ${tokenLabel} | durable wallet operation pending — paused`)
    return true
  }

  if (pos.rebalanceBusy) {
    console.log(`[rebalance] ${tokenLabel} | busy — skip this cycle`)
    return true
  }

  if (valuation.lowerBinId === undefined || valuation.upperBinId === undefined || valuation.poolActiveBinId === undefined) {
    return false
  }

  if (!isOorAbove(valuation.poolActiveBinId, valuation.upperBinId)) {
    if (pos.rebalanceOorSince !== null) updateRebalanceOorSince(pos.positionPubkey, null)
    return false
  }

  const now = Date.now()
  if (pos.rebalanceOorSince === null) {
    updateRebalanceOorSince(pos.positionPubkey, now)
    console.log(`[rebalance] ${tokenLabel} | OOR above detected (active=${valuation.poolActiveBinId} > upper=${valuation.upperBinId}) — waiting ${config.rebalanceOorMinutes} min`)
    return false
  }

  const timer = rebalanceTimerStatus(pos.rebalanceOorSince, now, config.rebalanceOorMinutes)
  if (timer === 'waiting') return false
  if (timer === 'none') {
    updateRebalanceOorSince(pos.positionPubkey, null)
    return false
  }

  const rangeWidth = valuation.upperBinId - valuation.lowerBinId + 1
  const pnlPercent = pnlFromValuation(valuation, pos).pnlPercent
  updateRebalanceBusy(pos.positionPubkey, true)
  console.log(`[rebalance] ${tokenLabel} | executing: close without swap then reopen with upper bin == active bin ${valuation.poolActiveBinId}`)
  sendNotification(
    `🔄 <b>Auto Rebalance — Starting</b>\n\n` +
    `<b>${tokenLabel}</b>\n` +
    `OOR above for <b>${config.rebalanceOorMinutes} min</b>\n` +
    `Active bin: <b>${valuation.poolActiveBinId}</b> (range ${valuation.lowerBinId}-${valuation.upperBinId})\n` +
    `Action: close position (no swap), reopen ${rangeWidth} bins with upper bin == current bin, deposit <b>${pos.basisQuote.toFixed(4)} ${pos.quoteCurrency}</b>.`
  )

  try {
    const outcome = await withWalletExecutionLock(async () => {
      const closeResult = await executeExit(
        getConnection(),
        getWallet(),
        pos.positionPubkey,
        pos.poolPubkey,
        pos.tokenXMint,
        pos.tokenYMint,
        'MANUAL',
        pnlPercent,
        pos.quoteCurrency,
        pos.basisQuote,
        valuation.estimatedExitQuote,
        true,
        true,
      )
      const disposition = rebalanceCloseDisposition(closeResult)
      if (disposition === 'deferred') {
        persistRebalanceReopenIntent(pos.owner, {
          positionPubkey: pos.positionPubkey,
          poolPubkey: pos.poolPubkey,
          quoteCurrency: pos.quoteCurrency,
          amountQuote: pos.basisQuote,
          rangeWidth,
          inheritMode: pos.autoRebalanceEnabled,
        })
        console.log(`[rebalance] ${tokenLabel} | close confirmed — reopen will run once finality reconciliation completes`)
        sendNotification(
          `⏳ <b>Auto Rebalance — Close In Progress</b>\n\n` +
          `<b>${tokenLabel}</b>\n` +
          `Remove liquidity confirmed; waiting for finality.\n` +
          `Reopen otomatis setelah posisi final ditutup.`
        )
        return { deferred: true as const }
      }
      if (disposition === 'failed') {
        throw new Error(closeResult.error || 'rebalance close failed')
      }
      return {
        deferred: false as const,
        exitResult: closeResult,
        openResult: await executeRebalanceOpen(
          getConnection(),
          getWallet(),
          {
            poolPubkey: pos.poolPubkey,
            quoteCurrency: pos.quoteCurrency,
            amountQuote: pos.basisQuote,
            rangeWidth,
          },
          true,
        ),
      }
    })
    if (outcome.deferred) return true

    const { exitResult, openResult } = outcome
    console.log(`[rebalance] ${tokenLabel} | closed ${pos.positionPubkey.slice(0, 8)} (${exitResult.removeLiqSig?.slice(0, 8) || 'n/a'}) and reopened as ${openResult.positionPubkey.slice(0, 8)}`)
    sendNotification(
      `✅ <b>Auto Rebalance Complete</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Old position closed (no swap): <code>${pos.positionPubkey.slice(0, 8)}..</code>\n` +
      `New position: <code>${openResult.positionPubkey}</code>\n` +
      `Range: <b>${openResult.preview.minBinId}-${openResult.preview.maxBinId}</b>\n` +
      `Deposit: <b>${openResult.preview.amountQuote.toFixed(4)} ${pos.quoteCurrency}</b>\n` +
      `Close: ${exitResult.removeLiqSig ? `<a href="https://solscan.io/tx/${exitResult.removeLiqSig}">${exitResult.removeLiqSig.slice(0, 6)}..${exitResult.removeLiqSig.slice(-4)}</a>` : '-'}\n` +
      `Open: <a href="https://solscan.io/tx/${openResult.signature}">${openResult.signature.slice(0, 6)}..${openResult.signature.slice(-4)}</a>`
    )
    updateRebalanceState(pos.positionPubkey, Date.now())
    updateAutoRebalanceEnabled(openResult.positionPubkey, true)
    return true
  } catch (err) {
    updateRebalanceBusy(pos.positionPubkey, false)
    const message = err instanceof Error ? err.message : 'unknown error'
    console.log(`[rebalance] ${tokenLabel} | failed: ${message}`)
    sendNotification(
      `⚠️ <b>Auto Rebalance Failed</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Reason: <code>${message}</code>\n\n` +
      `If the position was already closed, its funds are safe in the wallet. Bot will retry on the next valid cycle.`
    )
    return true
  }
}

async function maybeRunPrecisionCurve(
  pos: PositionRow,
  lowerBinId?: number,
  upperBinId?: number,
  poolActiveBinId?: number,
): Promise<boolean> {
  if (!pos.precisionCurveEnabled) return false
  const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
  if (getWalletOperation(pos.owner)) {
    console.log(`[precision] ${tokenLabel} | durable wallet operation pending — reshape paused`)
    return true
  }

  if (pos.precisionCurveBusy) {
    console.log(`[precision] ${tokenLabel} | busy — skip trigger evaluation this cycle`)
    return true
  }

  if (lowerBinId === undefined || upperBinId === undefined || poolActiveBinId === undefined) {
    console.log(`[precision] ${tokenLabel} | missing bin data — skip`)
    return false
  }

  if (poolActiveBinId < lowerBinId || poolActiveBinId > upperBinId) {
    console.log(`[precision] ${tokenLabel} | active bin ${poolActiveBinId} outside range ${lowerBinId}-${upperBinId} — skip`)
    return false
  }

  const isInitialReshape = pos.precisionCurveLastActiveBin === null
  if (!isInitialReshape) {
    const lastBin = pos.precisionCurveLastActiveBin!
    const movedBins = Math.abs(poolActiveBinId - lastBin)
    const dynamicThreshold = Math.max(THRESHOLD_MIN, Math.round((pos.precisionCurveRangeHalf || 100) * THRESHOLD_RATIO))
    if (movedBins < dynamicThreshold) return false

    const lastReshapeAt = pos.precisionCurveLastReshapeAt || 0
    const cooldownLeft = PRECISION_CURVE_COOLDOWN_MS - (Date.now() - lastReshapeAt)
    if (lastReshapeAt > 0 && cooldownLeft > 0) {
      console.log(`[precision] ${tokenLabel} | moved ${movedBins} bins but cooldown ${Math.ceil(cooldownLeft / 1000)}s left`)
      return false
    }
  }

  const direction = isInitialReshape ? 0 : poolActiveBinId - pos.precisionCurveLastActiveBin!
  const dirLabel = direction === 0 ? 'initial' : direction > 0 ? 'right/up' : 'left/down'

  const actualRangeHalf = Math.ceil((upperBinId - lowerBinId + 1) / 2)
  const dynThreshold = isInitialReshape
    ? Math.max(THRESHOLD_MIN, Math.round(actualRangeHalf * THRESHOLD_RATIO))
    : Math.max(THRESHOLD_MIN, Math.round((pos.precisionCurveRangeHalf || actualRangeHalf) * THRESHOLD_RATIO))

  if (isInitialReshape) {
    console.log(`[precision] ${tokenLabel} | initial reshape at activeBin=${poolActiveBinId}`)
    sendNotification(
      `🔁 <b>Precision Curve Initial Reshape — Starting</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Active bin: <b>${poolActiveBinId}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `Threshold: <b>${dynThreshold} bins</b> | Cooldown: <b>5s</b>`
    )
  } else {
    const lastBin = pos.precisionCurveLastActiveBin!
    const movedBins = Math.abs(poolActiveBinId - lastBin)
    console.log(`[precision] ${tokenLabel} | moved ${movedBins} bins (${lastBin} -> ${poolActiveBinId}) — directional reshape ${dirLabel}`)
    sendNotification(
      `🔁 <b>Precision Directional Reshape — Starting</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Moved: <b>${movedBins} bins</b>\n` +
      `Active: <b>${lastBin} → ${poolActiveBinId}</b>\n` +
      `Direction: <b>${dirLabel}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>`
    )
  }

  updatePrecisionCurveBusy(pos.positionPubkey, true)
  try {
    const result = await withWalletExecutionLock(() => withDurableWalletOperation(
      pos.owner,
      'reshape',
      `precision:${pos.positionPubkey}`,
      async () => {
        const outcome = await executeDirectionalPrecisionCurve(
          getConnection(),
          getWallet(),
          pos.positionPubkey,
          pos.poolPubkey,
          pos.tokenXMint,
          pos.tokenYMint,
          pos.precisionCurveLastActiveBin,
          pos.precisionCurveRangeHalf || 100,
          pos.precisionCurveMovementLog || [],
        )
        if (outcome.success) {
          updatePrecisionCurveState(pos.positionPubkey, outcome.activeBinId ?? poolActiveBinId, Date.now())
          updatePrecisionCurveRecoveryUntil(pos.positionPubkey, Date.now() + RECOVERY_MS)
        } else {
          updatePrecisionCurveBusy(pos.positionPubkey, false)
          if (outcome.removeSucceeded && outcome.addFailed) {
            updatePrecisionCurveRecoveryUntil(pos.positionPubkey, Number.MAX_SAFE_INTEGER)
          }
        }
        return outcome
      },
      outcome => outcome.success,
    ))

    if (!result.success) {
      if (result.removeSucceeded && result.addFailed) {
        console.log(`[precision] ${tokenLabel} | CRITICAL: remove succeeded but add failed: ${result.error}`)
        sendNotification(
          `🚨 <b>Precision Curve CRITICAL</b>\n\n` +
          `<b>${tokenLabel}</b>\n` +
          `Liquidity withdrawn but add-back failed!\n` +
          `Tokens idle in wallet.\n` +
          `Remove: ${result.removeSignature ? `<a href="https://solscan.io/tx/${result.removeSignature}">${result.removeSignature.slice(0, 6)}..${result.removeSignature.slice(-4)}</a>` : '-'}\n` +
          `Reason: <code>${result.error || 'unknown'}</code>\n\n` +
          `Position will NOT be auto-closed.`
        )
        return true
      }

      console.log(`[precision] ${tokenLabel} | failed: ${result.error || 'unknown'}`)
      sendNotification(
        `❌ <b>Precision Curve Failed</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Direction: <b>${dirLabel}</b>\n` +
        `Reason: <code>${result.error || 'unknown'}</code>\n` +
        `Position remains monitored.`
      )
      return true
    }

    const newBaseline = result.activeBinId ?? poolActiveBinId
    console.log(`[precision] ${tokenLabel} | recovery window: ${RECOVERY_MS / 1000}s — peak frozen`)

    if (isInitialReshape) {
      updatePrecisionCurveRangeHalf(pos.positionPubkey, actualRangeHalf)
      console.log(`[precision] ${tokenLabel} | initial range half: ${actualRangeHalf} (from ${lowerBinId}-${upperBinId})`)
    }

    const staleRange = result.staleFrom !== null && result.staleTo !== null
      ? `${result.staleFrom} → ${result.staleTo}`
      : '-'
    const addRange = result.addLowerBinId !== null && result.addUpperBinId !== null
      ? `${result.addLowerBinId}-${result.addUpperBinId} (half=${result.effectiveRangeHalf})`
      : '-'

    if (!result.noop && !isInitialReshape) {
      const movedBins = Math.abs(poolActiveBinId - pos.precisionCurveLastActiveBin!)
      const newLog = [...(pos.precisionCurveMovementLog || []), movedBins].slice(-5)
      updatePrecisionCurveMovementLog(pos.positionPubkey, newLog)

      if (newLog.length >= 2) {
        const avg = newLog.reduce((a, b) => a + b, 0) / newLog.length
        const currentRange = pos.precisionCurveRangeHalf || 100
        const newRange = Math.round(Math.min(Math.max(50, avg * 2), 500))
        if (newRange !== currentRange) {
          updatePrecisionCurveRangeHalf(pos.positionPubkey, newRange)
          console.log(`[precision] ${tokenLabel} | dynamic range: ${currentRange} → ${newRange} (avg movement=${avg.toFixed(1)})`)
        }
      }
    }

    if (result.noop) {
      console.log(`[precision] ${tokenLabel} | no-op: stale range empty — baseline ${newBaseline}`)
      sendNotification(
        `ℹ️ <b>Precision Curve — No-op</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Stale range: <b>${staleRange}</b>\n` +
        `No liquidity to remove.\n` +
        `Active baseline: <b>${newBaseline}</b>\n` +
        `Baseline updated.`
      )
      return true
    }

    console.log(`[precision] ${tokenLabel} | reshape complete: remove=${result.removeSignature || 'n/a'} add=${result.addSignature || 'n/a'}`)
    sendNotification(
      `✅ <b>Precision Directional Reshape Complete</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Direction: <b>${dirLabel}</b>\n` +
      `Active baseline: <b>${newBaseline}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `Concentrated: <b>${addRange}</b>\n` +
      `Stale range: <b>${staleRange}</b>\n` +
      `X withdrawn/deposited: <code>${result.xWithdrawn}</code> / <code>${result.xDeposited}</code>\n` +
      `Y withdrawn/deposited: <code>${result.yWithdrawn}</code> / <code>${result.yDeposited}</code>\n` +
      `X leftover: <code>${result.xLeftover}</code>\n` +
      `Y leftover: <code>${result.yLeftover}</code>\n` +
      `Remove: ${result.removeSignature ? `<a href="https://solscan.io/tx/${result.removeSignature}">${result.removeSignature.slice(0, 6)}..${result.removeSignature.slice(-4)}</a>` : '-'}\n` +
      `Add: ${result.addSignature ? `<a href="https://solscan.io/tx/${result.addSignature}">${result.addSignature.slice(0, 6)}..${result.addSignature.slice(-4)}</a>` : '-'}`
    )
    return true
  } catch (err) {
    updatePrecisionCurveBusy(pos.positionPubkey, false)
    const message = err instanceof Error ? err.message : 'unknown error'
    console.log(`[precision] ${tokenLabel} | error: ${message}`)
    sendNotification(
      `❌ <b>Precision Curve Failed</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Reason: <code>${message}</code>\n` +
      `Position remains monitored.`
    )
    return true
  }
}

function checkExitCooldown(pubkey: string): void {
  const now = Date.now()
  const last = exitCooldowns.get(pubkey) || 0
  if (now - last > config.exitCooldownMs) {
    const db = getDb()
    const row = db.prepare("SELECT status FROM positions WHERE position_pubkey = ? AND status = 'exiting'").get(pubkey)
    const execRow = db.prepare(
      "SELECT status FROM executions WHERE position_pubkey = ? ORDER BY created_at DESC LIMIT 1"
    ).get(pubkey) as any
    if (execRow?.status === 'completed') updatePositionStatus(pubkey, 'closed')
    exitCooldowns.set(pubkey, now)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
