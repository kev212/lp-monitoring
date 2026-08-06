import type { QuoteCurrency } from '../types.js'

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉'
const BIN_BAR_WIDTH = 10

export interface BinRangeDisplayInput {
  lowerBinId: number
  activeBinId: number
  upperBinId: number
  quoteSide: 'X' | 'Y'
  quoteCurrency: QuoteCurrency
  priceForBin: (binId: number) => number
}

export interface BinRangeDisplay {
  progressPct: number | null
  bar: string
  prices: string
}

export function formatCompactPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return 'N/A'
  const text = value.toPrecision(4)
  const decimal = text.includes('e')
    ? value.toFixed(Math.max(0, 4 - Math.floor(Math.log10(value)) - 1))
    : text
  const trimmed = decimal.includes('.')
    ? decimal.replace(/0+$/, '').replace(/\.$/, '')
    : decimal
  const match = /^0\.(0+)([1-9]\d*)$/.exec(trimmed)
  if (!match || match[1].length < 2) return trimmed
  const subscript = SUBSCRIPT_DIGITS[match[1].length] || String(match[1].length)
  return `0.0${subscript}${match[2]}`
}

function quotePrice(nativePrice: number, quoteSide: 'X' | 'Y'): number {
  if (!Number.isFinite(nativePrice) || nativePrice <= 0) return Number.NaN
  return quoteSide === 'Y' ? nativePrice : 1 / nativePrice
}

export function buildBinRangeDisplay(input: BinRangeDisplayInput): BinRangeDisplay {
  const endpointA = quotePrice(input.priceForBin(input.lowerBinId), input.quoteSide)
  const endpointB = quotePrice(input.priceForBin(input.upperBinId), input.quoteSide)
  const current = quotePrice(input.priceForBin(input.activeBinId), input.quoteSide)
  const lower = Math.min(endpointA, endpointB)
  const upper = Math.max(endpointA, endpointB)
  const lowerBin = Math.min(input.lowerBinId, input.upperBinId)
  const upperBin = Math.max(input.lowerBinId, input.upperBinId)
  const progressPct = Number.isFinite(lowerBin) && Number.isFinite(upperBin) && Number.isFinite(input.activeBinId) && upperBin > lowerBin
    ? Math.max(0, Math.min(100, Math.round(((input.activeBinId - lowerBin) / (upperBin - lowerBin)) * 100)))
    : null
  const cursor = progressPct === null
    ? 0
    : Math.min(BIN_BAR_WIDTH - 1, Math.floor((progressPct * BIN_BAR_WIDTH) / 100))
  const bar = progressPct === null
    ? `${'━'.repeat(BIN_BAR_WIDTH)} N/A`
    : `${'━'.repeat(cursor)}│${'━'.repeat(BIN_BAR_WIDTH - cursor - 1)} ${progressPct}%`
  const format = (value: number): string => {
    const compact = formatCompactPrice(value)
    return input.quoteCurrency === 'USDC' ? `$${compact}` : `${compact} SOL`
  }
  return {
    progressPct,
    bar,
    prices: `${format(lower)} – ${format(upper)} · ${format(current)}`,
  }
}
