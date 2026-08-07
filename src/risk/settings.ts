import { config } from '../config.js'
import { getDb } from '../db/client.js'
import type { GlobalRiskSettings, PositionRow, RiskSettingField } from '../types.js'

export interface RiskSettingsPatch {
  slPercent?: number
  tpPercent?: number
  trailingEnabled?: boolean
  trailingActivationPct?: number
  trailingStopDropPct?: number
  ddLockTpPercent?: number
  rebalanceTpPercent?: number | null
  rebalanceSlPercent?: number | null
}

export interface RiskSettingsActor {
  chatId?: string
  userId?: string
}

export function defaultRiskSettings(): Omit<GlobalRiskSettings, 'revision' | 'updatedAt'> {
  return {
    slPercent: config.defaultSlPercent,
    tpPercent: config.defaultTpPercent,
    trailingEnabled: true,
    trailingActivationPct: config.trailingActivationPct,
    trailingStopDropPct: config.trailingStopDropPct,
    ddLockTpPercent: config.maxDrawdownTpOverride,
    rebalanceTpPercent: null,
    rebalanceSlPercent: null,
  }
}

export function validateRiskSettings(settings: Omit<GlobalRiskSettings, 'revision' | 'updatedAt'>): void {
  if (!Number.isFinite(settings.slPercent) || settings.slPercent >= 0 || settings.slPercent <= -100) {
    throw new Error('Stop Loss must be greater than -100% and less than 0%')
  }
  if (!Number.isFinite(settings.tpPercent) || settings.tpPercent <= 0 || settings.tpPercent > 1000) {
    throw new Error('Take Profit must be greater than 0% and at most 1000%')
  }
  if (!Number.isFinite(settings.trailingActivationPct) || settings.trailingActivationPct <= 0 || settings.trailingActivationPct > 1000) {
    throw new Error('Trailing arm must be greater than 0% and at most 1000%')
  }
  if (!Number.isFinite(settings.trailingStopDropPct) || settings.trailingStopDropPct <= 0 || settings.trailingStopDropPct >= settings.trailingActivationPct) {
    throw new Error('Trailing drop must be positive and lower than the trailing arm')
  }
  if (!Number.isFinite(settings.ddLockTpPercent) || settings.ddLockTpPercent <= 0 || settings.ddLockTpPercent > 1000) {
    throw new Error('DD Lock Take Profit must be greater than 0% and at most 1000%')
  }
  if (settings.rebalanceTpPercent !== null) {
    if (!Number.isFinite(settings.rebalanceTpPercent) || settings.rebalanceTpPercent <= 0 || settings.rebalanceTpPercent > 1000) {
      throw new Error('Rebalance Take Profit must be greater than 0% and at most 1000%')
    }
  }
  if (settings.rebalanceSlPercent !== null) {
    if (!Number.isFinite(settings.rebalanceSlPercent) || settings.rebalanceSlPercent >= 0 || settings.rebalanceSlPercent <= -100) {
      throw new Error('Rebalance Stop Loss must be greater than -100% and less than 0%')
    }
  }
}

function rowToRiskSettings(row: any): GlobalRiskSettings {
  const settings: GlobalRiskSettings = {
    slPercent: Number(row.sl_percent),
    tpPercent: Number(row.tp_percent),
    trailingEnabled: row.trailing_enabled === 1,
    trailingActivationPct: Number(row.trailing_activation_pct),
    trailingStopDropPct: Number(row.trailing_stop_drop_pct),
    ddLockTpPercent: Number(row.dd_lock_tp_percent),
    rebalanceTpPercent: row.rebalance_tp_percent === null || row.rebalance_tp_percent === undefined
      ? null
      : Number(row.rebalance_tp_percent),
    rebalanceSlPercent: row.rebalance_sl_percent === null || row.rebalance_sl_percent === undefined
      ? null
      : Number(row.rebalance_sl_percent),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
  }
  validateRiskSettings(settings)
  return settings
}

function ensureRiskSettings(): GlobalRiskSettings {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM risk_settings WHERE id = 1').get()
  if (existing) return rowToRiskSettings(existing)

  const defaults = defaultRiskSettings()
  validateRiskSettings(defaults)
  const now = Date.now()
  return db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO risk_settings
        (id, sl_percent, tp_percent, trailing_enabled, trailing_activation_pct, trailing_stop_drop_pct,
         dd_lock_tp_percent, rebalance_tp_percent, rebalance_sl_percent, revision, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      defaults.slPercent,
      defaults.tpPercent,
      defaults.trailingEnabled ? 1 : 0,
      defaults.trailingActivationPct,
      defaults.trailingStopDropPct,
      defaults.ddLockTpPercent,
      defaults.rebalanceTpPercent,
      defaults.rebalanceSlPercent,
      now,
    )
    if (inserted.changes === 1) {
      db.prepare(`
        UPDATE positions
        SET sl_percent = ?, tp_percent = ?, trigger_confirmations = 0, updated_at = ?
        WHERE status IN ('opening', 'discovering', 'monitoring')
      `).run(defaults.slPercent, defaults.tpPercent, now)
    }
    return rowToRiskSettings(db.prepare('SELECT * FROM risk_settings WHERE id = 1').get())
  })()
}

export function getRiskSettings(): GlobalRiskSettings {
  return ensureRiskSettings()
}

export function riskSettingValue(settings: GlobalRiskSettings, field: RiskSettingField): number | boolean | null {
  if (field === 'sl') return settings.slPercent
  if (field === 'tp') return settings.tpPercent
  if (field === 'trail_arm') return settings.trailingActivationPct
  if (field === 'trail_drop') return settings.trailingStopDropPct
  if (field === 'dd_tp') return settings.ddLockTpPercent
  if (field === 'rebal_tp') return settings.rebalanceTpPercent
  if (field === 'rebal_sl') return settings.rebalanceSlPercent
  return settings.trailingEnabled
}

export function effectiveRiskSettings(
  settings: GlobalRiskSettings,
  position: Pick<PositionRow, 'autoRebalanceEnabled'>,
): GlobalRiskSettings {
  if (!position.autoRebalanceEnabled) return settings
  return {
    ...settings,
    tpPercent: settings.rebalanceTpPercent ?? settings.tpPercent,
    slPercent: settings.rebalanceSlPercent ?? settings.slPercent,
  }
}

export function updateGlobalRiskSettings(patch: RiskSettingsPatch, actor: RiskSettingsActor = {}): GlobalRiskSettings {
  const current = getRiskSettings()
  const nextValues = {
    slPercent: patch.slPercent ?? current.slPercent,
    tpPercent: patch.tpPercent ?? current.tpPercent,
    trailingEnabled: patch.trailingEnabled ?? current.trailingEnabled,
    trailingActivationPct: patch.trailingActivationPct ?? current.trailingActivationPct,
    trailingStopDropPct: patch.trailingStopDropPct ?? current.trailingStopDropPct,
    ddLockTpPercent: patch.ddLockTpPercent ?? current.ddLockTpPercent,
    rebalanceTpPercent: patch.rebalanceTpPercent === undefined ? current.rebalanceTpPercent : patch.rebalanceTpPercent,
    rebalanceSlPercent: patch.rebalanceSlPercent === undefined ? current.rebalanceSlPercent : patch.rebalanceSlPercent,
  }
  validateRiskSettings(nextValues)

  const changed = current.slPercent !== nextValues.slPercent
    || current.tpPercent !== nextValues.tpPercent
    || current.trailingEnabled !== nextValues.trailingEnabled
    || current.trailingActivationPct !== nextValues.trailingActivationPct
    || current.trailingStopDropPct !== nextValues.trailingStopDropPct
    || current.ddLockTpPercent !== nextValues.ddLockTpPercent
    || current.rebalanceTpPercent !== nextValues.rebalanceTpPercent
    || current.rebalanceSlPercent !== nextValues.rebalanceSlPercent
  if (!changed) return current

  const now = Date.now()
  const nextRevision = current.revision + 1
  const trailingPolicyChanged = current.trailingEnabled !== nextValues.trailingEnabled
    || current.trailingActivationPct !== nextValues.trailingActivationPct
    || current.trailingStopDropPct !== nextValues.trailingStopDropPct

  const db = getDb()
  return db.transaction(() => {
    const updated = db.prepare(`
      UPDATE risk_settings
      SET sl_percent = ?, tp_percent = ?, trailing_enabled = ?,
          trailing_activation_pct = ?, trailing_stop_drop_pct = ?,
          dd_lock_tp_percent = ?, rebalance_tp_percent = ?, rebalance_sl_percent = ?,
          revision = ?, updated_at = ?
      WHERE id = 1 AND revision = ?
    `).run(
      nextValues.slPercent,
      nextValues.tpPercent,
      nextValues.trailingEnabled ? 1 : 0,
      nextValues.trailingActivationPct,
      nextValues.trailingStopDropPct,
      nextValues.ddLockTpPercent,
      nextValues.rebalanceTpPercent,
      nextValues.rebalanceSlPercent,
      nextRevision,
      now,
      current.revision,
    )
    if (updated.changes !== 1) throw new Error('Risk settings changed before confirmation; review the update again')

    if (trailingPolicyChanged) {
      db.prepare(`
        UPDATE positions
        SET sl_percent = ?, tp_percent = ?, trigger_confirmations = 0,
            peak_pnl_percent = 0, trailing_activated = 0, updated_at = ?
        WHERE status IN ('opening', 'discovering', 'monitoring')
      `).run(nextValues.slPercent, nextValues.tpPercent, now)
    } else {
      db.prepare(`
        UPDATE positions
        SET sl_percent = ?, tp_percent = ?, trigger_confirmations = 0, updated_at = ?
        WHERE status IN ('opening', 'discovering', 'monitoring')
      `).run(nextValues.slPercent, nextValues.tpPercent, now)
    }

    db.prepare(`
      INSERT INTO risk_setting_events
        (revision, old_settings, new_settings, actor_chat_id, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      nextRevision,
      JSON.stringify(current),
      JSON.stringify({ ...nextValues, revision: nextRevision, updatedAt: now }),
      actor.chatId ?? null,
      actor.userId ?? null,
      now,
    )

    return {
      ...nextValues,
      revision: nextRevision,
      updatedAt: now,
    }
  })()
}
