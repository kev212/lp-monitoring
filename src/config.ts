import dotenv from 'dotenv'
import type { Config, OpenLiquidityStrategyName } from './types.js'

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

const runnerStrategyRaw = envStr('RUNNER_STRATEGY', 'spot')
if (!['spot', 'curve', 'bidask'].includes(runnerStrategyRaw)) {
  throw new Error('RUNNER_STRATEGY must be spot, curve, or bidask')
}
const runnerStrategy = runnerStrategyRaw as OpenLiquidityStrategyName
const runnerRangePercent = envNum('RUNNER_RANGE_PERCENT', 40)
if (!Number.isInteger(runnerRangePercent) || runnerRangePercent < 1 || runnerRangePercent > 99) {
  throw new Error('RUNNER_RANGE_PERCENT must be an integer between 1 and 99')
}
const runnerMaxActive = envNum('RUNNER_MAX_ACTIVE', 1)
if (!Number.isInteger(runnerMaxActive) || runnerMaxActive < 1) {
  throw new Error('RUNNER_MAX_ACTIVE must be an integer >= 1')
}
const runnerMaxWins = envNum('RUNNER_MAX_WINS', 3)
if (!Number.isInteger(runnerMaxWins) || runnerMaxWins < 1) {
  throw new Error('RUNNER_MAX_WINS must be an integer >= 1')
}
const runnerAlertPort = envNum('RUNNER_ALERT_PORT', 8787)
if (!Number.isInteger(runnerAlertPort) || runnerAlertPort < 1 || runnerAlertPort > 65535) {
  throw new Error('RUNNER_ALERT_PORT must be an integer between 1 and 65535')
}
const runnerOpenAmountSol = envNum('RUNNER_OPEN_AMOUNT_SOL', 0.5)
if (!(runnerOpenAmountSol > 0)) {
  throw new Error('RUNNER_OPEN_AMOUNT_SOL must be greater than 0')
}
const runnerAgentEnabled = envBool('RUNNER_AGENT_ENABLED', false)
const runnerAlertSecret = envStr('RUNNER_ALERT_SECRET')
if (runnerAgentEnabled && !runnerAlertSecret) {
  throw new Error('RUNNER_ALERT_SECRET is required when RUNNER_AGENT_ENABLED=true')
}

const runnerSafetyValues: Array<[string, number, (value: number) => boolean]> = [
  ['RUNNER_MIN_MCAP_USD', envNum('RUNNER_MIN_MCAP_USD', 150_000), value => value > 0],
  ['RUNNER_MIN_HOLDERS', envNum('RUNNER_MIN_HOLDERS', 1_000), value => Number.isInteger(value) && value >= 0],
  ['RUNNER_MIN_FEE_SOL', envNum('RUNNER_MIN_FEE_SOL', 20), value => value >= 0],
  ['RUNNER_MAX_ATH_DROP', envNum('RUNNER_MAX_ATH_DROP', 0.5), value => value >= 0 && value < 1],
  ['RUNNER_MAX_DLMM_TVL_USD', envNum('RUNNER_MAX_DLMM_TVL_USD', 100_000), value => value >= 0],
  ['RUNNER_REOPEN_MIN_VOL_5M_USD', envNum('RUNNER_REOPEN_MIN_VOL_5M_USD', 150_000), value => value >= 0],
  ['RUNNER_EXIT_MIN_VOL_5M_USD', envNum('RUNNER_EXIT_MIN_VOL_5M_USD', 100_000), value => value >= 0],
  ['RUNNER_POOL_WAIT_MS', envNum('RUNNER_POOL_WAIT_MS', 900_000), value => Number.isInteger(value) && value > 0],
  ['RUNNER_POOL_POLL_MS', envNum('RUNNER_POOL_POLL_MS', 15_000), value => Number.isInteger(value) && value > 0],
  ['RUNNER_FOLLOWUP_POLL_MS', envNum('RUNNER_FOLLOWUP_POLL_MS', 5_000), value => Number.isInteger(value) && value > 0],
  ['RUNNER_GPA_REFRESH_MS', envNum('RUNNER_GPA_REFRESH_MS', 60_000), value => Number.isInteger(value) && value > 0],
  ['RUNNER_FIRST_OPEN_RETRY_MAX', envNum('RUNNER_FIRST_OPEN_RETRY_MAX', 3), value => Number.isInteger(value) && value >= 1],
  ['RUNNER_FIRST_CHASE_MAX', envNum('RUNNER_FIRST_CHASE_MAX', 3), value => Number.isInteger(value) && value >= 1],
  ['RUNNER_ENTRY_DRIFT_PCT', envNum('RUNNER_ENTRY_DRIFT_PCT', 0.04), value => value >= 0 && value < 1],
]
for (const [name, value, valid] of runnerSafetyValues) {
  if (!Number.isFinite(value) || !valid(value)) throw new Error(`${name} has an unsafe value`)
}

export const config: Config = {
  solanaRpcUrl: envStr('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  solanaWsUrl: envStr('SOLANA_WS_URL'),
  solanaRpcFallbackUrl: envStr('SOLANA_RPC_FALLBACK_URL'),
  solanaRpcSecondaryFallbackUrl: envStr('SOLANA_RPC_SECONDARY_FALLBACK_URL', 'https://api.mainnet-beta.solana.com'),
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
  maxDrawdownTpOverride: envNum('MAX_DRAWDOWN_TP_OVERRIDE', 3),
  flipModeInitialTriggerPct: envNum('FLIP_MODE_INITIAL_TRIGGER_PCT', 40),
  flipModeRepeatStepPct: envNum('FLIP_MODE_REPEAT_STEP_PCT', 10),
  rebalanceOorMinutes: envNum('REBALANCE_OOR_MINUTES', 5),
  openMaxPriceMoveBins,
  openSolFeeReserve: envNum('OPEN_SOL_FEE_RESERVE', 0.02),
  runnerAgentEnabled,
  runnerAlertSecret,
  runnerAlertBind: envStr('RUNNER_ALERT_BIND', '127.0.0.1'),
  runnerAlertPort,
  runnerOpenAmountSol,
  runnerRangePercent,
  runnerStrategy,
  runnerMaxActive,
  runnerMaxWins,
  runnerMinMcapUsd: envNum('RUNNER_MIN_MCAP_USD', 150_000),
  runnerMinHolders: envNum('RUNNER_MIN_HOLDERS', 1_000),
  runnerMinFeeSol: envNum('RUNNER_MIN_FEE_SOL', 20),
  runnerMaxAthDrop: envNum('RUNNER_MAX_ATH_DROP', 0.5),
  runnerMaxDlmmTvlUsd: envNum('RUNNER_MAX_DLMM_TVL_USD', 100_000),
  runnerReopenMinVol5mUsd: envNum('RUNNER_REOPEN_MIN_VOL_5M_USD', 150_000),
  runnerExitMinVol5mUsd: envNum('RUNNER_EXIT_MIN_VOL_5M_USD', 100_000),
  runnerPoolWaitMs: envNum('RUNNER_POOL_WAIT_MS', 900_000),
  runnerPoolPollMs: envNum('RUNNER_POOL_POLL_MS', 15_000),
  runnerFollowupPollMs: envNum('RUNNER_FOLLOWUP_POLL_MS', 5_000),
  runnerGpaRefreshMs: envNum('RUNNER_GPA_REFRESH_MS', 60_000),
  runnerFirstOpenRetryMax: envNum('RUNNER_FIRST_OPEN_RETRY_MAX', 3),
  runnerFirstChaseMax: envNum('RUNNER_FIRST_CHASE_MAX', 3),
  runnerEntryDriftPct: envNum('RUNNER_ENTRY_DRIFT_PCT', 0.04),
  gmgnApiKey: envStr('GMGN_API_KEY'),
  dbPath: envStr('DB_PATH', './monitoring-lp.sqlite'),
  logLevel: envStr('LOG_LEVEL', 'info'),
}
