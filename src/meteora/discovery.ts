import { Connection, PublicKey } from '@solana/web3.js'
import { getDb } from '../db/client.js'
import type { PositionRow, BasisConfidence } from '../types.js'

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhbPFn5XX4kz4LZ7Qd8hLEjNvF7M7bQeFqF7gYx')

export interface DiscoveredPosition {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
}

export function loadKnownPositions(): PositionRow[] {
  const db = getDb()
  return db.prepare('SELECT * FROM positions WHERE status != ?').all('closed') as PositionRow[]
}

export function loadActivePositions(): PositionRow[] {
  const db = getDb()
  return db.prepare("SELECT * FROM positions WHERE status IN ('monitoring', 'exiting', 'discovering')").all() as PositionRow[]
}

export function upsertPosition(row: {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  owner: string
  basisSol: number
  basisConfidence: BasisConfidence
  tpPercent: number
  slPercent: number
  status: PositionRow['status']
  triggerConfirmations: number
  lastPnlPercent: number | null
  lastEstimatedExitSol: number | null
  lastSeenAt: number
}): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(`
    INSERT INTO positions (position_pubkey, pool_pubkey, token_x_mint, token_y_mint, owner,
      basis_sol, basis_confidence, tp_percent, sl_percent, status, trigger_confirmations,
      last_pnl_percent, last_estimated_exit_sol, last_seen_at, created_at, updated_at)
    VALUES (@positionPubkey, @poolPubkey, @tokenXMint, @tokenYMint, @owner,
      @basisSol, @basisConfidence, @tpPercent, @slPercent, @status, @triggerConfirmations,
      @lastPnlPercent, @lastEstimatedExitSol, @lastSeenAt, @createdAt, @updatedAt)
    ON CONFLICT(position_pubkey) DO UPDATE SET
      status = @status,
      basis_sol = @basisSol,
      basis_confidence = @basisConfidence,
      trigger_confirmations = @triggerConfirmations,
      last_pnl_percent = @lastPnlPercent,
      last_estimated_exit_sol = @lastEstimatedExitSol,
      last_seen_at = @lastSeenAt,
      updated_at = @updatedAt
  `).run({
    ...row,
    createdAt: now,
    updatedAt: now,
  })
}

export function updatePositionStatus(pubkey: string, status: PositionRow['status']): void {
  getDb().prepare('UPDATE positions SET status = ?, updated_at = ? WHERE position_pubkey = ?').run(status, Date.now(), pubkey)
}

export function updatePositionPnl(pubkey: string, pnlPercent: number, estimatedExitSol: number): void {
  getDb().prepare(
    'UPDATE positions SET last_pnl_percent = ?, last_estimated_exit_sol = ?, last_seen_at = ?, updated_at = ? WHERE position_pubkey = ?'
  ).run(pnlPercent, estimatedExitSol, Date.now(), Date.now(), pubkey)
}

export function updatePositionConfirmations(pubkey: string, count: number): void {
  getDb().prepare('UPDATE positions SET trigger_confirmations = ?, updated_at = ? WHERE position_pubkey = ?').run(count, Date.now(), pubkey)
}
