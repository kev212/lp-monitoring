import { deleteSyncValue, getSyncValue, listSyncValues, setSyncValue } from '../db/client.js'
import type { RebalanceDirection } from '../types.js'

const STATE_PREFIX = 'raydium_position_state:'
const SETTINGS_PREFIX = 'raydium_rebalance_settings:'

export type RaydiumBasisSource = 'rebalance' | 'baseline'

export interface RaydiumPositionState {
  nftMint: string
  since: number | null
  direction: RebalanceDirection | null
  notified: boolean
  cooldownUntil: number | null
  basisUsd: number | null
  basisSource: RaydiumBasisSource | null
  updatedAt: number
}

function stateKey(nftMint: string): string {
  return `${STATE_PREFIX}${nftMint}`
}

export function getRaydiumPositionState(nftMint: string): RaydiumPositionState | null {
  const raw = getSyncValue(stateKey(nftMint))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RaydiumPositionState>
    return {
      nftMint,
      since: Number.isSafeInteger(parsed.since) ? parsed.since as number : null,
      direction: ['up', 'down'].includes(parsed.direction || '') ? parsed.direction as RebalanceDirection : null,
      notified: parsed.notified === true,
      cooldownUntil: Number.isSafeInteger(parsed.cooldownUntil) ? parsed.cooldownUntil as number : null,
      basisUsd: typeof parsed.basisUsd === 'number' && Number.isFinite(parsed.basisUsd) && parsed.basisUsd > 0
        ? parsed.basisUsd
        : null,
      basisSource: parsed.basisSource === 'rebalance' || parsed.basisSource === 'baseline' ? parsed.basisSource : null,
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt as number : Date.now(),
    }
  } catch {
    return null
  }
}

export function saveRaydiumPositionState(state: Omit<RaydiumPositionState, 'updatedAt'>): void {
  setSyncValue(stateKey(state.nftMint), JSON.stringify({ ...state, updatedAt: Date.now() }))
}

export function deleteRaydiumPositionState(nftMint: string): void {
  deleteSyncValue(stateKey(nftMint))
}

export function listRaydiumPositionStates(): RaydiumPositionState[] {
  return listSyncValues(STATE_PREFIX).flatMap(row => getRaydiumPositionState(row.key.slice(STATE_PREFIX.length)) || [])
}

export interface RaydiumRebalanceSettings {
  nftMint: string
  enabled: boolean
  updatedAt: number
}

function settingsKey(nftMint: string): string {
  return `${SETTINGS_PREFIX}${nftMint}`
}

/**
 * Per-position auto rebalance override, stored separately from the OOR state so
 * a transient discovery gap never wipes the user's toggle. Missing or malformed
 * values default to enabled.
 */
export function getRaydiumRebalanceSettings(nftMint: string): RaydiumRebalanceSettings | null {
  const raw = getSyncValue(settingsKey(nftMint))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RaydiumRebalanceSettings>
    return {
      nftMint,
      enabled: parsed.enabled !== false,
      updatedAt: Number.isSafeInteger(parsed.updatedAt) ? parsed.updatedAt as number : Date.now(),
    }
  } catch {
    return null
  }
}

export function isRaydiumRebalanceEnabled(nftMint: string): boolean {
  return getRaydiumRebalanceSettings(nftMint)?.enabled ?? true
}

export function setRaydiumRebalanceEnabled(nftMint: string, enabled: boolean): void {
  setSyncValue(settingsKey(nftMint), JSON.stringify({ enabled, updatedAt: Date.now() }))
}

export function listRaydiumRebalanceSettings(): RaydiumRebalanceSettings[] {
  return listSyncValues(SETTINGS_PREFIX).flatMap(row => getRaydiumRebalanceSettings(row.key.slice(SETTINGS_PREFIX.length)) || [])
}
