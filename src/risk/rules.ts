import type { PositionRow, TriggerType } from '../types.js'
import { config } from '../config.js'

export interface TriggerDecision {
  shouldTrigger: boolean
  triggerType: TriggerType | null
  reason: string | null
}

export interface BinData {
  upperBinId?: number
  poolActiveBinId?: number
}

export function evaluateTrigger(
  position: PositionRow,
  currentPnlPercent: number,
  binData?: BinData,
): TriggerDecision {
  if (position.status === 'exiting' || position.status === 'closed') {
    return { shouldTrigger: false, triggerType: null, reason: 'position already exiting/closed' }
  }

  const baseTp = position.tpPercent ?? config.defaultTpPercent
  const tp = position.drawdownTpOverrideActive ? config.maxDrawdownTpOverride : baseTp
  const sl = position.slPercent ?? config.defaultSlPercent
  const trailDrop = config.trailingStopDropPct

  let triggered = false
  let triggerType: TriggerType | null = null
  let reason: string | null = null

  // Priority 1: Stop Loss — absolute floor, always
  if (currentPnlPercent <= sl) {
    triggered = true
    triggerType = 'SL'
    reason = `SL hit: ${currentPnlPercent.toFixed(2)}% <= ${sl}%`
  }
  // Priority 2: Take Profit — TP tetap jalan walau trailing aktif
  else if (currentPnlPercent >= tp) {
    triggered = true
    triggerType = 'TP'
    const overrideNote = tp !== baseTp ? ` (DD↓ TP overridden ${baseTp}%→${tp}%)` : ''
    reason = `TP hit: ${currentPnlPercent.toFixed(2)}% >= ${tp}%${overrideNote}`
  }
  // Priority 3: BIN_RANGE — auto close when PnL > threshold & close to upper bin
  // NOTE: PnL threshold in the else-if condition so failing distance check falls through to trailing stop
  else if (config.binRangeCloseEnabled && 
           binData?.upperBinId !== undefined && 
           binData?.poolActiveBinId !== undefined &&
           currentPnlPercent > config.binRangePnlThreshold) {
    const distance = binData.upperBinId - binData.poolActiveBinId
    if (distance >= 0 && distance <= config.binRangeMaxDistance) {
      triggered = true
      triggerType = 'BIN_RANGE'
      reason = `BIN_RANGE: PnL ${currentPnlPercent.toFixed(2)}% > ${config.binRangePnlThreshold}% & distance ${distance} bins <= ${config.binRangeMaxDistance}`
    }
  }
  // Priority 4: Trailing stop — hanya kalo trailing aktif, PnL positif, & PnL di bawah TP
  else if (position.trailingActivated && currentPnlPercent > 0) {
    const peak = position.peakPnlPercent
    const dropFromPeak = peak - currentPnlPercent
    if (dropFromPeak >= trailDrop) {
      triggered = true
      triggerType = 'TRAILING_STOP'
      reason = `Trailing stop: dropped ${dropFromPeak.toFixed(2)}% from peak ${peak.toFixed(2)}% (current ${currentPnlPercent.toFixed(2)}%)`
    }
  }

  // Confirmation counter — berlaku untuk semua trigger type
  if (triggered && config.triggerConfirmations > 1) {
    const newCount = (position.triggerConfirmations || 0) + 1
    if (newCount < config.triggerConfirmations) {
      return {
        shouldTrigger: false,
        triggerType,
        reason: `awaiting confirmation ${newCount}/${config.triggerConfirmations}`,
      }
    }
  }

  return { shouldTrigger: triggered, triggerType, reason }
}
