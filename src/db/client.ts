import Database from 'better-sqlite3'
import { config } from '../config.js'
import { initSchema } from './schema.js'

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.dbPath)
    _db.pragma('journal_mode = WAL')
    initSchema(_db)
  }
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

export function getSyncValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSyncValue(key: string, value: string): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(key, value, Date.now())
}

export function deleteSyncValue(key: string): void {
  getDb().prepare('DELETE FROM sync_state WHERE key = ?').run(key)
}

export function listSyncValues(prefix: string): Array<{ key: string; value: string }> {
  return getDb().prepare(
    'SELECT key, value FROM sync_state WHERE key LIKE ? ORDER BY updated_at ASC'
  ).all(`${prefix}%`) as Array<{ key: string; value: string }>
}
