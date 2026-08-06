import type {
  Connection,
  RpcResponseAndContext,
  SignatureResult,
} from '@solana/web3.js'

export type ConfirmationCommitment = 'confirmed' | 'finalized'

export interface ConfirmationStrategy {
  signature: string
  blockhash: string
  lastValidBlockHeight: number
}

const POLL_GRACE_MS = 2_000
const POLL_INTERVAL_MS = 500

export function commitmentReached(
  status: string | null | undefined,
  target: ConfirmationCommitment,
): boolean {
  if (target === 'confirmed') return status === 'confirmed' || status === 'finalized'
  return status === 'finalized'
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error('confirmation cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('confirmation cancelled'))
    }, { once: true })
  })
}

async function pollSignature(
  connection: Connection,
  strategy: ConfirmationStrategy,
  commitment: ConfirmationCommitment,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RpcResponseAndContext<SignatureResult>> {
  const startedAt = Date.now()
  let lastError: unknown
  await wait(Math.min(POLL_GRACE_MS, timeoutMs), signal)

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await connection.getSignatureStatus(strategy.signature, { searchTransactionHistory: true })
      const status = response.value
      if (status?.err || commitmentReached(status?.confirmationStatus, commitment)) {
        return response as unknown as RpcResponseAndContext<SignatureResult>
      }
    } catch (error) {
      lastError = error
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) break
    await wait(Math.min(POLL_INTERVAL_MS, remainingMs), signal)
  }

  throw lastError instanceof Error ? lastError : new Error(`confirm timeout (${timeoutMs / 1000}s)`)
}

/** Prefer the configured WebSocket subscription, with HTTP status polling as a backup. */
export async function confirmSignature(
  connection: Connection,
  strategy: ConfirmationStrategy,
  commitment: ConfirmationCommitment,
  timeoutMs: number,
): Promise<RpcResponseAndContext<SignatureResult>> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let websocketError: unknown
  let pollingError: unknown
  const websocketPromise = connection.confirmTransaction(
    { ...strategy, abortSignal: controller.signal },
    commitment,
  ).catch(error => {
    websocketError = error
    return new Promise<never>(() => undefined)
  })
  const pollingPromise = pollSignature(connection, strategy, commitment, timeoutMs, controller.signal).catch(error => {
    pollingError = error
    return new Promise<never>(() => undefined)
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const detail = websocketError instanceof Error
        ? websocketError.message
        : pollingError instanceof Error
          ? pollingError.message
          : ''
      const suffix = detail ? `: ${detail}` : ''
      reject(new Error(`confirm timeout (${timeoutMs / 1000}s)${suffix}`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([websocketPromise, pollingPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
}
