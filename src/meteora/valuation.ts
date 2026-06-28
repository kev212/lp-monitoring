/**
 * Position valuation using Meteora PnL API (per-position).
 *
 * Endpoint: GET /positions/{pool_address}/pnl?user={wallet}&status=open
 * Returns per-position PnL data directly from Meteora.
 * No external price oracles — pure Meteora data.
 */
const PNL_API_BASE = 'https://dlmm.datapi.meteora.ag/positions'
const CACHE_TTL_MS = 2_000

interface PnlPositionData {
  pnlPctChange?: string | number
  pnlSolPctChange?: string | number
  pnlSol?: string | number
  pnlUsd?: string | number
  unrealizedPnl?: {
    balancesSol?: string | number
    balances?: string | number
    unclaimedFeeTokenX?: { amountSol?: string | number; usd?: string | number }
    unclaimedFeeTokenY?: { amountSol?: string | number; usd?: string | number }
  }
  allTimeDeposits?: { total?: { sol?: string | number; usd?: string | number } }
  allTimeFees?: { total?: { sol?: string | number; usd?: string | number } }
  feePerTvl24h?: string | number
  isOutOfRange?: boolean
  lowerBinId?: number
  upperBinId?: number
  poolActiveBinId?: number
  createdAt?: number
  tokenXPrice?: string
  tokenYPrice?: string
}

export interface ValuationResult {
  estimatedExitSol: number
  tokenXValueSol: number
  tokenYValueSol: number
  depositEstimateSol: number
  allTimeDepositSol: number
  tokenXAmount: number
  tokenYAmount: number
  tokenXFees: number
  tokenYFees: number
  tokenXPriceSol: number
  tokenYPriceSol: number
  solUsdPrice: number
  /** PnL % langsung dari Meteora PnL API (USD basis — includes SOL price movement) */
  meteoraPnlPct?: number
  /** PnL % SOL basis (pure position perf, excludes SOL price volatility) */
  meteoraPnlSolPct?: number
  /** PnL dalam SOL langsung dari Meteora */
  meteoraPnlSol?: number
  /** Bin position data for range-based triggers */
  lowerBinId?: number
  upperBinId?: number
  poolActiveBinId?: number
}

const cache = new Map<string, { ts: number; data: any }>()

async function fetchPositionPnl(
  poolAddress: string,
  walletAddress: string,
  positionPubkey?: string,
): Promise<PnlPositionData | null> {
  const cacheKey = `${walletAddress}:${poolAddress}:${positionPubkey || 'default'}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  try {
    const url = `${PNL_API_BASE}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.log(`[pnl_api] HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}`)
      return null
    }
    const data = await res.json()
    const positions: any[] = data.positions || []
    if (positions.length === 0) {
      cache.set(cacheKey, { ts: Date.now(), data: null })
      return null
    }
    // Match by positionPubkey; return null if not found (closed on-chain)
    const p = positionPubkey
      ? positions.find((pos: any) => pos.positionAddress === positionPubkey)
      : positions[0]
    if (!p) {
      cache.set(cacheKey, { ts: Date.now(), data: null })
      return null
    }
    const result: PnlPositionData = {
      pnlPctChange: p.pnlPctChange,
      pnlSolPctChange: p.pnlSolPctChange,
      pnlSol: p.pnlSol,
      pnlUsd: p.pnlUsd,
      unrealizedPnl: p.unrealizedPnl,
      allTimeDeposits: p.allTimeDeposits,
      allTimeFees: p.allTimeFees,
      feePerTvl24h: p.feePerTvl24h,
      isOutOfRange: p.isOutOfRange,
      lowerBinId: p.lowerBinId,
      upperBinId: p.upperBinId,
      poolActiveBinId: p.poolActiveBinId,
      createdAt: p.createdAt,
      tokenXPrice: data.tokenXPrice,
      tokenYPrice: data.tokenYPrice,
    }
    cache.set(cacheKey, { ts: Date.now(), data: result })
    return result
  } catch (err) {
    console.log(`[pnl_api] error for pool ${poolAddress.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export async function estimateExitValue(
  poolPubkey: string,
  walletAddress?: string,
  positionPubkey?: string,
): Promise<ValuationResult | null> {
  // Try Meteora PnL API first (most accurate)
  if (walletAddress) {
    const pnlData = await fetchPositionPnl(poolPubkey, walletAddress, positionPubkey)
    if (pnlData && pnlData.unrealizedPnl) {
      const balancesSol = Number(pnlData.unrealizedPnl.balancesSol || 0)
      if (balancesSol > 0) {
        const pnlSol = Number(pnlData.pnlSol || 0)
        let tokenXPriceSol = 0
        let solUsdPrice = 0
        if (pnlData.tokenXPrice) tokenXPriceSol = Number(pnlData.tokenXPrice) / (pnlData.tokenYPrice ? Number(pnlData.tokenYPrice) : 1)
        if (pnlData.tokenYPrice) {
          solUsdPrice = Number(pnlData.tokenYPrice)
        }
        return {
          estimatedExitSol: balancesSol,
          tokenXValueSol: 0,
          tokenYValueSol: 0,
          depositEstimateSol: Math.max(0, balancesSol - pnlSol),
          allTimeDepositSol: Number(pnlData.allTimeDeposits?.total?.sol || 0),
          tokenXAmount: 0,
          tokenYAmount: 0,
          tokenXFees: 0,
          tokenYFees: 0,
          tokenXPriceSol,
          tokenYPriceSol: 1,
          solUsdPrice,
          meteoraPnlPct: Number(pnlData.pnlPctChange || 0),
          meteoraPnlSolPct: Number(pnlData.pnlSolPctChange || 0),
          meteoraPnlSol: Number(pnlData.pnlSol || 0),
          lowerBinId: pnlData.lowerBinId,
          upperBinId: pnlData.upperBinId,
          poolActiveBinId: pnlData.poolActiveBinId,
        }
      }
    }
  }

  return null
}

export function clearPnlCache(): void {
  cache.clear()
}
