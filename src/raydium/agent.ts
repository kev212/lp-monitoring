import type { Connection, Keypair } from '@solana/web3.js'
import { config } from '../config.js'
import { getWalletOperation } from '../executionLock.js'
import { isBotRunning } from '../lifecycle.js'
import { sendNotification } from '../telegram.js'
import { loadRaydiumPool, rayDiumPairLabel } from './pool.js'
import { listRaydiumWalletPositions } from './positions.js'
import { nextRaydiumTimer, raydiumOorDirection } from './policy.js'
import {
  deleteRaydiumPositionState,
  getRaydiumIntent,
  getRaydiumPositionState,
  listRaydiumPositionStates,
  reconcilePendingRaydiumRebalances,
  saveRaydiumPositionState,
  startRaydiumRebalance,
  type RaydiumPositionState,
} from './rebalance.js'
import { defaultRaydiumServices } from './services.js'
import { isRaydiumRebalanceEnabled } from './state.js'

let lastTickAt = 0

export function resetRaydiumAgentThrottle(): void {
  lastTickAt = 0
}

export async function tickRaydiumAgent(connection: Connection, wallet: Keypair): Promise<void> {
  if (!config.raydiumEnabled) return
  const owner = wallet.publicKey.toBase58()
  const services = defaultRaydiumServices(connection, wallet)

  await reconcilePendingRaydiumRebalances(owner, services)
  if (getRaydiumIntent(owner)) return
  if (Date.now() - lastTickAt < config.raydiumPollMs) return
  lastTickAt = Date.now()
  if (!isBotRunning()) return

  const positions = await listRaydiumWalletPositions(connection, wallet)
  const liveNfts = new Set(positions.map(position => position.nftMint))
  for (const state of listRaydiumPositionStates()) {
    if (!liveNfts.has(state.nftMint)) deleteRaydiumPositionState(state.nftMint)
  }
  if (positions.length === 0) return

  const minutes = config.raydiumRebalanceWindowMinutes
  const pools = new Map<string, Awaited<ReturnType<typeof loadRaydiumPool>>>()
  for (const position of positions) {
    if (getWalletOperation(owner) || getRaydiumIntent(owner)) return

    let loaded = pools.get(position.poolId)
    if (!loaded) {
      try {
        loaded = await loadRaydiumPool(connection, wallet, position.poolId)
      } catch (err) {
        console.log(`[raydium] pool ${position.poolId.slice(0, 6)} read failed: ${err instanceof Error ? err.message : 'unknown'}`)
        continue
      }
      pools.set(position.poolId, loaded)
    }

    const pair = rayDiumPairLabel(loaded.state)
    const direction = raydiumOorDirection(loaded.state.currentTick, position.tickLower, position.tickUpper)
    const existing = getRaydiumPositionState(position.nftMint)
    if (!isRaydiumRebalanceEnabled(position.nftMint)) {
      if (existing && (existing.since !== null || existing.direction !== null || existing.notified)) {
        saveRaydiumPositionState({
          nftMint: position.nftMint,
          since: null,
          direction: null,
          notified: false,
          cooldownUntil: existing.cooldownUntil,
          basisUsd: existing.basisUsd,
          basisSource: existing.basisSource,
        })
      }
      continue
    }
    if (existing?.cooldownUntil && Date.now() < existing.cooldownUntil) continue

    const timer = nextRaydiumTimer({
      direction,
      mode: config.raydiumRebalanceMode,
      since: existing?.since ?? null,
      previousDirection: existing?.direction ?? null,
      now: Date.now(),
      minutes,
    })
    const directionChanged = (existing?.direction ?? null) !== timer.direction
    const nextState: Omit<RaydiumPositionState, 'updatedAt'> = {
      nftMint: position.nftMint,
      since: timer.since,
      direction: timer.direction,
      notified: directionChanged ? false : (existing?.notified ?? false),
      cooldownUntil: existing?.cooldownUntil ?? null,
      basisUsd: existing?.basisUsd ?? null,
      basisSource: existing?.basisSource ?? null,
    }
    if (timer.since !== (existing?.since ?? null) || directionChanged) {
      saveRaydiumPositionState(nextState)
    }
    if (timer.direction && !nextState.notified) {
      saveRaydiumPositionState({ ...nextState, notified: true })
      sendNotification(
        `⏳ <b>Raydium OOR ${timer.direction.toUpperCase()}</b>\n\n` +
        `<b>${pair}</b>\n` +
        `Ticks: <b>${position.tickLower}-${position.tickUpper}</b> | current: <b>${loaded.state.currentTick}</b>\n` +
        `Menunggu window <b>${minutes} menit</b> sebelum rebalance in-range.`
      )
    }

    if (!timer.ready || !direction) continue
    const started = await startRaydiumRebalance({
      owner,
      nftMint: position.nftMint,
      poolId: position.poolId,
      pairLabel: pair,
      direction,
    }, services)
    if (started) return
  }
}
