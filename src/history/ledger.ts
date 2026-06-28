import { Connection, PublicKey } from '@solana/web3.js'
import { getDb } from '../db/client.js'
import { parseTransactionForPosition, type ParsedEvent } from './parser.js'
import type { EventType, BasisConfidence, PositionEventRow } from '../types.js'
import { getTokenPriceInSol } from '../pricing.js'

export function getSavedEvents(positionPubkey: string): PositionEventRow[] {
  const db = getDb()
  return db.prepare(
    'SELECT * FROM position_events WHERE position_pubkey = ? ORDER BY block_time ASC'
  ).all(positionPubkey) as PositionEventRow[]
}

export function getLastProcessedSignature(positionPubkey: string): string | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT signature FROM position_events WHERE position_pubkey = ? ORDER BY block_time DESC LIMIT 1'
  ).get(positionPubkey) as { signature: string } | undefined
  return row?.signature || null
}

export function saveEvent(event: PositionEventRow): void {
  const db = getDb()
  db.prepare(`
    INSERT OR IGNORE INTO position_events
      (position_pubkey, signature, block_time, event_type, token_x_delta, token_y_delta, sol_delta, basis_sol_delta, confidence, raw_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.positionPubkey,
    event.signature,
    event.blockTime,
    event.eventType,
    event.tokenXDelta,
    event.tokenYDelta,
    event.solDelta,
    event.basisSolDelta,
    event.confidence,
    event.rawSummary,
    event.createdAt
  )
}

export function getSyncState(positionPubkey: string): string | null {
  const db = getDb()
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(`last_sig:${positionPubkey}`) as { value: string } | undefined
  return row?.value || null
}

export function setSyncState(positionPubkey: string, signature: string): void {
  const db = getDb()
  db.prepare(
    'INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(`last_sig:${positionPubkey}`, signature, Date.now())
}

export async function fetchAndParseHistory(
  connection: Connection,
  walletPubkey: PublicKey,
  positionPubkey: string,
  ownerStr: string,
  tokenXMint?: string,
  tokenYMint?: string,
): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = []
  const lastSig = getSyncState(positionPubkey)

  try {
    let before: string | undefined = undefined
    let fetched = 0

    while (fetched < 200) {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(positionPubkey),
        { limit: 100, before },
        'confirmed'
      )

      if (sigs.length === 0) break

      const stopIndex = lastSig ? sigs.findIndex(s => s.signature === lastSig) : -1
      const batch = stopIndex >= 0 ? sigs.slice(0, stopIndex) : sigs

      for (const sigInfo of batch) {
        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
          })
          if (!tx) continue

          const parsed = parseTransactionForPosition(tx, positionPubkey, ownerStr, tokenXMint, tokenYMint)
          if (parsed) {
            events.push(parsed)
          }
        } catch {
          continue
        }
      }

      if (stopIndex >= 0) break
      before = sigs[sigs.length - 1].signature
      fetched += sigs.length
    }
  } catch (err) {
    console.log(`[history] fetch failed for ${positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  return events
}

export async function computeBasisFromEvents(
  events: ParsedEvent[],
  tokenXMint: string,
  tokenYMint: string
): Promise<{ basisSol: number; confidence: BasisConfidence }> {
  let totalBasis = 0
  let highCount = 0
  let totalCount = events.length

  if (totalCount === 0) return { basisSol: 0, confidence: 'low' }

  for (const event of events) {
    if (event.confidence === 'high') highCount++

    if (event.eventType === 'ADD_LIQUIDITY') {
      let solValue = Number(event.solDelta)

      if (solValue <= 0) {
        const xVal = Math.abs(Number(event.tokenXDelta))
        const yVal = Math.abs(Number(event.tokenYDelta))

        if (xVal > 0) {
          try {
            const price = await getTokenPriceInSol(new PublicKey(tokenXMint))
            solValue += xVal * price
          } catch { solValue += xVal * 0.00001 }
        }
        if (yVal > 0) {
          try {
            const price = await getTokenPriceInSol(new PublicKey(tokenYMint))
            solValue += yVal * price
          } catch { solValue += yVal * 0.00001 }
        }
      }

      totalBasis += Math.abs(solValue)
    } else if (event.eventType === 'REMOVE_LIQUIDITY') {
      let solValue = Number(event.solDelta)

      if (solValue <= 0) {
        const xVal = Math.abs(Number(event.tokenXDelta))
        const yVal = Math.abs(Number(event.tokenYDelta))

        if (xVal > 0) {
          try {
            const price = await getTokenPriceInSol(new PublicKey(tokenXMint))
            solValue += xVal * price
          } catch { solValue += xVal * 0.00001 }
        }
        if (yVal > 0) {
          try {
            const price = await getTokenPriceInSol(new PublicKey(tokenYMint))
            solValue += yVal * price
          } catch { solValue += yVal * 0.00001 }
        }
      }

      totalBasis -= Math.abs(solValue)
    }
  }

  totalBasis = Math.max(0, totalBasis)

  const confidence: BasisConfidence =
    totalBasis > 0 && highCount > totalCount * 0.5
      ? 'high'
      : totalBasis > 0
        ? 'medium'
        : 'low'

  return { basisSol: totalBasis, confidence }
}
