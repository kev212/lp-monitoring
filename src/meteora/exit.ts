import { randomUUID } from 'node:crypto'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { getPool } from './positions.js'
import { getDb, listSyncValues } from '../db/client.js'
import { swapTokensToSol, type SignedSwapAttempt } from '../swap.js'
import { config } from '../config.js'
import { confirmSignature } from '../solana/confirmation.js'
import type { ExecutionRow, ExitCompletionNotification, ExitStatus, QuoteCurrency, TriggerType } from '../types.js'
import { updatePositionStatus } from './discovery.js'
import {
  releaseWalletOperation,
  tryAcquireWalletOperation,
  walletOperationKey,
  withWalletExecutionLock,
} from '../executionLock.js'

const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'So11111111111111111111111111111111111111111',
])
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const EXIT_PENDING_PREFIX = 'exit_pending:'
const EXIT_NOTIFICATION_PREFIX = 'exit_notification:'
const EXPIRED_ABSENCE_CHECKS = 2
const EXPIRED_ABSENCE_MIN_INTERVAL_MS = 5_000
const RECONCILIATION_PROBE_TIMEOUT_MS = 2_000

class ConfirmedTransactionError extends Error {}

export interface SignedRemoveAttempt {
  signature: string
  blockhash: string
  lastValidBlockHeight: number
  signedTransaction: string
}

type ExitStage = 'pending_remove' | 'swap_pending' | 'finalizing'

interface FinalizingExitAttempt {
  kind: 'remove' | 'swap'
  attempt: SignedRemoveAttempt | SignedSwapAttempt
  resumeStage: Exclude<ExitStage, 'finalizing'>
  confirmedAt: number
}

interface ExitPendingState {
  version: 4
  revision: number
  leaseId: string
  executionId: number
  positionPubkey: string
  poolPubkey: string
  owner: string
  tokenXMint: string
  tokenYMint: string
  triggerType: TriggerType
  pnlPercent: number
  quoteCurrency: QuoteCurrency
  basisQuote: number
  estimatedExitQuote: number
  preSolBalance: number
  preUsdcBalance: string
  preSwapTokenBalances: Record<string, string>
  rentRefundSol: number
  stage: ExitStage
  removeSignatures: string[]
  swapSignatures: string[]
  currentRemove: SignedRemoveAttempt | null
  currentSwap: SignedSwapAttempt | null
  finalizing: FinalizingExitAttempt[]
  missingAfterExpiryChecks: number
  lastExpiryAbsenceAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

function executionStatusForState(state: ExitPendingState): ExitStatus {
  if (state.stage !== 'finalizing') return state.stage
  return state.finalizing[0]?.kind === 'remove' ? 'removed' : 'swap_pending'
}

export function saveExecution(row: ExecutionRow): number {
  const db = getDb()
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO executions (position_pubkey, trigger_type, trigger_pnl_percent, basis_sol,
      quote_currency, basis_quote, estimated_exit_sol, estimated_exit_quote,
      remove_liq_sig, swap_sig, final_sol_received, final_quote_received,
      status, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.positionPubkey,
    row.triggerType,
    row.triggerPnlPercent,
    row.quoteCurrency === 'SOL' ? row.basisQuote : 0,
    row.quoteCurrency,
    row.basisQuote,
    row.quoteCurrency === 'SOL' ? row.estimatedExitQuote : 0,
    row.estimatedExitQuote,
    row.removeLiqSig,
    row.swapSig,
    row.finalSolReceived ?? null,
    row.finalQuoteReceived,
    row.status,
    row.errorMessage,
    now,
    now,
  )
  return Number(result.lastInsertRowid)
}

export function updateExecution(executionId: number, status: ExitStatus, fields: Partial<ExecutionRow>): void {
  const db = getDb()
  const sets: string[] = ['status = ?', 'updated_at = ?']
  const vals: any[] = [status, Date.now()]
  if (fields.removeLiqSig !== undefined) { sets.push('remove_liq_sig = ?'); vals.push(fields.removeLiqSig) }
  if (fields.swapSig !== undefined) { sets.push('swap_sig = ?'); vals.push(fields.swapSig) }
  if (fields.finalSolReceived !== undefined) { sets.push('final_sol_received = ?'); vals.push(fields.finalSolReceived) }
  if (fields.finalQuoteReceived !== undefined) { sets.push('final_quote_received = ?'); vals.push(fields.finalQuoteReceived) }
  if (fields.errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(fields.errorMessage) }
  vals.push(executionId)
  db.prepare(`
    UPDATE executions
    SET ${sets.join(', ')}
    WHERE rowid = ?
  `).run(...vals)
}

function exitPendingKey(positionPubkey: string): string {
  return `${EXIT_PENDING_PREFIX}${positionPubkey}`
}

function exitNotificationKey(executionId: number): string {
  return `${EXIT_NOTIFICATION_PREFIX}${executionId}`
}

export function listPendingExitNotifications(): ExitCompletionNotification[] {
  return listSyncValues(EXIT_NOTIFICATION_PREFIX).flatMap(row => {
    try {
      const notification = JSON.parse(row.value) as ExitCompletionNotification
      if (!Number.isSafeInteger(notification.executionId) || !notification.positionPubkey || !notification.pair) return []
      return [notification]
    } catch {
      console.log(`[exit] malformed completion notification ${row.key}`)
      return []
    }
  })
}

export function acknowledgeExitCompletionNotification(executionId: number): void {
  getDb().prepare('DELETE FROM sync_state WHERE key = ?').run(exitNotificationKey(executionId))
}

function ensureExitWalletLease(state: ExitPendingState): void {
  const db = getDb()
  db.transaction(() => {
    const key = walletOperationKey(state.owner)
    const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) {
      db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify({
          kind: 'exit',
          operationId: state.positionPubkey,
          leaseId: state.leaseId,
          createdAt: state.createdAt,
          mutationCount: 0,
          attempt: null,
        }), Date.now())
      return
    }
    const lease = JSON.parse(row.value) as { kind?: string; operationId?: string; leaseId?: string }
    const operationMatches = lease.operationId === state.positionPubkey || lease.operationId === String(state.executionId)
    if (lease.kind !== 'exit' || !operationMatches) {
      throw new Error('wallet exit lease belongs to another execution')
    }
    if (lease.operationId !== state.positionPubkey || lease.leaseId !== state.leaseId) {
      const migratedLease = {
        kind: 'exit',
        operationId: state.positionPubkey,
        leaseId: state.leaseId,
        createdAt: state.createdAt,
        mutationCount: 0,
        attempt: null,
      }
      const migrated = db.prepare('UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
        .run(JSON.stringify(migratedLease), Date.now(), key, row.value)
      if (migrated.changes !== 1) throw new Error('wallet exit lease changed during migration')
    }
  })()
}

function parseExitPendingState(value: string): ExitPendingState {
  const parsed = JSON.parse(value) as Omit<Partial<ExitPendingState>, 'version'> & { version?: number }
  let state = parsed.version === 1 && parsed.revision === undefined
    ? { ...parsed, version: 3, revision: 0, leaseId: randomUUID() }
      : parsed.version === 2 && !parsed.leaseId
        ? { ...parsed, version: 3, leaseId: randomUUID() }
        : parsed
  if (state.version === 3) state = { ...state, version: 4, finalizing: [] }
  if (state.version === 4 && !Array.isArray(state.finalizing)) {
    state = { ...state, finalizing: state.finalizing ? [state.finalizing] : [] }
  }
  if (state.version === 4 && Array.isArray(state.finalizing)) {
    state = {
      ...state,
      finalizing: state.finalizing.map(finalizing => finalizing.kind === 'remove'
        ? { ...finalizing, resumeStage: 'pending_remove' }
        : finalizing),
    }
  }
  const validRawBalances = state.preSwapTokenBalances
    && Object.values(state.preSwapTokenBalances).every(balance => /^\d+$/.test(balance))
  const validAttempt = (attempt: SignedRemoveAttempt | SignedSwapAttempt | null | undefined): boolean => !attempt || Boolean(
    attempt.signature
    && attempt.blockhash
    && Number.isSafeInteger(attempt.lastValidBlockHeight)
    && attempt.signedTransaction
  )
  const validFinalizing = Array.isArray(state.finalizing) && state.finalizing.every(finalizing =>
    (finalizing.kind === 'remove' || finalizing.kind === 'swap')
    && validAttempt(finalizing.attempt)
    && (finalizing.resumeStage === 'pending_remove' || finalizing.resumeStage === 'swap_pending')
    && Number.isSafeInteger(finalizing.confirmedAt)
  )
  if (
    state.version !== 4
    || !Number.isSafeInteger(state.revision) || state.revision! < 0
    || !state.leaseId
    || !Number.isSafeInteger(state.executionId) || state.executionId! < 1
    || !state.positionPubkey
    || !state.poolPubkey
    || !state.owner
    || !state.tokenXMint
    || !state.tokenYMint
    || !['SOL', 'USDC'].includes(state.quoteCurrency || '')
    || !['pending_remove', 'swap_pending', 'finalizing'].includes(state.stage || '')
    || !Number.isSafeInteger(state.preSolBalance)
    || !/^\d+$/.test(state.preUsdcBalance || '')
    || !validRawBalances
    || !Array.isArray(state.removeSignatures)
    || !Array.isArray(state.swapSignatures)
    || !validAttempt(state.currentRemove)
    || !validAttempt(state.currentSwap)
    || !validFinalizing
    || (state.stage === 'finalizing' && (!state.finalizing || state.finalizing.length === 0))
  ) {
    throw new Error('durable exit state is malformed')
  }
  return state as ExitPendingState
}

function beginExit(row: ExecutionRow, pending: Omit<ExitPendingState, 'executionId'>): ExitPendingState | null {
  const db = getDb()
  try {
    return db.transaction(() => {
      const walletKey = walletOperationKey(pending.owner)
      const existingLease = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(walletKey) as { value: string } | undefined
      if (!existingLease) return null
      const lease = JSON.parse(existingLease.value) as { kind?: string; operationId?: string; leaseId?: string }
      if (lease.kind !== 'exit' || lease.operationId !== pending.positionPubkey || lease.leaseId !== pending.leaseId) return null
      const claimed = db.prepare(`
        UPDATE positions SET status = 'exiting', updated_at = ?
        WHERE position_pubkey = ? AND status IN ('monitoring', 'discovering')
      `).run(Date.now(), pending.positionPubkey)
      if (claimed.changes !== 1) return null

      const state: ExitPendingState = { ...pending, executionId: saveExecution(row) }
      db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(exitPendingKey(state.positionPubkey), JSON.stringify(state), state.updatedAt)
      return state
    })()
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) return null
    throw err
  }
}

function persistExitState(
  state: ExitPendingState,
  executionStatus: ExitStatus,
  fields: Partial<ExecutionRow> = {},
): void {
  const expectedRevision = state.revision
  const next: ExitPendingState = { ...state, revision: expectedRevision + 1, updatedAt: Date.now() }
  const db = getDb()
  db.transaction(() => {
    const result = db.prepare(`
      UPDATE sync_state SET value = ?, updated_at = ?
      WHERE key = ?
        AND json_extract(value, '$.executionId') = ?
        AND json_extract(value, '$.revision') = ?
    `).run(JSON.stringify(next), next.updatedAt, exitPendingKey(state.positionPubkey), state.executionId, expectedRevision)
    if (result.changes !== 1) throw new Error('durable exit state changed during execution')
    updateExecution(state.executionId, executionStatus, fields)
  })()
  Object.assign(state, next)
}

function finishExit(
  state: ExitPendingState,
  executionStatus: Extract<ExitStatus, 'completed' | 'failed'>,
  positionStatus: 'monitoring' | 'closed' | 'error',
  fields: Partial<ExecutionRow>,
  queueCompletionNotification = false,
): void {
  const db = getDb()
  db.transaction(() => {
    const deleted = db.prepare(`
      DELETE FROM sync_state
      WHERE key = ?
        AND json_extract(value, '$.executionId') = ?
        AND json_extract(value, '$.revision') = ?
    `).run(exitPendingKey(state.positionPubkey), state.executionId, state.revision)
    if (deleted.changes !== 1) throw new Error('refusing to finish a stale durable exit state')
    updateExecution(state.executionId, executionStatus, fields)
    updatePositionStatus(state.positionPubkey, positionStatus)
    if (executionStatus === 'completed' && queueCompletionNotification) {
      const position = db.prepare(`
        SELECT token_x_symbol, token_y_symbol
        FROM positions
        WHERE position_pubkey = ?
      `).get(state.positionPubkey) as { token_x_symbol?: string; token_y_symbol?: string } | undefined
      const notification: ExitCompletionNotification = {
        executionId: state.executionId,
        positionPubkey: state.positionPubkey,
        pair: `${position?.token_x_symbol || state.tokenXMint.slice(0, 4)}/${position?.token_y_symbol || state.tokenYMint.slice(0, 4)}`,
        triggerType: state.triggerType,
        quoteCurrency: state.quoteCurrency,
        receivedQuote: fields.finalQuoteReceived ?? fields.finalSolReceived ?? 0,
        rentRefundSol: state.rentRefundSol,
        removeLiqSig: fields.removeLiqSig ?? state.removeSignatures.at(-1) ?? null,
        swapSig: fields.swapSig ?? state.swapSignatures.at(-1) ?? null,
        createdAt: Date.now(),
      }
      db.prepare('INSERT OR IGNORE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(exitNotificationKey(state.executionId), JSON.stringify(notification), notification.createdAt)
    }
    const released = db.prepare(`
      DELETE FROM sync_state
      WHERE key = ?
        AND json_extract(value, '$.kind') = 'exit'
        AND json_extract(value, '$.operationId') = ?
        AND json_extract(value, '$.leaseId') = ?
    `).run(walletOperationKey(state.owner), state.positionPubkey, state.leaseId)
    if (released.changes !== 1) throw new Error('refusing to finish without the matching wallet exit lease')
  })()
}

export interface ExitResult {
  success: boolean
  pendingRecovery: boolean
  executionId: number | null
  removeSucceeded: boolean
  solReceived: number
  usdcReceived: number
  rentRefundSol: number
  removeLiqSig: string | null
  swapSig: string | null
  error?: string
}

export function positiveBalanceDelta(before: bigint, after: bigint): bigint {
  return after > before ? after - before : 0n
}

async function getTokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: string,
  attempts = 1,
): Promise<bigint> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise<void>(resolve => { setTimeout(resolve, 800) })
    try {
      const accounts = await connection.getTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
      let total = 0n
      for (const acc of accounts.value) {
        const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
        total += view.getBigUint64(0, true)
      }
      return total
    } catch (err) {
      lastError = err
      // Retry short-lived RPC inconsistencies after liquidity removal.
    }
  }
  throw new Error(`token balance unavailable for ${mint.slice(0, 8)}: ${lastError instanceof Error ? lastError.message : 'RPC error'}`)
}

export async function collectExitBaselines(
  connection: Connection,
  owner: PublicKey,
  quoteCurrency: QuoteCurrency,
  tokensToSwap: string[],
): Promise<{ preSolBalance: number; preUsdcBalance: bigint; preSwapTokenBalances: Map<string, bigint> }> {
  const preSolBalance = await connection.getBalance(owner)
  const preUsdcBalance = quoteCurrency === 'USDC'
    ? await getTokenBalance(connection, owner, USDC_MINT)
    : 0n
  const preSwapTokenBalances = new Map<string, bigint>()
  for (const mint of tokensToSwap) {
    preSwapTokenBalances.set(mint, await getTokenBalance(connection, owner, mint))
  }
  return { preSolBalance, preUsdcBalance, preSwapTokenBalances }
}

export async function sendTrackedTransaction(
  connection: Connection,
  wallet: Keypair,
  transaction: Transaction,
  onSubmitted: (attempt: SignedRemoveAttempt) => void,
  onConfirmed?: (attempt: SignedRemoveAttempt) => void,
): Promise<string> {
  const startedAt = Date.now()
  const latest = await connection.getLatestBlockhash('confirmed')
  transaction.feePayer = wallet.publicKey
  transaction.recentBlockhash = latest.blockhash
  transaction.sign(wallet)
  const signature = bs58.encode(transaction.signature!)
  const signedTransaction = transaction.serialize()
  const attempt: SignedRemoveAttempt = {
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    signedTransaction: signedTransaction.toString('base64'),
  }
  onSubmitted(attempt)
  const rpcSignature = await connection.sendRawTransaction(signedTransaction, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  })
  if (rpcSignature !== signature) throw new Error('RPC returned a signature that does not match the signed remove transaction')
  const confirmation = await confirmSignature(
    connection,
    { signature, ...latest },
    'confirmed',
    config.removeConfirmTimeoutMs,
  )
  if (confirmation.value.err) {
    throw new ConfirmedTransactionError(`transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
  }
  onConfirmed?.(attempt)
  console.log(`[exit-timing] remove ${signature.slice(0, 8)} confirmed in ${Date.now() - startedAt}ms`)
  return signature
}

export async function executeExit(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenXMint: string,
  tokenYMint: string,
  triggerType: TriggerType,
  pnlPercent: number,
  quoteCurrency: QuoteCurrency,
  basisQuote: number,
  estimatedExitQuote: number,
): Promise<ExitResult> {
  return withWalletExecutionLock(() => executeExitUnlocked(
    connection,
    wallet,
    positionPubkey,
    poolPubkey,
    tokenXMint,
    tokenYMint,
    triggerType,
    pnlPercent,
    quoteCurrency,
    basisQuote,
    estimatedExitQuote,
  ))
}

async function executeExitUnlocked(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenXMint: string,
  tokenYMint: string,
  triggerType: TriggerType,
  pnlPercent: number,
  quoteCurrency: QuoteCurrency,
  basisQuote: number,
  estimatedExitQuote: number,
): Promise<ExitResult> {
  console.log(`[exit] executing ${triggerType} for ${positionPubkey.slice(0, 8)}...`)

  const result: ExitResult = {
    success: false,
    pendingRecovery: false,
    executionId: null,
    removeSucceeded: false,
    solReceived: 0,
    usdcReceived: 0,
    rentRefundSol: 0,
    removeLiqSig: null,
    swapSig: null,
  }
  const owner = wallet.publicKey.toBase58()
  const initializationLease = tryAcquireWalletOperation(owner, 'exit', positionPubkey)
  if (!initializationLease) {
    result.error = 'wallet is busy with another pending operation'
    return result
  }

  const quoteIsUsdc = quoteCurrency === 'USDC'
  const tokensToSwap = [...new Set([tokenXMint, tokenYMint].filter(mint =>
    !SOL_MINTS.has(mint) && !(quoteIsUsdc && mint === USDC_MINT)
  ))]
  let preSolBalance: number
  let preUsdcBalance = 0n
  let preSwapTokenBalances: Map<string, bigint>
  try {
    ({ preSolBalance, preUsdcBalance, preSwapTokenBalances } = await collectExitBaselines(
      connection,
      wallet.publicKey,
      quoteCurrency,
      tokensToSwap,
    ))
  } catch (err) {
    releaseWalletOperation(owner, 'exit', positionPubkey, initializationLease.leaseId!)
    result.error = `exit baseline unavailable: ${err instanceof Error ? err.message : 'RPC error'}`
    return result
  }

  const now = Date.now()
  let state: ExitPendingState | null
  try {
    state = beginExit({
      positionPubkey,
      triggerType,
      triggerPnlPercent: pnlPercent,
      quoteCurrency,
      basisQuote,
      estimatedExitQuote,
      removeLiqSig: null,
      swapSig: null,
      finalQuoteReceived: null,
      status: 'pending_remove',
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }, {
      version: 4,
      revision: 0,
      leaseId: initializationLease.leaseId!,
      positionPubkey,
      poolPubkey,
      owner,
      tokenXMint,
      tokenYMint,
      triggerType,
      pnlPercent,
      quoteCurrency,
      basisQuote,
      estimatedExitQuote,
      preSolBalance,
      preUsdcBalance: preUsdcBalance.toString(),
      preSwapTokenBalances: Object.fromEntries([...preSwapTokenBalances].map(([mint, balance]) => [mint, balance.toString()])),
      rentRefundSol: 0,
      stage: 'pending_remove',
      removeSignatures: [],
      swapSignatures: [],
      currentRemove: null,
      currentSwap: null,
      finalizing: [],
      missingAfterExpiryChecks: 0,
      lastExpiryAbsenceAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    releaseWalletOperation(owner, 'exit', positionPubkey, initializationLease.leaseId!)
    result.error = `exit initialization failed: ${err instanceof Error ? err.message : 'database error'}`
    return result
  }
  if (!state) {
    releaseWalletOperation(owner, 'exit', positionPubkey, initializationLease.leaseId!)
    result.error = 'position is already exiting, closed, or unavailable'
    return result
  }
  result.executionId = state.executionId

  const removeOutcome = await removePositionLiquidity(connection, wallet, state, result)
  if (removeOutcome === 'pending') return result
  if (removeOutcome === 'failed') {
    if (state.removeSignatures.length === 0 && !state.currentRemove) {
      finishExit(state, 'failed', 'monitoring', {
        removeLiqSig: result.removeLiqSig,
        errorMessage: result.error || 'remove liquidity failed',
      })
    }
    return result
  }

  state.stage = 'swap_pending'
  state.lastError = null
  persistExitState(state, 'swap_pending', { removeLiqSig: result.removeLiqSig })
  await new Promise<void>(resolve => { setTimeout(resolve, 1500) })
  return settleExit(connection, wallet, state, result, false)
}

async function removePositionLiquidity(
  connection: Connection,
  wallet: Keypair,
  state: ExitPendingState,
  result: ExitResult,
): Promise<'removed' | 'pending' | 'failed'> {
  try {
    const positionAddress = new PublicKey(state.positionPubkey)
    const account = await connection.getAccountInfo(positionAddress, 'finalized')
    if (!account) {
      if (state.removeSignatures.length === 0) {
        const now = Date.now()
        const canCount = state.lastExpiryAbsenceAt === null
          || now - state.lastExpiryAbsenceAt >= EXPIRED_ABSENCE_MIN_INTERVAL_MS
        if (canCount) {
          state.missingAfterExpiryChecks++
          state.lastExpiryAbsenceAt = now
          state.lastError = 'position account absent; awaiting a second finalized observation'
          persistExitState(state, 'pending_remove', { errorMessage: state.lastError })
        }
        if (state.missingAfterExpiryChecks < EXPIRED_ABSENCE_CHECKS) {
          result.pendingRecovery = true
          result.error = state.lastError || 'position absence is pending reconciliation'
          return 'pending'
        }
      }
      result.removeSucceeded = true
      return 'removed'
    }
    if (state.missingAfterExpiryChecks > 0) {
      state.missingAfterExpiryChecks = 0
      state.lastExpiryAbsenceAt = null
      state.lastError = null
      persistExitState(state, 'pending_remove')
    }
    if (state.rentRefundSol === 0) {
      state.rentRefundSol = account.lamports / 1_000_000_000
      result.rentRefundSol = state.rentRefundSol
      persistExitState(state, 'pending_remove')
    }

    const pool = await getPool(connection, new PublicKey(state.poolPubkey))
    const position = await pool.getPosition(positionAddress)
    const pd = position.positionData
    const removeTxs = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionAddress,
      fromBinId: pd.lowerBinId,
      toBinId: pd.upperBinId,
      bps: new BN(10000) as any,
      shouldClaimAndClose: true,
    })
    if (removeTxs.length === 0) throw new Error('Meteora returned no remove-liquidity transaction')

    for (const tx of removeTxs) {
      const signature = await sendTrackedTransaction(
        connection,
        wallet,
        tx,
        attempt => {
          state.currentRemove = attempt
          state.missingAfterExpiryChecks = 0
          state.lastExpiryAbsenceAt = null
          state.lastError = null
          result.removeLiqSig = attempt.signature
          persistExitState(state, 'pending_remove', { removeLiqSig: attempt.signature })
        },
        attempt => {
          state.finalizing.push({
            kind: 'remove',
            attempt,
            resumeStage: 'pending_remove',
            confirmedAt: Date.now(),
          })
          state.stage = 'finalizing'
          result.removeLiqSig = attempt.signature
          persistExitState(state, 'removed', { removeLiqSig: attempt.signature })
        },
      )
      state.removeSignatures.push(signature)
      state.currentRemove = null
      state.missingAfterExpiryChecks = 0
      state.lastExpiryAbsenceAt = null
      result.removeLiqSig = signature
      persistExitState(state, state.finalizing.length > 0 ? 'removed' : 'pending_remove', { removeLiqSig: signature })
      console.log(`[exit] remove liq tx: ${signature}`)
    }
    result.removeSucceeded = true
    result.rentRefundSol = state.rentRefundSol
    if (state.finalizing.length > 0) {
      result.pendingRecovery = true
      result.error = 'remove liquidity confirmed; waiting for finality reconciliation'
      return 'pending'
    }
    return 'removed'
  } catch (err) {
    const message = `remove liquidity failed: ${err instanceof Error ? err.message : 'unknown'}`
    state.lastError = message
    result.error = message
    result.removeLiqSig = state.currentRemove?.signature || state.removeSignatures.at(-1) || null
    console.log(`[exit] ${message}`)
    if (err instanceof ConfirmedTransactionError) {
      state.currentRemove = null
      persistExitState(state, 'pending_remove', { removeLiqSig: result.removeLiqSig, errorMessage: message })
      return 'failed'
    }
    if (state.currentRemove) {
      result.pendingRecovery = true
      result.error = `${message}; pending final reconciliation`
      persistExitState(state, 'pending_remove', { removeLiqSig: result.removeLiqSig, errorMessage: message })
      return 'pending'
    }
    persistExitState(state, 'pending_remove', { errorMessage: message })
    return 'failed'
  }
}

async function settleExit(
  connection: Connection,
  wallet: Keypair,
  state: ExitPendingState,
  result: ExitResult,
  queueCompletionNotification: boolean,
): Promise<ExitResult> {
  result.removeSucceeded = true
  result.rentRefundSol = state.rentRefundSol
  result.removeLiqSig = state.removeSignatures.at(-1) || state.currentRemove?.signature || null
  result.swapSig = state.swapSignatures.at(-1)
    || state.currentSwap?.signature
    || state.finalizing.find(finalizing => finalizing.kind === 'swap')?.attempt.signature
    || null
  const quoteIsUsdc = state.quoteCurrency === 'USDC'
  const swapTarget = quoteIsUsdc ? USDC_MINT : undefined
  const targetLabel = quoteIsUsdc ? 'USDC' : 'SOL'

  try {
    if (state.finalizing.length > 0) {
      const finalizing = state.finalizing[0]
      result.pendingRecovery = true
      result.error = `${finalizing.kind} ${finalizing.attempt.signature} is pending finality reconciliation`
      return result
    }
    if (state.currentSwap) {
      result.pendingRecovery = true
      result.error = `swap ${state.currentSwap.signature} is pending final reconciliation`
      return result
    }

    for (const [mint, rawBaseline] of Object.entries(state.preSwapTokenBalances)) {
      const baseline = BigInt(rawBaseline)
      for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber++) {
        const balance = await getTokenBalance(connection, wallet.publicKey, mint, 2)
        const receivedBalance = positiveBalanceDelta(baseline, balance)
        if (receivedBalance === 0n) break
        console.log(`[exit] swap ${attemptNumber}/5: ${receivedBalance.toString()} ${mint.slice(0, 8)} → ${targetLabel}`)
        const swapResult = await swapTokensToSol(
          connection,
          wallet,
          mint,
          receivedBalance.toString(),
          swapTarget,
          baseline,
          signed => {
            state.currentSwap = signed
            state.missingAfterExpiryChecks = 0
            state.lastExpiryAbsenceAt = null
            state.lastError = null
            result.swapSig = signed.signature
            persistExitState(state, 'swap_pending', { swapSig: signed.signature })
          },
          (signature, status) => {
            if (state.currentSwap?.signature !== signature) return
            if (status === 'confirmed') {
              const attempt = state.currentSwap
              state.finalizing.push({
                kind: 'swap',
                attempt,
                resumeStage: 'swap_pending',
                confirmedAt: Date.now(),
              })
              state.currentSwap = null
              state.stage = 'finalizing'
              state.lastError = null
              persistExitState(state, 'swap_pending', { swapSig: signature })
              return
            }
            if (status === 'finalized' && !state.swapSignatures.includes(signature)) state.swapSignatures.push(signature)
            state.currentSwap = null
            state.lastError = status === 'failed' ? `swap ${signature} failed on-chain` : null
            persistExitState(state, 'swap_pending', { swapSig: signature, errorMessage: state.lastError })
          },
        )
        if (swapResult && !swapResult.confirmed) {
          result.pendingRecovery = true
          result.error = `swap ${swapResult.signature} is pending final reconciliation`
          return result
        }
        const pendingFinalizing = state.finalizing[0]
        if (pendingFinalizing) {
          result.pendingRecovery = true
          result.error = `swap ${pendingFinalizing.attempt.signature} confirmed; waiting for finality reconciliation`
          return result
        }
        if (!swapResult) await new Promise<void>(resolve => { setTimeout(resolve, 2_000) })
      }

      const finalBalance = await getTokenBalance(connection, wallet.publicKey, mint, 2)
      const remaining = positiveBalanceDelta(baseline, finalBalance)
      if (remaining > 0n) {
        state.lastError = `Unswapped balance: ${remaining.toString()} ${mint.slice(0, 8)}`
        persistExitState(state, 'swap_pending', {
          swapSig: result.swapSig || state.swapSignatures.at(-1) || null,
          errorMessage: state.lastError,
        })
        result.error = state.lastError
        result.pendingRecovery = true
        return result
      }
    }

    const postSolBalance = await connection.getBalance(wallet.publicKey)
    result.solReceived = (postSolBalance - state.preSolBalance) / 1_000_000_000
    if (quoteIsUsdc) {
      const postUsdcBalance = await getTokenBalance(connection, wallet.publicKey, USDC_MINT, 2)
      const baseline = BigInt(state.preUsdcBalance)
      result.usdcReceived = Number(positiveBalanceDelta(baseline, postUsdcBalance)) / 1e6
    }
    const quoteReceived = quoteIsUsdc ? result.usdcReceived : result.solReceived
    result.swapSig = state.swapSignatures.at(-1) || null
    finishExit(state, 'completed', 'closed', {
      removeLiqSig: result.removeLiqSig,
      swapSig: result.swapSig,
      finalSolReceived: result.solReceived,
      finalQuoteReceived: quoteReceived,
      errorMessage: null,
    }, queueCompletionNotification)
    result.success = true
    result.pendingRecovery = false
    console.log(`[exit] completed, received ${quoteIsUsdc ? `${result.usdcReceived.toFixed(2)} USDC` : `${result.solReceived.toFixed(6)} SOL`}`)
  } catch (err) {
    const message = `swap settlement pending: ${err instanceof Error ? err.message : 'unknown'}`
    state.lastError = message
    try { persistExitState(state, 'swap_pending', { errorMessage: message }) } catch { /* Preserve the prior durable state. */ }
    result.error = message
    result.pendingRecovery = true
    console.log(`[exit] ${message}`)
  }
  return result
}

async function reconcileFinalizingAttempt(
  connection: Connection,
  state: ExitPendingState,
  finalizing: FinalizingExitAttempt,
): Promise<'finalized' | 'failed' | 'review' | 'pending'> {
  const deadlineReached = () => Date.now() - finalizing.confirmedAt >= config.exitFinalityReviewTimeoutMs
  if (deadlineReached()) return 'review'

  if (finalizing.kind === 'remove') {
    try {
      const account = await withRpcTimeout(
        connection.getAccountInfo(new PublicKey(state.positionPubkey), 'finalized'),
        RECONCILIATION_PROBE_TIMEOUT_MS,
      )
      if (!account) return 'finalized'
    } catch {
      return deadlineReached() ? 'review' : 'pending'
    }
  }

  let status
  try {
    status = await withRpcTimeout(
      connection.getSignatureStatus(finalizing.attempt.signature, { searchTransactionHistory: true }),
      RECONCILIATION_PROBE_TIMEOUT_MS,
    )
  } catch {
    return deadlineReached() ? 'review' : 'pending'
  }
  if (status.value?.err) return 'failed'
  if (status.value?.confirmationStatus === 'finalized') return 'finalized'
  if (deadlineReached()) return 'review'
  return 'pending'
}

async function withRpcTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC probe timeout (${timeoutMs}ms)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function reconcileSignedAttempt(
  connection: Connection,
  state: ExitPendingState,
  attempt: SignedRemoveAttempt | SignedSwapAttempt,
  kind: 'remove' | 'swap',
): Promise<'succeeded' | 'confirmed' | 'finalized_failed' | 'expired' | 'pending'> {
  if (kind === 'remove') {
    const account = await connection.getAccountInfo(new PublicKey(state.positionPubkey), 'finalized')
    if (!account) return 'succeeded'
  }

  const status = await connection.getSignatureStatus(attempt.signature, { searchTransactionHistory: true })
  if (status.value?.err) return 'finalized_failed'
  if (status.value?.confirmationStatus === 'finalized') {
    return 'succeeded'
  }
  if (status.value?.confirmationStatus === 'confirmed') return 'confirmed'

  const blockHeight = await connection.getBlockHeight('confirmed')
  if (blockHeight > attempt.lastValidBlockHeight) {
    const now = Date.now()
    const canCount = state.lastExpiryAbsenceAt === null
      || now - state.lastExpiryAbsenceAt >= EXPIRED_ABSENCE_MIN_INTERVAL_MS
    if (canCount) {
      state.missingAfterExpiryChecks++
      state.lastExpiryAbsenceAt = now
      state.lastError = `${kind} signature absent after blockhash expiry`
      persistExitState(state, executionStatusForState(state), { errorMessage: state.lastError })
    }
    return state.missingAfterExpiryChecks >= EXPIRED_ABSENCE_CHECKS ? 'expired' : 'pending'
  }

  const signature = await connection.sendRawTransaction(Buffer.from(attempt.signedTransaction, 'base64'), {
    skipPreflight: true,
    maxRetries: 0,
  })
  if (signature !== attempt.signature) throw new Error(`${kind} rebroadcast signature does not match durable state`)
  return 'pending'
}

async function reconcilePendingExitsUnlocked(connection: Connection, wallet: Keypair): Promise<void> {
  const owner = wallet.publicKey.toBase58()
  for (const row of listSyncValues(EXIT_PENDING_PREFIX)) {
    let state: ExitPendingState | null = null
    try {
      state = parseExitPendingState(row.value)
      if (row.key !== exitPendingKey(state.positionPubkey)) throw new Error('durable exit key does not match its position')
      if (state.owner !== owner) {
        console.log(`[exit] pending position ${state.positionPubkey.slice(0, 8)} belongs to a different wallet`)
        continue
      }
      const stored = JSON.parse(row.value) as { version?: number; finalizing?: unknown }
      if (stored.version !== 4 || !Array.isArray(stored.finalizing)) {
        const migrated = getDb().prepare(`
          UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?
        `).run(JSON.stringify(state), Date.now(), row.key, row.value)
        if (migrated.changes !== 1) throw new Error('durable exit state changed during migration')
      }
      ensureExitWalletLease(state)
      getDb().prepare('DELETE FROM sync_state WHERE key = ?').run(`exit_wallet:${state.owner}`)
      const result: ExitResult = {
        success: false,
        pendingRecovery: false,
        executionId: state.executionId,
        removeSucceeded: state.stage !== 'pending_remove',
        solReceived: 0,
        usdcReceived: 0,
        rentRefundSol: state.rentRefundSol,
        removeLiqSig: state.removeSignatures.at(-1) || state.currentRemove?.signature || null,
        swapSig: state.swapSignatures.at(-1)
          || state.currentSwap?.signature
          || state.finalizing.find(finalizing => finalizing.kind === 'swap')?.attempt.signature
          || null,
      }

      if (state.finalizing.length > 0) {
        const finalizingAttempts = [...state.finalizing]
        const outcomes: Array<'finalized' | 'failed' | 'review' | 'pending'> = []
        for (const finalizing of finalizingAttempts) {
          const outcome = await reconcileFinalizingAttempt(connection, state, finalizing)
          if (outcome === 'pending') continue
          outcomes.push(outcome)
        }
        if (outcomes.length !== finalizingAttempts.length) continue

        const review = outcomes.find(outcome => outcome === 'review')
        const failedRemove = finalizingAttempts.find((finalizing, index) =>
          finalizing.kind === 'remove' && outcomes[index] === 'failed'
        )
        const failedSwap = finalizingAttempts.find((finalizing, index) =>
          finalizing.kind === 'swap' && outcomes[index] === 'failed'
        )
        if (review || failedRemove) {
          const unresolved = review
            ? finalizingAttempts.find((finalizing, index) => outcomes[index] === 'review')!
            : failedRemove!
          const message = review
            ? `${unresolved.kind} ${unresolved.attempt.signature} did not reach finalized before the review deadline`
            : `${unresolved.kind} ${unresolved.attempt.signature} failed on-chain after confirmation`
          finishExit(state, 'failed', 'error', {
            removeLiqSig: unresolved.kind === 'remove' ? unresolved.attempt.signature : result.removeLiqSig,
            swapSig: unresolved.kind === 'swap' ? unresolved.attempt.signature : result.swapSig,
            errorMessage: message,
          })
          console.log(`[exit] ${message}; position requires manual review`)
          continue
        }

        state.finalizing = []
        state.stage = state.currentRemove
          ? 'pending_remove'
          : finalizingAttempts.at(-1)!.resumeStage
        state.lastError = failedSwap
          ? `swap ${failedSwap.attempt.signature} failed on-chain after confirmation; retrying attributed balance`
          : null
        for (const finalizing of finalizingAttempts) {
          if (outcomes[finalizingAttempts.indexOf(finalizing)] !== 'finalized') continue
          if (finalizing.kind === 'remove' && !state.removeSignatures.includes(finalizing.attempt.signature)) {
            state.removeSignatures.push(finalizing.attempt.signature)
          }
          if (finalizing.kind === 'swap' && !state.swapSignatures.includes(finalizing.attempt.signature)) {
            state.swapSignatures.push(finalizing.attempt.signature)
          }
          console.log(`[exit-timing] ${finalizing.kind} ${finalizing.attempt.signature.slice(0, 8)} ${outcomes[finalizingAttempts.indexOf(finalizing)]} after ${Date.now() - finalizing.confirmedAt}ms`)
        }
        const finalizingStatus: ExitStatus = finalizingAttempts.some(finalizing => finalizing.kind === 'remove')
          && !finalizingAttempts.some(finalizing => finalizing.kind === 'swap')
          && !failedSwap
          ? 'removed'
          : 'swap_pending'
        persistExitState(state, finalizingStatus, {
          removeLiqSig: finalizingAttempts.find(finalizing => finalizing.kind === 'remove')?.attempt.signature,
          swapSig: finalizingAttempts.find(finalizing => finalizing.kind === 'swap')?.attempt.signature,
          errorMessage: state.lastError,
        })
      }

      if (state.currentRemove) {
        const current = state.currentRemove
        const outcome = await reconcileSignedAttempt(connection, state, current, 'remove')
        if (outcome === 'pending') continue
        if ((outcome === 'succeeded' || outcome === 'confirmed') && !state.removeSignatures.includes(current.signature)) {
          state.removeSignatures.push(current.signature)
        }
        state.currentRemove = null
        state.missingAfterExpiryChecks = 0
        state.lastExpiryAbsenceAt = null
        state.lastError = outcome === 'succeeded' || outcome === 'confirmed'
          ? null
          : `remove ${current.signature} ${outcome === 'expired' ? 'expired without a final status' : 'failed on-chain'}`
        if (outcome === 'confirmed') {
          state.finalizing.push({
            kind: 'remove',
            attempt: current,
            resumeStage: 'pending_remove',
            confirmedAt: Date.now(),
          })
          state.stage = 'finalizing'
          persistExitState(state, 'removed', {
            removeLiqSig: current.signature,
            errorMessage: null,
          })
          continue
        }
        persistExitState(state, 'pending_remove', {
          removeLiqSig: current.signature,
          errorMessage: state.lastError,
        })
        if (outcome === 'finalized_failed' && state.removeSignatures.length === 0) {
          const account = await connection.getAccountInfo(new PublicKey(state.positionPubkey), 'finalized')
          if (account) {
            finishExit(state, 'failed', 'monitoring', {
              removeLiqSig: current.signature,
              errorMessage: state.lastError,
            })
            continue
          }
        }
      }

      if (state.stage === 'pending_remove') {
        const removeOutcome = await removePositionLiquidity(connection, wallet, state, result)
        if (removeOutcome === 'pending') continue
        if (removeOutcome === 'failed') {
          if (state.removeSignatures.length === 0 && !state.currentRemove) {
            finishExit(state, 'failed', 'monitoring', {
              removeLiqSig: result.removeLiqSig,
              errorMessage: result.error || state.lastError,
            })
          }
          continue
        }
        state.stage = 'swap_pending'
        state.lastError = null
        persistExitState(state, 'swap_pending', { removeLiqSig: result.removeLiqSig })
      }

      if (state.currentSwap) {
        const current = state.currentSwap
        const outcome = await reconcileSignedAttempt(connection, state, current, 'swap')
        if (outcome === 'pending') continue
        if (outcome === 'succeeded' && !state.swapSignatures.includes(current.signature)) {
          state.swapSignatures.push(current.signature)
        }
        state.currentSwap = null
        state.missingAfterExpiryChecks = 0
        state.lastExpiryAbsenceAt = null
        if (outcome === 'confirmed') {
          state.finalizing.push({
            kind: 'swap',
            attempt: current,
            resumeStage: 'swap_pending',
            confirmedAt: Date.now(),
          })
          state.stage = 'finalizing'
          state.lastError = null
          persistExitState(state, 'swap_pending', { swapSig: current.signature })
          continue
        }
        state.lastError = outcome === 'succeeded' ? null : `swap ${current.signature} failed or expired; retrying attributed balance`
        persistExitState(state, 'swap_pending', {
          swapSig: current.signature,
          errorMessage: state.lastError,
        })
      }

      await settleExit(connection, wallet, state, result, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      if (state) {
        state.lastError = `exit reconciliation failed: ${message}`
        try { persistExitState(state, executionStatusForState(state), { errorMessage: state.lastError }) } catch { /* Keep prior state. */ }
      }
      console.log(`[exit] reconciliation failed: ${message}`)
    }
  }
}

export async function reconcilePendingExits(connection: Connection, wallet: Keypair): Promise<void> {
  await withWalletExecutionLock(() => reconcilePendingExitsUnlocked(connection, wallet))
}
