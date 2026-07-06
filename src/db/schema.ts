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
      precision_curve_range_half INTEGER NOT NULL DEFAULT 100,
      precision_curve_movement_log TEXT NOT NULL DEFAULT '[]',
      precision_curve_recovery_until INTEGER,
      flip_mode_enabled INTEGER NOT NULL DEFAULT 0,
      flip_mode_busy INTEGER NOT NULL DEFAULT 0,
      flip_mode_last_progress_pct REAL,
      flip_mode_last_active_bin INTEGER,
      flip_mode_last_flip_at INTEGER,
      flip_mode_recovery_until INTEGER,
      flip_mode_pending_add INTEGER NOT NULL DEFAULT 0,
      flip_mode_pending_token_mint TEXT,
      flip_mode_pending_token_side TEXT,
      flip_mode_pending_token_amount TEXT,
      flip_mode_pending_progress_pct REAL,
      flip_mode_pending_active_bin INTEGER,
      flip_mode_pending_since INTEGER,
      flip_mode_pending_attempts INTEGER NOT NULL DEFAULT 0,
      flip_mode_pending_last_error TEXT,
      drawdown_tp_override_active INTEGER NOT NULL DEFAULT 0,
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
  const hasDrawdownTpOverrideActive = cols.some((c: any) => c.name === 'drawdown_tp_override_active')
  if (!hasDrawdownTpOverrideActive) {
    db.exec("ALTER TABLE positions ADD COLUMN drawdown_tp_override_active INTEGER NOT NULL DEFAULT 0")
  }
  const hasFlipModeEnabled = cols.some((c: any) => c.name === 'flip_mode_enabled')
  if (!hasFlipModeEnabled) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_enabled INTEGER NOT NULL DEFAULT 0")
  }
  const hasFlipModeBusy = cols.some((c: any) => c.name === 'flip_mode_busy')
  if (!hasFlipModeBusy) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_busy INTEGER NOT NULL DEFAULT 0")
  }
  const hasFlipModeLastProgressPct = cols.some((c: any) => c.name === 'flip_mode_last_progress_pct')
  if (!hasFlipModeLastProgressPct) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_last_progress_pct REAL")
  }
  const hasFlipModeLastActiveBin = cols.some((c: any) => c.name === 'flip_mode_last_active_bin')
  if (!hasFlipModeLastActiveBin) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_last_active_bin INTEGER")
  }
  const hasFlipModeLastFlipAt = cols.some((c: any) => c.name === 'flip_mode_last_flip_at')
  if (!hasFlipModeLastFlipAt) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_last_flip_at INTEGER")
  }
  const hasFlipModeRecoveryUntil = cols.some((c: any) => c.name === 'flip_mode_recovery_until')
  if (!hasFlipModeRecoveryUntil) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_recovery_until INTEGER")
  }
  const hasFlipModePendingAdd = cols.some((c: any) => c.name === 'flip_mode_pending_add')
  if (!hasFlipModePendingAdd) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_add INTEGER NOT NULL DEFAULT 0")
  }
  const hasFlipModePendingTokenMint = cols.some((c: any) => c.name === 'flip_mode_pending_token_mint')
  if (!hasFlipModePendingTokenMint) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_token_mint TEXT")
  }
  const hasFlipModePendingTokenSide = cols.some((c: any) => c.name === 'flip_mode_pending_token_side')
  if (!hasFlipModePendingTokenSide) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_token_side TEXT")
  }
  const hasFlipModePendingTokenAmount = cols.some((c: any) => c.name === 'flip_mode_pending_token_amount')
  if (!hasFlipModePendingTokenAmount) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_token_amount TEXT")
  }
  const hasFlipModePendingProgressPct = cols.some((c: any) => c.name === 'flip_mode_pending_progress_pct')
  if (!hasFlipModePendingProgressPct) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_progress_pct REAL")
  }
  const hasFlipModePendingActiveBin = cols.some((c: any) => c.name === 'flip_mode_pending_active_bin')
  if (!hasFlipModePendingActiveBin) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_active_bin INTEGER")
  }
  const hasFlipModePendingSince = cols.some((c: any) => c.name === 'flip_mode_pending_since')
  if (!hasFlipModePendingSince) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_since INTEGER")
  }
  const hasFlipModePendingAttempts = cols.some((c: any) => c.name === 'flip_mode_pending_attempts')
  if (!hasFlipModePendingAttempts) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_attempts INTEGER NOT NULL DEFAULT 0")
  }
  const hasFlipModePendingLastError = cols.some((c: any) => c.name === 'flip_mode_pending_last_error')
  if (!hasFlipModePendingLastError) {
    db.exec("ALTER TABLE positions ADD COLUMN flip_mode_pending_last_error TEXT")
  }
}
