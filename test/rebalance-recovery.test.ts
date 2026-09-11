import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair } from '@solana/web3.js'
import { config } from '../src/config.js'
import { closeDb, getDb, setSyncValue } from '../src/db/client.js'
import { loadKnownPositions, upsertPosition, updatePositionStatus } from '../src/meteora/discovery.js'
import { OpenSubmissionPendingError, type OpenPositionPreview } from '../src/meteora/open.js'
import { listRebalanceReopenIntents, persistRebalanceReopenIntent, reconcilePendingRebalanceOpens, type RebalanceReconcileServices } from '../src/meteora/rebalance.js'
import { setPositionRiskDisabled } from '../src/risk/positionSettings.js'

const connection = {} as Connection
const wallet = Keypair.generate()
const owner = wallet.publicKey.toBase58()
const row = {
  positionPubkey: 'old', poolPubkey: 'pool', owner, tokenXMint: 'X', tokenYMint: 'Y',
  tokenXSymbol: 'TOKEN', tokenYSymbol: 'SOL', quoteCurrency: 'SOL' as const,
  basisQuote: 1, basisSolLegacy: 1, basisConfidence: 'high' as const,
  tpPercent: 30, slPercent: -20, status: 'monitoring' as const,
  triggerConfirmations: 0, peakPnlPercent: 0, trailingActivated: false,
  lastPnlPercent: null, lastEstimatedExitQuote: null, lastEstimatedExitSolLegacy: null,
  lastSeenAt: 1, strategy: 'single_side_quote' as const,
}
const intent = {
  positionPubkey: 'old', poolPubkey: 'pool', quoteCurrency: 'SOL' as const,
  amountQuote: 1, rangeWidth: 3, inheritMode: true, direction: 'down' as const,
  rebalanceMode: 'both' as const, trailingDisabled: true, binRangeDisabled: false,
  tokenMint: 'X', tokenAmountRaw: '123456789012345678', closeRequested: true,
  closePnlPercent: -4, closeEstimatedQuote: 0.96,
}
async function database(work: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rebalance-recovery-'))
  const original = config.dbPath
  closeDb()
  config.dbPath = join(directory, 'test.sqlite')
  try { await work() } finally { closeDb(); config.dbPath = original; rmSync(directory, { recursive: true, force: true }) }
}

const closed = { success: true, pendingRecovery: false, executionId: 1, removeSucceeded: true, solReceived: 0, usdcReceived: 0, rentRefundSol: 0, removeLiqSig: 'close', swapSig: null }

test('legacy reopen intents default to Up and inherit both flags from their source', async () => database(async () => {
  upsertPosition({ ...row, trailingDisabled: true, binRangeDisabled: true })
  setSyncValue(`rebalance_reopen:${owner}`, JSON.stringify({ version: 1, owner, positionPubkey: 'old', poolPubkey: 'pool', quoteCurrency: 'SOL', amountQuote: 1, rangeWidth: 3 }))
  const restored = listRebalanceReopenIntents()[0]
  assert.equal(restored.direction, 'up')
  assert.equal(restored.rebalanceMode, 'up')
  assert.equal(restored.trailingDisabled, true)
  assert.equal(restored.binRangeDisabled, true)
  assert.equal(restored.closeRequested, false)
}))

test('restart before close resumes once and passes every risk combination before opening', async () => database(async () => {
  for (const trailingDisabled of [false, true]) for (const binRangeDisabled of [false, true]) {
    upsertPosition(row)
    persistRebalanceReopenIntent(owner, { ...intent, trailingDisabled, binRangeDisabled })
    closeDb()
    let closeCalls = 0
    let openCalls = 0
    const services: RebalanceReconcileServices = {
      notify: () => undefined,
      close: async () => { closeCalls++; updatePositionStatus('old', 'closed'); return closed },
      open: async (_connection, _wallet, params) => {
        openCalls++
        assert.equal(loadKnownPositions().find(p => p.positionPubkey === 'old')?.status, 'closed')
        assert.equal(params.direction, 'down')
        assert.equal(params.tokenAmountRaw, intent.tokenAmountRaw)
        assert.equal(params.rangeWidth, 3)
        assert.equal(params.trailingDisabled, trailingDisabled)
        assert.equal(params.binRangeDisabled, binRangeDisabled)
        assert.equal(params.rebalanceMode, 'both')
        params.onPrepared!('new', 'signature')
        return { positionPubkey: 'new', signature: 'signature', preview: { minBinId: 90, maxBinId: 92, amountQuote: 0.96, amountInput: '123', baseSymbol: 'TOKEN' } as OpenPositionPreview }
      },
    }
    await reconcilePendingRebalanceOpens(connection, wallet, services)
    await reconcilePendingRebalanceOpens(connection, wallet, services)
    assert.equal(closeCalls, 1)
    assert.equal(openCalls, 1)
    assert.equal(listRebalanceReopenIntents().length, 0)
  }
}))

test('deferred close waits, and a prepared open survives restart without a second submission', async () => database(async () => {
  upsertPosition(row)
  persistRebalanceReopenIntent(owner, intent)
  let closeCalls = 0
  let openCalls = 0
  const services: RebalanceReconcileServices = {
    notify: () => undefined,
    close: async () => { closeCalls++; updatePositionStatus('old', 'exiting'); return { ...closed, success: false, pendingRecovery: true } },
    open: async (_connection, _wallet, params) => {
      openCalls++
      upsertPosition({ ...row, positionPubkey: 'new', status: 'opening', trailingDisabled: params.trailingDisabled, binRangeDisabled: params.binRangeDisabled, autoRebalanceEnabled: true, rebalanceMode: params.rebalanceMode })
      params.onPrepared!('new', 'signature')
      throw new OpenSubmissionPendingError('new', 'signature', 'waiting finality')
    },
  }
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(openCalls, 0)
  closeDb()
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(closeCalls, 1)
  updatePositionStatus('old', 'closed')
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(openCalls, 1)
  closeDb()
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(openCalls, 1)
  updatePositionStatus('new', 'monitoring')
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(openCalls, 1)
  const replacement = loadKnownPositions().find(p => p.positionPubkey === 'new')!
  assert.equal(replacement.trailingDisabled, true)
  assert.equal(replacement.binRangeDisabled, false)
  assert.equal(replacement.autoRebalanceEnabled, true)
  assert.equal(replacement.rebalanceMode, 'both')
  assert.equal(listRebalanceReopenIntents().length, 0)
}))

test('a failed linked open is not resubmitted, and in-progress risk settings are frozen', async () => database(async () => {
  upsertPosition(row)
  getDb().prepare('UPDATE positions SET rebalance_busy = 1 WHERE position_pubkey = ?').run('old')
  assert.throws(() => setPositionRiskDisabled('old', 'trail', true), /Rebalance sedang berjalan/)
  persistRebalanceReopenIntent(owner, intent)
  const saved = listRebalanceReopenIntents()[0]
  setSyncValue(`rebalance_reopen:${owner}`, JSON.stringify({ ...saved, openPositionPubkey: 'new', openSignature: 'signature' }))
  updatePositionStatus('old', 'closed')
  await reconcilePendingRebalanceOpens(connection, wallet, {
    notify: () => undefined,
    close: async () => { throw new Error('must not close') },
    open: async () => { assert.fail('must not resubmit a failed linked open') },
  })
  assert.equal(listRebalanceReopenIntents().length, 0)
}))

test('Down waits for a position-specific receipt and persists its exact raw amount before reopening', async () => database(async () => {  upsertPosition({ ...row, status: 'closed' })
  persistRebalanceReopenIntent(owner, { ...intent, tokenAmountRaw: null })
  let calls = 0
  const services: RebalanceReconcileServices = {
    notify: () => undefined,
    close: async () => { assert.fail('closed position must not be closed again') },
    open: async (_connection, _wallet, params) => {
      calls++
      assert.equal(params.tokenAmountRaw, '9007199254740993123')
      assert.equal(listRebalanceReopenIntents()[0].tokenAmountRaw, params.tokenAmountRaw)
      params.onPrepared!('new', 'signature')
      return { positionPubkey: 'new', signature: 'signature', preview: { minBinId: 90, maxBinId: 92, amountQuote: 0.96, amountInput: '123', baseSymbol: 'TOKEN' } as OpenPositionPreview }
    },
  }
  setSyncValue('exit_close_token_receipt:another-position:X', '99999999999999999999')
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(calls, 0)
  assert.equal(listRebalanceReopenIntents()[0].tokenAmountRaw, null)
  setSyncValue('exit_close_token_receipt:old:X', '9007199254740993123')
  closeDb()
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(calls, 1)
  assert.equal(listRebalanceReopenIntents().length, 0)
}))

test('throttles repeated reopen retry notifications for the same failure', async () => database(async () => {
  upsertPosition({ ...row, status: 'closed' })
  persistRebalanceReopenIntent(owner, intent)
  let notifications = 0
  const services: RebalanceReconcileServices = {
    notify: () => { notifications++ },
    close: async () => { assert.fail('closed position must not be closed again') },
    open: async () => { throw new Error('RPC request failed') },
  }
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(notifications, 1)
  assert.equal(listRebalanceReopenIntents().length, 1)
}))

test('stops reopening when the funding balance is insufficient', async () => database(async () => {
  upsertPosition({ ...row, status: 'closed' })
  persistRebalanceReopenIntent(owner, intent)
  const notifications: string[] = []
  const services: RebalanceReconcileServices = {
    notify: message => { notifications.push(message) },
    close: async () => { assert.fail('closed position must not be closed again') },
    open: async () => { throw new Error('Insufficient USDC balance') },
  }
  await reconcilePendingRebalanceOpens(connection, wallet, services)
  assert.equal(listRebalanceReopenIntents().length, 0)
  assert.equal(notifications.length, 1)
  assert.match(notifications[0], /Reopen Stopped/)
}))
