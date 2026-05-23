import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import axios from 'axios'
import { config } from './config.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

export async function swapTokensToSol(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amount: string
): Promise<{ signature: string; outputAmount: string } | null> {
  const amountNum = Number(amount)
  if (amountNum <= 0) return null

  try {
    const quoteUrl = new URL(`${config.jupiterSwapBaseUrl.replace(/\/$/, '')}/quote`)
    quoteUrl.searchParams.set('inputMint', inputMint)
    quoteUrl.searchParams.set('outputMint', WSOL_MINT)
    quoteUrl.searchParams.set('amount', String(Math.floor(amountNum)))
    quoteUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false')

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (config.jupiterApiKey) {
      headers['x-api-key'] = config.jupiterApiKey
    }

    const quoteRes = await axios.get(quoteUrl.toString(), { headers, timeout: 15_000 })
    const quote = quoteRes.data

    if (quote.error) {
      throw new Error(`Jupiter quote error: ${quote.error}`)
    }

    const swapBody = {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }

    const swapRes = await axios.post(
      `${config.jupiterSwapBaseUrl.replace(/\/$/, '')}/swap`,
      swapBody,
      { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 20_000 }
    )

    const { swapTransaction } = swapRes.data
    if (!swapTransaction) throw new Error('No swapTransaction in response')

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
    tx.sign([wallet])

    const sig = await connection.sendTransaction(tx, { skipPreflight: false })
    await connection.confirmTransaction(sig, 'confirmed')

    return {
      signature: sig,
      outputAmount: quote.outAmount || '0',
    }
  } catch (err) {
    console.log(`[swap] failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}
