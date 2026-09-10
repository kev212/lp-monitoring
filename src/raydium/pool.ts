import type { Raydium } from '@raydium-io/raydium-sdk-v2'
import type { Connection, Keypair } from '@solana/web3.js'
import { getRaydium } from './sdk.js'

export type RaydiumPoolBundle = Awaited<ReturnType<Raydium['clmm']['getPoolInfoFromRpc']>>

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
  return {
    bundle,
    state: {
      poolId: poolInfo.id,
      programId: poolInfo.programId,
      mintA: poolInfo.mintA.address,
      mintB: poolInfo.mintB.address,
      mintASymbol: poolInfo.mintA.symbol || poolInfo.mintA.address.slice(0, 4),
      mintBSymbol: poolInfo.mintB.symbol || poolInfo.mintB.address.slice(0, 4),
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
