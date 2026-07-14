import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { StrategyType } from '@meteora-ag/dlmm'
import { clearPoolCache, getPool } from './positions.js'
import { getSolPriceInUsd } from '../pricing.js'
import type { PositionRow, TokenSide } from '../types.js'

const BASIS_POINTS = new BN(10000)
const DUST_USD_THRESHOLD = 0.1
const REMOVE_DELAY_MS = 1500
const MAX_BINS_PER_REMOVE = 69
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SLIPPAGE_LEVELS = [5]
const MAX_BINS_SINGLE_TX = 69
const PROTECTED_BIN_DISTANCE = 1

function isQuoteMint(mint: string): boolean {
  return mint === SOL_MINT || mint === USDC_MINT
}

interface Range {
  from: number
  to: number
}

export interface FlipModeResult {
  success: boolean
  noop: boolean
  removeSucceeded: boolean
  addSucceeded: boolean
  pendingAdd: boolean
  tokenSide: TokenSide | null
  tokenMint: string | null
  tokenAmount: string
  activeBinId: number | null
  lowerBinId: number | null
  upperBinId: number | null
  progressPct: number | null
  removeRanges: Range[]
  removeSignatures: string[]
  addSignatures: string[]
  addSignature: string | null
  addLowerBinId: number | null
  addUpperBinId: number | null
  addSlippage: number | null
  error?: string
}

export interface FlipAddBackResult {
  success: boolean
  dustComplete?: boolean
  tokenAmountAttempted: string
  tokenAmountRemaining: string
  activeBinId: number | null
  lowerBinId: number | null
  upperBinId: number | null
  addSignature: string | null
  addSignatures: string[]
  addSlippage: number | null
  error?: string
}

function emptyResult(): FlipModeResult {
  return {
    success: false,
    noop: false,
    removeSucceeded: false,
    addSucceeded: false,
    pendingAdd: false,
    tokenSide: null,
    tokenMint: null,
    tokenAmount: '0',
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    progressPct: null,
    removeRanges: [],
    removeSignatures: [],
    addSignatures: [],
    addSignature: null,
    addLowerBinId: null,
    addUpperBinId: null,
    addSlippage: null,
  }
}

export function calculateFlipProgressPct(lowerBinId: number, upperBinId: number, activeBinId: number): number | null {
  const width = upperBinId - lowerBinId
  if (width <= 0) return null
  return ((upperBinId - activeBinId) / width) * 100
}

function getQuoteSide(tokenXMint: string, tokenYMint: string): TokenSide | null {
  if (isQuoteMint(tokenXMint)) return 'X'
  if (isQuoteMint(tokenYMint)) return 'Y'
  return null
}

function oppositeSide(side: TokenSide): TokenSide {
  return side === 'X' ? 'Y' : 'X'
}

function sideMint(side: TokenSide, tokenXMint: string, tokenYMint: string): string {
  return side === 'X' ? tokenXMint : tokenYMint
}

function parseAmount(value: string | number | BN | undefined | null): BN {
  if (value instanceof BN) return value
  if (value === undefined || value === null || value === '') return new BN(0)
  return new BN(String(value))
}

function getBinSideAmount(bin: any, side: TokenSide): BN {
  return parseAmount(side === 'X' ? bin.positionXAmount : bin.positionYAmount)
}

function buildContiguousRanges(binIds: number[]): Range[] {
  const sorted = [...new Set(binIds)].sort((a, b) => a - b)
  if (sorted.length === 0) return []
  const ranges: Range[] = []
  let start = sorted[0]
  let prev = sorted[0]
  for (const id of sorted.slice(1)) {
    if (id === prev + 1) {
      prev = id
      continue
    }
    ranges.push({ from: start, to: prev })
    start = id
    prev = id
  }
  ranges.push({ from: start, to: prev })
  return ranges
}

function chunkRanges(ranges: Range[]): Range[] {
  const chunks: Range[] = []
  for (const range of ranges) {
    let start = range.from
    while (start <= range.to) {
      const end = Math.min(start + MAX_BINS_PER_REMOVE - 1, range.to)
      chunks.push({ from: start, to: end })
      start = end + 1
    }
  }
  return chunks
}

function formatRanges(ranges: Range[]): string {
  return ranges.map(r => r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`).join(',')
}

function findTokenOnlyRanges(positionBinData: any[], quoteSide: TokenSide, tokenSide: TokenSide, activeBinId: number): Range[] {
  const tokenOnlyBinIds: number[] = []
  for (const bin of positionBinData || []) {
    const tokenAmount = getBinSideAmount(bin, tokenSide)
    const quoteAmount = getBinSideAmount(bin, quoteSide)
    if (tokenAmount.gt(new BN(0)) && quoteAmount.isZero()) {
      const binId = Number(bin.binId)
      if (Math.abs(binId - activeBinId) <= PROTECTED_BIN_DISTANCE) continue
      tokenOnlyBinIds.push(binId)
    }
  }
  return buildContiguousRanges(tokenOnlyBinIds)
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
  } catch {
    return 0n
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function sendAndConfirm(connection: Connection, wallet: Keypair, tx: any): Promise<string> {
  tx.sign(wallet)
  const sig = await connection.sendTransaction(tx, [wallet])
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

async function getTokenAmountUsd(
  pool: any,
  tokenSide: TokenSide,
  amount: bigint,
  poolPubkey: string,
): Promise<number> {
  try {
    const activeBin = pool.lbPair.activeId
    const binStep = pool.lbPair.binStep
    const pricePerLamport = Math.pow(1 + binStep / 10000, activeBin)

    const quoteSide = tokenSide === 'X' ? 'Y' : 'X'
    const quoteMint = quoteSide === 'Y'
      ? pool.lbPair.tokenYMint.toBase58()
      : pool.lbPair.tokenXMint.toBase58()

    const valueInQuoteLamports = tokenSide === 'X'
      ? Number(amount) * pricePerLamport
      : Number(amount) / pricePerLamport

    if (quoteMint === USDC_MINT) {
      return valueInQuoteLamports / 1_000_000
    }

    if (quoteMint === SOL_MINT) {
      const solPrice = await getSolPriceInUsd()
      return valueInQuoteLamports / 1_000_000_000 * solPrice
    }

    return Infinity
  } catch {
    return Infinity
  }
}

async function addBackBidAsk(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenSide: TokenSide,
  tokenMint: string,
  amount: bigint,
  removedBinCount?: number,
): Promise<FlipAddBackResult> {
  const result: FlipAddBackResult = {
    success: false,
    tokenAmountAttempted: amount.toString(),
    tokenAmountRemaining: amount.toString(),
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    addSignature: null,
    addSignatures: [],
    addSlippage: null,
  }

  if (amount <= 0n) {
    result.error = 'no token balance available for add-back'
    return result
  }

  try {
    clearPoolCache()
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const position = await pool.getPosition(new PublicKey(positionPubkey))
    if (!position) throw new Error('Position not found')

    const lowerBinId = position.positionData.lowerBinId
    const upperBinId = position.positionData.upperBinId
    const activeBinId = pool.lbPair.activeId
    result.lowerBinId = lowerBinId
    result.upperBinId = upperBinId
    result.activeBinId = activeBinId

    const binCount = upperBinId - lowerBinId + 1
    const addBinCount = removedBinCount ?? binCount

    const usdValue = await getTokenAmountUsd(pool, tokenSide, amount, poolPubkey)
    if (usdValue < DUST_USD_THRESHOLD) {
      console.log(`[flip] add-back dust balance ($${usdValue.toFixed(6)} < $${DUST_USD_THRESHOLD}) — clearing pending`)
      result.success = true
      result.dustComplete = true
      result.tokenAmountRemaining = '0'
      result.activeBinId = pool.lbPair.activeId
      result.lowerBinId = lowerBinId
      result.upperBinId = upperBinId
      return result
    }

    if (addBinCount <= MAX_BINS_SINGLE_TX) {
      // Single-tx: addLiquidityByStrategy on full position range
      let lastError = 'unknown error'
      for (const slippage of SLIPPAGE_LEVELS) {
        const preBalance = await getTokenBalance(connection, wallet, tokenMint)
        try {
          const addTx = await pool.addLiquidityByStrategy({
            positionPubKey: new PublicKey(positionPubkey),
            user: wallet.publicKey,
            totalXAmount: tokenSide === 'X' ? new BN(amount.toString()) : new BN(0),
            totalYAmount: tokenSide === 'Y' ? new BN(amount.toString()) : new BN(0),
            strategy: {
              minBinId: lowerBinId,
              maxBinId: upperBinId,
              strategyType: StrategyType.BidAsk,
              singleSidedX: tokenSide === 'X',
            },
            slippage,
          })

          const sig = await sendAndConfirm(connection, wallet, addTx)
          const txResult = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null)
          if (txResult?.meta?.err) {
            const errMsg = typeof txResult.meta.err === 'string' ? txResult.meta.err : JSON.stringify(txResult.meta.err)
            throw new Error(`add liquidity failed on-chain: ${errMsg}`)
          }

          result.addSignature = sig
          result.addSignatures = [sig]
          result.success = true
          result.tokenAmountRemaining = '0'
          result.addSlippage = slippage
          result.lowerBinId = lowerBinId
          result.upperBinId = upperBinId
          console.log(`[flip] add-back tx (slippage=${slippage}, bins=${lowerBinId}-${upperBinId}): ${sig}`)
          return result
        } catch (err) {
          lastError = err instanceof Error ? err.message : 'unknown error'
          const postBalance = await getTokenBalance(connection, wallet, tokenMint)
          const spent = preBalance > postBalance ? preBalance - postBalance : 0n
          if (spent > 0n) {
            const remaining = spent >= amount ? 0n : amount - spent
            result.tokenAmountRemaining = remaining.toString()
            result.success = remaining === 0n
            result.addSlippage = slippage
            result.error = result.success
              ? undefined
              : `partial add-back succeeded, remaining=${remaining.toString()}; last error: ${lastError}`
            result.lowerBinId = lowerBinId
            result.upperBinId = upperBinId
            console.log(`[flip] partial add-back: spent=${spent} remaining=${remaining} lastError=${lastError}`)
            return result
          }
          console.log(`[flip] add-back failed before spending tokens (slippage=${slippage}): ${lastError}`)
          await sleep(800)
        }
      }
      result.error = lastError
      result.lowerBinId = lowerBinId
      result.upperBinId = upperBinId
      return result
    }

    // addBinCount > MAX_BINS_SINGLE_TX: chunked via addLiquidityByStrategyChunkable
    console.log(`[flip] add-back chunked: ${addBinCount} bins (full range ${lowerBinId}-${upperBinId})`)

    let totalSpent = 0n
    let lastError = 'unknown error'

    for (const slippage of SLIPPAGE_LEVELS) {
      const preBalance = await getTokenBalance(connection, wallet, tokenMint)
      try {
        const addTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: new PublicKey(positionPubkey),
          user: wallet.publicKey,
          totalXAmount: tokenSide === 'X' ? new BN(amount.toString()) : new BN(0),
          totalYAmount: tokenSide === 'Y' ? new BN(amount.toString()) : new BN(0),
          strategy: {
            minBinId: lowerBinId,
            maxBinId: upperBinId,
            strategyType: StrategyType.BidAsk,
            singleSidedX: tokenSide === 'X',
          },
          slippage,
        })

        console.log(`[flip] add-back split into ${addTxs.length} txns (slippage=${slippage})`)

        for (const [j, tx] of addTxs.entries()) {
          const sig = await sendAndConfirm(connection, wallet, tx)
          const txResult = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null)
          if (txResult?.meta?.err) {
            const errMsg = typeof txResult.meta.err === 'string' ? txResult.meta.err : JSON.stringify(txResult.meta.err)
            throw new Error(`add liquidity failed on-chain: ${errMsg}`)
          }
          result.addSignature = sig
          result.addSignatures.push(sig)
          console.log(`[flip] add-back chunk ${j + 1}/${addTxs.length} (slippage=${slippage}): ${sig}`)
          if (j < addTxs.length - 1) await sleep(REMOVE_DELAY_MS)
        }

        totalSpent = amount
        result.addSlippage = slippage
        break
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'unknown error'
        const postBalance = await getTokenBalance(connection, wallet, tokenMint)
        const spent = preBalance > postBalance ? preBalance - postBalance : 0n
        if (spent > 0n) {
          totalSpent = spent
          result.addSlippage = slippage
          console.log(`[flip] partial add-back: spent=${spent} error=${lastError}`)
          break
        }
        console.log(`[flip] add-back failed before spending tokens (slippage=${slippage}): ${lastError}`)
        await sleep(800)
      }
    }

    const remaining = amount > totalSpent ? amount - totalSpent : 0n
    result.tokenAmountRemaining = remaining.toString()
    result.success = remaining === 0n
    result.lowerBinId = lowerBinId
    result.upperBinId = upperBinId
    result.error = remaining === 0n
      ? undefined
      : totalSpent > 0n
        ? `partial add-back succeeded, remaining=${remaining.toString()}; last error: ${lastError}`
        : lastError
    console.log(`[flip] add-back result: success=${result.success} spent=${totalSpent} remaining=${remaining}`)
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'unknown error'
    return result
  }
}

export async function retryPendingFlipAdd(
  connection: Connection,
  wallet: Keypair,
  pos: PositionRow,
): Promise<FlipAddBackResult> {
  const tokenSide = pos.flipModePendingTokenSide
  const tokenMint = pos.flipModePendingTokenMint
  const pendingAmount = BigInt(pos.flipModePendingTokenAmount || '0')
  const result: FlipAddBackResult = {
    success: false,
    tokenAmountAttempted: '0',
    tokenAmountRemaining: pendingAmount.toString(),
    activeBinId: null,
    lowerBinId: null,
    upperBinId: null,
    addSignature: null,
    addSignatures: [],
    addSlippage: null,
  }

  if (!tokenSide || !tokenMint || pendingAmount <= 0n) {
    result.error = 'missing pending add token data'
    return result
  }

  const walletBalance = await getTokenBalance(connection, wallet, tokenMint)
  const amountToAdd = walletBalance < pendingAmount ? walletBalance : pendingAmount
  result.tokenAmountAttempted = amountToAdd.toString()

  if (amountToAdd <= 0n) {
    result.error = `pending add token balance is 0 for ${tokenMint}`
    return result
  }

  const addResult = await addBackBidAsk(
    connection,
    wallet,
    pos.positionPubkey,
    pos.poolPubkey,
    tokenSide,
    tokenMint,
    amountToAdd,
  )

  const addRemaining = BigInt(addResult.tokenAmountRemaining || amountToAdd.toString())
  const spent = amountToAdd > addRemaining ? amountToAdd - addRemaining : 0n
  const totalRemaining = addResult.success
    ? (addResult.dustComplete ? 0n : pendingAmount - amountToAdd)
    : pendingAmount - spent

  return {
    ...addResult,
    tokenAmountAttempted: amountToAdd.toString(),
    tokenAmountRemaining: totalRemaining > 0n ? totalRemaining.toString() : '0',
  }
}

export async function executeFlipMode(
  connection: Connection,
  wallet: Keypair,
  pos: PositionRow,
  progressPct: number,
): Promise<FlipModeResult> {
  const result = emptyResult()
  result.progressPct = progressPct

  const quoteSide = getQuoteSide(pos.tokenXMint, pos.tokenYMint)
  if (!quoteSide) {
    result.error = 'position is not SOL or USDC quoted'
    return result
  }

  const tokenSide = oppositeSide(quoteSide)
  const tokenMint = sideMint(tokenSide, pos.tokenXMint, pos.tokenYMint)
  result.tokenSide = tokenSide
  result.tokenMint = tokenMint

  try {
    clearPoolCache()
    const pool = await getPool(connection, new PublicKey(pos.poolPubkey))
    const position = await pool.getPosition(new PublicKey(pos.positionPubkey))
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

    const tokenOnlyRanges = findTokenOnlyRanges(pd.positionBinData, quoteSide, tokenSide, activeBinId)
    result.removeRanges = tokenOnlyRanges
    if (tokenOnlyRanges.length === 0) {
      result.success = true
      result.noop = true
      console.log(`[flip] no-op: no ${tokenSide} token-only bins at progress=${progressPct.toFixed(2)}%`)
      return result
    }

    const removedBinCount = tokenOnlyRanges.reduce((sum, r) => sum + (r.to - r.from + 1), 0)
    const removeRanges = removedBinCount <= MAX_BINS_PER_REMOVE
      ? tokenOnlyRanges
      : chunkRanges(tokenOnlyRanges)
    console.log(`[flip] remove token-only ranges: ${formatRanges(removeRanges)} tokenSide=${tokenSide} bins=${removedBinCount}`)
    const preBalance = await getTokenBalance(connection, wallet, tokenMint)

    let removeError: string | null = null
    for (const [i, range] of removeRanges.entries()) {
      try {
        const removeTxs = await pool.removeLiquidity({
          user: wallet.publicKey,
          position: new PublicKey(pos.positionPubkey),
          fromBinId: range.from,
          toBinId: range.to,
          bps: BASIS_POINTS as any,
          shouldClaimAndClose: false,
        })

        const txs = Array.isArray(removeTxs) ? removeTxs : [removeTxs]
        for (const tx of txs) {
          const sig = await sendAndConfirm(connection, wallet, tx)
          result.removeSignatures.push(sig)
          console.log(`[flip] remove token liq tx ${i + 1}/${removeRanges.length} (${range.from}-${range.to}): ${sig}`)
        }
      } catch (err) {
        removeError = err instanceof Error ? err.message : 'unknown error'
        console.log(`[flip] remove token liq failed (${range.from}-${range.to}): ${removeError}`)
        break
      }

      if (i < removeRanges.length - 1) await sleep(REMOVE_DELAY_MS)
    }

    await sleep(REMOVE_DELAY_MS)
    const postBalance = await getTokenBalance(connection, wallet, tokenMint)
    const delta = postBalance > preBalance ? postBalance - preBalance : 0n
    result.removeSucceeded = result.removeSignatures.length > 0
    result.tokenAmount = delta.toString()

    if (delta <= 0n) {
      result.error = removeError || 'remove completed but no token balance delta detected'
      result.success = removeError === null
      result.noop = removeError === null
      return result
    }

    const addResult = await addBackBidAsk(
      connection,
      wallet,
      pos.positionPubkey,
      pos.poolPubkey,
      tokenSide,
      tokenMint,
      delta,
      removedBinCount,
    )

    result.addSignature = addResult.addSignature
    result.addSignatures = addResult.addSignatures
    result.addLowerBinId = addResult.lowerBinId
    result.addUpperBinId = addResult.upperBinId
    result.addSlippage = addResult.addSlippage

    if (addResult.success) {
      result.success = removeError === null
      result.addSucceeded = true
      result.error = removeError || undefined
      return result
    }

    result.pendingAdd = true
    result.tokenAmount = addResult.tokenAmountRemaining
    result.error = addResult.error || removeError || 'add-back failed, pending retry'
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'unknown error'
    return result
  }
}
