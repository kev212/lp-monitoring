import dotenv from 'dotenv'
import type { Config } from './types.js'

dotenv.config()

function envStr(key: string, fallback = ''): string {
  return process.env[key] || fallback
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const config: Config = {
  solanaRpcUrl: envStr('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  solanaRpcFallbackUrl: envStr('SOLANA_RPC_FALLBACK_URL'),
  solanaPrivateKey: envStr('SOLANA_PRIVATE_KEY'),
  jupiterApiKey: envStr('JUPITER_API_KEY'),
  jupiterSwapBaseUrl: envStr('JUPITER_SWAP_BASE_URL', 'https://api.jup.ag/swap/v2'),
  telegramBotToken: envStr('TELEGRAM_BOT_TOKEN'),
  telegramChatId: envStr('TELEGRAM_CHAT_ID'),
  defaultTpPercent: envNum('DEFAULT_TP_PERCENT', 5),
  defaultSlPercent: envNum('DEFAULT_SL_PERCENT', -15),
  pollIntervalMs: envNum('POLL_INTERVAL_MS', 5000),
  triggerConfirmations: envNum('TRIGGER_CONFIRMATIONS', 2),
  maxRetries: envNum('MAX_RETRIES', 3),
  exitCooldownMs: envNum('EXIT_COOLDOWN_MS', 15000),
  maxSwapSlippageBps: envNum('MAX_SWAP_SLIPPAGE_BPS', 300),
  dbPath: envStr('DB_PATH', './monitoring-lp.sqlite'),
  logLevel: envStr('LOG_LEVEL', 'info'),
}
