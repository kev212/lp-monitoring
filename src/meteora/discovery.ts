import { Connection, PublicKey } from '@solana/web3.js'
import { getDb } from '../db/client.js'
import type { PositionRow, BasisConfidence, StrategyType } from '../types.js'

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhbPFn5XX4kz4LZ7Qd8hLEjNvF7M7bQeFqF7gYx')

export interface DiscoveredPosition {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
}

function rowToPosition(row: any): PositionRow {
  return {
    positionPubkey: row.position_pubkey,
    poolPubkey: row.pool_pubkey,
    tokenXMint: row.token_x_mint,
    tokenYMint: row.token_y_mint,
    tokenXSymbol: row.token_x_symbol || '',
    tokenYSymbol: row.token_y_symbol || '',
    owner: row.owner,
    basisSol: row.basis_sol,
    basisConfidence: row.basis_confidence,
    tpPercent: row.tp_percent,
    slPercent: row.sl_percent,
    status: row.status,
    triggerConfirmations: row.trigger_confirmations,
    peakPnlPercent: row.peak_pnl_percent ?? 0,
    trailingActivated: row.trailing_activated === 1,
    lastPnlPercent: row.last_pnl_percent,
    lastEstimatedExitSol: row.last_estimated_exit_sol,
    lastSeenAt: row.last_seen_at,
    strategy: row.strategy || 'unknown',
    precisionCurveEnabled: row.precision_curve_enabled === 1,
    precisionCurveLastActiveBin: row.precision_curve_last_active_bin ?? null,
    precisionCurveLastReshapeAt: row.precision_curve_last_reshape_at ?? null,
    precisionCurveBusy: row.precision_curve_busy === 1,
    precisionCurveThresholdBins: row.precision_curve_threshold_bins ?? 3,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function loadKnownPositions(): PositionRow[] {
  const db = getDb()
  return (db.prepare('SELECT * FROM positions').all() as any[]).map(rowToPosition)
}

export function loadActivePositions(): PositionRow[] {
  const db = getDb()
  return (db.prepare("SELECT * FROM positions WHERE status IN ('monitoring', 'exiting', 'discovering')").all() as any[]).map(rowToPosition)
}

export function upsertPosition(row: {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  tokenXSymbol: string
  tokenYSymbol: string
  owner: string
  basisSol: number
  basisConfidence: BasisConfidence
  tpPercent: number
  slPercent: number
  status: PositionRow['status']
  triggerConfirmations: number
  peakPnlPercent: number
  trailingActivated: boolean
  lastPnlPercent: number | null
  lastEstimatedExitSol: number | null
  lastSeenAt: number
  strategy: StrategyType
}): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(`
    INSERT INTO positions (position_pubkey, pool_pubkey, token_x_mint, token_y_mint, token_x_symbol, token_y_symbol, owner,
      basis_sol, basis_confidence, tp_percent, sl_percent, status, trigger_confirmations,
      peak_pnl_percent, trailing_activated, strategy,
      last_pnl_percent, last_estimated_exit_sol, last_seen_at, created_at, updated_at)
    VALUES (@positionPubkey, @poolPubkey, @tokenXMint, @tokenYMint, @tokenXSymbol, @tokenYSymbol, @owner,
      @basisSol, @basisConfidence, @tpPercent, @slPercent, @status, @triggerConfirmations,
      @peakPnlPercent, @trailingActivated, @strategy,
      @lastPnlPercent, @lastEstimatedExitSol, @lastSeenAt, @createdAt, @updatedAt)
    ON CONFLICT(position_pubkey) DO UPDATE SET
      status = @status,
      basis_sol = @basisSol,
      basis_confidence = @basisConfidence,
      token_x_symbol = @tokenXSymbol,
      token_y_symbol = @tokenYSymbol,
      trigger_confirmations = @triggerConfirmations,
      peak_pnl_percent = COALESCE(@peakPnlPercent, peak_pnl_percent),
      trailing_activated = COALESCE(@trailingActivated, trailing_activated),
      strategy = @strategy,
      last_pnl_percent = @lastPnlPercent,
      last_estimated_exit_sol = @lastEstimatedExitSol,
      last_seen_at = @lastSeenAt,
      updated_at = @updatedAt
  `).run({
    ...row,
    trailingActivated: row.trailingActivated ? 1 : 0,
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

export function updatePeakPnl(pubkey: string, peakPct: number, trailingActivated: boolean): void {
  getDb().prepare(
    'UPDATE positions SET peak_pnl_percent = ?, trailing_activated = ?, updated_at = ? WHERE position_pubkey = ?'
  ).run(peakPct, trailingActivated ? 1 : 0, Date.now(), pubkey)
}

export function updatePositionStrategy(pubkey: string, strategy: StrategyType, slPercent: number, tpPercent: number): void {
  getDb().prepare(
    'UPDATE positions SET strategy = ?, sl_percent = ?, tp_percent = ?, updated_at = ? WHERE position_pubkey = ?'
  ).run(strategy, slPercent, tpPercent, Date.now(), pubkey)
}

export function updatePrecisionCurveEnabled(pubkey: string, enabled: boolean, currentActiveBin: number | null = null): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `UPDATE positions
     SET precision_curve_enabled = ?,
         precision_curve_last_active_bin = CASE WHEN ? = 1 THEN ? ELSE precision_curve_last_active_bin END,
         precision_curve_busy = 0,
         updated_at = ?
     WHERE position_pubkey = ?`
  ).run(enabled ? 1 : 0, enabled ? 1 : 0, currentActiveBin, now, pubkey)
}

export function updatePrecisionCurveBusy(pubkey: string, busy: boolean): void {
  getDb().prepare('UPDATE positions SET precision_curve_busy = ?, updated_at = ? WHERE position_pubkey = ?')
    .run(busy ? 1 : 0, Date.now(), pubkey)
}

export function updatePrecisionCurveState(pubkey: string, lastActiveBin: number, lastReshapeAt: number): void {
  getDb().prepare(
    'UPDATE positions SET precision_curve_last_active_bin = ?, precision_curve_last_reshape_at = ?, precision_curve_busy = 0, updated_at = ? WHERE position_pubkey = ?'
  ).run(lastActiveBin, lastReshapeAt, Date.now(), pubkey)
}

export function updatePrecisionCurveThreshold(pubkey: string, thresholdBins: number): void {
  getDb().prepare('UPDATE positions SET precision_curve_threshold_bins = ?, updated_at = ? WHERE position_pubkey = ?')
    .run(thresholdBins, Date.now(), pubkey)
}
