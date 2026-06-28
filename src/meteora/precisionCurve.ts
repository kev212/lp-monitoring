import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { StrategyType } from '@meteora-ag/dlmm'
import { getPool } from './positions.js'

const BASIS_POINTS = new BN(10000)
const STALE_BUFFER_BINS = 2
const REMOVE_DELAY_MS = 1500

export interface PrecisionCurveResult {
  success: boolean
  removeSucceeded: boolean
  addFailed: boolean
  removeSignature: string | null
  addSignature: string | null
  activeBinId: number | null
  lowerBinId: number | null
  upperBinId: number | null
  direction: number | null
  staleFrom: number | null
  staleTo: number | null
  isInitial: boolean
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
    removeSucceeded: false,
    addFailed: false,
    removeSignature: null,
    addSignature: null,
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    direction: null,
    staleFrom: null,
    staleTo: null,
    isInitial: false,
    xWithdrawn: '0',
    yWithdrawn: '0',
    xDeposited: '0',
    yDeposited: '0',
    xLeftover: '0',
    yLeftover: '0',
  }
}

async function getTokenBalance(connection: Connection, wallet: Keypair, mint: string): Promise<bigint> {
  try {
    const accounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(mint) }
    )
    let total = 0n
    for (const acc of accounts.value) {
      const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
      total += view.getBigUint64(0, true)
    }
    return total
  } catch { return 0n }
}

export async function executeDirectionalPrecisionCurve(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenXMint: string,
  tokenYMint: string,
  lastActiveBin: number | null,
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

    const isInitial = lastActiveBin === null
    result.isInitial = isInitial

    let staleFrom: number
    let staleTo: number
    let direction: number

    if (isInitial) {
      staleFrom = lowerBinId
      staleTo = upperBinId
      direction = 0
    } else {
      direction = activeBinId - lastActiveBin
      if (direction > 0) {
        staleFrom = lowerBinId
        staleTo = Math.min(upperBinId, activeBinId - STALE_BUFFER_BINS)
      } else if (direction < 0) {
        staleFrom = Math.max(lowerBinId, activeBinId + STALE_BUFFER_BINS)
        staleTo = upperBinId
      } else {
        staleFrom = lowerBinId
        staleTo = upperBinId
      }
    }

    result.direction = direction
    result.staleFrom = staleFrom
    result.staleTo = staleTo

    if (staleFrom > staleTo) {
      throw new Error(`invalid stale range: ${staleFrom}-${staleTo}`)
    }

    result.xWithdrawn = amountX.toString()
    result.yWithdrawn = amountY.toString()

    const removeTxs = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: new PublicKey(positionPubkey),
      fromBinId: staleFrom,
      toBinId: staleTo,
      bps: new BN(10000) as any,
      shouldClaimAndClose: false,
    })

    const txs = Array.isArray(removeTxs) ? removeTxs : [removeTxs]
    for (const tx of txs) {
      tx.sign(wallet)
      const sig = await connection.sendTransaction(tx, [wallet])
      await connection.confirmTransaction(sig, 'confirmed')
      result.removeSignature = sig
      console.log(`[precision] remove liq tx: ${sig}`)
    }
    result.removeSucceeded = true

    await new Promise<void>(resolve => { setTimeout(resolve, REMOVE_DELAY_MS) })

    const walletX = await getTokenBalance(connection, wallet, tokenXMint)
    const walletY = await getTokenBalance(connection, wallet, tokenYMint)

    if (walletX === 0n && walletY === 0n) {
      throw new Error('no tokens in wallet after remove — cannot re-add')
    }

    result.xDeposited = walletX.toString()
    result.yDeposited = walletY.toString()

    const freshPool = await getPool(connection, new PublicKey(poolPubkey))
    const freshActiveBin = freshPool.lbPair.activeId
    result.activeBinId = freshActiveBin
    console.log(`[precision] refetch activeBin=${freshActiveBin} (was ${activeBinId})`)

    const SLIPPAGE_LEVELS = [1, 3, 5]
    let addSig: string | null = null

    for (const slippage of SLIPPAGE_LEVELS) {
      try {
        const addTx = await freshPool.addLiquidityByStrategy({
          positionPubKey: new PublicKey(positionPubkey),
          user: wallet.publicKey,
          totalXAmount: new BN(walletX.toString()),
          totalYAmount: new BN(walletY.toString()),
          strategy: {
            maxBinId: upperBinId,
            minBinId: lowerBinId,
            strategyType: StrategyType.Curve,
          },
          slippage,
        })

        addTx.sign(wallet)
        addSig = await connection.sendTransaction(addTx, [wallet])
        await connection.confirmTransaction(addSig, 'confirmed')
        result.addSignature = addSig
        console.log(`[precision] add liq tx (slippage=${slippage}): ${addSig}`)
        break
      } catch (addErr) {
        const msg = addErr instanceof Error ? addErr.message : 'unknown'
        console.log(`[precision] add liq failed (slippage=${slippage}): ${msg}`)
        if (!msg.includes('ExceededBinSlippageTolerance')) {
          throw addErr
        }
        if (slippage === SLIPPAGE_LEVELS[SLIPPAGE_LEVELS.length - 1]) {
          result.addFailed = true
          result.error = `add liquidity failed after ${SLIPPAGE_LEVELS.length} attempts: ${msg}`
          return result
        }
        await new Promise<void>(resolve => { setTimeout(resolve, 800) })
      }
    }

    const finalX = await getTokenBalance(connection, wallet, tokenXMint)
    const finalY = await getTokenBalance(connection, wallet, tokenYMint)
    result.xLeftover = finalX.toString()
    result.yLeftover = finalY.toString()

    result.success = true
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'unknown error'
    return result
  }
}
