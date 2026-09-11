import { BN } from '@coral-xyz/anchor'
import {
  CLMM_PROGRAM_ID,
  LiquidityMathUtil,
  TickArrayBitmapExtensionLayout,
  TickUtil,
  TxVersion,
  getPdaExBitmapAccount,
  swapInternal,
  type SwapSimulationResult,
} from '@raydium-io/raydium-sdk-v2'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { Connection, Keypair } from '@solana/web3.js'
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import type { Signer } from '@solana/web3.js'
import { config } from '../config.js'
import { withRpcFallback } from '../solana/connection.js'
import { getJupiterSwapQuote } from '../swap.js'
import { buildRaydiumInRangeRange, pricePercentToTicks, type RaydiumTickRange } from './policy.js'
import { loadRaydiumPool, type RaydiumPoolBundle, type RaydiumPoolState } from './pool.js'
import { getRaydium } from './sdk.js'

const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const MAX_TX_BYTES = 1232
const CLOSE_MEASURE_TIMEOUT_MS = 45_000
const CLOSE_MEASURE_POLL_MS = 1_000
const SOLVE_ITERATIONS = 18

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function atomicBudget() {
  return { units: config.raydiumAtomicComputeUnitLimit, microLamports: config.raydiumComputeUnitPrice }
}

function closeBudget() {
  return { units: config.raydiumCloseComputeUnitLimit, microLamports: config.raydiumComputeUnitPrice }
}

async function readWalletTokenAmount(
  connection: Connection,
  owner: PublicKey,
  mint: string,
  tokenProgramId: string,
  commitment: 'confirmed' | 'finalized' = 'finalized',
): Promise<bigint> {
  if (mint === WSOL_MINT) {
    const lamports = await withRpcFallback(rpc => rpc.getBalance(owner, commitment), connection)
    return BigInt(lamports)
  }
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, new PublicKey(tokenProgramId))
  try {
    const balance = await withRpcFallback(rpc => rpc.getTokenAccountBalance(ata, commitment), connection)
    return BigInt(balance.value.amount)
  } catch {
    return 0n
  }
}

export interface RaydiumFundingBaseline {
  mintA: string
  mintB: string
  mintAProgramId: string
  mintBProgramId: string
  amountA: bigint
  amountB: bigint
}

export async function readRaydiumFundingBaseline(
  connection: Connection,
  wallet: Keypair,
  params: { poolId: string },
): Promise<RaydiumFundingBaseline> {
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const [amountA, amountB] = await Promise.all([
    readWalletTokenAmount(connection, wallet.publicKey, bundle.poolInfo.mintA.address, bundle.poolInfo.mintA.programId, 'finalized'),
    readWalletTokenAmount(connection, wallet.publicKey, bundle.poolInfo.mintB.address, bundle.poolInfo.mintB.programId, 'finalized'),
  ])
  return {
    mintA: bundle.poolInfo.mintA.address,
    mintB: bundle.poolInfo.mintB.address,
    mintAProgramId: bundle.poolInfo.mintA.programId,
    mintBProgramId: bundle.poolInfo.mintB.programId,
    amountA,
    amountB,
  }
}

export async function measureRaydiumFundingDelta(
  connection: Connection,
  wallet: Keypair,
  params: { mintA: string; mintB: string; mintAProgramId: string; mintBProgramId: string; baselineA: bigint; baselineB: bigint },
): Promise<{ amountA: bigint; amountB: bigint }> {
  const [currentA, currentB] = await Promise.all([
    readWalletTokenAmount(connection, wallet.publicKey, params.mintA, params.mintAProgramId, 'confirmed'),
    readWalletTokenAmount(connection, wallet.publicKey, params.mintB, params.mintBProgramId, 'confirmed'),
  ])
  return {
    amountA: currentA > params.baselineA ? currentA - params.baselineA : 0n,
    amountB: currentB > params.baselineB ? currentB - params.baselineB : 0n,
  }
}

export interface RaydiumCloseParams {
  poolId: string
  nftMint: string
  mintA: string
  mintB: string
  mintAProgramId: string
  mintBProgramId: string
  baselineA: bigint
  baselineB: bigint
}

export interface RaydiumCloseSubmission {
  signature: string
  amountA: bigint
  amountB: bigint
}

/**
 * Closes the position (100% liquidity, claim fees, burn NFT) and then polls
 * both funding sides until the proceeds are visible. A missing measurement is
 * returned as zero instead of failing, so the durable intent can re-measure.
 */
export async function submitRaydiumClose(
  connection: Connection,
  wallet: Keypair,
  params: RaydiumCloseParams,
): Promise<RaydiumCloseSubmission> {
  const raydium = await getRaydium(connection, wallet)
  const { bundle } = await loadRaydiumPool(connection, wallet, params.poolId)
  const ownerPositions = await raydium.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID })
  const ownerPosition = ownerPositions.find(position => position.nftMint.toBase58() === params.nftMint)
  if (!ownerPosition) throw new Error('Raydium position is no longer owned by this wallet')

  const sqrtCurrent = bundle.rpcPoolInfo.sqrtPriceX64
  const sqrtLower = TickUtil.getSqrtPriceAtTick(ownerPosition.tickLower)
  const sqrtUpper = TickUtil.getSqrtPriceAtTick(ownerPosition.tickUpper)
  const { amountA, amountB } = LiquidityMathUtil.getAmountsForLiquidity(
    sqrtCurrent,
    sqrtLower,
    sqrtUpper,
    ownerPosition.liquidity,
    false,
  )
  const keepRatio = (amount: BN) => amount.muln(10_000 - config.raydiumSlippageBps).divn(10_000)

  const { execute } = await raydium.clmm.decreaseLiquidity({
    poolInfo: bundle.poolInfo,
    poolKeys: bundle.poolKeys,
    ownerPosition,
    ownerInfo: { useSOLBalance: true, closePosition: true },
    liquidity: ownerPosition.liquidity,
    amountMinA: keepRatio(amountA),
    amountMinB: keepRatio(amountB),
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: closeBudget(),
  })
  const { txId } = await execute({ sendAndConfirm: true })

  const deadline = Date.now() + CLOSE_MEASURE_TIMEOUT_MS
  for (;;) {
    const measured = await measureRaydiumFundingDelta(connection, wallet, params)
    if (measured.amountA > 0n || measured.amountB > 0n) {
      return { signature: txId, amountA: measured.amountA, amountB: measured.amountB }
    }
    if (Date.now() >= deadline) return { signature: txId, amountA: 0n, amountB: 0n }
    await sleep(CLOSE_MEASURE_POLL_MS)
  }
}

export interface RaydiumRebalancePlan {
  mode: 'atomic' | 'split'
  anchor: RaydiumTickRange
  swapInputMint: string
  swapInputSide: 'MintA' | 'MintB'
  swapAmountIn: string
  expectedSwapOut: string
  postSwapTick: number
  liquidity: string
  depositA: string
  depositB: string
  nftMint: string
  signedTransaction: string
  blockhash: string
  lastValidBlockHeight: number
  /** Split mode only: the follow-up open transaction prepared after the swap lands. */
  followUp?: {
    nftMint: string
    signedTransaction: string
    blockhash: string
    lastValidBlockHeight: number
  }
}

export class RaydiumSwapRouteWorseError extends Error {
  constructor(readonly directWorsePct: number) {
    super(`Raydium direct swap is ${directWorsePct.toFixed(2)}% worse than the Jupiter quote; rebalance skipped`)
    this.name = 'RaydiumSwapRouteWorseError'
  }
}

interface SwapSimulation {
  out: bigint
  tickCurrent: number
  sqrtPriceX64: bigint
  accounts: PublicKey[]
}

function toNumber(value: bigint): number {
  return Number(value.toString())
}

/**
 * Required MintA/MintB raw-amount ratio of an in-range CLMM position at a
 * given sqrt price. Amounts are proportional to L*(1/sqrtP - 1/sqrtU) for A and
 * L*(sqrtP - sqrtL) for B; the Q64.64 scale cancels only after multiplying the
 * A term by 2^128.
 */
export function positionAmountRatio(sqrtPriceX64: bigint, tickLower: number, tickUpper: number): number {
  const sqrtP = toNumber(sqrtPriceX64)
  const sqrtL = toNumber(BigInt(TickUtil.getSqrtPriceAtTick(tickLower).toString()))
  const sqrtU = toNumber(BigInt(TickUtil.getSqrtPriceAtTick(tickUpper).toString()))
  const amountA = (1 / sqrtP - 1 / sqrtU) * 2 ** 128
  const amountB = sqrtP - sqrtL
  if (!(amountB > 0) || !(amountA >= 0)) return 0
  return amountA / amountB
}

/**
 * Solves the swap size so that post-swap balances match the composition of the
 * one-tick bucket anchored at the post-swap price. Bisection relies on the
 * ratio being monotonic as the swap moves the price and the balances.
 */
export function solveSwapAmount(input: {
  amountA: bigint
  amountB: bigint
  tickSpacing: number
  sellingA: boolean
  simulate: (amountIn: bigint) => { out: bigint; tickCurrent: number; sqrtPriceX64: bigint; accounts: PublicKey[] }
}): {
  amountIn: bigint
  out: bigint
  tickCurrent: number
  sqrtPriceX64: bigint
  accounts: PublicKey[]
  side: 'MintA' | 'MintB'
} {
  const maxIn = input.sellingA ? input.amountA : input.amountB
  if (maxIn <= 0n) throw new Error('Raydium rebalance has no funding to swap')
  const side: 'MintA' | 'MintB' = input.sellingA ? 'MintA' : 'MintB'

  // gap(amountIn) = post-swap A/B ratio minus the required ratio of the bucket
  // anchored at the post-swap price. Selling A shrinks the ratio (gap strictly
  // decreasing); selling B grows it (gap strictly increasing).
  const gap = (amountIn: bigint): number => {
    const sim = input.simulate(amountIn)
    const postA = input.sellingA ? input.amountA - amountIn : input.amountA + sim.out
    const postB = input.sellingA ? input.amountB + sim.out : input.amountB - amountIn
    const anchor = buildRaydiumInRangeRange(sim.tickCurrent, input.tickSpacing)
    const required = positionAmountRatio(sim.sqrtPriceX64, anchor.tickLower, anchor.tickUpper)
    if (postA === 0n && postB === 0n) return Number.NaN
    if (postB === 0n) return Number.POSITIVE_INFINITY
    if (postA === 0n) return Number.NEGATIVE_INFINITY
    return toNumber(postA) / toNumber(postB) - required
  }

  const gapLo = gap(0n)
  if (Number.isNaN(gapLo)) throw new Error('Raydium swap solver could not evaluate the range')
  if (gapLo === 0) {
    const sim = input.simulate(0n)
    return { amountIn: 0n, ...sim, side }
  }
  const gapHi = gap(maxIn)
  if (Number.isNaN(gapHi)) throw new Error('Raydium swap solver could not evaluate the range')
  const increasing = gapLo < 0
  if (increasing ? gapHi <= 0 : gapHi >= 0) {
    const sim = input.simulate(maxIn)
    return { amountIn: maxIn, ...sim, side }
  }

  let lo = 0n
  let hi = maxIn
  for (let iteration = 0; iteration < SOLVE_ITERATIONS; iteration++) {
    const mid = (lo + hi) / 2n
    if (mid === lo || mid === hi) break
    const gapMid = gap(mid)
    if (Number.isNaN(gapMid)) break
    if (increasing ? gapMid > 0 : gapMid < 0) hi = mid
    else lo = mid
  }
  const amountIn = (lo + hi) / 2n
  const sim = input.simulate(amountIn)
  return { amountIn, ...sim, side }
}

export interface RaydiumPreparedRebalance {
  plan: RaydiumRebalancePlan
}

function signedTxPayload(transaction: Transaction | VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64')
}

/**
 * Plans one in-range replacement: closes loop already done, swaps the excess
 * side and opens a one-tick bucket around the post-swap price. The swap and
 * open are merged into a single transaction when it fits; otherwise the plan
 * falls back to a swap transaction plus a follow-up open transaction.
 */
export async function prepareRaydiumRebalance(
  connection: Connection,
  wallet: Keypair,
  params: { poolId: string; amountA: bigint; amountB: bigint },
): Promise<RaydiumPreparedRebalance> {
  const raydium = await getRaydium(connection, wallet)
  const { bundle, state } = await loadRaydiumPool(connection, wallet, params.poolId)

  const anchorAtCurrent = buildRaydiumInRangeRange(state.currentTick, state.tickSpacing)
  const requiredRatio = positionAmountRatio(
    BigInt(bundle.rpcPoolInfo.sqrtPriceX64.toString()),
    anchorAtCurrent.tickLower,
    anchorAtCurrent.tickUpper,
  )
  const balanceRatio = params.amountB === 0n
    ? Number.POSITIVE_INFINITY
    : params.amountA === 0n
      ? 0
      : toNumber(params.amountA) / toNumber(params.amountB)
  const sellingA = params.amountB === 0n ? true : params.amountA === 0n ? false : balanceRatio > requiredRatio
  const inputMint = sellingA ? state.mintA : state.mintB
  const swapPool = await raydium.clmm.getSwapPoolInfo(params.poolId, sellingA)

  const programId = new PublicKey(state.programId)
  const poolPk = new PublicKey(state.poolId)
  const exBitmapAddress = getPdaExBitmapAccount(programId, poolPk).publicKey
  const exBitmapAccount = await withRpcFallback(rpc => rpc.getAccountInfo(exBitmapAddress, 'confirmed'), connection)
  const exBitmap = exBitmapAccount
    ? TickArrayBitmapExtensionLayout.decode(exBitmapAccount.data)
    : { poolId: poolPk, positiveTickArrayBitmap: Buffer.alloc(112), negativeTickArrayBitmap: Buffer.alloc(112) }

  const simulate = (amountIn: bigint): SwapSimulation => {
    const simulation: SwapSimulationResult = swapInternal({
      programId,
      poolId: poolPk,
      poolInfo: swapPool.rpcData,
      tickArrays: swapPool.tickArrays,
      configInfo: swapPool.configInfo,
      tickarrayBitmapExtension: exBitmap,
      amountSpecified: new BN(amountIn.toString()),
      sqrtPriceLimitX64: new BN(0),
      zeroForOne: sellingA,
      isBaseInput: true,
      blockTimestamp: Math.floor(Date.now() / 1000),
      includeExtraTickArrays: true,
    })
    return {
      out: BigInt(simulation.amountCalculated.toString()),
      tickCurrent: simulation.tickCurrent,
      sqrtPriceX64: BigInt(simulation.sqrtPriceX64.toString()),
      accounts: simulation.accounts,
    }
  }

  const solved = solveSwapAmount({ amountA: params.amountA, amountB: params.amountB, tickSpacing: state.tickSpacing, sellingA, simulate })

  const swapNeeded = solved.amountIn > 0n && solved.out > 0n
  if (swapNeeded) {
    const jupiter = await getJupiterSwapQuote({
      inputMint,
      outputMint: sellingA ? state.mintB : state.mintA,
      rawAmount: solved.amountIn.toString(),
      slippageBps: config.raydiumSwapSlippageBps,
    })
    if (jupiter && jupiter.outAmount > 0n) {
      const directWorsePct = (Number(jupiter.outAmount) - Number(solved.out)) / Number(jupiter.outAmount) * 100
      if (directWorsePct > config.raydiumSwapMaxImpactPct) {
        throw new RaydiumSwapRouteWorseError(directWorsePct)
      }
    }
  }
  const postA = sellingA ? params.amountA - solved.amountIn : params.amountA + solved.out
  const postB = sellingA ? params.amountB + solved.out : params.amountB - solved.amountIn
  const anchor = buildRaydiumInRangeRange(solved.tickCurrent, state.tickSpacing)
  const sqrtLower = TickUtil.getSqrtPriceAtTick(anchor.tickLower)
  const sqrtUpper = TickUtil.getSqrtPriceAtTick(anchor.tickUpper)
  const bufferPct = BigInt(Math.round(config.raydiumLiquidityBufferPct))
  const usableA = postA * bufferPct / 100n
  const usableB = postB * bufferPct / 100n
  const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(
    new BN(solved.sqrtPriceX64.toString()),
    sqrtLower,
    sqrtUpper,
    new BN(usableA.toString()),
    new BN(usableB.toString()),
  )
  if (liquidity.lten(0)) throw new Error('Raydium plan produced zero liquidity')

  const maxA = new BN(postA.toString())
  const maxB = new BN(postB.toString())

  const swapData = swapNeeded
    ? await raydium.clmm.swap<TxVersion.LEGACY>({
        poolInfo: swapPool.poolInfo,
        poolKeys: bundle.poolKeys,
        inputMint,
        amountIn: new BN(solved.amountIn.toString()),
        amountOutMin: new BN((solved.out * BigInt(10_000 - config.raydiumSwapSlippageBps) / 10_000n).toString()),
        observationId: swapPool.rpcData.observationId,
        ownerInfo: { useSOLBalance: true },
        remainingAccounts: solved.accounts,
        txVersion: TxVersion.LEGACY,
        computeBudgetConfig: atomicBudget(),
      })
    : null
  const openData = await raydium.clmm.openPositionFromLiquidity<TxVersion.LEGACY>({
    poolInfo: bundle.poolInfo,
    poolKeys: bundle.poolKeys,
    tickLower: anchor.tickLower,
    tickUpper: anchor.tickUpper,
    liquidity,
    amountMaxA: maxA,
    amountMaxB: maxB,
    ownerInfo: { useSOLBalance: true },
    nft2022: true,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: atomicBudget(),
  } as never)

  const nftMint = openData.extInfo.address.nftMint.toBase58()
  const latest = await withRpcFallback(rpc => rpc.getLatestBlockhash('confirmed'), connection)

  const atomic = await tryBuildAtomic(
    connection,
    wallet,
    bundle,
    swapData?.transaction.instructions ?? [],
    openData.transaction.instructions,
    [...(swapData?.signers ?? []), ...openData.signers],
    latest.blockhash,
  )
  if (atomic) {
    return {
      plan: {
        mode: 'atomic',
        anchor,
        swapInputMint: inputMint,
        swapInputSide: sellingA ? 'MintA' : 'MintB',
        swapAmountIn: solved.amountIn.toString(),
        expectedSwapOut: solved.out.toString(),
        postSwapTick: solved.tickCurrent,
        liquidity: liquidity.toString(),
        depositA: usableA.toString(),
        depositB: usableB.toString(),
        nftMint,
        signedTransaction: atomic.signedTransaction,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
    }
  }

  // No swap needed: the balances already match the target composition. Open the
  // bucket directly from the wallet (Raydium rejects zero-amount swaps).
  if (!swapData) {
    const openOnly = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: config.raydiumAtomicComputeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.raydiumComputeUnitPrice }),
      ...stripComputeBudget(openData.transaction.instructions),
    )
    openOnly.feePayer = wallet.publicKey
    openOnly.recentBlockhash = latest.blockhash
    openOnly.lastValidBlockHeight = latest.lastValidBlockHeight
    openOnly.sign(wallet, ...openData.signers)
    return {
      plan: {
        mode: 'atomic',
        anchor,
        swapInputMint: inputMint,
        swapInputSide: sellingA ? 'MintA' : 'MintB',
        swapAmountIn: '0',
        expectedSwapOut: '0',
        postSwapTick: solved.tickCurrent,
        liquidity: liquidity.toString(),
        depositA: usableA.toString(),
        depositB: usableB.toString(),
        nftMint,
        signedTransaction: signedTxPayload(openOnly),
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
    }
  }

  // Fallback: the merged transaction does not fit. Submit the swap first, then
  // the open transaction. Both are signed and persisted before broadcast.
  const swapTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.raydiumAtomicComputeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.raydiumComputeUnitPrice }),
    ...stripComputeBudget(swapData.transaction.instructions),
  )
  swapTx.feePayer = wallet.publicKey
  swapTx.recentBlockhash = latest.blockhash
  swapTx.lastValidBlockHeight = latest.lastValidBlockHeight
  swapTx.sign(wallet, ...swapData.signers)

  const openTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.raydiumAtomicComputeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.raydiumComputeUnitPrice }),
    ...stripComputeBudget(openData.transaction.instructions),
  )
  openTx.feePayer = wallet.publicKey
  openTx.recentBlockhash = latest.blockhash
  openTx.lastValidBlockHeight = latest.lastValidBlockHeight
  openTx.sign(wallet, ...openData.signers)

  const swapPayload = signedTxPayload(swapTx)
  const openPayload = signedTxPayload(openTx)
  return {
    plan: {
      mode: 'split',
      anchor,
      swapInputMint: inputMint,
      swapInputSide: sellingA ? 'MintA' : 'MintB',
      swapAmountIn: solved.amountIn.toString(),
      expectedSwapOut: solved.out.toString(),
      postSwapTick: solved.tickCurrent,
      liquidity: liquidity.toString(),
      depositA: usableA.toString(),
      depositB: usableB.toString(),
      nftMint,
      signedTransaction: swapPayload,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      followUp: {
        nftMint,
        signedTransaction: openPayload,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
    },
  }
}

function stripComputeBudget(instructions: Transaction['instructions']): Transaction['instructions'] {
  return instructions.filter(instruction => !instruction.programId.equals(ComputeBudgetProgram.programId))
}

async function tryBuildAtomic(
  connection: Connection,
  wallet: Keypair,
  bundle: RaydiumPoolBundle,
  swapInstructions: Transaction['instructions'],
  openInstructions: Transaction['instructions'],
  extraSigners: Signer[],
  blockhash: string,
): Promise<{ signedTransaction: string } | null> {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: config.raydiumAtomicComputeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.raydiumComputeUnitPrice }),
    ...stripComputeBudget(swapInstructions),
    ...stripComputeBudget(openInstructions),
  ]

  const legacy = new Transaction().add(...instructions)
  legacy.feePayer = wallet.publicKey
  legacy.recentBlockhash = blockhash
  const legacyBytes = legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).length
  if (legacyBytes <= MAX_TX_BYTES) {
    legacy.sign(wallet, ...extraSigners)
    return { signedTransaction: signedTxPayload(legacy) }
  }

  const lookupTableKey = (bundle.poolKeys as { lookupTableAccount?: string } | undefined)?.lookupTableAccount
  if (!lookupTableKey) return null
  const lookupTable = (await connection.getAddressLookupTable(new PublicKey(lookupTableKey))).value
  if (!lookupTable) return null

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lookupTable])
  const versioned = new VersionedTransaction(message)
  versioned.sign([wallet, ...extraSigners])
  if (versioned.serialize().length > MAX_TX_BYTES) return null
  return { signedTransaction: Buffer.from(versioned.serialize()).toString('base64') }
}

export async function sendRaydiumSigned(
  connection: Connection,
  base64Transaction: string,
  blockhash: string,
  lastValidBlockHeight: number,
): Promise<{ signature: string }> {
  const raw = Buffer.from(base64Transaction, 'base64')
  const signature = await withRpcFallback(rpc => rpc.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  }), connection)
  await withRpcFallback(rpc => rpc.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  ), connection)
  return { signature }
}

export async function simulateRaydiumSigned(
  connection: Connection,
  signedTransaction: string,
): Promise<void> {
  const raw = Buffer.from(signedTransaction, 'base64')
  let result: Awaited<ReturnType<Connection['simulateTransaction']>>
  let versioned: VersionedTransaction | null = null
  try {
    versioned = VersionedTransaction.deserialize(raw)
  } catch {
    versioned = null
  }
  if (versioned) {
    result = await withRpcFallback(rpc => rpc.simulateTransaction(versioned as VersionedTransaction), connection)
  } else {
    const legacy = Transaction.from(raw)
    result = await withRpcFallback(rpc => rpc.simulateTransaction(legacy), connection)
  }
  if (result.value.err) {
    const logs = (result.value.logs || []).filter(line => /Error|failed|insufficient|exceed/i.test(line)).slice(-4).join(' | ')
    throw new Error(`Raydium rebalance simulation failed: ${JSON.stringify(result.value.err)}${logs ? ` :: ${logs}` : ''}`)
  }
}

export { WSOL_MINT }
