import { deleteSyncValue, getSyncValue, listSyncValues, setSyncValue } from '../db/client.js'
import type { RebalanceDirection } from '../types.js'

const STATE_PREFIX = 'raydium_position_state:'

export interface RaydiumPositionState {
  nftMint: string
  since: number | null
  direction: RebalanceDirection | null
  notified: boolean
  cooldownUntil: number | null
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
