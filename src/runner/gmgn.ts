import { config } from '../config.js'

export interface GmgnSnapshot {
  marketCapUsd: number | null
  athMarketCapUsd: number | null
  volume5mUsd: number | null
  holders: number | null
}

export async function fetchGmgnSnapshot(mint: string): Promise<GmgnSnapshot | null> {
  if (!config.gmgnApiKey) return null
  try {
    const url = `https://gmgn.ai/vas/api/v1/token_info?chain=sol&address=${encodeURIComponent(mint)}`
    const res = await fetch(url, {
      headers: {
        'X-API-KEY': config.gmgnApiKey,
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.log(`[runner] gmgn HTTP ${res.status}`)
      return null
    }
    const payload = await res.json() as Record<string, unknown>
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>
    return {
      marketCapUsd: pickNumber(data, ['market_cap', 'marketCap', 'mc']),
      athMarketCapUsd: pickNumber(data, ['history_highest_market_cap', 'ath_market_cap', 'highest_market_cap']),
      volume5mUsd: pickVolume5m(data),
      holders: pickNumber(data, ['holder_count', 'holders', 'holderCount']),
    }
  } catch (err) {
    console.log(`[runner] gmgn fetch failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

function pickNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key]
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickVolume5m(data: Record<string, unknown>): number | null {
  const direct = pickNumber(data, ['volume_5m', 'volume5m', 'volume_5min'])
  if (direct !== null) return direct
  const volume = data.volume
  if (volume && typeof volume === 'object') {
    return pickNumber(volume as Record<string, unknown>, ['5m', 'm5'])
  }
  return null
}
