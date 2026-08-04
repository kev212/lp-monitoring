import type { QuoteCurrency } from '../types.js'

const PNL_API_BASE = 'https://dlmm.datapi.meteora.ag/positions'
const CACHE_TTL_MS = 5_000
const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export interface MeteoraPnlPosition {
  [key: string]: any
}

export interface ValuationResult {
  quoteCurrency: QuoteCurrency
  estimatedExitQuote: number
  pnlQuote: number
  pnlPercent: number
  depositQuote: number
  withdrawalQuote: number
  estimatedExitSol: number
  estimatedExitUsd: number
  depositSol: number
  depositUsd: number
  withdrawalSol: number
  withdrawalUsd: number
  tokenXValueQuote: number
  tokenYValueQuote: number
  tokenXValueSol: number
  tokenYValueSol: number
  tokenXValueUsd: number
  tokenYValueUsd: number
  allTimeDepositTokenXAmount: number
  allTimeDepositTokenYAmount: number
  tokenXAmount: number
  tokenYAmount: number
  tokenXFees: number
  tokenYFees: number
  tokenXPriceSol: number
  tokenYPriceSol: number
  solUsdPrice: number
  source: 'meteora-api'
  observedAt: number
  /** Bin position data for range-based triggers */
  lowerBinId?: number
  upperBinId?: number
  poolActiveBinId?: number
}

const apiCache = new Map<string, { ts: number; positions: Map<string, MeteoraPnlPosition> }>()
const valuationCache = new Map<string, { ts: number; data: ValuationResult }>()

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['value', 'amount', 'total', 'sol', 'usd']) {
      const nested = readNumber(object[key])
      if (nested !== null) return nested
    }
    return null
  }

  const stringValue = typeof value === 'string' && value.endsWith('%')
    ? value.slice(0, -1)
    : value
  const number = Number(stringValue)
  return Number.isFinite(number) ? number : null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = readNumber(value)
    if (number !== null) return number
  }
  return null
}

function amountValue(value: unknown): number {
  return firstNumber(value) ?? 0
}

function optionalNumber(value: unknown): number | undefined {
  return readNumber(value) ?? undefined
}

function apiCacheKey(poolAddress: string, walletAddress: string): string {
  return `${walletAddress}:${poolAddress}`
}

function valuationCacheKey(
  poolAddress: string,
  walletAddress: string,
  positionPubkey: string,
  quoteCurrency: QuoteCurrency,
): string {
  return `${walletAddress}:${poolAddress}:${positionPubkey}:${quoteCurrency}`
}

async function fetchPnlPositions(
  poolAddress: string,
  walletAddress: string,
  forceFresh = false,
): Promise<Map<string, MeteoraPnlPosition> | null> {
  const key = apiCacheKey(poolAddress, walletAddress)
  const cached = apiCache.get(key)
  if (!forceFresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.positions
  }

  try {
    const url = new URL(`${PNL_API_BASE}/${poolAddress}/pnl`)
    url.searchParams.set('user', walletAddress)
    url.searchParams.set('status', 'open')
    url.searchParams.set('page_size', '100')
    url.searchParams.set('page', '1')

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.log(`[pnl_api] HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}`)
      return null
    }

    const body = await res.json() as any
    const positions = Array.isArray(body?.positions)
      ? body.positions
      : Array.isArray(body?.data?.positions)
        ? body.data.positions
        : []
    const mapped = new Map<string, MeteoraPnlPosition>()
    for (const position of positions) {
      if (position?.positionAddress) mapped.set(String(position.positionAddress), position)
    }

    apiCache.set(key, { ts: Date.now(), positions: mapped })
    return mapped
  } catch (err) {
    console.log(`[pnl_api] error for pool ${poolAddress.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

async function fetchPnlPosition(
  poolAddress: string,
  walletAddress: string,
  positionPubkey: string,
  forceFresh = false,
): Promise<MeteoraPnlPosition | null> {
  const positions = await fetchPnlPositions(poolAddress, walletAddress, forceFresh)
  return positions?.get(positionPubkey) || null
}

export function getQuoteCurrency(tokenXMint: string, tokenYMint: string): QuoteCurrency | null {
  if (tokenXMint === WSOL_MINT || tokenYMint === WSOL_MINT) return 'SOL'
  if (tokenXMint === USDC_MINT || tokenYMint === USDC_MINT) return 'USDC'
  return null
}

function selectedValue(quoteCurrency: QuoteCurrency, sol: number, usd: number): number {
  return quoteCurrency === 'SOL' ? sol : usd
}

export function mapMeteoraPosition(
  position: MeteoraPnlPosition,
  quoteCurrency: QuoteCurrency,
): ValuationResult | null {
  const unrealized = position.unrealizedPnl || {}
  const deposits = position.allTimeDeposits || {}
  const withdrawals = position.allTimeWithdrawals || {}
  const depositTotal = deposits.total || {}
  const withdrawalTotal = withdrawals.total || {}
  const pnl = position.pnl || {}

  const currentSol = firstNumber(
    unrealized.balancesSol,
    unrealized.balanceSol,
    position.balancesSol,
  )
  const currentUsd = firstNumber(
    unrealized.balances,
    unrealized.balancesUsd,
    position.balancesUsd,
  )
  const currentValue = quoteCurrency === 'SOL' ? currentSol : currentUsd
  if (currentValue === null) {
    console.log(`[pnl_api] missing ${quoteCurrency} position value for ${position.positionAddress?.slice?.(0, 8) || 'position'}`)
    return null
  }
  const solUsdPrice = firstNumber(position.solPrice, position.solPriceUsd) ?? (
    currentSol !== null && currentUsd !== null && currentSol !== 0
      ? currentUsd / currentSol
      : 0
  )
  const estimatedExitSol = currentSol ?? (currentUsd !== null && solUsdPrice > 0 ? currentUsd / solUsdPrice : 0)
  const estimatedExitUsd = currentUsd ?? estimatedExitSol * solUsdPrice
  const estimatedExitQuote = selectedValue(quoteCurrency, estimatedExitSol, estimatedExitUsd)

  const depositSol = firstNumber(depositTotal.sol) ?? (firstNumber(depositTotal.usd) !== null && solUsdPrice > 0
    ? (firstNumber(depositTotal.usd) as number) / solUsdPrice
    : 0)
  const depositUsd = firstNumber(depositTotal.usd) ?? depositSol * solUsdPrice
  const depositQuote = selectedValue(quoteCurrency, depositSol, depositUsd)

  const withdrawalSol = firstNumber(withdrawalTotal.sol) ?? (firstNumber(withdrawalTotal.usd) !== null && solUsdPrice > 0
    ? (firstNumber(withdrawalTotal.usd) as number) / solUsdPrice
    : 0)
  const withdrawalUsd = firstNumber(withdrawalTotal.usd) ?? withdrawalSol * solUsdPrice
  const withdrawalQuote = selectedValue(quoteCurrency, withdrawalSol, withdrawalUsd)

  const pnlSolPercent = firstNumber(position.pnlSolPctChange, pnl.solPctChange)
  const pnlUsdPercent = firstNumber(position.pnlPctChange, pnl.usdPctChange)
  const pnlPercent = quoteCurrency === 'SOL' ? pnlSolPercent : pnlUsdPercent
  if (pnlPercent === null) {
    console.log(`[pnl_api] missing ${quoteCurrency} PnL percentage for ${position.positionAddress?.slice?.(0, 8) || 'position'}`)
    return null
  }

  const pnlSol = firstNumber(position.pnlSol, pnl.sol) ?? depositSol * pnlPercent / 100
  const pnlUsd = firstNumber(position.pnlUsd, pnl.usd) ?? depositUsd * pnlPercent / 100
  const pnlQuote = selectedValue(quoteCurrency, pnlSol, pnlUsd)

  const balanceTokenX = unrealized.balanceTokenX || position.balanceTokenX || {}
  const balanceTokenY = unrealized.balanceTokenY || position.balanceTokenY || {}
  const tokenXValueSol = firstNumber(balanceTokenX.amountSol, balanceTokenX.valueSol) ?? 0
  const tokenYValueSol = firstNumber(balanceTokenY.amountSol, balanceTokenY.valueSol) ?? 0
  const tokenXValueUsd = firstNumber(balanceTokenX.amountUsd, balanceTokenX.valueUsd, balanceTokenX.usd) ?? tokenXValueSol * solUsdPrice
  const tokenYValueUsd = firstNumber(balanceTokenY.amountUsd, balanceTokenY.valueUsd, balanceTokenY.usd) ?? tokenYValueSol * solUsdPrice

  const tokenXAmount = amountValue(balanceTokenX.amount)
  const tokenYAmount = amountValue(balanceTokenY.amount)
  const tokenXFees = amountValue(position.unclaimedFeeTokenX?.amount ?? unrealized.unclaimedFeeTokenX?.amount)
  const tokenYFees = amountValue(position.unclaimedFeeTokenY?.amount ?? unrealized.unclaimedFeeTokenY?.amount)
  const depositTokenX = amountValue(deposits.tokenX?.amount)
  const depositTokenY = amountValue(deposits.tokenY?.amount)
  const tokenXPriceUsd = firstNumber(position.tokenXPrice, position.tokenXPriceUsd) ?? 0
  const tokenYPriceUsd = firstNumber(position.tokenYPrice, position.tokenYPriceUsd) ?? 0

  return {
    quoteCurrency,
    estimatedExitQuote,
    pnlQuote,
    pnlPercent,
    depositQuote,
    withdrawalQuote,
    estimatedExitSol,
    estimatedExitUsd,
    depositSol,
    depositUsd,
    withdrawalSol,
    withdrawalUsd,
    tokenXValueQuote: selectedValue(quoteCurrency, tokenXValueSol, tokenXValueUsd),
    tokenYValueQuote: selectedValue(quoteCurrency, tokenYValueSol, tokenYValueUsd),
    tokenXValueSol,
    tokenYValueSol,
    tokenXValueUsd,
    tokenYValueUsd,
    allTimeDepositTokenXAmount: depositTokenX,
    allTimeDepositTokenYAmount: depositTokenY,
    tokenXAmount,
    tokenYAmount,
    tokenXFees,
    tokenYFees,
    tokenXPriceSol: tokenXPriceUsd > 0 && solUsdPrice > 0
      ? tokenXPriceUsd / solUsdPrice
      : tokenXAmount > 0 ? tokenXValueSol / tokenXAmount : 0,
    tokenYPriceSol: tokenYPriceUsd > 0 && solUsdPrice > 0
      ? tokenYPriceUsd / solUsdPrice
      : tokenYAmount > 0 ? tokenYValueSol / tokenYAmount : 0,
    solUsdPrice,
    source: 'meteora-api',
    observedAt: Date.now(),
    lowerBinId: optionalNumber(position.lowerBinId),
    upperBinId: optionalNumber(position.upperBinId),
    poolActiveBinId: optionalNumber(position.poolActiveBinId),
  }
}

export async function getDiscoveryBasis(
  poolAddress: string,
  walletAddress: string,
  positionPubkey: string,
): Promise<number> {
  const position = await fetchPnlPosition(poolAddress, walletAddress, positionPubkey)
  return firstNumber(position?.allTimeDeposits?.total?.sol) ?? 0
}

export async function estimateExitValue(
  poolPubkey: string,
  walletAddress: string,
  positionPubkey: string,
  quoteCurrency: QuoteCurrency,
  forceFresh = false,
): Promise<ValuationResult | null> {
  if (!walletAddress || !positionPubkey) return null

  const key = valuationCacheKey(poolPubkey, walletAddress, positionPubkey, quoteCurrency)
  const cached = valuationCache.get(key)
  if (!forceFresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  const position = await fetchPnlPosition(poolPubkey, walletAddress, positionPubkey, forceFresh)
  if (!position) return null

  const result = mapMeteoraPosition(position, quoteCurrency)
  if (!result) return null

  valuationCache.set(key, { ts: Date.now(), data: result })
  return result
}

export function clearPnlCache(): void {
  apiCache.clear()
  valuationCache.clear()
}
