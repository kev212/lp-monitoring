import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../src/config.js'
import { closeDb, getDb } from '../src/db/client.js'
import { initSchema } from '../src/db/schema.js'
import { loadKnownPositions, upsertPosition } from '../src/meteora/discovery.js'
import { isPositionRiskSnapshotCurrent, setPositionRiskDisabled } from '../src/risk/positionSettings.js'
import { defaultRiskSettings } from '../src/risk/settings.js'
import { evaluateTrigger } from '../src/risk/rules.js'
import { parseDashboardAction } from '../src/telegram/control.js'
import type { PositionRow } from '../src/types.js'

const settings = { ...defaultRiskSettings(), slPercent: -20, tpPercent: 30, trailingEnabled: true, trailingStopDropPct: 1, revision: 0, updatedAt: 0 }
const position = { status: 'monitoring', peakPnlPercent: 10, trailingActivated: true, trailingDisabled: false, binRangeDisabled: false, triggerConfirmations: 0 } as PositionRow

test('per-position flags independently suppress exits while preserving TP/SL and global OFF', () => {
  const original = config.binRangeCloseEnabled
  config.binRangeCloseEnabled = true
  try {
    const pnl = Math.max(config.binRangePnlThreshold + 1, 5)
    const bin = { upperBinId: 100, poolActiveBinId: 100 }
    const policy = { ...settings, tpPercent: pnl + 20 }
    assert.equal(evaluateTrigger(position, pnl, bin, policy, false).triggerType, 'BIN_RANGE')
    assert.equal(evaluateTrigger({ ...position, trailingDisabled: true }, pnl, bin, policy, false).triggerType, 'BIN_RANGE')
    assert.equal(evaluateTrigger({ ...position, binRangeDisabled: true }, 5, bin, policy, false).triggerType, 'TRAILING_STOP')
    const off = { ...position, trailingDisabled: true, binRangeDisabled: true }
    assert.equal(evaluateTrigger(off, 5, bin, policy, false).shouldTrigger, false)
    assert.equal(evaluateTrigger(off, 50, bin, settings, false).triggerType, 'TP')
    assert.equal(evaluateTrigger(off, -25, bin, settings, false).triggerType, 'SL')
    assert.equal(evaluateTrigger(position, 5, undefined, { ...settings, trailingEnabled: false }, false).shouldTrigger, false)
    assert.equal(evaluateTrigger({ ...position, trailingDisabled: true }, pnl, bin, policy, false, false).shouldTrigger, false)
    assert.equal(evaluateTrigger({ ...position, trailingDisabled: true, autoRebalanceEnabled: true }, pnl, bin, policy, false).shouldTrigger, false)
  } finally { config.binRangeCloseEnabled = original }
})

test('migrates old databases and persists independent settings across restart and rediscovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'position-risk-'))
  const original = config.dbPath
  config.dbPath = join(directory, 'test.sqlite')
  try {
    const legacy = new Database(config.dbPath)
    initSchema(legacy)
    for (const name of ['trailing_disabled', 'bin_range_disabled', 'position_risk_revision']) legacy.exec(`ALTER TABLE positions DROP COLUMN ${name}`)
    legacy.close()
    getDb()
    const input = { positionPubkey: 'A', poolPubkey: 'pool', tokenXMint: 'X', tokenYMint: 'Y', tokenXSymbol: 'X', tokenYSymbol: 'Y', owner: 'owner', quoteCurrency: 'SOL' as const, basisQuote: 1, basisSolLegacy: 1, basisConfidence: 'high' as const, tpPercent: 30, slPercent: -20, status: 'monitoring' as const, triggerConfirmations: 2, peakPnlPercent: 10, trailingActivated: true, strategy: 'unknown' as const, lastPnlPercent: 5, lastEstimatedExitQuote: 1, lastEstimatedExitSolLegacy: 1, lastSeenAt: 1 }
    upsertPosition(input)
    upsertPosition({ ...input, positionPubkey: 'B' })
    const read = () => loadKnownPositions().find(p => p.positionPubkey === 'A')!
    assert.equal(read().trailingDisabled, false)
    const pendingSnapshot = read()
    setPositionRiskDisabled('A', 'trail', true)
    assert.equal(isPositionRiskSnapshotCurrent(pendingSnapshot, read()), false)
    assert.equal(read().peakPnlPercent, 0)
    assert.equal(read().trailingActivated, false)
    assert.equal(read().triggerConfirmations, 0)
    const revision = read().positionRiskRevision
    setPositionRiskDisabled('A', 'trail', true)
    assert.equal(read().positionRiskRevision, revision)
    setPositionRiskDisabled('A', 'bin', true)
    upsertPosition(input)
    closeDb()
    assert.equal(read().peakPnlPercent, 0)
    assert.equal(read().trailingActivated, false)
    assert.equal(read().trailingDisabled, true)
    assert.equal(read().binRangeDisabled, true)
    assert.equal(loadKnownPositions().find(p => p.positionPubkey === 'B')!.trailingDisabled, false)
    setPositionRiskDisabled('A', 'trail', false)
    assert.equal(read().peakPnlPercent, 0)
    assert.equal(read().trailingActivated, false)
    assert.equal(read().binRangeDisabled, true)
    assert.equal(isPositionRiskSnapshotCurrent(pendingSnapshot, read()), false)
    assert.equal(isPositionRiskSnapshotCurrent(read(), read()), true)
    assert.equal(isPositionRiskSnapshotCurrent(read(), undefined), false)
    for (const status of ['exiting', 'closed', 'error']) {
      getDb().prepare('UPDATE positions SET status = ? WHERE position_pubkey = ?').run(status, 'A')
      assert.throws(() => setPositionRiskDisabled('A', 'bin', false), /tidak tersedia/)
    }
    assert.throws(() => setPositionRiskDisabled('missing', 'bin', true), /tidak tersedia/)
  } finally {
    closeDb()
    config.dbPath = original
    rmSync(directory, { recursive: true, force: true })
  }
})

test('position risk callbacks carry explicit desired states within Telegram limits', () => {
  const key = 'So11111111111111111111111111111111111111112'
  const callback = `lpd:pt:trail:1:${key}`
  assert.ok(Buffer.byteLength(callback) <= 64)
  assert.deepEqual(parseDashboardAction(callback), { type: 'position_risk_set', field: 'trail', disabled: true, positionPubkey: key })
  assert.deepEqual(parseDashboardAction(`lpd:pt:bin:0:${key}`), { type: 'position_risk_set', field: 'bin', disabled: false, positionPubkey: key })
  assert.deepEqual(parseDashboardAction('lpd:pr:2'), { type: 'position_risk', page: 2 })
  assert.deepEqual(parseDashboardAction(`lpd:ps:${key}`), { type: 'position_risk_select', positionPubkey: key })
  assert.equal(parseDashboardAction(`lpd:pt:bin:2:${key}`), null)
  assert.equal(parseDashboardAction('lpd:pr:-1'), null)
  assert.equal(parseDashboardAction('lpd:pt:trail:1:invalid'), null)
})
