import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { config } from '../src/config.js'
import { closeDb, getDb } from '../src/db/client.js'
import { initSchema } from '../src/db/schema.js'
import {
  loadKnownPositions,
  updateAutoRebalanceEnabled,
  updateFlipModeEnabled,
  updatePrecisionCurveEnabled,
  updateRebalanceOorSince,
  upsertPosition,
} from '../src/meteora/discovery.js'

const basePosition = {
  positionPubkey: 'settings-position',
  poolPubkey: 'pool',
  tokenXMint: 'X',
  tokenYMint: 'Y',
  tokenXSymbol: 'X',
  tokenYSymbol: 'Y',
  owner: 'owner',
  quoteCurrency: 'SOL' as const,
  basisQuote: 1,
  basisSolLegacy: 1,
  basisConfidence: 'high' as const,
  tpPercent: 5,
  slPercent: -15,
  status: 'monitoring' as const,
  triggerConfirmations: 0,
  peakPnlPercent: 4,
  trailingActivated: true,
  lastPnlPercent: null,
  lastEstimatedExitQuote: null,
  lastEstimatedExitSolLegacy: null,
  lastSeenAt: 1,
  strategy: 'unknown' as const,
}

function withDb(callback: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'rebalance-settings-'))
  const originalPath = config.dbPath
  config.dbPath = join(directory, 'test.sqlite')
  try {
    callback()
  } finally {
    closeDb()
    config.dbPath = originalPath
    rmSync(directory, { recursive: true, force: true })
  }
}

test('migrates rebalance mode and OOR direction columns with safe defaults', () => {
  withDb(() => {
    const legacy = new Database(config.dbPath)
    initSchema(legacy)
    legacy.exec('ALTER TABLE positions DROP COLUMN rebalance_mode')
    legacy.exec('ALTER TABLE positions DROP COLUMN rebalance_oor_direction')
    legacy.close()

    getDb()
    const columns = getDb().prepare("PRAGMA table_info('positions')").all() as Array<{ name: string; dflt_value: string | null }>
    assert.equal(columns.find(column => column.name === 'rebalance_mode')?.dflt_value, "'up'")
    assert.equal(columns.some(column => column.name === 'rebalance_oor_direction'), true)

    upsertPosition(basePosition)
    const position = loadKnownPositions()[0]
    assert.equal(position.rebalanceMode, 'up')
    assert.equal(position.rebalanceOorDirection, null)
    assert.equal(position.trailingActivated, true)
  })
})

test('upsert preserves absent risk and rebalance settings while inheriting explicit settings on insert', () => {
  withDb(() => {
    initSchema(getDb())
    upsertPosition({
      ...basePosition,
      trailingDisabled: true,
      binRangeDisabled: true,
      autoRebalanceEnabled: true,
      rebalanceMode: 'down',
    })
    getDb().prepare(`
      UPDATE positions
      SET rebalance_oor_since = 123, rebalance_oor_direction = 'down'
      WHERE position_pubkey = ?
    `).run(basePosition.positionPubkey)

    upsertPosition({ ...basePosition, peakPnlPercent: 8, trailingActivated: true })
    const preserved = loadKnownPositions()[0]
    assert.equal(preserved.trailingDisabled, true)
    assert.equal(preserved.binRangeDisabled, true)
    assert.equal(preserved.autoRebalanceEnabled, true)
    assert.equal(preserved.rebalanceMode, 'down')
    assert.equal(preserved.rebalanceOorSince, 123)
    assert.equal(preserved.rebalanceOorDirection, 'down')

    upsertPosition({
      ...basePosition,
      positionPubkey: 'inherited-position',
      trailingDisabled: true,
      binRangeDisabled: true,
      autoRebalanceEnabled: true,
      rebalanceMode: 'both',
    })
    const inherited = loadKnownPositions().find(position => position.positionPubkey === 'inherited-position')!
    assert.equal(inherited.trailingDisabled, true)
    assert.equal(inherited.binRangeDisabled, true)
    assert.equal(inherited.autoRebalanceEnabled, true)
    assert.equal(inherited.rebalanceMode, 'both')
  })
})

test('rebalance settings reset OOR state and retain Flip/Precision exclusivity', () => {
  withDb(() => {
    initSchema(getDb())
    upsertPosition(basePosition)

    updateRebalanceOorSince(basePosition.positionPubkey, 100, 'up')
    assert.equal(loadKnownPositions()[0].rebalanceOorDirection, 'up')

    updateAutoRebalanceEnabled(basePosition.positionPubkey, true, 'both')
    let position = loadKnownPositions()[0]
    assert.equal(position.autoRebalanceEnabled, true)
    assert.equal(position.rebalanceMode, 'both')
    assert.equal(position.rebalanceOorSince, null)
    assert.equal(position.rebalanceOorDirection, null)
    assert.equal(position.flipModeEnabled, false)
    assert.equal(position.precisionCurveEnabled, false)

    updateRebalanceOorSince(basePosition.positionPubkey, 200, 'down')
    updateAutoRebalanceEnabled(basePosition.positionPubkey, false)
    position = loadKnownPositions()[0]
    assert.equal(position.autoRebalanceEnabled, false)
    assert.equal(position.rebalanceOorSince, null)
    assert.equal(position.rebalanceOorDirection, null)
    assert.equal(position.rebalanceMode, 'both')

    updateRebalanceOorSince(basePosition.positionPubkey, 300, 'down')
    updatePrecisionCurveEnabled(basePosition.positionPubkey, true)
    position = loadKnownPositions()[0]
    assert.equal(position.autoRebalanceEnabled, false)
    assert.equal(position.rebalanceOorSince, null)
    assert.equal(position.rebalanceOorDirection, null)

    updateRebalanceOorSince(basePosition.positionPubkey, 400, 'up')
    updateFlipModeEnabled(basePosition.positionPubkey, true)
    position = loadKnownPositions()[0]
    assert.equal(position.autoRebalanceEnabled, false)
    assert.equal(position.rebalanceOorSince, null)
    assert.equal(position.rebalanceOorDirection, null)
  })
})
