import { getDb } from '../db/client.js'
import type { PositionRow } from '../types.js'

export type PositionRiskField = 'trail' | 'bin'
export function isPositionRiskEditable(status: PositionRow['status']): boolean {
  return ['opening', 'discovering', 'monitoring'].includes(status)
}

// Explicit desired state makes repeated Telegram callbacks idempotent.
export function setPositionRiskDisabled(pubkey: string, field: PositionRiskField, disabled: boolean): void {
  const db = getDb()
  const column = field === 'trail' ? 'trailing_disabled' : 'bin_range_disabled'
  db.transaction(() => {
    const row = db.prepare('SELECT status, rebalance_busy FROM positions WHERE position_pubkey = ?').get(pubkey) as { status: PositionRow['status']; rebalance_busy: number } | undefined
    if (!row || !isPositionRiskEditable(row.status)) throw new Error('Posisi tidak tersedia untuk perubahan risk.')
    if (row.rebalance_busy === 1) throw new Error('Rebalance sedang berjalan; ubah risk setelah posisi baru tersedia.')
    db.prepare(`UPDATE positions SET ${column} = ?, position_risk_revision = position_risk_revision + 1,
      trigger_confirmations = 0, updated_at = ?
      ${field === 'trail' ? ', peak_pnl_percent = 0, trailing_activated = 0' : ''}
      WHERE position_pubkey = ? AND ${column} != ?`).run(Number(disabled), Date.now(), pubkey, Number(disabled))
  })()
}

// A change during an async valuation/recheck invalidates that decision, even OFF → ON.
export function isPositionRiskSnapshotCurrent(snapshot: Pick<PositionRow, 'positionRiskRevision'>, latest: Pick<PositionRow, 'positionRiskRevision' | 'status'> | undefined): boolean {
  return latest !== undefined && isPositionRiskEditable(latest.status)
    && latest.positionRiskRevision === snapshot.positionRiskRevision
}
