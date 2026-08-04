import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { Connection, Keypair, SendTransactionError, Transaction } from '@solana/web3.js'
import { getDb } from './db/client.js'

let walletMutationTail: Promise<void> = Promise.resolve()

export type WalletOperationKind = 'open' | 'exit' | 'reshape'

export interface WalletOperationLease {
  kind: WalletOperationKind
  operationId: string
  leaseId?: string
  createdAt?: number
  lastTouchedAt?: number
  mutationCount?: number
  attempt?: DurableTransactionAttempt | null
}

export interface DurableTransactionAttempt {
  signature: string
  blockhash: string
  lastValidBlockHeight: number
  signedTransaction: string
  missingAfterExpiryChecks: number
  lastExpiryAbsenceAt: number | null
}

export class DurableTransactionPendingError extends Error {
  constructor(readonly signature: string, cause: unknown) {
    super(`transaction ${signature} requires reconciliation: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'DurableTransactionPendingError'
  }
}

export class WalletOperationBusyError extends Error {
  constructor(readonly lease: WalletOperationLease) {
    super(`wallet is busy with ${lease.kind} operation ${lease.operationId}`)
    this.name = 'WalletOperationBusyError'
  }
}

export function walletOperationKey(owner: string): string {
  return `wallet_operation:${owner}`
}

export function getWalletOperation(owner: string): WalletOperationLease | null {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(walletOperationKey(owner)) as { value: string } | undefined
  if (!row) return null
  const lease = JSON.parse(row.value) as Partial<WalletOperationLease>
  if (!['open', 'exit', 'reshape'].includes(lease.kind || '') || !lease.operationId) {
    throw new Error('durable wallet operation lease is malformed')
  }
  return lease as WalletOperationLease
}

export function tryAcquireWalletOperation(owner: string, kind: WalletOperationKind, operationId: string): WalletOperationLease | null {
  const lease: WalletOperationLease = {
    kind,
    operationId,
    leaseId: randomUUID(),
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    mutationCount: 0,
    attempt: null,
  }
  const result = getDb().prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(walletOperationKey(owner), JSON.stringify(lease), Date.now())
  return result.changes === 1 ? lease : null
}

export function releaseWalletOperation(owner: string, kind: WalletOperationKind, operationId: string, leaseId: string): boolean {
  const result = getDb().prepare(`
    DELETE FROM sync_state
    WHERE key = ?
      AND json_extract(value, '$.kind') = ?
      AND json_extract(value, '$.operationId') = ?
      AND json_extract(value, '$.leaseId') = ?
  `).run(walletOperationKey(owner), kind, operationId, leaseId)
  return result.changes === 1
}

export function reconcileOrphanExitIntent(owner: string, staleAfterMs = 120_000): 'none' | 'pending' | 'cleared' {
  const lease = getWalletOperation(owner)
  if (!lease || lease.kind !== 'exit') return 'none'
  const db = getDb()
  const matchingState = db.prepare(`
    SELECT 1 FROM sync_state
    WHERE key LIKE 'exit_pending:%'
      AND json_extract(value, '$.owner') = ?
    LIMIT 1
  `).get(owner)
  if (matchingState) return 'pending'
  if (lease.createdAt && Date.now() - lease.createdAt < staleAfterMs) return 'pending'

  if (lease.leaseId) {
    releaseWalletOperation(owner, 'exit', lease.operationId, lease.leaseId)
  } else {
    db.prepare('DELETE FROM sync_state WHERE key = ? AND value = ?')
      .run(walletOperationKey(owner), JSON.stringify(lease))
  }
  return 'cleared'
}

export async function withDurableWalletOperation<T>(
  owner: string,
  kind: WalletOperationKind,
  operationId: string,
  work: () => Promise<T>,
  safeToRelease: (result: T) => boolean,
): Promise<T> {
  const acquiredLease = tryAcquireWalletOperation(owner, kind, operationId)
  if (!acquiredLease) {
    throw new WalletOperationBusyError(getWalletOperation(owner) || { kind: 'reshape', operationId: 'unknown' })
  }
  let releaseIsSafe = false
  try {
    const result = await work()
    releaseIsSafe = safeToRelease(result)
    return result
  } finally {
    const lease = getWalletOperation(owner)
    const sameLease = lease?.kind === kind
      && lease.operationId === operationId
      && lease.leaseId === acquiredLease.leaseId
    if (sameLease && !lease.attempt && (releaseIsSafe || (lease.mutationCount || 0) === 0)) {
      releaseWalletOperation(owner, kind, operationId, acquiredLease.leaseId!)
    }
  }
}

function updateWalletOperationLease(owner: string, expected: WalletOperationLease, next: WalletOperationLease): void {
  const storedNext = { ...next, lastTouchedAt: Date.now() }
  const result = getDb().prepare(`
    UPDATE sync_state SET value = ?, updated_at = ?
    WHERE key = ? AND value = ?
  `).run(JSON.stringify(storedNext), Date.now(), walletOperationKey(owner), JSON.stringify(expected))
  if (result.changes !== 1) throw new Error('durable wallet operation lease changed concurrently')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`confirm timeout (${timeoutMs / 1000}s)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function sendDurableTransaction(
  connection: Connection,
  wallet: Keypair,
  owner: string,
  operationId: string,
  transaction: Transaction,
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed')
  transaction.feePayer = wallet.publicKey
  transaction.recentBlockhash = latest.blockhash
  transaction.sign(wallet)
  const signature = bs58.encode(transaction.signature!)
  const signedTransaction = transaction.serialize()
  const lease = getWalletOperation(owner)
  if (!lease || lease.kind !== 'reshape' || lease.operationId !== operationId || lease.attempt) {
    throw new Error('reshape wallet lease is unavailable or already has a pending transaction')
  }
  const pendingLease: WalletOperationLease = {
    ...lease,
    attempt: {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      signedTransaction: signedTransaction.toString('base64'),
      missingAfterExpiryChecks: 0,
      lastExpiryAbsenceAt: null,
    },
  }
  updateWalletOperationLease(owner, lease, pendingLease)

  try {
    const rpcSignature = await connection.sendRawTransaction(signedTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    })
    if (rpcSignature !== signature) throw new Error('RPC returned a signature that does not match the signed reshape transaction')
    const confirmation = await withTimeout(
      connection.confirmTransaction({ signature, ...latest }, 'finalized'),
      30_000,
    )
    const current = getWalletOperation(owner)
    if (!current || current.kind !== 'reshape' || current.operationId !== operationId || current.attempt?.signature !== signature) {
      throw new Error('durable reshape attempt changed during confirmation')
    }
    if (confirmation.value.err) {
      updateWalletOperationLease(owner, current, { ...current, attempt: null })
      throw new Error(`reshape transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    }
    updateWalletOperationLease(owner, current, {
      ...current,
      mutationCount: (current.mutationCount || 0) + 1,
      attempt: null,
    })
    return signature
  } catch (err) {
    const current = getWalletOperation(owner)
    if (current?.kind === 'reshape' && current.operationId === operationId && current.attempt?.signature === signature) {
      if (err instanceof SendTransactionError) {
        updateWalletOperationLease(owner, current, { ...current, attempt: null })
        throw err
      }
      throw new DurableTransactionPendingError(signature, err)
    }
    throw err
  }
}

function reshapePositionPubkey(operationId: string): string {
  const separator = operationId.indexOf(':')
  return separator >= 0 ? operationId.slice(separator + 1) : operationId
}

function finishReshapeReconciliation(owner: string, lease: WalletOperationLease, requiresReview: boolean): void {
  const positionPubkey = reshapePositionPubkey(lease.operationId)
  const db = getDb()
  db.transaction(() => {
    if (requiresReview) {
      db.prepare(`
        UPDATE positions
        SET status = 'error', precision_curve_busy = 0, flip_mode_busy = 0, updated_at = ?
        WHERE position_pubkey = ?
      `).run(Date.now(), positionPubkey)
    } else {
      db.prepare(`
        UPDATE positions
        SET precision_curve_busy = 0, flip_mode_busy = 0, updated_at = ?
        WHERE position_pubkey = ?
      `).run(Date.now(), positionPubkey)
    }
    if (!lease.leaseId) throw new Error('reshape lease has no fencing token')
    if (!releaseWalletOperation(owner, 'reshape', lease.operationId, lease.leaseId)) {
      throw new Error('reshape lease changed before reconciliation completed')
    }
  })()
}

export async function reconcileDurableReshapeOperation(connection: Connection, owner: string): Promise<'none' | 'pending' | 'cleared' | 'review'> {
  let lease = getWalletOperation(owner)
  if (!lease || lease.kind !== 'reshape') return 'none'
  if (!lease.leaseId) {
    const migrated: WalletOperationLease = {
      ...lease,
      leaseId: randomUUID(),
      createdAt: lease.createdAt || 0,
      lastTouchedAt: lease.lastTouchedAt || 0,
    }
    const updated = getDb().prepare('UPDATE sync_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
      .run(JSON.stringify(migrated), Date.now(), walletOperationKey(owner), JSON.stringify(lease))
    if (updated.changes !== 1) throw new Error('legacy reshape lease changed during migration')
    lease = migrated
  }
  if (!lease.attempt) {
    const lastTouchedAt = lease.lastTouchedAt || lease.createdAt || 0
    if (Date.now() - lastTouchedAt < 10 * 60_000) return 'pending'
    const requiresReview = (lease.mutationCount || 0) > 0
    finishReshapeReconciliation(owner, lease, requiresReview)
    return requiresReview ? 'review' : 'cleared'
  }

  const attempt = lease.attempt
  const status = await connection.getSignatureStatus(attempt.signature, { searchTransactionHistory: true })
  if (status.value?.confirmationStatus === 'finalized') {
    const landed = !status.value.err
    if (landed) lease = { ...lease, mutationCount: (lease.mutationCount || 0) + 1, attempt: null }
    else lease = { ...lease, attempt: null }
    const current = getWalletOperation(owner)
    if (!current || current.kind !== 'reshape' || current.operationId !== lease.operationId || current.attempt?.signature !== attempt.signature) {
      throw new Error('durable reshape attempt changed during reconciliation')
    }
    updateWalletOperationLease(owner, current, lease)
    const requiresReview = landed || (lease.mutationCount || 0) > 0
    finishReshapeReconciliation(owner, lease, requiresReview)
    return requiresReview ? 'review' : 'cleared'
  }
  if (status.value) return 'pending'

  const blockHeight = await connection.getBlockHeight('confirmed')
  if (blockHeight > attempt.lastValidBlockHeight) {
    const now = Date.now()
    const canCount = attempt.lastExpiryAbsenceAt === null || now - attempt.lastExpiryAbsenceAt >= 5_000
    if (canCount) {
      const current = getWalletOperation(owner)
      if (!current || current.kind !== 'reshape' || current.operationId !== lease.operationId || current.attempt?.signature !== attempt.signature) {
        throw new Error('durable reshape attempt changed during expiry reconciliation')
      }
      lease = {
        ...current,
        attempt: {
          ...attempt,
          missingAfterExpiryChecks: attempt.missingAfterExpiryChecks + 1,
          lastExpiryAbsenceAt: now,
        },
      }
      updateWalletOperationLease(owner, current, lease)
    }
    if ((lease.attempt?.missingAfterExpiryChecks || 0) < 2) return 'pending'
    const current = getWalletOperation(owner)
    if (!current || current.kind !== 'reshape' || current.operationId !== lease.operationId || current.attempt?.signature !== attempt.signature) {
      throw new Error('durable reshape attempt changed before expiry completion')
    }
    const cleared = { ...current, attempt: null }
    updateWalletOperationLease(owner, current, cleared)
    const requiresReview = (cleared.mutationCount || 0) > 0
    finishReshapeReconciliation(owner, cleared, requiresReview)
    return requiresReview ? 'review' : 'cleared'
  }

  const signature = await connection.sendRawTransaction(Buffer.from(attempt.signedTransaction, 'base64'), {
    skipPreflight: true,
    maxRetries: 0,
  })
  if (signature !== attempt.signature) throw new Error('reshape rebroadcast signature does not match durable lease')
  return 'pending'
}

export async function withWalletExecutionLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = walletMutationTail
  let release!: () => void
  walletMutationTail = new Promise<void>(resolve => {
    release = resolve
  })

  await previous.catch(() => undefined)
  try {
    return await work()
  } finally {
    release()
  }
}
