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
 * Converts a price distance in percent into pool ticks. Raydium CLMM prices
 * follow price = 1.0001^tick, so the tick delta is independent of token
 * decimals. 0.5% resolves to about 50 ticks.
 */
export function pricePercentToTicks(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) throw new Error('Raydium gap percent is invalid')
  return Math.round(Math.log(1 + percent / 100) / Math.log(1.0001))
}

export function snapTicksToSpacing(ticks: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1) throw new Error('Raydium tick spacing is invalid')
  const steps = Math.max(1, Math.round(ticks / tickSpacing))
  return steps * tickSpacing
}

export interface RaydiumRangeInput {
  currentTick: number
  tickSpacing: number
  direction: RebalanceDirection
  gapPercent: number
}

/**
 * Builds the one-tick-wide replacement range with a price gap from the current
 * tick. The gap is snapped to whole tick-spacing steps with a one-step minimum,
 * so the position always sits strictly outside the current price.
 * Up: the range sits below the current tick and holds 100% MintB.
 * Down: the range sits above the current tick and holds 100% MintA.
 */
export function buildRaydiumRebalanceRange(input: RaydiumRangeInput): RaydiumTickRange {
  if (!Number.isInteger(input.currentTick)) throw new Error('Raydium current tick is invalid')
  if (!Number.isInteger(input.tickSpacing) || input.tickSpacing < 1) throw new Error('Raydium tick spacing is invalid')
  if (input.direction !== 'up' && input.direction !== 'down') throw new Error('Raydium rebalance direction is invalid')
  const aligned = Math.floor(input.currentTick / input.tickSpacing) * input.tickSpacing
  const gap = snapTicksToSpacing(pricePercentToTicks(input.gapPercent), input.tickSpacing)
  if (input.direction === 'up') {
    const tickUpper = aligned - gap
    return { tickUpper, tickLower: tickUpper - input.tickSpacing }
  }
  const tickLower = aligned + gap
  return { tickLower, tickUpper: tickLower + input.tickSpacing }
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
