import { BN } from '@coral-xyz/anchor'
import DLMM, { getPriceOfBinByBinId, MAX_BINS_PER_POSITION, StrategyType } from '@meteora-ag/dlmm'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js'
import { config } from '../config.js'
import { getDb, listSyncValues } from '../db/client.js'
import { getWalletOperation, walletOperationKey, withWalletExecutionLock } from '../executionLock.js'
import type { QuoteCurrency } from '../types.js'
import { deleteOpeningPosition, updatePositionStatus, upsertPosition } from './discovery.js'
import { clearPnlCache, getQuoteCurrency } from './valuation.js'
import { clearPoolCache, getPool, getPoolInfo } from './positions.js'
import { getRiskSettings } from '../risk/settings.js'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const LAMPORTS_PER_SOL = 1_000_000_000
const OPEN_PENDING_PREFIX = 'open_pending:'
const OPEN_ATTEMPT_PREFIX = 'open_attempt:'
const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
const EXPIRED_ABSENCE_CHECKS = 2
const EXPIRED_ABSENCE_MIN_INTERVAL_MS = 5_000

export type OpenLiquidityStrategy = 'spot' | 'curve' | 'bidask'
export type OpenQuoteSide = 'X' | 'Y'

export interface OpenPoolInfo {
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  tokenXSymbol: string
  tokenYSymbol: string
  tokenXDecimals: number
  tokenYDecimals: number
  quoteCurrency: QuoteCurrency
  quoteSide: OpenQuoteSide
  quoteMint: string
  quoteSymbol: string
  quoteDecimals: number
  baseSymbol: string
}

export interface OpenPositionPreview extends OpenPoolInfo {
  amountInput: string
  amountQuote: number
  amountRaw: string
  rangePercent: number
  strategy: OpenLiquidityStrategy
  activeBinId: number
  minBinId: number
  maxBinId: number
  binCount: number
  currentPriceQuote: number
  targetPriceQuote: number
  estimatedPositionCostSol: number
  maxPriceMoveBins: number
  addSlippagePercent: number
  observedAt: number
}

export interface OpenPositionResult {
  signature: string
  positionPubkey: string
  preview: OpenPositionPreview
}

type PendingOpenStage = 'prepared' | 'submitted' | 'confirmed'
type TerminalOpenStage = 'finalized' | 'failed' | 'expired'

interface OpenAttemptState {
  version: 1
  positionPubkey: string
  owner: string
  poolPubkey: string
  quoteCurrency: QuoteCurrency
  amountRaw: string
  minBinId: number
  maxBinId: number
  strategy: OpenLiquidityStrategy
  signature: string
  signedTransaction: string
  blockhash: string
  lastValidBlockHeight: number
  stage: PendingOpenStage | TerminalOpenStage
  missingAfterExpiryChecks: number
  lastExpiryAbsenceAt: number | null
  createdAt: number
  updatedAt: number
  lastError: string | null
}

type PendingOpenState = OpenAttemptState & { stage: PendingOpenStage }
type TerminalOpenState = OpenAttemptState & { stage: TerminalOpenStage }

export interface OpenReconcileSummary {
  finalized: number
  failed: number
  pending: number
}

export class OpenSubmissionPendingError extends Error {
  constructor(
    readonly positionPubkey: string,
    readonly signature: string,
    cause: unknown,
    readonly transactionFinalized = false,
  ) {
    super(`open submission ${signature} requires reconciliation: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'OpenSubmissionPendingError'
  }
}

class DefinitiveOpenError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`confirm timeout (${timeoutMs / 1000}s)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface SingleSideRangeInput {
  activeBinId: number
  activePoolPrice: number
  quoteSide: OpenQuoteSide
  rangePercent: number
  getBinIdFromPrice: (price: number, min: boolean) => number
}

export function calculateSingleSideRange(input: SingleSideRangeInput): {
  minBinId: number
  maxBinId: number
  currentPriceQuote: number
  targetPriceQuote: number
} {
  const { activeBinId, activePoolPrice, quoteSide, rangePercent, getBinIdFromPrice } = input
  if (!Number.isFinite(activePoolPrice) || activePoolPrice <= 0) throw new Error('Pool active price is invalid')
  if (!Number.isFinite(rangePercent) || rangePercent <= 0 || rangePercent >= 100) {
    throw new Error('Range must be greater than 0% and less than 100%')
  }

  const remainingRatio = 1 - rangePercent / 100
  const currentPriceQuote = quoteSide === 'Y' ? activePoolPrice : 1 / activePoolPrice
  const targetPriceQuote = currentPriceQuote * remainingRatio

  if (quoteSide === 'Y') {
    const targetPoolPrice = activePoolPrice * remainingRatio
    return {
      minBinId: Math.min(getBinIdFromPrice(targetPoolPrice, true), activeBinId - 1),
      maxBinId: activeBinId - 1,
      currentPriceQuote,
      targetPriceQuote,
    }
  }

  const targetPoolPrice = activePoolPrice / remainingRatio
  return {
    minBinId: activeBinId + 1,
    maxBinId: Math.max(getBinIdFromPrice(targetPoolPrice, false), activeBinId + 1),
    currentPriceQuote,
    targetPriceQuote,
  }
}

export function parseUiAmountToRaw(input: string, decimals: number): bigint {
  const normalized = input.trim()
  if (normalized.includes(',') || normalized.includes('$') || /\s/.test(normalized)) {
    throw new Error('Use digits and a dot as the decimal separator, without spaces or commas')
  }
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error('Amount must be a positive number')
  const [whole, fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) throw new Error(`Amount supports at most ${decimals} decimal places`)
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (raw <= 0n) throw new Error('Amount must be greater than zero')
  return raw
}

export function formatRawAmount(raw: bigint, decimals: number): string {
  const padded = raw.toString().padStart(decimals + 1, '0')
  const whole = decimals === 0 ? padded : padded.slice(0, -decimals)
  const fraction = decimals === 0 ? '' : padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

export function strategyType(strategy: OpenLiquidityStrategy): StrategyType {
  if (strategy === 'curve') return StrategyType.Curve
  if (strategy === 'bidask') return StrategyType.BidAsk
  return StrategyType.Spot
}

export function sdkSlippagePercentForBins(binStep: number, bins: number): number {
  if (!Number.isFinite(binStep) || binStep <= 0) throw new Error('Pool bin step is invalid')
  if (!Number.isInteger(bins) || bins < 1) throw new Error('At least one price-movement bin must remain')
  // The SDK converts this percentage back to bins with ceil(percent / binStep%).
  return ((bins - 0.25) * binStep) / 100
}

export function remainingPriceMoveBins(maxBins: number, observedMoveBins: number): number {
  if (!Number.isInteger(maxBins) || maxBins < 1) throw new Error('Maximum price movement must be a positive integer')
  if (!Number.isInteger(observedMoveBins) || observedMoveBins < 0) throw new Error('Observed price movement is invalid')
  const remaining = maxBins - observedMoveBins
  if (remaining < 1) throw new Error('Pool price reached the movement limit; review the open position again')
  return remaining
}

async function rawAssociatedTokenBalance(connection: Connection, owner: PublicKey, mint: string): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner)
  const account = await connection.getAccountInfo(ata, 'confirmed')
  if (!account) return 0n
  if (account.data.byteLength < 72) throw new Error('Associated token account data is invalid')
  const view = new DataView(account.data.buffer, account.data.byteOffset + 64, 8)
  return view.getBigUint64(0, true)
}

async function loadOpenPool(connection: Connection, poolPubkey: string): Promise<{ pool: DLMM; poolInfo: OpenPoolInfo }> {
  let poolAddress: PublicKey
  try {
    poolAddress = new PublicKey(poolPubkey)
  } catch {
    throw new Error('Pool address is not a valid Solana public key')
  }

  clearPoolCache()
  const pool = await getPool(connection, poolAddress)
  const tokenXMint = pool.tokenX.publicKey.toBase58()
  const tokenYMint = pool.tokenY.publicKey.toBase58()
  const quoteCurrency = getQuoteCurrency(tokenXMint, tokenYMint)
  if (!quoteCurrency) throw new Error('Pool must contain SOL or USDC as quote token')

  const quoteMint = quoteCurrency === 'SOL' ? SOL_MINT : USDC_MINT
  const quoteSide: OpenQuoteSide = tokenXMint === quoteMint ? 'X' : 'Y'
  const poolInfo = await getPoolInfo(poolPubkey)
  const tokenXSymbol = poolInfo.tokenXSymbol || tokenXMint.slice(0, 4)
  const tokenYSymbol = poolInfo.tokenYSymbol || tokenYMint.slice(0, 4)
  const tokenXDecimals = pool.tokenX.mint.decimals
  const tokenYDecimals = pool.tokenY.mint.decimals

  return { pool, poolInfo: {
    poolPubkey,
    tokenXMint,
    tokenYMint,
    tokenXSymbol,
    tokenYSymbol,
    tokenXDecimals,
    tokenYDecimals,
    quoteCurrency,
    quoteSide,
    quoteMint,
    quoteSymbol: quoteCurrency,
    quoteDecimals: quoteSide === 'X' ? tokenXDecimals : tokenYDecimals,
    baseSymbol: quoteSide === 'X' ? tokenYSymbol : tokenXSymbol,
  } }
}

export async function inspectOpenPool(connection: Connection, poolPubkey: string): Promise<OpenPoolInfo> {
  return (await loadOpenPool(connection, poolPubkey)).poolInfo
}

async function prepareOpenPositionWithPool(
  connection: Connection,
  owner: PublicKey,
  poolPubkey: string,
  amountInput: string,
  rangePercent: number,
  strategy: OpenLiquidityStrategy,
): Promise<{ preview: OpenPositionPreview; pool: DLMM }> {
  const { pool, poolInfo } = await loadOpenPool(connection, poolPubkey)
  const activeBinId = pool.lbPair.activeId
  const activePoolPrice = Number(pool.fromPricePerLamport(Number(getPriceOfBinByBinId(activeBinId, pool.lbPair.binStep))))
  const range = calculateSingleSideRange({
    activeBinId,
    activePoolPrice,
    quoteSide: poolInfo.quoteSide,
    rangePercent,
    getBinIdFromPrice: (price, min) => pool.getBinIdFromPrice(price, min),
  })
  const binCount = range.maxBinId - range.minBinId + 1
  const maxBins = Number(MAX_BINS_PER_POSITION.toString())
  if (binCount <= 0 || binCount > maxBins) {
    throw new Error(`Range creates ${binCount} bins; one position supports at most ${maxBins}`)
  }

  const amountRaw = parseUiAmountToRaw(amountInput, poolInfo.quoteDecimals)
  const strategyParams = {
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    strategyType: strategyType(strategy),
    singleSidedX: poolInfo.quoteSide === 'X',
  }
  const cost = await pool.quoteCreatePosition({ strategy: strategyParams })
  if (cost.positionCount !== 1) throw new Error(`Range requires ${cost.positionCount} positions; reduce the percentage range`)
  if (cost.transactionCount !== 1) throw new Error(`Range requires ${cost.transactionCount} setup transactions; reduce the percentage range`)
  const estimatedPositionCostSol = cost.positionCost + cost.positionReallocCost + cost.bitmapExtensionCost + cost.binArrayCost
  const maxPriceMoveBins = config.openMaxPriceMoveBins
  const addSlippagePercent = sdkSlippagePercentForBins(pool.lbPair.binStep, maxPriceMoveBins)
  const nativeBalance = await connection.getBalance(owner)
  const requiredFeeLamports = BigInt(Math.ceil((estimatedPositionCostSol + config.openSolFeeReserve) * LAMPORTS_PER_SOL))

  if (poolInfo.quoteCurrency === 'SOL') {
    if (BigInt(nativeBalance) < amountRaw + requiredFeeLamports) {
      throw new Error(`Insufficient SOL; keep ${config.openSolFeeReserve} SOL plus estimated position rent for fees`)
    }
  } else {
    const quoteBalance = await rawAssociatedTokenBalance(connection, owner, poolInfo.quoteMint)
    if (quoteBalance < amountRaw) throw new Error('Insufficient USDC balance')
    if (BigInt(nativeBalance) < requiredFeeLamports) {
      throw new Error(`Insufficient SOL for rent and fees; keep at least ${config.openSolFeeReserve} SOL reserve`)
    }
  }

  return { pool, preview: {
    ...poolInfo,
    amountInput: formatRawAmount(amountRaw, poolInfo.quoteDecimals),
    amountQuote: Number(amountRaw) / 10 ** poolInfo.quoteDecimals,
    amountRaw: amountRaw.toString(),
    rangePercent,
    strategy,
    activeBinId,
    minBinId: range.minBinId,
    maxBinId: range.maxBinId,
    binCount,
    currentPriceQuote: range.currentPriceQuote,
    targetPriceQuote: range.targetPriceQuote,
    estimatedPositionCostSol,
    maxPriceMoveBins,
    addSlippagePercent,
    observedAt: Date.now(),
  } }
}

export async function prepareOpenPosition(
  connection: Connection,
  owner: PublicKey,
  poolPubkey: string,
  amountInput: string,
  rangePercent: number,
  strategy: OpenLiquidityStrategy,
): Promise<OpenPositionPreview> {
  return (await prepareOpenPositionWithPool(connection, owner, poolPubkey, amountInput, rangePercent, strategy)).preview
}

function persistOpenPosition(position: Keypair, preview: OpenPositionPreview, owner: string): void {
  const riskSettings = getRiskSettings()
  upsertPosition({
    positionPubkey: position.publicKey.toBase58(),
    poolPubkey: preview.poolPubkey,
    tokenXMint: preview.tokenXMint,
    tokenYMint: preview.tokenYMint,
    tokenXSymbol: preview.tokenXSymbol,
    tokenYSymbol: preview.tokenYSymbol,
    owner,
    quoteCurrency: preview.quoteCurrency,
    basisQuote: preview.amountQuote,
    basisSolLegacy: preview.quoteCurrency === 'SOL' ? preview.amountQuote : 0,
    basisConfidence: 'high',
    tpPercent: riskSettings.tpPercent,
    slPercent: riskSettings.slPercent,
    status: 'opening',
    triggerConfirmations: 0,
    peakPnlPercent: 0,
    trailingActivated: false,
    lastPnlPercent: null,
    lastEstimatedExitQuote: null,
    lastEstimatedExitSolLegacy: null,
    lastSeenAt: Date.now(),
    strategy: 'single_side_quote',
    flipModeEnabled: false,
  })
}

function pendingOpenKey(owner: string): string {
  return `${OPEN_PENDING_PREFIX}${owner}`
}

function parsePendingOpenState(value: string): PendingOpenState {
  const state = JSON.parse(value) as Partial<OpenAttemptState>
  if (
    state.version !== 1
    || !state.positionPubkey
    || !state.owner
    || !state.poolPubkey
    || !state.signature
    || !state.signedTransaction
    || !state.blockhash
    || !Number.isSafeInteger(state.lastValidBlockHeight)
    || !['prepared', 'submitted', 'confirmed'].includes(state.stage || '')
  ) {
    throw new Error('durable open state is malformed')
  }
  return state as PendingOpenState
}

function findPendingOpen(owner: string): PendingOpenState | null {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(pendingOpenKey(owner)) as { value: string } | undefined
  return row ? parsePendingOpenState(row.value) : null
}

export function pendingOpenExists(owner: string): boolean {
  return findPendingOpen(owner) !== null
}

function ensureOpenWalletLease(state: PendingOpenState): void {
  const db = getDb()
  db.transaction(() => {
    const key = walletOperationKey(state.owner)
    const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) {
      db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify({ kind: 'open', operationId: state.positionPubkey }), Date.now())
      return
    }
    const lease = JSON.parse(row.value) as { kind?: string; operationId?: string }
    if (lease.kind !== 'open' || lease.operationId !== state.positionPubkey) {
      throw new Error('wallet operation lease belongs to another operation')
    }
  })()
}

function createPendingOpen(position: Keypair, preview: OpenPositionPreview, state: PendingOpenState): void {
  const db = getDb()
  db.transaction(() => {
    const existing = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(pendingOpenKey(state.owner)) as { value: string } | undefined
    if (existing) {
      const pending = parsePendingOpenState(existing.value)
      throw new OpenSubmissionPendingError(pending.positionPubkey, pending.signature, 'another open is still pending')
    }
    const lease = db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(walletOperationKey(state.owner))
    if (lease) throw new Error('wallet is busy with another durable operation')
    persistOpenPosition(position, preview, state.owner)
    db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(walletOperationKey(state.owner), JSON.stringify({ kind: 'open', operationId: state.positionPubkey }), state.updatedAt)
    db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(pendingOpenKey(state.owner), JSON.stringify(state), state.updatedAt)
  })()
}

function updatePendingOpen(state: PendingOpenState): void {
  const next = { ...state, updatedAt: Date.now() }
  const result = getDb().prepare(`
    UPDATE sync_state
    SET value = ?, updated_at = ?
    WHERE key = ? AND json_extract(value, '$.positionPubkey') = ?
  `).run(JSON.stringify(next), next.updatedAt, pendingOpenKey(state.owner), state.positionPubkey)
  if (result.changes !== 1) throw new Error('durable open state changed during reconciliation')
}

function finishOpenAttempt(state: PendingOpenState, stage: TerminalOpenStage, error: string | null): void {
  const terminal: TerminalOpenState = {
    ...state,
    stage,
    updatedAt: Date.now(),
    lastError: error,
  }
  const db = getDb()
  db.transaction(() => {
    const current = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(pendingOpenKey(state.owner)) as { value: string } | undefined
    if (current && parsePendingOpenState(current.value).positionPubkey !== state.positionPubkey) {
      throw new Error('refusing to finalize a superseded open attempt')
    }
    if (stage === 'finalized') updatePositionStatus(state.positionPubkey, 'monitoring')
    else deleteOpeningPosition(state.positionPubkey)
    db.prepare('INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`${OPEN_ATTEMPT_PREFIX}${state.positionPubkey}`, JSON.stringify(terminal), terminal.updatedAt)
    db.prepare(`DELETE FROM sync_state WHERE key = ? AND json_extract(value, '$.positionPubkey') = ?`)
      .run(pendingOpenKey(state.owner), state.positionPubkey)
    db.prepare(`
      DELETE FROM sync_state
      WHERE key = ?
        AND json_extract(value, '$.kind') = 'open'
        AND json_extract(value, '$.operationId') = ?
    `).run(walletOperationKey(state.owner), state.positionPubkey)
  })()
}

async function verifyFinalizedPosition(connection: Connection, state: PendingOpenState): Promise<boolean> {
  const positionAddress = new PublicKey(state.positionPubkey)
  const account = await connection.getAccountInfo(positionAddress, 'finalized')
  if (!account) return false
  if (!account.owner.equals(DLMM_PROGRAM_ID)) throw new Error('finalized position account has an unexpected program owner')

  clearPoolCache()
  const pool = await getPool(connection, new PublicKey(state.poolPubkey))
  const position = await pool.getPosition(positionAddress)
  if (!position.positionData.owner.equals(new PublicKey(state.owner))) {
    throw new Error('finalized position account has an unexpected wallet owner')
  }
  if (position.positionData.lowerBinId !== state.minBinId || position.positionData.upperBinId !== state.maxBinId) {
    throw new Error('finalized position range does not match the durable open intent')
  }
  return true
}

function positionIsMonitoring(positionPubkey: string): boolean {
  const row = getDb().prepare('SELECT status FROM positions WHERE position_pubkey = ?').get(positionPubkey) as { status: string } | undefined
  return row?.status === 'monitoring'
}

export async function executeOpenPosition(
  connection: Connection,
  wallet: Keypair,
  preview: OpenPositionPreview,
  skipLock = false,
): Promise<OpenPositionResult> {
  const work = async (): Promise<OpenPositionResult> => {
    const owner = wallet.publicKey.toBase58()
    await reconcilePendingOpens(connection)
    const lease = getWalletOperation(owner)
    if (lease && lease.kind !== 'open') throw new Error(`Wallet is busy with a pending ${lease.kind} operation`)
    const unresolved = findPendingOpen(owner)
    if (unresolved) {
      throw new OpenSubmissionPendingError(unresolved.positionPubkey, unresolved.signature, 'wait for final reconciliation before opening again')
    }

    const { preview: refreshed, pool } = await prepareOpenPositionWithPool(
      connection,
      wallet.publicKey,
      preview.poolPubkey,
      preview.amountInput,
      preview.rangePercent,
      preview.strategy,
    )
    const maxPriceMoveBins = Math.min(preview.maxPriceMoveBins, refreshed.maxPriceMoveBins)
    const observedMoveBins = Math.abs(refreshed.activeBinId - preview.activeBinId)
    if (observedMoveBins > maxPriceMoveBins) {
      throw new Error('Pool price moved too far since preview; review the open position again')
    }
    const remainingMoveBins = remainingPriceMoveBins(maxPriceMoveBins, observedMoveBins)
    const executedPreview: OpenPositionPreview = {
      ...refreshed,
      maxPriceMoveBins,
      addSlippagePercent: sdkSlippagePercentForBins(pool.lbPair.binStep, remainingMoveBins),
    }

    return submitOpenPosition(connection, wallet, pool, executedPreview)
  }
  return skipLock ? work() : withWalletExecutionLock(work)
}

export interface RebalanceOpenParams {
  poolPubkey: string
  quoteCurrency: QuoteCurrency
  amountQuote: number
  rangeWidth: number
}

async function prepareRebalanceOpenWithPool(
  connection: Connection,
  owner: PublicKey,
  params: RebalanceOpenParams,
): Promise<{ preview: OpenPositionPreview; pool: DLMM }> {
  const { pool, poolInfo } = await loadOpenPool(connection, params.poolPubkey)
  const activeBinId = pool.lbPair.activeId
  const width = Math.round(params.rangeWidth)
  if (!Number.isInteger(width) || width < 1) throw new Error('Rebalance range width is invalid')
  const maxBins = Number(MAX_BINS_PER_POSITION.toString())
  if (width > maxBins) throw new Error(`Rebalance range ${width} bins exceeds the ${maxBins}-bin position limit`)
  const minBinId = activeBinId - width + 1
  const maxBinId = activeBinId

  if (poolInfo.quoteCurrency !== params.quoteCurrency) {
    throw new Error('Rebalance quote currency does not match the pool')
  }
  const amountRaw = parseUiAmountToRaw(
    formatRawAmount(BigInt(Math.round(params.amountQuote * 10 ** poolInfo.quoteDecimals)), poolInfo.quoteDecimals),
    poolInfo.quoteDecimals,
  )
  if (amountRaw <= 0n) throw new Error('Rebalance amount must be greater than zero')

  const strategyParams = {
    minBinId,
    maxBinId,
    strategyType: strategyType('spot'),
    singleSidedX: poolInfo.quoteSide === 'X',
  }
  const cost = await pool.quoteCreatePosition({ strategy: strategyParams })
  if (cost.positionCount !== 1) throw new Error(`Range requires ${cost.positionCount} positions; reduce the percentage range`)
  if (cost.transactionCount !== 1) throw new Error(`Range requires ${cost.transactionCount} setup transactions; reduce the percentage range`)
  const estimatedPositionCostSol = cost.positionCost + cost.positionReallocCost + cost.bitmapExtensionCost + cost.binArrayCost
  const addSlippagePercent = sdkSlippagePercentForBins(pool.lbPair.binStep, config.openMaxPriceMoveBins)
  const nativeBalance = await connection.getBalance(owner)
  const requiredFeeLamports = BigInt(Math.ceil((estimatedPositionCostSol + config.openSolFeeReserve) * LAMPORTS_PER_SOL))

  if (poolInfo.quoteCurrency === 'SOL') {
    if (BigInt(nativeBalance) < amountRaw + requiredFeeLamports) {
      throw new Error(`Insufficient SOL; keep ${config.openSolFeeReserve} SOL plus estimated position rent for fees`)
    }
  } else {
    const quoteBalance = await rawAssociatedTokenBalance(connection, owner, poolInfo.quoteMint)
    if (quoteBalance < amountRaw) throw new Error('Insufficient USDC balance')
    if (BigInt(nativeBalance) < requiredFeeLamports) {
      throw new Error(`Insufficient SOL for rent and fees; keep at least ${config.openSolFeeReserve} SOL reserve`)
    }
  }

  return { pool, preview: {
    ...poolInfo,
    amountInput: formatRawAmount(amountRaw, poolInfo.quoteDecimals),
    amountQuote: Number(amountRaw) / 10 ** poolInfo.quoteDecimals,
    amountRaw: amountRaw.toString(),
    rangePercent: 0,
    strategy: 'spot',
    activeBinId,
    minBinId,
    maxBinId,
    binCount: width,
    currentPriceQuote: 0,
    targetPriceQuote: 0,
    estimatedPositionCostSol,
    maxPriceMoveBins: config.openMaxPriceMoveBins,
    addSlippagePercent,
    observedAt: Date.now(),
  } }
}

export async function executeRebalanceOpen(
  connection: Connection,
  wallet: Keypair,
  params: RebalanceOpenParams,
  skipLock = false,
): Promise<OpenPositionResult> {
  const work = async (): Promise<OpenPositionResult> => {
    const owner = wallet.publicKey.toBase58()
    await reconcilePendingOpens(connection)
    const lease = getWalletOperation(owner)
    if (lease && lease.kind !== 'open') throw new Error(`Wallet is busy with a pending ${lease.kind} operation`)
    const unresolved = findPendingOpen(owner)
    if (unresolved) {
      throw new OpenSubmissionPendingError(unresolved.positionPubkey, unresolved.signature, 'wait for final reconciliation before opening again')
    }

    const { preview, pool } = await prepareRebalanceOpenWithPool(connection, wallet.publicKey, params)
    return submitOpenPosition(connection, wallet, pool, preview)
  }
  return skipLock ? work() : withWalletExecutionLock(work)
}

async function submitOpenPosition(
  connection: Connection,
  wallet: Keypair,
  pool: DLMM,
  executedPreview: OpenPositionPreview,
): Promise<OpenPositionResult> {
  const owner = wallet.publicKey.toBase58()
  const position = Keypair.generate()
  const amountRaw = new BN(executedPreview.amountRaw)
  const createTx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: wallet.publicKey,
    totalXAmount: executedPreview.quoteSide === 'X' ? amountRaw : new BN(0),
    totalYAmount: executedPreview.quoteSide === 'Y' ? amountRaw : new BN(0),
    strategy: {
      minBinId: executedPreview.minBinId,
      maxBinId: executedPreview.maxBinId,
      strategyType: strategyType(executedPreview.strategy),
      singleSidedX: executedPreview.quoteSide === 'X',
    },
    slippage: executedPreview.addSlippagePercent,
  })

  const latest = await connection.getLatestBlockhash('confirmed')
  createTx.feePayer = wallet.publicKey
  createTx.recentBlockhash = latest.blockhash
  createTx.sign(wallet, position)
  const expectedSignature = bs58.encode(createTx.signature!)
  const signedTransaction = createTx.serialize()
  const now = Date.now()
  const pendingState: PendingOpenState = {
    version: 1,
    positionPubkey: position.publicKey.toBase58(),
    owner,
    poolPubkey: executedPreview.poolPubkey,
    quoteCurrency: executedPreview.quoteCurrency,
    amountRaw: executedPreview.amountRaw,
    minBinId: executedPreview.minBinId,
    maxBinId: executedPreview.maxBinId,
    strategy: executedPreview.strategy,
    signature: expectedSignature,
    signedTransaction: signedTransaction.toString('base64'),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    stage: 'prepared',
    missingAfterExpiryChecks: 0,
    lastExpiryAbsenceAt: null,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  }
  createPendingOpen(position, executedPreview, pendingState)

  let transactionFinalized = false
  try {
    const signature = await connection.sendRawTransaction(signedTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    })
    if (signature !== expectedSignature) throw new Error('RPC returned a signature that does not match the signed transaction')
    pendingState.stage = 'submitted'
    updatePendingOpen(pendingState)
    const confirmation = await withTimeout(
      connection.confirmTransaction({ signature: expectedSignature, ...latest }, 'finalized'),
      30_000,
    )
    if (confirmation.value.err) {
      const message = `open transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
      finishOpenAttempt(pendingState, 'failed', message)
      throw new DefinitiveOpenError(message)
    }
    transactionFinalized = true
    if (!await verifyFinalizedPosition(connection, pendingState)) {
      throw new Error('transaction finalized but the position account is not yet visible')
    }
    finishOpenAttempt(pendingState, 'finalized', null)
  } catch (err) {
    if (err instanceof DefinitiveOpenError) throw err
    if (!findPendingOpen(owner) && positionIsMonitoring(pendingState.positionPubkey)) {
      console.log(`[open] position ${pendingState.positionPubkey.slice(0, 8)} was finalized by concurrent reconciliation`)
    } else {
      throw new OpenSubmissionPendingError(pendingState.positionPubkey, expectedSignature, err, transactionFinalized)
    }
  }
  clearPnlCache()
  clearPoolCache()

  return {
    signature: expectedSignature,
    positionPubkey: position.publicKey.toBase58(),
    preview: executedPreview,
  }
}

export async function reconcilePendingOpens(connection: Connection): Promise<OpenReconcileSummary> {
  const summary: OpenReconcileSummary = { finalized: 0, failed: 0, pending: 0 }
  for (const row of listSyncValues(OPEN_PENDING_PREFIX)) {
    let pending: PendingOpenState | null = null
    try {
      pending = parsePendingOpenState(row.value)
      const lease = getWalletOperation(pending.owner)
      if (lease && (lease.kind !== 'open' || lease.operationId !== pending.positionPubkey)) {
        summary.pending++
        console.log(`[open] reconciliation paused by ${lease.kind} operation ${lease.operationId}`)
        continue
      }
      ensureOpenWalletLease(pending)
      if (await verifyFinalizedPosition(connection, pending)) {
        finishOpenAttempt(pending, 'finalized', null)
        summary.finalized++
        console.log(`[open] reconciled finalized position ${pending.positionPubkey.slice(0, 8)}`)
        continue
      }

      const status = await connection.getSignatureStatus(pending.signature, { searchTransactionHistory: true })
      if (status.value?.confirmationStatus === 'finalized' && status.value.err) {
        const message = `open transaction failed on-chain: ${JSON.stringify(status.value.err)}`
        finishOpenAttempt(pending, 'failed', message)
        summary.failed++
        console.log(`[open] reconciled failed position ${pending.positionPubkey.slice(0, 8)}`)
        continue
      }

      if (status.value?.confirmationStatus === 'confirmed' && pending.stage !== 'confirmed') {
        pending = { ...pending, stage: 'confirmed', lastError: null }
        updatePendingOpen(pending)
      }

      const blockHeight = await connection.getBlockHeight('confirmed')
      if (!status.value && blockHeight > pending.lastValidBlockHeight) {
        const now = Date.now()
        const canCountAbsence = pending.lastExpiryAbsenceAt === null
          || now - pending.lastExpiryAbsenceAt >= EXPIRED_ABSENCE_MIN_INTERVAL_MS
        const missingAfterExpiryChecks = pending.missingAfterExpiryChecks + (canCountAbsence ? 1 : 0)
        if (missingAfterExpiryChecks >= EXPIRED_ABSENCE_CHECKS) {
          finishOpenAttempt(pending, 'expired', 'signature absent after blockhash expiry')
          summary.failed++
          console.log(`[open] reconciled expired position ${pending.positionPubkey.slice(0, 8)}`)
          continue
        }
        if (canCountAbsence) {
          pending = {
            ...pending,
            missingAfterExpiryChecks,
            lastExpiryAbsenceAt: now,
            lastError: 'signature absent after blockhash expiry; awaiting a second observation',
          }
          updatePendingOpen(pending)
        }
      } else if (!status.value) {
        const signature = await connection.sendRawTransaction(Buffer.from(pending.signedTransaction, 'base64'), {
          skipPreflight: true,
          maxRetries: 0,
        })
        if (signature !== pending.signature) throw new Error('rebroadcast signature does not match durable open intent')
        if (pending.stage === 'prepared') {
          pending = { ...pending, stage: 'submitted', lastError: null }
          updatePendingOpen(pending)
        }
      } else if (status.value.err) {
        pending = { ...pending, lastError: `non-final transaction error: ${JSON.stringify(status.value.err)}` }
        updatePendingOpen(pending)
      } else if (status.value.confirmationStatus === 'finalized') {
        pending = { ...pending, stage: 'confirmed', lastError: 'finalized signature found but position verification is unavailable' }
        updatePendingOpen(pending)
      }
      summary.pending++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      if (pending) {
        try { updatePendingOpen({ ...pending, lastError: message }) } catch { /* Keep the original durable state. */ }
      }
      summary.pending++
      console.log(`[open] pending reconciliation failed: ${message}`)
    }
  }
  return summary
}
