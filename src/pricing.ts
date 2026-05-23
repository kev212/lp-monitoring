import { PublicKey } from '@solana/web3.js'
import axios from 'axios'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const SOL_TOKEN_MINT = 'So11111111111111111111111111111111111111111'

let priceCache = new Map<string, { price: number; at: number }>()
const CACHE_TTL = 60_000

export async function getTokenPriceInSol(mint: PublicKey): Promise<number> {
  const mintStr = mint.toBase58()

  if (mintStr === WSOL_MINT || mintStr === SOL_TOKEN_MINT) return 1

  const cached = priceCache.get(mintStr)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.price

  try {
    const res = await axios.get('https://api.jup.ag/swap/v2/quote', {
      params: {
        inputMint: mintStr,
        outputMint: WSOL_MINT,
        amount: (1_000_000).toString(),
        slippageBps: 100,
        onlyDirectRoutes: false,
      },
      timeout: 10_000,
    })

    const outAmount = Number(res.data?.outAmount || 0)
    const price = outAmount > 0 ? outAmount / 1_000_000 : 0

    priceCache.set(mintStr, { price, at: Date.now() })
    return price
  } catch {
    priceCache.set(mintStr, { price: 0, at: Date.now() })
    return 0
  }
}

export function clearPriceCache(): void {
  priceCache.clear()
}
