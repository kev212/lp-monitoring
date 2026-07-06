import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { StrategyType } from '@meteora-ag/dlmm'
import { clearPoolCache, getPool } from './positions.js'
import type { PositionRow, TokenSide } from '../types.js'

const BASIS_POINTS = new BN(10000)
const REMOVE_DELAY_MS = 1500
const MAX_BINS_PER_REMOVE = 100
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SLIPPAGE_LEVELS = [5]

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

function findTokenOnlyRanges(positionBinData: any[], quoteSide: TokenSide, tokenSide: TokenSide): Range[] {
  const tokenOnlyBinIds: number[] = []
  for (const bin of positionBinData || []) {
    const tokenAmount = getBinSideAmount(bin, tokenSide)
    const quoteAmount = getBinSideAmount(bin, quoteSide)
    if (tokenAmount.gt(new BN(0)) && quoteAmount.isZero()) {
      tokenOnlyBinIds.push(Number(bin.binId))
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

async function addBackBidAsk(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenSide: TokenSide,
  tokenMint: string,
  amount: bigint,
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
    let lastError = 'unknown error'

    for (const slippage of SLIPPAGE_LEVELS) {
      const preBalance = await getTokenBalance(connection, wallet, tokenMint)
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

        const totalXAmount = tokenSide === 'X' ? new BN(amount.toString()) : new BN(0)
        const totalYAmount = tokenSide === 'Y' ? new BN(amount.toString()) : new BN(0)
        const addTxs = await pool.addLiquidityByStrategyChunkable({
          positionPubKey: new PublicKey(positionPubkey),
          user: wallet.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: {
            minBinId: lowerBinId,
            maxBinId: upperBinId,
            strategyType: StrategyType.BidAsk,
            singleSidedX: tokenSide === 'X',
          },
          slippage,
        })

        if (addTxs.length > 1) {
          console.log(`[flip] add-back split into ${addTxs.length} chunks (slippage=${slippage})`)
        }

        for (const [i, tx] of addTxs.entries()) {
          const sig = await sendAndConfirm(connection, wallet, tx)
          const txResult = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null)
          if (txResult?.meta?.err) {
            const errMsg = typeof txResult.meta.err === 'string' ? txResult.meta.err : JSON.stringify(txResult.meta.err)
            throw new Error(`add liquidity failed on-chain: ${errMsg}`)
          }

          result.addSignature = sig
          result.addSignatures.push(sig)
          console.log(`[flip] add-back tx chunk ${i + 1}/${addTxs.length} (slippage=${slippage}): ${sig}`)

          if (i < addTxs.length - 1) await sleep(REMOVE_DELAY_MS)
        }

        result.success = true
        result.tokenAmountRemaining = '0'
        result.addSlippage = slippage
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
          console.log(`[flip] partial add-back: spent=${spent} remaining=${remaining} lastError=${lastError}`)
          return result
        }

        console.log(`[flip] add-back failed before any chunk spent tokens (slippage=${slippage}): ${lastError}`)
        await sleep(800)
      }
    }

    result.error = lastError
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
    ? pendingAmount - amountToAdd
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

    const tokenOnlyRanges = findTokenOnlyRanges(pd.positionBinData, quoteSide, tokenSide)
    result.removeRanges = tokenOnlyRanges
    if (tokenOnlyRanges.length === 0) {
      result.success = true
      result.noop = true
      console.log(`[flip] no-op: no ${tokenSide} token-only bins at progress=${progressPct.toFixed(2)}%`)
      return result
    }

    const removeRanges = chunkRanges(tokenOnlyRanges)
    console.log(`[flip] remove token-only ranges: ${formatRanges(removeRanges)} tokenSide=${tokenSide}`)
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
