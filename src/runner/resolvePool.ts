import { getPriceOfBinByBinId } from '@meteora-ag/dlmm'
import { Connection, PublicKey } from '@solana/web3.js'
import { getPool } from '../meteora/positions.js'
import { withRpcFallback } from '../solana/connection.js'
import { entryDriftFromPrices, SOL_MINT, type DiscoveredDlmmPool } from './gates.js'

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
const TOKEN_X_MINT_OFFSET = 88
const TOKEN_Y_MINT_OFFSET = 120

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

export async function entryDriftPct(connection: Connection, poolPubkey: string, lowerBinId: number, upperBinId: number): Promise<number | null> {
  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const pair = pool.lbPair as { tokenXMint?: PublicKey; tokenYMint?: PublicKey }
    const x = pair.tokenXMint?.toBase58?.() || ''
    const y = pair.tokenYMint?.toBase58?.() || ''
    const quoteSide = x === SOL_MINT ? 'X' : y === SOL_MINT ? 'Y' : null
    if (!quoteSide) return null
    const priceOf = (binId: number) => Number(pool.fromPricePerLamport(Number(getPriceOfBinByBinId(binId, pool.lbPair.binStep))))
    return entryDriftFromPrices({
      quoteSide,
      currentPoolPrice: priceOf(pool.lbPair.activeId),
      lowerBinPrice: priceOf(lowerBinId),
      upperBinPrice: priceOf(upperBinId),
    })
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
  const mintBytes = new PublicKey(mint).toBase58()
  const offsets = [TOKEN_X_MINT_OFFSET, TOKEN_Y_MINT_OFFSET]
  const found: string[] = []
  for (const offset of offsets) {
    try {
      const accounts = await withRpcFallback(rpc => rpc.getProgramAccounts(DLMM_PROGRAM_ID, {
        filters: [{ memcmp: { offset, bytes: mintBytes } }],
        dataSlice: { offset: 0, length: 0 },
      }), connection)
      for (const account of accounts) found.push(account.pubkey.toBase58())
    } catch (err) {
      console.log(`[runner] pool lookup failed at offset ${offset}: ${err instanceof Error ? err.message : 'unknown'}`)
    }
  }
  return [...new Set(found)]
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
