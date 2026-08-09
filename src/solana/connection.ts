import { Connection } from '@solana/web3.js'
import { config } from '../config.js'

let _primary: Connection | null = null
let _fallback: Connection | null = null
let _secondaryFallback: Connection | null = null
let _activeIsPrimary = true
const FAILOVER_PROVIDERS = Symbol('failoverProviders')
const SUBSCRIPTION_METHODS = new Set<PropertyKey>([
  'onAccountChange',
  'removeAccountChangeListener',
  'onProgramAccountChange',
  'removeProgramAccountChangeListener',
  'onLogs',
  'removeOnLogsListener',
  'onSlotChange',
  'removeSlotChangeListener',
  'onSignature',
  'onSignatureWithOptions',
  'removeSignatureListener',
  'onRootChange',
  'removeRootChangeListener',
])

type FailoverConnection = Connection & {
  [FAILOVER_PROVIDERS]?: Connection[]
}

function uniqueConnections(connections: Array<Connection | null | undefined>): Connection[] {
  const unique: Connection[] = []
  const endpoints = new Set<string>()
  for (const connection of connections) {
    if (!connection || unique.includes(connection)) continue
    const endpoint = connection.rpcEndpoint
    if (endpoint && endpoints.has(endpoint)) continue
    unique.push(connection)
    if (endpoint) endpoints.add(endpoint)
  }
  return unique
}

function embeddedProviders(connection: Connection | null): Connection[] {
  if (!connection) return []
  return (connection as FailoverConnection)[FAILOVER_PROVIDERS] || [connection]
}

function providerCandidates(
  primary: Connection,
  fallback: Connection | null,
  secondaryFallback: Connection | null,
): Connection[] {
  return uniqueConnections([
    ...embeddedProviders(primary),
    ...embeddedProviders(fallback),
    ...embeddedProviders(secondaryFallback),
  ])
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

function providerLabel(connection: Connection): string {
  if (connection === _primary) return 'primary'
  if (connection === _fallback) return 'fallback'
  if (connection === _secondaryFallback) return 'secondary fallback'
  return 'configured RPC'
}

function isConfiguredConnection(connection: Connection): boolean {
  return embeddedProviders(connection).some(provider =>
    provider === _primary || provider === _fallback || provider === _secondaryFallback
  )
}

function invokeWithFailover(
  providers: Connection[],
  property: PropertyKey,
  args: unknown[],
  index = 0,
): unknown {
  const provider = providers[index]
  const method = Reflect.get(provider, property, provider)
  if (typeof method !== 'function') return method

  const retry = (error: unknown): unknown => {
    if (index >= providers.length - 1) throw error
    console.log(`[connection] ${providerLabel(provider)} RPC failed (${error instanceof Error ? error.message : 'unknown'}), retrying ${providerLabel(providers[index + 1])}`)
    return invokeWithFailover(providers, property, args, index + 1)
  }

  try {
    const result = method.apply(provider, args)
    return isPromiseLike(result) ? Promise.resolve(result).catch(retry) : result
  } catch (error) {
    return retry(error)
  }
}

export function getPrimaryConnection(): Connection {
  if (!_primary) {
    _primary = new Connection(config.solanaRpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      ...(config.solanaWsUrl ? { wsEndpoint: config.solanaWsUrl } : {}),
    })
  }
  return _primary
}

export function getFallbackConnection(): Connection | null {
  if (config.solanaRpcFallbackUrl && !_fallback) {
    _fallback = new Connection(config.solanaRpcFallbackUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    })
  }
  return _fallback
}

export function getSecondaryFallbackConnection(): Connection | null {
  if (config.solanaRpcSecondaryFallbackUrl && !_secondaryFallback) {
    _secondaryFallback = new Connection(config.solanaRpcSecondaryFallbackUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    })
  }
  return _secondaryFallback
}

/**
 * Wrap a Connection so SDK calls that do not use withRpcFallback still use
 * the complete configured provider chain.
 */
export function createRpcFailoverConnection(
  primary: Connection,
  fallbackConnections: Array<Connection | null> = [getFallbackConnection(), getSecondaryFallbackConnection()],
): Connection {
  const providers = providerCandidates(primary, fallbackConnections[0] || null, fallbackConnections[1] || null)
  if (providers.length <= 1) return primary

  const proxy = new Proxy(primary, {
    get(target, property) {
      if (property === FAILOVER_PROVIDERS) return providers
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      // Subscription IDs belong to one WebSocket connection; do not fail over
      // registration/removal across providers.
      if (SUBSCRIPTION_METHODS.has(property)) return value.bind(target)
      return (...args: unknown[]) => invokeWithFailover(providers, property, args)
    },
  }) as FailoverConnection
  return proxy
}

export function getConnection(): Connection {
  const primary = getPrimaryConnection()
  const fallback = getFallbackConnection()
  return _activeIsPrimary ? primary : (fallback ?? primary)
}

async function runWithRpcFallback<T>(
  fn: (connection: Connection) => Promise<T>,
  providers: Connection[],
  skipFallback?: (error: unknown) => boolean,
  retryResult?: (result: T) => boolean,
): Promise<T> {
  let lastError: unknown
  let lastResult: T | undefined
  let hasResult = false
  for (const [index, provider] of providers.entries()) {
    try {
      const result = await fn(provider)
      lastResult = result
      hasResult = true
      if (retryResult?.(result) && index < providers.length - 1) {
        console.log(`[connection] ${providerLabel(provider)} returned an incomplete RPC response, retrying ${providerLabel(providers[index + 1])}`)
        continue
      }
      return result
    } catch (error) {
      if (skipFallback?.(error)) throw error
      lastError = error
      if (index < providers.length - 1) {
        console.log(`[connection] ${providerLabel(provider)} RPC failed (${error instanceof Error ? error.message : 'unknown'}), retrying ${providerLabel(providers[index + 1])}`)
      }
    }
  }
  if (hasResult) return lastResult as T
  throw lastError instanceof Error ? lastError : new Error('all configured Solana RPC providers failed')
}

/** Read valuation state through the primary, configured fallback, and public fallback RPCs. */
export async function withValuationFallback<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  return runWithRpcFallback(
    fn,
    providerCandidates(getPrimaryConnection(), getFallbackConnection(), getSecondaryFallbackConnection()),
    error => error instanceof Error && /account .* not found/i.test(error.message),
  )
}

/** Run any RPC-backed operation through the selected provider and all configured fallbacks. */
export async function withRpcFallback<T>(
  fn: (connection: Connection) => Promise<T>,
  primary: Connection = getConnection(),
  fallback?: Connection | null,
  secondaryFallback?: Connection | null,
): Promise<T> {
  const configuredFallback = fallback === undefined && isConfiguredConnection(primary)
    ? getFallbackConnection()
    : fallback || null
  const configuredSecondaryFallback = secondaryFallback === undefined && isConfiguredConnection(primary)
    ? getSecondaryFallbackConnection()
    : secondaryFallback || null
  return runWithRpcFallback(fn, providerCandidates(primary, configuredFallback, configuredSecondaryFallback))
}

/** Retry signature lookups when a provider returns no local status record. */
export async function withSignatureStatusFallback<T extends { value: unknown }>(
  fn: (connection: Connection) => Promise<T>,
  primary: Connection = getConnection(),
  fallback?: Connection | null,
  secondaryFallback?: Connection | null,
): Promise<T> {
  const configuredFallback = fallback === undefined && isConfiguredConnection(primary)
    ? getFallbackConnection()
    : fallback || null
  const configuredSecondaryFallback = secondaryFallback === undefined && isConfiguredConnection(primary)
    ? getSecondaryFallbackConnection()
    : secondaryFallback || null
  return runWithRpcFallback(
    fn,
    providerCandidates(primary, configuredFallback, configuredSecondaryFallback),
    undefined,
    result => result.value === null,
  )
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

/** Run an RPC call with auto-fallback on failure. */
export async function withFallback<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  const primary = getPrimaryConnection()
  const fallback = getFallbackConnection()
  const secondaryFallback = getSecondaryFallbackConnection()
  const providers = _activeIsPrimary
    ? providerCandidates(primary, fallback, secondaryFallback)
    : providerCandidates(fallback || primary, secondaryFallback, primary)
  try {
    return await runWithRpcFallback(fn, providers)
  } catch (error) {
    _activeIsPrimary = true
    throw error
  }
}
