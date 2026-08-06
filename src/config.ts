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

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return v === 'true' || v === '1'
}

const telegramChatId = envStr('TELEGRAM_CHAT_ID')
const openMaxPriceMoveBins = envNum('OPEN_MAX_PRICE_MOVE_BINS', 3)
if (!Number.isInteger(openMaxPriceMoveBins) || openMaxPriceMoveBins < 1 || openMaxPriceMoveBins > 25) {
  throw new Error('OPEN_MAX_PRICE_MOVE_BINS must be an integer between 1 and 25')
}

export const config: Config = {
  solanaRpcUrl: envStr('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  solanaWsUrl: envStr('SOLANA_WS_URL'),
  solanaRpcFallbackUrl: envStr('SOLANA_RPC_FALLBACK_URL'),
  solanaPrivateKey: envStr('SOLANA_PRIVATE_KEY'),
  jupiterApiKey: envStr('JUPITER_API_KEY'),
  jupiterSwapBaseUrl: envStr('JUPITER_SWAP_BASE_URL', 'https://api.jup.ag/swap/v2'),
  telegramBotToken: envStr('TELEGRAM_BOT_TOKEN'),
  telegramChatId,
  telegramUserId: envStr('TELEGRAM_USER_ID', telegramChatId.startsWith('-') ? '' : telegramChatId),
  telegramManualTradingEnabled: envBool('TELEGRAM_MANUAL_TRADING_ENABLED', false),
  telegramConfirmTtlMs: envNum('TELEGRAM_CONFIRM_TTL_MS', 120_000),
  defaultTpPercent: envNum('DEFAULT_TP_PERCENT', 10),
  defaultSlPercent: envNum('DEFAULT_SL_PERCENT', -17),
  pollIntervalMs: envNum('POLL_INTERVAL_MS', 2500),
  triggerConfirmations: envNum('TRIGGER_CONFIRMATIONS', 2),
  maxRetries: envNum('MAX_RETRIES', 3),
  exitCooldownMs: envNum('EXIT_COOLDOWN_MS', 15000),
  maxSwapSlippageBps: envNum('MAX_SWAP_SLIPPAGE_BPS', 300),
  removeConfirmTimeoutMs: envNum('REMOVE_CONFIRM_TIMEOUT_MS', 10_000),
  swapConfirmTimeoutMs: envNum('SWAP_CONFIRM_TIMEOUT_MS', 5_000),
  exitRecoveryPollMs: envNum('EXIT_RECOVERY_POLL_MS', 2_000),
  exitFinalityReviewTimeoutMs: envNum('EXIT_FINALITY_REVIEW_TIMEOUT_MS', 60_000),
  trailingActivationPct: envNum('TRAILING_ACTIVATION_PCT', 3),
  trailingStopDropPct: envNum('TRAILING_STOP_DROP_PCT', 1),
  recheckDelayMs: envNum('RECHECK_DELAY_MS', 3000),
  lpAgentApiKey: envStr('LP_AGENT_API_KEY'),
  binRangeCloseEnabled: envBool('BIN_RANGE_CLOSE_ENABLED', true),
  binRangePnlThreshold: envNum('BIN_RANGE_PNL_THRESHOLD', 1.5),
  binRangeMaxDistance: envNum('BIN_RANGE_MAX_DISTANCE', 7),
  binRangeDistanceRatio: envNum('BIN_RANGE_DISTANCE_RATIO', 0.05),
  maxDrawdownThreshold: envNum('MAX_DRAWDOWN_THRESHOLD', -6),
  maxDrawdownTpOverride: envNum('MAX_DRAWDOWN_TP_OVERRIDE', 2),
  flipModeInitialTriggerPct: envNum('FLIP_MODE_INITIAL_TRIGGER_PCT', 40),
  flipModeRepeatStepPct: envNum('FLIP_MODE_REPEAT_STEP_PCT', 10),
  openMaxPriceMoveBins,
  openSolFeeReserve: envNum('OPEN_SOL_FEE_RESERVE', 0.02),
  dbPath: envStr('DB_PATH', './monitoring-lp.sqlite'),
  logLevel: envStr('LOG_LEVEL', 'info'),
}
