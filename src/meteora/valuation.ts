import DLMM from '@meteora-ag/dlmm'
import { PublicKey } from '@solana/web3.js'
import { config } from '../config.js'
import { withValuationFallback } from '../solana/connection.js'

const PNL_API_BASE = 'https://dlmm.datapi.meteora.ag/positions'
const CACHE_TTL_MS = 5_000
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

interface PnlPositionData {
  allTimeDeposits?: {
    total?: { sol?: string | number; usd?: string | number }
  }
}

export interface ValuationResult {
  estimatedExitSol: number
  tokenXValueSol: number
  tokenYValueSol: number
  depositEstimateSol: number
  allTimeDepositSol: number
  allTimeDepositTokenXAmount: number
  allTimeDepositTokenYAmount: number
  allTimeWithdrawalSol: number
  tokenXAmount: number
  tokenYAmount: number
  tokenXFees: number
  tokenYFees: number
  tokenXPriceSol: number
  tokenYPriceSol: number
  solUsdPrice: number
  onchainPnlPercent: number
  source: 'on-chain'
  observedAt: number
  /** Bin position data for range-based triggers */
  lowerBinId?: number
  upperBinId?: number
  poolActiveBinId?: number
}

const cache = new Map<string, { ts: number; data: ValuationResult }>()

async function fetchDiscoveryBasis(
  poolAddress: string,
  walletAddress: string,
  positionPubkey?: string,
): Promise<PnlPositionData | null> {
  try {
    const url = `${PNL_API_BASE}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.log(`[pnl_api] HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}`)
      return null
    }
    const data = await res.json()
    const positions: any[] = data.positions || []
    if (positions.length === 0) {
      return null
    }
    // Match by positionPubkey; return null if not found (closed on-chain)
    const p = positionPubkey
      ? positions.find((pos: any) => pos.positionAddress === positionPubkey)
      : positions[0]
    if (!p) {
      return null
    }
    const result: PnlPositionData = {
      allTimeDeposits: p.allTimeDeposits,
    }
    return result
  } catch (err) {
    console.log(`[pnl_api] error for pool ${poolAddress.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

/** Meteora is retained only to establish a discovery-time deposit basis. */
export async function getDiscoveryBasis(
  poolAddress: string,
  walletAddress: string,
  positionPubkey: string,
): Promise<number> {
  const data = await fetchDiscoveryBasis(poolAddress, walletAddress, positionPubkey)
  return Number(data?.allTimeDeposits?.total?.sol || 0)
}

function rawAmount(value: unknown): string {
  const amount = String(value ?? '0')
  return /^\d+$/.test(amount) ? amount : '0'
}

function tokenAmount(positionData: any, side: 'X' | 'Y'): string {
  const excluded = positionData[`total${side}AmountExcludeTransferFee`]
  const liquidity = rawAmount(excluded ?? positionData[`total${side}Amount`])
  const fee = rawAmount(positionData[`fee${side}ExcludeTransferFee`] ?? positionData[`fee${side}`])
  return (BigInt(liquidity) + BigInt(fee)).toString()
}

function withBasis(valuation: ValuationResult, basisSol: number): ValuationResult {
  return {
    ...valuation,
    depositEstimateSol: basisSol,
    allTimeDepositSol: basisSol,
    onchainPnlPercent: basisSol > 0 ? ((valuation.estimatedExitSol - basisSol) / basisSol) * 100 : 0,
  }
}

async function quoteToSol(inputMint: string, amount: string): Promise<number | null> {
  if (amount === '0') return 0
  const quoteUrl = new URL(`${config.jupiterSwapBaseUrl.replace(/\/$/, '')}/quote`)
  quoteUrl.searchParams.set('inputMint', inputMint)
  quoteUrl.searchParams.set('outputMint', WSOL_MINT)
  quoteUrl.searchParams.set('amount', amount)
  quoteUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey

  const res = await fetch(quoteUrl, { headers, signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`Jupiter quote HTTP ${res.status}`)
  const quote = await res.json()
  const outAmount = rawAmount(quote?.outAmount)
  if (outAmount === '0') throw new Error('Jupiter returned no executable route')
  return Number(BigInt(outAmount)) / 1e9
}

export async function estimateExitValue(
  poolPubkey: string,
  _walletAddress?: string,
  positionPubkey?: string,
  basisSol = 0,
  forceFresh = false,
): Promise<ValuationResult | null> {
  if (!positionPubkey) return null
  const cached = cache.get(positionPubkey)
  if (!forceFresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) return withBasis(cached.data, basisSol)

  try {
    const onchainPosition = await withValuationFallback(async connection => {
      const pool = await DLMM.create(connection, new PublicKey(poolPubkey), { cluster: 'mainnet-beta' })
      const position = await pool.getPosition(new PublicKey(positionPubkey))
      return { pool, position }
    })
    const { pool, position } = onchainPosition
    const xMint = pool.tokenX.publicKey.toBase58()
    const yMint = pool.tokenY.publicKey.toBase58()
    // This valuation deliberately supports SOL-quoted pairs only; USD quotes are not converted.
    if (xMint !== WSOL_MINT && yMint !== WSOL_MINT) return null

    if (!position) return null
    const data: any = position.positionData
    const xRaw = tokenAmount(data, 'X')
    const yRaw = tokenAmount(data, 'Y')
    const [xValue, yValue] = await Promise.all([
      xMint === WSOL_MINT ? Promise.resolve(Number(BigInt(xRaw)) / 1e9) : quoteToSol(xMint, xRaw),
      yMint === WSOL_MINT ? Promise.resolve(Number(BigInt(yRaw)) / 1e9) : quoteToSol(yMint, yRaw),
    ])
    if (xValue === null || yValue === null || !Number.isFinite(xValue + yValue)) return null

    const estimatedExitSol = xValue + yValue
    const result: ValuationResult = {
      estimatedExitSol,
      tokenXValueSol: xValue,
      tokenYValueSol: yValue,
      depositEstimateSol: 0,
      allTimeDepositSol: 0,
      allTimeDepositTokenXAmount: 0,
      allTimeDepositTokenYAmount: 0,
      allTimeWithdrawalSol: 0,
      tokenXAmount: Number(BigInt(rawAmount(data.totalXAmount))) / 10 ** pool.tokenX.mint.decimals,
      tokenYAmount: Number(BigInt(rawAmount(data.totalYAmount))) / 10 ** pool.tokenY.mint.decimals,
      tokenXFees: Number(BigInt(rawAmount(data.feeXExcludeTransferFee ?? data.feeX))) / 10 ** pool.tokenX.mint.decimals,
      tokenYFees: Number(BigInt(rawAmount(data.feeYExcludeTransferFee ?? data.feeY))) / 10 ** pool.tokenY.mint.decimals,
      tokenXPriceSol: 0,
      tokenYPriceSol: 0,
      solUsdPrice: 0,
      onchainPnlPercent: 0,
      source: 'on-chain',
      observedAt: Date.now(),
      lowerBinId: data.lowerBinId,
      upperBinId: data.upperBinId,
      poolActiveBinId: pool.lbPair.activeId,
    }
    cache.set(positionPubkey, { ts: Date.now(), data: result })
    return withBasis(result, basisSol)
  } catch (err) {
    console.log(`[valuation] on-chain failed for ${positionPubkey.slice(0, 8)}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export function clearPnlCache(): void {
  cache.clear()
}
