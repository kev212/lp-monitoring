import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import axios from 'axios'
import { config } from './config.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const MIN_SWAP_AMOUNT_SOL = 0.0005 // skip swap kalo di bawah ~$0.05

async function getRawTokenBalance(connection: Connection, wallet: Keypair, mint: string): Promise<bigint> {
  try {
    const accounts = await connection.getTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(mint) }
    )
    if (accounts.value.length > 0) {
      let total = 0n
      for (const acc of accounts.value) {
        const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
        total += view.getBigUint64(0, true)
      }
      return total
    }
  } catch { /* fallthrough */ }
  return 0n
}

/**
 * Estimate token value in SOL using Jupiter price
 */
async function estimateTokenValueInSol(connection: Connection, mint: string, rawAmount: string): Promise<number> {
  try {
    const res = await axios.get(`https://api.jup.ag/price/v3?ids=${mint}`, {
      headers: { 'Accept': 'application/json' },
      timeout: 5_000,
    })
    const data = res.data?.data?.[mint]
    if (data?.price) {
      // price is in USD, need SOL price too
      const solRes = await axios.get('https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', {
        headers: { 'Accept': 'application/json' },
        timeout: 5_000,
      })
      const solPrice = solRes.data?.data?.['So11111111111111111111111111111111111111112']?.price
      if (solPrice && Number(solPrice) > 0) {
        return Number(data.price) / Number(solPrice) * Number(rawAmount) / 1e9
      }
    }
  } catch { /* ignore */ }
  return -1 // unknown
}

/**
 * Try fallback to old /quote + /swap pattern
 */
async function tryLegacySwap(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amount: string,
  outputMint: string = WSOL_MINT
): Promise<{ signature: string; outputAmount: string } | null> {
  try {
    const baseUrl = config.jupiterSwapBaseUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey

    // Quote
    const quoteUrl = new URL(`${baseUrl}/quote`)
    quoteUrl.searchParams.set('inputMint', inputMint)
    quoteUrl.searchParams.set('outputMint', outputMint)
    quoteUrl.searchParams.set('amount', String(Math.floor(Number(amount))))
    quoteUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false')

    const quoteRes = await axios.get(quoteUrl.toString(), { headers, timeout: 15_000 })
    const quote = quoteRes.data
    if (quote?.error) throw new Error(`Quote error: ${quote.error}`)
    if (!quote?.routes?.length) throw new Error('No routes found')

    // Build swap tx
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      taker: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }

    const swapRes = await axios.post(`${baseUrl}/swap`, swapBody, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: 20_000,
    })
    const { swapTransaction } = swapRes.data
    if (!swapTransaction) throw new Error('No swapTransaction in swap response')

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'))
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.message.recentBlockhash = blockhash
    tx.sign([wallet])

    const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 })
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')

    return { signature: sig, outputAmount: quote.outAmount || '0' }
  } catch (err) {
    console.log(`[swap] legacy fallback failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

/**
 * Jupiter Ultra (Meta-Aggregator) swap via /order + /execute,
 * with fallback to legacy /quote + /swap
 */
async function attemptSwap(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amount: string,
  outputMint: string = WSOL_MINT,
  retryCount: number = 0
): Promise<{ signature: string; outputAmount: string } | null> {
  const amountNum = Number(amount)
  if (amountNum <= 0) return null

  // Skip if amount is dust
  if (amountNum < 1000) {
    console.log(`[swap] skipping dust (${amountNum} raw)`)
    return null
  }

  let sentSig = ''

  try {
    const baseUrl = config.jupiterSwapBaseUrl.replace(/\/$/, '')
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }
    if (config.jupiterApiKey) headers['x-api-key'] = config.jupiterApiKey

    // ── Attempt 1: Ultra Mode via /order ──
    // Response bisa pake field "transaction" (baru) atau "swapTransaction" (lama)
    const orderUrl = new URL(`${baseUrl}/order`)
    orderUrl.searchParams.set('inputMint', inputMint)
    orderUrl.searchParams.set('outputMint', outputMint)
    orderUrl.searchParams.set('amount', String(Math.floor(amountNum)))
    orderUrl.searchParams.set('taker', wallet.publicKey.toBase58())
    orderUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
    orderUrl.searchParams.set('orderMode', 'ultra')
    orderUrl.searchParams.set('dynamicSlippage', 'true')

    const outputLabel = outputMint === WSOL_MINT ? 'SOL' : outputMint.slice(0, 8)
    console.log(`[swap] GET /order (ultra) for ${Math.floor(amountNum)} ${inputMint.slice(0, 8)} → ${outputLabel}`)

    const orderRes = await axios.get(orderUrl.toString(), { headers, timeout: 20_000 })
    const order = orderRes.data

    if (order?.error) {
      // Ultra failed — fallback to legacy
      console.log(`[swap] ultra failed (${order.error}), trying legacy...`)
      return tryLegacySwap(connection, wallet, inputMint, amount, outputMint)
    }

    // Field bisa "transaction" (v2 baru) atau "swapTransaction" (v2 lama)
    const rawTx = order.transaction || order.swapTransaction
    if (!rawTx) {
      console.log(`[swap] ultra: no transaction in response, trying legacy...`)
      return tryLegacySwap(connection, wallet, inputMint, amount, outputMint)
    }

    // Sign & send via RPC langsung (karena gak selalu ada requestId buat /execute)
    const tx = VersionedTransaction.deserialize(Buffer.from(rawTx, 'base64'))
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.message.recentBlockhash = blockhash
    tx.sign([wallet])

    sentSig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 })
    await Promise.race([
      connection.confirmTransaction({ signature: sentSig, blockhash, lastValidBlockHeight }, 'confirmed'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('confirm timeout (10s)')), 10_000)),
    ])

    console.log(`[swap] ultra success: ${sentSig}`)
    return {
      signature: sentSig,
      outputAmount: order.outAmount || '0',
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.log(`[swap] attempt ${retryCount + 1} failed: ${msg}`)

    // If confirmation timed out, the tx may have gone through — check balance
    if (sentSig && (msg.includes('not confirmed') || msg.includes('confirm timeout'))) {
      await new Promise<void>(r => setTimeout(r, 5_000))
      const balanceAfter = await getRawTokenBalance(connection, wallet, inputMint)
      if (balanceAfter === 0n) {
        console.log(`[swap] tx succeeded despite RPC timeout`)
        return { signature: sentSig, outputAmount: '0' }
      }
    }

    // Retry on transient errors
    if (
      retryCount < 2 &&
      (msg.includes('expired') || msg.includes('block height') || msg.includes('429') ||
       msg.includes('timeout') || msg.includes('not confirmed') || msg.includes('confirm timeout'))
    ) {
      console.log(`[swap] retrying (${retryCount + 1}/3)...`)
      await new Promise<void>(resolve => { setTimeout(resolve, 2_000); })
      return attemptSwap(connection, wallet, inputMint, amount, outputMint, retryCount + 1)
    }

    // Token has no routes / can't swap — not a fatal error, just log
    if (msg.includes('No routes') || msg.includes('No swapTransaction') || msg.includes('No tx')) {
      console.log(`[swap] ${inputMint.slice(0, 8)} cannot be swapped (no routes) — skipping`)
      return null
    }

    return null
  }
}

export async function swapTokensToSol(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amount: string,
  outputMint: string = WSOL_MINT
): Promise<{ signature: string; outputAmount: string } | null> {
  return attemptSwap(connection, wallet, inputMint, amount, outputMint, 0)
}
