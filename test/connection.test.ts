import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connection } from '@solana/web3.js'
import { withRpcFallback } from '../src/solana/connection.js'

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

  const slot = await withRpcFallback(connection => connection.getSlot('confirmed'), primary, fallback)
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

  const slot = await withRpcFallback(connection => connection.getSlot('confirmed'), primary, fallback)
  assert.equal(slot, 456)
  assert.equal(fallbackCalls, 0)
})
