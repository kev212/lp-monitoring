import type { PositionRow } from '../types.js'
import { config } from '../config.js'

export interface TriggerDecision {
  shouldTrigger: boolean
  triggerType: 'TP' | 'SL' | null
  reason: string | null
}

export function evaluateTrigger(
  position: PositionRow,
  currentPnlPercent: number
): TriggerDecision {
  if (position.status === 'exiting' || position.status === 'closed') {
    return { shouldTrigger: false, triggerType: null, reason: 'position already exiting/closed' }
  }

  const tp = position.tpPercent ?? config.defaultTpPercent
  const sl = position.slPercent ?? config.defaultSlPercent

  let triggered = false
  let triggerType: 'TP' | 'SL' | null = null
  let reason: string | null = null

  if (currentPnlPercent <= sl) {
    triggered = true
    triggerType = 'SL'
    reason = `SL hit: ${currentPnlPercent.toFixed(2)}% <= ${sl}%`
  } else if (currentPnlPercent >= tp) {
    triggered = true
    triggerType = 'TP'
    reason = `TP hit: ${currentPnlPercent.toFixed(2)}% >= ${tp}%`
  }

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
