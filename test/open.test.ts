import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateSingleSideRange,
  formatRawAmount,
  OpenSubmissionPendingError,
  parseUiAmountToRaw,
  remainingPriceMoveBins,
  sdkSlippagePercentForBins,
  strategyType,
} from '../src/meteora/open.js'
import { StrategyType } from '@meteora-ag/dlmm'

function binResolver(activeBinId: number, activePrice: number, step: number) {
  return (price: number, min: boolean): number => {
    const exact = activeBinId + Math.log(price / activePrice) / Math.log(step)
    return min ? Math.floor(exact) : Math.ceil(exact)
  }
}

test('builds a quote-Y single-side range strictly below the active bin', () => {
  const range = calculateSingleSideRange({
    activeBinId: 100,
    activePoolPrice: 2,
    quoteSide: 'Y',
    rangePercent: 10,
    getBinIdFromPrice: binResolver(100, 2, 1.01),
  })

  assert.equal(range.maxBinId, 99)
  assert.ok(range.minBinId < range.maxBinId)
  assert.equal(range.currentPriceQuote, 2)
  assert.equal(range.targetPriceQuote, 1.8)
})

test('builds a quote-X single-side range strictly above the active bin', () => {
  const range = calculateSingleSideRange({
    activeBinId: 100,
    activePoolPrice: 2,
    quoteSide: 'X',
    rangePercent: 10,
    getBinIdFromPrice: binResolver(100, 2, 1.01),
  })

  assert.equal(range.minBinId, 101)
  assert.ok(range.maxBinId > range.minBinId)
  assert.equal(range.currentPriceQuote, 0.5)
  assert.equal(range.targetPriceQuote, 0.45)
})

test('parses UI token amounts without floating-point rounding', () => {
  assert.equal(parseUiAmountToRaw('1.234567', 6), 1_234_567n)
  assert.equal(parseUiAmountToRaw('0.1', 9), 100_000_000n)
  assert.equal(formatRawAmount(100_000_000n, 9), '0.1')
  assert.throws(() => parseUiAmountToRaw('1.0000001', 6))
  assert.throws(() => parseUiAmountToRaw('0,1', 9))
  assert.throws(() => parseUiAmountToRaw('1 0', 9))
  assert.throws(() => parseUiAmountToRaw('0', 9))
})

test('maps Telegram strategy names to Meteora SDK strategies', () => {
  assert.equal(strategyType('spot'), StrategyType.Spot)
  assert.equal(strategyType('curve'), StrategyType.Curve)
  assert.equal(strategyType('bidask'), StrategyType.BidAsk)
})

test('encodes an exact Meteora active-bin tolerance', () => {
  for (const binStep of [1, 25, 100]) {
    for (const bins of [1, 3, 25]) {
      const slippage = sdkSlippagePercentForBins(binStep, bins)
      assert.equal(Math.ceil(slippage / (binStep / 100)), bins)
    }
  }
  assert.throws(() => sdkSlippagePercentForBins(1, 0))
})

test('shares one total movement budget between refresh and on-chain execution', () => {
  assert.equal(remainingPriceMoveBins(3, 0), 3)
  assert.equal(remainingPriceMoveBins(3, 2), 1)
  assert.throws(() => remainingPriceMoveBins(3, 3))
  assert.throws(() => remainingPriceMoveBins(3, 4))
})

test('distinguishes finalized open transactions from unknown submission state', () => {
  const finalized = new OpenSubmissionPendingError('position', 'signature', new Error('position read delayed'), true)
  const unknown = new OpenSubmissionPendingError('position', 'signature', new Error('confirm timeout'))

  assert.equal(finalized.transactionFinalized, true)
  assert.equal(unknown.transactionFinalized, false)
})
