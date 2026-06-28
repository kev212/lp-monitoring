import { PublicKey } from '@solana/web3.js'
import axios from 'axios'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

let priceCache = new Map<string, { price: number; at: number }>()
const CACHE_TTL = 60_000

export async function getTokenPriceInSol(mint: PublicKey): Promise<number> {
  const mintStr = mint.toBase58()

  // SOL/WSOL = 1 SOL
  if (mintStr === WSOL_MINT) return 1

  const cached = priceCache.get(mintStr)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.price

  try {
    // Use Jupiter Price API v3 — decimal-independent, returns USD price
    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mintStr}`, {
      headers: { 'Accept': 'application/json' },
      timeout: 5_000,
    })
    const tokenPriceUsd = Number(res.data?.data?.[mintStr]?.price || 0)
    if (tokenPriceUsd <= 0) {
      priceCache.set(mintStr, { price: 0, at: Date.now() })
      return 0
    }

    // Get SOL price to convert USD → SOL
    const solRes = await axios.get(
      'https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
      { headers: { 'Accept': 'application/json' }, timeout: 5_000 }
    )
    const solPriceUsd = Number(solRes.data?.data?.['So11111111111111111111111111111111111111112']?.price || 0)
    if (solPriceUsd <= 0) {
      priceCache.set(mintStr, { price: 0, at: Date.now() })
      return 0
    }

    const price = tokenPriceUsd / solPriceUsd
    priceCache.set(mintStr, { price, at: Date.now() })
    return price
  } catch {
    priceCache.set(mintStr, { price: 0, at: Date.now() })
    return 0
  }
}

export async function getSolPriceInUsd(): Promise<number> {
  const cached = priceCache.get('SOL_USD')
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.price

  try {
    const res = await axios.get('https://api.jup.ag/swap/v2/quote', {
      params: {
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amount: (1_000_000_000).toString(), // 1 SOL in lamports
        slippageBps: 100,
        onlyDirectRoutes: false,
      },
      timeout: 10_000,
    })

    const outAmount = Number(res.data?.outAmount || 0)
    // outAmount is in USDC raw units (6 decimals) — divide by 1e6
    const price = outAmount > 0 ? outAmount / 1_000_000 : 0

    priceCache.set('SOL_USD', { price, at: Date.now() })
    return price
  } catch {
    priceCache.set('SOL_USD', { price: 0, at: Date.now() })
    return 0
  }
}

export function clearPriceCache(): void {
  priceCache.clear()
}
