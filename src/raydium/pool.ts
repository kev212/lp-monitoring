import type { ApiV3PoolInfoConcentratedItem, Raydium } from '@raydium-io/raydium-sdk-v2'
import type { Connection, Keypair } from '@solana/web3.js'
import { getRaydium } from './sdk.js'

export type RaydiumPoolBundle = Awaited<ReturnType<Raydium['clmm']['getPoolInfoFromRpc']>>

const symbolCache = new Map<string, { mintA: string; mintB: string }>()

function fallbackSymbol(symbol: string | undefined, address: string): string {
  return symbol || address.slice(0, 4)
}

/**
 * On-chain pool info can omit token symbols when the SDK token list is
 * disabled, so one API lookup per pool fills them in for clear notifications.
 */
async function resolvePoolSymbols(raydium: Raydium, poolInfo: ApiV3PoolInfoConcentratedItem): Promise<{ mintA: string; mintB: string }> {
  const cached = symbolCache.get(poolInfo.id)
  if (cached) return cached
  const symbols = {
    mintA: fallbackSymbol(poolInfo.mintA.symbol, poolInfo.mintA.address),
    mintB: fallbackSymbol(poolInfo.mintB.symbol, poolInfo.mintB.address),
  }
  try {
    const items = await raydium.api.fetchPoolById({ ids: poolInfo.id })
    const item = items[0] as ApiV3PoolInfoConcentratedItem | undefined
    if (item?.mintA?.symbol) symbols.mintA = item.mintA.symbol
    if (item?.mintB?.symbol) symbols.mintB = item.mintB.symbol
  } catch {
    // Keep the deterministic on-chain fallback symbols.
  }
  symbolCache.set(poolInfo.id, symbols)
  return symbols
}

export interface RaydiumPoolState {
  poolId: string
  programId: string
  mintA: string
  mintB: string
  mintASymbol: string
  mintBSymbol: string
  mintADecimals: number
  mintBDecimals: number
  mintAProgramId: string
  mintBProgramId: string
  tickSpacing: number
  currentTick: number
  currentPrice: number
}

export async function loadRaydiumPool(
  connection: Connection,
  wallet: Keypair,
  poolId: string,
): Promise<{ state: RaydiumPoolState; bundle: RaydiumPoolBundle }> {
  const raydium = await getRaydium(connection, wallet)
  const bundle = await raydium.clmm.getPoolInfoFromRpc(poolId)
  const { poolInfo, rpcPoolInfo } = bundle
  const symbols = await resolvePoolSymbols(raydium, poolInfo)
  return {
    bundle,
    state: {
      poolId: poolInfo.id,
      programId: poolInfo.programId,
      mintA: poolInfo.mintA.address,
      mintB: poolInfo.mintB.address,
      mintASymbol: symbols.mintA,
      mintBSymbol: symbols.mintB,
      mintADecimals: poolInfo.mintA.decimals,
      mintBDecimals: poolInfo.mintB.decimals,
      mintAProgramId: poolInfo.mintA.programId,
      mintBProgramId: poolInfo.mintB.programId,
      tickSpacing: poolInfo.config.tickSpacing,
      currentTick: rpcPoolInfo.tickCurrent,
      currentPrice: rpcPoolInfo.currentPrice,
    },
  }
}

export function rayDiumPairLabel(state: RaydiumPoolState): string {
  return `${state.mintASymbol}/${state.mintBSymbol}`
}
