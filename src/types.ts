export type PositionStatus = 'discovering' | 'monitoring' | 'exiting' | 'closed' | 'error' | 'precision_readd_pending'
export type BasisConfidence = 'high' | 'medium' | 'low'
export type StrategyType = 'single_side_quote' | 'single_side_token' | 'balanced' | 'unknown'
export type EventType = 'POSITION_INIT' | 'ADD_LIQUIDITY' | 'REMOVE_LIQUIDITY' | 'CLAIM_FEE' | 'CLAIM_REWARD' | 'CLOSE_POSITION' | 'UNKNOWN'
export type TriggerType = 'TP' | 'SL' | 'TRAILING_STOP' | 'BIN_RANGE'
export type ExitStatus = 'pending_remove' | 'removed' | 'swap_pending' | 'completed' | 'failed'

export interface PositionRow {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  tokenXSymbol: string
  tokenYSymbol: string
  owner: string
  basisSol: number
  entryValueSol: number | null
  basisConfidence: BasisConfidence
  tpPercent: number
  slPercent: number
  status: PositionStatus
  triggerConfirmations: number
  peakPnlPercent: number
  trailingActivated: boolean
  lastPnlPercent: number | null
  lastEstimatedExitSol: number | null
  lastSeenAt: number
  strategy: StrategyType
  precisionCurveEnabled: boolean
  precisionCurveLastActiveBin: number | null
  precisionCurveLastReshapeAt: number | null
  precisionCurveBusy: boolean
  precisionCurveThresholdBins: number
  precisionCurveRangeHalf: number
  precisionCurveMovementLog: number[]
  precisionCurveRecoveryUntil: number | null
  precisionCurvePendingX: string | null
  precisionCurvePendingY: string | null
  precisionCurvePendingPreBalances: string | null
  precisionCurvePendingStartedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface PositionEventRow {
  positionPubkey: string
  signature: string
  blockTime: number
  eventType: EventType
  tokenXDelta: string
  tokenYDelta: string
  solDelta: string
  basisSolDelta: number
  confidence: BasisConfidence
  rawSummary: string
  createdAt: number
}

export interface ExecutionRow {
  positionPubkey: string
  triggerType: TriggerType
  triggerPnlPercent: number
  basisSol: number
  estimatedExitSol: number
  removeLiqSig: string | null
  swapSig: string | null
  finalSolReceived: number | null
  status: ExitStatus
  errorMessage: string | null
  createdAt: number
  updatedAt: number
}

export interface Config {
  solanaRpcUrl: string
  solanaRpcFallbackUrl: string
  solanaPrivateKey: string
  jupiterApiKey: string
  jupiterSwapBaseUrl: string
  telegramBotToken: string
  telegramChatId: string
  defaultTpPercent: number
  defaultSlPercent: number
  pollIntervalMs: number
  triggerConfirmations: number
  maxRetries: number
  exitCooldownMs: number
  maxSwapSlippageBps: number
  trailingActivationPct: number
  trailingStopDropPct: number
  recheckDelayMs: number
  lpAgentApiKey: string
  binRangeCloseEnabled: boolean
  binRangePnlThreshold: number
  binRangeMaxDistance: number
  binRangeDistanceRatio: number
  maxDrawdownThreshold: number
  maxDrawdownTpOverride: number
  dbPath: string
  logLevel: string
}
