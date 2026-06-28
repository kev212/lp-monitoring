import { Connection, PublicKey } from '@solana/web3.js'
import { config } from './config.js'
import { getConnection } from './solana/connection.js'
import { loadWallet, getWallet } from './solana/wallet.js'
import { getDb } from './db/client.js'
import {
  loadKnownPositions,
  loadActivePositions,
  upsertPosition,
  updatePositionStatus,
  updatePositionPnl,
  updatePositionConfirmations,
  updatePeakPnl,
  updatePositionStrategy,
  updatePrecisionCurveBusy,
  updatePrecisionCurveState,
} from './meteora/discovery.js'
import {
  getAllPositionsForWallet,
  getPositionDetail,
  getPool,
  getPoolInfo,
  clearPoolCache,
} from './meteora/positions.js'
import { estimateExitValue, clearPnlCache } from './meteora/valuation.js'
import { fetchLpAgentPositions } from './lpagent.js'
import { executeExit } from './meteora/exit.js'
import { executePrecisionCurveRebalance } from './meteora/precisionCurve.js'
import { evaluateTrigger, type BinData } from './risk/rules.js'
import {
  sendNotification,
  formatPositionDiscovered,
  formatPnlAlert,
  formatExitStarted,
  formatExitSuccess,
  formatExitFailed,
  formatBotStart,
  formatBotStop,
} from './telegram.js'
import type { PositionRow, PositionStatus, BasisConfidence, TriggerType, StrategyType } from './types.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

let running = false
let exitCooldowns = new Map<string, number>()
let lastDiscoveryTime = 0
let monitorRetries = new Map<string, number>()
const pendingTriggers = new Map<string, { triggerType: TriggerType; timestamp: number; pnlAtTrigger: number }>()
const DISCOVERY_INTERVAL_MS = 3 * 60 * 1000 // 3 menit
const MAX_MONITOR_RETRIES = 5
const PRECISION_CURVE_COOLDOWN_MS = 60_000

export async function startBot(): Promise<void> {
  console.log('[app] starting monitoring-lp...')
  running = true

  loadWallet()
  const wallet = getWallet()
  const walletPubkey = wallet.publicKey
  const ownerStr = walletPubkey.toBase58()

  sendNotification(formatBotStart(walletPubkey.toBase58(), 0))
  // Balance will be fetched in first cycle

  await discoverInitialPositions(getConnection(), walletPubkey, ownerStr)
  await redetectStrategies(ownerStr)
  lastDiscoveryTime = Date.now() // start timer dari sini

  while (running) {
    try {
      // Periodic discovery — every 5 menit
      const now = Date.now()
      if (now - lastDiscoveryTime >= DISCOVERY_INTERVAL_MS) {
        lastDiscoveryTime = now
        await discoverInitialPositions(getConnection(), walletPubkey, ownerStr)
      }

      // Skip monitoring kalo gak ada posisi aktif
      const activePositions = loadActivePositions()
      if (activePositions.length === 0) {
        // Gak ada posisi → tidur sampe discovery berikutnya
        const nextDiscovery = DISCOVERY_INTERVAL_MS - (Date.now() - lastDiscoveryTime)
        await sleep(Math.max(nextDiscovery, 5_000))
        continue
      }

      await monitorCycle(getConnection(), walletPubkey, ownerStr)
      await sleep(config.pollIntervalMs) // pakai config biar fleksibel
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
  console.log(`[discovery] found ${discovered.length} positions`)

  for (const dp of discovered) {
    const existing = loadKnownPositions().find(p => p.positionPubkey === dp.positionPubkey)
    if (existing) continue

    try {
      // Use token info from Portfolio API; fallback to getPoolInfo if DLMM API (no token data)
      let tokenXMint = dp.tokenXMint
      let tokenYMint = dp.tokenYMint
      let tokenXSymbol = dp.tokenXSymbol
      let tokenYSymbol = dp.tokenYSymbol

      if (!tokenXMint || !tokenYMint) {
        const poolInfo = await getPoolInfo(dp.poolPubkey)
        if (!tokenXSymbol) tokenXSymbol = poolInfo.tokenXSymbol
        if (!tokenYSymbol) tokenYSymbol = poolInfo.tokenYSymbol
        // If still no mints, skip this position
        if (!tokenXMint || !tokenYMint) {
          console.log(`[discovery] ${dp.positionPubkey.slice(0, 8)} — no token mints, skipping`)
          continue
        }
      }

      // Get position value + deposit from Meteora PnL API (no RPC needed)
      let currentValue = 0
      let finalBasis = 0
      let pnlPct = 0
      let val: Awaited<ReturnType<typeof estimateExitValue>> = null
      try {
        val = await Promise.race([
          estimateExitValue(dp.poolPubkey, ownerStr, dp.positionPubkey),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('estimateExitValue timeout')), 10_000))
        ])
        if (val && val.estimatedExitSol > 0) {
          currentValue = val.estimatedExitSol
          // Prefer allTimeDepositSol (accurate per-position from Meteora), fallback to depositEstimateSol
          finalBasis = val.allTimeDepositSol > 0 ? val.allTimeDepositSol : val.depositEstimateSol
          if (finalBasis > 0) pnlPct = ((currentValue - finalBasis) / finalBasis) * 100
        }
      } catch {
        // valuation failed, use 0
      }

      const finalConfidence: BasisConfidence = 'medium'

      const finalTokenXSymbol = tokenXSymbol || tokenXMint.slice(0, 4)
      const finalTokenYSymbol = tokenYSymbol || tokenYMint.slice(0, 4)

      // --- Strategy detection from LP Agent deposit data ---
      let strategy: StrategyType = 'unknown'
      let tpPercent = config.defaultTpPercent
      let slPercent = config.defaultSlPercent

      try {
        const lpAgentPositions = await fetchLpAgentPositions(ownerStr)
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
              tpPercent = config.defaultTpPercent
              slPercent = config.defaultSlPercent
            } else if (quoteAmount === 0 && tokenAmount > 0) {
              strategy = 'single_side_token'
              tpPercent = 35
              slPercent = -35
            } else if (quoteAmount > 0 && tokenAmount > 0) {
              strategy = 'balanced'
              tpPercent = config.defaultTpPercent
              slPercent = config.defaultSlPercent
            } else {
              strategy = 'unknown'
              tpPercent = config.defaultTpPercent
              slPercent = config.defaultSlPercent
            }

            console.log(`[discovery] ${dp.positionPubkey.slice(0, 8)} | strategy: ${strategy} | quote=${quoteAmount} token=${tokenAmount} | SL: ${slPercent}% TP: ${tpPercent}%`)
          }
        }
      } catch {
        // LP Agent check failed, use defaults
      }

      upsertPosition({
        positionPubkey: dp.positionPubkey,
        poolPubkey: dp.poolPubkey,
        tokenXMint,
        tokenYMint,
        tokenXSymbol: finalTokenXSymbol,
        tokenYSymbol: finalTokenYSymbol,
        owner: ownerStr,
        basisSol: finalBasis,
        basisConfidence: finalConfidence,
        tpPercent,
        slPercent,
        status: 'monitoring',
        triggerConfirmations: 0,
        peakPnlPercent: pnlPct > 0 ? pnlPct : 0,
        trailingActivated: false,
        lastPnlPercent: null,
        lastEstimatedExitSol: null,
        lastSeenAt: Date.now(),
        strategy,
      })

      sendNotification(formatPositionDiscovered(
        dp.positionPubkey, dp.poolPubkey, finalBasis, finalConfidence,
        finalTokenXSymbol,
        finalTokenYSymbol,
        currentValue, pnlPct, val?.solUsdPrice || 0, ownerStr,
        val?.tokenXAmount, val?.tokenYAmount,
        val?.tokenXFees, val?.tokenYFees,
        strategy, slPercent, tpPercent
      ))
      const isDupeDiscovery = loadKnownPositions().some(p => p.tokenXMint === tokenXMint && p.positionPubkey !== dp.positionPubkey)
      const dupMarkerDisc = isDupeDiscovery ? ' [DUPE-TOKEN]' : ''
      console.log(`[discovery] registered position ${dp.positionPubkey.slice(0, 8)}${dupMarkerDisc} strategy=${strategy} SL=${slPercent}% TP=${tpPercent}% basis=${finalBasis.toFixed(4)}`)
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
    const lpAgentPositions = await fetchLpAgentPositions(ownerStr)
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
      let tpPercent = config.defaultTpPercent
      let slPercent = config.defaultSlPercent

      if (quoteAmount > 0 && tokenAmount === 0) {
        strategy = 'single_side_quote'
      } else if (quoteAmount === 0 && tokenAmount > 0) {
        strategy = 'single_side_token'
        tpPercent = 35
        slPercent = -35
      } else if (quoteAmount > 0 && tokenAmount > 0) {
        strategy = 'balanced'
      }

      updatePositionStrategy(pos.positionPubkey, strategy, slPercent, tpPercent)
      console.log(`[strategy] ${pos.tokenXSymbol}/${pos.tokenYSymbol} → ${strategy} | SL: ${slPercent}% TP: ${tpPercent}%`)
    }
  } catch (err) {
    console.log(`[strategy] redetect error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

async function monitorCycle(connection: Connection, walletPubkey: PublicKey, ownerStr: string): Promise<void> {
  const positions = loadActivePositions()
  if (positions.length === 0) return

  // Build duplicate token map for logging
  const tokenPositions = new Map<string, number>()
  for (const p of positions) {
    tokenPositions.set(p.tokenXMint, (tokenPositions.get(p.tokenXMint) || 0) + 1)
  }

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]
    if (pos.status === 'exiting') {
      if (pos.positionPubkey) {
        checkExitCooldown(pos.positionPubkey)
      }
      continue
    }

      if (i > 0) await sleep(250)

    try {
      const valuation = await estimateExitValue(pos.poolPubkey, ownerStr, pos.positionPubkey)
      if (!valuation || valuation.estimatedExitSol <= 0) {
        const retryCount = (monitorRetries.get(pos.positionPubkey) || 0) + 1
        if (retryCount >= MAX_MONITOR_RETRIES) {
          console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | PnL API failed ${retryCount}x — marking as closed`)
          updatePositionStatus(pos.positionPubkey, 'closed')
          monitorRetries.delete(pos.positionPubkey)
        } else {
          monitorRetries.set(pos.positionPubkey, retryCount)
          console.log(`[monitor] ${pos.positionPubkey.slice(0, 8)} | PnL API failed (${retryCount}/${MAX_MONITOR_RETRIES}) — retrying`)
        }
        continue
      }
      // Reset retry counter on success
      monitorRetries.delete(pos.positionPubkey)

      // Update basis if still 0 (history missed it) — use deposit estimate from SDK
      if (pos.basisSol <= 0 && valuation.depositEstimateSol > 0) {
        const db = getDb()
        db.prepare('UPDATE positions SET basis_sol = ?, basis_confidence = ?, updated_at = ? WHERE position_pubkey = ?')
          .run(valuation.depositEstimateSol, 'medium', Date.now(), pos.positionPubkey)
        pos.basisSol = valuation.depositEstimateSol
        pos.basisConfidence = 'medium'
        console.log(`[monitor] updated basis for ${pos.positionPubkey.slice(0, 8)}: ${valuation.depositEstimateSol.toFixed(4)} SOL (SDK estimate)`)
      }

      const quoteIsUsdc = pos.tokenXMint === USDC_MINT || pos.tokenYMint === USDC_MINT
      const quoteIsSol = pos.tokenXMint === SOL_MINT || pos.tokenYMint === SOL_MINT

      let pnlPercent: number
      let pnlSource = 'basis'
      const rawPnlSol = valuation.meteoraPnlSolPct
      const rawPnlUsd = valuation.meteoraPnlPct

      if (quoteIsUsdc) {
        // USDC-quoted pair — prefer USD PnL (includes SOL price movement vs USDC)
        if (rawPnlUsd !== undefined && rawPnlUsd !== null && Number.isFinite(rawPnlUsd) && !Number.isNaN(rawPnlUsd)) {
          pnlPercent = rawPnlUsd
          pnlSource = 'meteora(usd)'
        } else if (rawPnlSol !== undefined && rawPnlSol !== null && Number.isFinite(rawPnlSol) && !Number.isNaN(rawPnlSol)) {
          pnlPercent = rawPnlSol
          pnlSource = 'meteora(sol)'
        } else if (pos.basisSol > 0) {
          pnlPercent = ((valuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
          pnlSource = 'basis'
        } else {
          pnlPercent = 0
          pnlSource = 'zero'
        }
      } else {
        // SOL-quoted (or unknown quote) pair — prefer SOL PnL (pure position perf)
        if (rawPnlSol !== undefined && rawPnlSol !== null && Number.isFinite(rawPnlSol) && !Number.isNaN(rawPnlSol)) {
          pnlPercent = rawPnlSol
          pnlSource = 'meteora(sol)'
        } else if (rawPnlUsd !== undefined && rawPnlUsd !== null && Number.isFinite(rawPnlUsd) && !Number.isNaN(rawPnlUsd)) {
          pnlPercent = rawPnlUsd
          pnlSource = 'meteora(usd)'
        } else if (pos.basisSol > 0) {
          pnlPercent = ((valuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
          pnlSource = 'basis'
        } else {
          pnlPercent = 0
          pnlSource = 'zero'
        }
      }

      // Warn if API returned 0 PnL but valuation suggests profit/loss
      if (pnlSource.startsWith('meteora') && pnlPercent === 0 && pos.basisSol > 0) {
        const implied = ((valuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
        if (Math.abs(implied) > 2) {
          console.log(`[warn] ${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)} | Meteora API returned PnL=0 but implied=${implied.toFixed(2)}% — possible API issue`)
        }
      }

      updatePositionPnl(pos.positionPubkey, pnlPercent, valuation.estimatedExitSol)

      // ── PnL log ──
      const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
      const isDupe = (tokenPositions.get(pos.tokenXMint) || 0) > 1
      const dupMarker = isDupe ? ' [DUPE-TOKEN]' : ''
      const pnlSign = pnlPercent >= 0 ? '+' : ''
      const triggerInfo = pos.triggerConfirmations > 0
        ? `Conf: ${pos.triggerConfirmations}/${config.triggerConfirmations}`
        : 'Conf: 0'
      console.log(
        `[monitor] ${tokenLabel}${dupMarker} | ${pos.status} | PnL: ${pnlSign}${pnlPercent.toFixed(2)}% (${pnlSource})` +
        ` | Value: ${valuation.estimatedExitSol.toFixed(4)} SOL` +
        ` | Basis: ${pos.basisSol.toFixed(4)} SOL` +
        ` | SL: ${pos.slPercent}% TP: +${pos.tpPercent}%` +
        ` | Peak: ${pos.peakPnlPercent.toFixed(2)}%` +
        ` | ${triggerInfo}`
      )

      // --- Trailing stop: track peak PnL ---
      let updatedPeak = pos.peakPnlPercent
      let trailingActive = pos.trailingActivated
      let peakOrTrailingChanged = false

      // Activate trailing tiap kali PnL >= threshold, terlepas dari peak update
      if (!trailingActive && pnlPercent >= config.trailingActivationPct) {
        trailingActive = true
        peakOrTrailingChanged = true
        console.log(`[trailing] activated for ${pos.positionPubkey.slice(0, 8)} at ${pnlPercent.toFixed(2)}%`)
      }

      if (pnlPercent > updatedPeak) {
        updatedPeak = pnlPercent
        peakOrTrailingChanged = true
      }

      if (pnlPercent <= 0) {
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

      const binData: BinData = {
        upperBinId: valuation.upperBinId,
        poolActiveBinId: valuation.poolActiveBinId,
      }

      const precisionHandled = await maybeRunPrecisionCurve(pos, valuation.lowerBinId, valuation.upperBinId, valuation.poolActiveBinId)
      if (precisionHandled) continue

      const decision = evaluateTrigger(pos, pnlPercent, binData)
      if (decision.shouldTrigger && decision.triggerType) {
        const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`

        // Cross-check with LP Agent before setting pending trigger (1 API call per trigger)
        let lpAgentAtTrigger: { pnlPercentNative: number } | null = null
        try {
          const lpAgentPositions = await fetchLpAgentPositions(ownerStr)
          if (lpAgentPositions) {
            const lpPos = lpAgentPositions.get(pos.positionPubkey)
            if (lpPos) {
              lpAgentAtTrigger = lpPos
              const diff = Math.abs(pnlPercent - lpPos.pnlPercentNative)
              if (diff > 3) {
                console.log(`[recheck] ${tokenLabel} | LP Agent pre-check: meteora=${pnlPercent.toFixed(2)}% vs lpagent=${lpPos.pnlPercentNative.toFixed(2)}% (diff=${diff.toFixed(1)}% > 3%)`)
              }
            }
          }
        } catch {
          // lpagent check failed, use meteora
        }

        // Validate trigger with LP Agent — only block if delta > 3% AND LP Agent itself doesn't trigger
        if (lpAgentAtTrigger) {
          const delta = Math.abs(pnlPercent - lpAgentAtTrigger.pnlPercentNative)
          if (delta > 3) {
            // Cek apakah LP Agent sendiri masih trigger condition
            const sl = pos.slPercent ?? config.defaultSlPercent
            const tp = pos.tpPercent ?? config.defaultTpPercent
            const lpPnl = lpAgentAtTrigger.pnlPercentNative
            let lpStillTriggers = false
            if (decision.triggerType === 'SL') {
              lpStillTriggers = lpPnl <= sl
            } else if (decision.triggerType === 'TP') {
              lpStillTriggers = lpPnl >= tp
            } else if (decision.triggerType === 'TRAILING_STOP') {
              lpStillTriggers = lpPnl > 0
            } else if (decision.triggerType === 'BIN_RANGE') {
              lpStillTriggers = lpPnl > config.binRangePnlThreshold
            }

            if (lpStillTriggers) {
              console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} delta ${delta.toFixed(1)}% (meteora=${pnlPercent.toFixed(2)}% vs lpagent=${lpPnl.toFixed(2)}%) — LP Agent confirms, proceed`)
            } else {
              console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} BLOCKED: delta ${delta.toFixed(1)}% (meteora=${pnlPercent.toFixed(2)}% vs lpagent=${lpPnl.toFixed(2)}%) — LP Agent does not confirm, skip`)
              continue
            }
          }
        }

        // --- Re-check dengan delay untuk handle glitch (SL/TP/TRAILING) ---
        const pending = pendingTriggers.get(pos.positionPubkey)

        if (!pending) {
          pendingTriggers.set(pos.positionPubkey, {
            triggerType: decision.triggerType,
            timestamp: Date.now(),
            pnlAtTrigger: pnlPercent,
          })
          console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} triggered at ${pnlPercent.toFixed(2)}% — waiting ${config.recheckDelayMs}ms for confirmation`)
          continue
        }

        const elapsed = Date.now() - pending.timestamp
        if (elapsed < config.recheckDelayMs) {
          continue
        }

        console.log(`[recheck] ${tokenLabel} | ${decision.triggerType} re-check after ${(elapsed / 1000).toFixed(1)}s`)
        let verifiedPnlPct = pnlPercent
        try {
          clearPnlCache()
          const freshValuation = await estimateExitValue(pos.poolPubkey, ownerStr, pos.positionPubkey)
          if (freshValuation && freshValuation.estimatedExitSol > 0) {
            let freshPnlPct = 0
            const freshRawSol = freshValuation.meteoraPnlSolPct
            const freshRawUsd = freshValuation.meteoraPnlPct

            if (quoteIsUsdc) {
              if (freshRawUsd !== undefined && freshRawUsd !== null && Number.isFinite(freshRawUsd) && !Number.isNaN(freshRawUsd)) {
                freshPnlPct = freshRawUsd
              } else if (freshRawSol !== undefined && freshRawSol !== null && Number.isFinite(freshRawSol) && !Number.isNaN(freshRawSol)) {
                freshPnlPct = freshRawSol
              } else if (pos.basisSol > 0) {
                freshPnlPct = ((freshValuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
              }
            } else {
              if (freshRawSol !== undefined && freshRawSol !== null && Number.isFinite(freshRawSol) && !Number.isNaN(freshRawSol)) {
                freshPnlPct = freshRawSol
              } else if (freshRawUsd !== undefined && freshRawUsd !== null && Number.isFinite(freshRawUsd) && !Number.isNaN(freshRawUsd)) {
                freshPnlPct = freshRawUsd
              } else if (pos.basisSol > 0) {
                freshPnlPct = ((freshValuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
              }
            }

            // Cross-check: LP Agent independent PnL vs Meteora PnL (use cached result, no new API call)
            let usedPnlPct = freshPnlPct
            let usedPnlSource = 'meteora'
            if (lpAgentAtTrigger) {
              const delta = Math.abs(freshPnlPct - lpAgentAtTrigger.pnlPercentNative)
              if (delta > 3) {
                console.log(`[recheck] ${tokenLabel} | DELTA ${delta.toFixed(1)}%: meteora=${freshPnlPct.toFixed(2)}% vs lpagent=${lpAgentAtTrigger.pnlPercentNative.toFixed(2)}% — using lpagent`)
                usedPnlPct = lpAgentAtTrigger.pnlPercentNative
                usedPnlSource = 'lpagent'
              }
            }

            const sl = pos.slPercent ?? config.defaultSlPercent
            const tp = pos.tpPercent ?? config.defaultTpPercent

            let stillTriggers = false
            if (decision.triggerType === 'SL') {
              stillTriggers = usedPnlPct <= sl
            } else if (decision.triggerType === 'TP') {
              stillTriggers = usedPnlPct >= tp
            } else if (decision.triggerType === 'BIN_RANGE') {
              const freshUpper = freshValuation.upperBinId
              const freshActive = freshValuation.poolActiveBinId
              if (freshUpper !== undefined && freshActive !== undefined) {
                const dist = freshUpper - freshActive
                stillTriggers = usedPnlPct > config.binRangePnlThreshold && dist >= 0 && dist <= config.binRangeMaxDistance
              }
            } else if (decision.triggerType === 'TRAILING_STOP') {
              const dropFromPeak = pos.peakPnlPercent - usedPnlPct
              stillTriggers = usedPnlPct > 0 && dropFromPeak >= config.trailingStopDropPct
            }

            if (!stillTriggers) {
              console.log(`[recheck] ${tokenLabel} | fresh PnL: ${usedPnlPct.toFixed(2)}% (${usedPnlSource}) — ${decision.triggerType} no longer valid (was ${pending.pnlAtTrigger.toFixed(2)}%) — skip exit`)
              sendNotification(
                `⚠️ <b>Exit Skipped — PnL Re-check</b>\n\n` +
                `<b>${tokenLabel}</b>\n` +
                `Fresh PnL: <b>${usedPnlPct.toFixed(2)}%</b> (${usedPnlSource})\n` +
                `(was ${pending.pnlAtTrigger.toFixed(2)}% at trigger)\n` +
                `${decision.triggerType} no longer valid. Position safe.`
              )
              pendingTriggers.delete(pos.positionPubkey)
              updatePositionStatus(pos.positionPubkey, 'monitoring')
              updatePositionConfirmations(pos.positionPubkey, 0)
              continue
            }

            console.log(`[recheck] ${tokenLabel} | fresh PnL: ${usedPnlPct.toFixed(2)}% (${usedPnlSource}) — ${decision.triggerType} confirmed — proceeding with exit`)
            verifiedPnlPct = usedPnlPct
          }
        } catch (err) {
          console.log(`[recheck] ${tokenLabel} | re-check failed: ${err instanceof Error ? err.message : 'unknown'} — proceeding with exit`)
        }
        pendingTriggers.delete(pos.positionPubkey)

        // --- Kirim notifikasi + execute exit ---
        const meteoraPnlSol = typeof valuation.meteoraPnlSol === 'number' && Number.isFinite(valuation.meteoraPnlSol)
          ? valuation.meteoraPnlSol
          : (valuation.estimatedExitSol - pos.basisSol)
        sendNotification(
          formatExitStarted(
            pos.positionPubkey, decision.triggerType, pnlPercent, meteoraPnlSol,
            pos.basisSol, valuation.estimatedExitSol,
            pos.tokenXMint.slice(0, 4),
            pos.tokenYMint.slice(0, 4),
            pos.poolPubkey, valuation.solUsdPrice
          )
        )

        const result = await executeExit(
          connection,
          getWallet(),
          pos.positionPubkey,
          pos.poolPubkey,
          pos.tokenXMint,
          pos.tokenYMint,
          decision.triggerType,
          verifiedPnlPct,
          pos.basisSol,
          valuation.estimatedExitSol
        )

        if (result.success) {
          const quoteIsUsdc = pos.tokenXMint === USDC_MINT || pos.tokenYMint === USDC_MINT
          const received = quoteIsUsdc ? result.usdcReceived : result.solReceived
          const adjReceived = received - (quoteIsUsdc ? 0 : result.rentRefundSol)
          const basisForPnl = quoteIsUsdc ? pos.basisSol * valuation.solUsdPrice : pos.basisSol
          const finalPnl = basisForPnl > 0
            ? ((adjReceived - basisForPnl) / basisForPnl) * 100
            : 0
          sendNotification(
            formatExitSuccess(
              pos.positionPubkey,
              received,
              finalPnl,
              quoteIsUsdc ? 0 : result.rentRefundSol,
              basisForPnl,
              result.removeLiqSig || '',
              result.swapSig,
              pos.tokenXMint.slice(0, 4),
              pos.tokenYMint.slice(0, 4),
              pos.poolPubkey,
              valuation.solUsdPrice,
              ownerStr,
              quoteIsUsdc
            )
          )
        } else {
          sendNotification(
            formatExitFailed(
              pos.positionPubkey,
              result.error || 'unknown error',
              pos.tokenXMint.slice(0, 4),
              pos.tokenYMint.slice(0, 4),
              pos.poolPubkey
            )
          )
          updatePositionStatus(pos.positionPubkey, 'monitoring')
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
}

async function maybeRunPrecisionCurve(
  pos: PositionRow,
  lowerBinId?: number,
  upperBinId?: number,
  poolActiveBinId?: number,
): Promise<boolean> {
  if (!pos.precisionCurveEnabled) return false
  const tokenLabel = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`

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
    sendNotification(
      `⚠️ <b>Precision Curve Skipped</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Active bin: <b>${poolActiveBinId}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `Reason: active bin outside range.`
    )
    return false
  }

  const isInitialReshape = pos.precisionCurveLastActiveBin === null
  if (!isInitialReshape) {
    const lastBin = pos.precisionCurveLastActiveBin!
    const movedBins = Math.abs(poolActiveBinId - lastBin)
    const threshold = pos.precisionCurveThresholdBins || 3
    if (movedBins < threshold) return false

    const lastReshapeAt = pos.precisionCurveLastReshapeAt || 0
    const cooldownLeft = PRECISION_CURVE_COOLDOWN_MS - (Date.now() - lastReshapeAt)
    if (lastReshapeAt > 0 && cooldownLeft > 0) {
      console.log(`[precision] ${tokenLabel} | moved ${movedBins} bins but cooldown ${Math.ceil(cooldownLeft / 1000)}s left`)
      return false
    }
  }

  if (isInitialReshape) {
    console.log(`[precision] ${tokenLabel} | initial reshape at activeBin=${poolActiveBinId}`)
    sendNotification(
      `🔁 <b>Precision Curve Initial Reshape — Starting</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Active bin: <b>${poolActiveBinId}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `Threshold: <b>${pos.precisionCurveThresholdBins || 3} bins</b> | Cooldown: <b>60s</b>`
    )
  } else {
    const lastBin = pos.precisionCurveLastActiveBin!
    const movedBins = Math.abs(poolActiveBinId - lastBin)
    console.log(`[precision] ${tokenLabel} | moved ${movedBins} bins (${lastBin} -> ${poolActiveBinId}) — rebalance`)
    sendNotification(
      `🔁 <b>Precision Curve Reshape Started</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Moved: <b>${movedBins} bins</b>\n` +
      `Active: <b>${pos.precisionCurveLastActiveBin} → ${poolActiveBinId}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `Auto-compound: <b>off</b>`
    )
  }

  updatePrecisionCurveBusy(pos.positionPubkey, true)
  try {
    const result = await executePrecisionCurveRebalance(
      getConnection(),
      getWallet(),
      pos.positionPubkey,
      pos.poolPubkey,
    )

    if (result.skipReason) {
      updatePrecisionCurveBusy(pos.positionPubkey, false)
      console.log(`[precision] ${tokenLabel} | skip: ${result.skipReason}`)
      sendNotification(
        `⏭️ <b>Precision Curve Skipped</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Active bin: <b>${poolActiveBinId}</b>\n` +
        `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
        `Reason: <code>${result.skipReason}</code>\n\n` +
        `X top-up: <code>${result.xTopup}</code> (${result.xTopupPct.toFixed(2)}%)\n` +
        `Y top-up: <code>${result.yTopup}</code> (${result.yTopupPct.toFixed(2)}%)\n` +
        `X leftover: <code>${result.xLeftover}</code> (${result.xLeftoverPct.toFixed(2)}%)\n` +
        `Y leftover: <code>${result.yLeftover}</code> (${result.yLeftoverPct.toFixed(2)}%)`
      )
      return true
    }

    if (!result.success) {
      updatePrecisionCurveBusy(pos.positionPubkey, false)
      console.log(`[precision] ${tokenLabel} | failed: ${result.error || 'unknown'}`)
      sendNotification(
        `❌ <b>Precision Curve Failed</b>\n\n` +
        `<b>${tokenLabel}</b>\n` +
        `Reason: <code>${result.error || 'unknown'}</code>\n` +
        `Position remains monitored.`
      )
      return true
    }

    updatePrecisionCurveState(pos.positionPubkey, poolActiveBinId, Date.now())
    console.log(`[precision] ${tokenLabel} | rebalance tx: ${result.signature || 'n/a'}`)
    sendNotification(
      `✅ <b>Precision Curve Reshape Complete</b>\n\n` +
      `<b>${tokenLabel}</b>\n` +
      `Active baseline: <b>${poolActiveBinId}</b>\n` +
      `Range: <b>${lowerBinId}-${upperBinId}</b>\n` +
      `X withdrawn/deposited: <code>${result.xWithdrawn}</code> / <code>${result.xDeposited}</code>\n` +
      `Y withdrawn/deposited: <code>${result.yWithdrawn}</code> / <code>${result.yDeposited}</code>\n` +
      `X top-up: <code>${result.xTopup}</code> (${result.xTopupPct.toFixed(2)}%)\n` +
      `Y top-up: <code>${result.yTopup}</code> (${result.yTopupPct.toFixed(2)}%)\n` +
      `X leftover: <code>${result.xLeftover}</code> (${result.xLeftoverPct.toFixed(2)}%)\n` +
      `Y leftover: <code>${result.yLeftover}</code> (${result.yLeftoverPct.toFixed(2)}%)\n` +
      `Tx: ${result.signature ? `<a href="https://solscan.io/tx/${result.signature}">${result.signature.slice(0, 6)}..${result.signature.slice(-4)}</a>` : '-'}`
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
    if (execRow && (execRow.status === 'completed' || execRow.status === 'failed' || execRow.status === 'removed' || execRow.status === 'swap_pending')) {
      const targetStatus = execRow.status === 'completed' ? 'closed' : 'error'
      updatePositionStatus(pubkey, targetStatus)
    }
    exitCooldowns.set(pubkey, now)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
