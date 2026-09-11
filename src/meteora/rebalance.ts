import { Connection, Keypair } from '@solana/web3.js'
import { MAX_BINS_PER_POSITION } from '@meteora-ag/dlmm'
import { getDb, listSyncValues } from '../db/client.js'
import { getWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { loadKnownPositions, updateRebalanceBusy, updateRebalanceState } from './discovery.js'
import { executeRebalanceOpen, OpenSubmissionPendingError, pendingOpenExists } from './open.js'
import { executeExit, readCloseTokenReceipt } from './exit.js'
import { sendNotification } from '../telegram.js'
import type { PositionRow, QuoteCurrency, RebalanceDirection, RebalanceMode } from '../types.js'

export type RebalanceTimerStatus = 'none' | 'waiting' | 'ready'

export function isOorAbove(activeBinId: number | undefined, upperBinId: number | undefined): boolean {
  return activeBinId !== undefined && upperBinId !== undefined && activeBinId > upperBinId
}

export function rebalanceOorDirection(active: number | undefined, lower: number | undefined, upper: number | undefined): RebalanceDirection | null {
  if (![active, lower, upper].every(value => Number.isInteger(value)) || lower! > upper!) return null
  return active! > upper! ? 'up' : active! < lower! ? 'down' : null
}

export function rebalanceDirectionEnabled(mode: RebalanceMode, direction: RebalanceDirection | null): direction is RebalanceDirection {
  return direction !== null && (mode === 'both' || mode === direction)
}

export function nextRebalanceTimer(input: {
  direction: RebalanceDirection | null; mode: RebalanceMode; since: number | null;
  previousDirection: RebalanceDirection | null; now: number; minutes: number;
}): { since: number | null; direction: RebalanceDirection | null; ready: boolean } {
  if (!rebalanceDirectionEnabled(input.mode, input.direction)) return { since: null, direction: null, ready: false }
  if (input.previousDirection !== input.direction || rebalanceTimerStatus(input.since, input.now, input.minutes) === 'none') {
    return { since: input.now, direction: input.direction, ready: false }
  }
  return { since: input.since, direction: input.direction, ready: rebalanceTimerStatus(input.since, input.now, input.minutes) === 'ready' }
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

export function buildRebalanceRange(activeBinId: number, width: number, direction: RebalanceDirection = 'up'): RebalanceRange {
  if (!Number.isInteger(activeBinId)) throw new Error('Active bin id is invalid')
  if (!Number.isInteger(width) || width < 1) throw new Error('Rebalance range width must be at least 1 bin')
  const maxBins = Number(MAX_BINS_PER_POSITION.toString())
  if (width > maxBins) throw new Error(`Rebalance range ${width} bins exceeds the ${maxBins}-bin position limit`)
  if (direction !== 'up' && direction !== 'down') throw new Error('Rebalance direction is invalid')
  if (direction === 'down') return { minBinId: activeBinId, maxBinId: activeBinId + width - 1 }
  return {
    minBinId: activeBinId - width + 1,
    maxBinId: activeBinId,
  }
}

const REBALANCE_REOPEN_PREFIX = 'rebalance_reopen:'

export interface RebalanceReopenIntent {
  version: 1 | 2
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
  direction: RebalanceDirection
  rebalanceMode: RebalanceMode
  trailingDisabled: boolean
  binRangeDisabled: boolean
  tokenMint: string | null
  tokenAmountRaw: string | null
  closeRequested: boolean
  closePnlPercent: number
  closeEstimatedQuote: number
  lastNotifyKey: string | null
  lastNotifyAt: number | null
}

const REBALANCE_NOTIFY_COOLDOWN_MS = 15 * 60_000

export function persistRebalanceReopenIntent(
  owner: string,
  intent: Omit<RebalanceReopenIntent, 'version' | 'owner' | 'openPositionPubkey' | 'openSignature' | 'createdAt' | 'lastNotifyKey' | 'lastNotifyAt'>,
): void {
  const value: RebalanceReopenIntent = {
    version: 2,
    owner,
    ...intent,
    openPositionPubkey: null,
    openSignature: null,
    createdAt: Date.now(),
    lastNotifyKey: null,
    lastNotifyAt: null,
  }
  getDb().prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(`${REBALANCE_REOPEN_PREFIX}${owner}`, JSON.stringify(value), value.createdAt)
}

export function updateRebalanceReopenAttempt(owner: string, openPositionPubkey: string, openSignature: string): void {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(`${REBALANCE_REOPEN_PREFIX}${owner}`) as { value: string } | undefined
  if (!row) throw new Error('Rebalance intent missing before open submission')
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
        (parsed.version !== 1 && parsed.version !== 2)
        || !parsed.owner
        || !parsed.positionPubkey
        || !parsed.poolPubkey
        || !['SOL', 'USDC'].includes(parsed.quoteCurrency || '')
        || !Number.isFinite(parsed.amountQuote) || (parsed.amountQuote || 0) <= 0
        || !Number.isInteger(parsed.rangeWidth) || (parsed.rangeWidth || 0) < 1
        || (parsed.version === 2 && (
          !['up', 'down'].includes(parsed.direction || '')
          || !['up', 'down', 'both'].includes(parsed.rebalanceMode || '')
          || typeof parsed.trailingDisabled !== 'boolean' || typeof parsed.binRangeDisabled !== 'boolean'
          || typeof parsed.closeRequested !== 'boolean'
          || !Number.isFinite(parsed.closePnlPercent) || !Number.isFinite(parsed.closeEstimatedQuote)
          || (parsed.direction === 'down' && !parsed.tokenMint)
          || (parsed.tokenAmountRaw !== null && !/^[1-9]\d*$/.test(parsed.tokenAmountRaw || ''))
        ))
      ) {
        return []
      }
      const original = parsed.version === 1 ? loadKnownPositions().find(p => p.positionPubkey === parsed.positionPubkey) : undefined
      const intent: RebalanceReopenIntent = {
        version: parsed.version!,
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
        direction: parsed.direction ?? 'up',
        rebalanceMode: parsed.rebalanceMode ?? 'up',
        trailingDisabled: parsed.trailingDisabled ?? original?.trailingDisabled ?? false,
        binRangeDisabled: parsed.binRangeDisabled ?? original?.binRangeDisabled ?? false,
        tokenMint: parsed.tokenMint ?? null,
        tokenAmountRaw: parsed.tokenAmountRaw ?? null,
        closeRequested: parsed.closeRequested ?? false,
        closePnlPercent: parsed.closePnlPercent ?? 0,
        closeEstimatedQuote: parsed.closeEstimatedQuote ?? 0,
        lastNotifyKey: typeof parsed.lastNotifyKey === 'string' ? parsed.lastNotifyKey : null,
        lastNotifyAt: Number.isSafeInteger(parsed.lastNotifyAt) ? parsed.lastNotifyAt as number : null,
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

function restoreLegacyRebalanceSettings(intent: RebalanceReopenIntent, pubkey: string): void {
  getDb().prepare(`UPDATE positions SET trailing_disabled = ?, bin_range_disabled = ?,
    auto_rebalance_enabled = ?, rebalance_mode = ?, peak_pnl_percent = 0, trailing_activated = 0,
    trigger_confirmations = 0, updated_at = ? WHERE position_pubkey = ?`)
    .run(Number(intent.trailingDisabled), Number(intent.binRangeDisabled), Number(intent.inheritMode), intent.rebalanceMode, Date.now(), pubkey)
}

function completeRebalanceIntent(intent: RebalanceReopenIntent, newPositionPubkey: string): void {
  getDb().transaction(() => {
    if (intent.version === 1) restoreLegacyRebalanceSettings(intent, newPositionPubkey)
    updateRebalanceState(intent.positionPubkey, Date.now())
    deleteRebalanceReopenIntent(intent.owner)
  })()
}

export function isTerminalRebalanceOpenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^Range requires \d+ (?:positions|setup transactions); reduce the percentage range$/.test(message)
    || message === 'Rebalance close returned no deposit token'
    || message === 'Down rebalance is unsupported when the quote token is X'
    || message === 'Down rebalance token mint must match pool token X'
    || /Insufficient .+ balance/.test(message)
}

/**
 * Sends at most one notification per cooldown for the same category (key),
 * persisting the marker in the durable intent so restarts cannot un-throttle it.
 */
function notifyRebalanceIntent(
  intent: RebalanceReopenIntent,
  key: string,
  message: string,
  notify: typeof sendNotification,
): boolean {
  const now = Date.now()
  if (
    intent.lastNotifyKey === key
    && intent.lastNotifyAt !== null
    && now - intent.lastNotifyAt < REBALANCE_NOTIFY_COOLDOWN_MS
  ) {
    return false
  }
  intent.lastNotifyKey = key
  intent.lastNotifyAt = now
  getDb().prepare('UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ?')
    .run(JSON.stringify(intent), now, `${REBALANCE_REOPEN_PREFIX}${intent.owner}`)
  notify(message)
  return true
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

export interface RebalanceReconcileServices {
  close: typeof executeExit
  open: typeof executeRebalanceOpen
  notify: typeof sendNotification
}

export async function reconcilePendingRebalanceOpens(
  connection: Connection, wallet: Keypair,
  services: RebalanceReconcileServices = { close: executeExit, open: executeRebalanceOpen, notify: sendNotification },
): Promise<void> {
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

        let oldPosition = loadKnownPositions().find(p => p.positionPubkey === intent.positionPubkey)
        // The intent precedes closing, so a restart between these two steps can resume safely.
        if (intent.closeRequested && !intent.openPositionPubkey && oldPosition?.status === 'monitoring') {
          const result = await services.close(connection, wallet, oldPosition.positionPubkey, oldPosition.poolPubkey,
            oldPosition.tokenXMint, oldPosition.tokenYMint, 'MANUAL', intent.closePnlPercent,
            oldPosition.quoteCurrency, oldPosition.basisQuote, intent.closeEstimatedQuote, true, true)
          if (rebalanceCloseDisposition(result) === 'deferred') continue
          if (rebalanceCloseDisposition(result) === 'failed') {
            deleteRebalanceReopenIntent(owner)
            updateRebalanceBusy(intent.positionPubkey, false)
            throw new Error(result.error || 'Rebalance close failed; next valid monitoring cycle may retry')
          }
          oldPosition = loadKnownPositions().find(p => p.positionPubkey === intent.positionPubkey)
        }
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
            services.notify(
              `⚠️ <b>Auto Rebalance Reopen Failed</b>\n\n` +
              `Position: <code>${intent.positionPubkey}</code>\n` +
              `Open attempt: <code>${intent.openPositionPubkey}</code>\n\n` +
              `Funds are safe in the wallet. Review the position manually.`
            )
          } else if (!oldPosition) {
            console.log(`[rebalance] reopen intent ${pair} dropped: position no longer tracked`)
          } else {
            console.log(`[rebalance] reopen ${pair} cancelled: close failed (status ${oldPosition.status})`)
            services.notify(
              `⚠️ <b>Auto Rebalance Close Failed</b>\n\n` +
              `Position: <code>${intent.positionPubkey}</code>\n` +
              `Status: <code>${oldPosition.status}</code>\n\n` +
              `Funds are safe in the wallet. Review the position manually.`
            )
          }
          continue
        }

        if (decision === 'complete' && intent.openPositionPubkey) {
          completeRebalanceIntent(intent, intent.openPositionPubkey)
          console.log(`[rebalance] reopened ${pair} as ${intent.openPositionPubkey.slice(0, 8)}`)
          services.notify(
            `✅ <b>Auto Rebalance Complete</b>\n\n` +
            `Old position closed (no swap): <code>${intent.positionPubkey}</code>\n` +
            `New position: <code>${intent.openPositionPubkey}</code>\n` +
            `Open: ${intent.openSignature ? `<a href="https://solscan.io/tx/${intent.openSignature}">${intent.openSignature.slice(0, 6)}..${intent.openSignature.slice(-4)}</a>` : '-'}`
          )
          continue
        }

        if (intent.direction === 'down' && intent.tokenAmountRaw === null) {
          const raw = readCloseTokenReceipt(intent.positionPubkey, intent.tokenMint!)
          if (raw === null) throw new Error('Waiting for confirmed close token receipt')
          if (!/^[1-9]\d*$/.test(raw)) throw new Error('Rebalance close returned no deposit token')
          intent.tokenAmountRaw = raw
          getDb().prepare('UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(intent), Date.now(), `${REBALANCE_REOPEN_PREFIX}${owner}`)
        }
        const result = await services.open(connection, wallet, {
          poolPubkey: intent.poolPubkey,
          quoteCurrency: intent.quoteCurrency,
          amountQuote: intent.amountQuote,
          rangeWidth: intent.rangeWidth,
          direction: intent.direction,
          tokenAmountRaw: intent.tokenAmountRaw ?? undefined,
          tokenMint: intent.tokenMint ?? undefined,
          trailingDisabled: intent.trailingDisabled,
          binRangeDisabled: intent.binRangeDisabled,
          rebalanceMode: intent.rebalanceMode,
          inheritMode: intent.inheritMode,
          onPrepared: (pubkey, signature) => updateRebalanceReopenAttempt(owner, pubkey, signature),
        }, true)
        completeRebalanceIntent(intent, result.positionPubkey)
        console.log(`[rebalance] reopened ${pair} as ${result.positionPubkey.slice(0, 8)} (range ${result.preview.minBinId}-${result.preview.maxBinId})`)
        services.notify(
          `✅ <b>Auto Rebalance Complete</b>\n\n` +
          `Old position closed (no swap): <code>${intent.positionPubkey}</code>\n` +
          `New position: <code>${result.positionPubkey}</code>\n` +
          `Range: <b>${result.preview.minBinId}-${result.preview.maxBinId}</b>\n` +
          `Direction: <b>${intent.direction.toUpperCase()}</b>\n` +
          (intent.direction === 'down' ? `Deposit: <b>${result.preview.amountInput} ${result.preview.baseSymbol}</b>\n` : '') +
          `Deposit value: <b>${result.preview.amountQuote.toFixed(4)} ${intent.quoteCurrency}</b>\n` +
          `Open: <a href="https://solscan.io/tx/${result.signature}">${result.signature.slice(0, 6)}..${result.signature.slice(-4)}</a>`
        )
      } catch (err) {
        if (err instanceof OpenSubmissionPendingError) {
          updateRebalanceReopenAttempt(owner, err.positionPubkey, err.signature)
          console.log(`[rebalance] reopen ${pair} attempt submitted ${err.positionPubkey.slice(0, 8)} — waiting for finality reconciliation`)
          const latest = listRebalanceReopenIntents().find(item => item.owner === owner) ?? intent
          notifyRebalanceIntent(
            latest,
            `pending:${err.signature}`,
            `⏳ <b>Auto Rebalance — Reopen In Progress</b>\n\n` +
            `Position: <code>${intent.positionPubkey}</code>\n` +
            `Open tx: <a href="https://solscan.io/tx/${err.signature}">${err.signature.slice(0, 6)}..${err.signature.slice(-4)}</a>\n` +
            `Menunggu finalisasi open; notifikasi sukses menyusul.`,
            services.notify,
          )
          continue
        }
        const message = err instanceof Error ? err.message : 'unknown error'
        if (isTerminalRebalanceOpenError(err)) {
          deleteRebalanceReopenIntent(owner)
          updateRebalanceBusy(intent.positionPubkey, false)
          console.log(`[rebalance] reopen ${pair} stopped: ${message}`)
          services.notify(
            `🛑 <b>Auto Rebalance Reopen Stopped</b>\n\n` +
            `Position: <code>${intent.positionPubkey}</code>\n` +
            `Reason: <code>${message}</code>\n\n` +
            `Funds remain in the wallet. Review the reason before reopening manually.`
          )
          continue
        }
        const notified = notifyRebalanceIntent(
          intent,
          `retry:${message}`,
          `⚠️ <b>Auto Rebalance Reopen Retrying</b>\n\n` +
          `Position: <code>${intent.positionPubkey}</code>\n` +
          `Reason: <code>${message}</code>\n\n` +
          `Bot will retry the reopen automatically.`,
          services.notify,
        )
        if (notified) console.log(`[rebalance] reopen ${pair} attempt failed: ${message}`)
      }
    }
  })
}
