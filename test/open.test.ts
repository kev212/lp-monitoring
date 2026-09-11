import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateSingleSideRange,
  binIdFromUiPrice,
  formatRawAmount,
  describeOpenError,
  isBinSlippageError,
  OpenSimulationError,
  OpenTransactionFailedError,
  OpenSubmissionPendingError,
  parseUiAmountToRaw,
  remainingPriceMoveBins,
  resolveRebalanceFunding,
  sdkSlippagePercentForBins,
  strategyType,
  tokenProgramIdFromMintOwner,
  transactionRequiresInitializeBinArray,
} from '../src/meteora/open.js'
import { StrategyType } from '@meteora-ag/dlmm'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SystemProgram } from '@solana/web3.js'

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

test('converts UI prices back to lamport prices before resolving bins', () => {
  const seen: number[] = []
  const resolved = binIdFromUiPrice({
    price: 0.6,
    min: true,
    toPricePerLamport: price => price / 1_000,
    getBinIdFromPrice: price => {
      seen.push(price)
      return 48
    },
  })
  assert.equal(resolved, 48)
  assert.equal(seen[0], 0.0006)

  const range = calculateSingleSideRange({
    activeBinId: 100,
    activePoolPrice: 1,
    quoteSide: 'Y',
    rangePercent: 40,
    getBinIdFromPrice: (price, min) => {
      const lamportPrice = price / 1_000
      const exact = 100 + Math.log(lamportPrice / 0.001) / Math.log(1.01)
      return min ? Math.floor(exact) : Math.ceil(exact)
    },
  })
  assert.equal(range.minBinId, 48)
  assert.equal(range.maxBinId, 99)
  assert.equal(range.maxBinId - range.minBinId + 1, 52)
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

test('detects only Meteora InitializeBinArray instructions', () => {
  const meteoraProgram = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
  const initializeBinArray = Buffer.from('235613b94ed44bd3', 'hex')

  assert.equal(transactionRequiresInitializeBinArray({ instructions: [
    { programId: meteoraProgram, data: Buffer.concat([initializeBinArray, Buffer.alloc(8)]) },
  ] }), true)
  assert.equal(transactionRequiresInitializeBinArray({ instructions: [
    { programId: SystemProgram.programId, data: initializeBinArray },
    { programId: meteoraProgram, data: Buffer.from('235613b94ed44bd4', 'hex') },
  ] }), false)
})

test('decodes Meteora bin slippage errors for simulation and finalized failures', () => {
  const details = describeOpenError({ InstructionError: [6, { Custom: 6004 }] }, [
    'Program log: Error Code: ExceededBinSlippageTolerance. Error Number: 6004. Error Message: Exceeded bin slippage tolerance.',
  ])
  assert.deepEqual(details, {
    code: 6004,
    name: 'ExceededBinSlippageTolerance',
    message: 'Exceeded bin slippage tolerance.',
  })
  assert.equal(isBinSlippageError(new OpenSimulationError(details)), true)
  assert.equal(isBinSlippageError(new OpenTransactionFailedError('signature', 'position', details)), true)
  assert.equal(isBinSlippageError(new Error('RPC request failed')), false)
})

test('funds an up rebalance from the exact USDC close receipt when present', () => {
  const funding = resolveRebalanceFunding({
    quoteSide: 'Y',
    quoteMint: 'USDC',
    tokenXMint: 'X',
    quoteDecimals: 6,
    tokenXDecimals: 6,
    amountQuote: 980.35,
    direction: 'up',
    tokenAmountRaw: '849175236',
  })
  assert.equal(funding.amountRaw, 849175236n)
  assert.equal(funding.amountInput, '849.175236')
  assert.equal(funding.amountQuote, 849.175236)
  assert.equal(funding.fundingSide, 'Y')
  assert.equal(funding.fundingMint, 'USDC')

  const fallback = resolveRebalanceFunding({
    quoteSide: 'Y',
    quoteMint: 'USDC',
    tokenXMint: 'X',
    quoteDecimals: 6,
    tokenXDecimals: 6,
    amountQuote: 980.35,
    direction: 'up',
  })
  assert.equal(fallback.amountRaw, 980350000n)
})

test('resolves the token program from the mint account owner', () => {
  assert.equal(
    tokenProgramIdFromMintOwner('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb').toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
  )
  assert.equal(
    tokenProgramIdFromMintOwner('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
  )
  assert.equal(tokenProgramIdFromMintOwner(undefined).toBase58(), TOKEN_PROGRAM_ID.toBase58())
  assert.equal(tokenProgramIdFromMintOwner(null).toBase58(), TOKEN_PROGRAM_ID.toBase58())
})
