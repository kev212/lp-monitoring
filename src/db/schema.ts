import type Database from 'better-sqlite3'

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      position_pubkey TEXT PRIMARY KEY,
      pool_pubkey TEXT NOT NULL,
      token_x_mint TEXT NOT NULL,
      token_y_mint TEXT NOT NULL,
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
}
