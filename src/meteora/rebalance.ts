import { MAX_BINS_PER_POSITION } from '@meteora-ag/dlmm'

export type RebalanceTimerStatus = 'none' | 'waiting' | 'ready'

export function isOorAbove(activeBinId: number | undefined, upperBinId: number | undefined): boolean {
  return activeBinId !== undefined && upperBinId !== undefined && activeBinId > upperBinId
}

export function rebalanceTimerStatus(
  oorSince: number | null,
  now: number,
  oorMinutes: number,
): RebalanceTimerStatus {
  if (oorSince === null || !Number.isFinite(oorSince)) return 'none'
  const elapsedMs = now - oorSince
  if (elapsedMs < 0) return 'none'
  if (elapsedMs >= oorMinutes * 60_000) return 'ready'
  return 'waiting'
}

export interface RebalanceRange {
  minBinId: number
  maxBinId: number
}

export function buildRebalanceRange(activeBinId: number, width: number): RebalanceRange {
  if (!Number.isInteger(activeBinId)) throw new Error('Active bin id is invalid')
  if (!Number.isInteger(width) || width < 1) throw new Error('Rebalance range width must be at least 1 bin')
  const maxBins = Number(MAX_BINS_PER_POSITION.toString())
  if (width > maxBins) throw new Error(`Rebalance range ${width} bins exceeds the ${maxBins}-bin position limit`)
  return {
    minBinId: activeBinId - width + 1,
    maxBinId: activeBinId,
  }
}
