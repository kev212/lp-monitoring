import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinRangeDisplay, formatCompactPrice } from '../src/telegram/binDisplay.js'
import { formatDashboardPositionLines, formatOpeningDashboardLines, formatPnlUsd, parseRiskInput } from '../src/telegram/control.js'
import { effectiveRiskSettings, validateRiskSettings } from '../src/risk/settings.js'
import { evaluateTrigger } from '../src/risk/rules.js'
import type { PositionRow } from '../src/types.js'

test('formats compact prices and a fixed-width bin-position progress bar', () => {
  assert.equal(formatCompactPrice(0.00001695), '0.0₄1695')
  assert.equal(formatCompactPrice(0.00004771), '0.0₄4771')
  assert.equal(formatCompactPrice(0.00003795), '0.0₄3795')

  const display = buildBinRangeDisplay({
    lowerBinId: 10,
    activeBinId: 18,
    upperBinId: 20,
    quoteSide: 'Y',
    quoteCurrency: 'SOL',
    priceForBin: bin => ({ 10: 0.00001695, 18: 0.00003795, 20: 0.00004771 }[bin] || 1),
  })

  assert.equal(display.progressPct, 80)
  assert.equal(display.bar, '━━━━━━━━│━ 80%')
  assert.equal(display.prices, '0.0₄1695 SOL – 0.0₄4771 SOL · 0.0₄3795 SOL')
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

  assert.equal(display.progressPct, 50)
  assert.equal(display.bar, '━━━━━│━━━━ 50%')
  assert.equal(display.prices, '$0.125 – $0.5 · $0.25')
})

test('keeps a sub-90 percent marker off the final bar slot', () => {
  const display = buildBinRangeDisplay({
    lowerBinId: 0,
    activeBinId: 88,
    upperBinId: 100,
    quoteSide: 'Y',
    quoteCurrency: 'SOL',
    priceForBin: () => 1,
  })

  assert.equal(display.progressPct, 88)
  assert.equal(display.bar, '━━━━━━━━│━ 88%')
})

test('formats approximate PnL in USD for SOL and USDC quotes', () => {
  assert.equal(formatPnlUsd({ quoteCurrency: 'SOL', pnlQuote: 0.02, solUsdPrice: 50 }), '~$1')
  assert.equal(formatPnlUsd({ quoteCurrency: 'SOL', pnlQuote: -0.02, solUsdPrice: 50 }), '~-$1')
  assert.equal(formatPnlUsd({ quoteCurrency: 'SOL', pnlQuote: 0.02, solUsdPrice: 0 }), null)
  assert.equal(formatPnlUsd({ quoteCurrency: 'USDC', pnlQuote: 1.25, solUsdPrice: 0 }), '~$1')
})

test('orders dashboard value before PnL and only shows positive Peak', () => {
  assert.deepEqual(formatDashboardPositionLines(
    { peakPnlPercent: 1.46 },
    1.45,
    149.87,
    'USDC',
    'off',
    { bar: '━━━━━━━━│━ 86%', prices: '$763.9 – $819.1 · $811' },
  ), [
    '   💰 $149.87 · 📈 PnL +1.45% · 🎯 Peak 1.46%',
    '   ━━━━━━━━│━ 86% · ⚙️ Modes off',
    '   $763.9 – $819.1 · $811',
  ])

  assert.deepEqual(formatDashboardPositionLines(
    { peakPnlPercent: 0 },
    -1.2,
    2,
    'SOL',
    'Flip',
    null,
  ), [
    '   💰 2.00 SOL · 📉 PnL -1.20%',
    '   ⚙️ Modes Flip',
  ])
})

test('renders opening positions without monitoring metrics', () => {
  const lines = formatOpeningDashboardLines({ basisQuote: 0.1, quoteCurrency: 'SOL' })

  assert.deepEqual(lines, [
    '   ⏳ Menunggu finalisasi transaksi dan sinkronisasi lokal',
    '   💰 Deposit 0.10 SOL',
  ])
  assert.equal(lines.join('\n').includes('N/A'), false)
  assert.equal(lines.join('\n').includes('Peak'), false)
})

test('validates global risk inputs', () => {
  assert.equal(parseRiskInput('sl', '-12.5%'), -12.5)
  assert.equal(parseRiskInput('tp', '8'), 8)
  assert.equal(parseRiskInput('trail_arm', '3'), 3)
  assert.equal(parseRiskInput('trail_drop', '1%'), 1)
  assert.equal(parseRiskInput('rebal_tp', '6'), 6)
  assert.equal(parseRiskInput('rebal_sl', '-10'), -10)
  assert.equal(parseRiskInput('sl', '12'), null)
  assert.equal(parseRiskInput('tp', '1e2'), null)
  assert.equal(parseRiskInput('rebal_tp', '0'), null)
  assert.equal(parseRiskInput('rebal_tp', '1500'), null)
  assert.equal(parseRiskInput('rebal_sl', '5'), null)
  assert.equal(parseRiskInput('rebal_sl', '-150'), null)
  assert.throws(() => validateRiskSettings({
    slPercent: -12,
    tpPercent: 8,
    trailingEnabled: true,
    trailingActivationPct: 1,
    trailingStopDropPct: 1,
    rebalanceTpPercent: null,
    rebalanceSlPercent: null,
  }))
  assert.throws(() => validateRiskSettings({
    slPercent: -12,
    tpPercent: 8,
    trailingEnabled: true,
    trailingActivationPct: 1,
    trailingStopDropPct: 1,
    rebalanceTpPercent: 5,
    rebalanceSlPercent: 3,
  }))
})

test('applies rebalance TP/SL only to Auto Rebalance positions with global fallback', () => {
  const settings = {
    slPercent: -25,
    tpPercent: 5,
    trailingEnabled: true,
    trailingActivationPct: 3,
    trailingStopDropPct: 1,
    rebalanceTpPercent: 3,
    rebalanceSlPercent: -10,
    revision: 1,
    updatedAt: 1,
  }

  assert.deepEqual(effectiveRiskSettings(settings, { autoRebalanceEnabled: false }), settings)
  const rebalanceSettings = effectiveRiskSettings(settings, { autoRebalanceEnabled: true })
  assert.equal(rebalanceSettings.tpPercent, 3)
  assert.equal(rebalanceSettings.slPercent, -10)

  const unset = { ...settings, rebalanceTpPercent: null, rebalanceSlPercent: null }
  const fallback = effectiveRiskSettings(unset, { autoRebalanceEnabled: true })
  assert.equal(fallback.tpPercent, 5)
  assert.equal(fallback.slPercent, -25)
})

test('excludes BIN_RANGE close for Auto Rebalance positions', () => {
  const binData = { upperBinId: 100, poolActiveBinId: 95 }
  const basePosition = {
    status: 'monitoring',
    drawdownTpOverrideActive: false,
    trailingActivated: false,
    peakPnlPercent: 0,
    triggerConfirmations: 0,
  } as PositionRow
  const settings = {
    slPercent: -20,
    tpPercent: 20,
    trailingEnabled: false,
    trailingActivationPct: 3,
    trailingStopDropPct: 1,
    revision: 1,
    updatedAt: 1,
  }

  const normal = evaluateTrigger({ ...basePosition, autoRebalanceEnabled: false }, 6, binData, settings, false)
  assert.equal(normal.shouldTrigger, true)
  assert.equal(normal.triggerType, 'BIN_RANGE')

  const rebalance = evaluateTrigger({ ...basePosition, autoRebalanceEnabled: true }, 6, binData, settings, false)
  assert.equal(rebalance.shouldTrigger, false)
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
    rebalanceTpPercent: null,
    rebalanceSlPercent: null,
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
    rebalanceTpPercent: null,
    rebalanceSlPercent: null,
    revision: 1,
    updatedAt: 1,
  }, false)

  assert.equal(decision.shouldTrigger, false)
})
