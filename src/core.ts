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
} from './meteora/discovery.js'
import {
  getAllPositionsForWallet,
  getPositionDetail,
  getPool,
  clearPoolCache,
} from './meteora/positions.js'
import { estimateExitValue } from './meteora/valuation.js'
import { executeExit } from './meteora/exit.js'
import {
  fetchAndParseHistory,
  computeBasisFromEvents,
  saveEvent,
  getSavedEvents,
  setSyncState,
} from './history/ledger.js'
import { evaluateTrigger } from './risk/rules.js'
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
import type { PositionRow, PositionStatus, BasisConfidence } from './types.js'

let running = false
let exitCooldowns = new Map<string, number>()

export async function startBot(): Promise<void> {
  console.log('[app] starting monitoring-lp...')
  running = true

  loadWallet()
  const wallet = getWallet()
  const walletPubkey = wallet.publicKey
  const ownerStr = walletPubkey.toBase58()

  sendNotification(formatBotStart())

  await discoverInitialPositions(getConnection(), walletPubkey, ownerStr)

  while (running) {
    try {
      await monitorCycle(getConnection(), walletPubkey, ownerStr)
    } catch (err) {
      console.log(`[loop] cycle error: ${err instanceof Error ? err.message : 'unknown'}`)
    }
    await sleep(config.pollIntervalMs)
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
      const pool = await getPool(connection, new PublicKey(dp.poolPubkey))
      const detail = await getPositionDetail(connection, pool, new PublicKey(dp.positionPubkey))
      if (!detail || !detail.active) continue

      const events = await fetchAndParseHistory(connection, walletPubkey, dp.positionPubkey, ownerStr)
      for (const ev of events) {
        saveEvent({
          positionPubkey: dp.positionPubkey,
          signature: ev.signature,
          blockTime: ev.blockTime,
          eventType: ev.eventType,
          tokenXDelta: ev.tokenXDelta,
          tokenYDelta: ev.tokenYDelta,
          solDelta: ev.solDelta,
          basisSolDelta: 0,
          confidence: ev.confidence,
          rawSummary: ev.rawSummary,
          createdAt: Date.now(),
        })
        if (ev.signature !== 'unknown') {
          setSyncState(dp.positionPubkey, ev.signature)
        }
      }

      const { basisSol, confidence } = await computeBasisFromEvents(events, detail.tokenXMint, detail.tokenYMint)

      upsertPosition({
        positionPubkey: dp.positionPubkey,
        poolPubkey: dp.poolPubkey,
        tokenXMint: detail.tokenXMint,
        tokenYMint: detail.tokenYMint,
        owner: ownerStr,
        basisSol,
        basisConfidence: confidence,
        tpPercent: config.defaultTpPercent,
        slPercent: config.defaultSlPercent,
        status: 'monitoring',
        triggerConfirmations: 0,
        lastPnlPercent: null,
        lastEstimatedExitSol: null,
        lastSeenAt: Date.now(),
      })

      sendNotification(formatPositionDiscovered(dp.positionPubkey, dp.poolPubkey, basisSol, confidence))
      console.log(`[discovery] registered position ${dp.positionPubkey.slice(0, 8)} basis=${basisSol.toFixed(4)}: confidence=${confidence}`)
    } catch (err) {
      console.log(`[discovery] failed on ${dp.positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
}

async function monitorCycle(connection: Connection, walletPubkey: PublicKey, ownerStr: string): Promise<void> {
  const positions = loadActivePositions()
  if (positions.length === 0) return

  for (const pos of positions) {
    if (pos.status === 'exiting') {
      if (pos.positionPubkey) {
        checkExitCooldown(pos.positionPubkey)
      }
      continue
    }

    try {
      const pool = await getPool(connection, new PublicKey(pos.poolPubkey))
      const detail = await getPositionDetail(connection, pool, new PublicKey(pos.positionPubkey))
      if (!detail) {
        updatePositionStatus(pos.positionPubkey, 'error')
        continue
      }

      if (!detail.active) {
        updatePositionStatus(pos.positionPubkey, 'closed')
        continue
      }

      const valuation = await estimateExitValue(connection, detail)
      if (!valuation || valuation.estimatedExitSol <= 0) continue

      updatePositionPnl(pos.positionPubkey, 0, valuation.estimatedExitSol)

      let pnlPercent: number
      if (pos.basisSol > 0) {
        pnlPercent = ((valuation.estimatedExitSol - pos.basisSol) / pos.basisSol) * 100
      } else {
        pnlPercent = 0
      }

      updatePositionPnl(pos.positionPubkey, pnlPercent, valuation.estimatedExitSol)

      const decision = evaluateTrigger(pos, pnlPercent)
      if (decision.shouldTrigger && decision.triggerType) {
        sendNotification(
          formatExitStarted(pos.positionPubkey, decision.triggerType, pnlPercent)
        )

        const result = await executeExit(
          connection,
          getWallet(),
          pos.positionPubkey,
          pos.poolPubkey,
          pos.tokenXMint,
          pos.tokenYMint,
          decision.triggerType,
          pnlPercent,
          pos.basisSol,
          valuation.estimatedExitSol
        )

        if (result.success) {
          const finalPnl = pos.basisSol > 0
            ? ((result.solReceived - pos.basisSol) / pos.basisSol) * 100
            : 0
          sendNotification(
            formatExitSuccess(
              pos.positionPubkey,
              result.solReceived,
              finalPnl,
              result.removeLiqSig || '',
              result.swapSig
            )
          )
        } else {
          sendNotification(
            formatExitFailed(pos.positionPubkey, result.error || 'unknown error')
          )
          updatePositionStatus(pos.positionPubkey, 'monitoring')
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

function checkExitCooldown(pubkey: string): void {
  const now = Date.now()
  const last = exitCooldowns.get(pubkey) || 0
  if (now - last > config.exitCooldownMs) {
    const db = getDb()
    const row = db.prepare("SELECT status FROM positions WHERE position_pubkey = ? AND status = 'exiting'").get(pubkey)
    const execRow = db.prepare(
      "SELECT status FROM executions WHERE position_pubkey = ? ORDER BY created_at DESC LIMIT 1"
    ).get(pubkey) as any
    if (execRow && (execRow.status === 'completed' || execRow.status === 'failed')) {
      updatePositionStatus(pubkey, execRow.status === 'completed' ? 'closed' : 'error')
    }
    exitCooldowns.set(pubkey, now)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
