import type { Connection, Keypair } from '@solana/web3.js'
import { sendNotification } from '../telegram.js'
import {
  measureRaydiumFundingDelta,
  prepareRaydiumRebalance,
  readRaydiumFundingBaseline,
  sendRaydiumSigned,
  submitRaydiumClose,
  type RaydiumFundingBaseline,
  type RaydiumPreparedRebalance,
  type RaydiumRebalancePlan,
} from './execute.js'
import { raydiumPositionExists } from './positions.js'
import type { RaydiumRebalanceServices } from './rebalance.js'

export function defaultRaydiumServices(connection: Connection, wallet: Keypair): RaydiumRebalanceServices {
  return {
    readFundingBaseline: params => readRaydiumFundingBaseline(connection, wallet, params),
    submitClose: params => submitRaydiumClose(connection, wallet, {
      poolId: params.poolId,
      nftMint: params.nftMint,
      mintA: params.baseline.mintA,
      mintB: params.baseline.mintB,
      mintAProgramId: params.baseline.mintAProgramId,
      mintBProgramId: params.baseline.mintBProgramId,
      baselineA: params.baseline.amountA,
      baselineB: params.baseline.amountB,
    }),
    measureFunding: (baseline: RaydiumFundingBaseline) => measureRaydiumFundingDelta(connection, wallet, {
      mintA: baseline.mintA,
      mintB: baseline.mintB,
      mintAProgramId: baseline.mintAProgramId,
      mintBProgramId: baseline.mintBProgramId,
      baselineA: baseline.amountA,
      baselineB: baseline.amountB,
    }),
    prepareRebalance: (params): Promise<RaydiumPreparedRebalance> => prepareRaydiumRebalance(connection, wallet, params),
    submitSigned: (plan: RaydiumRebalancePlan, signedTransaction: string) =>
      sendRaydiumSigned(connection, signedTransaction, plan.blockhash, plan.lastValidBlockHeight),
    positionExists: nftMint => raydiumPositionExists(connection, nftMint),
    notify: sendNotification,
  }
}
