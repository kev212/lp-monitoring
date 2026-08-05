import { config } from '../config.js'
import { getDb } from '../db/client.js'
import type { GlobalRiskSettings, RiskSettingField } from '../types.js'

export interface RiskSettingsPatch {
  slPercent?: number
  tpPercent?: number
  trailingEnabled?: boolean
  trailingActivationPct?: number
  trailingStopDropPct?: number
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
}

function rowToRiskSettings(row: any): GlobalRiskSettings {
  const settings: GlobalRiskSettings = {
    slPercent: Number(row.sl_percent),
    tpPercent: Number(row.tp_percent),
    trailingEnabled: row.trailing_enabled === 1,
    trailingActivationPct: Number(row.trailing_activation_pct),
    trailingStopDropPct: Number(row.trailing_stop_drop_pct),
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
        (id, sl_percent, tp_percent, trailing_enabled, trailing_activation_pct, trailing_stop_drop_pct, revision, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      defaults.slPercent,
      defaults.tpPercent,
      defaults.trailingEnabled ? 1 : 0,
      defaults.trailingActivationPct,
      defaults.trailingStopDropPct,
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

export function riskSettingValue(settings: GlobalRiskSettings, field: RiskSettingField): number | boolean {
  if (field === 'sl') return settings.slPercent
  if (field === 'tp') return settings.tpPercent
  if (field === 'trail_arm') return settings.trailingActivationPct
  if (field === 'trail_drop') return settings.trailingStopDropPct
  return settings.trailingEnabled
}

export function updateGlobalRiskSettings(patch: RiskSettingsPatch, actor: RiskSettingsActor = {}): GlobalRiskSettings {
  const current = getRiskSettings()
  const nextValues = {
    slPercent: patch.slPercent ?? current.slPercent,
    tpPercent: patch.tpPercent ?? current.tpPercent,
    trailingEnabled: patch.trailingEnabled ?? current.trailingEnabled,
    trailingActivationPct: patch.trailingActivationPct ?? current.trailingActivationPct,
    trailingStopDropPct: patch.trailingStopDropPct ?? current.trailingStopDropPct,
  }
  validateRiskSettings(nextValues)

  const changed = current.slPercent !== nextValues.slPercent
    || current.tpPercent !== nextValues.tpPercent
    || current.trailingEnabled !== nextValues.trailingEnabled
    || current.trailingActivationPct !== nextValues.trailingActivationPct
    || current.trailingStopDropPct !== nextValues.trailingStopDropPct
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
          revision = ?, updated_at = ?
      WHERE id = 1 AND revision = ?
    `).run(
      nextValues.slPercent,
      nextValues.tpPercent,
      nextValues.trailingEnabled ? 1 : 0,
      nextValues.trailingActivationPct,
      nextValues.trailingStopDropPct,
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
