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
