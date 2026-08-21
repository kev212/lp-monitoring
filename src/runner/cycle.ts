import { randomUUID } from 'node:crypto'
import { deleteSyncValue, getDb, getSyncValue, listSyncValues, setSyncValue } from '../db/client.js'
import { normalizeAlertedAtMs } from './gates.js'
import type { RunnerAlertPayload, RunnerCycleStage } from './gates.js'

export interface RunnerCycle {
  version: 1
  cycleId: string
  eventId: string
  revision: number
  owner: string
  mint: string
  symbol: string
  stage: RunnerCycleStage
  poolPubkey: string | null
  knownPoolPubkeys: string[]
  positionPubkey: string | null
  firstOpenRetryCount: number
  firstChaseCount: number
  firstEverInRange: boolean
  winCount: number
  createdAt: number
  waitingSince: number | null
  lastGpaAt: number
  lastTvlUsd: number | null
  lastVol5mUsd: number | null
  lastFollowupAt: number
  lastError: string | null
  lastHandledExitPubkey: string | null
  chaseCancelNotified: boolean
}

const PREFIX = 'runner_cycle:'
const ALERT_SEEN_PREFIX = 'runner_alert_seen:'
const ALERT_EVENT_PREFIX = 'runner_alert_event:'

export function runnerCycleKey(owner: string, mint: string): string {
  return `${PREFIX}${owner}:${mint}`
}

export function createRunnerCycle(owner: string, mint: string, symbol: string): RunnerCycle {
  return {
    version: 1,
    cycleId: randomUUID(),
    eventId: '',
    revision: 0,
    owner,
    mint,
    symbol,
    stage: 'waiting_pool',
    poolPubkey: null,
    knownPoolPubkeys: [],
    positionPubkey: null,
    firstOpenRetryCount: 0,
    firstChaseCount: 0,
    firstEverInRange: false,
    winCount: 0,
    createdAt: Date.now(),
    waitingSince: Date.now(),
    lastGpaAt: 0,
    lastTvlUsd: null,
    lastVol5mUsd: null,
    lastFollowupAt: 0,
    lastError: null,
    lastHandledExitPubkey: null,
    chaseCancelNotified: false,
  }
}

export function saveRunnerCycle(cycle: RunnerCycle): boolean {
  const db = getDb()
  const key = runnerCycleKey(cycle.owner, cycle.mint)
  const current = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined
  if (current) {
    let parsed: Partial<RunnerCycle>
    try { parsed = JSON.parse(current.value) as Partial<RunnerCycle> } catch { return false }
    if ((parsed.cycleId && parsed.cycleId !== cycle.cycleId) || (parsed.revision ?? 0) !== cycle.revision) return false
  } else if (cycle.revision !== 0) {
    return false
  }
  cycle.revision += 1
  setSyncValue(key, JSON.stringify(cycle))
  return true
}

export function deleteRunnerCycle(owner: string, mint: string, cycleId?: string): boolean {
  const key = runnerCycleKey(owner, mint)
  if (!cycleId) {
    deleteSyncValue(key)
    return true
  }
  const result = getDb().prepare(`
    DELETE FROM sync_state
    WHERE key = ?
      AND (json_extract(value, '$.cycleId') = ? OR (json_extract(value, '$.cycleId') IS NULL AND ? LIKE 'legacy:%'))
  `).run(key, cycleId, cycleId)
  return result.changes === 1
}

export function createRunnerCycleAtomically(cycle: RunnerCycle, payload: RunnerAlertPayload, eventId: string): boolean {
  const db = getDb()
  const cycleKey = runnerCycleKey(cycle.owner, cycle.mint)
  const eventKey = `${ALERT_EVENT_PREFIX}${cycle.owner}:${eventId}`
  const alertedAtMs = normalizeAlertedAtMs(payload.alertedAt)
  const inserted = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(cycleKey)) return false
    if (db.prepare('SELECT 1 FROM sync_state WHERE key = ?').get(eventKey)) return false
    cycle.eventId = eventId
    cycle.revision = 1
    const now = Date.now()
    db.prepare('INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`${ALERT_SEEN_PREFIX}${cycle.owner}:${cycle.mint}`, String(alertedAtMs), now)
    db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(eventKey, JSON.stringify({ eventId, mint: cycle.mint, alertedAtMs, createdAt: now }), now)
    db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(cycleKey, JSON.stringify(cycle), now)
    return true
  })()
  return inserted
}

export function listRunnerCycles(): RunnerCycle[] {
  return listSyncValues(PREFIX).flatMap(row => {
    try {
      const parsed = JSON.parse(row.value) as Partial<RunnerCycle>
      if (parsed.version !== 1 || !parsed.owner || !parsed.mint || !parsed.stage) return []
      return [{
        version: 1,
        cycleId: parsed.cycleId || `legacy:${parsed.owner}:${parsed.mint}`,
        eventId: parsed.eventId || '',
        revision: Number.isSafeInteger(parsed.revision) ? parsed.revision as number : 0,
        owner: parsed.owner,
        mint: parsed.mint,
        symbol: parsed.symbol || '',
        stage: parsed.stage,
        poolPubkey: parsed.poolPubkey || null,
        knownPoolPubkeys: Array.isArray(parsed.knownPoolPubkeys) ? parsed.knownPoolPubkeys : [],
        positionPubkey: parsed.positionPubkey || null,
        firstOpenRetryCount: parsed.firstOpenRetryCount || 0,
        firstChaseCount: parsed.firstChaseCount || 0,
        firstEverInRange: parsed.firstEverInRange === true,
        winCount: parsed.winCount || 0,
        createdAt: parsed.createdAt || 0,
        waitingSince: parsed.waitingSince ?? null,
        lastGpaAt: parsed.lastGpaAt || 0,
        lastTvlUsd: parsed.lastTvlUsd ?? null,
        lastVol5mUsd: parsed.lastVol5mUsd ?? null,
        lastFollowupAt: parsed.lastFollowupAt || 0,
        lastError: parsed.lastError || null,
        lastHandledExitPubkey: parsed.lastHandledExitPubkey || null,
        chaseCancelNotified: parsed.chaseCancelNotified === true,
      }]
    } catch {
      return []
    }
  })
}

export function getRunnerCycle(owner: string, mint: string): RunnerCycle | null {
  const raw = getSyncValue(runnerCycleKey(owner, mint))
  if (!raw) return null
  const match = listRunnerCycles().find(cycle => cycle.owner === owner && cycle.mint === mint)
  return match || null
}

export function findCycleByPosition(positionPubkey: string): RunnerCycle | null {
  return listRunnerCycles().find(cycle => cycle.positionPubkey === positionPubkey) || null
}

export function busyRunnerStages(cycles: RunnerCycle[]): RunnerCycle[] {
  return cycles.filter(cycle => cycle.stage === 'waiting_pool' || cycle.stage === 'open_first' || cycle.stage === 'reopen_eval' || cycle.stage === 'open_followup')
}

export function getLastAlertedAt(owner: string, mint: string): number | null {
  const raw = getSyncValue(`${ALERT_SEEN_PREFIX}${owner}:${mint}`)
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function rememberAlertedAt(owner: string, mint: string, alertedAt: number): void {
  setSyncValue(`${ALERT_SEEN_PREFIX}${owner}:${mint}`, String(normalizeAlertedAtMs(alertedAt)))
}
