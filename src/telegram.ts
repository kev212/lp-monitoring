import TelegramBot from 'node-telegram-bot-api'
import { config } from './config.js'

let _bot: TelegramBot | null = null

function getBot(): TelegramBot | null {
  if (!config.telegramBotToken || !config.telegramChatId) return null
  if (!_bot) {
    _bot = new TelegramBot(config.telegramBotToken, { polling: false })
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

/** Format PnL: emoji + SOL + % + USD (SOL basis prioritized) */
function fmtPnl(pct: number, diff: number, solPrice: number, isUsdc = false): string {
  const sign = pct >= 0 ? '+' : ''
  const emoji = pct >= 15 ? '🟢' : pct >= 5 ? '📗' : pct >= 0 ? '📘' : pct >= -5 ? '📙' : pct >= -15 ? '🟠' : '🔴'
  if (isUsdc) {
    const usdStr = diff >= 0 ? `<b>+$${diff.toFixed(2)}</b>` : `<b>-$${Math.abs(diff).toFixed(2)}</b>`
    return `${emoji} ${usdStr} (${sign}${pct.toFixed(2)}%)`
  }
  const solStr = diff >= 0 ? `<b>+${diff.toFixed(4)} SOL</b>` : `<b>${diff.toFixed(4)} SOL</b>`
  const usdStr = diff >= 0 ? `<b>+$${(diff * solPrice).toFixed(2)}</b>` : `<b>-$${Math.abs(diff * solPrice).toFixed(2)}</b>`
  return `${emoji} ${solStr} (${sign}${pct.toFixed(2)}% / ${usdStr})`
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
  depositSol: number,
  confidence: string,
  tokenX: string,
  tokenY: string,
  valueSol: number,
  pnlPct: number,
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
): string {
  const confidenceEmoji = confidence === 'high' ? '🟢' : confidence === 'medium' ? '🟡' : '⚪'
  const profitSol = valueSol - depositSol

  // Build "Your Liquidity" with token breakdown
  let liquidityStr: string
  if (tokenXAmount !== undefined && tokenYAmount !== undefined) {
    const parts: string[] = []
    if (tokenXAmount > 0.0001) parts.push(`<b>${tokenXAmount.toFixed(2)} ${tokenX}</b>`)
    if (tokenYAmount > 0.0001) parts.push(`<b>${tokenYAmount.toFixed(3)} ${tokenY}</b>`)
    liquidityStr = parts.join(' + ') + ` (${fmtDollar(valueSol, solUsdPrice)})`
  } else {
    liquidityStr = `${fmtSol(valueSol)} (${fmtDollar(valueSol, solUsdPrice)})`
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
    `PnL: ${fmtPnl(pnlPct, profitSol, solUsdPrice)}`,
    `Deposit: ${fmtSol(depositSol)} (${fmtDollar(depositSol, solUsdPrice)})`,
    `Your Liquidity: ${liquidityStr}`,
    `Fees: ${feesStr}`,
    `Confidence: ${confidenceEmoji} <b>${confidence}</b>`,
    strategy ? `Strategy: <b>${strategy}</b>` : null,
    slPercent !== undefined && tpPercent !== undefined ? `SL: <b>${slPercent}%</b> | TP: <b>+${tpPercent}%</b>` : null,
    sep(),
    `Wallet: ${solscanAddr(wallet)} · ${gmgnWallet(wallet)}`,
  ].filter(Boolean).join('\n')
}

// ─── Exit Triggered ─────────────────────────────────────────────────

export function formatExitStarted(
  pubkey: string,
  triggerType: string,
  pnlPercent: number,
  pnlSol: number,
  depositSol: number,
  valueSol: number,
  tokenX: string,
  tokenY: string,
  pool: string,
  solUsdPrice: number
): string {
  const emoji = triggerType === 'TP' ? '🎯' : triggerType === 'TRAILING_STOP' ? '🔻' : '🛡️'
  return [
    `${emoji} <b>Exit Triggered — ${triggerType}</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPercent, pnlSol, solUsdPrice)}`,
    `Deposit: ${fmtSol(depositSol)} (${fmtDollar(depositSol, solUsdPrice)})`,
    `Your Liquidity: ${fmtSol(valueSol)} (${fmtDollar(valueSol, solUsdPrice)})`,
    sep(),
    `<i>Removing liquidity & swapping to SOL...</i>`,
  ].join('\n')
}

// ─── Exit Success ───────────────────────────────────────────────────

export function formatExitSuccess(
  pubkey: string,
  received: number,
  pnlPercent: number,
  rentRefundSol: number,
  depositSol: number,
  removeSig: string,
  swapSig: string | null,
  tokenX: string,
  tokenY: string,
  pool: string,
  solPrice: number,
  wallet: string,
  isUsdc: boolean = false
): string {
  const adjReceived = received - rentRefundSol
  const profitSol = adjReceived - depositSol
  const receivedLabel = isUsdc ? `<b>$${received.toFixed(2)} USDC</b>` : fmtSol(received)
  const depositLabel = isUsdc ? `<b>$${depositSol.toFixed(2)} USDC equiv</b>` : fmtSol(depositSol)
  const profitLabel = isUsdc
    ? (profitSol >= 0 ? `<b>+$${profitSol.toFixed(2)}</b>` : `<b>-$${Math.abs(profitSol).toFixed(2)}</b>`)
    : fmtSol(profitSol)
  return [
    `✅ <b>Exit Complete</b>`,
    sep(),
    `<b>${tokenX}/${tokenY}</b>`,
    `Position: <code>${shortAddr(pubkey)}</code>`,
    `Pool: ${meteoraPool(pool)}`,
    sep(),
    `PnL: ${fmtPnl(pnlPercent, profitSol, solPrice, isUsdc)}`,
    `Deposit: ${depositLabel}`,
    `Received: ${receivedLabel}`,
    sep(),
    `Remove: ${solscanTx(removeSig)}`,
    swapSig ? `Swap: ${solscanTx(swapSig)}` : 'Swap: <i>none (SOL-only)</i>',
    sep(),
    `Wallet: ${solscanAddr(wallet)} · ${gmgnWallet(wallet)}`,
  ].join('\n')
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
    `<i>Retrying next cycle...</i>`,
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
    `PnL: ${fmtPnl(pnlPercent, profitSol, solPrice)}`,
    `Deposit: ${fmtSol(depositSol)} (${fmtDollar(depositSol, solPrice)})`,
    `Your Liquidity: ${fmtSol(valueSol)} (${fmtDollar(valueSol, solPrice)})`,
  ].join('\n')
}
