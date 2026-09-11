import { BN } from '@coral-xyz/anchor'
import { LiquidityMathUtil, TickUtil } from '@raydium-io/raydium-sdk-v2'
import { PublicKey } from '@solana/web3.js'
import { getSolPriceInUsd, getTokenPriceInSol } from '../pricing.js'
import type { RaydiumPoolBundle } from './pool.js'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

export interface RaydiumPositionAmounts {
  amountA: number
  amountB: number
}

/** Human amounts of both tokens for a CLMM position at the current pool price. */
export function raydiumPositionAmounts(input: {
  bundle: RaydiumPoolBundle
  liquidity: bigint
  tickLower: number
  tickUpper: number
}): RaydiumPositionAmounts {
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(
    input.bundle.rpcPoolInfo.sqrtPriceX64,
    TickUtil.getSqrtPriceAtTick(input.tickLower),
    TickUtil.getSqrtPriceAtTick(input.tickUpper),
    new BN(input.liquidity.toString()),
    false,
  )
  return {
    amountA: Number(amounts.amountA.toString()) / 10 ** input.bundle.poolInfo.mintA.decimals,
    amountB: Number(amounts.amountB.toString()) / 10 ** input.bundle.poolInfo.mintB.decimals,
  }
}

/**
 * Human price of MintA in MintB from a Q64.64 sqrt price. The raw ratio is
 * scaled up by the decimal difference, matching the SDK's currentPrice.
 */
export function raydiumPriceAtSqrtX64(sqrtPriceX64: bigint, mintADecimals: number, mintBDecimals: number): number {
  const ratio = Number(sqrtPriceX64.toString()) / 2 ** 64
  return ratio * ratio * 10 ** (mintADecimals - mintBDecimals)
}

export function raydiumPriceAtTick(tick: number, mintADecimals: number, mintBDecimals: number): number {
  return raydiumPriceAtSqrtX64(BigInt(TickUtil.getSqrtPriceAtTick(tick).toString()), mintADecimals, mintBDecimals)
}

export interface RaydiumPositionValue {
  valueQuote: number
  valueUsd: number | null
  feeValueQuote: number
  feeValueUsd: number | null
}

/** Position value and claimable fees in quote terms, plus USD when a rate exists. */
export function raydiumPositionValue(input: {
  amounts: RaydiumPositionAmounts
  feeOwedA: bigint
  feeOwedB: bigint
  mintADecimals: number
  mintBDecimals: number
  priceAInB: number
  usdPerQuote: number | null
}): RaydiumPositionValue {
  const valueQuote = input.amounts.amountB + input.amounts.amountA * input.priceAInB
  const feeA = Number(input.feeOwedA.toString()) / 10 ** input.mintADecimals
  const feeB = Number(input.feeOwedB.toString()) / 10 ** input.mintBDecimals
  const feeValueQuote = feeB + feeA * input.priceAInB
  const usdPerQuote = input.usdPerQuote !== null && input.usdPerQuote > 0 ? input.usdPerQuote : null
  return {
    valueQuote,
    valueUsd: usdPerQuote === null ? null : valueQuote * usdPerQuote,
    feeValueQuote,
    feeValueUsd: usdPerQuote === null ? null : feeValueQuote * usdPerQuote,
  }
}

export interface RaydiumPnl {
  pnlUsd: number
  pnlPercent: number
}

export function raydiumPnl(valueUsd: number | null, basisUsd: number | null): RaydiumPnl | null {
  if (valueUsd === null || basisUsd === null || !Number.isFinite(valueUsd) || !(basisUsd > 0)) return null
  const pnlUsd = valueUsd - basisUsd
  return { pnlUsd, pnlPercent: (pnlUsd / basisUsd) * 100 }
}

export interface RaydiumUsdValue {
  valueUsd: number
  feeValueUsd: number
}

/**
 * USD value and claimable fees from per-token Jupiter prices, which are more
 * precise than deriving one side from the pool spot price.
 */
export function raydiumUsdValue(input: {
  amounts: RaydiumPositionAmounts
  feeOwedA: bigint
  feeOwedB: bigint
  mintADecimals: number
  mintBDecimals: number
  usdPerA: number
  usdPerB: number
}): RaydiumUsdValue {
  const feeA = Number(input.feeOwedA.toString()) / 10 ** input.mintADecimals
  const feeB = Number(input.feeOwedB.toString()) / 10 ** input.mintBDecimals
  return {
    valueUsd: input.amounts.amountA * input.usdPerA + input.amounts.amountB * input.usdPerB,
    feeValueUsd: feeA * input.usdPerA + feeB * input.usdPerB,
  }
}

/** USD value of one quote token; null when no price feed is available. */
export async function raydiumUsdPerQuote(mintB: string): Promise<number | null> {
  try {
    if (mintB === USDC_MINT) return 1
    const solUsd = await getSolPriceInUsd()
    if (!(solUsd > 0)) return null
    if (mintB === WSOL_MINT) return solUsd
    const quoteInSol = await getTokenPriceInSol(new PublicKey(mintB))
    return quoteInSol > 0 ? quoteInSol * solUsd : null
  } catch {
    return null
  }
}
