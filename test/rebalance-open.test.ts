import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { config } from '../src/config.js'
import { closeDb, getDb } from '../src/db/client.js'
import { loadKnownPositions } from '../src/meteora/discovery.js'
import { buildRebalanceRange, listRebalanceReopenIntents, persistRebalanceReopenIntent, updateRebalanceReopenAttempt } from '../src/meteora/rebalance.js'
import { buildOpenTransaction, createPendingOpen, resolveRebalanceFunding, type OpenPositionPreview } from '../src/meteora/open.js'

const fundingInput = { quoteSide: 'Y' as const, quoteMint: 'SOL', tokenXMint: 'TOKEN', quoteDecimals: 9, tokenXDecimals: 6, amountQuote: 99 }

test('Down deposits raw token units and values the new basis at the reopen price', () => {
  const result = resolveRebalanceFunding({ ...fundingInput, direction: 'down', tokenMint: 'TOKEN', tokenAmountRaw: '1234567', activeQuotePrice: 0.02 })
  assert.equal(result.amountRaw, 1234567n)
  assert.equal(result.amountInput, '1.234567')
  assert.equal(result.fundingSide, 'X')
  assert.equal(result.fundingMint, 'TOKEN')
  assert.equal(result.amountQuote, 1.234567 * 0.02)
  assert.notEqual(result.amountQuote, fundingInput.amountQuote)
  const large = resolveRebalanceFunding({ ...fundingInput, direction: 'down', tokenAmountRaw: '9007199254740993', activeQuotePrice: 1 })
  assert.equal(large.amountRaw.toString(), '9007199254740993')
})

test('rejects incompatible Down funding while Up keeps its quote funding', () => {
  const down = { ...fundingInput, direction: 'down' as const, tokenAmountRaw: '123', activeQuotePrice: 1 }
  assert.throws(() => resolveRebalanceFunding({ ...down, quoteSide: 'X' }), /unsupported/)
  assert.throws(() => resolveRebalanceFunding({ ...down, tokenMint: 'different' }), /must match/)
  for (const raw of ['0', '-1', '1.5', 'abc']) assert.throws(() => resolveRebalanceFunding({ ...down, tokenAmountRaw: raw }), /positive integer/)
  assert.throws(() => resolveRebalanceFunding({ ...down, activeQuotePrice: NaN }), /price is invalid/)
  const up = resolveRebalanceFunding({ ...fundingInput, amountQuote: 1.5 })
  assert.equal(up.amountRaw, 1500000000n)
  assert.equal(up.fundingSide, 'Y')
  assert.equal(up.fundingMint, 'SOL')
  assert.equal(up.amountQuote, 1.5)
})

const preview: OpenPositionPreview = {
  poolPubkey: 'pool', tokenXMint: 'TOKEN', tokenYMint: 'SOL', tokenXSymbol: 'TOKEN', tokenYSymbol: 'SOL',
  tokenXDecimals: 6, tokenYDecimals: 9, quoteCurrency: 'SOL', quoteSide: 'Y', quoteMint: 'SOL',
  quoteSymbol: 'SOL', quoteDecimals: 9, baseSymbol: 'TOKEN', amountInput: '1.234567', amountRaw: '1234567', amountQuote: 0.025,
  rangePercent: 0, strategy: 'spot', activeBinId: 90, ...buildRebalanceRange(90, 3, 'down'), binCount: 3,
  currentPriceQuote: 0.02, targetPriceQuote: 0.02, estimatedPositionCostSol: 0, maxPriceMoveBins: 1,
  addSlippagePercent: 1, observedAt: 1, fundingSide: 'X', fundingMint: 'TOKEN',
}

test('transaction builder funds token X for Down and retains quote Y for ordinary opens', async () => {
  const requests: any[] = []
  const pool = { initializePositionAndAddLiquidityByStrategy: async (params: any) => { requests.push(params); return {} } }
  const owner = Keypair.generate().publicKey
  await buildOpenTransaction(pool as any, owner, Keypair.generate().publicKey, preview)
  assert.equal(requests[0].totalXAmount.toString(), '1234567')
  assert.equal(requests[0].totalYAmount.toString(), '0')
  assert.deepEqual([requests[0].strategy.minBinId, requests[0].strategy.maxBinId], [90, 92])
  assert.equal(requests[0].strategy.singleSidedX, true)
  await buildOpenTransaction(pool as any, owner, Keypair.generate().publicKey, { ...preview, fundingSide: undefined, fundingMint: undefined })
  assert.equal(requests[1].totalXAmount.toString(), '0')
  assert.equal(requests[1].totalYAmount.toString(), '1234567')
  assert.equal(requests[1].strategy.singleSidedX, false)
})

test('prepared open atomically records inherited flags and its exact intent link before submission', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rebalance-open-'))
  const original = config.dbPath
  closeDb()
  config.dbPath = join(directory, 'test.sqlite')
  try {
    for (const trailingDisabled of [false, true]) for (const binRangeDisabled of [false, true]) {
      const owner = Keypair.generate().publicKey.toBase58()
      const position = Keypair.generate()
      persistRebalanceReopenIntent(owner, {
        positionPubkey: 'old', poolPubkey: 'pool', quoteCurrency: 'SOL', amountQuote: 1, rangeWidth: 3,
        inheritMode: true, direction: 'down', rebalanceMode: 'both', trailingDisabled, binRangeDisabled,
        tokenMint: 'TOKEN', tokenAmountRaw: '1234567', closeRequested: true, closePnlPercent: 0, closeEstimatedQuote: 1,
      })
      const state: Parameters<typeof createPendingOpen>[2] = {
        version: 1, positionPubkey: position.publicKey.toBase58(), owner, poolPubkey: 'pool', quoteCurrency: 'SOL',
        amountRaw: '1234567', minBinId: 90, maxBinId: 92, strategy: 'spot', signature: 'signature',
        signedTransaction: 'dGVzdA==', blockhash: 'hash', lastValidBlockHeight: 100, stage: 'prepared',
        missingAfterExpiryChecks: 0, missingVerificationChecks: 0, lastExpiryAbsenceAt: null,
        createdAt: 1, updatedAt: 1, lastError: null, runnerCycleId: null, runnerMint: null,
      }
      const context = { trailingDisabled, binRangeDisabled, rebalanceMode: 'both' as const, inheritMode: true }
      assert.throws(() => createPendingOpen(position, preview, state, { ...context, onPrepared: (pubkey, signature) => {
        updateRebalanceReopenAttempt(owner, pubkey, signature)
        throw new Error('link failure')
      } }), /link failure/)
      assert.equal(loadKnownPositions().some(p => p.positionPubkey === state.positionPubkey), false)
      assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM sync_state WHERE key = ?').get(`wallet_operation:${owner}`)?.n ?? 0, 0)
      assert.equal(listRebalanceReopenIntents().find(i => i.owner === owner)!.openPositionPubkey, null)
      createPendingOpen(position, preview, state, { ...context, onPrepared: (pubkey, signature) => updateRebalanceReopenAttempt(owner, pubkey, signature) })
      closeDb()
      const saved = loadKnownPositions().find(p => p.positionPubkey === state.positionPubkey)!
      assert.equal(saved.status, 'opening')
      assert.equal(saved.strategy, 'single_side_token')
      assert.equal(saved.basisQuote, preview.amountQuote)
      assert.equal(saved.trailingDisabled, trailingDisabled)
      assert.equal(saved.binRangeDisabled, binRangeDisabled)
      assert.equal(saved.autoRebalanceEnabled, true)
      assert.equal(saved.rebalanceMode, 'both')
      assert.equal(saved.peakPnlPercent, 0)
      assert.equal(saved.trailingActivated, false)
      assert.equal(listRebalanceReopenIntents().find(i => i.owner === owner)!.openPositionPubkey, state.positionPubkey)
    }
  } finally { closeDb(); config.dbPath = original; rmSync(directory, { recursive: true, force: true }) }
})
