import { BN } from '@coral-xyz/anchor'
import {
  PositionUtils,
  TickArrayLayout,
  TickArrayUtil,
  getPdaTickArrayAddress,
} from '@raydium-io/raydium-sdk-v2'
import { PublicKey, type Connection } from '@solana/web3.js'
import { withRpcFallback } from '../solana/connection.js'
import type { RaydiumPoolBundle } from './pool.js'
import type { RaydiumWalletPosition } from './positions.js'

const RPC_BATCH_SIZE = 100

export interface RaydiumPositionFees {
  feeA: bigint
  feeB: bigint
}

export interface RaydiumFeeTickTarget {
  address: string
  offset: number
}

/**
 * The on-chain tokenFeesOwed fields only reflect the last time the position was
 * touched. The claimable amount also includes the fee growth accrued since then,
 * so the dashboard has to recompute it from the tick array states like the UI.
 */
export function raydiumFeeTickTargets(input: {
  programId: string
  poolId: string
  tickSpacing: number
  tickLower: number
  tickUpper: number
}): { lower: RaydiumFeeTickTarget; upper: RaydiumFeeTickTarget } {
  const program = new PublicKey(input.programId)
  const pool = new PublicKey(input.poolId)
  const target = (tick: number): RaydiumFeeTickTarget => {
    const startIndex = TickArrayUtil.getTickArrayStartIndex(tick, input.tickSpacing)
    return {
      address: getPdaTickArrayAddress(program, pool, startIndex).publicKey.toBase58(),
      offset: TickArrayUtil.getTickOffsetInArray(tick, input.tickSpacing),
    }
  }
  return { lower: target(input.tickLower), upper: target(input.tickUpper) }
}

/**
 * Current claimable fees per position. Falls back to the stored tokenFeesOwed
 * values whenever the tick array read fails, so a transient RPC error cannot
 * blank out the dashboard.
 */
export async function computeRaydiumPositionFees(
  connection: Connection,
  bundle: RaydiumPoolBundle,
  positions: RaydiumWalletPosition[],
): Promise<Map<string, RaydiumPositionFees>> {
  const fees = new Map<string, RaydiumPositionFees>()
  for (const position of positions) {
    fees.set(position.nftMint, { feeA: position.feeOwedA, feeB: position.feeOwedB })
  }
  if (positions.length === 0) return fees

  try {
    const programId = bundle.poolInfo.programId
    const poolId = bundle.poolInfo.id
    const tickSpacing = bundle.poolInfo.config.tickSpacing
    const targets = positions.map(position => ({
      position,
      ticks: raydiumFeeTickTargets({
        programId,
        poolId,
        tickSpacing,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      }),
    }))

    const addresses = [...new Set(targets.flatMap(target => [target.ticks.lower.address, target.ticks.upper.address]))]
    const accountData = new Map<string, Buffer>()
    for (let index = 0; index < addresses.length; index += RPC_BATCH_SIZE) {
      const chunk = addresses.slice(index, index + RPC_BATCH_SIZE)
      const infos = await withRpcFallback(
        rpc => rpc.getMultipleAccountsInfo(chunk.map(address => new PublicKey(address)), 'confirmed'),
        connection,
      )
      infos.forEach((info, offset) => {
        if (info) accountData.set(chunk[offset], info.data)
      })
    }

    const decodedArrays = new Map<string, ReturnType<typeof TickArrayLayout.decode>>()
    const decodedTick = (target: RaydiumFeeTickTarget) => {
      const data = accountData.get(target.address)
      if (!data) return null
      let decoded = decodedArrays.get(target.address)
      if (!decoded) {
        decoded = TickArrayLayout.decode(data)
        decodedArrays.set(target.address, decoded)
      }
      return decoded.ticks[target.offset] ?? null
    }

    const poolState = {
      tickCurrent: bundle.rpcPoolInfo.tickCurrent,
      feeGrowthGlobalX64A: bundle.rpcPoolInfo.feeGrowthGlobalX64A,
      feeGrowthGlobalX64B: bundle.rpcPoolInfo.feeGrowthGlobalX64B,
    }
    for (const { position, ticks } of targets) {
      const lowerTick = decodedTick(ticks.lower)
      const upperTick = decodedTick(ticks.upper)
      if (!lowerTick || !upperTick) continue
      const result = PositionUtils.GetPositionFees(
        poolState,
        {
          liquidity: new BN(position.liquidity.toString()),
          feeGrowthInsideLastX64A: new BN(position.feeGrowthInsideLastA.toString()),
          feeGrowthInsideLastX64B: new BN(position.feeGrowthInsideLastB.toString()),
          tokenFeesOwedA: new BN(position.feeOwedA.toString()),
          tokenFeesOwedB: new BN(position.feeOwedB.toString()),
        },
        lowerTick,
        upperTick,
      )
      fees.set(position.nftMint, {
        feeA: BigInt(result.tokenFeeAmountA.toString()),
        feeB: BigInt(result.tokenFeeAmountB.toString()),
      })
    }
  } catch (err) {
    console.log(`[raydium] fee refresh failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }
  return fees
}
