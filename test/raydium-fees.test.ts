import assert from 'node:assert/strict'
import test from 'node:test'
import { PublicKey, type Connection } from '@solana/web3.js'
import { CLMM_PROGRAM_ID, TickArrayUtil } from '@raydium-io/raydium-sdk-v2'
import { computeRaydiumPositionFees, raydiumFeeTickTargets } from '../src/raydium/fees.js'
import type { RaydiumPoolBundle } from '../src/raydium/pool.js'
import type { RaydiumWalletPosition } from '../src/raydium/positions.js'

function position(overrides: Partial<RaydiumWalletPosition> = {}): RaydiumWalletPosition {
  return {
    nftMint: 'nft',
    poolId: PublicKey.default.toBase58(),
    tickLower: 20400,
    tickUpper: 20520,
    liquidity: 1000n,
    feeOwedA: 7n,
    feeOwedB: 0n,
    feeGrowthInsideLastA: 0n,
    feeGrowthInsideLastB: 0n,
    ...overrides,
  }
}

test('derives one tick array target per edge with the tick offset inside it', () => {
  const targets = raydiumFeeTickTargets({
    programId: CLMM_PROGRAM_ID.toBase58(),
    poolId: PublicKey.default.toBase58(),
    tickSpacing: 120,
    tickLower: 20400,
    tickUpper: 20520,
  })
  assert.equal(targets.lower.offset, TickArrayUtil.getTickOffsetInArray(20400, 120))
  assert.equal(targets.upper.offset, TickArrayUtil.getTickOffsetInArray(20520, 120))
  assert.equal(targets.lower.address, targets.upper.address)
})

test('derives separate tick arrays when the edges fall in different arrays', () => {
  const targets = raydiumFeeTickTargets({
    programId: CLMM_PROGRAM_ID.toBase58(),
    poolId: PublicKey.default.toBase58(),
    tickSpacing: 60,
    tickLower: -3600,
    tickUpper: 0,
  })
  assert.notEqual(targets.lower.address, targets.upper.address)
  assert.equal(targets.lower.offset, 0)
  assert.equal(targets.upper.offset, 0)
})

test('keeps the stored fees when the tick array read fails', async () => {
  const connection = {
    getMultipleAccountsInfo: async () => { throw new Error('rpc down') },
  } as unknown as Connection
  const bundle = {
    poolInfo: {
      programId: CLMM_PROGRAM_ID.toBase58(),
      id: PublicKey.default.toBase58(),
      config: { tickSpacing: 120 },
    },
    rpcPoolInfo: {
      tickCurrent: 20460,
      feeGrowthGlobalX64A: { toString: () => '0' },
      feeGrowthGlobalX64B: { toString: () => '0' },
    },
  } as unknown as RaydiumPoolBundle

  const fees = await computeRaydiumPositionFees(connection, bundle, [position()])
  assert.deepEqual(fees.get('nft'), { feeA: 7n, feeB: 0n })
})

test('returns an empty map without touching the connection when there are no positions', async () => {
  const connection = {
    getMultipleAccountsInfo: async () => { throw new Error('must not be called') },
  } as unknown as Connection
  const fees = await computeRaydiumPositionFees(connection, {} as RaydiumPoolBundle, [])
  assert.equal(fees.size, 0)
})
