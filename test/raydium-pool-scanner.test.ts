import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createRaydiumPoolScanner,
  type RaydiumHttpClient,
  type RaydiumHttpResponse,
} from '../src/raydium/poolScanner.js'

function response(body: unknown, status = 200, headers: Record<string, string> = {}): RaydiumHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => body,
  }
}

function pool(
  id: string,
  tvl: number,
  tradeFeeRate: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'Concentrated',
    id,
    tvl,
    mintA: { symbol: `${id}-A`, address: `${id}-mint-a` },
    mintB: { symbol: `${id}-B`, address: `${id}-mint-b` },
    hasDynamicFee: false,
    config: { tradeFeeRate, protocolFeeRate: 0, fundFeeRate: 0 },
    ...overrides,
  }
}

function dexPair(poolId: string, volume1hUsd: number): Record<string, unknown> {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: poolId,
    baseToken: { symbol: 'BASE' },
    quoteToken: { symbol: 'QUOTE' },
    volume: { h1: volume1hUsd, h24: volume1hUsd * 24 },
  }
}

test('paginates Raydium CLMM pools, stops at the TVL boundary, and ranks by estimated LP yield', async () => {
  const raydiumUrls: string[] = []
  const dexUrls: string[] = []
  const pages = [
    response({
      success: true,
      data: {
        data: [
          pool('pool-a', 10_000, 10_000),
          pool('pool-b', 6_000, 5_000),
        ],
        nextPageId: 'cursor-1',
      },
    }),
    response({
      success: true,
      data: {
        data: [
          pool('pool-c', 5_000, 5_000),
          pool('pool-low-volume', 5_500, 100_000),
          pool('pool-low', 4_999, 100_000),
        ],
        nextPageId: 'cursor-2',
      },
    }),
  ]
  const volumes = new Map([
    ['pool-a', 100_000],
    ['pool-b', 20_000],
    ['pool-c', 40_000],
    ['pool-low-volume', 19_999],
  ])
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      raydiumUrls.push(url)
      return pages[raydiumUrls.length - 1] ?? response({ success: true, data: { data: [] } })
    }
    dexUrls.push(url)
    const id = [...volumes.keys()].find(candidate => url.endsWith(`/${candidate}`))
    return id ? response({ pairs: [dexPair(id, volumes.get(id) ?? 0)] }) : response({ pairs: [] })
  }

  const scanner = createRaydiumPoolScanner({
    http,
    sleep: async () => undefined,
    dsRateLimitPerMinute: 1_000,
  })
  const result = await scanner.scan()

  assert.equal(raydiumUrls.length, 2)
  assert.equal(raydiumUrls[0].includes('poolType=Concentrated'), true)
  assert.equal(raydiumUrls[0].includes('sortField=liquidity'), true)
  assert.equal(raydiumUrls[0].includes('sortType=desc'), true)
  assert.equal(raydiumUrls[1].includes('nextPageId=cursor-1'), true)
  assert.equal(raydiumUrls.some(url => url.includes('cursor-2')), false)
  assert.equal(dexUrls.length, 4)
  assert.equal(result.stats.discovered, 5)
  assert.equal(result.stats.eligible, 4)
  assert.equal(result.stats.checked, 4)
  assert.equal(result.stats.belowVolume, 1)
  assert.equal(result.pools.length, 3)
  assert.equal(result.pools[0].poolId, 'pool-a')
  assert.equal(result.pools[1].poolId, 'pool-c')
  assert.equal(result.pools[1].volume1hUsd, 40_000)
  assert.equal(result.pools[1].estimatedLpFees1hUsd, 200)
  assert.equal(result.pools[1].estimatedYieldPctPerHour, 4)
})

test('uses the configured LP share, rejects dynamic/invalid pools, and requires an exact Raydium pair', async () => {
  const pools = [
    pool('dynamic', 20_000, 10_000, { hasDynamicFee: true }),
    pool('invalid-rate', 20_000, 10_000, { config: { tradeFeeRate: -1, protocolFeeRate: 0, fundFeeRate: 0 } }),
    pool('wrong-type', 20_000, 10_000, { type: 'Standard' }),
    pool('wrong-pair', 20_000, 10_000),
    pool('valid', 20_000, 10_000, { config: { tradeFeeRate: 10_000, protocolFeeRate: 100_000, fundFeeRate: 50_000 } }),
  ]
  let dexRequests = 0
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      return response({ success: true, data: { data: pools } })
    }
    dexRequests++
    if (url.endsWith('/wrong-pair')) {
      return response({ pairs: [dexPair('different-pool', 100_000)] })
    }
    return response({ pairs: [dexPair('valid', 100_000)] })
  }
  const scanner = createRaydiumPoolScanner({ http, sleep: async () => undefined, dsRateLimitPerMinute: 1_000 })
  const result = await scanner.scan()

  assert.equal(result.stats.discovered, 5)
  assert.equal(result.stats.dynamicFee, 1)
  assert.equal(result.stats.invalid, 3)
  assert.equal(result.stats.eligible, 2)
  assert.equal(result.stats.checked, 2)
  assert.equal(dexRequests, 2)
  assert.equal(result.pools.length, 1)
  assert.equal(result.pools[0].poolId, 'valid')
  assert.equal(result.pools[0].estimatedLpFees1hUsd, 850)
  assert.equal(result.pools[0].estimatedYieldPctPerHour, 4.25)
})

test('retries transient HTTP failures, honors Retry-After, and marks exhausted failures partial', async () => {
  let dexAttempts = 0
  const delays: number[] = []
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      return response({ success: true, data: { data: [pool('pool-retry', 20_000, 10_000)] } })
    }
    dexAttempts++
    if (dexAttempts === 1) return response({ error: 'busy' }, 429, { 'Retry-After': '0' })
    if (dexAttempts === 2) return response({ error: 'busy' }, 503)
    return response({ pairs: [dexPair('pool-retry', 50_000)] })
  }
  const scanner = createRaydiumPoolScanner({
    http,
    sleep: async milliseconds => { delays.push(milliseconds) },
    dsRateLimitPerMinute: 1_000,
    maxRetries: 2,
  })
  const result = await scanner.scan()

  assert.equal(dexAttempts, 3)
  assert.deepEqual(delays, [0, 2_000])
  assert.equal(result.partial, false)
  assert.equal(result.pools.length, 1)

  const failedScanner = createRaydiumPoolScanner({
    http: async url => url.includes('/pools/info/list-v2')
      ? response({ success: true, data: { data: [pool('pool-failed', 20_000, 10_000)] } })
      : response({ error: 'down' }, 500),
    sleep: async () => undefined,
    dsRateLimitPerMinute: 1_000,
    maxRetries: 2,
  })
  const failed = await failedScanner.scan()
  assert.equal(failed.partial, true)
  assert.equal(failed.stats.failed, 1)
  assert.equal(failed.stats.checked, 1)
  assert.equal(failed.pools.length, 0)
})

test('coalesces concurrent scans and serves the completed result from the 60-second cache', async () => {
  let currentTime = 1_000_000
  let listCalls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      listCalls++
      await gate
      return response({ success: true, data: { data: [] } })
    }
    throw new Error('unexpected DexScreener request')
  }
  const scanner = createRaydiumPoolScanner({
    http,
    now: () => currentTime,
    sleep: async () => undefined,
    dsRateLimitPerMinute: 1_000,
  })
  const firstProgress: string[] = []
  const secondProgress: string[] = []
  const first = scanner.scan(progress => { firstProgress.push(progress.phase) })
  const second = scanner.scan(progress => { secondProgress.push(progress.phase) })
  assert.equal(first, second)
  release?.()
  await first
  assert.equal(firstProgress.includes('discovering'), true)
  assert.equal(secondProgress.includes('discovering'), true)
  await scanner.scan()
  assert.equal(listCalls, 1)
  currentTime += 60_000
  await scanner.scan()
  assert.equal(listCalls, 2)
})

test('marks repeated cursors as a partial scan, including an empty page', async () => {
  let listCalls = 0
  const http: RaydiumHttpClient = async url => {
    if (!url.includes('/pools/info/list-v2')) throw new Error('unexpected DexScreener request')
    listCalls++
    return response({ success: true, data: { data: [], nextPageId: 'same-cursor' } })
  }
  const scanner = createRaydiumPoolScanner({ http, sleep: async () => undefined })
  const result = await scanner.scan()

  assert.equal(listCalls, 2)
  assert.equal(result.partial, true)
  assert.equal(result.stats.discovered, 0)
  assert.equal(result.stats.failed, 1)
})

test('times out a hanging response body and retries it twice', async () => {
  let listCalls = 0
  const signals: AbortSignal[] = []
  const http: RaydiumHttpClient = async (url, init) => {
    if (!url.includes('/pools/info/list-v2')) throw new Error('unexpected DexScreener request')
    listCalls++
    if (init?.signal) signals.push(init.signal)
    return {
      status: 200,
      ok: true,
      json: () => new Promise<unknown>(() => undefined),
    }
  }
  const scanner = createRaydiumPoolScanner({
    http,
    timeoutMs: 5,
    maxRetries: 2,
    sleep: async () => undefined,
  })
  const result = await scanner.scan()

  assert.equal(listCalls, 3)
  assert.equal(signals.length, 3)
  assert.equal(signals.every(signal => signal.aborted), true)
  assert.equal(result.partial, true)
  assert.equal(result.stats.failed, 1)
})

test('requires volume.h1 and treats an explicit zero hour as valid low volume', async () => {
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      return response({ success: true, data: { data: [pool('missing-h1', 10_000, 10_000), pool('zero-h1', 10_000, 10_000)] } })
    }
    const poolId = url.endsWith('/missing-h1') ? 'missing-h1' : 'zero-h1'
    return poolId === 'missing-h1'
      ? response({ pairs: [{ ...dexPair(poolId, 0), volume: { h24: 1_000_000 } }] })
      : response({ pairs: [dexPair(poolId, 0)] })
  }
  const scanner = createRaydiumPoolScanner({ http, sleep: async () => undefined, dsRateLimitPerMinute: 1_000 })
  const result = await scanner.scan()

  assert.equal(result.stats.checked, 2)
  assert.equal(result.stats.invalid, 1)
  assert.equal(result.stats.belowVolume, 1)
  assert.equal(result.pools.length, 0)
})

test('continues past whitespace TVL and deduplicates candidates across pages', async () => {
  let listCalls = 0
  const checked: string[] = []
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      listCalls++
      return listCalls === 1
        ? response({ success: true, data: {
          data: [pool('first', 10_000, 10_000), pool('blank-tvl', 10_000, 10_000, { tvl: '   ' })],
          nextPageId: 'second-page',
        } })
        : response({ success: true, data: {
          data: [pool('first', 10_000, 10_000), pool('second', 5_000, 10_000)],
        } })
    }
    const poolId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    checked.push(poolId)
    return response({ pairs: [dexPair(poolId, 20_000)] })
  }
  const result = await createRaydiumPoolScanner({ http, dsRateLimitPerMinute: 1_000 }).scan()
  assert.equal(listCalls, 2)
  assert.equal(result.partial, false)
  assert.equal(result.stats.invalid, 1)
  assert.equal(result.stats.discovered, 3)
  assert.deepEqual(checked.sort(), ['first', 'second'])
  assert.deepEqual(result.pools.map(item => item.poolId), ['second', 'first'])
})

test('limits DexScreener to four concurrent requests and 240 starts per minute', async () => {
  let currentTime = 1_000_000
  let active = 0
  let maximumActive = 0
  const requestTimes: number[] = []
  const poolIds = Array.from({ length: 241 }, (_, index) => `pool-${String(index + 1).padStart(3, '0')}`)
  const http: RaydiumHttpClient = async (url: string) => {
    if (url.includes('/pools/info/list-v2')) {
      return response({ success: true, data: { data: poolIds.map(id => pool(id, 10_000, 10_000)) } })
    }
    active++
    maximumActive = Math.max(maximumActive, active)
    requestTimes.push(currentTime)
    await Promise.resolve()
    active--
    const poolId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    return response({ pairs: [dexPair(poolId, 20_000)] })
  }
  const scanner = createRaydiumPoolScanner({
    http,
    now: () => currentTime,
    sleep: async milliseconds => { currentTime += milliseconds },
    dsConcurrency: 4,
    dsRateLimitPerMinute: 240,
  })
  const result = await scanner.scan()

  assert.equal(result.stats.checked, 241)
  assert.equal(result.pools.length, 10)
  assert.equal(maximumActive, 4)
  assert.equal(requestTimes.length, 241)
  assert.equal(requestTimes.slice(0, 240).every(time => time === 1_000_000), true)
  assert.equal(requestTimes[240] >= 1_060_000, true)
})

test('uses deterministic pool-id ordering when the top-ten scores tie', async () => {
  const poolIds = Array.from({ length: 11 }, (_, index) => `tie-${String(index + 1).padStart(2, '0')}`)
  const http: RaydiumHttpClient = async url => {
    if (url.includes('/pools/info/list-v2')) {
      return response({ success: true, data: { data: poolIds.map(id => pool(id, 10_000, 10_000)) } })
    }
    const poolId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    return response({ pairs: [dexPair(poolId, 20_000)] })
  }
  const scanner = createRaydiumPoolScanner({ http, sleep: async () => undefined, dsRateLimitPerMinute: 1_000 })
  const result = await scanner.scan()

  assert.deepEqual(result.pools.map(item => item.poolId), poolIds.slice(0, 10))
})

test('does not infer static fees from missing flags or whitespace fee rates', async () => {
  const http: RaydiumHttpClient = async url => {
    if (!url.includes('/pools/info/list-v2')) throw new Error('unexpected DexScreener request')
    return response({
      success: true,
      data: {
        data: [
          pool('missing-dynamic-flag', 10_000, 10_000, { hasDynamicFee: undefined }),
          pool('whitespace-fee', 10_000, 10_000, { config: { tradeFeeRate: ' ', protocolFeeRate: 0, fundFeeRate: 0 } }),
        ],
      },
    })
  }
  const scanner = createRaydiumPoolScanner({ http, sleep: async () => undefined })
  const result = await scanner.scan()

  assert.equal(result.stats.eligible, 0)
  assert.equal(result.stats.invalid, 2)
  assert.equal(result.stats.checked, 0)
})
