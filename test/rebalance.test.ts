import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRebalanceRange, decideRebalanceReopen, isOorAbove, rebalanceTimerStatus } from '../src/meteora/rebalance.js'

const MINUTE = 60_000

test('detects OOR above only when the active bin exceeds the upper bin', () => {
  assert.equal(isOorAbove(10, 5), true)
  assert.equal(isOorAbove(5, 5), false)
  assert.equal(isOorAbove(4, 5), false)
  assert.equal(isOorAbove(undefined, 5), false)
  assert.equal(isOorAbove(10, undefined), false)
})

test('tracks the sustained OOR-above window and resets when cleared', () => {
  const now = 1_000_000
  assert.equal(rebalanceTimerStatus(null, now, 5), 'none')
  assert.equal(rebalanceTimerStatus(now + 1, now, 5), 'none')
  assert.equal(rebalanceTimerStatus(now - 60_000, now, 5), 'waiting')
  assert.equal(rebalanceTimerStatus(now - 4 * MINUTE, now, 5), 'waiting')
  assert.equal(rebalanceTimerStatus(now - 5 * MINUTE, now, 5), 'ready')
  assert.equal(rebalanceTimerStatus(now - 10 * MINUTE, now, 5), 'ready')
})

test('builds the rebalance range anchored at the active bin with the original width', () => {
  assert.deepEqual(buildRebalanceRange(100, 14), { minBinId: 87, maxBinId: 100 })
  assert.deepEqual(buildRebalanceRange(-43, 15), { minBinId: -57, maxBinId: -43 })
  assert.deepEqual(buildRebalanceRange(10, 1), { minBinId: 10, maxBinId: 10 })
  assert.throws(() => buildRebalanceRange(10, 0), /at least 1 bin/)
  assert.throws(() => buildRebalanceRange(10, 100_000), /position limit/)
  assert.throws(() => buildRebalanceRange(10.5, 5), /invalid/)
})

test('defers the reopen while the close is still finalizing and aborts on close failure', () => {
  assert.equal(decideRebalanceReopen('monitoring'), 'defer')
  assert.equal(decideRebalanceReopen('exiting'), 'defer')
  assert.equal(decideRebalanceReopen('discovering'), 'defer')
  assert.equal(decideRebalanceReopen('closed'), 'reopen')
  assert.equal(decideRebalanceReopen('error'), 'abort')
  assert.equal(decideRebalanceReopen(undefined), 'abort')
  assert.equal(decideRebalanceReopen('opening'), 'ignore')
})
