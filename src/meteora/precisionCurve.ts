import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { StrategyType } from '@meteora-ag/dlmm'
import { getPool, clearPoolCache } from './positions.js'

const BASIS_POINTS = new BN(10000)
const ACTIVE_SIDE_BUFFER_BINS = 2
const REMOVE_DELAY_MS = 1500
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_FEE_BUFFER_LAMPORTS = BigInt(0.001 * 1e9)
const SLIPPAGE_LEVELS = [100, 300, 500]
const MAX_BINS_PER_REMOVE = 100
const DYNAMIC_RANGE_MULTIPLIER = 2
const DYNAMIC_RANGE_MIN = 50
const DYNAMIC_RANGE_MAX = 500
const MOVEMENT_LOG_MAX = 5
export const THRESHOLD_RATIO = 0.1
export const THRESHOLD_MIN = 3
export const RECOVERY_MS = 10000

function chunkRange(from: number, to: number, max: number): Array<{from: number, to: number}> {
  const chunks = []
  let start = from
  while (start <= to) {
    const end = Math.min(start + max - 1, to)
    chunks.push({ from: start, to: end })
    start = end + 1
  }
  return chunks
}

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
  addLowerBinId: number | null
  addUpperBinId: number | null
  effectiveRangeHalf: number
  isInitial: boolean
  xWithdrawn: string
  yWithdrawn: string
  xDeposited: string
  yDeposited: string
  xLeftover: string
  yLeftover: string
  noop: boolean
  error?: string
}

export interface PrecisionCurveRecoveryInput {
  enabled: boolean
  pendingX: string | null
  pendingY: string | null
  pendingPreBalances: string | null
}

export interface PrecisionCurveCallbacks {
  onPendingStart?: (preBalancesJson: string) => void
  onPendingAmounts?: (pendingX: string, pendingY: string) => void
}

interface BalanceSnapshot {
  nativeSol: bigint
  tokenX: bigint
  tokenY: bigint
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
    addLowerBinId: null,
    addUpperBinId: null,
    effectiveRangeHalf: 0,
    isInitial: false,
    xWithdrawn: '0',
    yWithdrawn: '0',
    xDeposited: '0',
    yDeposited: '0',
    xLeftover: '0',
    yLeftover: '0',
    noop: false,
  }
}

function isSolMint(mint: string): boolean {
  return mint === SOL_MINT
}

async function getTokenBalance(connection: Connection, wallet: Keypair, mint: string): Promise<bigint> {
  if (isSolMint(mint)) {
    try {
      const accounts = await connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: new PublicKey(SOL_MINT) }
      )
      let total = 0n
      for (const acc of accounts.value) {
        const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
        total += view.getBigUint64(0, true)
      }
      return total
    } catch { return 0n }
  }
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

async function getNativeSolLamports(connection: Connection, wallet: Keypair): Promise<bigint> {
  try {
    return BigInt(await connection.getBalance(wallet.publicKey))
  } catch { return 0n }
}

async function captureBalances(connection: Connection, wallet: Keypair, tokenXMint: string, tokenYMint: string) {
  const nativeSol = await getNativeSolLamports(connection, wallet)
  const tokenX = await getTokenBalance(connection, wallet, tokenXMint)
  const tokenY = await getTokenBalance(connection, wallet, tokenYMint)
  return { nativeSol, tokenX, tokenY }
}

function serializeBalances(balances: BalanceSnapshot): string {
  return JSON.stringify({
    nativeSol: balances.nativeSol.toString(),
    tokenX: balances.tokenX.toString(),
    tokenY: balances.tokenY.toString(),
  })
}

function parseBalances(json: string | null): BalanceSnapshot | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    return {
      nativeSol: BigInt(parsed.nativeSol || '0'),
      tokenX: BigInt(parsed.tokenX || '0'),
      tokenY: BigInt(parsed.tokenY || '0'),
    }
  } catch {
    return null
  }
}

function parsePendingAmount(value: string | null): bigint {
  if (!value) return 0n
  try { return BigInt(value) } catch { return 0n }
}

function computeWithdrawnDeltas(
  preBal: BalanceSnapshot,
  postBal: BalanceSnapshot,
  tokenXMint: string,
  tokenYMint: string,
): { deltaX: bigint; deltaY: bigint } {
  let deltaX = postBal.tokenX > preBal.tokenX ? postBal.tokenX - preBal.tokenX : 0n
  let deltaY: bigint
  if (isSolMint(tokenYMint)) {
    const nativeSolDelta = postBal.nativeSol > preBal.nativeSol ? postBal.nativeSol - preBal.nativeSol : 0n
    const wsolDelta = postBal.tokenY > preBal.tokenY ? postBal.tokenY - preBal.tokenY : 0n
    const totalSolDelta = nativeSolDelta + wsolDelta
    deltaY = totalSolDelta > SOL_FEE_BUFFER_LAMPORTS ? totalSolDelta - SOL_FEE_BUFFER_LAMPORTS : 0n
    console.log(`[precision] SOL delta: native=${nativeSolDelta} wsol=${wsolDelta} total=${totalSolDelta} addY=${deltaY}`)
  } else {
    deltaY = postBal.tokenY > preBal.tokenY ? postBal.tokenY - preBal.tokenY : 0n
  }

  if (isSolMint(tokenXMint)) {
    const nativeSolDelta = postBal.nativeSol > preBal.nativeSol ? postBal.nativeSol - preBal.nativeSol : 0n
    const wsolDelta = postBal.tokenX > preBal.tokenX ? postBal.tokenX - preBal.tokenX : 0n
    const totalSolDelta = nativeSolDelta + wsolDelta
    deltaX = totalSolDelta > SOL_FEE_BUFFER_LAMPORTS ? totalSolDelta - SOL_FEE_BUFFER_LAMPORTS : 0n
    console.log(`[precision] SOL delta (X): native=${nativeSolDelta} wsol=${wsolDelta} total=${totalSolDelta} addX=${deltaX}`)
  }

  return { deltaX, deltaY }
}

function spendableForMint(balances: BalanceSnapshot, mint: string, side: 'x' | 'y'): bigint {
  const tokenBalance = side === 'x' ? balances.tokenX : balances.tokenY
  if (!isSolMint(mint)) return tokenBalance
  const totalSol = balances.nativeSol + tokenBalance
  return totalSol > SOL_FEE_BUFFER_LAMPORTS ? totalSol - SOL_FEE_BUFFER_LAMPORTS : 0n
}

export async function executeDirectionalPrecisionCurve(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenXMint: string,
  tokenYMint: string,
  lastActiveBin: number | null,
  rangeHalf: number,
  movements: number[],
  recovery?: PrecisionCurveRecoveryInput,
  callbacks?: PrecisionCurveCallbacks,
): Promise<PrecisionCurveResult> {
  const result = emptyResult()
  const recoveryMode = recovery?.enabled === true
  try {
    clearPoolCache()
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
    if (!recoveryMode && amountX.isZero() && amountY.isZero()) throw new Error('position has no active liquidity')

    const isInitial = !recoveryMode && lastActiveBin === null
    result.isInitial = isInitial

    result.xWithdrawn = amountX.toString()
    result.yWithdrawn = amountY.toString()

    let deltaX = 0n
    let deltaY = 0n

    if (recoveryMode) {
      result.removeSucceeded = true
      deltaX = parsePendingAmount(recovery?.pendingX ?? null)
      deltaY = parsePendingAmount(recovery?.pendingY ?? null)
      const currentBal = await captureBalances(connection, wallet, tokenXMint, tokenYMint)
      if (deltaX === 0n && deltaY === 0n) {
        const preBal = parseBalances(recovery?.pendingPreBalances ?? null)
        if (preBal) {
          console.log(`[precision] recovery balances: nativeSol=${currentBal.nativeSol} tokenX=${currentBal.tokenX} tokenY=${currentBal.tokenY}`)
          const deltas = computeWithdrawnDeltas(preBal, currentBal, tokenXMint, tokenYMint)
          deltaX = deltas.deltaX
          deltaY = deltas.deltaY
          callbacks?.onPendingAmounts?.(deltaX.toString(), deltaY.toString())
        }
      }
      const spendableX = spendableForMint(currentBal, tokenXMint, 'x')
      const spendableY = spendableForMint(currentBal, tokenYMint, 'y')
      if (deltaX > spendableX) deltaX = spendableX
      if (deltaY > spendableY) deltaY = spendableY
      callbacks?.onPendingAmounts?.(deltaX.toString(), deltaY.toString())
      console.log(`[precision] recovery add amounts: deltaX=${deltaX} deltaY=${deltaY}`)
    } else {
      let staleFrom: number
      let staleTo: number
      let direction: number

      if (isInitial) {
        staleFrom = lowerBinId
        staleTo = upperBinId
        direction = 0
      } else {
        direction = activeBinId - lastActiveBin!
        if (direction > 0) {
          staleFrom = lowerBinId
          staleTo = Math.min(upperBinId, activeBinId - ACTIVE_SIDE_BUFFER_BINS - 1)
        } else if (direction < 0) {
          staleFrom = Math.max(lowerBinId, activeBinId + ACTIVE_SIDE_BUFFER_BINS + 1)
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

      console.log(`[precision] pre-remove: activeBin=${activeBinId} staleRange=${staleFrom}-${staleTo} direction=${direction}`)
      const preBal = await captureBalances(connection, wallet, tokenXMint, tokenYMint)
      callbacks?.onPendingStart?.(serializeBalances(preBal))
      console.log(`[precision] pre-balances: nativeSol=${preBal.nativeSol} tokenX=${preBal.tokenX} tokenY=${preBal.tokenY}`)

      const staleBins = staleTo - staleFrom + 1
      const chunks = staleBins > MAX_BINS_PER_REMOVE
        ? chunkRange(staleFrom, staleTo, MAX_BINS_PER_REMOVE)
        : [{ from: staleFrom, to: staleTo }]

      if (chunks.length > 1) {
        console.log(`[precision] ${staleBins} stale bins — split into ${chunks.length} chunks of max ${MAX_BINS_PER_REMOVE}`)
      }

      for (const [i, chunk] of chunks.entries()) {
        const removeTxs = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: new PublicKey(positionPubkey),
          fromBinId: chunk.from,
          toBinId: chunk.to,
          bps: new BN(10000) as any,
          shouldClaimAndClose: false,
        })

        const txs = Array.isArray(removeTxs) ? removeTxs : [removeTxs]
        for (const tx of txs) {
          tx.sign(wallet)
          const sig = await connection.sendTransaction(tx, [wallet])
          await connection.confirmTransaction(sig, 'confirmed')
          result.removeSignature = sig
          console.log(`[precision] remove liq tx chunk ${i + 1}/${chunks.length} (${chunk.from}-${chunk.to}): ${sig}`)
        }

        if (i < chunks.length - 1) {
          await new Promise<void>(resolve => { setTimeout(resolve, REMOVE_DELAY_MS) })
        }
      }

      result.removeSucceeded = true

      await new Promise<void>(resolve => { setTimeout(resolve, REMOVE_DELAY_MS) })

      const postBal = await captureBalances(connection, wallet, tokenXMint, tokenYMint)
      console.log(`[precision] post-balances: nativeSol=${postBal.nativeSol} tokenX=${postBal.tokenX} tokenY=${postBal.tokenY}`)
      const deltas = computeWithdrawnDeltas(preBal, postBal, tokenXMint, tokenYMint)
      deltaX = deltas.deltaX
      deltaY = deltas.deltaY
      callbacks?.onPendingAmounts?.(deltaX.toString(), deltaY.toString())
    }

    result.xDeposited = deltaX.toString()
    result.yDeposited = deltaY.toString()
    console.log(`[precision] add amounts: deltaX=${deltaX} deltaY=${deltaY}`)

    if (deltaX === 0n && deltaY === 0n) {
      const staleLabel = result.staleFrom !== null && result.staleTo !== null
        ? `${result.staleFrom}-${result.staleTo}`
        : 'pending re-add'
      console.log(`[precision] no-op: ${staleLabel} has no liquidity to add — updating baseline to ${activeBinId}`)
      result.activeBinId = activeBinId
      result.success = true
      result.noop = true
      return result
    }

    clearPoolCache()
    const freshPool = await getPool(connection, new PublicKey(poolPubkey))
    const freshActiveBin = freshPool.lbPair.activeId
    result.activeBinId = freshActiveBin
    console.log(`[precision] refetch activeBin=${freshActiveBin} (was ${activeBinId})`)

    const effectiveRangeHalf = movements.length > 0
      ? Math.round(Math.max(rangeHalf, (movements.reduce((a, b) => a + b, 0) / movements.length) * DYNAMIC_RANGE_MULTIPLIER))
      : rangeHalf

    result.effectiveRangeHalf = effectiveRangeHalf
    result.addLowerBinId = Math.max(lowerBinId, freshActiveBin - effectiveRangeHalf)
    result.addUpperBinId = Math.min(upperBinId, freshActiveBin + effectiveRangeHalf)
    console.log(`[precision] concentrated range: ${result.addLowerBinId}-${result.addUpperBinId} (half=${effectiveRangeHalf}, movements=[${movements.join(',')}])`)

    let addSig: string | null = null

    for (const slippage of SLIPPAGE_LEVELS) {
      try {
        const addTx = await freshPool.addLiquidityByStrategy({
          positionPubKey: new PublicKey(positionPubkey),
          user: wallet.publicKey,
          totalXAmount: new BN(deltaX.toString()),
          totalYAmount: new BN(deltaY.toString()),
          strategy: {
            maxBinId: result.addUpperBinId!,
            minBinId: result.addLowerBinId!,
            strategyType: StrategyType.Curve,
          },
          slippage,
        })

        addTx.sign(wallet)
        addSig = await connection.sendTransaction(addTx, [wallet])
        await connection.confirmTransaction(addSig, 'confirmed')

        const txResult = await connection.getTransaction(addSig, { maxSupportedTransactionVersion: 0 })
        if (!txResult || txResult.meta?.err) {
          const errMsg = txResult?.meta?.err
            ? (typeof txResult.meta.err === 'string' ? txResult.meta.err : JSON.stringify(txResult.meta.err))
            : 'no transaction result'
          console.log(`[precision] add liq tx failed on-chain (slippage=${slippage}): ${errMsg}`)
          throw new Error(`add liquidity failed on-chain: ${errMsg}`)
        }

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

    const finalBal = await captureBalances(connection, wallet, tokenXMint, tokenYMint)
    result.xLeftover = finalBal.tokenX.toString()
    result.yLeftover = isSolMint(tokenYMint) ? finalBal.nativeSol.toString() : finalBal.tokenY.toString()

    result.success = true
    return result
  } catch (err) {
    if (result.removeSucceeded) result.addFailed = true
    result.error = err instanceof Error ? err.message : 'unknown error'
    return result
  }
}
