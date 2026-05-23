import { Connection, PublicKey } from '@solana/web3.js'
import DLMM from '@meteora-ag/dlmm'

export interface PositionDetail {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  totalXAmount: string
  totalYAmount: string
  feeX: string
  feeY: string
  lowerBinId: number
  upperBinId: number
  active: boolean
}

let poolCache = new Map<string, DLMM>()

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
  try {
    const pos = await dlmmPool.getPosition(positionPubkey)
    if (!pos) return null

    const pd = pos.positionData
    const mints = getTokenMint(dlmmPool)
    const xAmt = typeof pd.totalXAmount === 'string' ? pd.totalXAmount : String(pd.totalXAmount)
    const yAmt = typeof pd.totalYAmount === 'string' ? pd.totalYAmount : String(pd.totalYAmount)

    return {
      positionPubkey: positionPubkey.toBase58(),
      poolPubkey: dlmmPool.pubkey.toBase58(),
      tokenXMint: mints.x,
      tokenYMint: mints.y,
      totalXAmount: xAmt,
      totalYAmount: yAmt,
      feeX: (pd.feeX as any)?.toString?.() || '0',
      feeY: (pd.feeY as any)?.toString?.() || '0',
      lowerBinId: pd.lowerBinId,
      upperBinId: pd.upperBinId,
      active: xAmt !== '0' || yAmt !== '0',
    }
  } catch (err) {
    console.log(`[position] getPosition failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export async function getAllPositionsForWallet(
  connection: Connection,
  walletPubkey: PublicKey
): Promise<Array<{ poolPubkey: string; positionPubkey: string }>> {
  const discovered = new Map<string, string>()

  try {
    const allPairs = await DLMM.getLbPairs(connection, { cluster: 'mainnet-beta' })
    console.log(`[discovery] found ${allPairs.length} total DLMM pairs on chain`)

    for (const pair of allPairs) {
      const pairPubkey = (pair as any).publicKey?.toBase58?.() || (pair as any).pubkey?.toBase58?.()
      if (!pairPubkey) continue

      try {
        const pool = await getPool(connection, new PublicKey(pairPubkey))
        const userPositions = await pool.getPositionsByUserAndLbPair(walletPubkey)
        if (userPositions?.userPositions?.length) {
          for (const up of userPositions.userPositions) {
            if ((up as any).publicKey) {
              discovered.set((up as any).publicKey.toBase58(), pairPubkey)
            }
          }
        }
      } catch {
        continue
      }
    }
  } catch (err) {
    console.log(`[discovery] getLbPairs failed: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  return Array.from(discovered.entries()).map(([positionPubkey, poolPubkey]) => ({
    poolPubkey,
    positionPubkey,
  }))
}
