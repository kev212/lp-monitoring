import { Connection, Keypair } from '@solana/web3.js'
import { MAX_BINS_PER_POSITION } from '@meteora-ag/dlmm'
import { getDb, listSyncValues } from '../db/client.js'
import { getWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { loadKnownPositions, updateAutoRebalanceEnabled, updateRebalanceBusy, updateRebalanceState } from './discovery.js'
import { executeRebalanceOpen, OpenSubmissionPendingError, pendingOpenExists } from './open.js'
import { sendNotification } from '../telegram.js'
import type { PositionRow, QuoteCurrency } from '../types.js'

export type RebalanceTimerStatus = 'none' | 'waiting' | 'ready'

export function isOorAbove(activeBinId: number | undefined, upperBinId: number | undefined): boolean {
  return activeBinId !== undefined && upperBinId !== undefined && activeBinId > upperBinId
}

export function rebalanceTimerStatus(
  oorSince: number | null,
  now: number,
  oorMinutes: number,
): RebalanceTimerStatus {
  if (oorSince === null || !Number.isFinite(oorSince)) return 'none'
  const elapsedMs = now - oorSince
  if (elapsedMs < 0) return 'none'
  if (elapsedMs >= oorMinutes * 60_000) return 'ready'
  return 'waiting'
}

export interface RebalanceRange {
  minBinId: number
  maxBinId: number
}

export function buildRebalanceRange(activeBinId: number, width: number): RebalanceRange {
  if (!Number.isInteger(activeBinId)) throw new Error('Active bin id is invalid')
  if (!Number.isInteger(width) || width < 1) throw new Error('Rebalance range width must be at least 1 bin')
  const maxBins = Number(MAX_BINS_PER_POSITION.toString())
  if (width > maxBins) throw new Error(`Rebalance range ${width} bins exceeds the ${maxBins}-bin position limit`)
  return {
    minBinId: activeBinId - width + 1,
    maxBinId: activeBinId,
  }
}

const REBALANCE_REOPEN_PREFIX = 'rebalance_reopen:'

export interface RebalanceReopenIntent {
  version: 1
  owner: string
  positionPubkey: string
  poolPubkey: string
  quoteCurrency: QuoteCurrency
  amountQuote: number
  rangeWidth: number
  openPositionPubkey: string | null
  openSignature: string | null
  inheritMode: boolean
  createdAt: number
}

export function persistRebalanceReopenIntent(
  owner: string,
  intent: Omit<RebalanceReopenIntent, 'version' | 'owner' | 'openPositionPubkey' | 'openSignature' | 'createdAt'>,
): void {
  const value: RebalanceReopenIntent = {
    version: 1,
    owner,
    ...intent,
    openPositionPubkey: null,
    openSignature: null,
    createdAt: Date.now(),
  }
  getDb().prepare('INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(`${REBALANCE_REOPEN_PREFIX}${owner}`, JSON.stringify(value), value.createdAt)
}

export function updateRebalanceReopenAttempt(owner: string, openPositionPubkey: string, openSignature: string): void {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(`${REBALANCE_REOPEN_PREFIX}${owner}`) as { value: string } | undefined
  if (!row) return
  const intent = JSON.parse(row.value) as RebalanceReopenIntent
  const updated: RebalanceReopenIntent = { ...intent, openPositionPubkey, openSignature }
  getDb().prepare('UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ?')
    .run(JSON.stringify(updated), Date.now(), `${REBALANCE_REOPEN_PREFIX}${owner}`)
}

export function listRebalanceReopenIntents(): RebalanceReopenIntent[] {
  return listSyncValues(REBALANCE_REOPEN_PREFIX).flatMap(row => {
    try {
      const parsed = JSON.parse(row.value) as Partial<RebalanceReopenIntent>
      if (
        parsed.version !== 1
        || !parsed.owner
        || !parsed.positionPubkey
        || !parsed.poolPubkey
        || !['SOL', 'USDC'].includes(parsed.quoteCurrency || '')
        || !Number.isFinite(parsed.amountQuote) || (parsed.amountQuote || 0) <= 0
        || !Number.isInteger(parsed.rangeWidth) || (parsed.rangeWidth || 0) < 1
      ) {
        return []
      }
      const intent: RebalanceReopenIntent = {
        version: 1,
        owner: parsed.owner!,
        positionPubkey: parsed.positionPubkey!,
        poolPubkey: parsed.poolPubkey!,
        quoteCurrency: parsed.quoteCurrency as QuoteCurrency,
        amountQuote: parsed.amountQuote!,
        rangeWidth: parsed.rangeWidth!,
        openPositionPubkey: parsed.openPositionPubkey || null,
        openSignature: parsed.openSignature || null,
        inheritMode: parsed.inheritMode !== false,
        createdAt: parsed.createdAt || 0,
      }
      return [intent]
    } catch {
      console.log(`[rebalance] malformed reopen intent ${row.key}`)
      return []
    }
  })
}

export function deleteRebalanceReopenIntent(owner: string): void {
  getDb().prepare('DELETE FROM sync_state WHERE key = ?').run(`${REBALANCE_REOPEN_PREFIX}${owner}`)
}

export type RebalanceCloseDisposition = 'deferred' | 'failed' | 'ok'

export function rebalanceCloseDisposition(result: { success: boolean; pendingRecovery: boolean }): RebalanceCloseDisposition {
  if (result.pendingRecovery) return 'deferred'
  if (!result.success) return 'failed'
  return 'ok'
}

export type ReopenAttemptDecision = 'execute' | 'complete' | 'defer' | 'abort'

export function decideRebalanceOpenAttempt(input: {
  intentHasOpenPosition: boolean
  pendingOpen: boolean
  oldPositionStatus: PositionRow['status'] | undefined
  newPositionStatus: PositionRow['status'] | undefined
}): ReopenAttemptDecision {
  if (input.intentHasOpenPosition) {
    if (input.newPositionStatus === 'monitoring') return 'complete'
    if (input.newPositionStatus === 'opening' || input.pendingOpen) return 'defer'
    return 'abort'
  }
  if (input.pendingOpen) return 'defer'
  if (input.oldPositionStatus === 'closed') return 'execute'
  if (input.oldPositionStatus === 'error' || input.oldPositionStatus === undefined) return 'abort'
  return 'defer'
}

export async function reconcilePendingRebalanceOpens(connection: Connection, wallet: Keypair): Promise<void> {
  await withWalletExecutionLock(async () => {
    const owner = wallet.publicKey.toBase58()
    for (const intent of listRebalanceReopenIntents()) {
      if (intent.owner !== owner) continue
      const pair = `${intent.positionPubkey.slice(0, 8)}`
      try {
        if (getWalletOperation(owner)) {
          console.log(`[rebalance] reopen ${pair} deferred: wallet operation pending`)
          continue
        }

        const oldPosition = loadKnownPositions().find(p => p.positionPubkey === intent.positionPubkey)
        const newPosition = intent.openPositionPubkey
          ? loadKnownPositions().find(p => p.positionPubkey === intent.openPositionPubkey)
          : undefined
        const decision = decideRebalanceOpenAttempt({
          intentHasOpenPosition: intent.openPositionPubkey !== null,
          pendingOpen: pendingOpenExists(owner),
          oldPositionStatus: oldPosition?.status,
          newPositionStatus: newPosition?.status,
        })

        if (decision === 'defer') {
          console.log(`[rebalance] reopen ${pair} deferred: waiting for open to settle`)
          continue
        }

        if (decision === 'abort') {
          deleteRebalanceReopenIntent(owner)
          updateRebalanceBusy(intent.positionPubkey, false)
          if (intent.openPositionPubkey) {
            console.log(`[rebalance] reopen ${pair} aborted: open attempt ${intent.openPositionPubkey.slice(0, 8)} failed or expired`)
            sendNotification(
              `⚠️ <b>Auto Rebalance Reopen Failed</b>\n\n` +
              `Position: <code>${intent.positionPubkey}</code>\n` +
              `Open attempt: <code>${intent.openPositionPubkey}</code>\n\n` +
              `Funds are safe in the wallet. Review the position manually.`
            )
          } else if (!oldPosition) {
            console.log(`[rebalance] reopen intent ${pair} dropped: position no longer tracked`)
          } else {
            console.log(`[rebalance] reopen ${pair} cancelled: close failed (status ${oldPosition.status})`)
            sendNotification(
              `⚠️ <b>Auto Rebalance Close Failed</b>\n\n` +
              `Position: <code>${intent.positionPubkey}</code>\n` +
              `Status: <code>${oldPosition.status}</code>\n\n` +
              `Funds are safe in the wallet. Review the position manually.`
            )
          }
          continue
        }

        if (decision === 'complete' && intent.openPositionPubkey) {
          deleteRebalanceReopenIntent(owner)
          updateRebalanceState(intent.positionPubkey, Date.now())
          if (intent.inheritMode) {
            updateAutoRebalanceEnabled(intent.openPositionPubkey, true)
          }
          console.log(`[rebalance] reopened ${pair} as ${intent.openPositionPubkey.slice(0, 8)}`)
          sendNotification(
            `✅ <b>Auto Rebalance Complete</b>\n\n` +
            `Old position closed (no swap): <code>${intent.positionPubkey}</code>\n` +
            `New position: <code>${intent.openPositionPubkey}</code>\n` +
            `Open: ${intent.openSignature ? `<a href="https://solscan.io/tx/${intent.openSignature}">${intent.openSignature.slice(0, 6)}..${intent.openSignature.slice(-4)}</a>` : '-'}`
          )
          continue
        }

        const result = await executeRebalanceOpen(connection, wallet, {
          poolPubkey: intent.poolPubkey,
          quoteCurrency: intent.quoteCurrency,
          amountQuote: intent.amountQuote,
          rangeWidth: intent.rangeWidth,
        }, true)
        deleteRebalanceReopenIntent(owner)
        updateRebalanceState(intent.positionPubkey, Date.now())
        if (intent.inheritMode) {
          updateAutoRebalanceEnabled(result.positionPubkey, true)
        }
        console.log(`[rebalance] reopened ${pair} as ${result.positionPubkey.slice(0, 8)} (range ${result.preview.minBinId}-${result.preview.maxBinId})`)
        sendNotification(
          `✅ <b>Auto Rebalance Complete</b>\n\n` +
          `Old position closed (no swap): <code>${intent.positionPubkey}</code>\n` +
          `New position: <code>${result.positionPubkey}</code>\n` +
          `Range: <b>${result.preview.minBinId}-${result.preview.maxBinId}</b>\n` +
          `Deposit: <b>${result.preview.amountQuote.toFixed(4)} ${intent.quoteCurrency}</b>\n` +
          `Open: <a href="https://solscan.io/tx/${result.signature}">${result.signature.slice(0, 6)}..${result.signature.slice(-4)}</a>`
        )
      } catch (err) {
        if (err instanceof OpenSubmissionPendingError) {
          updateRebalanceReopenAttempt(owner, err.positionPubkey, err.signature)
          console.log(`[rebalance] reopen ${pair} attempt submitted ${err.positionPubkey.slice(0, 8)} — waiting for finality reconciliation`)
          sendNotification(
            `⏳ <b>Auto Rebalance — Reopen In Progress</b>\n\n` +
            `Position: <code>${intent.positionPubkey}</code>\n` +
            `Open tx: <a href="https://solscan.io/tx/${err.signature}">${err.signature.slice(0, 6)}..${err.signature.slice(-4)}</a>\n` +
            `Menunggu finalisasi open; notifikasi sukses menyusul.`
          )
          continue
        }
        const message = err instanceof Error ? err.message : 'unknown error'
        console.log(`[rebalance] reopen ${pair} attempt failed: ${message}`)
        sendNotification(
          `⚠️ <b>Auto Rebalance Reopen Retrying</b>\n\n` +
          `Position: <code>${intent.positionPubkey}</code>\n` +
          `Reason: <code>${message}</code>\n\n` +
          `Bot will retry the reopen automatically.`
        )
      }
    }
  })
}
