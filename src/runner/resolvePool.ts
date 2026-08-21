import DLMM, { getPriceOfBinByBinId } from '@meteora-ag/dlmm'
import { Connection, PublicKey } from '@solana/web3.js'
import { getPool } from '../meteora/positions.js'
import { type DiscoveredDlmmPool, SOL_MINT } from './gates.js'

interface DatapiPool {
  address?: string
  tvl?: number
  is_blacklisted?: boolean
  token_x?: { address?: string }
  token_y?: { address?: string }
}

export async function discoverMintPools(connection: Connection, mint: string, knownPoolPubkeys: string[], forceGpa: boolean): Promise<DiscoveredDlmmPool[]> {
  const addresses = new Set(knownPoolPubkeys)
  if (forceGpa || addresses.size === 0) {
    for (const address of await listLbPairAddressesForMint(connection, mint)) {
      addresses.add(address)
    }
  }
  const pools: DiscoveredDlmmPool[] = []
  for (const address of addresses) {
    const meta = await fetchDatapiPool(address)
    if (!meta) continue
    const tokenXMint = meta.token_x?.address || ''
    const tokenYMint = meta.token_y?.address || ''
    if (tokenXMint !== mint && tokenYMint !== mint) continue
    pools.push({
      poolPubkey: meta.address || address,
      tokenXMint,
      tokenYMint,
      tvlUsd: Number(meta.tvl) || 0,
      blacklisted: meta.is_blacklisted === true,
    })
  }
  return pools
}

export async function entryDriftPct(connection: Connection, poolPubkey: string, upperBinId: number): Promise<number | null> {
  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const activeBinId = pool.lbPair.activeId
    const current = Number(pool.fromPricePerLamport(Number(getPriceOfBinByBinId(activeBinId, pool.lbPair.binStep))))
    const upper = Number(pool.fromPricePerLamport(Number(getPriceOfBinByBinId(upperBinId, pool.lbPair.binStep))))
    if (!(upper > 0) || !Number.isFinite(current)) return null
    return (current - upper) / upper
  } catch (err) {
    console.log(`[runner] drift read failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export async function readActiveBin(connection: Connection, poolPubkey: string): Promise<number | null> {
  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    return pool.lbPair.activeId
  } catch {
    return null
  }
}

async function listLbPairAddressesForMint(connection: Connection, mint: string): Promise<string[]> {
  const pairs = await DLMM.getLbPairs(connection)
  const addresses: string[] = []
  for (const pair of pairs as Array<{ publicKey?: PublicKey; account?: { tokenXMint?: PublicKey; tokenYMint?: PublicKey } }>) {
    const tokenX = pair.account?.tokenXMint?.toBase58?.() || ''
    const tokenY = pair.account?.tokenYMint?.toBase58?.() || ''
    if (tokenX !== mint && tokenY !== mint) continue
    const address = pair.publicKey?.toBase58?.()
    if (address) addresses.push(address)
  }
  return addresses
}

async function fetchDatapiPool(address: string): Promise<DatapiPool | null> {
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${address}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    return await res.json() as DatapiPool
  } catch {
    return null
  }
}

export { SOL_MINT }
