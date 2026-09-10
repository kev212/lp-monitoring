import { Raydium } from '@raydium-io/raydium-sdk-v2'
import type { Connection, Keypair } from '@solana/web3.js'

let cached: Raydium | null = null
let cachedOwner: string | null = null

/**
 * Singleton Raydium SDK instance. Token list loading is disabled because the
 * rebalancer only needs on-chain pool/position data, keeping startup cheap.
 */
export async function getRaydium(connection: Connection, wallet: Keypair): Promise<Raydium> {
  const owner = wallet.publicKey.toBase58()
  if (cached && cachedOwner === owner) {
    cached.setConnection(connection)
    return cached
  }
  cached = await Raydium.load({
    connection,
    owner: wallet,
    disableLoadToken: true,
    disableFeatureCheck: true,
    blockhashCommitment: 'confirmed',
  })
  cachedOwner = owner
  return cached
}

export function resetRaydium(): void {
  cached = null
  cachedOwner = null
}
