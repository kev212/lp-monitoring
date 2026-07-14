import { Connection } from '@solana/web3.js'
import { config } from '../config.js'

let _primary: Connection | null = null
let _fallback: Connection | null = null
let _activeIsPrimary = true

function getPrimaryConnection(): Connection {
  if (!_primary) {
    _primary = new Connection(config.solanaRpcUrl, 'confirmed')
  }
  return _primary
}

function getFallbackConnection(): Connection | null {
  if (config.solanaRpcFallbackUrl && !_fallback) {
    _fallback = new Connection(config.solanaRpcFallbackUrl, 'confirmed')
  }
  return _fallback
}

export function getConnection(): Connection {
  const primary = getPrimaryConnection()
  const fallback = getFallbackConnection()
  return _activeIsPrimary ? primary : (fallback ?? primary)
}

/** Read valuation state from the public RPC first, then retry Helius on an RPC error. */
export async function withValuationFallback<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  try {
    return await fn(getPrimaryConnection())
  } catch (err) {
    // A missing account is a valid chain state, not an RPC outage to retry.
    if (err instanceof Error && /account .* not found/i.test(err.message)) throw err
    const fallback = getFallbackConnection()
    if (!fallback) throw err
    console.log(`[connection] public valuation RPC failed (${err instanceof Error ? err.message : 'unknown'}), retrying Helius`)
    return await fn(fallback)
  }
}

export function switchConnection(): void {
  if (_fallback) {
    _activeIsPrimary = !_activeIsPrimary
    console.log(`[connection] switched to ${_activeIsPrimary ? 'primary' : 'fallback'} RPC`)
  }
}

export function getActiveEndpoint(): string {
  return _activeIsPrimary ? config.solanaRpcUrl : config.solanaRpcFallbackUrl || config.solanaRpcUrl
}

/** Run an RPC call with auto-fallback on failure */
export async function withFallback<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  try {
    return await fn(getConnection())
  } catch (err) {
    // RPC error — try fallback if available
    if (_fallback && _activeIsPrimary) {
      console.log(`[connection] primary RPC failed (${err instanceof Error ? err.message : 'unknown'}), switching to fallback`)
      _activeIsPrimary = false
      return await fn(getConnection())
    }
    // Fallback also failed or no fallback — switch back to primary and rethrow
    if (!_activeIsPrimary) {
      _activeIsPrimary = true
    }
    throw err
  }
}
