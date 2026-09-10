import { config } from '../config.js'
import { getDb, getSyncValue, setSyncValue } from '../db/client.js'

export const MIN_REBALANCE_MINUTES = 1
export const MAX_REBALANCE_MINUTES = 1440

const REBALANCE_SETTINGS_KEY = 'rebalance_settings'

export interface RebalanceSettings {
  minutes: number
  revision: number
}

export function parseRebalanceMinutesInput(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < MIN_REBALANCE_MINUTES || value > MAX_REBALANCE_MINUTES) return null
  return value
}

function defaultSettings(): RebalanceSettings {
  const fallback = Math.round(config.rebalanceOorMinutes)
  const minutes = Number.isSafeInteger(fallback) && fallback >= MIN_REBALANCE_MINUTES && fallback <= MAX_REBALANCE_MINUTES
    ? fallback
    : 5
  return { minutes, revision: 0 }
}

export function getRebalanceSettings(): RebalanceSettings {
  const raw = getSyncValue(REBALANCE_SETTINGS_KEY)
  if (!raw) return defaultSettings()
  try {
    const parsed = JSON.parse(raw) as Partial<RebalanceSettings> & { version?: number }
    if (
      parsed.version !== 1
      || !Number.isInteger(parsed.minutes)
      || (parsed.minutes as number) < MIN_REBALANCE_MINUTES
      || (parsed.minutes as number) > MAX_REBALANCE_MINUTES
    ) {
      return defaultSettings()
    }
    return {
      minutes: parsed.minutes as number,
      revision: Number.isSafeInteger(parsed.revision) ? parsed.revision as number : 0,
    }
  } catch {
    return defaultSettings()
  }
}

export function getRebalanceOorMinutes(): number {
  return getRebalanceSettings().minutes
}

export function setRebalanceOorMinutes(minutes: number): { minutes: number; revision: number; resetTimers: boolean } {
  if (!Number.isInteger(minutes) || minutes < MIN_REBALANCE_MINUTES || minutes > MAX_REBALANCE_MINUTES) {
    throw new Error(`Rebalance window must be a whole number between ${MIN_REBALANCE_MINUTES} and ${MAX_REBALANCE_MINUTES} minutes`)
  }
  const current = getRebalanceSettings()
  if (current.minutes === minutes) return { minutes, revision: current.revision, resetTimers: false }

  const db = getDb()
  return db.transaction(() => {
    const revision = current.revision + 1
    setSyncValue(REBALANCE_SETTINGS_KEY, JSON.stringify({ version: 1, minutes, revision }))
    const cleared = db.prepare(`
      UPDATE positions
      SET rebalance_oor_since = NULL,
          rebalance_oor_direction = NULL,
          updated_at = ?
      WHERE rebalance_oor_since IS NOT NULL
    `).run(Date.now())
    return { minutes, revision, resetTimers: cleared.changes > 0 }
  })()
}
