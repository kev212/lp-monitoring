import { config } from '../config.js'
import { deleteSyncValue, getSyncValue, listSyncValues, setSyncValue } from '../db/client.js'
import { getWalletOperation, releaseWalletOperation, tryAcquireWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { sendNotification } from '../telegram.js'
import type { RebalanceDirection } from '../types.js'
import type {
  RaydiumFundingBaseline,
  RaydiumPreparedRebalance,
  RaydiumRebalancePlan,
} from './execute.js'
import { RaydiumSwapRouteWorseError } from './execute.js'
import {
  deleteRaydiumPositionState,
  getRaydiumPositionState,
  listRaydiumPositionStates,
  saveRaydiumPositionState,
  type RaydiumPositionState,
} from './state.js'

export { deleteRaydiumPositionState, getRaydiumPositionState, listRaydiumPositionStates, saveRaydiumPositionState, type RaydiumPositionState }

const INTENT_PREFIX = 'raydium_rebalance:'
const MEASURE_RETRY_MS = 10_000
const CLOSE_MEASURE_GRACE_MS = 300_000
const REBALANCE_NOTIFY_COOLDOWN_MS = 15 * 60_000

export type RaydiumIntentStage = 'close_requested' | 'close_submitted' | 'swap_pending' | 'open_pending' | 'done'

interface StoredBaseline {
  mintA: string
  mintB: string
  mintAProgramId: string
  mintBProgramId: string
  amountA: string
  amountB: string
}

export interface RaydiumRebalanceIntent {
  version: 2
  owner: string
  leaseId: string | null
  oldNftMint: string
  poolId: string
  pairLabel: string
  direction: RebalanceDirection
  stage: RaydiumIntentStage
  baseline: StoredBaseline | null
  amountA: string | null
  amountB: string | null
  plan: RaydiumRebalancePlan | null
  closeSignature: string | null
  swapSignature: string | null
  openSignature: string | null
  closeSubmittedAt: number | null
  attempts: number
  nextRetryAt: number
  lastError: string | null
  lastNotifyKey: string | null
  lastNotifyAt: number | null
  createdAt: number
  updatedAt: number
}

export interface RaydiumRebalanceServices {
  readFundingBaseline: (params: { poolId: string }) => Promise<RaydiumFundingBaseline>
  submitClose: (params: { poolId: string; nftMint: string; baseline: RaydiumFundingBaseline }) => Promise<{
    signature: string
    amountA: bigint
    amountB: bigint
  }>
  measureFunding: (baseline: RaydiumFundingBaseline) => Promise<{ amountA: bigint; amountB: bigint }>
  prepareRebalance: (params: { poolId: string; amountA: bigint; amountB: bigint }) => Promise<RaydiumPreparedRebalance>
  submitSigned: (plan: RaydiumRebalancePlan, signedTransaction: string) => Promise<{ signature: string }>
  positionExists: (nftMint: string) => Promise<boolean>
  notify: (message: string) => void
}

export interface RaydiumRebalanceTrigger {
  owner: string
  nftMint: string
  poolId: string
  pairLabel: string
  direction: RebalanceDirection
}

export function raydiumRetryDelayMs(attempts: number): number {
  return Math.min(300_000, 5_000 * Math.max(1, attempts))
}

function toStoredBaseline(baseline: RaydiumFundingBaseline): StoredBaseline {
  return {
    mintA: baseline.mintA,
    mintB: baseline.mintB,
    mintAProgramId: baseline.mintAProgramId,
    mintBProgramId: baseline.mintBProgramId,
    amountA: baseline.amountA.toString(),
    amountB: baseline.amountB.toString(),
  }
}

function toBigintBaseline(stored: StoredBaseline): RaydiumFundingBaseline {
  return {
    mintA: stored.mintA,
    mintB: stored.mintB,
    mintAProgramId: stored.mintAProgramId,
    mintBProgramId: stored.mintBProgramId,
    amountA: BigInt(stored.amountA),
    amountB: BigInt(stored.amountB),
  }
}

function intentKey(owner: string): string {
  return `${INTENT_PREFIX}${owner}`
}

export function saveRaydiumIntent(intent: RaydiumRebalanceIntent): void {
  setSyncValue(intentKey(intent.owner), JSON.stringify(intent))
}

export function getRaydiumIntent(owner: string): RaydiumRebalanceIntent | null {
  const raw = getSyncValue(intentKey(owner))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RaydiumRebalanceIntent>
    if (
      parsed.version !== 2
      || !parsed.owner
      || !parsed.oldNftMint
      || !parsed.poolId
      || !['up', 'down'].includes(parsed.direction || '')
      || !['close_requested', 'close_submitted', 'swap_pending', 'open_pending', 'done'].includes(parsed.stage || '')
    ) {
      return null
    }
    return {
      version: 2,
      owner: parsed.owner,
      leaseId: parsed.leaseId || null,
      oldNftMint: parsed.oldNftMint,
      poolId: parsed.poolId,
      pairLabel: parsed.pairLabel || parsed.poolId.slice(0, 6),
      direction: parsed.direction as RebalanceDirection,
      stage: parsed.stage as RaydiumIntentStage,
      baseline: parsed.baseline || null,
      amountA: parsed.amountA || null,
      amountB: parsed.amountB || null,
      plan: parsed.plan || null,
      closeSignature: parsed.closeSignature || null,
      swapSignature: parsed.swapSignature || null,
      openSignature: parsed.openSignature || null,
      closeSubmittedAt: Number.isSafeInteger(parsed.closeSubmittedAt) ? parsed.closeSubmittedAt as number : null,
      attempts: Number.isSafeInteger(parsed.attempts) ? parsed.attempts as number : 0,
      nextRetryAt: Number.isSafeInteger(parsed.nextRetryAt) ? parsed.nextRetryAt as number : 0,
      lastError: parsed.lastError || null,
      lastNotifyKey: typeof parsed.lastNotifyKey === 'string' ? parsed.lastNotifyKey : null,
      lastNotifyAt: Number.isSafeInteger(parsed.lastNotifyAt) ? parsed.lastNotifyAt as number : null,
      createdAt: Number.isSafeInteger(parsed.createdAt) ? parsed.createdAt as number : Date.now(),
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt as number : Date.now(),
    }
  } catch {
    return null
  }
}

export function deleteRaydiumIntent(owner: string): void {
  deleteSyncValue(intentKey(owner))
}

export function listRaydiumIntents(): RaydiumRebalanceIntent[] {
  return listSyncValues(INTENT_PREFIX).flatMap(row => {
    const owner = row.key.slice(INTENT_PREFIX.length)
    const intent = getRaydiumIntent(owner)
    return intent ? [intent] : []
  })
}

/**
 * Claims the wallet for one close+swap+open cycle: durable lease, durable
 * intent, then reconcile. Every step is persisted so a restart can resume
 * without a duplicate swap or open.
 */
export async function startRaydiumRebalance(
  trigger: RaydiumRebalanceTrigger,
  services: RaydiumRebalanceServices,
): Promise<boolean> {
  const owner = trigger.owner
  if (getRaydiumIntent(owner) || getWalletOperation(owner)) return false

  const started = await withWalletExecutionLock(async () => {
    if (getRaydiumIntent(owner) || getWalletOperation(owner)) return false
    const lease = tryAcquireWalletOperation(owner, 'raydium', trigger.nftMint)
    if (!lease) return false
    const now = Date.now()
    const intent: RaydiumRebalanceIntent = {
      version: 2,
      owner,
      leaseId: lease.leaseId || null,
      oldNftMint: trigger.nftMint,
      poolId: trigger.poolId,
      pairLabel: trigger.pairLabel,
      direction: trigger.direction,
      stage: 'close_requested',
      baseline: null,
      amountA: null,
      amountB: null,
      plan: null,
      closeSignature: null,
      swapSignature: null,
      openSignature: null,
      closeSubmittedAt: null,
      attempts: 0,
      nextRetryAt: 0,
      lastError: null,
      lastNotifyKey: null,
      lastNotifyAt: null,
      createdAt: now,
      updatedAt: now,
    }
    saveRaydiumIntent(intent)
    deleteRaydiumPositionState(trigger.nftMint)
    return true
  })
  if (!started) return false

  console.log(`[raydium] ${trigger.pairLabel} | rebalance ${trigger.direction.toUpperCase()} started (in-range, double-sided)`)
  services.notify(
    `🔄 <b>Raydium Rebalance ${trigger.direction.toUpperCase()}</b>\n\n` +
    `<b>${trigger.pairLabel}</b>\n` +
    `Close, swap, lalu buka posisi <b>1 tick wide in-range</b> (double-sided).`
  )
  await reconcilePendingRaydiumRebalances(owner, services)
  return true
}

export async function reconcilePendingRaydiumRebalances(
  owner: string,
  services: RaydiumRebalanceServices,
): Promise<void> {
  const intents = listRaydiumIntents().filter(intent => intent.owner === owner)
  if (intents.length === 0) {
    const lease = getWalletOperation(owner)
    if (lease?.kind === 'raydium' && lease.leaseId) {
      releaseWalletOperation(owner, 'raydium', lease.operationId, lease.leaseId)
    }
    return
  }
  await withWalletExecutionLock(async () => {
    for (const intent of intents) {
      if (intent.stage !== 'done' && intent.nextRetryAt > Date.now()) continue
      await reconcileRaydiumIntent(intent, services)
    }
  })
}

function notifyRaydiumIntent(
  intent: RaydiumRebalanceIntent,
  key: string,
  message: string,
  notify: (message: string) => void,
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
  saveRaydiumIntent(intent)
  notify(message)
  return true
}

function clearPlan(intent: RaydiumRebalanceIntent): void {
  intent.plan = null
  intent.swapSignature = null
  intent.openSignature = null
  intent.amountA = null
  intent.amountB = null
  intent.stage = 'close_submitted'
  intent.nextRetryAt = 0
}

async function reconcileRaydiumIntent(
  intent: RaydiumRebalanceIntent,
  services: RaydiumRebalanceServices,
): Promise<void> {
  try {
    if (intent.stage === 'close_requested') {
      if (await services.positionExists(intent.oldNftMint)) {
        if (!intent.baseline) {
          const baseline = await services.readFundingBaseline({ poolId: intent.poolId })
          intent.baseline = toStoredBaseline(baseline)
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          console.log(`[raydium] ${intent.pairLabel} | funding baseline recorded`)
        }
        const closed = await services.submitClose({
          poolId: intent.poolId,
          nftMint: intent.oldNftMint,
          baseline: toBigintBaseline(intent.baseline),
        })
        intent.closeSignature = closed.signature
        intent.closeSubmittedAt = Date.now()
        const measured = closed.amountA > 0n || closed.amountB > 0n
        services.notify(
          `✅ <b>Raydium Close ${intent.direction.toUpperCase()}</b>\n\n` +
          `<b>${intent.pairLabel}</b>\n` +
          `Close: <a href="https://solscan.io/tx/${closed.signature}">${closed.signature.slice(0, 6)}..${closed.signature.slice(-4)}</a>` +
          (measured ? '' : '\nStatus: menunggu saldo hasil close terlihat.')
        )
        if (!measured) {
          intent.stage = 'close_submitted'
          intent.attempts = 0
          intent.lastError = 'menunggu saldo hasil close terlihat'
          intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          return
        }
        intent.amountA = closed.amountA.toString()
        intent.amountB = closed.amountB.toString()
        intent.stage = 'close_submitted'
        intent.attempts = 0
        intent.lastError = null
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | close ${closed.signature.slice(0, 8)} proceeds A=${intent.amountA} B=${intent.amountB}`)
      } else if (intent.baseline) {
        const measured = await services.measureFunding(toBigintBaseline(intent.baseline))
        if (measured.amountA > 0n || measured.amountB > 0n) {
          intent.amountA = measured.amountA.toString()
          intent.amountB = measured.amountB.toString()
          intent.closeSubmittedAt = intent.closeSubmittedAt ?? Date.now()
          intent.stage = 'close_submitted'
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
        } else {
          intent.closeSubmittedAt = intent.closeSubmittedAt ?? Date.now()
          intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
          intent.lastError = 'posisi hilang sebelum close terkirim; menunggu saldo terlihat'
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          notifyRaydiumIntent(intent, `wait-funding:${intent.poolId}`, `⏳ <b>Raydium Menunggu Saldo</b>\n\n<b>${intent.pairLabel}</b>`, services.notify)
          return
        }
      } else {
        abortRaydiumIntent(intent, services, 'posisi lama sudah tertutup tanpa baseline; reopen dilewati')
        return
      }
    }

    if (intent.stage === 'close_submitted') {
      if (intent.amountA === null || intent.amountB === null) {
        if (!intent.baseline) {
          abortRaydiumIntent(intent, services, 'baseline saldo tidak tercatat; reopen dilewati')
          return
        }
        const measured = await services.measureFunding(toBigintBaseline(intent.baseline))
        if (measured.amountA <= 0n && measured.amountB <= 0n) {
          const since = intent.closeSubmittedAt ?? intent.updatedAt
          if (Date.now() - since >= CLOSE_MEASURE_GRACE_MS) {
            abortRaydiumIntent(intent, services, 'dana hasil close ada di wallet; reopen dilewati setelah menunggu pengukuran')
            return
          }
          intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
          intent.lastError = 'menunggu saldo hasil close terlihat'
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          return
        }
        intent.amountA = measured.amountA.toString()
        intent.amountB = measured.amountB.toString()
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
      }
      const prepared = await services.prepareRebalance({
        poolId: intent.poolId,
        amountA: BigInt(intent.amountA),
        amountB: BigInt(intent.amountB),
      })
      intent.plan = prepared.plan
      intent.stage = prepared.plan.mode === 'atomic' ? 'open_pending' : 'swap_pending'
      intent.attempts = 0
      intent.lastError = null
      intent.updatedAt = Date.now()
      saveRaydiumIntent(intent)
      console.log(`[raydium] ${intent.pairLabel} | plan ${prepared.plan.mode} anchor ${prepared.plan.anchor.tickLower}-${prepared.plan.anchor.tickUpper} swap ${prepared.plan.swapAmountIn}`)
      const swapNote = BigInt(prepared.plan.swapAmountIn) > 0n
        ? `Swap via Raydium direct: <b>${prepared.plan.swapInputSide}</b> → sisi lain.\n`
        : 'Tanpa swap (saldo sudah seimbang).\n'
      services.notify(
        `🧭 <b>Raydium Plan</b>\n\n` +
        `<b>${intent.pairLabel}</b>\n` +
        swapNote +
        `Range: <b>${prepared.plan.anchor.tickLower}-${prepared.plan.anchor.tickUpper}</b> (1 tick wide, in-range)\n` +
        `Mode: <b>${prepared.plan.mode === 'atomic' ? 'atomic swap+open' : 'swap + open (fallback)'}</b>`
      )
    }

    if (intent.stage === 'swap_pending') {
      const plan = intent.plan
      if (!plan?.followUp) throw new Error('plan split tidak lengkap')
      if (await services.positionExists(plan.followUp.nftMint)) {
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
      } else if (!intent.swapSignature) {
        const result = await services.submitSigned(plan, plan.signedTransaction)
        intent.swapSignature = result.signature
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | swap submitted ${result.signature.slice(0, 8)}`)
        return
      } else {
        const result = await services.submitSigned(plan, plan.followUp.signedTransaction)
        intent.openSignature = result.signature
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | open submitted ${result.signature.slice(0, 8)} nft ${plan.followUp.nftMint.slice(0, 8)}`)
      }
    }

    if (intent.stage === 'open_pending') {
      const plan = intent.plan
      if (!plan) throw new Error('plan tidak ditemukan')
      if (await services.positionExists(plan.nftMint)) {
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | atomic position verified ${plan.nftMint.slice(0, 8)}`)
      } else {
        const result = await services.submitSigned(plan, plan.signedTransaction)
        intent.openSignature = result.signature
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | atomic tx submitted ${result.signature.slice(0, 8)} nft ${plan.nftMint.slice(0, 8)}`)
      }
    }

    if (intent.stage === 'done') {
      const plan = intent.plan
      saveRaydiumPositionState({
        nftMint: plan?.nftMint || intent.oldNftMint,
        since: null,
        direction: null,
        notified: false,
        cooldownUntil: Date.now() + config.raydiumRebalanceCooldownMs,
        basisUsd: plan?.depositValueUsd ?? null,
        basisSource: plan?.depositValueUsd != null ? 'rebalance' : null,
      })
      deleteRaydiumIntent(intent.owner)
      if (intent.leaseId) {
        releaseWalletOperation(intent.owner, 'raydium', intent.oldNftMint, intent.leaseId)
      }
      console.log(`[raydium] ${intent.pairLabel} | rebalance ${intent.direction.toUpperCase()} complete (${plan?.mode || 'unknown'})`)
      services.notify(
        `🎯 <b>Raydium Rebalance ${intent.direction.toUpperCase()} Selesai</b>\n\n` +
        `<b>${intent.pairLabel}</b>\n` +
        `New position: <code>${plan?.nftMint || '-'}</code>\n` +
        `Range: <b>${plan ? `${plan.anchor.tickLower}-${plan.anchor.tickUpper}` : '-'}</b> (1 tick wide, in-range)\n` +
        `Mode: <b>${plan?.mode === 'atomic' ? 'atomic' : 'split'}</b>\n` +
        `Close: ${intent.closeSignature ? `<a href="https://solscan.io/tx/${intent.closeSignature}">${intent.closeSignature.slice(0, 6)}..${intent.closeSignature.slice(-4)}</a>` : '-'}\n` +
        `Swap: ${intent.swapSignature ? `<a href="https://solscan.io/tx/${intent.swapSignature}">${intent.swapSignature.slice(0, 6)}..${intent.swapSignature.slice(-4)}</a>` : '-'}\n` +
        `Open: ${intent.openSignature ? `<a href="https://solscan.io/tx/${intent.openSignature}">${intent.openSignature.slice(0, 6)}..${intent.openSignature.slice(-4)}</a>` : '-'}`
      )
    }
  } catch (err) {
    if (err instanceof RaydiumSwapRouteWorseError) {
      abortRaydiumIntent(intent, services, err.message)
      return
    }
    const message = err instanceof Error ? err.message : 'unknown error'
    if (/blockhash|expired|not found/i.test(message) && intent.plan) {
      clearPlan(intent)
      console.log(`[raydium] ${intent.pairLabel} | plan expired, rebuilding from current balances`)
    }
    intent.attempts += 1
    intent.lastError = message
    intent.nextRetryAt = Date.now() + raydiumRetryDelayMs(intent.attempts)
    intent.updatedAt = Date.now()
    saveRaydiumIntent(intent)
    const notified = notifyRaydiumIntent(
      intent,
      `retry:${message}`,
      `⚠️ <b>Raydium Rebalance Retry</b>\n\n` +
      `<b>${intent.pairLabel}</b>\n` +
      `Stage: <code>${intent.stage}</code>\n` +
      `Reason: <code>${message}</code>`,
      services.notify,
    )
    if (notified) console.log(`[raydium] ${intent.pairLabel} | retry ${intent.attempts} at ${intent.stage}: ${message}`)
  }
}

function abortRaydiumIntent(
  intent: RaydiumRebalanceIntent,
  services: RaydiumRebalanceServices,
  reason: string,
): void {
  deleteRaydiumPositionState(intent.oldNftMint)
  deleteRaydiumIntent(intent.owner)
  if (intent.leaseId) {
    releaseWalletOperation(intent.owner, 'raydium', intent.oldNftMint, intent.leaseId)
  }
  console.log(`[raydium] ${intent.pairLabel} | rebalance aborted: ${reason}`)
  services.notify(
    `⚠️ <b>Raydium Rebalance Dibatalkan</b>\n\n` +
    `<b>${intent.pairLabel}</b>\n` +
    `Reason: <code>${reason}</code>`
  )
}
