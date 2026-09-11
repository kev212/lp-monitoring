import type { Connection, Keypair } from '@solana/web3.js'
import { getSyncValue, setSyncValue } from '../db/client.js'
import { formatCompactPrice } from '../telegram/binDisplay.js'
import type { RebalanceDirection, RebalanceMode } from '../types.js'
import { loadRaydiumPool, rayDiumPairLabel } from './pool.js'
import { raydiumOorDirection } from './policy.js'
import { listRaydiumWalletPositions } from './positions.js'
import {
  getRaydiumPositionState,
  isRaydiumRebalanceEnabled,
  saveRaydiumPositionState,
  type RaydiumBasisSource,
} from './state.js'
import {
  raydiumPnl,
  raydiumPositionAmounts,
  raydiumPositionValue,
  raydiumPriceAtTick,
  raydiumUsdPerQuote,
} from './valuation.js'

const SNAPSHOT_KEY = 'raydium_dashboard'
const SNAPSHOT_VERSION = 2
const REFRESH_INTERVAL_MS = 30_000
const RANGE_BAR_WIDTH = 10

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
  enabled: boolean
  valueUsd: number | null
  pnlUsd: number | null
  pnlPercent: number | null
  basisUsd: number | null
  basisSource: RaydiumBasisSource | null
  feeValueUsd: number | null
  priceLower: number | null
  priceUpper: number | null
  priceCurrent: number | null
}

export interface RaydiumDashboardSnapshot {
  version: 2
  updatedAt: number
  positions: RaydiumDashboardPosition[]
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readRaydiumDashboardSnapshot(): RaydiumDashboardSnapshot | null {
  const raw = getSyncValue(SNAPSHOT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Omit<RaydiumDashboardSnapshot, 'version'>> & { version?: number }
    if ((parsed.version !== 1 && parsed.version !== SNAPSHOT_VERSION) || !Array.isArray(parsed.positions)) return null
    return {
      version: SNAPSHOT_VERSION,
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
          enabled: position.enabled !== false,
          valueUsd: finiteNumber(position.valueUsd),
          pnlUsd: finiteNumber(position.pnlUsd),
          pnlPercent: finiteNumber(position.pnlPercent),
          basisUsd: finiteNumber(position.basisUsd),
          basisSource: position.basisSource === 'rebalance' || position.basisSource === 'baseline'
            ? position.basisSource
            : null,
          feeValueUsd: finiteNumber(position.feeValueUsd),
          priceLower: finiteNumber(position.priceLower),
          priceUpper: finiteNumber(position.priceUpper),
          priceCurrent: finiteNumber(position.priceCurrent),
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
 * rebalance is off; throttled and never mutates wallet state. The first
 * observed value of a position without a rebalance basis seeds a baseline so
 * every position can show a PnL from the moment the bot started tracking it.
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
    const usdRates = new Map<string, number | null>()
    const entries: RaydiumDashboardPosition[] = []
    for (const position of positions) {
      let loaded = pools.get(position.poolId)
      if (!loaded) {
        loaded = await loadRaydiumPool(connection, wallet, position.poolId)
        pools.set(position.poolId, loaded)
      }
      const { bundle, state: pool } = loaded
      const amounts = raydiumPositionAmounts({
        bundle,
        liquidity: position.liquidity,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      })
      if (!usdRates.has(pool.mintB)) {
        usdRates.set(pool.mintB, await raydiumUsdPerQuote(pool.mintB))
      }
      const priceCurrent = pool.currentPrice > 0 ? pool.currentPrice : null
      const value = raydiumPositionValue({
        amounts,
        feeOwedA: position.feeOwedA,
        feeOwedB: position.feeOwedB,
        mintADecimals: pool.mintADecimals,
        mintBDecimals: pool.mintBDecimals,
        priceAInB: priceCurrent ?? 0,
        usdPerQuote: usdRates.get(pool.mintB) ?? null,
      })

      let positionState = getRaydiumPositionState(position.nftMint)
      if (positionState?.basisUsd == null && value.valueUsd !== null) {
        saveRaydiumPositionState({
          nftMint: position.nftMint,
          since: positionState?.since ?? null,
          direction: positionState?.direction ?? null,
          notified: positionState?.notified ?? false,
          cooldownUntil: positionState?.cooldownUntil ?? null,
          basisUsd: value.valueUsd,
          basisSource: 'baseline',
        })
        positionState = getRaydiumPositionState(position.nftMint)
      }
      const pnl = raydiumPnl(value.valueUsd, positionState?.basisUsd ?? null)

      entries.push({
        nftMint: position.nftMint,
        poolId: position.poolId,
        pair: rayDiumPairLabel(pool),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        tickSpacing: pool.tickSpacing,
        currentTick: pool.currentTick,
        direction: raydiumOorDirection(pool.currentTick, position.tickLower, position.tickUpper),
        since: positionState?.since ?? null,
        cooldownUntil: positionState?.cooldownUntil ?? null,
        enabled: isRaydiumRebalanceEnabled(position.nftMint),
        valueUsd: value.valueUsd,
        pnlUsd: pnl?.pnlUsd ?? null,
        pnlPercent: pnl?.pnlPercent ?? null,
        basisUsd: positionState?.basisUsd ?? null,
        basisSource: positionState?.basisSource ?? null,
        feeValueUsd: value.feeValueUsd,
        priceLower: raydiumPriceAtTick(position.tickLower, pool.mintADecimals, pool.mintBDecimals),
        priceUpper: raydiumPriceAtTick(position.tickUpper, pool.mintADecimals, pool.mintBDecimals),
        priceCurrent,
      })
    }
    const snapshot: RaydiumDashboardSnapshot = { version: SNAPSHOT_VERSION, updatedAt: now, positions: entries }
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

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A'
  if (value > 0 && value < 0.01) return '< $0.01'
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function formatSignedUsd(value: number): string {
  return `${value >= 0 ? '+' : '-'}${formatUsd(Math.abs(value))}`
}

export function buildRaydiumRangeBar(input: {
  tickLower: number
  tickUpper: number
  currentTick: number
  direction: RebalanceDirection | null
}): string {
  const span = input.tickUpper - input.tickLower
  if (!(span > 0)) return `${'━'.repeat(RANGE_BAR_WIDTH)} N/A`
  const clamped = Math.max(input.tickLower, Math.min(input.tickUpper, input.currentTick))
  const progressPct = Math.max(0, Math.min(100, Math.round(((clamped - input.tickLower) / span) * 100)))
  const cursor = Math.min(RANGE_BAR_WIDTH - 1, Math.floor((progressPct * RANGE_BAR_WIDTH) / 100))
  const arrow = input.direction === 'down' ? '⬅ ' : input.direction === 'up' ? '➡ ' : ''
  return `${arrow}${'━'.repeat(cursor)}│${'━'.repeat(RANGE_BAR_WIDTH - cursor - 1)} ${progressPct}%`
}

function formatPrices(position: RaydiumDashboardPosition): string {
  if (position.priceLower === null || position.priceUpper === null || position.priceCurrent === null) return 'harga N/A'
  const symbolB = position.pair.split('/')[1] || ''
  const unit = symbolB === 'USDC' ? '' : ` ${symbolB}`
  return `${formatCompactPrice(position.priceLower)} – ${formatCompactPrice(position.priceUpper)}${unit} · now ${formatCompactPrice(position.priceCurrent)}${unit}`
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
    const rebal = position.enabled ? 'ON' : 'OFF (posisi)'
    lines.push(`   • ${position.pair} · ${status}${timer}${cooldown} · rebal ${rebal}`)
    const pnlLabel = position.pnlUsd === null || position.pnlPercent === null
      ? 'PnL N/A'
      : `PnL ${position.pnlUsd >= 0 ? '📈' : '📉'} ${formatSignedUsd(position.pnlUsd)} (${position.pnlPercent >= 0 ? '+' : ''}${position.pnlPercent.toFixed(2)}%)`
    const basisLabel = position.basisSource === 'baseline'
      ? 'sejak monitoring'
      : position.basisSource === 'rebalance' ? 'bot' : 'N/A'
    lines.push(`     💰 ${formatUsd(position.valueUsd)} · ${pnlLabel} · basis ${formatUsd(position.basisUsd)} (${basisLabel})`)
    lines.push(`     ${buildRaydiumRangeBar(position)} · ${formatPrices(position)} · fees ${formatUsd(position.feeValueUsd)}`)
    lines.push(`     ticks ${position.tickLower}..${position.tickUpper} · curr ${position.currentTick} · spacing ${position.tickSpacing}`)
  }
  if (snapshot.positions.length > maxLines) {
    lines.push(`   +${snapshot.positions.length - maxLines} posisi lagi`)
  }
  return lines
}
