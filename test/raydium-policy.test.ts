import assert from 'node:assert/strict'
import test from 'node:test'
import {
  armedDirectionAfterRebalance,
  baseSideForDirection,
  buildRaydiumRebalanceRange,
  nextRaydiumTimer,
  pricePercentToTicks,
  raydiumDirectionEnabled,
  raydiumOorDirection,
  shouldTriggerRaydium,
  snapTicksToSpacing,
} from '../src/raydium/policy.js'
import { raydiumRetryDelayMs } from '../src/raydium/rebalance.js'

test('treats a Raydium CLMM range as half-open on both edges', () => {
  assert.equal(raydiumOorDirection(105, 100, 105), 'up')
  assert.equal(raydiumOorDirection(104, 100, 105), null)
  assert.equal(raydiumOorDirection(100, 100, 105), null)
  assert.equal(raydiumOorDirection(99, 100, 105), 'down')
  assert.equal(raydiumOorDirection(null, 100, 105), null)
  assert.equal(raydiumOorDirection(105, 105, 105), null)
  assert.equal(raydiumOorDirection(105, 106, 105), null)
})

test('converts a price gap into pool ticks', () => {
  assert.equal(pricePercentToTicks(0.5), 50)
  assert.equal(pricePercentToTicks(1), 100)
  assert.equal(pricePercentToTicks(0.1), 10)
  assert.throws(() => pricePercentToTicks(0), /gap percent/i)
  assert.throws(() => pricePercentToTicks(-1), /gap percent/i)
  assert.throws(() => pricePercentToTicks(Number.NaN), /gap percent/i)
})

test('snaps the gap to whole tick-spacing steps with a one-step minimum', () => {
  assert.equal(snapTicksToSpacing(50, 60), 60)
  assert.equal(snapTicksToSpacing(50, 120), 120)
  assert.equal(snapTicksToSpacing(50, 10), 50)
  assert.equal(snapTicksToSpacing(50, 1), 50)
  assert.equal(snapTicksToSpacing(130, 60), 120)
  assert.throws(() => snapTicksToSpacing(50, 0), /tick spacing/i)
})

test('builds a one-tick-wide range a snapped gap away from the current tick', () => {
  // tickSpacing 60: 0.5% (50 ticks) snaps to one step (60 ticks)
  assert.deepEqual(
    buildRaydiumRebalanceRange({ currentTick: 1000, tickSpacing: 60, direction: 'up', gapPercent: 0.5 }),
    { tickLower: 840, tickUpper: 900 },
  )
  assert.deepEqual(
    buildRaydiumRebalanceRange({ currentTick: 1000, tickSpacing: 60, direction: 'down', gapPercent: 0.5 }),
    { tickLower: 1020, tickUpper: 1080 },
  )
  // tickSpacing 1: 0.5% resolves to exactly 50 ticks
  assert.deepEqual(
    buildRaydiumRebalanceRange({ currentTick: 1000, tickSpacing: 1, direction: 'up', gapPercent: 0.5 }),
    { tickLower: 949, tickUpper: 950 },
  )
  assert.deepEqual(
    buildRaydiumRebalanceRange({ currentTick: 1000, tickSpacing: 1, direction: 'down', gapPercent: 0.5 }),
    { tickLower: 1050, tickUpper: 1051 },
  )
  // an unaligned current tick floors to the pool spacing first
  assert.deepEqual(
    buildRaydiumRebalanceRange({ currentTick: 1010, tickSpacing: 60, direction: 'up', gapPercent: 0.5 }),
    { tickLower: 840, tickUpper: 900 },
  )
  assert.throws(
    () => buildRaydiumRebalanceRange({ currentTick: 10.5, tickSpacing: 1, direction: 'up', gapPercent: 0.5 }),
    /current tick/i,
  )
})

test('maps direction to funding side and opposite armed side', () => {
  assert.equal(baseSideForDirection('up'), 'MintB')
  assert.equal(baseSideForDirection('down'), 'MintA')
  assert.equal(armedDirectionAfterRebalance('up'), 'down')
  assert.equal(armedDirectionAfterRebalance('down'), 'up')
})

test('honours the global mode and the armed side after a rebalance', () => {
  assert.equal(raydiumDirectionEnabled('both', 'up'), true)
  assert.equal(raydiumDirectionEnabled('up', 'down'), false)
  assert.equal(shouldTriggerRaydium({ direction: 'up', armedDirection: null, mode: 'both' }), true)
  assert.equal(shouldTriggerRaydium({ direction: 'up', armedDirection: 'up', mode: 'both' }), true)
  assert.equal(shouldTriggerRaydium({ direction: 'up', armedDirection: 'down', mode: 'both' }), false)
  assert.equal(shouldTriggerRaydium({ direction: 'down', armedDirection: null, mode: 'up' }), false)
  assert.equal(shouldTriggerRaydium({ direction: null, armedDirection: null, mode: 'both' }), false)
})

test('tracks the sustained OOR window and resets on direction changes', () => {
  const now = 1_000_000
  const base = { mode: 'both' as const, armedDirection: null, minutes: 5 }
  assert.deepEqual(nextRaydiumTimer({ ...base, direction: 'up', since: null, previousDirection: null, now }), {
    since: now,
    direction: 'up',
    ready: false,
  })
  assert.equal(nextRaydiumTimer({ ...base, direction: 'up', since: now, previousDirection: 'up', now: now + 4 * 60_000 }).ready, false)
  assert.equal(nextRaydiumTimer({ ...base, direction: 'up', since: now, previousDirection: 'up', now: now + 5 * 60_000 }).ready, true)
  assert.deepEqual(nextRaydiumTimer({ ...base, direction: 'down', since: now, previousDirection: 'up', now: now + 6 * 60_000 }), {
    since: now + 6 * 60_000,
    direction: 'down',
    ready: false,
  })
  assert.deepEqual(nextRaydiumTimer({ ...base, direction: 'up', armedDirection: 'down', since: now, previousDirection: 'up', now: now + 10 * 60_000 }), {
    since: null,
    direction: null,
    ready: false,
  })
  assert.equal(nextRaydiumTimer({ ...base, direction: 'up', since: now + 10, previousDirection: 'up', now }).since, now)
  assert.equal(nextRaydiumTimer({ ...base, direction: 'up', since: now, previousDirection: 'up', now: now - 1 }).since, now - 1)
})

test('bounds the rebalance retry backoff', () => {
  assert.equal(raydiumRetryDelayMs(1), 5_000)
  assert.equal(raydiumRetryDelayMs(2), 10_000)
  assert.equal(raydiumRetryDelayMs(200), 300_000)
})
