import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.js'
import { closeDb, setSyncValue } from '../src/db/client.js'
import {
  buildRaydiumRangeBar,
  formatRaydiumDashboardLines,
  formatUsd,
  readRaydiumDashboardSnapshot,
  type RaydiumDashboardPosition,
  type RaydiumDashboardSnapshot,
} from '../src/raydium/dashboard.js'

function position(overrides: Partial<RaydiumDashboardPosition> = {}): RaydiumDashboardPosition {
  return {
    nftMint: 'n1',
    poolId: 'p1',
    pair: 'DoGE/SOL',
    tickLower: 100,
    tickUpper: 160,
    tickSpacing: 60,
    currentTick: 130,
    direction: null,
    since: null,
    cooldownUntil: null,
    enabled: true,
    valueUsd: null,
    pnlUsd: null,
    pnlPercent: null,
    basisUsd: null,
    basisSource: null,
    feeValueUsd: null,
    priceLower: null,
    priceUpper: null,
    priceCurrent: null,
    ...overrides,
  }
}

function snapshot(positions: RaydiumDashboardPosition[], updatedAt = 1_000_000): RaydiumDashboardSnapshot {
  return { version: 2, updatedAt, positions }
}

test('formats a Raydium section with value, fees, range bar and the OOR timer', () => {
  const now = 1_000_000
  const lines = formatRaydiumDashboardLines(snapshot([
    position({
      valueUsd: 120.5,
      pnlUsd: 5.5,
      pnlPercent: 4.7826,
      basisUsd: 115,
      basisSource: 'rebalance',
      feeValueUsd: 0.42,
      priceLower: 0.08,
      priceUpper: 0.09,
      priceCurrent: 0.085,
    }),
    position({
      nftMint: 'n2',
      poolId: 'p2',
      pair: 'AAA/SOL',
      tickLower: 200,
      tickUpper: 260,
      currentTick: 300,
      direction: 'up',
      since: now - 120_000,
      cooldownUntil: now + 300_000,
      valueUsd: 50,
      pnlUsd: -1,
      pnlPercent: -1.96,
      basisUsd: 51,
      basisSource: 'baseline',
      feeValueUsd: 0.001,
      priceLower: 0.008,
      priceUpper: 0.009,
      priceCurrent: 0.0091,
    }),
  ], now), { enabled: true, mode: 'both', windowMinutes: 5, now })

  assert.match(lines[0], /RAYDIUM CLMM · auto ON · mode both · window 5m · in-range 1 tick/)
  assert.match(lines[1], /DoGE\/SOL · IN RANGE · rebal ON/)
  assert.match(lines[2], /💰 \$120\.50 · PnL 📈 \+\$5\.50 \(\+4\.78%\) · basis \$115\.00 \(bot\)/)
  assert.match(lines[3], /fees \$0\.42/)
  assert.match(lines[4], /ticks 100\.\.160 · curr 130 · spacing 60/)
  assert.match(lines[5], /AAA\/SOL · OOR UP · 2m00s · cooldown 5m00s/)
  assert.match(lines[6], /📉 -\$1\.00 \(-1\.96%\) · basis \$51\.00 \(sejak monitoring\)/)
  assert.match(lines[7], /fees < \$0\.01/)
})

test('marks a position whose per-position rebalance is disabled', () => {
  const lines = formatRaydiumDashboardLines(snapshot([
    position({
      nftMint: 'n1',
      poolId: 'p1',
      pair: 'DOGE/USDC',
      tickLower: -70860,
      tickUpper: -70800,
      currentTick: -70830,
      enabled: false,
    }),
  ], 1_000_000), { enabled: true, mode: 'both', windowMinutes: 5, now: 1_000_000 })

  assert.match(lines[1], /DOGE\/USDC · IN RANGE · rebal OFF \(posisi\)/)
})

test('shows the disabled state and handles empty snapshots', () => {
  const missing = formatRaydiumDashboardLines(null, { enabled: false, mode: 'up', windowMinutes: 5 })
  assert.match(missing[0], /auto OFF · mode up/)
  assert.match(missing[1], /Belum ada data posisi Raydium/)

  const empty = formatRaydiumDashboardLines(snapshot([]), { enabled: true, mode: 'both', windowMinutes: 5 })
  assert.match(empty[1], /Tidak ada posisi Raydium/)
})

test('caps the section and reports the remaining positions', () => {
  const positions = Array.from({ length: 7 }, (_, index) => position({ nftMint: `n${index}`, poolId: 'p' }))
  const lines = formatRaydiumDashboardLines(snapshot(positions), {
    enabled: true,
    mode: 'both',
    windowMinutes: 5,
    maxLines: 5,
  })
  assert.match(lines.at(-1) ?? '', /\+2 posisi lagi/)
})

test('renders the range bar with an in-range cursor and OOR arrows', () => {
  assert.equal(buildRaydiumRangeBar({ tickLower: 0, tickUpper: 100, currentTick: 50, direction: null }), '━━━━━│━━━━ 50%')
  assert.equal(buildRaydiumRangeBar({ tickLower: 0, tickUpper: 100, currentTick: -10, direction: 'down' }), '⬅ │━━━━━━━━━ 0%')
  assert.equal(buildRaydiumRangeBar({ tickLower: 0, tickUpper: 100, currentTick: 200, direction: 'up' }), '➡ ━━━━━━━━━│ 100%')
  assert.equal(buildRaydiumRangeBar({ tickLower: 0, tickUpper: 0, currentTick: 0, direction: null }), '━━━━━━━━━━ N/A')
})

test('formats USD values and handles tiny or missing amounts', () => {
  assert.equal(formatUsd(null), 'N/A')
  assert.equal(formatUsd(0.001), '< $0.01')
  assert.equal(formatUsd(120.5), '$120.50')
  assert.equal(formatUsd(-12.34), '-$12.34')
})

test('parses a v1 snapshot and defaults the valuation fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raydium-dashboard-'))
  const originalPath = config.dbPath
  closeDb()
  config.dbPath = join(directory, 'test.sqlite')
  try {
    setSyncValue('raydium_dashboard', JSON.stringify({
      version: 1,
      updatedAt: 123,
      positions: [{
        nftMint: 'n1',
        poolId: 'p1',
        pair: 'DOGE/USDC',
        tickLower: -10,
        tickUpper: 50,
        tickSpacing: 60,
        currentTick: 0,
        direction: null,
        since: null,
        cooldownUntil: null,
        enabled: true,
      }],
    }))
    const parsed = readRaydiumDashboardSnapshot()
    assert.equal(parsed?.version, 2)
    assert.equal(parsed?.positions[0].valueUsd, null)
    assert.equal(parsed?.positions[0].pnlPercent, null)
    assert.equal(parsed?.positions[0].basisSource, null)
    assert.equal(parsed?.positions[0].enabled, true)
  } finally {
    closeDb()
    config.dbPath = originalPath
    rmSync(directory, { recursive: true, force: true })
  }
})
