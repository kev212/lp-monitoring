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
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

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
  usdcReceived: number
  rentRefundSol: number
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
    usdcReceived: 0,
    rentRefundSol: 0,
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

  const quoteIsUsdc = tokenXMint === USDC_MINT || tokenYMint === USDC_MINT

  // Capture pre-exit SOL balance for accurate solReceived calculation
  let preSolBalance = 0
  try {
    preSolBalance = await connection.getBalance(wallet.publicKey)
  } catch {
    console.log('[exit] failed to get pre-balance, solReceived may be inaccurate')
  }

  // Capture pre-exit USDC balance to exclude existing wallet USDC
  let preUsdcBalance = 0n
  if (quoteIsUsdc) {
    try {
      const accounts = await connection.getTokenAccountsByOwner(
        wallet.publicKey,
        { mint: new PublicKey(USDC_MINT) }
      )
      for (const acc of accounts.value) {
        const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
        preUsdcBalance += view.getBigUint64(0, true)
      }
    } catch {
      console.log('[exit] failed to get pre-USDC balance, usdcReceived may be inaccurate')
    }
  }

  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const pos = await pool.getPosition(new PublicKey(positionPubkey))
    if (!pos) throw new Error('Position not found')

    // Capture position account rent before closing
    try {
      const accInfo = await connection.getAccountInfo(new PublicKey(positionPubkey))
      result.rentRefundSol = accInfo ? accInfo.lamports / 1_000_000_000 : 0
    } catch {
      console.log('[exit] failed to get position account rent, rentRefundSol=0')
      result.rentRefundSol = 0
    }

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

    // Helper: get token balance via ATA or owner query (with retry + delay for RPC consistency)
    async function getTokenBalance(mint: string, attempt: number = 1): Promise<bigint> {
      for (let i = 0; i < attempt; i++) {
        if (i > 0) await new Promise<void>(resolve => { setTimeout(resolve, 800); })
        try {
          const accounts = await connection.getTokenAccountsByOwner(
            wallet.publicKey,
            { mint: new PublicKey(mint) }
          )
          if (accounts.value.length > 0) {
            let total = 0n
            for (const acc of accounts.value) {
              const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
              total += view.getBigUint64(0, true)
            }
            if (total > 0n) return total
          }
          return 0n
        } catch { /* fallthrough to next attempt */ }
      }
      return 0n
    }

    // Sleep after remove liquidity to let RPC catch up
    await new Promise<void>(resolve => { setTimeout(resolve, 1500); })

    const swapTarget = quoteIsUsdc ? USDC_MINT : undefined // undefined = WSOL (default)

    // Build list of tokens to swap (skip SOL, skip USDC if quoteIsUsdc)
    const tokensToSwap: string[] = []
    if (!SOL_MINTS.has(tokenXMint) && !(quoteIsUsdc && tokenXMint === USDC_MINT)) tokensToSwap.push(tokenXMint)
    if (!SOL_MINTS.has(tokenYMint) && !(quoteIsUsdc && tokenYMint === USDC_MINT)) tokensToSwap.push(tokenYMint)

    // Unified retry loop: swap terus sampai balance 0 atau 5x percobaan
    let hasUnswappableTokens = false
    const MAX_SWAP_RETRIES = 5
    const targetLabel = quoteIsUsdc ? 'USDC' : 'SOL'

    for (const mint of tokensToSwap) {
      for (let attempt = 1; attempt <= MAX_SWAP_RETRIES; attempt++) {
        const balance = await getTokenBalance(mint, 2)
        if (balance === 0n) break

        console.log(`[exit] swap ${attempt}/${MAX_SWAP_RETRIES}: ${balance.toString()} ${mint.slice(0, 8)} → ${targetLabel}`)
        const swapResult = await swapTokensToSol(connection, wallet, mint, balance.toString(), swapTarget)
        if (swapResult?.signature) {
          result.swapSig = swapResult.signature
          break
        }

        await new Promise<void>(resolve => { setTimeout(resolve, 3_000); })
      }

      await new Promise<void>(resolve => { setTimeout(resolve, 5_000); })
      const finalBalance = await getTokenBalance(mint, 2)
      if (finalBalance > 0n) {
        console.log(`[exit] WARN: ${finalBalance.toString()} ${mint.slice(0, 8)} unswappable after ${MAX_SWAP_RETRIES} attempts`)
        result.error = `Unswappable: ${finalBalance.toString()} ${mint.slice(0, 8)}`
        hasUnswappableTokens = true
      }
    }

    // Measure final balances
    const postSolBalance = await connection.getBalance(wallet.publicKey)
    result.solReceived = preSolBalance > 0
      ? (postSolBalance - preSolBalance) / 1_000_000_000
      : 0

    if (quoteIsUsdc) {
      const postUsdcBalance = await getTokenBalance(USDC_MINT, 2)
      const netUsdc = postUsdcBalance > preUsdcBalance ? postUsdcBalance - preUsdcBalance : 0n
      result.usdcReceived = Number(netUsdc) / 1e6
    }

    if (hasUnswappableTokens) {
      updateExecution(positionPubkey, 'failed', {
        swapSig: result.swapSig || null,
        finalSolReceived: result.solReceived,
        errorMessage: result.error || 'partial swap — tokens remain unswappable',
      })
      result.success = false
    } else {
      updateExecution(positionPubkey, 'completed', {
        swapSig: result.swapSig!,
        finalSolReceived: result.solReceived,
      })
      updatePositionStatus(positionPubkey, 'closed')
      result.success = true
    }

    if (quoteIsUsdc) {
      console.log(`[exit] ${hasUnswappableTokens ? 'partial' : 'completed'}, received ${result.usdcReceived.toFixed(2)} USDC`)
    } else {
      console.log(`[exit] ${hasUnswappableTokens ? 'partial' : 'completed'}, received ${result.solReceived.toFixed(6)} SOL`)
    }
  } catch (err) {
    const msg = `swap failed: ${err instanceof Error ? err.message : 'unknown'}`
    console.log(`[exit] ${msg}`)
    updateExecution(positionPubkey, 'failed', { errorMessage: msg })
    result.error = msg
  }

  return result
}
