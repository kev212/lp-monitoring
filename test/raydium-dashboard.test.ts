import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatRaydiumDashboardLines,
  type RaydiumDashboardSnapshot,
} from '../src/raydium/dashboard.js'

function snapshot(positions: RaydiumDashboardSnapshot['positions'], updatedAt = 1_000_000): RaydiumDashboardSnapshot {
  return { version: 1, updatedAt, positions }
}

test('formats a Raydium dashboard section with range status and OOR timer', () => {
  const now = 1_000_000
  const lines = formatRaydiumDashboardLines(snapshot([
    {
      nftMint: 'n1', poolId: 'p1', pair: 'DoGE/SOL',
      tickLower: 100, tickUpper: 160, tickSpacing: 60, currentTick: 130,
      direction: null, since: null, cooldownUntil: null,
    },
    {
      nftMint: 'n2', poolId: 'p2', pair: 'AAA/SOL',
      tickLower: 200, tickUpper: 260, tickSpacing: 60, currentTick: 300,
      direction: 'up', since: now - 120_000, cooldownUntil: now + 300_000,
    },
  ], now), { enabled: true, mode: 'both', windowMinutes: 5, now })

  assert.match(lines[0], /RAYDIUM CLMM · auto ON · mode both · window 5m · in-range 1 tick/)
  assert.match(lines[1], /DoGE\/SOL · IN RANGE/)
  assert.match(lines[2], /ticks 100\.\.160 · curr 130 · spacing 60/)
  assert.match(lines[3], /AAA\/SOL · OOR UP · 2m00s · cooldown 5m00s/)
})

test('shows the disabled state and handles empty snapshots', () => {
  const missing = formatRaydiumDashboardLines(null, { enabled: false, mode: 'up', windowMinutes: 5 })
  assert.match(missing[0], /auto OFF · mode up/)
  assert.match(missing[1], /Belum ada data posisi Raydium/)

  const empty = formatRaydiumDashboardLines(snapshot([]), { enabled: true, mode: 'both', windowMinutes: 5 })
  assert.match(empty[1], /Tidak ada posisi Raydium/)
})

test('caps the section and reports the remaining positions', () => {
  const positions = Array.from({ length: 7 }, (_, index) => ({
    nftMint: `n${index}`,
    poolId: 'p',
    pair: 'A/B',
    tickLower: 0,
    tickUpper: 1,
    tickSpacing: 1,
    currentTick: 0,
    direction: null,
    since: null,
    cooldownUntil: null,
  }))
  const lines = formatRaydiumDashboardLines(snapshot(positions), {
    enabled: true,
    mode: 'both',
    windowMinutes: 5,
    maxLines: 5,
  })
  assert.match(lines.at(-1) ?? '', /\+2 posisi lagi/)
})
