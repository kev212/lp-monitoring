import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import axios from 'axios'
import bs58 from 'bs58'
import { config } from './config.js'
import { confirmSignature } from './solana/confirmation.js'
import { withRpcFallback } from './solana/connection.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const SWAP_RPC_TIMEOUT_MS = 10_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`swap RPC timeout (${timeoutMs / 1000}s)`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function normalizeRawSwapAmount(amount: string): string {
  if (!/^\d+$/.test(amount)) throw new Error('Swap amount must be a raw integer')
  return BigInt(amount).toString()
}

export function shouldRetrySwapError(sentSignature: string, message: string, retryCount: number): boolean {
  if (sentSignature || retryCount >= 2) return false
  return ['expired', 'block height', '429', 'timeout', 'not confirmed', 'confirm timeout']
    .some(fragment => message.includes(fragment))
}

export interface SignedSwapAttempt {
  signature: string
  blockhash: string
  lastValidBlockHeight: number
  signedTransaction: string
  inputMint: string
  outputMint: string
  rawAmount: string
}

export interface SwapResult {
  signature: string
  outputAmount: string
  confirmed: boolean
}

export type SwapAttemptTracker = (attempt: SignedSwapAttempt) => void
export type SwapAttemptSettlement = (signature: string, status: 'confirmed' | 'finalized' | 'failed') => void

async function getRawTokenBalance(connection: Connection, wallet: Keypair, mint: string): Promise<bigint | null> {
  try {
    const accounts = await withTimeout(
      withRpcFallback(
        rpc => rpc.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) }, { commitment: 'finalized' }),
        connection,
      ),
      SWAP_RPC_TIMEOUT_MS,
    )
    if (accounts.value.length > 0) {
      let total = 0n
      for (const acc of accounts.value) {
        const view = new DataView(acc.account.data.buffer, acc.account.data.byteOffset + 64, 8)
        total += view.getBigUint64(0, true)
      }
      return total
    }
    return 0n
  } catch {
    return null
  }
}

/**
 * Try fallback to old /quote + /swap pattern
 */
async function tryLegacySwap(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  amount: string,
  outputMint: string = WSOL_MINT,
  minimumRemainingBalance = 0n,
  onSigned?: SwapAttemptTracker,
  onSettled?: SwapAttemptSettlement,
): Promise<SwapResult | null> {
  let sentSig = ''
  const startedAt = Date.now()
  try {
    const rawAmount = normalizeRawSwapAmount(amount)
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
    quoteUrl.searchParams.set('amount', rawAmount)
    quoteUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false')

    const quoteRes = await axios.get(quoteUrl.toString(), { headers, timeout: 15_000 })
    const quote = quoteRes.data
    if (quote?.error) throw new Error(`Quote error: ${quote.error}`)
    if (!quote?.outAmount || !Array.isArray(quote.routePlan) || quote.routePlan.length === 0) {
      throw new Error('No routes found')
    }

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
    const { blockhash, lastValidBlockHeight } = await withRpcFallback(
      rpc => rpc.getLatestBlockhash('confirmed'),
      connection,
    )
    tx.message.recentBlockhash = blockhash
    tx.sign([wallet])

    sentSig = bs58.encode(tx.signatures[0])
    onSigned?.({
      signature: sentSig,
      blockhash,
      lastValidBlockHeight,
      signedTransaction: Buffer.from(tx.serialize()).toString('base64'),
      inputMint,
      outputMint,
      rawAmount,
    })
    const serialized = Buffer.from(tx.serialize())
    const sig = await withRpcFallback(
      rpc => rpc.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 3 }),
      connection,
    )
    if (sig !== sentSig) throw new Error('RPC returned a signature that does not match the signed swap transaction')
    const confirmation = await confirmSignature(
      connection,
      { signature: sentSig, blockhash, lastValidBlockHeight },
      'confirmed',
      config.swapConfirmTimeoutMs,
    )
    if (confirmation.value.err) throw new Error(`swap transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    onSettled?.(sentSig, 'confirmed')
    console.log(`[swap-timing] legacy ${sentSig.slice(0, 8)} confirmed in ${Date.now() - startedAt}ms`)

    return { signature: sentSig, outputAmount: quote.outAmount || '0', confirmed: true }
  } catch (err) {
    console.log(`[swap] legacy fallback failed: ${err instanceof Error ? err.message : 'unknown'}`)
    if (sentSig && err instanceof Error && err.message.includes('failed on-chain')) onSettled?.(sentSig, 'failed')
    if (sentSig && !(err instanceof Error && err.message.includes('failed on-chain'))) {
      const balanceAfter = await getRawTokenBalance(connection, wallet, inputMint)
      if (balanceAfter !== null && balanceAfter <= minimumRemainingBalance) {
        console.log('[swap] legacy transaction spent the attributed input despite an ambiguous confirmation')
      }
      return { signature: sentSig, outputAmount: '0', confirmed: false }
    }
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
  retryCount: number = 0,
  minimumRemainingBalance = 0n,
  onSigned?: SwapAttemptTracker,
  onSettled?: SwapAttemptSettlement,
): Promise<SwapResult | null> {
  let rawAmount: string
  try {
    rawAmount = normalizeRawSwapAmount(amount)
  } catch (err) {
    console.log(`[swap] invalid amount: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
  const amountRaw = BigInt(rawAmount)
  if (amountRaw <= 0n) return null

  let sentSig = ''
  const startedAt = Date.now()

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
    orderUrl.searchParams.set('amount', rawAmount)
    orderUrl.searchParams.set('taker', wallet.publicKey.toBase58())
    orderUrl.searchParams.set('slippageBps', String(config.maxSwapSlippageBps))
    orderUrl.searchParams.set('orderMode', 'ultra')
    orderUrl.searchParams.set('dynamicSlippage', 'true')

    const outputLabel = outputMint === WSOL_MINT ? 'SOL' : outputMint.slice(0, 8)
    console.log(`[swap] GET /order (ultra) for ${rawAmount} ${inputMint.slice(0, 8)} → ${outputLabel}`)

    const orderRes = await axios.get(orderUrl.toString(), { headers, timeout: 20_000 })
    const order = orderRes.data

    if (order?.error) {
      // Ultra failed — fallback to legacy
      console.log(`[swap] ultra failed (${order.error}), trying legacy...`)
      return tryLegacySwap(connection, wallet, inputMint, rawAmount, outputMint, minimumRemainingBalance, onSigned, onSettled)
    }

    // Field bisa "transaction" (v2 baru) atau "swapTransaction" (v2 lama)
    const rawTx = order.transaction || order.swapTransaction
    if (!rawTx) {
      console.log(`[swap] ultra: no transaction in response, trying legacy...`)
      return tryLegacySwap(connection, wallet, inputMint, rawAmount, outputMint, minimumRemainingBalance, onSigned, onSettled)
    }

    // Sign & send via RPC langsung (karena gak selalu ada requestId buat /execute)
    const tx = VersionedTransaction.deserialize(Buffer.from(rawTx, 'base64'))
    const { blockhash, lastValidBlockHeight } = await withRpcFallback(
      rpc => rpc.getLatestBlockhash('confirmed'),
      connection,
    )
    tx.message.recentBlockhash = blockhash
    tx.sign([wallet])

    sentSig = bs58.encode(tx.signatures[0])
    onSigned?.({
      signature: sentSig,
      blockhash,
      lastValidBlockHeight,
      signedTransaction: Buffer.from(tx.serialize()).toString('base64'),
      inputMint,
      outputMint,
      rawAmount,
    })
    const serialized = Buffer.from(tx.serialize())
    const rpcSignature = await withRpcFallback(
      rpc => rpc.sendRawTransaction(serialized, { skipPreflight: true, maxRetries: 3 }),
      connection,
    )
    if (rpcSignature !== sentSig) throw new Error('RPC returned a signature that does not match the signed swap transaction')
    const confirmation = await confirmSignature(
      connection,
      { signature: sentSig, blockhash, lastValidBlockHeight },
      'confirmed',
      config.swapConfirmTimeoutMs,
    )
    if (confirmation.value.err) throw new Error(`swap transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
    onSettled?.(sentSig, 'confirmed')
    console.log(`[swap-timing] ultra ${sentSig.slice(0, 8)} confirmed in ${Date.now() - startedAt}ms`)

    console.log(`[swap] ultra success: ${sentSig}`)
    return {
      signature: sentSig,
      outputAmount: order.outAmount || '0',
      confirmed: true,
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown'
    console.log(`[swap] attempt ${retryCount + 1} failed: ${msg}`)
    if (sentSig && msg.includes('failed on-chain')) onSettled?.(sentSig, 'failed')

    // If confirmation timed out, the tx may have gone through — check balance
    if (sentSig && !msg.includes('failed on-chain')) {
      const balanceAfter = await getRawTokenBalance(connection, wallet, inputMint)
      if (balanceAfter !== null && balanceAfter <= minimumRemainingBalance) {
        console.log(`[swap] tx succeeded despite RPC timeout`)
      }
      // Never broadcast the same attributed amount twice after an ambiguous send.
      return { signature: sentSig, outputAmount: '0', confirmed: false }
    }

    // Retry on transient errors
    if (shouldRetrySwapError(sentSig, msg, retryCount)) {
      console.log(`[swap] retrying (${retryCount + 1}/3)...`)
      await new Promise<void>(resolve => { setTimeout(resolve, 2_000); })
      return attemptSwap(connection, wallet, inputMint, rawAmount, outputMint, retryCount + 1, minimumRemainingBalance, onSigned, onSettled)
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
  outputMint: string = WSOL_MINT,
  minimumRemainingBalance = 0n,
  onSigned?: SwapAttemptTracker,
  onSettled?: SwapAttemptSettlement,
): Promise<SwapResult | null> {
  return attemptSwap(connection, wallet, inputMint, amount, outputMint, 0, minimumRemainingBalance, onSigned, onSettled)
}
