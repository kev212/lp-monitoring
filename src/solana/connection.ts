import { Connection } from '@solana/web3.js'
import { config } from '../config.js'

let _primary: Connection | null = null
let _fallback: Connection | null = null
let _activeIsPrimary = true

export function getConnection(): Connection {
  if (!_primary) {
    _primary = new Connection(config.solanaRpcUrl, 'confirmed')
  }
  if (config.solanaRpcFallbackUrl && !_fallback) {
    _fallback = new Connection(config.solanaRpcFallbackUrl, 'confirmed')
  }
  return _activeIsPrimary ? _primary : (_fallback ?? _primary)
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
