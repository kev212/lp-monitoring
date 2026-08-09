import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connection } from '@solana/web3.js'
import { createRpcFailoverConnection, withRpcFallback, withSignatureStatusFallback } from '../src/solana/connection.js'

test('retries a failed RPC read on the configured fallback connection', async () => {
  let fallbackCalls = 0
  const primary = {
    getSlot: async () => { throw new Error('429 Too Many Requests') },
  } as unknown as Connection
  const fallback = {
    getSlot: async () => {
      fallbackCalls++
      return 123
    },
  } as unknown as Connection

  const slot = await withRpcFallback(connection => connection.getSlot('confirmed'), primary, fallback, null)
  assert.equal(slot, 123)
  assert.equal(fallbackCalls, 1)
})

test('does not call the fallback when the primary RPC read succeeds', async () => {
  let fallbackCalls = 0
  const primary = {
    getSlot: async () => 456,
  } as unknown as Connection
  const fallback = {
    getSlot: async () => {
      fallbackCalls++
      return 789
    },
  } as unknown as Connection

  const slot = await withRpcFallback(connection => connection.getSlot('confirmed'), primary, fallback, null)
  assert.equal(slot, 456)
  assert.equal(fallbackCalls, 0)
})

test('retries signature status when the primary has no local record', async () => {
  const calls: string[] = []
  const primary = {
    getSignatureStatus: async () => {
      calls.push('primary')
      return { context: { slot: 100 }, value: null }
    },
  } as unknown as Connection
  const fallback = {
    getSignatureStatus: async () => {
      calls.push('fallback')
      return {
        context: { slot: 101 },
        value: { slot: 99, confirmations: null, err: null, confirmationStatus: 'finalized' },
      }
    },
  } as unknown as Connection

  const status = await withSignatureStatusFallback(
    connection => connection.getSignatureStatus('signature', { searchTransactionHistory: true }),
    primary,
    fallback,
    null,
  )
  assert.equal(status.value?.confirmationStatus, 'finalized')
  assert.deepEqual(calls, ['primary', 'fallback'])
})

test('retries the secondary public RPC after both configured providers fail', async () => {
  const calls: string[] = []
  const primary = {
    getSlot: async () => {
      calls.push('primary')
      throw new Error('429 primary')
    },
  } as unknown as Connection
  const fallback = {
    getSlot: async () => {
      calls.push('fallback')
      throw new Error('429 fallback')
    },
  } as unknown as Connection
  const secondary = {
    getSlot: async () => {
      calls.push('secondary')
      return 789
    },
  } as unknown as Connection

  const slot = await withRpcFallback(connection => connection.getSlot('confirmed'), primary, fallback, secondary)
  assert.equal(slot, 789)
  assert.deepEqual(calls, ['primary', 'fallback', 'secondary'])
})

test('failover connection applies the same chain to SDK-style direct RPC calls', async () => {
  const calls: string[] = []
  const primary = {
    getSlot: async () => {
      calls.push('primary')
      throw new Error('primary unavailable')
    },
  } as unknown as Connection
  const fallback = {
    getSlot: async () => {
      calls.push('fallback')
      throw new Error('fallback unavailable')
    },
  } as unknown as Connection
  const secondary = {
    getSlot: async () => {
      calls.push('secondary')
      return 321
    },
  } as unknown as Connection

  const connection = createRpcFailoverConnection(primary, [fallback, secondary])
  const slot = await connection.getSlot('confirmed')
  assert.equal(slot, 321)
  assert.deepEqual(calls, ['primary', 'fallback', 'secondary'])
})

test('keeps subscription registration on the same connection as listener removal', async () => {
  const calls: string[] = []
  const primary = {
    onSignature: () => {
      calls.push('primary:on')
      return 7
    },
    removeSignatureListener: async (id: number) => {
      calls.push(`primary:remove:${id}`)
    },
  } as unknown as Connection
  const fallback = {
    onSignature: () => {
      calls.push('fallback:on')
      return 8
    },
    removeSignatureListener: async () => {
      calls.push('fallback:remove')
    },
  } as unknown as Connection

  const connection = createRpcFailoverConnection(primary, [fallback])
  const id = connection.onSignature('signature', () => undefined)
  await connection.removeSignatureListener(id)
  assert.deepEqual(calls, ['primary:on', 'primary:remove:7'])
})
