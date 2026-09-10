import type { Connection, Keypair } from '@solana/web3.js'
import { sendNotification } from '../telegram.js'
import { closeRaydiumPosition, prepareRaydiumOpen } from './execute.js'
import { raydiumPositionExists } from './positions.js'
import type { RaydiumRebalanceServices } from './rebalance.js'

export function defaultRaydiumServices(connection: Connection, wallet: Keypair): RaydiumRebalanceServices {
  return {
    closePosition: params => closeRaydiumPosition(connection, wallet, params),
    prepareOpen: params => prepareRaydiumOpen(connection, wallet, params),
    positionExists: nftMint => raydiumPositionExists(connection, nftMint),
    notify: sendNotification,
  }
}
