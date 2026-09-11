/**
 * Read-only Raydium CLMM pool scanner.
 *
 * The scanner deliberately uses the public Raydium and DexScreener HTTP APIs
 * instead of the wallet-bound SDK. This keeps the command safe to run from a
 * Telegram handler and makes the HTTP boundary straightforward to test.
 */

export const RAYDIUM_MIN_TVL_USD = 5_000
export const RAYDIUM_MIN_VOLUME_1H_USD = 20_000
export const RAYDIUM_SCAN_LIMIT = 10
export const RAYDIUM_REQUEST_TIMEOUT_MS = 15_000
export const RAYDIUM_MAX_RETRIES = 2
export const RAYDIUM_CACHE_TTL_MS = 60_000
export const RAYDIUM_DS_RATE_LIMIT_PER_MINUTE = 240
export const RAYDIUM_DS_CONCURRENCY = 4
export const RAYDIUM_RATE_DENOMINATOR = 1_000_000

const RAYDIUM_API_BASE_URL = 'https://api-v3.raydium.io'
const DEXSCREENER_API_BASE_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana'
const DEFAULT_PAGE_SIZE = 100

type JsonRecord = Record<string, unknown>

export interface RaydiumHttpResponse {
  status?: number
  ok?: boolean
  headers?: Headers | Record<string, string | number | undefined>
  json(): Promise<unknown>
}

export type RaydiumHttpClient = (url: string, init?: RequestInit) => Promise<RaydiumHttpResponse>

export interface RaydiumScanPool {
  poolId: string
  symbolA: string
  symbolB: string
  tvlUsd: number
  volume1hUsd: number
  estimatedLpFees1hUsd: number
  estimatedYieldPctPerHour: number
  tradeFeeRate: number
}

export interface RaydiumScanStats {
  discovered: number
  eligible: number
  checked: number
  belowVolume: number
  dynamicFee: number
  invalid: number
  failed: number
}

export interface RaydiumScanProgress extends RaydiumScanStats {
  phase: string
}

export interface RaydiumPoolScanResult {
  startedAt: number
  completedAt: number
  pools: RaydiumScanPool[]
  stats: RaydiumScanStats
  partial: boolean
}

export interface RaydiumRateLimiter {
  schedule<T>(task: () => Promise<T>): Promise<T>
}

export interface RaydiumPoolScannerOptions {
  /** Injectable public HTTP client. `fetch` is accepted as a convenient alias. */
  http?: RaydiumHttpClient
  fetch?: RaydiumHttpClient
  /** Injectable millisecond clock. */
  now?: () => number
  clock?: () => number
  /** Injectable retry delay, useful for deterministic tests. */
  sleep?: (milliseconds: number) => Promise<void>
  raydiumBaseUrl?: string
  dexScreenerBaseUrl?: string
  pageSize?: number
  minTvlUsd?: number
  minVolume1hUsd?: number
  timeoutMs?: number
  maxRetries?: number
  dsConcurrency?: number
  dsRateLimitPerMinute?: number
  /** Optional shared limiter for callers that need to coordinate instances. */
  rateLimiter?: RaydiumRateLimiter
  cacheTtlMs?: number
}

export interface RaydiumPoolScanner {
  scan(onProgress?: (progress: RaydiumScanProgress) => void | Promise<void>): Promise<RaydiumPoolScanResult>
}

interface ScanCandidate {
  poolId: string
  symbolA: string
  symbolB: string
  tvlUsd: number
  tradeFeeRate: number
  protocolFeeRate: number
  fundFeeRate: number
}

interface RaydiumPage {
  items: unknown[]
  hasNextPage: boolean
  nextPageId?: string
}

interface DexPairData {
  volume1hUsd: number
}

class ScannerRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ScannerRequestError'
  }
}

class ScannerPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScannerPayloadError'
  }
}

class RequestRateLimiter implements RaydiumRateLimiter {
  private readonly queue: Array<{
    task: () => Promise<unknown>
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }> = []
  private readonly requestTimes: number[] = []
  private inFlight = 0
  private waking = false
  private pumping = false

  constructor(
    private readonly limit: number,
    private readonly concurrency: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = wait,
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.pump()
    })
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      this.prune()
      while (this.queue.length > 0 && this.inFlight < this.concurrency) {
        this.prune()
        if (this.requestTimes.length >= this.limit) {
          this.scheduleWake()
          return
        }

        const item = this.queue.shift()
        if (!item) return
        this.requestTimes.push(this.now())
        this.inFlight++
        void Promise.resolve()
          .then(item.task)
          .then(item.resolve, item.reject)
          .finally(() => {
            this.inFlight--
            this.pump()
          })
      }
    } finally {
      this.pumping = false
    }
  }

  private prune(): void {
    const cutoff = this.now() - 60_000
    while (this.requestTimes.length > 0 && this.requestTimes[0] <= cutoff) {
      this.requestTimes.shift()
    }
  }

  private scheduleWake(): void {
    if (this.waking || this.requestTimes.length === 0) return
    const waitMs = Math.max(1, this.requestTimes[0] + 60_000 - this.now())
    this.waking = true
    void this.sleep(waitMs).finally(() => {
      this.waking = false
      this.pump()
    })
  }
}

const defaultDexScreenerLimiter = new RequestRateLimiter(
  RAYDIUM_DS_RATE_LIMIT_PER_MINUTE,
  RAYDIUM_DS_CONCURRENCY,
)

const defaultHttp: RaydiumHttpClient = (url, init) => fetch(url, init)

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    parsed = Number(trimmed)
  } else {
    parsed = Number.NaN
  }
  return Number.isFinite(parsed) ? parsed : null
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = finiteNumber(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readHeader(headers: RaydiumHttpResponse['headers'], name: string): string | undefined {
  if (!headers) return undefined
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name)
    return value ?? undefined
  }
  const record = headers as Record<string, string | number | undefined>
  const exact = record[name]
  if (exact !== undefined) return String(exact)
  const key = Object.keys(record).find(candidate => candidate.toLowerCase() === name.toLowerCase())
  const value = key ? record[key] : undefined
  return value === undefined ? undefined : String(value)
}

function retryAfterMs(headers: RaydiumHttpResponse['headers'], now: () => number): number | undefined {
  const value = readHeader(headers, 'retry-after')
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.max(0, timestamp - now())
  return undefined
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1_000 * (2 ** attempt), 5_000)
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}

async function requestJson(
  http: RaydiumHttpClient,
  url: string,
  options: {
    timeoutMs: number
    maxRetries: number
    sleep: (milliseconds: number) => Promise<void>
    now: () => number
    rateLimiter?: RaydiumRateLimiter
  },
): Promise<unknown> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    let response: RaydiumHttpResponse
    let body: unknown
    let bodyRead = false
    try {
      const request = async (): Promise<RaydiumHttpResponse> => {
        const controller = new AbortController()
        let timeout: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new Error(`HTTP request timed out after ${options.timeoutMs}ms`))
          }, options.timeoutMs)
        })
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => http(url, {
              headers: { accept: 'application/json' },
              signal: controller.signal,
            })),
            timeoutPromise,
          ])
          const status = finiteNumber(result.status) ?? (result.ok === false ? 500 : 200)
          if (status >= 200 && status < 300 && result.ok !== false) {
            if (typeof result.json !== 'function') {
              throw new ScannerPayloadError('HTTP response has no JSON body')
            }
            body = await Promise.race([result.json(), timeoutPromise])
            bodyRead = true
          }
          return result
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      }
      response = options.rateLimiter
        ? await options.rateLimiter.schedule(request)
        : await request()
    } catch (error) {
      if (error instanceof ScannerPayloadError) throw error
      lastError = error
      if (attempt >= options.maxRetries) throw error
      await options.sleep(defaultRetryDelayMs(attempt))
      continue
    }

    const status = finiteNumber(response.status) ?? (response.ok === false ? 500 : 200)
    if (status === 429 || status >= 500) {
      const error = new ScannerRequestError(`HTTP ${status}`, status)
      lastError = error
      if (attempt >= options.maxRetries) throw error
      await options.sleep(retryAfterMs(response.headers, options.now) ?? defaultRetryDelayMs(attempt))
      continue
    }
    if (status < 200 || status >= 300 || response.ok === false) {
      throw new ScannerRequestError(`HTTP ${status}`, status)
    }

    if (typeof response.json !== 'function') {
      throw new ScannerPayloadError('HTTP response has no JSON body')
    }
    if (bodyRead) return body
    try {
      return await response.json()
    } catch (error) {
      throw new ScannerPayloadError(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('HTTP request failed')
}

function readNextPageId(record: JsonRecord): string | undefined {
  return nonEmptyString(record.nextPageId)
    ?? nonEmptyString(record.nextPageID)
    ?? nonEmptyString(record.nextCursor)
    ?? undefined
}

function parseRaydiumPage(payload: unknown): RaydiumPage {
  const root = asRecord(payload)
  if (!root) throw new ScannerPayloadError('Raydium response is not an object')
  if (root.success === false) throw new ScannerPayloadError('Raydium response reported success=false')

  const rootData = root.data
  const outer = asRecord(rootData) ?? root
  const nestedData = outer.data
  const items = Array.isArray(nestedData)
    ? nestedData
    : Array.isArray(rootData)
      ? rootData
      : null
  if (!items) throw new ScannerPayloadError('Raydium response has no pool data array')

  const nextPageId = readNextPageId(outer) ?? readNextPageId(root)
  const hasNextRaw = outer.hasNextPage ?? root.hasNextPage
  const hasNextPage = typeof hasNextRaw === 'boolean' ? hasNextRaw : nextPageId !== undefined
  return { items, hasNextPage, nextPageId }
}

function tokenLabel(value: unknown): string | null {
  if (typeof value === 'string') return nonEmptyString(value)
  const token = asRecord(value)
  if (!token) return null
  const symbol = nonEmptyString(token.symbol)
  if (symbol) return symbol
  const address = nonEmptyString(token.address) ?? nonEmptyString(token.mint)
  return address ? address.slice(0, 4) : null
}

function isDynamicFeePool(pool: JsonRecord): boolean {
  const config = asRecord(pool.config)
  return pool.hasDynamicFee === true
    || pool.hasDynamicFee === 'true'
    || pool.dynamicFee === true
    || (pool.dynamicFeeConfig !== undefined && pool.dynamicFeeConfig !== null && pool.dynamicFeeConfig !== '')
    || config?.hasDynamicFee === true
    || (finiteNumber(config?.dynamicFeeControl) ?? 0) > 0
}

function parseCandidate(pool: unknown, minTvlUsd: number): {
  candidate?: ScanCandidate
  validTvl?: number
  lowTvl: boolean
  invalid: boolean
  dynamic: boolean
} {
  const record = asRecord(pool)
  if (!record) return { lowTvl: false, invalid: true, dynamic: false }

  const tvl = nonNegativeNumber(record.tvl ?? record.liquidity)
  if (tvl === null) return { lowTvl: false, invalid: true, dynamic: false }
  if (tvl < minTvlUsd) return { lowTvl: true, validTvl: tvl, invalid: false, dynamic: false }

  if (record.type !== 'Concentrated') {
    return { lowTvl: false, validTvl: tvl, invalid: true, dynamic: false }
  }
  if (typeof record.hasDynamicFee !== 'boolean') {
    return { lowTvl: false, validTvl: tvl, invalid: true, dynamic: false }
  }
  if (isDynamicFeePool(record)) {
    return { lowTvl: false, validTvl: tvl, invalid: false, dynamic: true }
  }

  const poolId = nonEmptyString(record.id)
  const symbolA = tokenLabel(record.mintA)
  const symbolB = tokenLabel(record.mintB)
  const config = asRecord(record.config)
  const tradeFeeRate = finiteNumber(config?.tradeFeeRate)
  const protocolFeeRate = finiteNumber(config?.protocolFeeRate)
  const fundFeeRate = finiteNumber(config?.fundFeeRate)
  const ratesValid = tradeFeeRate !== null
    && protocolFeeRate !== null
    && fundFeeRate !== null
    && tradeFeeRate >= 0
    && protocolFeeRate >= 0
    && fundFeeRate >= 0
    && tradeFeeRate <= RAYDIUM_RATE_DENOMINATOR
    && protocolFeeRate <= RAYDIUM_RATE_DENOMINATOR
    && fundFeeRate <= RAYDIUM_RATE_DENOMINATOR
    && protocolFeeRate + fundFeeRate <= RAYDIUM_RATE_DENOMINATOR
  if (!poolId || !symbolA || !symbolB || !ratesValid) {
    return { lowTvl: false, validTvl: tvl, invalid: true, dynamic: false }
  }

  return {
    lowTvl: false,
    validTvl: tvl,
    invalid: false,
    dynamic: false,
    candidate: {
      poolId,
      symbolA,
      symbolB,
      tvlUsd: tvl,
      tradeFeeRate,
      protocolFeeRate,
      fundFeeRate,
    },
  }
}

function parseDexPair(payload: unknown, poolId: string): DexPairData | null {
  const root = asRecord(payload)
  if (!root) return null
  const nested = asRecord(root.data)
  const pairs = Array.isArray(root.pairs)
    ? root.pairs
    : nested && Array.isArray(nested.pairs)
      ? nested.pairs
      : null
  if (!pairs) return null

  const match = pairs.find(item => {
    const pair = asRecord(item)
    if (!pair) return false
    const chainId = nonEmptyString(pair.chainId)?.toLowerCase()
    const dexId = nonEmptyString(pair.dexId)?.toLowerCase()
    return pair.pairAddress === poolId && chainId === 'solana' && dexId === 'raydium'
  })
  const pair = asRecord(match)
  if (!pair) return null
  const volume = asRecord(pair.volume)
  const volume1hUsd = nonNegativeNumber(volume?.h1)
  if (volume1hUsd === null) return null
  return { volume1hUsd }
}

function copyStats(stats: RaydiumScanStats): RaydiumScanStats {
  return { ...stats }
}

function emptyStats(): RaydiumScanStats {
  return {
    discovered: 0,
    eligible: 0,
    checked: 0,
    belowVolume: 0,
    dynamicFee: 0,
    invalid: 0,
    failed: 0,
  }
}

function normaliseInteger(value: number | undefined, fallback: number, minimum: number): number {
  return value !== undefined && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback
}

export function createRaydiumPoolScanner(options: RaydiumPoolScannerOptions = {}): RaydiumPoolScanner {
  const http = options.http ?? options.fetch ?? defaultHttp
  const now = options.now ?? options.clock ?? Date.now
  const sleep = options.sleep ?? wait
  const timeoutMs = normaliseInteger(options.timeoutMs, RAYDIUM_REQUEST_TIMEOUT_MS, 1)
  const maxRetries = normaliseInteger(options.maxRetries, RAYDIUM_MAX_RETRIES, 0)
  const pageSize = Math.min(normaliseInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1), 100)
  const minTvlUsd = options.minTvlUsd !== undefined && Number.isFinite(options.minTvlUsd) && options.minTvlUsd >= 0
    ? options.minTvlUsd
    : RAYDIUM_MIN_TVL_USD
  const minVolume1hUsd = options.minVolume1hUsd !== undefined && Number.isFinite(options.minVolume1hUsd) && options.minVolume1hUsd >= 0
    ? options.minVolume1hUsd
    : RAYDIUM_MIN_VOLUME_1H_USD
  const cacheTtlMs = options.cacheTtlMs !== undefined && Number.isFinite(options.cacheTtlMs) && options.cacheTtlMs >= 0
    ? options.cacheTtlMs
    : RAYDIUM_CACHE_TTL_MS
  const raydiumBaseUrl = (options.raydiumBaseUrl ?? RAYDIUM_API_BASE_URL).replace(/\/$/, '')
  const dexScreenerBaseUrl = (options.dexScreenerBaseUrl ?? DEXSCREENER_API_BASE_URL).replace(/\/$/, '')
  const dsConcurrency = normaliseInteger(options.dsConcurrency, RAYDIUM_DS_CONCURRENCY, 1)
  const dsRateLimit = normaliseInteger(options.dsRateLimitPerMinute, RAYDIUM_DS_RATE_LIMIT_PER_MINUTE, 1)
  const rateLimiter = options.rateLimiter
    ?? (options.dsConcurrency !== undefined || options.dsRateLimitPerMinute !== undefined
      ? new RequestRateLimiter(dsRateLimit, dsConcurrency, now, sleep)
      : defaultDexScreenerLimiter)
  let activeScan: Promise<RaydiumPoolScanResult> | null = null
  let cached: RaydiumPoolScanResult | null = null
  let progressSubscribers = new Set<(progress: RaydiumScanProgress) => void | Promise<void>>()

  const emitOne = (onProgress: ((progress: RaydiumScanProgress) => void | Promise<void>) | undefined, phase: string, stats: RaydiumScanStats): void => {
    if (!onProgress) return
    try {
      const result = onProgress({ phase, ...copyStats(stats) })
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch(() => undefined)
      }
    } catch {
      // Progress reporting must not turn a read-only scan into a failed scan.
    }
  }

  const emit = (phase: string, stats: RaydiumScanStats): void => {
    for (const onProgress of [...progressSubscribers]) emitOne(onProgress, phase, stats)
  }

  const scanInternal = async (): Promise<RaydiumPoolScanResult> => {
    const startedAt = now()
    const stats = emptyStats()
    let partial = false
    const candidates: ScanCandidate[] = []
    const seenPools = new Set<string>()
    const seenCursors = new Set<string>()
    let nextPageId: string | undefined
    emit('discovering', stats)

    while (true) {
      const cursorKey = nextPageId ?? ''
      if (seenCursors.has(cursorKey)) {
        partial = true
        stats.failed++
        emit('pagination_error', stats)
        break
      }
      seenCursors.add(cursorKey)

      const url = new URL(`${raydiumBaseUrl}/pools/info/list-v2`)
      url.searchParams.set('size', String(pageSize))
      url.searchParams.set('poolType', 'Concentrated')
      url.searchParams.set('sortField', 'liquidity')
      url.searchParams.set('sortType', 'desc')
      url.searchParams.set('hasReward', 'false')
      if (nextPageId) url.searchParams.set('nextPageId', nextPageId)

      let page: RaydiumPage
      try {
        page = parseRaydiumPage(await requestJson(http, url.toString(), { timeoutMs, maxRetries, sleep, now }))
      } catch (error) {
        partial = true
        stats.failed++
        emit('raydium_error', stats)
        console.log(`[raydium] pool list failed: ${error instanceof Error ? error.message : String(error)}`)
        break
      }

      let pageHasLowTvl = false
      for (const rawPool of page.items) {
        const rawRecord = asRecord(rawPool)
        const rawId = nonEmptyString(rawRecord?.id)
        if (rawId && seenPools.has(rawId)) continue
        if (rawId) seenPools.add(rawId)
        stats.discovered++

        const parsed = parseCandidate(rawPool, minTvlUsd)
        pageHasLowTvl ||= parsed.lowTvl
        if (parsed.invalid) {
          stats.invalid++
          continue
        }
        if (parsed.dynamic) {
          stats.dynamicFee++
          continue
        }
        if (parsed.candidate) {
          candidates.push(parsed.candidate)
          stats.eligible++
        }
      }
      emit('discovering', stats)

      if (!page.hasNextPage) break
      if (!page.nextPageId || page.nextPageId === nextPageId) {
        partial = true
        stats.failed++
        emit('pagination_error', stats)
        break
      }
      nextPageId = page.nextPageId
      if (pageHasLowTvl) break
    }

    const scored: RaydiumScanPool[] = []
    let nextCandidate = 0
    const workerCount = Math.min(dsConcurrency, candidates.length)
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextCandidate++
        const candidate = candidates[index]
        if (!candidate) return
        stats.checked++
        emit('checking', stats)
        const url = `${dexScreenerBaseUrl}/${encodeURIComponent(candidate.poolId)}`
        let pair: DexPairData | null
        try {
          pair = parseDexPair(await requestJson(http, url, {
            timeoutMs,
            maxRetries,
            sleep,
            now,
            rateLimiter,
          }), candidate.poolId)
        } catch (error) {
          partial = true
          stats.failed++
          emit('dexscreener_error', stats)
          console.log(`[raydium] DexScreener failed for ${candidate.poolId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (!pair) {
          stats.invalid++
          emit('invalid_pair', stats)
          continue
        }
        if (pair.volume1hUsd < minVolume1hUsd) {
          stats.belowVolume++
          emit('below_volume', stats)
          continue
        }

        const lpShare = 1 - ((candidate.protocolFeeRate + candidate.fundFeeRate) / RAYDIUM_RATE_DENOMINATOR)
        const estimatedLpFees1hUsd = pair.volume1hUsd
          * (candidate.tradeFeeRate / RAYDIUM_RATE_DENOMINATOR)
          * lpShare
        const estimatedYieldPctPerHour = (estimatedLpFees1hUsd / candidate.tvlUsd) * 100
        if (!Number.isFinite(estimatedLpFees1hUsd) || !Number.isFinite(estimatedYieldPctPerHour)) {
          stats.invalid++
          emit('invalid_calculation', stats)
          continue
        }
        scored.push({
          poolId: candidate.poolId,
          symbolA: candidate.symbolA,
          symbolB: candidate.symbolB,
          tvlUsd: candidate.tvlUsd,
          volume1hUsd: pair.volume1hUsd,
          estimatedLpFees1hUsd,
          estimatedYieldPctPerHour,
          tradeFeeRate: candidate.tradeFeeRate,
        })
        emit('checked', stats)
      }
    }
    if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, () => worker()))

    scored.sort((left, right) => {
      const yieldDelta = right.estimatedYieldPctPerHour - left.estimatedYieldPctPerHour
      if (yieldDelta !== 0) return yieldDelta
      const feeDelta = right.estimatedLpFees1hUsd - left.estimatedLpFees1hUsd
      if (feeDelta !== 0) return feeDelta
      const volumeDelta = right.volume1hUsd - left.volume1hUsd
      if (volumeDelta !== 0) return volumeDelta
      return left.poolId.localeCompare(right.poolId)
    })

    const completedAt = now()
    const result: RaydiumPoolScanResult = {
      startedAt,
      completedAt,
      pools: scored.slice(0, RAYDIUM_SCAN_LIMIT),
      stats: copyStats(stats),
      partial,
    }
    cached = result
    return result
  }

  return {
    scan(onProgress) {
      if (activeScan) {
        if (onProgress) progressSubscribers.add(onProgress)
        return activeScan
      }
      const current = now()
      if (cached && current - cached.completedAt < cacheTtlMs) {
        emitOne(onProgress, 'cached', cached.stats)
        return Promise.resolve(cached)
      }
      progressSubscribers = new Set(onProgress ? [onProgress] : [])
      const promise = scanInternal()
      activeScan = promise
      const clearActiveScan = () => {
        if (activeScan === promise) {
          activeScan = null
          progressSubscribers.clear()
        }
      }
      void promise.then(clearActiveScan, clearActiveScan)
      return promise
    },
  }
}

const defaultScanner = createRaydiumPoolScanner()

export function scanRaydiumPools(
  onProgress?: (progress: RaydiumScanProgress) => void | Promise<void>,
): Promise<RaydiumPoolScanResult> {
  return defaultScanner.scan(onProgress)
}
