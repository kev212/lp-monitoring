import type { Connection, Keypair } from '@solana/web3.js'
import { getSyncValue, setSyncValue } from '../db/client.js'
import type { RebalanceDirection, RebalanceMode } from '../types.js'
import { loadRaydiumPool, rayDiumPairLabel } from './pool.js'
import { raydiumOorDirection } from './policy.js'
import { listRaydiumWalletPositions } from './positions.js'
import { getRaydiumPositionState } from './state.js'

const SNAPSHOT_KEY = 'raydium_dashboard'
const REFRESH_INTERVAL_MS = 30_000

export interface RaydiumDashboardPosition {
  nftMint: string
  poolId: string
  pair: string
  tickLower: number
  tickUpper: number
  tickSpacing: number
  currentTick: number
  direction: RebalanceDirection | null
  since: number | null
  cooldownUntil: number | null
}

export interface RaydiumDashboardSnapshot {
  version: 1
  updatedAt: number
  positions: RaydiumDashboardPosition[]
}

export function readRaydiumDashboardSnapshot(): RaydiumDashboardSnapshot | null {
  const raw = getSyncValue(SNAPSHOT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RaydiumDashboardSnapshot>
    if (parsed.version !== 1 || !Array.isArray(parsed.positions)) return null
    return {
      version: 1,
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt as number : 0,
      positions: parsed.positions.flatMap(position => {
        if (
          !position
          || typeof position.nftMint !== 'string'
          || typeof position.poolId !== 'string'
          || typeof position.pair !== 'string'
          || !Number.isInteger(position.tickLower)
          || !Number.isInteger(position.tickUpper)
          || !Number.isInteger(position.tickSpacing)
          || !Number.isInteger(position.currentTick)
        ) {
          return []
        }
        return [{
          nftMint: position.nftMint,
          poolId: position.poolId,
          pair: position.pair,
          tickLower: position.tickLower as number,
          tickUpper: position.tickUpper as number,
          tickSpacing: position.tickSpacing as number,
          currentTick: position.currentTick as number,
          direction: ['up', 'down'].includes(position.direction || '') ? position.direction as RebalanceDirection : null,
          since: Number.isSafeInteger(position.since) ? position.since as number : null,
          cooldownUntil: Number.isSafeInteger(position.cooldownUntil) ? position.cooldownUntil as number : null,
        }]
      }),
    }
  } catch {
    return null
  }
}

/**
 * Read-only snapshot of the wallet's Raydium CLMM positions for the dashboard.
 * Independent from RAYDIUM_ENABLED so positions stay visible while auto
 * rebalance is off; throttled and never mutates wallet state.
 */
export async function refreshRaydiumDashboardSnapshot(
  connection: Connection,
  wallet: Keypair,
  options: { force?: boolean; now?: number } = {},
): Promise<RaydiumDashboardSnapshot | null> {
  const now = options.now ?? Date.now()
  const cached = readRaydiumDashboardSnapshot()
  if (!options.force && cached && now - cached.updatedAt < REFRESH_INTERVAL_MS) return cached

  try {
    const positions = await listRaydiumWalletPositions(connection, wallet)
    const pools = new Map<string, Awaited<ReturnType<typeof loadRaydiumPool>>>()
    const entries: RaydiumDashboardPosition[] = []
    for (const position of positions) {
      let loaded = pools.get(position.poolId)
      if (!loaded) {
        loaded = await loadRaydiumPool(connection, wallet, position.poolId)
        pools.set(position.poolId, loaded)
      }
      const state = getRaydiumPositionState(position.nftMint)
      entries.push({
        nftMint: position.nftMint,
        poolId: position.poolId,
        pair: rayDiumPairLabel(loaded.state),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        tickSpacing: loaded.state.tickSpacing,
        currentTick: loaded.state.currentTick,
        direction: raydiumOorDirection(loaded.state.currentTick, position.tickLower, position.tickUpper),
        since: state?.since ?? null,
        cooldownUntil: state?.cooldownUntil ?? null,
      })
    }
    const snapshot: RaydiumDashboardSnapshot = { version: 1, updatedAt: now, positions: entries }
    setSyncValue(SNAPSHOT_KEY, JSON.stringify(snapshot))
    return snapshot
  } catch (err) {
    console.log(`[raydium] dashboard refresh failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return cached
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

export function formatRaydiumDashboardLines(
  snapshot: RaydiumDashboardSnapshot | null,
  options: { enabled: boolean; mode: RebalanceMode; windowMinutes: number; now?: number; maxLines?: number },
): string[] {
  const now = options.now ?? Date.now()
  const maxLines = options.maxLines ?? 5
  const lines = [`🟣 RAYDIUM CLMM · auto ${options.enabled ? 'ON' : 'OFF'} · mode ${options.mode} · window ${options.windowMinutes}m · in-range 1 tick`]
  if (!snapshot) {
    lines.push('   Belum ada data posisi Raydium.')
    return lines
  }
  if (snapshot.positions.length === 0) {
    lines.push('   Tidak ada posisi Raydium.')
    return lines
  }
  for (const position of snapshot.positions.slice(0, maxLines)) {
    const status = position.direction ? `OOR ${position.direction.toUpperCase()}` : 'IN RANGE'
    const cooldown = position.cooldownUntil && position.cooldownUntil > now
      ? ` · cooldown ${formatElapsed(position.cooldownUntil - now)}`
      : ''
    const timer = position.since === null ? '' : ` · ${formatElapsed(now - position.since)}`
    lines.push(`   • ${position.pair} · ${status}${timer}${cooldown}`)
    lines.push(`     ticks ${position.tickLower}..${position.tickUpper} · curr ${position.currentTick} · spacing ${position.tickSpacing}`)
  }
  if (snapshot.positions.length > maxLines) {
    lines.push(`   +${snapshot.positions.length - maxLines} posisi lagi`)
  }
  return lines
}
