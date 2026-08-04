import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRawSwapAmount, shouldRetrySwapError } from '../src/swap.js'

test('keeps raw swap amounts exact above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(normalizeRawSwapAmount('18446744073709551615'), '18446744073709551615')
  assert.equal(normalizeRawSwapAmount('0001000'), '1000')
  assert.throws(() => normalizeRawSwapAmount('1.5'))
  assert.throws(() => normalizeRawSwapAmount('-1'))
})

test('never retries a different transaction after an ambiguous signed send', () => {
  assert.equal(shouldRetrySwapError('signed-transaction', 'confirm timeout', 0), false)
  assert.equal(shouldRetrySwapError('', 'confirm timeout', 0), true)
  assert.equal(shouldRetrySwapError('', 'confirm timeout', 2), false)
  assert.equal(shouldRetrySwapError('', 'No routes found', 0), false)
})
