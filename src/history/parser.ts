import { Connection, PublicKey } from '@solana/web3.js'
import type { EventType, BasisConfidence } from '../types.js'

const DLMM_PROGRAM_ID = new PublicKey('LBUZKhbPFn5XX4kz4LZ7Qd8hLEjNvF7M7bQeFqF7gYx')

export interface ParsedEvent {
  signature: string
  blockTime: number
  eventType: EventType
  tokenXDelta: string
  tokenYDelta: string
  solDelta: string
  confidence: BasisConfidence
  rawSummary: string
}

function classifyInstruction(logs: string[] | undefined): EventType {
  if (!logs || logs.length === 0) return 'UNKNOWN'

  const joined = logs.join(' ').toLowerCase()

  if (joined.includes('initialize_position') || joined.includes('initialize position')) return 'POSITION_INIT'
  if (joined.includes('add_liquidity') || joined.includes('add liquidity') || joined.includes('deposit')) return 'ADD_LIQUIDITY'
  if (joined.includes('remove_liquidity') || joined.includes('remove liquidity') || joined.includes('withdraw')) return 'REMOVE_LIQUIDITY'
  if (joined.includes('claim_fee') || joined.includes('claim fee')) return 'CLAIM_FEE'
  if (joined.includes('claim_reward') || joined.includes('claim reward')) return 'CLAIM_REWARD'
  if (joined.includes('close_position') || joined.includes('close position')) return 'CLOSE_POSITION'

  return 'UNKNOWN'
}

function extractTokenDeltas(tx: any, positionOwner: string): { xDelta: string; yDelta: string; solDelta: string } {
  let xDelta = '0', yDelta = '0', solDelta = '0'

  const postBalances = tx.meta?.postTokenBalances || []
  const preBalances = tx.meta?.preTokenBalances || []

  const preMap = new Map<string, Map<string, string>>()
  for (const bal of preBalances) {
    if (bal.owner === positionOwner) {
      if (!preMap.has(bal.mint)) preMap.set(bal.mint, new Map())
      preMap.get(bal.mint)!.set(bal.accountIndex.toString(), bal.uiTokenAmount?.uiAmountString || '0')
    }
  }

  const postMap = new Map<string, string>()
  for (const bal of postBalances) {
    if (bal.owner === positionOwner) {
      const key = bal.mint
      const existing = postMap.get(key) || '0'
      postMap.set(key, (Number(existing) + Number(bal.uiTokenAmount?.uiAmountString || 0)).toString())
    }
  }

  for (const [mint, preAmounts] of preMap) {
    let preTotal = 0
    for (const amount of preAmounts.values()) {
      preTotal += Number(amount)
    }
    const postTotal = Number(postMap.get(mint) || '0')
    const delta = postTotal - preTotal
    if (delta !== 0) {
      if (mint === 'So11111111111111111111111111111111111111112' || mint === 'So11111111111111111111111111111111111111111') {
        solDelta = delta.toString()
      } else if (xDelta === '0') {
        xDelta = delta.toString()
      } else {
        yDelta = delta.toString()
      }
    }
  }

  return { xDelta, yDelta, solDelta }
}

export function parseTransactionForPosition(tx: any, positionPubkey: string, positionOwner: string): ParsedEvent | null {
  if (!tx?.meta || tx.meta.err) return null
  if (!tx.blockTime) return null

  const accountKeys = tx.transaction?.message?.accountKeys || []
  const isDLMM = accountKeys.some((k: any) => {
    const pk = typeof k === 'string' ? k : k.pubkey?.toBase58?.() || k
    return pk === DLMM_PROGRAM_ID.toBase58()
  })

  if (!isDLMM) return null

  const txLogs = tx.meta.logMessages || []
  const eventType = classifyInstruction(txLogs)
  const deltas = extractTokenDeltas(tx, positionOwner)

  const confidence: BasisConfidence =
    eventType !== 'UNKNOWN' && (deltas.xDelta !== '0' || deltas.yDelta !== '0' || deltas.solDelta !== '0')
      ? 'high'
      : eventType !== 'UNKNOWN'
        ? 'medium'
        : 'low'

  return {
    signature: tx.transaction?.signatures?.[0] || 'unknown',
    blockTime: tx.blockTime,
    eventType,
    tokenXDelta: deltas.xDelta,
    tokenYDelta: deltas.yDelta,
    solDelta: deltas.solDelta,
    confidence,
    rawSummary: (txLogs.slice(0, 3) || []).join(' | '),
  }
}
