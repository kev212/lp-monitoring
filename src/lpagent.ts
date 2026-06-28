/**
 * LP Agent API client — independent PnL source for cross-checking Meteora.
 *
 * Endpoint: GET /lp-positions/opening?owner={wallet}&protocol=meteora
 * Returns per-position PnL calculated independently from Meteora API.
 */
import { config } from './config.js'

const API_BASE = 'https://api.lpagent.io/open-api/v1'
const CACHE_TTL_MS = 20_000
const API_MIN_INTERVAL_MS = 15_000
const COOLDOWN_429_MS = 60_000

let lastApiCallTime = 0
let cooldownUntil = 0

export interface LpAgentPosition {
  tokenId: string
  pairName: string
  pnlPercentNative: number
  pnlValueNative: number
  valueNative: number
  inputNative: number
  inputToken0: string
  inputToken1: string
  decimal0: number
  decimal1: number
  token0: string
  token1: string
}

interface LpAgentCacheEntry {
  ts: number
  data: Map<string, LpAgentPosition>
}

const cache = new Map<string, LpAgentCacheEntry>()

export async function fetchLpAgentPositions(owner: string, force = false): Promise<Map<string, LpAgentPosition> | null> {
  if (!config.lpAgentApiKey) return null

  const now = Date.now()

  if (cooldownUntil > now) {
    console.log('[lpagent] 429 cooldown active — skipping')
    return null
  }

  const cached = cache.get(owner)

  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.data

  if (!force) {
    if (cached && now - lastApiCallTime < API_MIN_INTERVAL_MS) {
      return cached.data
    }
    if (now - lastApiCallTime < API_MIN_INTERVAL_MS) {
      return null
    }
  }

  lastApiCallTime = now
  try {
    const url = `${API_BASE}/lp-positions/opening?owner=${owner}&protocol=meteora`
    const res = await fetch(url, {
      headers: {
        'x-api-key': config.lpAgentApiKey,
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(8_000),
    })

    if (res.status === 429) {
      cooldownUntil = now + COOLDOWN_429_MS
      console.log('[lpagent] HTTP 429 — cooldown 60s')
      return null
    }

    if (!res.ok) {
      console.log(`[lpagent] HTTP ${res.status}`)
      return null
    }

    const body = await res.json()
    if (body.status !== 'success' || !Array.isArray(body.data)) {
      console.log(`[lpagent] unexpected response: ${body.status}`)
      return null
    }

    const positions = new Map<string, LpAgentPosition>()
    for (const p of body.data) {
      const pos = p.position || p.tokenId
      if (!pos) continue

      positions.set(pos, {
        tokenId: pos,
        pairName: p.pairName || '',
        pnlPercentNative: Number(p.pnl?.percentNative || 0),
        pnlValueNative: Number(p.pnl?.valueNative || 0),
        valueNative: Number(p.valueNative || 0),
        inputNative: Number(p.inputNative || 0),
        inputToken0: String(p.inputToken0 || '0'),
        inputToken1: String(p.inputToken1 || '0'),
        decimal0: Number(p.decimal0 || 0),
        decimal1: Number(p.decimal1 || 0),
        token0: String(p.token0 || ''),
        token1: String(p.token1 || ''),
      })
    }

    cache.set(owner, { ts: now, data: positions })
    return positions
  } catch (err) {
    console.log(`[lpagent] error: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export function clearLpAgentCache(): void {
  cache.clear()
}
