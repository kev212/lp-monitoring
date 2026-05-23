export type PositionStatus = 'discovering' | 'monitoring' | 'exiting' | 'closed' | 'error'
export type BasisConfidence = 'high' | 'medium' | 'low'
export type EventType = 'POSITION_INIT' | 'ADD_LIQUIDITY' | 'REMOVE_LIQUIDITY' | 'CLAIM_FEE' | 'CLAIM_REWARD' | 'CLOSE_POSITION' | 'UNKNOWN'
export type TriggerType = 'TP' | 'SL'
export type ExitStatus = 'pending_remove' | 'removed' | 'swap_pending' | 'completed' | 'failed'

export interface PositionRow {
  positionPubkey: string
  poolPubkey: string
  tokenXMint: string
  tokenYMint: string
  owner: string
  basisSol: number
  basisConfidence: BasisConfidence
  tpPercent: number
  slPercent: number
  status: PositionStatus
  triggerConfirmations: number
  lastPnlPercent: number | null
  lastEstimatedExitSol: number | null
  lastSeenAt: number
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
  dbPath: string
  logLevel: string
}
