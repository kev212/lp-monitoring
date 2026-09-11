import { PublicKey } from '@solana/web3.js'
import axios from 'axios'
import { config } from './config.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const CACHE_TTL = 60_000

const usdPriceCache = new Map<string, { price: number; at: number }>()

/**
 * Jupiter Price API v3 returns { data: { [mint]: { usdPrice } | null } }.
 * Older payloads used `price`, so accept both and skip zero/missing entries.
 */
export function parseJupiterUsdPrices(payload: unknown, mints: string[]): Map<string, number> {
  const prices = new Map<string, number>()
  const data = (payload as { data?: unknown } | null | undefined)?.data
  if (!data || typeof data !== 'object') return prices
  for (const mint of mints) {
    const entry = (data as Record<string, { usdPrice?: unknown; price?: unknown } | null>)[mint]
    if (!entry || typeof entry !== 'object') continue
    const price = Number(entry.usdPrice ?? entry.price)
    if (Number.isFinite(price) && price > 0) prices.set(mint, price)
  }
  return prices
}

/**
 * Fresh USD prices for the requested mints in a single batched request. Fresh
 * cache hits are reused for 60 seconds; failures are not cached so the next
 * refresh retries instead of pinning a zero price.
 */
export async function getTokenPricesInUsd(mints: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))]
  const prices = new Map<string, number>()
  const now = Date.now()
  const missing: string[] = []
  for (const mint of unique) {
    const cached = usdPriceCache.get(mint)
    if (cached && now - cached.at < CACHE_TTL) {
      prices.set(mint, cached.price)
      continue
    }
    missing.push(mint)
  }
  if (missing.length === 0) return prices

  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey
    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${missing.join(',')}`, { headers, timeout: 5_000 })
    for (const [mint, price] of parseJupiterUsdPrices(res.data, missing)) {
      usdPriceCache.set(mint, { price, at: now })
      prices.set(mint, price)
    }
  } catch {
    // Leave uncached mints out of the result so callers can fall back this round.
  }
  return prices
}

export async function getTokenPriceInSol(mint: PublicKey): Promise<number> {
  const mintStr = mint.toBase58()

  // SOL/WSOL = 1 SOL
  if (mintStr === WSOL_MINT) return 1

  const prices = await getTokenPricesInUsd([mintStr, WSOL_MINT])
  const tokenUsd = prices.get(mintStr) ?? 0
  const solUsd = prices.get(WSOL_MINT) ?? 0
  if (!(tokenUsd > 0) || !(solUsd > 0)) return 0
  return tokenUsd / solUsd
}

export async function getSolPriceInUsd(): Promise<number> {
  const prices = await getTokenPricesInUsd([WSOL_MINT])
  return prices.get(WSOL_MINT) ?? 0
}

export function clearPriceCache(): void {
  usdPriceCache.clear()
}
