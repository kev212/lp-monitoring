import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      position_pubkey TEXT PRIMARY KEY,
      pool_pubkey TEXT NOT NULL,
      token_x_mint TEXT NOT NULL,
      token_y_mint TEXT NOT NULL,
      token_x_symbol TEXT NOT NULL DEFAULT '',
      token_y_symbol TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL,
      basis_sol REAL NOT NULL DEFAULT 0,
      entry_value_sol REAL,
      basis_confidence TEXT NOT NULL DEFAULT 'low',
      tp_percent REAL NOT NULL DEFAULT 5,
      sl_percent REAL NOT NULL DEFAULT -15,
      status TEXT NOT NULL DEFAULT 'discovering',
      trigger_confirmations INTEGER NOT NULL DEFAULT 0,
      last_pnl_percent REAL,
      last_estimated_exit_sol REAL,
      last_seen_at INTEGER NOT NULL,
      peak_pnl_percent REAL NOT NULL DEFAULT 0,
      trailing_activated INTEGER NOT NULL DEFAULT 0,
      strategy TEXT NOT NULL DEFAULT 'unknown',
      precision_curve_enabled INTEGER NOT NULL DEFAULT 0,
      precision_curve_last_active_bin INTEGER,
      precision_curve_last_reshape_at INTEGER,
      precision_curve_busy INTEGER NOT NULL DEFAULT 0,
      precision_curve_threshold_bins INTEGER NOT NULL DEFAULT 5,
      precision_curve_pending_x TEXT,
      precision_curve_pending_y TEXT,
      precision_curve_pending_pre_balances TEXT,
      precision_curve_pending_started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS position_events (
      position_pubkey TEXT NOT NULL,
      signature TEXT NOT NULL,
      block_time INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      token_x_delta TEXT NOT NULL DEFAULT '0',
      token_y_delta TEXT NOT NULL DEFAULT '0',
      sol_delta TEXT NOT NULL DEFAULT '0',
      basis_sol_delta REAL NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'low',
      raw_summary TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (position_pubkey, signature)
    );

    CREATE TABLE IF NOT EXISTS executions (
      position_pubkey TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_pnl_percent REAL NOT NULL,
      basis_sol REAL NOT NULL,
      estimated_exit_sol REAL NOT NULL,
      remove_liq_sig TEXT,
      swap_sig TEXT,
      final_sol_received REAL,
      status TEXT NOT NULL DEFAULT 'pending_remove',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_position_events_pubkey ON position_events(position_pubkey);
    CREATE INDEX IF NOT EXISTS idx_executions_pubkey ON executions(position_pubkey);
  `)

  // Add columns for existing DBs that were created before schema update
  const cols = db.prepare("PRAGMA table_info('positions')").all() as any[]
  const hasTokenXSymbol = cols.some((c: any) => c.name === 'token_x_symbol')
  if (!hasTokenXSymbol) {
    db.exec("ALTER TABLE positions ADD COLUMN token_x_symbol TEXT NOT NULL DEFAULT ''")
    db.exec("ALTER TABLE positions ADD COLUMN token_y_symbol TEXT NOT NULL DEFAULT ''")
  }
  const hasStrategy = cols.some((c: any) => c.name === 'strategy')
  if (!hasStrategy) {
    db.exec("ALTER TABLE positions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'unknown'")
  }
  const hasPrecisionCurveEnabled = cols.some((c: any) => c.name === 'precision_curve_enabled')
  if (!hasPrecisionCurveEnabled) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_enabled INTEGER NOT NULL DEFAULT 0")
  }
  const hasPrecisionCurveLastActiveBin = cols.some((c: any) => c.name === 'precision_curve_last_active_bin')
  if (!hasPrecisionCurveLastActiveBin) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_last_active_bin INTEGER")
  }
  const hasPrecisionCurveLastReshapeAt = cols.some((c: any) => c.name === 'precision_curve_last_reshape_at')
  if (!hasPrecisionCurveLastReshapeAt) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_last_reshape_at INTEGER")
  }
  const hasPrecisionCurveBusy = cols.some((c: any) => c.name === 'precision_curve_busy')
  if (!hasPrecisionCurveBusy) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_busy INTEGER NOT NULL DEFAULT 0")
  }
  const hasPrecisionCurveThresholdBins = cols.some((c: any) => c.name === 'precision_curve_threshold_bins')
  if (!hasPrecisionCurveThresholdBins) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_threshold_bins INTEGER NOT NULL DEFAULT 5")
  }
  const hasPrecisionCurveRangeHalf = cols.some((c: any) => c.name === 'precision_curve_range_half')
  if (!hasPrecisionCurveRangeHalf) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_range_half INTEGER NOT NULL DEFAULT 100")
  }
  const hasPrecisionCurveMovementLog = cols.some((c: any) => c.name === 'precision_curve_movement_log')
  if (!hasPrecisionCurveMovementLog) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_movement_log TEXT NOT NULL DEFAULT '[]'")
  }
  const hasPrecisionCurveRecoveryUntil = cols.some((c: any) => c.name === 'precision_curve_recovery_until')
  if (!hasPrecisionCurveRecoveryUntil) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_recovery_until INTEGER")
  }
  const hasEntryValueSol = cols.some((c: any) => c.name === 'entry_value_sol')
  if (!hasEntryValueSol) {
    db.exec("ALTER TABLE positions ADD COLUMN entry_value_sol REAL")
  }
  const hasPrecisionCurvePendingX = cols.some((c: any) => c.name === 'precision_curve_pending_x')
  if (!hasPrecisionCurvePendingX) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_pending_x TEXT")
  }
  const hasPrecisionCurvePendingY = cols.some((c: any) => c.name === 'precision_curve_pending_y')
  if (!hasPrecisionCurvePendingY) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_pending_y TEXT")
  }
  const hasPrecisionCurvePendingPreBalances = cols.some((c: any) => c.name === 'precision_curve_pending_pre_balances')
  if (!hasPrecisionCurvePendingPreBalances) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_pending_pre_balances TEXT")
  }
  const hasPrecisionCurvePendingStartedAt = cols.some((c: any) => c.name === 'precision_curve_pending_started_at')
  if (!hasPrecisionCurvePendingStartedAt) {
    db.exec("ALTER TABLE positions ADD COLUMN precision_curve_pending_started_at INTEGER")
  }
  db.exec("UPDATE positions SET entry_value_sol = basis_sol WHERE entry_value_sol IS NULL AND basis_sol > 0")
}
