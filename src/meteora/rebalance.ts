import { Connection, Keypair } from '@solana/web3.js'
import { MAX_BINS_PER_POSITION } from '@meteora-ag/dlmm'
import { getDb, listSyncValues } from '../db/client.js'
import { getWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { loadKnownPositions, updateAutoRebalanceEnabled, updateRebalanceBusy, updateRebalanceState } from './discovery.js'
import { executeRebalanceOpen, pendingOpenExists } from './open.js'
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
  createdAt: number
}

export function persistRebalanceReopenIntent(
  owner: string,
  intent: Omit<RebalanceReopenIntent, 'version' | 'owner' | 'createdAt'>,
): void {
  const value: RebalanceReopenIntent = { version: 1, owner, ...intent, createdAt: Date.now() }
  getDb().prepare('INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(`${REBALANCE_REOPEN_PREFIX}${owner}`, JSON.stringify(value), value.createdAt)
}

export function listRebalanceReopenIntents(): RebalanceReopenIntent[] {
  return listSyncValues(REBALANCE_REOPEN_PREFIX).flatMap(row => {
    try {
      const intent = JSON.parse(row.value) as RebalanceReopenIntent
      if (
        intent.version !== 1
        || !intent.owner
        || !intent.positionPubkey
        || !intent.poolPubkey
        || !['SOL', 'USDC'].includes(intent.quoteCurrency)
        || !Number.isFinite(intent.amountQuote) || intent.amountQuote <= 0
        || !Number.isInteger(intent.rangeWidth) || intent.rangeWidth < 1
      ) {
        return []
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

export type ReopenDecision = 'defer' | 'reopen' | 'abort' | 'ignore'

export function decideRebalanceReopen(status: PositionRow['status'] | undefined): ReopenDecision {
  if (status === undefined) return 'abort'
  if (status === 'monitoring' || status === 'exiting' || status === 'discovering') return 'defer'
  if (status === 'error') return 'abort'
  if (status === 'closed') return 'reopen'
  return 'ignore'
}

export type RebalanceCloseDisposition = 'deferred' | 'failed' | 'ok'

export function rebalanceCloseDisposition(result: { success: boolean; pendingRecovery: boolean }): RebalanceCloseDisposition {
  if (result.pendingRecovery) return 'deferred'
  if (!result.success) return 'failed'
  return 'ok'
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
        if (pendingOpenExists(owner)) {
          console.log(`[rebalance] reopen ${pair} deferred: another open is pending`)
          continue
        }

        const position = loadKnownPositions().find(p => p.positionPubkey === intent.positionPubkey)
        const decision = decideRebalanceReopen(position?.status)
        if (decision === 'defer') continue
        if (decision === 'ignore') continue

        if (decision === 'abort') {
          deleteRebalanceReopenIntent(owner)
          updateRebalanceBusy(intent.positionPubkey, false)
          if (!position) {
            console.log(`[rebalance] reopen intent ${pair} dropped: position no longer tracked`)
          } else {
            console.log(`[rebalance] reopen ${pair} cancelled: close failed (status ${position.status})`)
            sendNotification(
              `⚠️ <b>Auto Rebalance Close Failed</b>\n\n` +
              `Position: <code>${intent.positionPubkey}</code>\n` +
              `Status: <code>${position.status}</code>\n\n` +
              `Funds are safe in the wallet. Review the position manually.`
            )
          }
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
        if (position?.autoRebalanceEnabled) {
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
