import { deleteSyncValue, listSyncValues, setSyncValue, getSyncValue } from '../db/client.js'
import { getWalletOperation, releaseWalletOperation, tryAcquireWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { sendNotification } from '../telegram.js'
import type { RebalanceDirection } from '../types.js'
import { armedDirectionAfterRebalance, baseSideForDirection, buildRaydiumRebalanceRange, type RaydiumBaseSide } from './policy.js'
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

export type RaydiumIntentStage = 'close_requested' | 'close_submitted' | 'open_prepared' | 'open_submitted' | 'done'

export interface RaydiumRebalanceIntent {
  version: 1
  owner: string
  leaseId: string | null
  oldNftMint: string
  poolId: string
  pairLabel: string
  direction: RebalanceDirection
  stage: RaydiumIntentStage
  tickLower: number
  tickUpper: number
  baseSide: RaydiumBaseSide
  preFundingBalanceRaw: string | null
  fundingMint: string | null
  fundingMintProgramId: string | null
  baseAmountRaw: string | null
  newNftMint: string | null
  closeSignature: string | null
  closeSubmittedAt: number | null
  openSignature: string | null
  attempts: number
  nextRetryAt: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface RaydiumRebalanceServices {
  readFundingBaseline: (params: { poolId: string; direction: RebalanceDirection }) => Promise<{
    baseSide: RaydiumBaseSide
    fundingMint: string
    fundingMintProgramId: string
    fundingAmountRaw: bigint
  }>
  submitClose: (params: {
    poolId: string
    nftMint: string
    direction: RebalanceDirection
    fundingMint: string
    fundingMintProgramId: string
    preFundingAmountRaw: bigint
  }) => Promise<{ signature: string; baseAmountRaw: bigint | null }>
  measureFunding: (params: {
    fundingMint: string
    fundingMintProgramId: string
    preFundingAmountRaw: bigint
  }) => Promise<bigint>
  prepareOpen: (params: {
    poolId: string
    tickLower: number
    tickUpper: number
    baseSide: RaydiumBaseSide
    baseAmountRaw: bigint
  }) => Promise<{ nftMint: string; submit: () => Promise<string> }>
  positionExists: (nftMint: string) => Promise<boolean>
  notify: (message: string) => void
}

export interface RaydiumRebalanceTrigger {
  owner: string
  nftMint: string
  poolId: string
  pairLabel: string
  currentTick: number
  tickSpacing: number
  direction: RebalanceDirection
  gapPercent: number
}

export function raydiumRetryDelayMs(attempts: number): number {
  return Math.min(300_000, 5_000 * Math.max(1, attempts))
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
      parsed.version !== 1
      || !parsed.owner
      || !parsed.oldNftMint
      || !parsed.poolId
      || !['up', 'down'].includes(parsed.direction || '')
      || !['close_requested', 'close_submitted', 'open_prepared', 'open_submitted', 'done'].includes(parsed.stage || '')
      || !Number.isInteger(parsed.tickLower)
      || !Number.isInteger(parsed.tickUpper)
    ) {
      return null
    }
    const direction = parsed.direction as RebalanceDirection
    return {
      version: 1,
      owner: parsed.owner,
      leaseId: parsed.leaseId || null,
      oldNftMint: parsed.oldNftMint,
      poolId: parsed.poolId,
      pairLabel: parsed.pairLabel || parsed.poolId.slice(0, 6),
      direction,
      stage: parsed.stage as RaydiumIntentStage,
      tickLower: parsed.tickLower as number,
      tickUpper: parsed.tickUpper as number,
      baseSide: ['MintA', 'MintB'].includes(parsed.baseSide || '')
        ? parsed.baseSide as RaydiumBaseSide
        : baseSideForDirection(direction),
      preFundingBalanceRaw: parsed.preFundingBalanceRaw || null,
      fundingMint: parsed.fundingMint || null,
      fundingMintProgramId: parsed.fundingMintProgramId || null,
      baseAmountRaw: parsed.baseAmountRaw || null,
      newNftMint: parsed.newNftMint || null,
      closeSignature: parsed.closeSignature || null,
      closeSubmittedAt: Number.isSafeInteger(parsed.closeSubmittedAt) ? parsed.closeSubmittedAt as number : null,
      openSignature: parsed.openSignature || null,
      attempts: Number.isSafeInteger(parsed.attempts) ? parsed.attempts as number : 0,
      nextRetryAt: Number.isSafeInteger(parsed.nextRetryAt) ? parsed.nextRetryAt as number : 0,
      lastError: parsed.lastError || null,
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
 * Claims the wallet for one close+reopen cycle: durable lease, durable intent,
 * then reconcile. The freshly reopened position is armed for the opposite side
 * so the bot does not churn every window while price has not crossed it.
 */
export async function startRaydiumRebalance(
  trigger: RaydiumRebalanceTrigger,
  services: RaydiumRebalanceServices,
): Promise<boolean> {
  const owner = trigger.owner
  if (getRaydiumIntent(owner) || getWalletOperation(owner)) return false
  const range = buildRaydiumRebalanceRange({
    currentTick: trigger.currentTick,
    tickSpacing: trigger.tickSpacing,
    direction: trigger.direction,
    gapPercent: trigger.gapPercent,
  })

  const started = await withWalletExecutionLock(async () => {
    if (getRaydiumIntent(owner) || getWalletOperation(owner)) return false
    const lease = tryAcquireWalletOperation(owner, 'raydium', trigger.nftMint)
    if (!lease) return false
    const now = Date.now()
    const intent: RaydiumRebalanceIntent = {
      version: 1,
      owner,
      leaseId: lease.leaseId || null,
      oldNftMint: trigger.nftMint,
      poolId: trigger.poolId,
      pairLabel: trigger.pairLabel,
      direction: trigger.direction,
      stage: 'close_requested',
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      baseSide: baseSideForDirection(trigger.direction),
      preFundingBalanceRaw: null,
      fundingMint: null,
      fundingMintProgramId: null,
      baseAmountRaw: null,
      newNftMint: null,
      closeSignature: null,
      closeSubmittedAt: null,
      openSignature: null,
      attempts: 0,
      nextRetryAt: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    saveRaydiumIntent(intent)
    deleteRaydiumPositionState(trigger.nftMint)
    return true
  })
  if (!started) return false

  console.log(`[raydium] ${trigger.pairLabel} | rebalance ${trigger.direction.toUpperCase()} started; target ticks ${range.tickLower}-${range.tickUpper}`)
  services.notify(
    `🔄 <b>Raydium Rebalance ${trigger.direction.toUpperCase()}</b>\n\n` +
    `<b>${trigger.pairLabel}</b>\n` +
    `Close + reopen <b>1 tick wide</b> ${trigger.direction === 'up' ? 'di bawah' : 'di atas'} current price, gap <b>${trigger.gapPercent}%</b>.\n` +
    `Target ticks: <b>${range.tickLower}-${range.tickUpper}</b>`
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

async function reconcileRaydiumIntent(
  intent: RaydiumRebalanceIntent,
  services: RaydiumRebalanceServices,
): Promise<void> {
  try {
    if (intent.stage === 'close_requested') {
      if (await services.positionExists(intent.oldNftMint)) {
        if (!intent.preFundingBalanceRaw) {
          const baseline = await services.readFundingBaseline({ poolId: intent.poolId, direction: intent.direction })
          intent.baseSide = baseline.baseSide
          intent.fundingMint = baseline.fundingMint
          intent.fundingMintProgramId = baseline.fundingMintProgramId
          intent.preFundingBalanceRaw = baseline.fundingAmountRaw.toString()
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          console.log(`[raydium] ${intent.pairLabel} | funding baseline recorded (${intent.fundingMint.slice(0, 6)})`)
        }
        const submitted = await services.submitClose({
          poolId: intent.poolId,
          nftMint: intent.oldNftMint,
          direction: intent.direction,
          fundingMint: intent.fundingMint as string,
          fundingMintProgramId: intent.fundingMintProgramId as string,
          preFundingAmountRaw: BigInt(intent.preFundingBalanceRaw),
        })
        intent.closeSignature = submitted.signature
        intent.closeSubmittedAt = Date.now()
        const measured = submitted.baseAmountRaw !== null && submitted.baseAmountRaw > 0n
        services.notify(
          `✅ <b>Raydium Close ${intent.direction.toUpperCase()}</b>\n\n` +
          `<b>${intent.pairLabel}</b>\n` +
          `Funding: <b>${intent.baseSide}</b>\n` +
          `Close: <a href="https://solscan.io/tx/${submitted.signature}">${submitted.signature.slice(0, 6)}..${submitted.signature.slice(-4)}</a>` +
          (measured ? '' : '\nStatus: menunggu saldo hasil close terlihat.')
        )
        if (measured) {
          intent.baseAmountRaw = (submitted.baseAmountRaw as bigint).toString()
          intent.stage = 'open_prepared'
          intent.attempts = 0
          intent.lastError = null
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          console.log(`[raydium] ${intent.pairLabel} | close ${submitted.signature.slice(0, 8)} measured ${intent.baseAmountRaw}`)
        } else {
          intent.stage = 'close_submitted'
          intent.attempts = 0
          intent.lastError = 'menunggu saldo hasil close terlihat'
          intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
          intent.updatedAt = Date.now()
          saveRaydiumIntent(intent)
          console.log(`[raydium] ${intent.pairLabel} | close ${submitted.signature.slice(0, 8)} submitted; funding not visible yet`)
          return
        }
      } else if (intent.preFundingBalanceRaw && intent.fundingMint && intent.fundingMintProgramId) {
        const amount = await services.measureFunding({
          fundingMint: intent.fundingMint,
          fundingMintProgramId: intent.fundingMintProgramId,
          preFundingAmountRaw: BigInt(intent.preFundingBalanceRaw),
        })
        if (amount > 0n) {
          intent.baseAmountRaw = amount.toString()
          intent.stage = 'open_prepared'
          intent.attempts = 0
          intent.lastError = null
        } else {
          intent.stage = 'close_submitted'
          intent.closeSubmittedAt = intent.closeSubmittedAt ?? Date.now()
          intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
          intent.lastError = 'posisi hilang sebelum close terkirim; menunggu saldo terlihat'
        }
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | position gone before submit; measured ${amount.toString()}`)
        if (amount <= 0n) return
      } else {
        abortRaydiumIntent(intent, services, 'posisi lama sudah tertutup tanpa receipt; reopen dilewati')
        return
      }
    }

    if (intent.stage === 'close_submitted') {
      if (!intent.preFundingBalanceRaw || !intent.fundingMint || !intent.fundingMintProgramId) {
        abortRaydiumIntent(intent, services, 'baseline saldo tidak tercatat; reopen dilewati')
        return
      }
      const amount = await services.measureFunding({
        fundingMint: intent.fundingMint,
        fundingMintProgramId: intent.fundingMintProgramId,
        preFundingAmountRaw: BigInt(intent.preFundingBalanceRaw),
      })
      if (amount > 0n) {
        intent.baseAmountRaw = amount.toString()
        intent.stage = 'open_prepared'
        intent.attempts = 0
        intent.lastError = null
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | funding visible after close: ${intent.baseAmountRaw}`)
      } else {
        const since = intent.closeSubmittedAt ?? intent.updatedAt
        if (Date.now() - since >= CLOSE_MEASURE_GRACE_MS) {
          abortRaydiumIntent(intent, services, 'dana hasil close ada di wallet; reopen dilewati setelah menunggu pengukuran')
          return
        }
        intent.attempts += 1
        intent.lastError = 'menunggu saldo hasil close terlihat'
        intent.nextRetryAt = Date.now() + MEASURE_RETRY_MS
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | funding still not visible (attempt ${intent.attempts})`)
        return
      }
    }

    if (intent.stage === 'open_prepared') {
      if (!intent.baseAmountRaw || BigInt(intent.baseAmountRaw) <= 0n) {
        throw new Error('recorded funding amount is missing')
      }
      const prepared = await services.prepareOpen({
        poolId: intent.poolId,
        tickLower: intent.tickLower,
        tickUpper: intent.tickUpper,
        baseSide: intent.baseSide,
        baseAmountRaw: BigInt(intent.baseAmountRaw),
      })
      // Persist the generated NFT mint before submitting. Recovery can then
      // verify this exact position instead of risking a duplicate open.
      intent.newNftMint = prepared.nftMint
      intent.stage = 'open_submitted'
      intent.updatedAt = Date.now()
      saveRaydiumIntent(intent)
      const signature = await prepared.submit()
      intent.openSignature = signature
      intent.stage = 'done'
      intent.lastError = null
      intent.updatedAt = Date.now()
      saveRaydiumIntent(intent)
      console.log(`[raydium] ${intent.pairLabel} | reopen submitted ${signature.slice(0, 8)} nft ${prepared.nftMint.slice(0, 8)}`)
    } else if (intent.stage === 'open_submitted') {
      if (!intent.newNftMint) throw new Error('submitted open is missing its NFT mint')
      if (!await services.positionExists(intent.newNftMint)) {
        if (!intent.baseAmountRaw) throw new Error('recorded funding amount is missing')
        const prepared = await services.prepareOpen({
          poolId: intent.poolId,
          tickLower: intent.tickLower,
          tickUpper: intent.tickUpper,
          baseSide: intent.baseSide,
          baseAmountRaw: BigInt(intent.baseAmountRaw),
        })
        intent.newNftMint = prepared.nftMint
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        const signature = await prepared.submit()
        intent.openSignature = signature
        intent.stage = 'done'
        intent.lastError = null
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | reopen rebuilt ${signature.slice(0, 8)} nft ${prepared.nftMint.slice(0, 8)}`)
      } else {
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
        console.log(`[raydium] ${intent.pairLabel} | reopen verified ${intent.newNftMint.slice(0, 8)}`)
      }
    }

    if (intent.stage === 'done') {
      saveRaydiumPositionState({
        nftMint: intent.newNftMint || intent.oldNftMint,
        since: null,
        direction: null,
        armedDirection: armedDirectionAfterRebalance(intent.direction),
        notified: false,
      })
      deleteRaydiumIntent(intent.owner)
      if (intent.leaseId) {
        releaseWalletOperation(intent.owner, 'raydium', intent.oldNftMint, intent.leaseId)
      }
      console.log(`[raydium] ${intent.pairLabel} | rebalance ${intent.direction.toUpperCase()} complete`)
      services.notify(
        `🎯 <b>Raydium Rebalance ${intent.direction.toUpperCase()} Selesai</b>\n\n` +
        `<b>${intent.pairLabel}</b>\n` +
        `New position: <code>${intent.newNftMint || '-'}</code>\n` +
        `Ticks: <b>${intent.tickLower}-${intent.tickUpper}</b> (1 tick wide)\n` +
        `Close: ${intent.closeSignature ? `<a href="https://solscan.io/tx/${intent.closeSignature}">${intent.closeSignature.slice(0, 6)}..${intent.closeSignature.slice(-4)}</a>` : '-'}\n` +
        `Open: ${intent.openSignature ? `<a href="https://solscan.io/tx/${intent.openSignature}">${intent.openSignature.slice(0, 6)}..${intent.openSignature.slice(-4)}</a>` : '-'}`
      )
    }
  } catch (err) {
    intent.attempts += 1
    intent.lastError = err instanceof Error ? err.message : 'unknown error'
    intent.nextRetryAt = Date.now() + raydiumRetryDelayMs(intent.attempts)
    intent.updatedAt = Date.now()
    saveRaydiumIntent(intent)
    console.log(`[raydium] ${intent.pairLabel} | retry ${intent.attempts} at stage ${intent.stage}: ${intent.lastError}`)
    if (intent.attempts === 1) {
      services.notify(
        `⚠️ <b>Raydium Rebalance Retry</b>\n\n` +
        `<b>${intent.pairLabel}</b>\n` +
        `Stage: <code>${intent.stage}</code>\n` +
        `Reason: <code>${intent.lastError}</code>`
      )
    }
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
