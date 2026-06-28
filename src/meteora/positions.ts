import { Connection, PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'

export interface PositionDetail {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  tokenXSymbol: string
  tokenYSymbol: string
  tokenXDecimals: number
  tokenYDecimals: number
  totalXAmount: string
  totalYAmount: string
  feeX: string
  feeY: string
  lowerBinId: number
  upperBinId: number
  active: boolean
}

export interface DiscoveredPosition {
  poolPubkey: string
  positionPubkey: string
  tokenXMint: string
  tokenYMint: string
  tokenXSymbol: string
  tokenYSymbol: string
}

let poolCache = new Map<string, DLMM>()

// Cache for pool info from DLMM API (token symbols, names, decimals)
let poolInfoCache = new Map<string, { tokenXSymbol: string; tokenYSymbol: string; name: string; tokenXDecimals: number; tokenYDecimals: number }>()

// Cache for position detail on-chain data (reduce RPC calls)
let positionDetailCache = new Map<string, { data: PositionDetail; ts: number }>()
const POSITION_CACHE_TTL = 30_000 // 30 seconds

export async function getPool(connection: Connection, poolPubkey: PublicKey): Promise<DLMM> {
  const key = poolPubkey.toBase58()
  const cached = poolCache.get(key)
  if (cached) return cached

  const pool = await DLMM.create(connection, poolPubkey, { cluster: 'mainnet-beta' })
  poolCache.set(key, pool)
  return pool
}

export function clearPoolCache(): void {
  poolCache = new Map()
  poolInfoCache = new Map()
  positionDetailCache = new Map()
}

/** Fetch pool info from DLMM API — includes token symbols, names & decimals */
export async function getPoolInfo(poolAddress: string): Promise<{ tokenXSymbol: string; tokenYSymbol: string; name: string; tokenXDecimals: number; tokenYDecimals: number }> {
  const cached = poolInfoCache.get(poolAddress)
  if (cached) return cached

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return { tokenXSymbol: '', tokenYSymbol: '', name: '', tokenXDecimals: 9, tokenYDecimals: 9 }

    const data = await res.json()
    const info = {
      tokenXSymbol: data?.token_x?.symbol || '',
      tokenYSymbol: data?.token_y?.symbol || '',
      name: data?.name || '',
      tokenXDecimals: data?.token_x?.decimals ?? 9,
      tokenYDecimals: data?.token_y?.decimals ?? 9,
    }
    poolInfoCache.set(poolAddress, info)
    return info
  } catch {
    return { tokenXSymbol: '', tokenYSymbol: '', name: '', tokenXDecimals: 9, tokenYDecimals: 9 }
  }
}

function getTokenMint(dlmmPool: DLMM): { x: string; y: string } {
  const x = (dlmmPool.tokenX as any).mint?.toBase58?.() || (dlmmPool.lbPair as any)?.tokenXMint?.toBase58?.() || ''
  const y = (dlmmPool.tokenY as any).mint?.toBase58?.() || (dlmmPool.lbPair as any)?.tokenYMint?.toBase58?.() || ''
  return { x, y }
}

export async function getPositionDetail(
  connection: Connection,
  dlmmPool: DLMM,
  positionPubkey: PublicKey
): Promise<PositionDetail | null> {
  const cacheKey = positionPubkey.toBase58()
  const cached = positionDetailCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < POSITION_CACHE_TTL) {
    return cached.data
  }

  try {
    const pos = await dlmmPool.getPosition(positionPubkey)
    if (!pos) return null

    const pd = pos.positionData
    const mints = getTokenMint(dlmmPool)
    const xAmt = typeof pd.totalXAmount === 'string' ? pd.totalXAmount : String(pd.totalXAmount)
    const yAmt = typeof pd.totalYAmount === 'string' ? pd.totalYAmount : String(pd.totalYAmount)

    // Get token symbols from API (non-blocking, fallback to empty)
    const poolAddr = dlmmPool.pubkey.toBase58()
    const poolInfo = await getPoolInfo(poolAddr)
    const tokenXSymbol = poolInfo.tokenXSymbol || mints.x.slice(0, 4).toUpperCase()
    const tokenYSymbol = poolInfo.tokenYSymbol || mints.y.slice(0, 4).toUpperCase()

    const result: PositionDetail = {
      positionPubkey: positionPubkey.toBase58(),
      poolPubkey: poolAddr,
      tokenXMint: mints.x,
      tokenYMint: mints.y,
      tokenXSymbol,
      tokenYSymbol,
      tokenXDecimals: poolInfo.tokenXDecimals,
      tokenYDecimals: poolInfo.tokenYDecimals,
      totalXAmount: xAmt,
      totalYAmount: yAmt,
      feeX: (pd.feeX as any)?.toString?.() || '0',
      feeY: (pd.feeY as any)?.toString?.() || '0',
      lowerBinId: pd.lowerBinId,
      upperBinId: pd.upperBinId,
      active: xAmt !== '0' || yAmt !== '0',
    }

    positionDetailCache.set(cacheKey, { data: result, ts: Date.now() })
    return result
  } catch (err) {
    console.log(`[position] getPosition failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export async function getAllPositionsForWallet(
  connection: Connection,
  walletPubkey: PublicKey
): Promise<Array<DiscoveredPosition>> {
  // Priority 1: DLMM Data API — fast, no RPC rate limit
  const dlmmApiPositions = await getPositionsFromDlmmApi(walletPubkey.toBase58())
  if (dlmmApiPositions.length > 0) {
    console.log(`[discovery] DLMM API found ${dlmmApiPositions.length} positions for ${walletPubkey.toBase58().slice(0, 8)}`)
    return dlmmApiPositions
  }

  // Priority 2: Meteora Portfolio API — backup
  const portfolioPositions = await getPositionsFromPortfolioApi(walletPubkey.toBase58())
  if (portfolioPositions.length > 0) {
    console.log(`[discovery] Portfolio API found ${portfolioPositions.length} positions`)
    return portfolioPositions
  }

  // Priority 3: skip full on-chain scan (too slow, rate-limited)
  // DLMM API + Portfolio API is sufficient for periodic discovery
  return []
}

/** Fetch positions from DLMM Data API */
async function getPositionsFromDlmmApi(wallet: string): Promise<Array<DiscoveredPosition>> {
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/wallets/${wallet}/open_positions`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []

    return data.map((pos: any) => ({
      poolPubkey: pos.pool_address || pos.poolPubkey || '',
      positionPubkey: pos.address || pos.positionPubkey || pos.pubkey || '',
      tokenXMint: '',
      tokenYMint: '',
      tokenXSymbol: '',
      tokenYSymbol: '',
    })).filter((p: any) => p.poolPubkey && p.positionPubkey)
  } catch {
    return []
  }
}

/** Fetch positions from Meteora Portfolio API */
async function getPositionsFromPortfolioApi(wallet: string): Promise<Array<DiscoveredPosition>> {
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}&page_size=50`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const items = Array.isArray(data) ? data : data?.pools || []
    if (!Array.isArray(items)) return []

    return items.flatMap((pool: any) =>
      (pool.listPositions || []).map((posPubkey: string) => ({
        poolPubkey: pool.poolAddress || pool.poolPubkey || '',
        positionPubkey: posPubkey,
        tokenXMint: pool.tokenXMint || '',
        tokenYMint: pool.tokenYMint || '',
        tokenXSymbol: pool.tokenX || '',
        tokenYSymbol: pool.tokenY || '',
      }))
    ).filter((p: any) => p.poolPubkey && p.positionPubkey)
  } catch {
    return []
  }
}
