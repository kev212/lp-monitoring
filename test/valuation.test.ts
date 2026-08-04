import assert from 'node:assert/strict'
import test from 'node:test'
import { mapMeteoraPosition } from '../src/meteora/valuation.js'
import { isBasisIncrease } from '../src/meteora/discovery.js'

const samplePosition = {
  positionAddress: 'position-1',
  pnlSol: '0.125',
  pnlSolPctChange: '12.5',
  pnlUsd: '25',
  pnlPctChange: '8',
  allTimeDeposits: {
    total: { sol: '1', usd: '200' },
    tokenX: { amount: '10' },
    tokenY: { amount: '2' },
  },
  allTimeWithdrawals: {
    total: { sol: '0.1', usd: '20' },
  },
  unrealizedPnl: {
    balancesSol: '1.125',
    balances: '225',
    balanceTokenX: { amount: '10.5', amountSol: '0.5', usd: '100' },
    balanceTokenY: { amount: '2.5', amountSol: '0.625', usd: '125' },
  },
  unclaimedFeeTokenX: { amount: '0.1' },
  unclaimedFeeTokenY: { amount: '0.2' },
  lowerBinId: 10,
  upperBinId: 20,
  poolActiveBinId: 18,
}

test('maps Meteora SOL fields for SOL-quoted positions', () => {
  const result = mapMeteoraPosition(samplePosition, 'SOL')

  assert.ok(result)
  assert.equal(result.quoteCurrency, 'SOL')
  assert.equal(result.estimatedExitQuote, 1.125)
  assert.equal(result.pnlQuote, 0.125)
  assert.equal(result.pnlPercent, 12.5)
  assert.equal(result.depositQuote, 1)
  assert.equal(result.withdrawalQuote, 0.1)
  assert.equal(result.tokenXAmount, 10.5)
  assert.equal(result.tokenXFees, 0.1)
  assert.equal(result.source, 'meteora-api')
})

test('maps Meteora USD fields for USDC-quoted positions', () => {
  const result = mapMeteoraPosition(samplePosition, 'USDC')

  assert.ok(result)
  assert.equal(result.quoteCurrency, 'USDC')
  assert.equal(result.estimatedExitQuote, 225)
  assert.equal(result.pnlQuote, 25)
  assert.equal(result.pnlPercent, 8)
  assert.equal(result.depositQuote, 200)
  assert.equal(result.withdrawalQuote, 20)
  assert.equal(result.estimatedExitSol, 1.125)
})

test('only increases the stored gross-deposit basis', () => {
  assert.equal(isBasisIncrease(0.1, 0.2), true)
  assert.equal(isBasisIncrease(0.2, 0.2), false)
  assert.equal(isBasisIncrease(0.2, 0.1), false)
  assert.equal(isBasisIncrease(Number.NaN, 0.2), false)
})
