import type { RebalanceDirection, RebalanceMode } from '../types.js'

export interface RaydiumTickRange {
  tickLower: number
  tickUpper: number
}

export type RaydiumBaseSide = 'MintA' | 'MintB'

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
 * Builds the one-tick-wide replacement range.
 * Up: the range sits one tick below the current tick and holds 100% MintB.
 * Down: the range sits one tick above the current tick and holds 100% MintA.
 */
export function buildOneTickRange(
  currentTick: number,
  tickSpacing: number,
  direction: RebalanceDirection,
): RaydiumTickRange {
  if (!Number.isInteger(currentTick)) throw new Error('Raydium current tick is invalid')
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) throw new Error('Raydium tick spacing is invalid')
  if (direction !== 'up' && direction !== 'down') throw new Error('Raydium rebalance direction is invalid')
  const aligned = Math.floor(currentTick / tickSpacing) * tickSpacing
  if (direction === 'up') {
    return { tickUpper: aligned - tickSpacing, tickLower: aligned - 2 * tickSpacing }
  }
  return { tickLower: aligned + tickSpacing, tickUpper: aligned + 2 * tickSpacing }
}

export function baseSideForDirection(direction: RebalanceDirection): RaydiumBaseSide {
  return direction === 'up' ? 'MintB' : 'MintA'
}

/**
 * A freshly rebalanced one-tick position is placed just outside the current
 * price, so it is immediately "out of range" on the side that just triggered.
 * The next trigger must therefore come from the opposite side after price
 * crossed the new range; otherwise the bot would churn every window.
 */
export function armedDirectionAfterRebalance(trigger: RebalanceDirection): RebalanceDirection {
  return trigger === 'up' ? 'down' : 'up'
}

export interface RaydiumTriggerInput {
  direction: RebalanceDirection | null
  armedDirection: RebalanceDirection | null
  mode: RebalanceMode
}

export function shouldTriggerRaydium(input: RaydiumTriggerInput): boolean {
  if (!raydiumDirectionEnabled(input.mode, input.direction)) return false
  if (input.armedDirection && input.direction !== input.armedDirection) return false
  return true
}

export interface RaydiumTimerState {
  since: number | null
  direction: RebalanceDirection | null
  ready: boolean
}

/**
 * Sustained-window timer for a single Raydium position. Uses the same global
 * window as Meteora auto rebalance. Resets whenever the direction changes or
 * the stored timestamp is missing/invalid.
 */
export function nextRaydiumTimer(input: {
  direction: RebalanceDirection | null
  mode: RebalanceMode
  armedDirection: RebalanceDirection | null
  since: number | null
  previousDirection: RebalanceDirection | null
  now: number
  minutes: number
}): RaydiumTimerState {
  if (!shouldTriggerRaydium({ direction: input.direction, armedDirection: input.armedDirection, mode: input.mode })) {
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
