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

export function formatPositionDiscovered(pubkey: string, pool: string, basisSol: number, confidence: string): string {
  return [
    `<b> Position Discovered</b>`,
    `Position: <code>${pubkey.slice(0, 12)}...</code>`,
    `Pool: <code>${pool.slice(0, 12)}...</code>`,
    `Basis: <b>${basisSol.toFixed(4)} SOL</b>`,
    `Confidence: <b>${confidence}</b>`,
  ].join('\n')
}

export function formatPnlAlert(pubkey: string, pnlPercent: number, estimatedSol: number, basisSol: number, confidence: string): string {
  const emoji = pnlPercent >= 0 ? '' : ''
  const direction = pnlPercent >= 0 ? 'UP' : 'DOWN'
  return [
    `${emoji} <b>PnL Alert: ${direction}</b>`,
    `Position: <code>${pubkey.slice(0, 12)}...</code>`,
    `PnL: <b>${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>`,
    `Est. Value: <b>${estimatedSol.toFixed(4)} SOL</b>`,
    `Basis: <b>${basisSol.toFixed(4)} SOL</b>`,
    `Confidence: ${confidence}`,
  ].join('\n')
}

export function formatExitStarted(pubkey: string, triggerType: string, pnlPercent: number): string {
  return [
    `<b> Exit Triggered!</b>`,
    `Type: <b>${triggerType}</b>`,
    `Position: <code>${pubkey.slice(0, 12)}...</code>`,
    `PnL: <b>${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>`,
  ].join('\n')
}

export function formatExitSuccess(pubkey: string, solReceived: number, pnlPercent: number, removeSig: string, swapSig: string | null): string {
  return [
    `<b> Exit Complete</b>`,
    `Position: <code>${pubkey.slice(0, 12)}...</code>`,
    `Received: <b>${solReceived.toFixed(6)} SOL</b>`,
    `PnL: <b>${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</b>`,
    `Remove tx: <code>${removeSig.slice(0, 12)}...</code>`,
    swapSig ? `Swap tx: <code>${swapSig.slice(0, 12)}...</code>` : '',
  ].join('\n')
}

export function formatExitFailed(pubkey: string, reason: string): string {
  return [
    `<b> Exit Failed</b>`,
    `Position: <code>${pubkey.slice(0, 12)}...</code>`,
    `Error: ${reason}`,
  ].join('\n')
}

export function formatBotStart(): string {
  return `<b> Monitoring-LP Started</b>\nBot is now monitoring DLMM positions.`
}

export function formatBotStop(): string {
  return `<b> Monitoring-LP Stopped</b>`
}
