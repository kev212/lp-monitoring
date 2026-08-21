import { randomUUID } from 'node:crypto'
import { config } from '../config.js'

export interface GmgnSnapshot {
  marketCapUsd: number | null
  athMarketCapUsd: number | null
  volume5mUsd: number | null
  holders: number | null
}

export function parseGmgnTokenInfo(payload: unknown): GmgnSnapshot | null {
  const root = asRecord(payload)
  if (!root) return null
  const code = root.code
  if (code !== undefined && code !== 0) return null
  const data = root.data === undefined ? root : asRecord(root.data)
  if (!data) return null
  const price = asRecord(data.price) ?? {}
  const supply = pickNumber(data, ['circulating_supply', 'circulatingSupply', 'total_supply'])
  const spot = pickNumber(price, ['price']) ?? pickNumber(data, ['price'])
  const marketCapUsd = pickNumber(data, ['market_cap', 'marketCap', 'mc'])
    ?? multiply(spot, supply)
  const athPrice = pickNumber(data, ['ath_price', 'athPrice', 'history_highest_price'])
  const athMarketCapUsd = pickNumber(data, ['history_highest_market_cap', 'ath_market_cap', 'highest_market_cap'])
    ?? multiply(athPrice, supply)
  const volume5mUsd = pickNumber(price, ['volume_5m', 'volume5m'])
    ?? pickNumber(data, ['volume_5m', 'volume5m', 'volume_5min'])
    ?? pickNested(data.volume, ['5m', 'm5'])
  const holders = pickNumber(data, ['holder_count', 'holders', 'holderCount'])
  if ([marketCapUsd, athMarketCapUsd, volume5mUsd, holders].every(value => value === null)) return null
  return { marketCapUsd, athMarketCapUsd, volume5mUsd, holders }
}

export async function fetchGmgnSnapshot(mint: string): Promise<GmgnSnapshot | null> {
  if (!config.gmgnApiKey) return null
  try {
    const url = new URL('https://openapi.gmgn.ai/v1/token/info')
    url.searchParams.set('chain', 'sol')
    url.searchParams.set('address', mint)
    url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)))
    url.searchParams.set('client_id', randomUUID())
    const res = await fetch(url, {
      headers: {
        'X-APIKEY': config.gmgnApiKey,
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.log(`[runner] gmgn HTTP ${res.status}`)
      return null
    }
    return parseGmgnTokenInfo(await res.json())
  } catch (err) {
    console.log(`[runner] gmgn fetch failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function pickNumber(data: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = data[key]
    if (value === null || value === undefined || value === '' || typeof value === 'boolean' || Array.isArray(value)) continue
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickNested(value: unknown, keys: string[]): number | null {
  const record = asRecord(value)
  return record ? pickNumber(record, keys) : null
}

function multiply(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null
  const product = left * right
  return Number.isFinite(product) ? product : null
}
