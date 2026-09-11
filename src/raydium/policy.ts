import type { RebalanceDirection, RebalanceMode } from '../types.js'

export interface RaydiumTickRange {
  tickLower: number
  tickUpper: number
}

export type RaydiumSide = 'MintA' | 'MintB'

/**
 * Raydium CLMM positions are half-open [tickLower, tickUpper): a position is
 * earning fees while tickLower <= currentTick < tickUpper, is 100% MintB once
 * currentTick >= tickUpper, and 100% MintA once currentTick < tickLower.
 * This is intentionally different from Meteora bin ranges, which are inclusive.
 */
export function raydiumOorDirection(
  currentTick: number | null | undefined,
  tickLower: number,
  tickUpper: number,
): RebalanceDirection | null {
  if (!Number.isInteger(currentTick) || !Number.isInteger(tickLower) || !Number.isInteger(tickUpper)) return null
  if (tickLower >= tickUpper) return null
  if ((currentTick as number) >= tickUpper) return 'up'
  if ((currentTick as number) < tickLower) return 'down'
  return null
}

export function raydiumDirectionEnabled(mode: RebalanceMode, direction: RebalanceDirection | null): direction is RebalanceDirection {
  return direction !== null && (mode === 'both' || mode === direction)
}

/**
 * Converts a price distance in percent into pool ticks. Raydium CLMM prices
 * follow price = 1.0001^tick, so the tick delta is independent of token
 * decimals. 0.5% resolves to about 50 ticks.
 */
export function pricePercentToTicks(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) throw new Error('Raydium percent must be greater than zero')
  return Math.round(Math.log(1 + percent / 100) / Math.log(1.0001))
}

/**
 * Builds the one-tick-wide replacement range that always contains the current
 * tick, so the position opens in range and holds both sides from the start.
 */
export function buildRaydiumInRangeRange(currentTick: number, tickSpacing: number): RaydiumTickRange {
  if (!Number.isInteger(currentTick)) throw new Error('Raydium current tick is invalid')
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) throw new Error('Raydium tick spacing is invalid')
  const aligned = Math.floor(currentTick / tickSpacing) * tickSpacing
  return { tickLower: aligned, tickUpper: aligned + tickSpacing }
}

export function shouldTriggerRaydium(input: {
  direction: RebalanceDirection | null
  mode: RebalanceMode
}): boolean {
  return raydiumDirectionEnabled(input.mode, input.direction)
}

export interface RaydiumTimerState {
  since: number | null
  direction: RebalanceDirection | null
  ready: boolean
}

/**
 * Sustained-window timer for a single Raydium position. Resets whenever the
 * direction changes or the stored timestamp is missing/invalid.
 */
export function nextRaydiumTimer(input: {
  direction: RebalanceDirection | null
  mode: RebalanceMode
  since: number | null
  previousDirection: RebalanceDirection | null
  now: number
  minutes: number
}): RaydiumTimerState {
  if (!shouldTriggerRaydium({ direction: input.direction, mode: input.mode })) {
    return { since: null, direction: null, ready: false }
  }
  const elapsedValid = input.since !== null && Number.isFinite(input.since) && input.now - input.since >= 0
  if (input.previousDirection !== input.direction || !elapsedValid) {
    return { since: input.now, direction: input.direction, ready: false }
  }
  return {
    since: input.since,
    direction: input.direction,
    ready: input.now - (input.since as number) >= input.minutes * 60_000,
  }
}
