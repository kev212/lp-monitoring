import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { config } from '../src/config.js'
import { deleteSyncValue, getDb, getSyncValue, setSyncValue } from '../src/db/client.js'
import {
  getRebalanceOorMinutes,
  getRebalanceSettings,
  MAX_REBALANCE_MINUTES,
  MIN_REBALANCE_MINUTES,
  parseRebalanceMinutesInput,
  setRebalanceOorMinutes,
} from '../src/meteora/rebalanceSettings.js'

const SETTINGS_KEY = 'rebalance_settings'

test('accepts only whole minutes inside the supported window', () => {
  assert.equal(MIN_REBALANCE_MINUTES, 1)
  assert.equal(MAX_REBALANCE_MINUTES, 1440)
  assert.equal(parseRebalanceMinutesInput('1'), 1)
  assert.equal(parseRebalanceMinutesInput('1440'), 1440)
  assert.equal(parseRebalanceMinutesInput(' 15 '), 15)
  for (const invalid of ['0', '-1', '+5', '5.5', '1e3', 'abc', '', '1441', '0000']) {
    assert.equal(parseRebalanceMinutesInput(invalid), null)
  }
})

test('falls back to the configured default when the stored window is missing or malformed', () => {
  const previous = getSyncValue(SETTINGS_KEY)
  try {
    deleteSyncValue(SETTINGS_KEY)
    assert.equal(getRebalanceOorMinutes(), config.rebalanceOorMinutes)
    assert.equal(getRebalanceSettings().revision, 0)

    setSyncValue(SETTINGS_KEY, JSON.stringify({ version: 1, minutes: 0, revision: 4 }))
    assert.equal(getRebalanceOorMinutes(), config.rebalanceOorMinutes)

    setSyncValue(SETTINGS_KEY, 'not-json')
    assert.equal(getRebalanceOorMinutes(), config.rebalanceOorMinutes)
  } finally {
    if (previous === null) deleteSyncValue(SETTINGS_KEY)
    else setSyncValue(SETTINGS_KEY, previous)
  }
})

test('persists a changed window, bumps the revision, and resets only waiting timers', () => {
  const db = getDb()
  const previous = getSyncValue(SETTINGS_KEY)
  const owner = `timer-owner-${randomUUID()}`
  const waitingPubkey = `timer-waiting-${randomUUID()}`
  const cleanPubkey = `timer-clean-${randomUUID()}`
  const now = Date.now()
  const insertPosition = db.prepare(`
    INSERT INTO positions (
      position_pubkey, pool_pubkey, token_x_mint, token_y_mint, owner,
      status, rebalance_oor_since, rebalance_oor_direction, last_seen_at, created_at, updated_at
    ) VALUES (?, 'pool-timer-test', 'mint-x', 'mint-y', ?, 'monitoring', ?, ?, ?, ?, ?)
  `)
  insertPosition.run(waitingPubkey, owner, now - 60_000, 'up', now, now, now)
  insertPosition.run(cleanPubkey, owner, null, null, now, now, now)

  try {
    const before = getRebalanceSettings()
    const nextMinutes = before.minutes === 17 ? 18 : 17
    const saved = setRebalanceOorMinutes(nextMinutes)
    assert.deepEqual(saved, { minutes: nextMinutes, revision: before.revision + 1, resetTimers: true })
    assert.equal(getRebalanceOorMinutes(), nextMinutes)

    const waiting = db.prepare('SELECT rebalance_oor_since, rebalance_oor_direction FROM positions WHERE position_pubkey = ?').get(waitingPubkey)
    assert.deepEqual(waiting, { rebalance_oor_since: null, rebalance_oor_direction: null })

    const same = setRebalanceOorMinutes(nextMinutes)
    assert.deepEqual(same, { minutes: nextMinutes, revision: before.revision + 1, resetTimers: false })

    assert.throws(() => setRebalanceOorMinutes(0))
    assert.throws(() => setRebalanceOorMinutes(MAX_REBALANCE_MINUTES + 1))
    assert.throws(() => setRebalanceOorMinutes(5.5))
  } finally {
    if (previous === null) deleteSyncValue(SETTINGS_KEY)
    else setSyncValue(SETTINGS_KEY, previous)
    db.prepare('DELETE FROM positions WHERE position_pubkey IN (?, ?)').run(waitingPubkey, cleanPubkey)
  }
})
