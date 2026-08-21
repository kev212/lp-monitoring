import { deleteSyncValue, getSyncValue, listSyncValues, setSyncValue } from '../db/client.js'
import type { RunnerCycleStage } from './gates.js'

export interface RunnerCycle {
  version: 1
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
}

const PREFIX = 'runner_cycle:'

export function runnerCycleKey(owner: string, mint: string): string {
  return `${PREFIX}${owner}:${mint}`
}

export function createRunnerCycle(owner: string, mint: string, symbol: string): RunnerCycle {
  return {
    version: 1,
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
  }
}

export function saveRunnerCycle(cycle: RunnerCycle): void {
  setSyncValue(runnerCycleKey(cycle.owner, cycle.mint), JSON.stringify(cycle))
}

export function deleteRunnerCycle(owner: string, mint: string): void {
  deleteSyncValue(runnerCycleKey(owner, mint))
}

export function listRunnerCycles(): RunnerCycle[] {
  return listSyncValues(PREFIX).flatMap(row => {
    try {
      const parsed = JSON.parse(row.value) as Partial<RunnerCycle>
      if (parsed.version !== 1 || !parsed.owner || !parsed.mint || !parsed.stage) return []
      return [{
        version: 1,
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
