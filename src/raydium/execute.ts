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

function computeBudget() {
  return {
    units: config.raydiumComputeUnitLimit,
    microLamports: config.raydiumComputeUnitPrice,
  }
}

async function readWalletTokenAmount(
  connection: Connection,
  owner: PublicKey,
  mint: string,
  tokenProgramId: string,
): Promise<bigint> {
  if (mint === WSOL_MINT) {
    const lamports = await withRpcFallback(rpc => rpc.getBalance(owner, 'finalized'), connection)
    return BigInt(lamports)
  }
  const mintAddress = new PublicKey(mint)
  const ata = getAssociatedTokenAddressSync(mintAddress, owner, false, new PublicKey(tokenProgramId))
  try {
    const balance = await withRpcFallback(rpc => rpc.getTokenAccountBalance(ata, 'finalized'), connection)
    return BigInt(balance.value.amount)
  } catch {
    return 0n
  }
}

export interface RaydiumCloseParams {
  poolId: string
  nftMint: string
  direction: RebalanceDirection
}

export interface RaydiumCloseResult {
  signature: string
  baseSide: RaydiumBaseSide
  baseAmountRaw: bigint
}

/**
 * Closes the position (100% liquidity, burn NFT, claim fees) and measures the
 * newly received amount of the side that will fund the replacement position.
 */
export async function closeRaydiumPosition(
  connection: Connection,
  wallet: Keypair,
  params: RaydiumCloseParams,
): Promise<RaydiumCloseResult> {
  const raydium = await getRaydium(connection, wallet)
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const ownerPositions = await raydium.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID })
  const ownerPosition = ownerPositions.find(position => position.nftMint.toBase58() === params.nftMint)
  if (!ownerPosition) throw new Error('Raydium position is no longer owned by this wallet')

  const baseSide = baseSideForDirection(params.direction)
  const baseMint = baseSide === 'MintA' ? bundle.poolInfo.mintA : bundle.poolInfo.mintB

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

  const preAmount = await readWalletTokenAmount(connection, wallet.publicKey, baseMint.address, baseMint.programId)

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

  const postAmount = await readWalletTokenAmount(connection, wallet.publicKey, baseMint.address, baseMint.programId)
  const baseAmountRaw = postAmount - preAmount
  if (baseAmountRaw <= 0n) {
    throw new Error('Raydium close returned no balance for the funding side; reopen skipped')
  }

  return { signature: txId, baseSide, baseAmountRaw }
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
