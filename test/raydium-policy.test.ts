import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRaydiumInRangeRange,
  nextRaydiumTimer,
  pricePercentToTicks,
  raydiumDirectionEnabled,
  raydiumOorDirection,
  shouldTriggerRaydium,
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

test('converts a price distance into pool ticks', () => {
  assert.equal(pricePercentToTicks(0.5), 50)
  assert.equal(pricePercentToTicks(1), 100)
  assert.equal(pricePercentToTicks(0.1), 10)
  assert.throws(() => pricePercentToTicks(0), /greater than zero/i)
  assert.throws(() => pricePercentToTicks(-1), /greater than zero/i)
  assert.throws(() => pricePercentToTicks(Number.NaN), /greater than zero/i)
})

test('builds a one-tick-wide range that always contains the current tick', () => {
  assert.deepEqual(buildRaydiumInRangeRange(1000, 60), { tickLower: 960, tickUpper: 1020 })
  assert.deepEqual(buildRaydiumInRangeRange(1010, 60), { tickLower: 960, tickUpper: 1020 })
  assert.deepEqual(buildRaydiumInRangeRange(-70796, 60), { tickLower: -70800, tickUpper: -70740 })
  assert.deepEqual(buildRaydiumInRangeRange(5, 1), { tickLower: 5, tickUpper: 6 })
  assert.throws(() => buildRaydiumInRangeRange(10.5, 60), /current tick/i)
  assert.throws(() => buildRaydiumInRangeRange(10, 0), /tick spacing/i)
})

test('honours the global mode for the OOR trigger', () => {
  assert.equal(raydiumDirectionEnabled('both', 'up'), true)
  assert.equal(raydiumDirectionEnabled('up', 'down'), false)
  assert.equal(shouldTriggerRaydium({ direction: 'up', mode: 'both' }), true)
  assert.equal(shouldTriggerRaydium({ direction: 'down', mode: 'up' }), false)
  assert.equal(shouldTriggerRaydium({ direction: null, mode: 'both' }), false)
})

test('tracks the sustained OOR window and resets on direction changes', () => {
  const now = 1_000_000
  const base = { mode: 'both' as const, minutes: 5 }
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
  assert.deepEqual(nextRaydiumTimer({ ...base, direction: 'down', since: now, previousDirection: 'up', now: now + 6 * 60_000, mode: 'up' }), {
    since: null,
    direction: null,
    ready: false,
  })
  assert.equal(nextRaydiumTimer({ ...base, direction: 'up', since: now + 10, previousDirection: 'up', now }).since, now)
})

test('bounds the rebalance retry backoff', () => {
  assert.equal(raydiumRetryDelayMs(1), 5_000)
  assert.equal(raydiumRetryDelayMs(2), 10_000)
  assert.equal(raydiumRetryDelayMs(200), 300_000)
})
