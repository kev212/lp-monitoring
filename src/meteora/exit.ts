import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BN } from '@coral-xyz/anchor'
import { getPool } from './positions.js'
import { getDb } from '../db/client.js'
import { swapTokensToSol } from '../swap.js'
import type { ExecutionRow, ExitStatus, TriggerType } from '../types.js'
import { updatePositionStatus } from './discovery.js'

const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'So11111111111111111111111111111111111111111',
])

export function saveExecution(row: ExecutionRow): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(`
    INSERT INTO executions (position_pubkey, trigger_type, trigger_pnl_percent, basis_sol,
      estimated_exit_sol, remove_liq_sig, swap_sig, final_sol_received, status, error_message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.positionPubkey, row.triggerType, row.triggerPnlPercent, row.basisSol,
    row.estimatedExitSol, row.removeLiqSig, row.swapSig, row.finalSolReceived,
    row.status, row.errorMessage, now, now)
}

export function updateExecution(pubkey: string, status: ExitStatus, fields: Partial<ExecutionRow>): void {
  const db = getDb()
  const sets: string[] = ['status = ?', 'updated_at = ?']
  const vals: any[] = [status, Date.now()]
  if (fields.removeLiqSig !== undefined) { sets.push('remove_liq_sig = ?'); vals.push(fields.removeLiqSig) }
  if (fields.swapSig !== undefined) { sets.push('swap_sig = ?'); vals.push(fields.swapSig) }
  if (fields.finalSolReceived !== undefined) { sets.push('final_sol_received = ?'); vals.push(fields.finalSolReceived) }
  if (fields.errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(fields.errorMessage) }
  vals.push(pubkey)
  db.prepare(`UPDATE executions SET ${sets.join(', ')} WHERE position_pubkey = ? AND status != 'completed'`).run(...vals)
}

export interface ExitResult {
  success: boolean
  solReceived: number
  removeLiqSig: string | null
  swapSig: string | null
  error?: string
}

export async function executeExit(
  connection: Connection,
  wallet: Keypair,
  positionPubkey: string,
  poolPubkey: string,
  tokenXMint: string,
  tokenYMint: string,
  triggerType: TriggerType,
  pnlPercent: number,
  basisSol: number,
  estimatedExitSol: number
): Promise<ExitResult> {
  console.log(`[exit] executing ${triggerType} for ${positionPubkey.slice(0, 8)}...`)

  const result: ExitResult = {
    success: false,
    solReceived: 0,
    removeLiqSig: null,
    swapSig: null,
  }

  saveExecution({
    positionPubkey,
    triggerType,
    triggerPnlPercent: pnlPercent,
    basisSol,
    estimatedExitSol,
    removeLiqSig: null,
    swapSig: null,
    finalSolReceived: null,
    status: 'pending_remove',
    errorMessage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  updatePositionStatus(positionPubkey, 'exiting')

  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const pos = await pool.getPosition(new PublicKey(positionPubkey))
    if (!pos) throw new Error('Position not found')

    const pd = pos.positionData
    const removeTxs = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: new PublicKey(positionPubkey),
      fromBinId: pd.lowerBinId,
      toBinId: pd.upperBinId,
      bps: new BN(10000) as any,
      shouldClaimAndClose: true,
    })

    for (const tx of removeTxs) {
      tx.sign(wallet)
      const sig = await connection.sendTransaction(tx, [wallet])
      await connection.confirmTransaction(sig, 'confirmed')
      result.removeLiqSig = sig
      console.log(`[exit] remove liq tx: ${sig}`)
    }

    updateExecution(positionPubkey, 'removed', { removeLiqSig: result.removeLiqSig! })
  } catch (err) {
    const msg = `remove liquidity failed: ${err instanceof Error ? err.message : 'unknown'}`
    console.log(`[exit] ${msg}`)
    updateExecution(positionPubkey, 'failed', { errorMessage: msg })
    result.error = msg
    return result
  }

  try {
    updateExecution(positionPubkey, 'swap_pending', {})

    const nonSolTokens: string[] = []
    if (!SOL_MINTS.has(tokenXMint)) nonSolTokens.push(tokenXMint)
    if (!SOL_MINTS.has(tokenYMint)) nonSolTokens.push(tokenYMint)

    for (const mint of nonSolTokens) {
      const balance = await connection.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) })
      let totalAmount = 0n
      for (const acc of balance.value) {
        const data = acc.account.data
        const amount = BigInt('0x' + data.subarray(64, 72).toString('hex'))
        totalAmount += amount
      }

      if (totalAmount > 0n) {
        const swapResult = await swapTokensToSol(connection, wallet, mint, totalAmount.toString())
        if (swapResult) {
          result.swapSig = swapResult.signature
        }
      }
    }

    const solBalance = await connection.getBalance(wallet.publicKey)
    result.solReceived = solBalance / 1_000_000_000

    updateExecution(positionPubkey, 'completed', {
      swapSig: result.swapSig!,
      finalSolReceived: result.solReceived,
    })

    updatePositionStatus(positionPubkey, 'closed')
    result.success = true

    console.log(`[exit] completed, received ${result.solReceived.toFixed(6)} SOL`)
  } catch (err) {
    const msg = `swap failed: ${err instanceof Error ? err.message : 'unknown'}`
    console.log(`[exit] ${msg}`)
    updateExecution(positionPubkey, 'failed', { errorMessage: msg })
    result.error = msg
  }

  return result
}
