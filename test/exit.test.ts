import assert from 'node:assert/strict'
import test from 'node:test'
import { Connection, Keypair, SendTransactionError, Transaction, TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'
import { closeDb, getDb } from '../src/db/client.js'
import { config } from '../src/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAmbiguousDurableSendError } from '../src/executionLock.js'
import { attributedTokenReceipt, collectExitBaselines, exitRetryDelayMs, finalizedSettlementSlot, getTokenBalance, positiveBalanceDelta, readCloseTokenReceipt, sendTrackedTransaction, shouldResolveClosedExitWithoutFinalSignature, swapObligation } from '../src/meteora/exit.js'
import { formatExitReconciled } from '../src/telegram.js'

const CLOSE_RECEIPT_PREFIX = 'exit_close_token_receipt:'

function tokenBalance(accountIndex: number, mint: string, owner: string, amount: string) {
  return { accountIndex, mint, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: amount } }
}

function tokenTransaction(preTokenBalances: any[], postTokenBalances: any[]) {
  return { meta: { err: null, preTokenBalances, postTokenBalances } }
}

test('attributes close token proceeds from raw owner and mint deltas across remove transactions', () => {
  const owner = 'WalletOwner'
  const mint = 'TokenMint'
  const otherMint = 'UnrelatedMint'
  const transactions = [
    tokenTransaction(
      [
        tokenBalance(0, mint, owner, '1000'),
        tokenBalance(1, mint, owner, '250'),
        tokenBalance(2, otherMint, owner, '900'),
        tokenBalance(3, mint, 'OtherOwner', '5000'),
      ],
      [
        tokenBalance(0, mint, owner, '1300'),
        tokenBalance(1, mint, owner, '300'),
        tokenBalance(2, otherMint, owner, '901'),
        tokenBalance(3, mint, 'OtherOwner', '5000'),
      ],
    ),
    tokenTransaction(
      [tokenBalance(4, mint, owner, '10')],
      [tokenBalance(4, mint, owner, '135')],
    ),
  ]

  assert.equal(attributedTokenReceipt(transactions, owner, mint), '475')
})

test('defers token attribution when finalized transaction metadata is missing', () => {
  assert.throws(
    () => attributedTokenReceipt([{ meta: null }], 'WalletOwner', 'TokenMint'),
    /metadata unavailable/,
  )
})

test('accepts an empty but present token balance set as a secured zero receipt', () => {
  assert.equal(attributedTokenReceipt([tokenTransaction([], [])], 'WalletOwner', 'TokenMint'), '0')
})

test('reads a durable close token receipt by position and mint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'exit-receipt-'))
  const originalPath = config.dbPath
  closeDb()
  config.dbPath = join(directory, 'test.sqlite')
  const positionPubkey = `receipt-test-position-${Date.now()}`
  const mint = 'receipt-test-mint'
  const key = `${CLOSE_RECEIPT_PREFIX}${positionPubkey}:${mint}`
  try {
    const db = getDb()
    assert.equal(readCloseTokenReceipt(positionPubkey, mint), null)
    db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, '123456', Date.now())
    assert.equal(readCloseTokenReceipt(positionPubkey, mint), '123456')
    assert.equal(readCloseTokenReceipt(positionPubkey, 'other-mint'), null)
  } finally {
    closeDb()
    config.dbPath = originalPath
    rmSync(directory, { recursive: true, force: true })
  }
})

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

test('keeps durable attempts for ambiguous send errors', () => {
  const alreadyProcessed = new SendTransactionError({
    action: 'send',
    signature: '',
    transactionMessage: 'Transaction was already processed',
  })
  const simulationFailure = new SendTransactionError({
    action: 'simulate',
    signature: '',
    transactionMessage: 'custom program error: 0x1',
  })

  assert.equal(isAmbiguousDurableSendError(alreadyProcessed), true)
  assert.equal(isAmbiguousDurableSendError(simulationFailure), false)
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

test('withholds settlement until every exit transaction is finalized', async () => {
  const connection = {
    getSignatureStatus: async (signature: string) => ({
      value: signature === 'done'
        ? { slot: 42, err: null, confirmationStatus: 'finalized' }
        : { slot: 43, err: null, confirmationStatus: 'confirmed' },
    }),
  } as unknown as Connection

  assert.equal(await finalizedSettlementSlot(connection, ['done', 'pending']), null)
})

test('uses the highest finalized slot as the settlement floor', async () => {
  const slots: Record<string, number> = { first: 41, second: 43 }
  const connection = {
    getSignatureStatus: async (signature: string) => ({
      value: { slot: slots[signature], err: null, confirmationStatus: 'finalized' },
    }),
  } as unknown as Connection

  assert.equal(await finalizedSettlementSlot(connection, ['first', 'second']), 43)
  assert.equal(await finalizedSettlementSlot(connection, []), 0)
})

test('withholds settlement when an exit transaction failed on-chain', async () => {
  const connection = {
    getSignatureStatus: async () => ({
      value: { slot: 42, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' },
    }),
  } as unknown as Connection

  assert.equal(await finalizedSettlementSlot(connection, ['failed']), null)
})

test('stops a manually closed exit only after its finality review timeout', () => {
  const createdAt = 1_000
  const input = {
    createdAt,
    now: createdAt + 60_000,
    reviewTimeoutMs: 60_000,
    settlementSlot: null,
    positionClosed: true,
  }

  assert.equal(shouldResolveClosedExitWithoutFinalSignature(input), true)
  assert.equal(shouldResolveClosedExitWithoutFinalSignature({ ...input, now: createdAt + 59_999 }), false)
  assert.equal(shouldResolveClosedExitWithoutFinalSignature({ ...input, positionClosed: false }), false)
  assert.equal(shouldResolveClosedExitWithoutFinalSignature({ ...input, settlementSlot: 42 }), false)
})

test('requests token balances at or after the settlement slot', async () => {
  let seenMinContextSlot = 0
  const connection = {
    getTokenAccountsByOwner: async (_owner: unknown, _filter: unknown, config: { minContextSlot?: number }) => {
      seenMinContextSlot = config.minContextSlot ?? 0
      return { context: { slot: 50 }, value: [] }
    },
  } as unknown as Connection

  const balance = await getTokenBalance(connection, Keypair.generate().publicKey, 'So11111111111111111111111111111111111111112', 1, 42)
  assert.equal(balance, 0n)
  assert.equal(seenMinContextSlot, 42)
})

test('rejects a stale token balance read from a lagging RPC', async () => {
  const connection = {
    getTokenAccountsByOwner: async () => ({ context: { slot: 41 }, value: [] }),
  } as unknown as Connection

  await assert.rejects(
    getTokenBalance(connection, Keypair.generate().publicKey, 'So11111111111111111111111111111111111111112', 1, 42),
    /stale token balance read/,
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
