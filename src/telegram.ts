import TelegramBot from 'node-telegram-bot-api'
import { config } from './config.js'
import { loadActivePositions, updateFlipModeEnabled, updatePrecisionCurveEnabled, updatePrecisionCurveThreshold } from './meteora/discovery.js'
import { getDb } from './db/client.js'
import type { QuoteCurrency } from './types.js'
import { setupTelegramControl } from './telegram/control.js'

let _bot: TelegramBot | null = null

const TELEGRAM_COMMANDS = [
  { command: 'dashboard', description: 'Open the LP control dashboard' },
  { command: 'status', description: 'Open the LP control dashboard' },
  { command: 'open', description: 'Open a Meteora position' },
  { command: 'close', description: 'Close a position from the dashboard' },
  { command: 'precision', description: 'Precision Curve settings menu' },
  { command: 'flip', description: 'Flip Mode settings menu' },
  { command: 'help', description: 'List all available commands' },
]

function getBot(): TelegramBot | null {
  if (!config.telegramBotToken || !config.telegramChatId) return null
  if (!_bot) {
    _bot = new TelegramBot(config.telegramBotToken, { polling: true })
    if (!config.telegramUserId) {
      console.log('[telegram] TELEGRAM_USER_ID is required when TELEGRAM_CHAT_ID is a group')
    }
    setupCommandHandlers(_bot)
  }
  return _bot
}

export function sendNotification(message: string): void {
  const bot = getBot()
  if (!bot || !config.telegramChatId) return

  bot.sendMessage(config.telegramChatId, message, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(err => {
    console.log(`[telegram] send failed: ${err.message}`)
  })
}

function isAllowedChat(chatId: number | string, userId: number | string | undefined): boolean {
  return String(chatId) === String(config.telegramChatId)
    && String(userId ?? '') === String(config.telegramUserId)
}

function setupCommandHandlers(bot: TelegramBot): void {
  const db = getDb()
  const wiped = db.prepare("SELECT value FROM sync_state WHERE key = 'telegram_commands_wiped_v2'").get() as any

  if (!wiped || wiped.value !== '1') {
    const scopes: Array<{ scope?: { type: string }; label: string }> = [
      { scope: { type: 'default' }, label: 'default' },
      { scope: { type: 'all_private_chats' }, label: 'all_private_chats' },
      { scope: { type: 'all_group_chats' }, label: 'all_group_chats' },
      { scope: { type: 'all_chat_administrators' }, label: 'all_chat_administrators' },
    ]
    const failures: string[] = []

    ;(async () => {
      for (const s of scopes) {
        try {
          await (bot as any).setMyCommands(TELEGRAM_COMMANDS, s.scope ? { scope: s.scope } : {})
        } catch (err: any) {
          failures.push(`${s.label}: ${err.message}`)
        }
      }
      if (failures.length > 0) {
        console.log(`[telegram] wipe v2 failures: ${failures.join('; ')} — retrying next restart`)
      } else {
        db.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('telegram_commands_wiped_v2', '1', ?)").run(Date.now())
        console.log('[telegram] wiped v2 all scopes with bot commands')
      }
      console.log(`[telegram] registered commands: ${TELEGRAM_COMMANDS.map(c => `/${c.command}`).join(', ')}`)
    })().catch((err: any) => console.log(`[telegram] wipe v2 error: ${err.message}`))
  } else {
    bot.setMyCommands(TELEGRAM_COMMANDS)
      .then(() => console.log(`[telegram] registered commands: ${TELEGRAM_COMMANDS.map(c => `/${c.command}`).join(', ')}`))
      .catch(err => console.log(`[telegram] setMyCommands failed: ${err.message}`))
  }

  bot.onText(/^\/precision(?:\s+(.+))?$/, msg => {
    if (!msg.chat || !isAllowedChat(msg.chat.id, msg.from?.id)) return
    sendPrecisionMenu(bot, msg.chat.id)
  })

  bot.onText(/^\/flip(?:\s+(.+))?$/, msg => {
    if (!msg.chat || !isAllowedChat(msg.chat.id, msg.from?.id)) return
    sendFlipMenu(bot, msg.chat.id)
  })

  bot.onText(/^\/help$/, msg => {
    if (!msg.chat || !isAllowedChat(msg.chat.id, msg.from?.id)) return
    bot.sendMessage(msg.chat.id,
      `📋 <b>Available Commands</b>\n\n` +
      TELEGRAM_COMMANDS.map(c => `/${c.command} — ${c.description}`).join('\n'),
      { parse_mode: 'HTML', disable_web_page_preview: true }
    ).catch(() => undefined)
  })

  bot.on('callback_query', async query => {
    const chatId = query.message?.chat.id
    if (!chatId || !isAllowedChat(chatId, query.from.id)) return
    const data = query.data || ''
    if (!data.startsWith('pc:') && !data.startsWith('flip:')) return

    const [, action, pubkey] = data.split(':')
    const positions = loadActivePositions()
    const pos = positions.find(p => p.positionPubkey === pubkey)
    if (!pos) {
      await bot.answerCallbackQuery(query.id, { text: 'Position not active' }).catch(() => undefined)
      if (data.startsWith('flip:')) sendFlipMenu(bot, chatId)
      else sendPrecisionMenu(bot, chatId)
      return
    }

    if (data.startsWith('pc:')) {
      if (action === 'on') {
        updatePrecisionCurveEnabled(pos.positionPubkey, true, null)
        updatePrecisionCurveThreshold(pos.positionPubkey, 5)
        await bot.answerCallbackQuery(query.id, { text: 'Precision Curve enabled — Flip Mode disabled' }).catch(() => undefined)
      } else if (action === 'off') {
        updatePrecisionCurveEnabled(pos.positionPubkey, false)
        await bot.answerCallbackQuery(query.id, { text: 'Precision Curve disabled' }).catch(() => undefined)
      } else if (action === 'status') {
        await bot.answerCallbackQuery(query.id, { text: precisionStatusText(pos), show_alert: true }).catch(() => undefined)
        return
      }

      sendPrecisionMenu(bot, chatId)
      return
    }

    if (action === 'on') {
      updateFlipModeEnabled(pos.positionPubkey, true)
      await bot.answerCallbackQuery(query.id, { text: 'Flip Mode enabled — Precision disabled' }).catch(() => undefined)
    } else if (action === 'off') {
      updateFlipModeEnabled(pos.positionPubkey, false)
      await bot.answerCallbackQuery(query.id, { text: 'Flip Mode disabled' }).catch(() => undefined)
    } else if (action === 'status') {
      await bot.answerCallbackQuery(query.id, { text: flipStatusText(pos), show_alert: true }).catch(() => undefined)
      return
    }

    sendFlipMenu(bot, chatId)
  })

  setupTelegramControl(bot, {
    showPrecision: chatId => sendPrecisionMenu(bot, chatId),
    showFlip: chatId => sendFlipMenu(bot, chatId),
  })
}

function sendStatusMenu(bot: TelegramBot, chatId: number | string): void {
  const positions = loadActivePositions()
  if (positions.length === 0) {
    bot.sendMessage(chatId, 'No active positions.', { parse_mode: 'HTML' }).catch(() => undefined)
    return
  }

  const lines = [
    `📊 <b>Active Positions (${positions.length})</b>`,
    sep(),
    ...positions.map((p, idx) => {
      const label = `${p.tokenXSymbol || p.tokenXMint.slice(0, 4)}/${p.tokenYSymbol || p.tokenYMint.slice(0, 4)}`
      const pnl = p.lastPnlPercent ?? 0
      const sign = pnl >= 0 ? '+' : ''
      const emoji = pnl >= 5 ? '🟢' : pnl >= 0 ? '📘' : pnl >= -5 ? '📙' : '🔴'
      const value = p.lastEstimatedExitQuote ?? 0
      const peak = p.peakPnlPercent ?? 0
      const trail = p.trailingActivated ? ' 🔻' : ''
      const modes = `${p.precisionCurveEnabled ? ' Precision' : ''}${p.flipModeEnabled ? ' Flip' : ''}${p.flipModePendingAdd ? ' FlipPending' : ''}`
      return `${idx + 1}. ${emoji} <b>${label}</b> <code>${shortAddr(p.positionPubkey)}</code>\n` +
        `   PnL: <b>${sign}${pnl.toFixed(2)}%</b> | Value: <b>${formatQuoteValue(value, p.quoteCurrency)}</b>\n` +
        `   SL: <b>${p.slPercent}%</b> TP: <b>+${p.tpPercent}%</b> | Peak: <b>${peak.toFixed(2)}%</b>${trail}${modes}`
    }),
  ]

  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(err => {
    console.log(`[telegram] status menu failed: ${err.message}`)
  })
}

function sendFlipMenu(bot: TelegramBot, chatId: number | string): void {
  const positions = loadActivePositions()
  if (positions.length === 0) {
    bot.sendMessage(chatId, 'No active positions.', { parse_mode: 'HTML' }).catch(() => undefined)
    return
  }

  const lines = [
    `<b>Flip Mode</b>`,
    sep(),
    `Default: <b>off</b> | First trigger: <b>${config.flipModeInitialTriggerPct}%</b> | Repeat: <b>${config.flipModeRepeatStepPct}%</b>`,
    `Withdraw non-SOL token-only liquidity and add back as BidAsk.`,
    sep(),
    ...positions.map((p, idx) => {
      const label = `${p.tokenXSymbol || p.tokenXMint.slice(0, 4)}/${p.tokenYSymbol || p.tokenYMint.slice(0, 4)}`
      const state = p.flipModeEnabled ? 'ON' : 'OFF'
      const busy = p.flipModeBusy ? ' busy' : ''
      const pending = p.flipModePendingAdd ? ' pending-add' : ''
      const last = p.flipModeLastProgressPct === null ? '-' : `${p.flipModeLastProgressPct.toFixed(2)}%`
      const next = nextFlipTriggerPct(p)
      return `${idx + 1}. <b>${label}</b> <code>${shortAddr(p.positionPubkey)}</code> — <b>${state}</b>${busy}${pending}\nLast flip: <b>${last}</b> | Next trigger: <b>${next.toFixed(2)}%</b>`
    })
  ]

  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: positions.flatMap(p => {
        const label = `${p.tokenXSymbol || p.tokenXMint.slice(0, 4)}/${p.tokenYSymbol || p.tokenYMint.slice(0, 4)} ${shortAddr(p.positionPubkey)}`
        return [[
          { text: p.flipModeEnabled ? `Disable ${label}` : `Enable ${label}`, callback_data: `flip:${p.flipModeEnabled ? 'off' : 'on'}:${p.positionPubkey}` },
          { text: 'Status', callback_data: `flip:status:${p.positionPubkey}` },
        ]]
      })
    }
  }).catch(err => {
    console.log(`[telegram] flip menu failed: ${err.message}`)
  })
}

function sendPrecisionMenu(bot: TelegramBot, chatId: number | string): void {
  const positions = loadActivePositions()
  if (positions.length === 0) {
    bot.sendMessage(chatId, 'No active positions.', { parse_mode: 'HTML' }).catch(() => undefined)
    return
  }

  const lines = [
    `<b>Precision Curve</b>`,
    sep(),
    `Default: <b>off</b> | Threshold: <b>5 bins</b> | Cooldown: <b>5s</b>`,
    sep(),
    ...positions.map((p, idx) => {
      const label = `${p.tokenXSymbol || p.tokenXMint.slice(0, 4)}/${p.tokenYSymbol || p.tokenYMint.slice(0, 4)}`
      const state = p.precisionCurveEnabled ? 'ON' : 'OFF'
      const busy = p.precisionCurveBusy ? ' busy' : ''
      const last = p.precisionCurveLastActiveBin === null ? '-' : String(p.precisionCurveLastActiveBin)
      return `${idx + 1}. <b>${label}</b> <code>${shortAddr(p.positionPubkey)}</code> — <b>${state}</b>${busy}\nThreshold: <b>${p.precisionCurveThresholdBins} bins</b> | Last active bin: <b>${last}</b>`
    })
  ]

  bot.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: positions.flatMap(p => {
        const label = `${p.tokenXSymbol || p.tokenXMint.slice(0, 4)}/${p.tokenYSymbol || p.tokenYMint.slice(0, 4)} ${shortAddr(p.positionPubkey)}`
        return [[
          { text: p.precisionCurveEnabled ? `Disable ${label}` : `Enable ${label}`, callback_data: `pc:${p.precisionCurveEnabled ? 'off' : 'on'}:${p.positionPubkey}` },
          { text: 'Status', callback_data: `pc:status:${p.positionPubkey}` },
        ]]
      })
    }
  }).catch(err => {
    console.log(`[telegram] precision menu failed: ${err.message}`)
  })
}

function precisionStatusText(pos: ReturnType<typeof loadActivePositions>[number]): string {
  const label = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
  return [
    `${label} ${shortAddr(pos.positionPubkey)}`,
    `Precision Curve: ${pos.precisionCurveEnabled ? 'ON' : 'OFF'}`,
    `Threshold: ${pos.precisionCurveThresholdBins} bins`,
    `Last active bin: ${pos.precisionCurveLastActiveBin ?? '-'}`,
    `Last reshape: ${pos.precisionCurveLastReshapeAt ? new Date(pos.precisionCurveLastReshapeAt).toISOString() : '-'}`,
    `Busy: ${pos.precisionCurveBusy ? 'yes' : 'no'}`,
  ].join('\n')
}

function nextFlipTriggerPct(pos: ReturnType<typeof loadActivePositions>[number]): number {
  return pos.flipModeLastProgressPct === null
    ? config.flipModeInitialTriggerPct
    : pos.flipModeLastProgressPct + config.flipModeRepeatStepPct
}

function flipStatusText(pos: ReturnType<typeof loadActivePositions>[number]): string {
  const label = `${pos.tokenXSymbol || pos.tokenXMint.slice(0, 4)}/${pos.tokenYSymbol || pos.tokenYMint.slice(0, 4)}`
  return [
    `${label} ${shortAddr(pos.positionPubkey)}`,
    `Flip Mode: ${pos.flipModeEnabled ? 'ON' : 'OFF'}`,
    `First trigger: ${config.flipModeInitialTriggerPct}%`,
    `Repeat step: ${config.flipModeRepeatStepPct}%`,
    `Last progress: ${pos.flipModeLastProgressPct === null ? '-' : `${pos.flipModeLastProgressPct.toFixed(2)}%`}`,
    `Next trigger: ${nextFlipTriggerPct(pos).toFixed(2)}%`,
    `Last active bin: ${pos.flipModeLastActiveBin ?? '-'}`,
    `Last flip: ${pos.flipModeLastFlipAt ? new Date(pos.flipModeLastFlipAt).toISOString() : '-'}`,
    `Busy: ${pos.flipModeBusy ? 'yes' : 'no'}`,
    `Pending add: ${pos.flipModePendingAdd ? 'yes' : 'no'}`,
    `Pending amount: ${pos.flipModePendingTokenAmount ?? '-'}`,
    `Pending attempts: ${pos.flipModePendingAttempts}`,
    `Last error: ${pos.flipModePendingLastError ?? '-'}`,
  ].join('\n')
}

// ─── Helpers ────────────────────────────────────────────────────────

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return addr.slice(0, 6) + '..' + addr.slice(-4)
}

function solscanTx(sig: string): string {
  if (!sig) return '-'
  return `<a href="https://solscan.io/tx/${sig}">${shortAddr(sig)}</a>`
}

function solscanAddr(addr: string): string {
  if (!addr) return '-'
  return `<a href="https://solscan.io/account/${addr}">${shortAddr(addr)}</a>`
}

function meteoraPool(pool: string): string {
  if (!pool) return '-'
  return `<a href="https://app.meteora.ag/dlmm/${pool}">Meteora</a>`
}

function gmgnWallet(addr: string): string {
  if (!addr) return '-'
  return `<a href="https://gmgn.ai/sol/address/${addr}">GMGN</a>`
}

/** Format SOL amount — always 3 decimals */
function fmtSol(val: number): string {
  if (val <= 0) return '<b>0.000 SOL</b>'
  return `<b>${val.toFixed(3)} SOL</b>`
}

/** Format USD value */
function fmtDollar(val: number, solPrice: number): string {
  if (val <= 0) return '<b>$0.00</b>'
  return `<b>$${(val * solPrice).toFixed(2)}</b>`
}

function formatQuoteValue(value: number, quoteCurrency: QuoteCurrency): string {
  return quoteCurrency === 'USDC'
    ? `$${value.toFixed(2)} USDC`
    : `${value.toFixed(4)} SOL`
}

/** Format PnL in the position's quote currency. */
function fmtPnl(pct: number, diff: number, quoteCurrency: QuoteCurrency, solPrice: number): string {
  const sign = pct >= 0 ? '+' : ''
  const emoji = pct >= 15 ? '🟢' : pct >= 5 ? '📗' : pct >= 0 ? '📘' : pct >= -5 ? '📙' : pct >= -15 ? '🟠' : '🔴'
  if (quoteCurrency === 'USDC') {
    const usdStr = diff >= 0 ? `<b>+$${diff.toFixed(2)}</b>` : `<b>-$${Math.abs(diff).toFixed(2)}</b>`
    return `${emoji} ${usdStr} (${sign}${pct.toFixed(2)}%)`
  }
  const solStr = diff >= 0 ? `<b>+${diff.toFixed(4)} SOL</b>` : `<b>${diff.toFixed(4)} SOL</b>`
  const usdStr = solPrice > 0
    ? (diff >= 0 ? `<b>+$${(diff * solPrice).toFixed(2)}</b>` : `<b>-$${Math.abs(diff * solPrice).toFixed(2)}</b>`)
    : ''
  return `${emoji} ${solStr} (${sign}${pct.toFixed(2)}%${usdStr ? ` / ${usdStr}` : ''})`
}

// ─── Separator ──────────────────────────────────────────────────────

function sep(): string {
  return '\n━━━━━━━━━━━━━━━━━━\n'
}

// ─── Start / Stop ───────────────────────────────────────────────────

export function formatBotStart(wallet: string, solBalance: number): string {
  return [
    `🚀 <b>LP Monitor Started</b>`,
    sep(),
    `Wallet: ${solscanAddr(wallet)} · ${gmgnWallet(wallet)}`,
    `Balance: <b>${solBalance.toFixed(4)} SOL</b>`,
    `TP: <b>+${config.defaultTpPercent}%</b> | SL: <b>${config.defaultSlPercent}%</b>`,
    sep(),
    `👀 <i>Scanning for positions...</i>`,
  ].join('\n')
}

export function formatBotStop(): string {
  return `🛑 <b>LP Monitor Stopped</b>`
}

// ─── Discovery ──────────────────────────────────────────────────────

export function formatPositionDiscovered(
  pubkey: string,
  pool: string,
  depositQuote: number,
  confidence: string,
  tokenX: string,
  tokenY: string,
  valueQuote: number,
  pnlPct: number,
  pnlQuote: number,
  quoteCurrency: QuoteCurrency,
  solUsdPrice: number,
  wallet: string,
  /** Token X amount (actual units, not SOL) */
  tokenXAmount?: number,
  /** Token Y amount (actual units, not SOL) */
  tokenYAmount?: number,
  /** Fee X amount (actual units) */
  feeXAmount?: number,
  /** Fee Y amount (actual units) */
  feeYAmount?: number,
  /** Strategy type */
  strategy?: string,
  /** SL percent */
  slPercent?: number,
  /** TP percent */
  tpPercent?: number,
  /** Flip mode auto status */
  flipModeEnabled?: boolean,
  flipModeReason?: string,
): string {
  const confidenceEmoji = confidence === 'high' ? '🟢' : confidence === 'medium' ? '🟡' : '⚪'

  // Build "Your Liquidity" with token breakdown
  let liquidityStr: string
  if (tokenXAmount !== undefined && tokenYAmount !== undefined) {
    const parts: string[] = []
    if (tokenXAmount > 0.0001) parts.push(`<b>${tokenXAmount.toFixed(2)} ${tokenX}</b>`)
    if (tokenYAmount > 0.0001) parts.push(`<b>${tokenYAmount.toFixed(3)} ${tokenY}</b>`)
    liquidityStr = parts.join(' + ') + ` (${formatQuoteValue(valueQuote, quoteCurrency)})`
  } else {
    liquidityStr = formatQuoteValue(valueQuote, quoteCurrency)
  }

  // Build "Fees" line
  let feesStr: string
  if (feeXAmount !== undefined && feeYAmount !== undefined && (feeXAmount > 0 || feeYAmount > 0)) {
    const feeParts: string[] = []
    if (feeXAmount > 0.0001) feeParts.push(`<b>${feeXAmount.toFixed(2)} ${tokenX}</b>`)
    if (feeYAmount > 0.0001) feeParts.push(`<b>${feeYAmount.toFixed(4)} ${tokenY}</b>`)
    feesStr = feeParts.join(' + ')
  } else {
    feesStr = '-'
  }

  return [
    `📡 <b>Position Detected</b>`,
    sep(),
    `Token: <b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPct, pnlQuote, quoteCurrency, solUsdPrice)}`,
    `Deposit: ${formatQuoteValue(depositQuote, quoteCurrency)}`,
    `Your Liquidity: ${liquidityStr}`,
    `Fees: ${feesStr}`,
    `Confidence: ${confidenceEmoji} <b>${confidence}</b>`,
    strategy ? `Strategy: <b>${strategy}</b>` : null,
    slPercent !== undefined && tpPercent !== undefined ? `SL: <b>${slPercent}%</b> | TP: <b>+${tpPercent}%</b>` : null,
    flipModeEnabled !== undefined
      ? `Flip Mode: <b>${flipModeEnabled ? `ON (${flipModeReason || 'auto'})` : 'OFF'}</b>`
      : null,
    sep(),
    `Wallet: ${solscanAddr(wallet)} · ${gmgnWallet(wallet)}`,
  ].filter(Boolean).join('\n')
}

// ─── Exit Triggered ─────────────────────────────────────────────────

export function formatExitStarted(
  pubkey: string,
  triggerType: string,
  pnlPercent: number,
  pnlQuote: number,
  depositQuote: number,
  valueQuote: number,
  tokenX: string,
  tokenY: string,
  pool: string,
  solUsdPrice: number,
  quoteCurrency: QuoteCurrency,
): string {
  const emoji = triggerType === 'TP' ? '🎯' : triggerType === 'TRAILING_STOP' ? '🔻' : '🛡️'
  return [
    `${emoji} <b>Exit Triggered — ${triggerType}</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPercent, pnlQuote, quoteCurrency, solUsdPrice)}`,
    `Deposit: ${formatQuoteValue(depositQuote, quoteCurrency)}`,
    `Your Liquidity: ${formatQuoteValue(valueQuote, quoteCurrency)}`,
    sep(),
    `<i>Removing liquidity & swapping to ${quoteCurrency}...</i>`,
  ].join('\n')
}

// ─── Exit Success ───────────────────────────────────────────────────

export function formatExitSuccess(
  pubkey: string,
  received: number,
  pnlPercent: number,
  pnlQuote: number,
  rentRefundQuote: number,
  depositQuote: number,
  removeSig: string,
  swapSig: string | null,
  tokenX: string,
  tokenY: string,
  pool: string,
  solPrice: number,
  wallet: string,
  quoteCurrency: QuoteCurrency,
): string {
  const receivedLabel = formatQuoteValue(received, quoteCurrency)
  const depositLabel = formatQuoteValue(depositQuote, quoteCurrency)
  return [
    `✅ <b>Exit Complete</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPercent, pnlQuote, quoteCurrency, solPrice)}`,
    `Deposit: ${depositLabel}`,
    `Received: ${receivedLabel}`,
    rentRefundQuote > 0 ? `Rent refund: ${formatQuoteValue(rentRefundQuote, quoteCurrency)}` : null,
    sep(),
    `Remove: ${solscanTx(removeSig)}`,
    swapSig ? `Swap: ${solscanTx(swapSig)}` : 'Swap: <i>none (quote-only)</i>',
    sep(),
    `Wallet: ${solscanAddr(wallet)} · ${gmgnWallet(wallet)}`,
  ].filter(Boolean).join('\n')
}

// ─── Exit Failed ────────────────────────────────────────────────────

export function formatExitFailed(
  pubkey: string,
  reason: string,
  tokenX: string,
  tokenY: string,
  pool: string
): string {
  return [
    `❌ <b>Exit Failed</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `Error: <code>${reason}</code>`,
    sep(),
    `<i>Check the dashboard for the current recovery state.</i>`,
  ].join('\n')
}

// ─── PnL Alert ──────────────────────────────────────────────────────

export function formatPnlAlert(
  pubkey: string,
  pnlPercent: number,
  valueSol: number,
  depositSol: number,
  confidence: string,
  tokenX: string,
  tokenY: string,
  pool: string,
  solPrice: number
): string {
  const profitSol = valueSol - depositSol
  return [
    `📊 <b>PnL Update</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPercent, profitSol, 'SOL', solPrice)}`,
    `Deposit: ${fmtSol(depositSol)} (${fmtDollar(depositSol, solPrice)})`,
    `Your Liquidity: ${fmtSol(valueSol)} (${fmtDollar(valueSol, solPrice)})`,
  ].join('\n')
}
