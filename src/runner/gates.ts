import type { TriggerType } from '../types.js'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export type RunnerCycleStage = 'waiting_pool' | 'open_first' | 'reopen_eval' | 'open_followup' | 'cycle_done'

export interface RunnerAlertPayload {
  chainId: string
  mint: string
  symbol: string
  volumeUsd: number
  marketCapUsd: number
  athMarketCapUsd: number
  holders: number
  top10HolderPct: number | null
  totalFeeSol: number
  liquidityUsd: number | null
  reason: string
  alertedAt: number
}

export interface RunnerOpenGateInput {
  marketCapUsd: number | null
  athMarketCapUsd: number | null
  totalTvlUsd: number
  minMcapUsd: number
  maxAthDrop: number
  maxDlmmTvlUsd: number
}

export interface DiscoveredDlmmPool {
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  tvlUsd: number
  blacklisted: boolean
}

export interface PoolDiscoveryResult {
  pools: DiscoveredDlmmPool[]
  knownAddresses: string[]
  incomplete: boolean
}

export function combinePoolDiscovery(input: {
  previousKnown: string[]
  discoveredAddresses: string[]
  hydrated: DiscoveredDlmmPool[]
  failedAddresses: string[]
  lookupFailed: boolean
}): PoolDiscoveryResult {
  const knownAddresses = [...new Set([...input.previousKnown, ...input.discoveredAddresses, ...input.hydrated.map(pool => pool.poolPubkey)])]
  const incomplete = input.lookupFailed || input.failedAddresses.length > 0 || input.hydrated.length < knownAddresses.length
  return { pools: input.hydrated, knownAddresses, incomplete }
}

export function isDuplicateAlert(lastAlertedAt: number | null, alertedAt: number): boolean {
  return lastAlertedAt !== null && alertedAt <= lastAlertedAt
}

export function isStaleAlert(alertedAt: number, now: number, maxAgeMs = 3_600_000): boolean {
  if (!Number.isFinite(alertedAt)) return true
  const alertMs = alertedAt > 1e12 ? alertedAt : alertedAt * 1000
  return now - alertMs > maxAgeMs || alertMs - now > 300_000
}

export function parseRunnerAlertPayload(body: unknown): RunnerAlertPayload | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'payload must be an object' }
  const raw = body as Record<string, unknown>
  const chainId = typeof raw.chainId === 'string' ? raw.chainId : ''
  const mint = typeof raw.mint === 'string' ? raw.mint.trim() : ''
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : ''
  if (!chainId) return { error: 'chainId is required' }
  if (!mint) return { error: 'mint is required' }
  if (!symbol) return { error: 'symbol is required' }
  const marketCapUsd = numberOrNaN(raw.marketCapUsd)
  const athMarketCapUsd = numberOrNaN(raw.athMarketCapUsd)
  const holders = numberOrNaN(raw.holders)
  const totalFeeSol = numberOrNaN(raw.totalFeeSol)
  const volumeUsd = numberOrNaN(raw.volumeUsd)
  const alertedAt = numberOrNaN(raw.alertedAt)
  if (![marketCapUsd, athMarketCapUsd, holders, totalFeeSol, volumeUsd, alertedAt].every(Number.isFinite)) {
    return { error: 'numeric fields are invalid' }
  }
  return {
    chainId,
    mint,
    symbol,
    volumeUsd,
    marketCapUsd,
    athMarketCapUsd,
    holders,
    top10HolderPct: optionalNumber(raw.top10HolderPct),
    totalFeeSol,
    liquidityUsd: optionalNumber(raw.liquidityUsd),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    alertedAt,
  }
}

export function evaluateIngestGate(input: {
  enabled: boolean
  secretOk: boolean
  payload: RunnerAlertPayload
  minMcapUsd: number
  minHolders: number
  minFeeSol: number
  activeRunnerCount: number
  maxActive: number
  sameMintBusy: boolean
}): { ok: true } | { ok: false; reason: string; status: 400 | 401 | 503 | 202 } {
  if (!input.enabled) return { ok: false, reason: 'runner agent disabled', status: 503 }
  if (!input.secretOk) return { ok: false, reason: 'invalid secret', status: 401 }
  if (input.payload.chainId !== 'sol') return { ok: false, reason: 'chainId must be sol', status: 400 }
  if (input.payload.marketCapUsd < input.minMcapUsd) return { ok: false, reason: 'mcap below minimum', status: 202 }
  if (input.payload.holders < input.minHolders) return { ok: false, reason: 'holders below minimum', status: 202 }
  if (input.payload.totalFeeSol < input.minFeeSol) return { ok: false, reason: 'fee below minimum', status: 202 }
  if (input.sameMintBusy) return { ok: false, reason: 'mint already in a runner cycle', status: 202 }
  if (input.activeRunnerCount >= input.maxActive) return { ok: false, reason: 'runner slot full', status: 202 }
  return { ok: true }
}

export type OpenGateResult = { ok: true } | { ok: false; reason: string; retryable?: boolean }

export function gmgnUnavailableGate(): OpenGateResult {
  return { ok: false, reason: 'gmgn unavailable', retryable: true }
}

export function tvlIncompleteGate(): OpenGateResult {
  return { ok: false, reason: 'dlmm tvl incomplete', retryable: true }
}

export function evaluateOpenGate(input: RunnerOpenGateInput): OpenGateResult {
  if (input.marketCapUsd === null || !Number.isFinite(input.marketCapUsd) || input.marketCapUsd < input.minMcapUsd) {
    return { ok: false, reason: 'mcap below minimum' }
  }
  if (input.athMarketCapUsd === null || !Number.isFinite(input.athMarketCapUsd) || input.athMarketCapUsd <= 0) {
    return { ok: false, reason: 'ath mcap missing' }
  }
  if (input.marketCapUsd / input.athMarketCapUsd <= input.maxAthDrop) {
    return { ok: false, reason: 'ath drop too large' }
  }
  if (input.totalTvlUsd > input.maxDlmmTvlUsd) {
    return { ok: false, reason: 'dlmm tvl too high' }
  }
  return { ok: true }
}

export function sumDlmmTvl(pools: DiscoveredDlmmPool[]): number {
  return pools.reduce((sum, pool) => sum + (Number.isFinite(pool.tvlUsd) ? pool.tvlUsd : 0), 0)
}

export function selectSolOpenPool(pools: DiscoveredDlmmPool[]): DiscoveredDlmmPool | null {
  const eligible = pools.filter(pool => !pool.blacklisted && quoteIsSol(pool.tokenXMint, pool.tokenYMint))
  if (eligible.length === 0) return null
  return eligible.reduce((best, pool) => pool.tvlUsd > best.tvlUsd ? pool : best)
}

export function quoteIsSol(tokenXMint: string, tokenYMint: string): boolean {
  return tokenXMint === SOL_MINT || tokenYMint === SOL_MINT
}

export function isTerminalOpenError(message: string): boolean {
  return /Range requires \d+ (?:positions|setup transactions)/.test(message)
    || /one position supports at most/.test(message)
    || /Insufficient SOL/.test(message)
    || /Insufficient USDC/.test(message)
    || /Pool must contain SOL or USDC/.test(message)
    || /Rebalance quote currency does not match/.test(message)
    || /Rebalance range/.test(message)
}

export function classifyOpenFailure(error: unknown, retryCount: number, maxRetry: number): 'pending' | 'terminal' | 'retry' | 'give_up' {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'OpenSubmissionPendingError' || /requires reconciliation/.test(message)) return 'pending'
  if (isTerminalOpenError(message)) return 'terminal'
  if (retryCount + 1 >= maxRetry) return 'give_up'
  return 'retry'
}

export function priceAboveUpperRatio(currentPriceQuote: number, upperBinPriceQuote: number): number {
  if (!(upperBinPriceQuote > 0) || !Number.isFinite(currentPriceQuote)) return 0
  return (currentPriceQuote - upperBinPriceQuote) / upperBinPriceQuote
}

export function entryDriftFromPrices(input: {
  quoteSide: 'X' | 'Y'
  currentPoolPrice: number
  lowerBinPrice: number
  upperBinPrice: number
}): number {
  if (!(input.currentPoolPrice > 0)) return 0
  if (input.quoteSide === 'Y') {
    return priceAboveUpperRatio(input.currentPoolPrice, input.upperBinPrice)
  }
  if (!(input.lowerBinPrice > 0)) return 0
  return priceAboveUpperRatio(1 / input.currentPoolPrice, 1 / input.lowerBinPrice)
}

export function shouldChaseEntryDrift(input: {
  cycleStage: RunnerCycleStage
  firstChaseCount: number
  firstEverInRange: boolean
  maxChase: number
  driftPct: number
  threshold: number
}): boolean {
  if (input.cycleStage !== 'open_first') return false
  if (input.firstEverInRange) return false
  if (input.firstChaseCount >= input.maxChase) return false
  return input.driftPct > input.threshold
}

export function isPriceInRange(activeBinId: number, lowerBinId: number, upperBinId: number): boolean {
  return activeBinId >= lowerBinId && activeBinId <= upperBinId
}

export function decideRunnerClose(triggerType: TriggerType, winCount: number, maxWins: number): 'chase_first' | 'reopen_eval' | 'cycle_done' {
  if (triggerType === 'RUNNER_ENTRY_DRIFT') return 'chase_first'
  if (triggerType === 'TP' || triggerType === 'TRAILING_STOP') {
    if (winCount >= maxWins) return 'cycle_done'
    return 'reopen_eval'
  }
  return 'cycle_done'
}

export function isWinTrigger(triggerType: TriggerType): boolean {
  return triggerType === 'TP' || triggerType === 'TRAILING_STOP'
}

export function shouldCloseFollowup(input: {
  totalTvlUsd: number
  vol5mUsd: number | null
  pnlPercent: number
  maxDlmmTvlUsd: number
  exitMinVol5mUsd: number
}): boolean {
  if (!(input.pnlPercent > 0)) return false
  if (input.totalTvlUsd > input.maxDlmmTvlUsd) return true
  if (input.vol5mUsd !== null && input.vol5mUsd < input.exitMinVol5mUsd) return true
  return false
}

export function canReopenAfterWin(input: {
  winCount: number
  maxWins: number
  vol5mUsd: number | null
  minVol5mUsd: number
  openGate: { ok: true } | { ok: false; reason: string }
}): { ok: true } | { ok: false; reason: string } {
  if (input.winCount >= input.maxWins) return { ok: false, reason: 'win cap reached' }
  if (!input.openGate.ok) return input.openGate
  if (input.vol5mUsd === null || !Number.isFinite(input.vol5mUsd) || input.vol5mUsd <= input.minVol5mUsd) {
    return { ok: false, reason: 'vol 5m below reopen minimum' }
  }
  return { ok: true }
}

function numberOrNaN(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
