import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connection } from '@solana/web3.js'
import { createRpcFailoverConnection, withRpcFallback } from '../src/solana/connection.js'

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
