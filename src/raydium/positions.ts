import { CLMM_PROGRAM_ID, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2'
import type { Connection, Keypair } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { withRpcFallback } from '../solana/connection.js'
import { getRaydium } from './sdk.js'

export interface RaydiumWalletPosition {
  nftMint: string
  poolId: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
}

export async function listRaydiumWalletPositions(
  connection: Connection,
  wallet: Keypair,
): Promise<RaydiumWalletPosition[]> {
  const raydium = await getRaydium(connection, wallet)
  const positions = await raydium.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID })
  return positions
    .filter(position => position.liquidity.gtn(0))
    .map(position => ({
      nftMint: position.nftMint.toBase58(),
      poolId: position.poolId.toBase58(),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: BigInt(position.liquidity.toString()),
    }))
}

export async function raydiumPersonalPositionAddress(nftMint: string): Promise<PublicKey> {
  return getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, new PublicKey(nftMint)).publicKey
}

export async function raydiumPositionExists(
  connection: Connection,
  nftMint: string,
): Promise<boolean> {
  const address = await raydiumPersonalPositionAddress(nftMint)
  const account = await withRpcFallback(rpc => rpc.getAccountInfo(address, 'confirmed'), connection)
  return account !== null
}
