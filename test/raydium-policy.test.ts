import assert from 'node:assert/strict'
import test from 'node:test'
import {
  armedDirectionAfterRebalance,
  baseSideForDirection,
  buildOneTickRange,
  nextRaydiumTimer,
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

test('builds a one-tick-wide range one tick away from the current tick', () => {
  assert.deepEqual(buildOneTickRange(1000, 60, 'up'), { tickLower: 840, tickUpper: 900 })
  assert.deepEqual(buildOneTickRange(1000, 60, 'down'), { tickLower: 1020, tickUpper: 1080 })
  assert.deepEqual(buildOneTickRange(1010, 60, 'up'), { tickLower: 840, tickUpper: 900 })
  assert.deepEqual(buildOneTickRange(-43, 10, 'down'), { tickLower: -40, tickUpper: -30 })
  assert.throws(() => buildOneTickRange(10, 0, 'up'), /tick spacing/i)
  assert.throws(() => buildOneTickRange(10.5, 1, 'up'), /current tick/i)
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
