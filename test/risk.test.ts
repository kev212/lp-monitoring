import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinRangeDisplay, formatCompactPrice } from '../src/telegram/binDisplay.js'
import { parseRiskInput } from '../src/telegram/control.js'
import { validateRiskSettings } from '../src/risk/settings.js'
import { evaluateTrigger } from '../src/risk/rules.js'
import type { PositionRow } from '../src/types.js'

test('formats compact prices and linear bin progress for a SOL quote', () => {
  assert.equal(formatCompactPrice(0.0003579), '0.0₃3579')
  assert.equal(formatCompactPrice(0.0004992), '0.0₃4992')
  assert.equal(formatCompactPrice(0.0004908), '0.0₃4908')

  const display = buildBinRangeDisplay({
    lowerBinId: 10,
    activeBinId: 18,
    upperBinId: 20,
    quoteSide: 'Y',
    quoteCurrency: 'SOL',
    priceForBin: bin => ({ 10: 0.0003579, 18: 0.0004908, 20: 0.0004992 }[bin] || 1),
  })

  assert.equal(display.progressPct, 94)
  assert.equal(display.bar, '━━━━━━━━━│ 94%')
  assert.equal(display.prices, '0.0₃3579 SOL – 0.0₃4992 SOL · 0.0₃4908 SOL')
})

test('inverts bin prices for a quote-X position and formats USDC as dollars', () => {
  const display = buildBinRangeDisplay({
    lowerBinId: 10,
    activeBinId: 15,
    upperBinId: 20,
    quoteSide: 'X',
    quoteCurrency: 'USDC',
    priceForBin: bin => ({ 10: 2, 15: 4, 20: 8 }[bin] || 1),
  })

  assert.equal(display.progressPct, 33)
  assert.equal(display.prices, '$0.125 – $0.5 · $0.25')
})

test('validates global risk inputs', () => {
  assert.equal(parseRiskInput('sl', '-12.5%'), -12.5)
  assert.equal(parseRiskInput('tp', '8'), 8)
  assert.equal(parseRiskInput('trail_arm', '3'), 3)
  assert.equal(parseRiskInput('trail_drop', '1%'), 1)
  assert.equal(parseRiskInput('sl', '12'), null)
  assert.equal(parseRiskInput('tp', '1e2'), null)
  assert.throws(() => validateRiskSettings({
    slPercent: -12,
    tpPercent: 8,
    trailingEnabled: true,
    trailingActivationPct: 1,
    trailingStopDropPct: 1,
  }))
})

test('trailing remains eligible when bin-range distance is outside its window', () => {
  const position = {
    status: 'monitoring',
    drawdownTpOverrideActive: false,
    trailingActivated: true,
    peakPnlPercent: 8,
    triggerConfirmations: 0,
  } as PositionRow
  const decision = evaluateTrigger(position, 6, { upperBinId: 100, poolActiveBinId: 50 }, {
    slPercent: -20,
    tpPercent: 20,
    trailingEnabled: true,
    trailingActivationPct: 3,
    trailingStopDropPct: 1,
    revision: 1,
    updatedAt: 1,
  }, false)

  assert.equal(decision.shouldTrigger, true)
  assert.equal(decision.triggerType, 'TRAILING_STOP')
})

test('disabled trailing cannot trigger', () => {
  const position = {
    status: 'monitoring',
    drawdownTpOverrideActive: false,
    trailingActivated: true,
    peakPnlPercent: 8,
    triggerConfirmations: 0,
  } as PositionRow
  const decision = evaluateTrigger(position, 6, undefined, {
    slPercent: -20,
    tpPercent: 20,
    trailingEnabled: false,
    trailingActivationPct: 3,
    trailingStopDropPct: 1,
    revision: 1,
    updatedAt: 1,
  }, false)

  assert.equal(decision.shouldTrigger, false)
})
