import { randomBytes } from 'node:crypto'
import TelegramBot from 'node-telegram-bot-api'
import { PublicKey } from '@solana/web3.js'
import { getPriceOfBinByBinId } from '@meteora-ag/dlmm'
import { config } from '../config.js'
import { deleteSyncValue, getSyncValue, setSyncValue } from '../db/client.js'
import { loadKnownPositions } from '../meteora/discovery.js'
import { executeExit } from '../meteora/exit.js'
import {
  executeOpenPosition,
  inspectOpenPool,
  OpenSubmissionPendingError,
  prepareOpenPosition,
  type OpenLiquidityStrategy,
  type OpenPositionPreview,
} from '../meteora/open.js'
import { getPool } from '../meteora/positions.js'
import { estimateExitValue, type ValuationResult } from '../meteora/valuation.js'
import { getRiskSettings, updateGlobalRiskSettings, validateRiskSettings, type RiskSettingsPatch } from '../risk/settings.js'
import { getConnection } from '../solana/connection.js'
import { getWallet } from '../solana/wallet.js'
import type { GlobalRiskSettings, PositionRow, RiskSettingField } from '../types.js'
import { buildBinRangeDisplay } from './binDisplay.js'

const DASHBOARD_PAGE_SIZE = 5
const DASHBOARD_KEY_PREFIX = 'telegram_dashboard:'
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

export type DashboardAction =
  | { type: 'show'; page: number }
  | { type: 'refresh'; page: number }
  | { type: 'close'; page: number }
  | { type: 'close_select'; page: number; positionPubkey: string }
  | { type: 'close_confirm'; token: string }
  | { type: 'open' }
  | { type: 'open_strategy'; strategy: OpenLiquidityStrategy }
  | { type: 'open_confirm'; token: string }
  | { type: 'open_cancel'; token: string }
  | { type: 'risk' }
  | { type: 'risk_field'; field: RiskSettingField }
  | { type: 'risk_toggle' }
  | { type: 'risk_confirm'; token: string }
  | { type: 'risk_cancel'; token: string }
  | { type: 'precision' }
  | { type: 'flip' }

type PendingOpenInput =
  | PendingBase & { kind: 'pool'; strategy: OpenLiquidityStrategy }
  | PendingBase & { kind: 'range'; strategy: OpenLiquidityStrategy; poolPubkey: string; quoteSymbol: string }
  | PendingBase & { kind: 'amount'; strategy: OpenLiquidityStrategy; poolPubkey: string; rangePercent: number; quoteSymbol: string }
  | PendingBase & { kind: 'risk'; field: RiskSettingField }

interface PendingBase {
  chatId: string
  userId: string
  dashboardMessageId: number
  expiresAt: number
  promptMessageId?: number
}

interface Confirmation<T> {
  chatId: string
  userId: string
  expiresAt: number
  value: T
}

interface CloseConfirmationValue {
  positionPubkey: string
  page: number
}

interface RiskConfirmationValue {
  field: RiskSettingField | 'trailing_toggle'
  oldValue: number | boolean
  newValue: number | boolean
  settings: GlobalRiskSettings
}

interface DashboardRender {
  text: string
  keyboard: TelegramBot.InlineKeyboardMarkup
  positions: PositionRow[]
  page: number
}

interface TelegramControlMenus {
  showPrecision: (chatId: number | string) => void
  showFlip: (chatId: number | string) => void
}

export function isTelegramAuthorized(
  chatId: string,
  userId: string | undefined,
  allowedChatId = config.telegramChatId,
  allowedUserId = config.telegramUserId,
): boolean {
  return Boolean(allowedChatId && allowedUserId && chatId === allowedChatId && userId === allowedUserId)
}

function parsePage(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const page = Number(value)
  return Number.isSafeInteger(page) ? page : null
}

export function parseRiskInput(field: RiskSettingField, input: string): number | null {
  const normalized = input.trim().replace(/%$/, '')
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null
  const value = Number(normalized)
  if (!Number.isFinite(value)) return null
  if (field === 'sl' && (value >= 0 || value <= -100)) return null
  if (field === 'tp' && (value <= 0 || value > 1000)) return null
  if (field === 'trail_arm' && (value <= 0 || value > 1000)) return null
  if (field === 'trail_drop' && value <= 0) return null
  return value
}

function riskFieldLabel(field: RiskSettingField | 'trailing_toggle'): string {
  if (field === 'sl') return 'Stop Loss'
  if (field === 'tp') return 'Take Profit'
  if (field === 'trail_arm') return 'Trail Arm'
  if (field === 'trail_drop') return 'Trail Drop'
  return 'Trailing'
}

export function parseDashboardAction(data: string | undefined): DashboardAction | null {
  if (!data?.startsWith('lpd:')) return null
  const parts = data.split(':')
  if (parts.length === 3 && (parts[1] === 'show' || parts[1] === 'refresh' || parts[1] === 'close')) {
    const page = parsePage(parts[2])
    return page === null ? null : { type: parts[1], page }
  }
  if (parts.length === 4 && parts[1] === 'pick') {
    const page = parsePage(parts[2])
    return page === null || !parts[3] ? null : { type: 'close_select', page, positionPubkey: parts[3] }
  }
  if (parts.length === 3 && parts[1] === 'cc' && parts[2]) return { type: 'close_confirm', token: parts[2] }
  if (parts.length === 2 && parts[1] === 'open') return { type: 'open' }
  if (parts.length === 3 && parts[1] === 'strategy' && ['spot', 'curve', 'bidask'].includes(parts[2] || '')) {
    return { type: 'open_strategy', strategy: parts[2] as OpenLiquidityStrategy }
  }
  if (parts.length === 3 && parts[1] === 'oc' && parts[2]) return { type: 'open_confirm', token: parts[2] }
  if (parts.length === 3 && parts[1] === 'ox' && parts[2]) return { type: 'open_cancel', token: parts[2] }
  if (parts.length === 2 && parts[1] === 'risk') return { type: 'risk' }
  if (parts.length === 3 && parts[1] === 'rs' && ['sl', 'tp', 'trail_arm', 'trail_drop'].includes(parts[2] || '')) {
    return { type: 'risk_field', field: parts[2] as RiskSettingField }
  }
  if (parts.length === 2 && parts[1] === 'rt') return { type: 'risk_toggle' }
  if (parts.length === 3 && parts[1] === 'rc' && parts[2]) return { type: 'risk_confirm', token: parts[2] }
  if (parts.length === 3 && parts[1] === 'rx' && parts[2]) return { type: 'risk_cancel', token: parts[2] }
  if (parts.length === 2 && parts[1] === 'precision') return { type: 'precision' }
  if (parts.length === 2 && parts[1] === 'flip') return { type: 'flip' }
  return null
}

function parsePoolAddress(input: string): string | null {
  const trimmed = input.trim()
  const fromUrl = /^https:\/\/app\.meteora\.ag\/dlmm\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/.exec(trimmed)?.[1]
  const value = fromUrl || trimmed
  try {
    return new PublicKey(value).toBase58()
  } catch {
    return null
  }
}

function strategyLabel(strategy: OpenLiquidityStrategy): string {
  if (strategy === 'bidask') return 'BidAsk'
  return strategy[0].toUpperCase() + strategy.slice(1)
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}..${value.slice(-4)}` : value
}

function formatQuote(value: number, quote: PositionRow['quoteCurrency']): string {
  return quote === 'USDC' ? `${value.toFixed(2)} USDC` : `${value.toFixed(4)} SOL`
}

function confirmationToken(): string {
  return randomBytes(8).toString('hex')
}

function isClosable(position: PositionRow): boolean {
  const now = Date.now()
  return (position.status === 'monitoring' || position.status === 'discovering')
    && !position.precisionCurveBusy
    && !position.flipModeBusy
    && !position.flipModePendingAdd
    && (position.precisionCurveRecoveryUntil ?? 0) <= now
    && (position.flipModeRecoveryUntil ?? 0) <= now
}

class TelegramDashboardController {
  private readonly pendingInput = new Map<string, PendingOpenInput>()
  private readonly openConfirmations = new Map<string, Confirmation<OpenPositionPreview>>()
  private readonly closeConfirmations = new Map<string, Confirmation<CloseConfirmationValue>>()
  private readonly riskConfirmations = new Map<string, Confirmation<RiskConfirmationValue>>()
  private readonly closeInFlight = new Set<string>()
  private openInFlight = false
  private readonly lastDashboardPositions = new Map<string, PositionRow[]>()

  constructor(
    private readonly bot: TelegramBot,
    private readonly menus: TelegramControlMenus,
  ) {}

  register(): void {
    this.bot.onText(/^\/(dashboard|status)(?:@\w+)?$/, (msg, match) => {
      if (!this.authorized(msg)) return
      void this.showDashboard(String(msg.chat.id), 0, undefined, match?.[1] === 'status').catch(err => this.reportError(msg.chat.id, err))
    })
    this.bot.onText(/^\/risk(?:@\w+)?$/, msg => {
      if (!this.authorized(msg)) return
      void this.showRiskMenu(String(msg.chat.id)).catch(err => this.reportError(msg.chat.id, err))
    })
    this.bot.onText(/^\/open(?:@\w+)?$/, msg => {
      if (!this.authorized(msg)) return
      void this.sendOpenStrategyMenu(msg.chat.id).catch(err => this.reportError(msg.chat.id, err))
    })
    this.bot.onText(/^\/close(?:@\w+)?(?:\s+(.+))?$/, (msg, match) => {
      if (!this.authorized(msg)) return
      void this.handleCloseCommand(msg, match?.[1]?.trim()).catch(err => this.reportError(msg.chat.id, err))
    })
    this.bot.on('callback_query', query => {
      if (!query.data?.startsWith('lpd:')) return
      void this.handleCallback(query).catch(err => {
        if (query.message) void this.reportError(query.message.chat.id, err)
      })
    })
    this.bot.on('message', msg => {
      if (!msg.text || msg.text.startsWith('/') || !this.authorized(msg)) return
      void this.handlePendingInput(msg).catch(err => this.reportError(msg.chat.id, err))
    })
  }

  private authorized(message: TelegramBot.Message): boolean {
    return isTelegramAuthorized(String(message.chat.id), message.from?.id.toString())
  }

  private async acknowledge(query: TelegramBot.CallbackQuery, text?: string): Promise<void> {
    try {
      await this.bot.answerCallbackQuery(query.id, text ? { text } : undefined)
    } catch {
      // Expired Telegram callbacks are safe to ignore.
    }
  }

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const message = query.message
    if (!message || !isTelegramAuthorized(String(message.chat.id), query.from.id.toString())) {
      await this.acknowledge(query, 'Tidak diizinkan.')
      return
    }
    const action = parseDashboardAction(query.data)
    if (!action) {
      await this.acknowledge(query, 'Tombol tidak valid.')
      return
    }
    await this.acknowledge(query, action.type === 'refresh' ? 'Memperbarui...' : undefined)
    const chatId = String(message.chat.id)

    if (action.type === 'show' || action.type === 'refresh') {
      await this.showDashboard(chatId, action.page, message.message_id)
      return
    }
    if (action.type === 'close') {
      await this.showCloseMenu(chatId, action.page, message.message_id)
      return
    }
    if (action.type === 'close_select') {
      await this.showCloseConfirmation(chatId, query.from.id.toString(), message.message_id, action.positionPubkey, action.page)
      return
    }
    if (action.type === 'close_confirm') {
      await this.startConfirmedClose(query, action.token)
      return
    }
    if (action.type === 'open') {
      await this.editOpenStrategyMenu(chatId, message.message_id)
      return
    }
    if (action.type === 'open_strategy') {
      this.pendingInput.set(chatId, {
        kind: 'pool',
        strategy: action.strategy,
        chatId,
        userId: query.from.id.toString(),
        dashboardMessageId: message.message_id,
        expiresAt: Date.now() + config.telegramConfirmTtlMs,
      })
      const dashboardMessageId = Number(getSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`) || 0)
      if (dashboardMessageId === message.message_id) {
        await this.showDashboard(chatId, 0, message.message_id)
      } else {
        await this.removeInlineKeyboard(message)
      }
      await this.bot.sendMessage(chatId, `Open ${strategyLabel(action.strategy)}: kirim pool address atau link Meteora DLMM.`, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Pool address' },
      })
      return
    }
    if (action.type === 'open_confirm') {
      await this.startConfirmedOpen(query, action.token)
      return
    }
    if (action.type === 'open_cancel') {
      this.openConfirmations.delete(action.token)
      await this.removeInlineKeyboard(message)
      await this.bot.sendMessage(chatId, 'Open position dibatalkan.')
      return
    }
    if (action.type === 'risk') {
      await this.showRiskMenu(chatId, message.message_id)
      return
    }
    if (action.type === 'risk_field') {
      await this.startRiskInput(chatId, query.from.id.toString(), message.message_id, action.field)
      return
    }
    if (action.type === 'risk_toggle') {
      await this.startRiskToggle(chatId, query.from.id.toString(), message.message_id)
      return
    }
    if (action.type === 'risk_confirm') {
      await this.confirmRiskChange(query, action.token)
      return
    }
    if (action.type === 'risk_cancel') {
      this.riskConfirmations.delete(action.token)
      await this.showRiskMenu(chatId, message.message_id)
      return
    }
    if (action.type === 'precision') {
      this.menus.showPrecision(message.chat.id)
      return
    }
    this.menus.showFlip(message.chat.id)
  }

  private async buildDashboard(requestedPage: number): Promise<DashboardRender> {
    const riskSettings = getRiskSettings()
    const positions = loadKnownPositions()
      .filter(position => position.status !== 'closed')
      .sort((a, b) => a.createdAt - b.createdAt)
    const pageCount = Math.max(1, Math.ceil(positions.length / DASHBOARD_PAGE_SIZE))
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1))
    const first = page * DASHBOARD_PAGE_SIZE
    const pagePositions = positions.slice(first, first + DASHBOARD_PAGE_SIZE)
    const valuations = await Promise.all(pagePositions.map(position =>
      position.status === 'monitoring' || position.status === 'discovering'
        ? estimateExitValue(position.poolPubkey, position.owner, position.positionPubkey, position.quoteCurrency).catch(() => null)
        : Promise.resolve(null)
    ))
    const binDisplays = await Promise.all(pagePositions.map((position, index) => {
      const valuation = valuations[index]
      return valuation ? buildPositionBinDisplay(position, valuation).catch(() => null) : Promise.resolve(null)
    }))
    const lines = [
      'LP MONITOR DASHBOARD',
      `Wallet: ${shortAddress(getWallet().publicKey.toBase58())}`,
      `Manual trading: ${config.telegramManualTradingEnabled ? 'ENABLED' : 'LOCKED'}`,
      `Risk: SL ${riskSettings.slPercent}% · TP +${riskSettings.tpPercent}% · Trail ${riskSettings.trailingEnabled ? `ON (${riskSettings.trailingActivationPct}%/${riskSettings.trailingStopDropPct}%)` : 'OFF'}`,
      `Updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      '',
    ]

    if (pagePositions.length === 0) {
      lines.push('Tidak ada posisi aktif.')
    } else {
      for (let index = 0; index < pagePositions.length; index++) {
        const position = pagePositions[index]
        const valuation = valuations[index]
        const label = `${position.tokenXSymbol || position.tokenXMint.slice(0, 4)}/${position.tokenYSymbol || position.tokenYMint.slice(0, 4)}`
        const pnl = valuation?.pnlPercent ?? position.lastPnlPercent
        const value = valuation?.estimatedExitQuote ?? position.lastEstimatedExitQuote
        const indicator = pnl === null ? '⚪' : pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪'
        const pnlLabel = pnl === null ? 'N/A' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`
        const valueLabel = value === null ? 'N/A' : formatQuote(value, position.quoteCurrency)
        const modes = [position.precisionCurveEnabled ? 'Precision' : '', position.flipModeEnabled ? 'Flip' : '', position.flipModePendingAdd ? 'FlipPending' : ''].filter(Boolean).join(', ') || 'off'
        const exceptionalStatus = ['opening', 'exiting', 'error'].includes(position.status) ? ` · ${position.status.toUpperCase()}` : ''
        lines.push(`${indicator} ${first + index + 1}. ${label}${exceptionalStatus}`)
        lines.push(`   PnL ${pnlLabel} | Value ${valueLabel} | Basis ${formatQuote(position.basisQuote, position.quoteCurrency)}`)
        if (binDisplays[index]) {
          lines.push(`   ${binDisplays[index]!.bar}`)
          lines.push(`   ${binDisplays[index]!.prices}`)
        }
        lines.push(`   Peak ${position.peakPnlPercent.toFixed(2)}% | Modes ${modes}`)
      }
    }
    if (pageCount > 1) lines.push('', `Page ${page + 1}/${pageCount} | ${positions.length} positions`)

    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
      [
        { text: 'Refresh', callback_data: `lpd:refresh:${page}` },
        { text: 'Close Position', callback_data: `lpd:close:${page}` },
      ],
      [{ text: 'Open Position', callback_data: 'lpd:open' }],
      [{ text: 'Risk Settings', callback_data: 'lpd:risk' }],
      [
        { text: 'Precision Curve', callback_data: 'lpd:precision' },
        { text: 'Flip Mode', callback_data: 'lpd:flip' },
      ],
    ]
    if (pageCount > 1) {
      const nav: TelegramBot.InlineKeyboardButton[] = []
      if (page > 0) nav.push({ text: 'Prev', callback_data: `lpd:show:${page - 1}` })
      if (page < pageCount - 1) nav.push({ text: 'Next', callback_data: `lpd:show:${page + 1}` })
      inline_keyboard.push(nav)
    }
    return { text: lines.join('\n'), keyboard: { inline_keyboard }, positions, page }
  }

  private async showDashboard(chatId: string, page: number, messageId?: number, forceNew = false): Promise<void> {
    const dashboard = await this.buildDashboard(page)
    this.lastDashboardPositions.set(chatId, dashboard.positions)
    const persistedId = Number(getSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`) || 0)
    const storedId = forceNew ? undefined : messageId ?? (persistedId || undefined)
    if (storedId) {
      try {
        await this.bot.editMessageText(dashboard.text, {
          chat_id: chatId,
          message_id: storedId,
          reply_markup: dashboard.keyboard,
        })
        setSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`, String(storedId))
        return
      } catch (err) {
        if (String(err).includes('message is not modified')) return
        if (!messageId) deleteSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`)
        else throw err
      }
    }
    const sent = await this.bot.sendMessage(chatId, dashboard.text, { reply_markup: dashboard.keyboard })
    setSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`, String(sent.message_id))
  }

  private async showCloseMenu(chatId: string, requestedPage: number, messageId: number): Promise<void> {
    const positions = loadKnownPositions().filter(isClosable)
    const pageCount = Math.max(1, Math.ceil(positions.length / DASHBOARD_PAGE_SIZE))
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1))
    const first = page * DASHBOARD_PAGE_SIZE
    const keyboard: TelegramBot.InlineKeyboardButton[][] = []
    for (const position of positions.slice(first, first + DASHBOARD_PAGE_SIZE)) {
      const label = `${position.tokenXSymbol}/${position.tokenYSymbol} ${shortAddress(position.positionPubkey)}`
      keyboard.push([{ text: label.slice(0, 64), callback_data: `lpd:pick:${page}:${position.positionPubkey}` }])
    }
    if (pageCount > 1) {
      const nav: TelegramBot.InlineKeyboardButton[] = []
      if (page > 0) nav.push({ text: 'Prev', callback_data: `lpd:close:${page - 1}` })
      if (page < pageCount - 1) nav.push({ text: 'Next', callback_data: `lpd:close:${page + 1}` })
      keyboard.push(nav)
    }
    keyboard.push([{ text: 'Back', callback_data: `lpd:show:${page}` }])
    await this.bot.editMessageText(
      positions.length > 0
        ? 'SELECT POSITION TO CLOSE\nPilih posisi untuk melihat fresh preview sebelum konfirmasi.'
        : 'Tidak ada posisi yang aman untuk ditutup saat ini.',
      { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } },
    )
  }

  private async showCloseConfirmation(
    chatId: string,
    userId: string,
    messageId: number,
    positionPubkey: string,
    page: number,
  ): Promise<void> {
    const position = loadKnownPositions().find(row => row.positionPubkey === positionPubkey)
    if (!position || !isClosable(position)) {
      await this.showCloseMenu(chatId, page, messageId)
      return
    }
    const valuation = await estimateExitValue(position.poolPubkey, position.owner, position.positionPubkey, position.quoteCurrency, true)
    if (!valuation) throw new Error('Fresh valuation unavailable; close was not armed')
    const token = confirmationToken()
    this.closeConfirmations.set(token, {
      chatId,
      userId,
      expiresAt: Date.now() + config.telegramConfirmTtlMs,
      value: { positionPubkey, page },
    })
    const label = `${position.tokenXSymbol}/${position.tokenYSymbol}`
    const text = [
      'CONFIRM MANUAL CLOSE',
      `${label} ${shortAddress(position.positionPubkey)}`,
      `PnL: ${valuation.pnlPercent >= 0 ? '+' : ''}${valuation.pnlPercent.toFixed(2)}%`,
      `Estimated value: ${formatQuote(valuation.estimatedExitQuote, position.quoteCurrency)}`,
      `Withdrawn before: ${formatQuote(valuation.withdrawalQuote, position.quoteCurrency)}`,
      '',
      `Liquidity akan dihapus, fee diklaim, position ditutup, lalu token hasil posisi ditukar ke ${position.quoteCurrency}.`,
      config.telegramManualTradingEnabled ? 'Konfirmasi berlaku satu kali.' : 'TRADING LOCKED: preview only.',
    ].join('\n')
    await this.bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Confirm Close', callback_data: `lpd:cc:${token}` },
          { text: 'Cancel', callback_data: `lpd:close:${page}` },
        ]],
      },
    })
  }

  private takeConfirmation<T>(
    map: Map<string, Confirmation<T>>,
    token: string,
    chatId: string,
    userId: string,
  ): T | null {
    const confirmation = map.get(token)
    if (!confirmation || confirmation.expiresAt < Date.now() || confirmation.chatId !== chatId || confirmation.userId !== userId) {
      if (confirmation?.expiresAt && confirmation.expiresAt < Date.now()) map.delete(token)
      return null
    }
    map.delete(token)
    return confirmation.value
  }

  private async startConfirmedClose(query: TelegramBot.CallbackQuery, token: string): Promise<void> {
    const message = query.message!
    const chatId = String(message.chat.id)
    if (!config.telegramManualTradingEnabled) {
      await this.bot.sendMessage(chatId, 'Manual trading masih dikunci oleh TELEGRAM_MANUAL_TRADING_ENABLED=false.')
      return
    }
    const confirmation = this.takeConfirmation(this.closeConfirmations, token, chatId, query.from.id.toString())
    if (!confirmation) {
      await this.bot.sendMessage(chatId, 'Konfirmasi close kedaluwarsa atau sudah dipakai.')
      return
    }
    if (this.closeInFlight.has(confirmation.positionPubkey)) {
      await this.bot.sendMessage(chatId, 'Close posisi ini sedang diproses.')
      return
    }
    this.closeInFlight.add(confirmation.positionPubkey)
    await this.bot.editMessageText('Closing position... remove liquidity dan settlement sedang diproses.', {
      chat_id: chatId,
      message_id: message.message_id,
    })
    void this.runConfirmedClose(chatId, message.message_id, confirmation).finally(() => {
      this.closeInFlight.delete(confirmation.positionPubkey)
    })
  }

  private async runConfirmedClose(chatId: string, messageId: number, confirmation: CloseConfirmationValue): Promise<void> {
    try {
      const position = loadKnownPositions().find(row => row.positionPubkey === confirmation.positionPubkey)
      if (!position || !isClosable(position)) throw new Error('Position is no longer available for manual close')
      const valuation = await estimateExitValue(position.poolPubkey, position.owner, position.positionPubkey, position.quoteCurrency, true)
      if (!valuation) throw new Error('Fresh valuation unavailable; no transaction was sent')
      const result = await executeExit(
        getConnection(),
        getWallet(),
        position.positionPubkey,
        position.poolPubkey,
        position.tokenXMint,
        position.tokenYMint,
        'MANUAL',
        valuation.pnlPercent,
        position.quoteCurrency,
        position.basisQuote,
        valuation.estimatedExitQuote,
      )
      if (result.pendingRecovery) {
        await this.bot.sendMessage(chatId, `Manual close menunggu rekonsiliasi final. Jangan ulangi close.\n${result.error || ''}`)
        return
      }
      if (!result.success) throw new Error(result.error || 'Manual close failed')
      const received = position.quoteCurrency === 'USDC' ? result.usdcReceived : result.solReceived
      await this.bot.sendMessage(chatId, `Manual close selesai. Received ${formatQuote(received, position.quoteCurrency)}\nRemove: ${result.removeLiqSig || '-'}\nSwap: ${result.swapSig || 'none'}`)
    } catch (err) {
      await this.bot.sendMessage(chatId, `Manual close gagal: ${errorMessage(err)}`)
    }
    await this.showDashboard(chatId, confirmation.page, messageId).catch(() => this.showDashboard(chatId, confirmation.page))
  }

  private async showRiskMenu(chatId: string, messageId?: number): Promise<void> {
    const settings = getRiskSettings()
    const activeCount = loadKnownPositions().filter(position => position.status === 'monitoring' || position.status === 'discovering').length
    const text = [
      'GLOBAL RISK SETTINGS',
      `Applies to: ${activeCount} active positions`,
      '',
      `Stop Loss: ${settings.slPercent}%`,
      `Take Profit: +${settings.tpPercent}%`,
      `Trailing: ${settings.trailingEnabled ? 'ON' : 'OFF'}`,
      `Trail Arm: +${settings.trailingActivationPct}%`,
      `Trail Drop: ${settings.trailingStopDropPct}% from peak`,
      `Policy revision: ${settings.revision}`,
      '',
      'Changes apply to all active positions after confirmation.',
    ].join('\n')
    const keyboard: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: 'Set SL', callback_data: 'lpd:rs:sl' },
          { text: 'Set TP', callback_data: 'lpd:rs:tp' },
        ],
        [
          { text: `Trailing ${settings.trailingEnabled ? 'OFF' : 'ON'}`, callback_data: 'lpd:rt' },
        ],
        [
          { text: 'Set Trail Arm', callback_data: 'lpd:rs:trail_arm' },
          { text: 'Set Trail Drop', callback_data: 'lpd:rs:trail_drop' },
        ],
        [{ text: 'Back to Dashboard', callback_data: 'lpd:show:0' }],
      ],
    }
    if (messageId) {
      try {
        await this.bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: keyboard })
        return
      } catch (err) {
        if (String(err).includes('message is not modified')) return
      }
    }
    await this.bot.sendMessage(chatId, text, { reply_markup: keyboard })
  }

  private async startRiskInput(chatId: string, userId: string, messageId: number, field: RiskSettingField): Promise<void> {
    const settings = getRiskSettings()
    const prompt = await this.bot.sendMessage(
      chatId,
      `Risk Settings — ${riskFieldLabel(field)}\n` +
        `Current: ${formatRiskValue(field, riskFieldValue(settings, field))}\n` +
        `Kirim angka baru${field === 'sl' ? ' negatif' : ' positif'} (contoh: ${field === 'sl' ? '-12' : field === 'tp' ? '8' : '3'}).`,
      { reply_markup: { force_reply: true, input_field_placeholder: field === 'sl' ? '-12' : '3' } },
    )
    this.pendingInput.set(chatId, {
      kind: 'risk',
      field,
      chatId,
      userId,
      dashboardMessageId: messageId,
      promptMessageId: prompt.message_id,
      expiresAt: Date.now() + config.telegramConfirmTtlMs,
    })
  }

  private async startRiskToggle(chatId: string, userId: string, messageId: number): Promise<void> {
    const settings = getRiskSettings()
    await this.armRiskConfirmation(chatId, userId, messageId, 'trailing_toggle', !settings.trailingEnabled)
  }

  private async armRiskConfirmation(
    chatId: string,
    userId: string,
    _messageId: number,
    field: RiskSettingField | 'trailing_toggle',
    newValue: number | boolean,
  ): Promise<void> {
    const settings = getRiskSettings()
    const patch = riskPatch(field, newValue)
    try {
      validateRiskSettings({
        slPercent: patch.slPercent ?? settings.slPercent,
        tpPercent: patch.tpPercent ?? settings.tpPercent,
        trailingEnabled: patch.trailingEnabled ?? settings.trailingEnabled,
        trailingActivationPct: patch.trailingActivationPct ?? settings.trailingActivationPct,
        trailingStopDropPct: patch.trailingStopDropPct ?? settings.trailingStopDropPct,
      })
    } catch (err) {
      await this.bot.sendMessage(chatId, `Risk setting tidak valid: ${errorMessage(err)}`)
      return
    }
    const token = confirmationToken()
    this.riskConfirmations.set(token, {
      chatId,
      userId,
      expiresAt: Date.now() + config.telegramConfirmTtlMs,
      value: { field, oldValue: riskFieldValue(settings, field), newValue, settings },
    })
    const activePositions = loadKnownPositions().filter(position => position.status === 'monitoring' || position.status === 'discovering')
    const crossed = field === 'sl' && typeof newValue === 'number'
      ? activePositions.filter(position => (position.lastPnlPercent ?? Number.POSITIVE_INFINITY) <= newValue).length
      : 0
    const text = [
      'CONFIRM GLOBAL RISK CHANGE',
      `${riskFieldLabel(field)}: ${formatRiskValue(field, riskFieldValue(settings, field))} -> ${formatRiskValue(field, newValue)}`,
      `Affected positions: ${activePositions.length}`,
      crossed > 0 ? `WARNING: ${crossed} position(s) already crossed this SL.` : null,
      field === 'tp' && activePositions.some(position => position.drawdownTpOverrideActive)
        ? 'Effective TP remains DD override on positions with Drawdown Lock.'
        : null,
      '',
      'Perubahan berlaku setelah konfirmasi dan reset trigger confirmations.',
    ].filter(Boolean).join('\n')
    await this.bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Confirm', callback_data: `lpd:rc:${token}` },
          { text: 'Cancel', callback_data: `lpd:rx:${token}` },
        ]],
      },
    })
  }

  private async confirmRiskChange(query: TelegramBot.CallbackQuery, token: string): Promise<void> {
    const message = query.message!
    const chatId = String(message.chat.id)
    const confirmation = this.takeConfirmation(this.riskConfirmations, token, chatId, query.from.id.toString())
    if (!confirmation) {
      await this.bot.sendMessage(chatId, 'Konfirmasi risk kedaluwarsa atau sudah dipakai.')
      return
    }
    const current = getRiskSettings()
    const oldValue = riskFieldValue(current, confirmation.field)
    if (current.revision !== confirmation.settings.revision || oldValue !== confirmation.oldValue) {
      await this.bot.sendMessage(chatId, 'Risk settings sudah berubah. Review ulang perubahan terbaru.')
      return
    }
    const result = updateGlobalRiskSettings(
      riskPatch(confirmation.field, confirmation.newValue),
      { chatId, userId: query.from.id.toString() },
    )
    await this.bot.editMessageText(
      `Risk settings updated. Revision ${result.revision}\n${riskSettingsSummary(result)}`,
      { chat_id: chatId, message_id: message.message_id },
    ).catch(() => undefined)
    await this.showRiskMenu(chatId)
  }

  private async sendOpenStrategyMenu(chatId: number | string): Promise<void> {
    await this.bot.sendMessage(chatId, 'OPEN POSITION\nPilih distribusi liquidity:', {
      reply_markup: this.openStrategyKeyboard(),
    })
  }

  private async editOpenStrategyMenu(chatId: string, messageId: number): Promise<void> {
    await this.bot.editMessageText('OPEN POSITION\nPilih distribusi liquidity:', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: this.openStrategyKeyboard(true),
    })
  }

  private openStrategyKeyboard(includeBack = false): TelegramBot.InlineKeyboardMarkup {
    const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [
      [
        { text: 'Spot', callback_data: 'lpd:strategy:spot' },
        { text: 'Curve', callback_data: 'lpd:strategy:curve' },
        { text: 'BidAsk', callback_data: 'lpd:strategy:bidask' },
      ],
    ]
    if (includeBack) inline_keyboard.push([{ text: 'Back', callback_data: 'lpd:show:0' }])
    return { inline_keyboard }
  }

  private async handlePendingInput(message: TelegramBot.Message): Promise<void> {
    const chatId = String(message.chat.id)
    const pending = this.pendingInput.get(chatId)
    if (!pending || pending.userId !== message.from?.id.toString()) return
    if (pending.promptMessageId && message.reply_to_message?.message_id !== pending.promptMessageId) return
    if (pending.expiresAt < Date.now()) {
      this.pendingInput.delete(chatId)
      await this.bot.sendMessage(chatId, 'Input kedaluwarsa. Mulai lagi dari dashboard.')
      return
    }
    const text = message.text!.trim()

    if (pending.kind === 'pool') {
      const poolPubkey = parsePoolAddress(text)
      if (!poolPubkey) {
        await this.bot.sendMessage(chatId, 'Pool address tidak valid. Kirim address Solana atau link Meteora DLMM.')
        return
      }
      try {
        const poolInfo = await inspectOpenPool(getConnection(), poolPubkey)
        const prompt = await this.bot.sendMessage(chatId, `Pool ${poolInfo.baseSymbol}/${poolInfo.quoteSymbol}. Kirim range penurunan harga 1-99% (contoh: 30).`, {
          reply_markup: { force_reply: true, input_field_placeholder: '30' },
        })
        this.pendingInput.set(chatId, {
          ...pending,
          kind: 'range',
          poolPubkey,
          quoteSymbol: poolInfo.quoteSymbol,
          promptMessageId: prompt.message_id,
          expiresAt: Date.now() + config.telegramConfirmTtlMs,
        })
      } catch (err) {
        await this.bot.sendMessage(chatId, `Pool tidak dapat dipakai: ${errorMessage(err)}`)
      }
      return
    }

    if (pending.kind === 'range') {
      const rangePercent = Number(text.replace(/[%\s,]/g, ''))
      if (!Number.isFinite(rangePercent) || rangePercent <= 0 || rangePercent >= 100) {
        await this.bot.sendMessage(chatId, 'Range tidak valid. Kirim angka lebih dari 0 dan kurang dari 100.')
        return
      }
      const prompt = await this.bot.sendMessage(chatId, `Kirim jumlah deposit single-side dalam ${pending.quoteSymbol}.`, {
        reply_markup: { force_reply: true, input_field_placeholder: pending.quoteSymbol === 'SOL' ? '0.1' : '100' },
      })
      this.pendingInput.set(chatId, {
        ...pending,
        kind: 'amount',
        rangePercent,
        promptMessageId: prompt.message_id,
        expiresAt: Date.now() + config.telegramConfirmTtlMs,
      })
      return
    }

    if (pending.kind === 'risk') {
      const value = parseRiskInput(pending.field, text)
      if (value === null) {
        await this.bot.sendMessage(chatId, `Input ${riskFieldLabel(pending.field)} tidak valid. Gunakan angka ${pending.field === 'sl' ? 'negatif' : 'positif'} yang valid.`)
        return
      }
      this.pendingInput.delete(chatId)
      await this.armRiskConfirmation(chatId, pending.userId, pending.dashboardMessageId, pending.field, value)
      return
    }

    try {
      const preview = await prepareOpenPosition(
        getConnection(),
        getWallet().publicKey,
        pending.poolPubkey,
        text,
        pending.rangePercent,
        pending.strategy,
      )
      this.pendingInput.delete(chatId)
      await this.sendOpenPreview(message, preview)
    } catch (err) {
      await this.bot.sendMessage(chatId, `Preview open gagal: ${errorMessage(err)}. Kirim jumlah lagi atau mulai ulang dari dashboard.`)
    }
  }

  private async sendOpenPreview(message: TelegramBot.Message, preview: OpenPositionPreview): Promise<void> {
    const chatId = String(message.chat.id)
    const token = confirmationToken()
    this.openConfirmations.set(token, {
      chatId,
      userId: message.from!.id.toString(),
      expiresAt: Date.now() + config.telegramConfirmTtlMs,
      value: preview,
    })
    const text = [
      'OPEN POSITION REVIEW',
      `${preview.baseSymbol}/${preview.quoteSymbol} | ${strategyLabel(preview.strategy)}`,
      `Pool: ${shortAddress(preview.poolPubkey)}`,
      `Deposit: ${preview.amountInput} ${preview.quoteSymbol}`,
      `Current price: ${preview.currentPriceQuote.toPrecision(8)} ${preview.quoteSymbol}`,
      `Target price: ${preview.targetPriceQuote.toPrecision(8)} ${preview.quoteSymbol} (-${preview.rangePercent}%)`,
      `Bins: ${preview.minBinId} to ${preview.maxBinId} (${preview.binCount})`,
      `Price movement guard: ${preview.maxPriceMoveBins} bins total`,
      `Estimated rent/setup: ${preview.estimatedPositionCostSol.toFixed(4)} SOL`,
      '',
      config.telegramManualTradingEnabled ? 'Konfirmasi berlaku satu kali.' : 'TRADING LOCKED: preview only.',
    ].join('\n')
    await this.bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Confirm Open', callback_data: `lpd:oc:${token}` },
          { text: 'Cancel', callback_data: `lpd:ox:${token}` },
        ]],
      },
    })
  }

  private async startConfirmedOpen(query: TelegramBot.CallbackQuery, token: string): Promise<void> {
    const message = query.message!
    const chatId = String(message.chat.id)
    if (!config.telegramManualTradingEnabled) {
      await this.bot.sendMessage(chatId, 'Manual trading masih dikunci oleh TELEGRAM_MANUAL_TRADING_ENABLED=false.')
      return
    }
    const preview = this.takeConfirmation(this.openConfirmations, token, chatId, query.from.id.toString())
    if (!preview) {
      await this.bot.sendMessage(chatId, 'Konfirmasi open kedaluwarsa atau sudah dipakai.')
      return
    }
    if (this.openInFlight) {
      await this.bot.sendMessage(chatId, 'Open position lain sedang diproses.')
      return
    }
    this.openInFlight = true
    let result: Awaited<ReturnType<typeof executeOpenPosition>>
    try {
      await this.removeInlineKeyboard(message)
      await this.bot.sendMessage(chatId, 'Opening position... harga dan saldo sedang diperiksa ulang.')
      result = await executeOpenPosition(getConnection(), getWallet(), preview)
    } catch (err) {
      if (err instanceof OpenSubmissionPendingError) {
        await this.bot.sendMessage(chatId, [
          'Open position masih menunggu rekonsiliasi final. Jangan kirim open ulang.',
          `Position: ${err.positionPubkey}`,
          `Transaction: ${err.signature}`,
        ].join('\n'))
        await this.showDashboard(chatId, 0).catch(() => undefined)
      } else {
        await this.bot.sendMessage(chatId, `Open position gagal: ${errorMessage(err)}`)
      }
      return
    } finally {
      this.openInFlight = false
    }
    await this.bot.sendMessage(chatId, [
      'Open position berhasil.',
      `${result.preview.baseSymbol}/${result.preview.quoteSymbol} | ${strategyLabel(result.preview.strategy)}`,
      `Position: ${result.positionPubkey}`,
      `Transaction: ${result.signature}`,
    ].join('\n')).catch(() => undefined)
    await this.showDashboard(chatId, 0).catch(() => undefined)
  }

  private async removeInlineKeyboard(message: TelegramBot.Message): Promise<void> {
    try {
      await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: message.chat.id,
        message_id: message.message_id,
      })
    } catch {
      // The review message may already have been removed by Telegram.
    }
  }

  private async handleCloseCommand(message: TelegramBot.Message, input?: string): Promise<void> {
    const chatId = String(message.chat.id)
    const dashboard = await this.buildDashboard(0)
    this.lastDashboardPositions.set(chatId, dashboard.positions)
    let position: PositionRow | undefined
    if (input) {
      const index = Number(input)
      if (Number.isInteger(index) && index > 0) position = dashboard.positions[index - 1]
      if (!position) position = loadKnownPositions().find(row => row.positionPubkey === input)
    }
    const storedId = Number(getSyncValue(`${DASHBOARD_KEY_PREFIX}${chatId}`) || 0)
    if (!storedId) {
      await this.showDashboard(chatId, 0)
      await this.bot.sendMessage(chatId, 'Dashboard dibuat. Gunakan tombol Close Position.')
      return
    }
    if (!position) {
      await this.showCloseMenu(chatId, 0, storedId)
      return
    }
    await this.showCloseConfirmation(chatId, message.from!.id.toString(), storedId, position.positionPubkey, 0)
  }

  private async reportError(chatId: number | string, err: unknown): Promise<void> {
    await this.bot.sendMessage(chatId, `Dashboard error: ${errorMessage(err)}`).catch(() => undefined)
  }
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/[<>]/g, '').slice(0, 300)
}

function riskFieldValue(settings: GlobalRiskSettings, field: RiskSettingField | 'trailing_toggle'): number | boolean {
  if (field === 'sl') return settings.slPercent
  if (field === 'tp') return settings.tpPercent
  if (field === 'trail_arm') return settings.trailingActivationPct
  if (field === 'trail_drop') return settings.trailingStopDropPct
  return settings.trailingEnabled
}

function riskPatch(field: RiskSettingField | 'trailing_toggle', value: number | boolean): RiskSettingsPatch {
  if (field === 'sl') return { slPercent: Number(value) }
  if (field === 'tp') return { tpPercent: Number(value) }
  if (field === 'trail_arm') return { trailingActivationPct: Number(value) }
  if (field === 'trail_drop') return { trailingStopDropPct: Number(value) }
  return { trailingEnabled: Boolean(value) }
}

function formatRiskValue(field: RiskSettingField | 'trailing_toggle', value: number | boolean): string {
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF'
  if (field === 'sl') return `${value}%`
  return `+${value}%`
}

function riskSettingsSummary(settings: GlobalRiskSettings): string {
  return `SL ${settings.slPercent}% · TP +${settings.tpPercent}% · Trail ${settings.trailingEnabled ? `ON (${settings.trailingActivationPct}%/${settings.trailingStopDropPct}%)` : 'OFF'}`
}

export function setupTelegramControl(bot: TelegramBot, menus: TelegramControlMenus): void {
  new TelegramDashboardController(bot, menus).register()
}

async function buildPositionBinDisplay(position: PositionRow, valuation: ValuationResult) {
  if (valuation.lowerBinId === undefined || valuation.upperBinId === undefined || valuation.poolActiveBinId === undefined) return null
  const pool = await getPool(getConnection(), new PublicKey(position.poolPubkey))
  const quoteMint = position.quoteCurrency === 'SOL' ? SOL_MINT : USDC_MINT
  const tokenXMint = pool.tokenX.publicKey.toBase58()
  const quoteSide = tokenXMint === quoteMint ? 'X' : 'Y'
  return buildBinRangeDisplay({
    lowerBinId: valuation.lowerBinId,
    activeBinId: valuation.poolActiveBinId,
    upperBinId: valuation.upperBinId,
    quoteSide,
    quoteCurrency: position.quoteCurrency,
    priceForBin: binId => Number(pool.fromPricePerLamport(Number(getPriceOfBinByBinId(binId, pool.lbPair.binStep)))),
  })
}
