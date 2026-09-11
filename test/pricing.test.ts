import assert from 'node:assert/strict'
import test from 'node:test'
import { getTokenPricesInUsd, parseJupiterUsdPrices } from '../src/pricing.js'

test('parses top-level and nested usdPrice/price entries, skipping invalid ones', () => {
  const topLevel = parseJupiterUsdPrices({
    A: { usdPrice: 1.5 },
    B: { price: 2.5 },
    C: null,
    D: { usdPrice: 0 },
    E: { usdPrice: 'nope' },
  }, ['A', 'B', 'C', 'D', 'E', 'F'])

  assert.equal(topLevel.get('A'), 1.5)
  assert.equal(topLevel.get('B'), 2.5)
  assert.equal(topLevel.has('C'), false)
  assert.equal(topLevel.has('D'), false)
  assert.equal(topLevel.has('E'), false)
  assert.equal(topLevel.has('F'), false)

  const nested = parseJupiterUsdPrices({ data: { A: { usdPrice: 3 } } }, ['A'])
  assert.equal(nested.get('A'), 3)
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
