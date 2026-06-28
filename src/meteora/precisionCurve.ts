import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { StrategyType, getLiquidityStrategyParameterBuilder, buildLiquidityStrategyParameters } from '@meteora-ag/dlmm'
import { getPool } from './positions.js'

const BASIS_POINTS = new BN(10000)
const LEFTOVER_TOLERANCE_BPS = new BN(1) // 0.01%
const DEFAULT_MAX_ACTIVE_BIN_SLIPPAGE = new BN(3)

export interface PrecisionCurveResult {
  success: boolean
  signature: string | null
  activeBinId: number | null
  lowerBinId: number | null
  upperBinId: number | null
  xWithdrawn: string
  yWithdrawn: string
  xDeposited: string
  yDeposited: string
  xLeftover: string
  yLeftover: string
  error?: string
}

function emptyResult(): PrecisionCurveResult {
  return {
    success: false,
    signature: null,
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    xWithdrawn: '0',
    yWithdrawn: '0',
    xDeposited: '0',
    yDeposited: '0',
    xLeftover: '0',
    yLeftover: '0',
  }
}

function withinTolerance(withdrawn: BN, deposited: BN): boolean {
  if (withdrawn.isZero()) return deposited.isZero()
  const diff = withdrawn.gt(deposited) ? withdrawn.sub(deposited) : deposited.sub(withdrawn)
  return diff.mul(BASIS_POINTS).lte(withdrawn.mul(LEFTOVER_TOLERANCE_BPS))
}

function nearZero(amount: BN, basis: BN): boolean {
  if (amount.isZero()) return true
  if (basis.isZero()) return amount.isZero()
  return amount.mul(BASIS_POINTS).lte(basis.mul(LEFTOVER_TOLERANCE_BPS))
}

async function sendInstructionTx(
  connection: Connection,
  wallet: Keypair,
  instructions: any[],
): Promise<string | null> {
  if (instructions.length === 0) return null
  const tx = new Transaction()
  tx.add(...instructions)
  tx.feePayer = wallet.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(wallet)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

export async function executePrecisionCurveRebalance(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
): Promise<PrecisionCurveResult> {
  const result = emptyResult()
  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const position = await pool.getPosition(new PublicKey(positionPubkey))
    if (!position) throw new Error('Position not found')

    const pd = position.positionData
    const lowerBinId = pd.lowerBinId
    const upperBinId = pd.upperBinId
    const activeBinId = pool.lbPair.activeId
    result.lowerBinId = lowerBinId
    result.upperBinId = upperBinId
    result.activeBinId = activeBinId

    if (activeBinId < lowerBinId || activeBinId > upperBinId) {
      throw new Error(`active bin ${activeBinId} outside range ${lowerBinId}-${upperBinId}`)
    }

    const amountX = new BN(pd.totalXAmount)
    const amountY = new BN(pd.totalYAmount)
    if (amountX.isZero() && amountY.isZero()) throw new Error('position has no active liquidity')

    const minDeltaId = new BN(lowerBinId - activeBinId)
    const maxDeltaId = new BN(upperBinId - activeBinId)
    const builder = getLiquidityStrategyParameterBuilder(StrategyType.Curve)
    const curveParams = buildLiquidityStrategyParameters(
      amountX,
      amountY,
      minDeltaId,
      maxDeltaId,
      new BN(pool.lbPair.binStep),
      false,
      new BN(activeBinId),
      builder,
    )

    const deposits = [{
      minDeltaId,
      maxDeltaId,
      x0: curveParams.x0,
      y0: curveParams.y0,
      deltaX: curveParams.deltaX,
      deltaY: curveParams.deltaY,
      favorXInActiveBin: false,
    }]
    const withdraws = [{
      minBinId: new BN(lowerBinId),
      maxBinId: new BN(upperBinId),
      bps: BASIS_POINTS,
    }]

    const simulation = await pool.simulateRebalancePosition(
      new PublicKey(positionPubkey),
      pd,
      false,
      false,
      deposits,
      withdraws,
    )

    const sim = simulation.simulationResult
    result.xWithdrawn = amountX.toString()
    result.yWithdrawn = amountY.toString()
    result.xDeposited = sim.amountXDeposited.toString()
    result.yDeposited = sim.amountYDeposited.toString()

    const xLeftover = sim.actualAmountXWithdrawn.add(sim.actualAmountXDeposited)
    const yLeftover = sim.actualAmountYWithdrawn.add(sim.actualAmountYDeposited)
    result.xLeftover = xLeftover.toString()
    result.yLeftover = yLeftover.toString()

    if (!withinTolerance(amountX, sim.amountXDeposited)) {
      throw new Error(`X gross deposit mismatch: withdraw=${result.xWithdrawn} deposit=${result.xDeposited}`)
    }
    if (!withinTolerance(amountY, sim.amountYDeposited)) {
      throw new Error(`Y gross deposit mismatch: withdraw=${result.yWithdrawn} deposit=${result.yDeposited}`)
    }
    if (!nearZero(xLeftover, amountX)) {
      throw new Error(`X net leftover/topup too high: ${xLeftover.toString()}`)
    }
    if (!nearZero(yLeftover, amountY)) {
      throw new Error(`Y net leftover/topup too high: ${yLeftover.toString()}`)
    }

    const built = await pool.rebalancePosition(simulation, DEFAULT_MAX_ACTIVE_BIN_SLIPPAGE, wallet.publicKey, 0.01)
    for (const ix of built.initBinArrayInstructions) {
      const sig = await sendInstructionTx(connection, wallet, [ix])
      if (sig) result.signature = sig
    }
    const sig = await sendInstructionTx(connection, wallet, built.rebalancePositionInstruction)
    if (sig) result.signature = sig
    result.success = true
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'unknown error'
    return result
  }
}
