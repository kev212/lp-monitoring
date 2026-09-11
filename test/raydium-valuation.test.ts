import assert from 'node:assert/strict'
import test from 'node:test'
import { raydiumPnl, raydiumPositionValue, raydiumPriceAtSqrtX64, raydiumUsdPerQuote, raydiumUsdValue } from '../src/raydium/valuation.js'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

test('values a position and its claimable fees in quote and USD', () => {
  const value = raydiumPositionValue({
    amounts: { amountA: 6113.23913512, amountB: 421.418623 },
    feeOwedA: 1_000_000n,
    feeOwedB: 500_000n,
    mintADecimals: 6,
    mintBDecimals: 6,
    priceAInB: 0.08393016751107246,
    usdPerQuote: 1,
  })

  const expectedQuote = 421.418623 + 6113.23913512 * 0.08393016751107246
  assert.ok(Math.abs(value.valueQuote - expectedQuote) < 1e-9)
  assert.equal(value.valueUsd, value.valueQuote)
  assert.ok(Math.abs(value.feeValueQuote - (0.5 + 1 * 0.08393016751107246)) < 1e-12)
  assert.equal(value.feeValueUsd, value.feeValueQuote)
})

test('leaves USD values null when no quote price feed is available', () => {
  const value = raydiumPositionValue({
    amounts: { amountA: 10, amountB: 1 },
    feeOwedA: 0n,
    feeOwedB: 0n,
    mintADecimals: 6,
    mintBDecimals: 6,
    priceAInB: 2,
    usdPerQuote: null,
  })
  assert.equal(value.valueQuote, 21)
  assert.equal(value.valueUsd, null)
  assert.equal(value.feeValueUsd, null)
})

test('computes PnL in USD and percent from a basis', () => {
  const pnl = raydiumPnl(934.5, 913.4)
  assert.ok(pnl)
  assert.ok(Math.abs((pnl?.pnlUsd ?? 0) - 21.1) < 1e-9)
  assert.ok(Math.abs((pnl?.pnlPercent ?? 0) - (21.1 / 913.4) * 100) < 1e-9)

  assert.equal(raydiumPnl(null, 913.4), null)
  assert.equal(raydiumPnl(934.5, null), null)
  assert.equal(raydiumPnl(934.5, 0), null)
})

test('values a position and its claimable fees from per-token Jupiter prices', () => {
  const value = raydiumUsdValue({
    amounts: { amountA: 331.137752, amountB: 3019.846389 },
    feeOwedA: 11_793_164n,
    feeOwedB: 0n,
    mintADecimals: 6,
    mintBDecimals: 6,
    usdPerA: 7.506202166142409,
    usdPerB: 1,
  })

  assert.ok(Math.abs(value.valueUsd - (331.137752 * 7.506202166142409 + 3019.846389)) < 1e-9)
  assert.ok(Math.abs(value.feeValueUsd - 11.793164 * 7.506202166142409) < 1e-9)
})

test('derives the human price from a Q64.64 sqrt price and decimals', () => {
  assert.equal(raydiumPriceAtSqrtX64(1n << 64n, 6, 6), 1)
  assert.equal(raydiumPriceAtSqrtX64(1n << 63n, 6, 0), 0.25 * 1e6)
})

test('treats USDC as a one-dollar quote without external calls', async () => {
  assert.equal(await raydiumUsdPerQuote(USDC_MINT), 1)
})
