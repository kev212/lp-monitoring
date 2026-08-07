import assert from 'node:assert/strict'
import test from 'node:test'
import { isDashboardPositionVisible, isTelegramAuthorized, parseDashboardAction } from '../src/telegram/control.js'

test('requires both configured chat and user for Telegram trading controls', () => {
  assert.equal(isTelegramAuthorized('100', '200', '100', '200'), true)
  assert.equal(isTelegramAuthorized('100', '201', '100', '200'), false)
  assert.equal(isTelegramAuthorized('101', '200', '100', '200'), false)
  assert.equal(isTelegramAuthorized('100', undefined, '100', '200'), false)
})

test('parses compact dashboard actions and rejects malformed callbacks', () => {
  assert.deepEqual(parseDashboardAction('lpd:refresh:2'), { type: 'refresh', page: 2 })
  assert.deepEqual(parseDashboardAction('lpd:pick:1:PositionKey'), {
    type: 'close_select',
    page: 1,
    positionPubkey: 'PositionKey',
  })
  assert.deepEqual(parseDashboardAction('lpd:strategy:curve'), { type: 'open_strategy', strategy: 'curve' })
  assert.deepEqual(parseDashboardAction('lpd:oc:abc123'), { type: 'open_confirm', token: 'abc123' })
  assert.deepEqual(parseDashboardAction('lpd:rebal'), { type: 'rebalance' })
  assert.equal(parseDashboardAction('lpd:strategy:invalid'), null)
  assert.equal(parseDashboardAction('lpd:refresh:-1'), null)
  assert.equal(parseDashboardAction('other:refresh:0'), null)
})

test('parses global risk settings callbacks', () => {
  assert.deepEqual(parseDashboardAction('lpd:risk'), { type: 'risk' })
  assert.deepEqual(parseDashboardAction('lpd:rs:sl'), { type: 'risk_field', field: 'sl' })
  assert.deepEqual(parseDashboardAction('lpd:rs:trail_drop'), { type: 'risk_field', field: 'trail_drop' })
  assert.deepEqual(parseDashboardAction('lpd:rt'), { type: 'risk_toggle' })
  assert.deepEqual(parseDashboardAction('lpd:rc:abc123'), { type: 'risk_confirm', token: 'abc123' })
  assert.equal(parseDashboardAction('lpd:rs:invalid'), null)
})

test('hides closed and manual-review positions from the active dashboard list', () => {
  assert.equal(isDashboardPositionVisible('monitoring'), true)
  assert.equal(isDashboardPositionVisible('exiting'), true)
  assert.equal(isDashboardPositionVisible('error'), false)
  assert.equal(isDashboardPositionVisible('closed'), false)
})
