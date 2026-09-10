import { BN } from '@coral-xyz/anchor'
import { CLMM_PROGRAM_ID, LiquidityMathUtil, TickUtil, TxVersion } from '@raydium-io/raydium-sdk-v2'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { Connection, Keypair } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { config } from '../config.js'
import { withRpcFallback } from '../solana/connection.js'
import type { RebalanceDirection } from '../types.js'
import { baseSideForDirection, type RaydiumBaseSide } from './policy.js'
import { loadRaydiumPool, type RaydiumPoolBundle } from './pool.js'
import { getRaydium } from './sdk.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const CLOSE_MEASURE_TIMEOUT_MS = 45_000
const CLOSE_MEASURE_POLL_MS = 1_000

function computeBudget() {
  return {
    units: config.raydiumComputeUnitLimit,
    microLamports: config.raydiumComputeUnitPrice,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readWalletTokenAmount(
  connection: Connection,
  owner: PublicKey,
  mint: string,
  tokenProgramId: string,
  commitment: 'confirmed' | 'finalized' = 'finalized',
): Promise<bigint> {
  if (mint === WSOL_MINT) {
    const lamports = await withRpcFallback(rpc => rpc.getBalance(owner, commitment), connection)
    return BigInt(lamports)
  }
  const mintAddress = new PublicKey(mint)
  const ata = getAssociatedTokenAddressSync(mintAddress, owner, false, new PublicKey(tokenProgramId))
  try {
    const balance = await withRpcFallback(rpc => rpc.getTokenAccountBalance(ata, commitment), connection)
    return BigInt(balance.value.amount)
  } catch {
    return 0n
  }
}

export interface RaydiumFundingBaseline {
  baseSide: RaydiumBaseSide
  fundingMint: string
  fundingMintProgramId: string
  fundingAmountRaw: bigint
}

/**
 * Reads the funding-side wallet balance before the close. Persisting this
 * baseline lets recovery attribute the proceeds even if the process restarts
 * in the middle of the close+reopen cycle.
 */
export async function readRaydiumFundingBaseline(
  connection: Connection,
  wallet: Keypair,
  params: { poolId: string; direction: RebalanceDirection },
): Promise<RaydiumFundingBaseline> {
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const baseSide = baseSideForDirection(params.direction)
  const fundingMint = baseSide === 'MintA' ? bundle.poolInfo.mintA : bundle.poolInfo.mintB
  const fundingAmountRaw = await readWalletTokenAmount(
    connection,
    wallet.publicKey,
    fundingMint.address,
    fundingMint.programId,
    'finalized',
  )
  return {
    baseSide,
    fundingMint: fundingMint.address,
    fundingMintProgramId: fundingMint.programId,
    fundingAmountRaw,
  }
}

export async function measureRaydiumFundingAmount(
  connection: Connection,
  wallet: Keypair,
  params: { fundingMint: string; fundingMintProgramId: string; preFundingAmountRaw: bigint },
): Promise<bigint> {
  const current = await readWalletTokenAmount(
    connection,
    wallet.publicKey,
    params.fundingMint,
    params.fundingMintProgramId,
    'confirmed',
  )
  return current > params.preFundingAmountRaw ? current - params.preFundingAmountRaw : 0n
}

export interface RaydiumCloseParams {
  poolId: string
  nftMint: string
  direction: RebalanceDirection
  fundingMint: string
  fundingMintProgramId: string
  preFundingAmountRaw: bigint
}

export interface RaydiumCloseSubmission {
  signature: string
  baseAmountRaw: bigint | null
}

/**
 * Closes the position (100% liquidity, claim fees, burn NFT) and then polls the
 * funding-side balance until the proceeds are visible. Returns a null amount
 * instead of failing when the balance has not caught up yet, so the durable
 * intent can re-measure without re-sending the close.
 */
export async function submitRaydiumClose(
  connection: Connection,
  wallet: Keypair,
  params: RaydiumCloseParams,
): Promise<RaydiumCloseSubmission> {
  const raydium = await getRaydium(connection, wallet)
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const ownerPositions = await raydium.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID })
  const ownerPosition = ownerPositions.find(position => position.nftMint.toBase58() === params.nftMint)
  if (!ownerPosition) throw new Error('Raydium position is no longer owned by this wallet')

  const sqrtCurrent = bundle.rpcPoolInfo.sqrtPriceX64
  const sqrtLower = TickUtil.getSqrtPriceAtTick(ownerPosition.tickLower)
  const sqrtUpper = TickUtil.getSqrtPriceAtTick(ownerPosition.tickUpper)
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(
    sqrtCurrent,
    sqrtLower,
    sqrtUpper,
    ownerPosition.liquidity,
    false,
  )
  const keepRatio = (amount: BN) => amount.muln(10_000 - config.raydiumSlippageBps).divn(10_000)
  const amountMinA = keepRatio(amountA)
  const amountMinB = keepRatio(amountB)

  const { execute } = await raydium.clmm.decreaseLiquidity({
    poolInfo: bundle.poolInfo,
    poolKeys: bundle.poolKeys,
    ownerPosition,
    ownerInfo: { useSOLBalance: true, closePosition: true },
    liquidity: ownerPosition.liquidity,
    amountMinA,
    amountMinB,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: computeBudget(),
  })
  const { txId } = await execute({ sendAndConfirm: true })

  const deadline = Date.now() + CLOSE_MEASURE_TIMEOUT_MS
  for (;;) {
    const amount = await measureRaydiumFundingAmount(connection, wallet, params)
    if (amount > 0n) return { signature: txId, baseAmountRaw: amount }
    if (Date.now() >= deadline) return { signature: txId, baseAmountRaw: null }
    await sleep(CLOSE_MEASURE_POLL_MS)
  }
}

export interface RaydiumOpenParams {
  poolId: string
  tickLower: number
  tickUpper: number
  baseSide: RaydiumBaseSide
  baseAmountRaw: bigint
}

export interface RaydiumPreparedOpen {
  nftMint: string
  submit: () => Promise<string>
}

/**
 * Builds the replacement position without submitting it. The generated NFT
 * mint is available before submission so callers can persist it first and
 * recover without risking a duplicate open.
 */
export async function prepareRaydiumOpen(
  connection: Connection,
  wallet: Keypair,
  params: RaydiumOpenParams,
): Promise<RaydiumPreparedOpen> {
  const raydium = await getRaydium(connection, wallet)
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo: bundle.poolInfo,
    poolKeys: bundle.poolKeys,
    tickLower: Math.min(params.tickLower, params.tickUpper),
    tickUpper: Math.max(params.tickLower, params.tickUpper),
    base: params.baseSide,
    baseAmount: new BN(params.baseAmountRaw.toString()),
    otherAmountMax: new BN(0),
    liquidity: new BN(0),
    nft2022: true,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: computeBudget(),
  })
  const nftMint = extInfo.nftMint.toBase58()
  return {
    nftMint,
    submit: async () => (await execute({ sendAndConfirm: true })).txId,
  }
}

export type { RaydiumPoolBundle }
