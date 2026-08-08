import assert from 'node:assert/strict'
import test from 'node:test'
import { Connection, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'
import { collectExitBaselines, exitRetryDelayMs, positiveBalanceDelta, sendTrackedTransaction, swapObligation } from '../src/meteora/exit.js'
import { formatExitReconciled } from '../src/telegram.js'

test('isolates only newly received close proceeds from an existing wallet balance', () => {
  assert.equal(positiveBalanceDelta(1_000n, 1_450n), 450n)
  assert.equal(positiveBalanceDelta(1_000n, 1_000n), 0n)
  assert.equal(positiveBalanceDelta(1_000n, 900n), 0n)
})

test('keeps retry backoff bounded and excludes already-consumed swap input', () => {
  assert.equal(exitRetryDelayMs(0), 2_000)
  assert.equal(exitRetryDelayMs(1), 4_000)
  assert.equal(exitRetryDelayMs(20), 300_000)
  assert.equal(swapObligation(1_000n, 450n, 1_450n), 0n)
  assert.equal(swapObligation(1_000n, 450n, 1_600n), 150n)
})

function signedTestTransaction(wallet: Keypair): Transaction {
  return new Transaction().add(new TransactionInstruction({
    keys: [],
    programId: wallet.publicKey,
    data: Buffer.alloc(0),
  }))
}

test('persists a remove signature before an ambiguous RPC send', async () => {
  const wallet = Keypair.generate()
  let trackedSignature = ''
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
    sendRawTransaction: async () => { throw new Error('RPC timeout after submit') },
  } as unknown as Connection

  await assert.rejects(
    sendTrackedTransaction(connection, wallet, signedTestTransaction(wallet), attempt => { trackedSignature = attempt.signature }),
    /RPC timeout/,
  )
  assert.match(trackedSignature, /^[1-9A-HJ-NP-Za-km-z]+$/)
})

test('rejects a finalized remove transaction with an on-chain error', async () => {
  const wallet = Keypair.generate()
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
    sendRawTransaction: async (raw: Buffer) => {
      const transaction = Transaction.from(raw)
      return bs58.encode(transaction.signature!)
    },
    confirmTransaction: async () => ({ value: { err: { InstructionError: [0, 'Custom'] } } }),
  } as unknown as Connection

  await assert.rejects(
    sendTrackedTransaction(connection, wallet, signedTestTransaction(wallet), () => undefined),
    /failed on-chain/,
  )
})

test('returns after confirmed remove confirmation and records the attempt', async () => {
  const wallet = Keypair.generate()
  let commitment = ''
  let confirmedSignature = ''
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
    sendRawTransaction: async (raw: Buffer) => {
      const transaction = Transaction.from(raw)
      return bs58.encode(transaction.signature!)
    },
    confirmTransaction: async (_strategy: unknown, requestedCommitment: string) => {
      commitment = requestedCommitment
      return { value: { err: null } }
    },
  } as unknown as Connection

  const signature = await sendTrackedTransaction(
    connection,
    wallet,
    signedTestTransaction(wallet),
    () => undefined,
    attempt => { confirmedSignature = attempt.signature },
  )
  assert.equal(commitment, 'confirmed')
  assert.equal(confirmedSignature, signature)
})

test('aborts baseline collection when an RPC balance read fails', async () => {
  const connection = {
    getBalance: async () => { throw new Error('RPC unavailable') },
  } as unknown as Connection
  await assert.rejects(
    collectExitBaselines(connection, Keypair.generate().publicKey, 'SOL', []),
    /RPC unavailable/,
  )
})

test('formats a final background reconciliation notification with transaction links', () => {
  const message = formatExitReconciled({
    executionId: 7,
    positionPubkey: '2acTcQJ4NSQdFy68SEbLDEWWxa9PwxPXYv8kr6kwV8ua',
    pair: 'Doom/SOL',
    triggerType: 'MANUAL',
    quoteCurrency: 'SOL',
    receivedQuote: 3.137309,
    rentRefundSol: 0.002,
    removeLiqSig: 'remove-signature',
    swapSig: 'swap-signature',
    createdAt: Date.now(),
  })
  assert.match(message, /Exit Complete — Reconciled/)
  assert.match(message, /Doom\/SOL/)
  assert.match(message, /3\.1373 SOL/)
  assert.match(message, /solscan\.io\/tx\/remove-signature/)
  assert.match(message, /solscan\.io\/tx\/swap-signature/)
})
