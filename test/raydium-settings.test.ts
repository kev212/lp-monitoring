import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { deleteSyncValue, setSyncValue } from '../src/db/client.js'
import {
  getRaydiumRebalanceSettings,
  isRaydiumRebalanceEnabled,
  listRaydiumRebalanceSettings,
  setRaydiumRebalanceEnabled,
} from '../src/raydium/state.js'

const PREFIX = 'raydium_rebalance_settings:'

function cleanup(...mints: string[]): void {
  for (const mint of mints) deleteSyncValue(`${PREFIX}${mint}`)
}

test('defaults a position without settings to enabled', () => {
  const mint = `rdn-default-${randomUUID()}`
  try {
    assert.equal(getRaydiumRebalanceSettings(mint), null)
    assert.equal(isRaydiumRebalanceEnabled(mint), true)
  } finally {
    cleanup(mint)
  }
})

test('persists a per-position disable toggle and reads it back', () => {
  const mint = `rdn-toggle-${randomUUID()}`
  try {
    setRaydiumRebalanceEnabled(mint, false)
    assert.equal(isRaydiumRebalanceEnabled(mint), false)
    const stored = getRaydiumRebalanceSettings(mint)
    assert.equal(stored?.enabled, false)
    assert.equal(stored?.nftMint, mint)
    assert.ok((stored?.updatedAt ?? 0) > 0)

    setRaydiumRebalanceEnabled(mint, true)
    assert.equal(isRaydiumRebalanceEnabled(mint), true)
    assert.equal(getRaydiumRebalanceSettings(mint)?.enabled, true)
  } finally {
    cleanup(mint)
  }
})

test('falls back to enabled when the stored value is malformed', () => {
  const mint = `rdn-malformed-${randomUUID()}`
  try {
    setSyncValue(`${PREFIX}${mint}`, 'not-json')
    assert.equal(getRaydiumRebalanceSettings(mint), null)
    assert.equal(isRaydiumRebalanceEnabled(mint), true)
  } finally {
    cleanup(mint)
  }
})

test('lists stored settings without exposing unrelated keys', () => {
  const mintOn = `rdn-list-on-${randomUUID()}`
  const mintOff = `rdn-list-off-${randomUUID()}`
  try {
    setRaydiumRebalanceEnabled(mintOn, true)
    setRaydiumRebalanceEnabled(mintOff, false)
    const listed = listRaydiumRebalanceSettings()
    const byMint = new Map(listed.map(settings => [settings.nftMint, settings.enabled]))
    assert.equal(byMint.get(mintOn), true)
    assert.equal(byMint.get(mintOff), false)
  } finally {
    cleanup(mintOn, mintOff)
  }
})
