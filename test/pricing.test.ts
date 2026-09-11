import assert from 'node:assert/strict'
import test from 'node:test'
import { getTokenPricesInUsd, parseJupiterUsdPrices } from '../src/pricing.js'

test('parses usdPrice and legacy price fields, skipping missing or zero entries', () => {
  const prices = parseJupiterUsdPrices({
    data: {
      A: { usdPrice: 1.5 },
      B: { price: 2.5 },
      C: null,
      D: { usdPrice: 0 },
      E: { usdPrice: 'nope' },
    },
  }, ['A', 'B', 'C', 'D', 'E', 'F'])

  assert.equal(prices.get('A'), 1.5)
  assert.equal(prices.get('B'), 2.5)
  assert.equal(prices.has('C'), false)
  assert.equal(prices.has('D'), false)
  assert.equal(prices.has('E'), false)
  assert.equal(prices.has('F'), false)
})

test('handles malformed payloads and empty mint lists', () => {
  assert.equal(parseJupiterUsdPrices(null, ['A']).size, 0)
  assert.equal(parseJupiterUsdPrices({}, ['A']).size, 0)
  assert.equal(parseJupiterUsdPrices({ data: [] }, ['A']).size, 0)
})

test('returns an empty map for an empty batch without network access', async () => {
  const prices = await getTokenPricesInUsd([])
  assert.equal(prices.size, 0)
})
