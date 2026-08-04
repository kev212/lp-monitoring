import assert from 'node:assert/strict'
import test from 'node:test'
import { Connection, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'
import { collectExitBaselines, positiveBalanceDelta, sendTrackedTransaction } from '../src/meteora/exit.js'

test('isolates only newly received close proceeds from an existing wallet balance', () => {
  assert.equal(positiveBalanceDelta(1_000n, 1_450n), 450n)
  assert.equal(positiveBalanceDelta(1_000n, 1_000n), 0n)
  assert.equal(positiveBalanceDelta(1_000n, 900n), 0n)
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

test('aborts baseline collection when an RPC balance read fails', async () => {
  const connection = {
    getBalance: async () => { throw new Error('RPC unavailable') },
  } as unknown as Connection
  await assert.rejects(
    collectExitBaselines(connection, Keypair.generate().publicKey, 'SOL', []),
    /RPC unavailable/,
  )
})
