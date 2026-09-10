import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRebalanceRange, decideRebalanceOpenAttempt, isOorAbove, isTerminalRebalanceOpenError, rebalanceCloseDisposition, rebalanceTimerStatus, rebalanceOorDirection, nextRebalanceTimer } from '../src/meteora/rebalance.js'

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

test('down keeps the bin count and anchors the lower bin at the current bin', () => {
  assert.deepEqual(buildRebalanceRange(90, 3, 'down'), { minBinId: 90, maxBinId: 92 })
  assert.deepEqual(buildRebalanceRange(-43, 3, 'down'), { minBinId: -43, maxBinId: -41 })
  assert.deepEqual(buildRebalanceRange(90, 1, 'down'), { minBinId: 90, maxBinId: 90 })
  assert.equal(rebalanceOorDirection(89, 90, 92), 'down')
  assert.equal(rebalanceOorDirection(93, 90, 92), 'up')
  for (const active of [90, 91, 92, undefined, NaN]) assert.equal(rebalanceOorDirection(active, 90, 92), null)
  assert.equal(rebalanceOorDirection(90, 92, 89), null)
})

test('requires a continuous window on the selected side, including in Both mode', () => {
  const input = { direction: 'down' as const, mode: 'both' as const, since: 1000, previousDirection: 'down' as const, now: 301000, minutes: 5 }
  assert.equal(nextRebalanceTimer(input).ready, true)
  assert.deepEqual(nextRebalanceTimer({ ...input, previousDirection: 'up' }), { since: 301000, direction: 'down', ready: false })
  assert.deepEqual(nextRebalanceTimer({ ...input, mode: 'up' }), { since: null, direction: null, ready: false })
  assert.deepEqual(nextRebalanceTimer({ ...input, direction: null }), { since: null, direction: null, ready: false })
  assert.equal(nextRebalanceTimer({ ...input, since: 302000 }).ready, false)
  assert.equal(nextRebalanceTimer({ ...input, since: null }).since, input.now)
})

test('defers the reopen while the close is still finalizing and aborts on close failure', () => {
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: false,
    pendingOpen: false,
    oldPositionStatus: 'monitoring',
    newPositionStatus: undefined,
  }), 'defer')
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: false,
    pendingOpen: false,
    oldPositionStatus: 'error',
    newPositionStatus: undefined,
  }), 'abort')
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: false,
    pendingOpen: false,
    oldPositionStatus: undefined,
    newPositionStatus: undefined,
  }), 'abort')
})

test('never reopens once an open attempt produced a position', () => {
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: true,
    pendingOpen: false,
    oldPositionStatus: 'closed',
    newPositionStatus: 'monitoring',
  }), 'complete')
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: true,
    pendingOpen: true,
    oldPositionStatus: 'closed',
    newPositionStatus: 'opening',
  }), 'defer')
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: true,
    pendingOpen: false,
    oldPositionStatus: 'closed',
    newPositionStatus: undefined,
  }), 'abort')
})

test('executes a fresh reopen only when no attempt has been made yet', () => {
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: false,
    pendingOpen: false,
    oldPositionStatus: 'closed',
    newPositionStatus: undefined,
  }), 'execute')
  assert.equal(decideRebalanceOpenAttempt({
    intentHasOpenPosition: false,
    pendingOpen: true,
    oldPositionStatus: 'closed',
    newPositionStatus: undefined,
  }), 'defer')
})

test('classifies a pending close as deferred even when success is false', () => {
  assert.equal(rebalanceCloseDisposition({ success: false, pendingRecovery: true }), 'deferred')
  assert.equal(rebalanceCloseDisposition({ success: true, pendingRecovery: false }), 'ok')
  assert.equal(rebalanceCloseDisposition({ success: false, pendingRecovery: false }), 'failed')
})

test('stops retrying deterministic range-cost failures but retries transient errors', () => {
  assert.equal(isTerminalRebalanceOpenError(new Error('Range requires 2 setup transactions; reduce the percentage range')), true)
  assert.equal(isTerminalRebalanceOpenError(new Error('Range requires 2 positions; reduce the percentage range')), true)
  assert.equal(isTerminalRebalanceOpenError(new Error('Insufficient SOL; keep 0.02 SOL plus estimated position rent for fees')), false)
  assert.equal(isTerminalRebalanceOpenError(new Error('RPC request failed')), false)
})
