import { Connection, PublicKey } from '@solana/web3.js'
import { getPool } from './positions.js'
import type { PositionDetail } from './positions.js'
import { getTokenPriceInSol } from '../pricing.js'

export interface ValuationResult {
  estimatedExitSol: number
  tokenXValueSol: number
  tokenYValueSol: number
  feesValueSol: number
  tokenXAmount: string
  tokenYAmount: string
  tokenXUsdPrice: number
  tokenYUsdPrice: number
}

export async function estimateExitValue(
  connection: Connection,
  detail: PositionDetail
): Promise<ValuationResult | null> {
  try {
    const pool = await getPool(connection, new PublicKey(detail.poolPubkey))
    const tokenXPriceSol = await getTokenPriceInSol(new PublicKey(detail.tokenXMint))
    const tokenYPriceSol = await getTokenPriceInSol(new PublicKey(detail.tokenYMint))

    const xAmount = Number(detail.totalXAmount) / Math.pow(10, 9)
    const yAmount = Number(detail.totalYAmount) / Math.pow(10, 9)
    const feeXAmount = Number(detail.feeX) / Math.pow(10, 9)
    const feeYAmount = Number(detail.feeY) / Math.pow(10, 9)

    const tokenXValueSol = xAmount * tokenXPriceSol
    const tokenYValueSol = yAmount * tokenYPriceSol
    const feesValueSol = (feeXAmount * tokenXPriceSol) + (feeYAmount * tokenYPriceSol)

    const estimatedExitSol = tokenXValueSol + tokenYValueSol + feesValueSol

    return {
      estimatedExitSol,
      tokenXValueSol,
      tokenYValueSol,
      feesValueSol,
      tokenXAmount: detail.totalXAmount,
      tokenYAmount: detail.totalYAmount,
      tokenXUsdPrice: 0,
      tokenYUsdPrice: 0,
    }
  } catch (err) {
    console.log(`[valuation] failed for ${detail.positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}
