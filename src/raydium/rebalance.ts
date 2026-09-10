import { deleteSyncValue, listSyncValues, setSyncValue, getSyncValue } from '../db/client.js'
import { getWalletOperation, releaseWalletOperation, tryAcquireWalletOperation, withWalletExecutionLock } from '../executionLock.js'
import { sendNotification } from '../telegram.js'
import type { RebalanceDirection } from '../types.js'
import { armedDirectionAfterRebalance, baseSideForDirection, buildOneTickRange, type RaydiumBaseSide } from './policy.js'

const INTENT_PREFIX = 'raydium_rebalance:'
const STATE_PREFIX = 'raydium_position_state:'

export type RaydiumIntentStage = 'close_requested' | 'open_prepared' | 'open_submitted' | 'done'

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
  baseAmountRaw: string | null
  newNftMint: string | null
  closeSignature: string | null
  openSignature: string | null
  attempts: number
  nextRetryAt: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface RaydiumPositionState {
  nftMint: string
  since: number | null
  direction: RebalanceDirection | null
  armedDirection: RebalanceDirection | null
  notified: boolean
  updatedAt: number
}

export interface RaydiumRebalanceServices {
  closePosition: (params: {
    poolId: string
    nftMint: string
    direction: RebalanceDirection
  }) => Promise<{ signature: string; baseSide: RaydiumBaseSide; baseAmountRaw: bigint }>
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
}

export function raydiumRetryDelayMs(attempts: number): number {
  return Math.min(300_000, 5_000 * Math.max(1, attempts))
}

function intentKey(owner: string): string {
  return `${INTENT_PREFIX}${owner}`
}

function stateKey(nftMint: string): string {
  return `${STATE_PREFIX}${nftMint}`
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
      || !['close_requested', 'open_prepared', 'open_submitted', 'done'].includes(parsed.stage || '')
      || !Number.isInteger(parsed.tickLower)
      || !Number.isInteger(parsed.tickUpper)
      || !['MintA', 'MintB'].includes(parsed.baseSide || '')
    ) {
      return null
    }
    return {
      version: 1,
      owner: parsed.owner,
      leaseId: parsed.leaseId || null,
      oldNftMint: parsed.oldNftMint,
      poolId: parsed.poolId,
      pairLabel: parsed.pairLabel || parsed.poolId.slice(0, 6),
      direction: parsed.direction as RebalanceDirection,
      stage: parsed.stage as RaydiumIntentStage,
      tickLower: parsed.tickLower as number,
      tickUpper: parsed.tickUpper as number,
      baseSide: parsed.baseSide as RaydiumBaseSide,
      baseAmountRaw: parsed.baseAmountRaw || null,
      newNftMint: parsed.newNftMint || null,
      closeSignature: parsed.closeSignature || null,
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

export function getRaydiumPositionState(nftMint: string): RaydiumPositionState | null {
  const raw = getSyncValue(stateKey(nftMint))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RaydiumPositionState>
    return {
      nftMint,
      since: Number.isSafeInteger(parsed.since) ? parsed.since as number : null,
      direction: ['up', 'down'].includes(parsed.direction || '') ? parsed.direction as RebalanceDirection : null,
      armedDirection: ['up', 'down'].includes(parsed.armedDirection || '') ? parsed.armedDirection as RebalanceDirection : null,
      notified: parsed.notified === true,
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt as number : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveRaydiumPositionState(state: Omit<RaydiumPositionState, 'updatedAt'>): void {
  setSyncValue(stateKey(state.nftMint), JSON.stringify({ ...state, updatedAt: Date.now() }))
}

export function deleteRaydiumPositionState(nftMint: string): void {
  deleteSyncValue(stateKey(nftMint))
}

export function listRaydiumPositionStates(): RaydiumPositionState[] {
  return listSyncValues(STATE_PREFIX).flatMap(row => getRaydiumPositionState(row.key.slice(STATE_PREFIX.length)) || [])
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
  const range = buildOneTickRange(trigger.currentTick, trigger.tickSpacing, trigger.direction)

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
      baseAmountRaw: null,
      newNftMint: null,
      closeSignature: null,
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

  services.notify(
    `🔄 <b>Raydium Rebalance ${trigger.direction.toUpperCase()}</b>\n\n` +
    `<b>${trigger.pairLabel}</b>\n` +
    `Close + reopen <b>1 tick wide</b> ${trigger.direction === 'up' ? 'di bawah' : 'di atas'} current tick.\n` +
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
      if (!await services.positionExists(intent.oldNftMint)) {
        abortRaydiumIntent(intent, services, 'posisi lama sudah tertutup tanpa receipt; reopen dilewati')
        return
      }
      const closed = await services.closePosition({
        poolId: intent.poolId,
        nftMint: intent.oldNftMint,
        direction: intent.direction,
      })
      intent.baseSide = closed.baseSide
      intent.baseAmountRaw = closed.baseAmountRaw.toString()
      intent.closeSignature = closed.signature
      intent.stage = 'open_prepared'
      intent.attempts = 0
      intent.lastError = null
      intent.updatedAt = Date.now()
      saveRaydiumIntent(intent)
      services.notify(
        `✅ <b>Raydium Close ${intent.direction.toUpperCase()}</b>\n\n` +
        `<b>${intent.pairLabel}</b>\n` +
        `Funding: <b>${intent.baseSide === 'MintA' ? 'MintA' : 'MintB'}</b>\n` +
        `Close: <a href="https://solscan.io/tx/${closed.signature}">${closed.signature.slice(0, 6)}..${closed.signature.slice(-4)}</a>`
      )
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
      } else {
        intent.stage = 'done'
        intent.updatedAt = Date.now()
        saveRaydiumIntent(intent)
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
  services.notify(
    `⚠️ <b>Raydium Rebalance Dibatalkan</b>\n\n` +
    `<b>${intent.pairLabel}</b>\n` +
    `Reason: <code>${reason}</code>`
  )
}
