import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { getDb } from '../src/db/client.js'
import {
  canReopenAfterWin,
  classifyOpenFailure,
  decideRunnerClose,
  entryDriftFromPrices,
  combinePoolDiscovery,
  evaluateIngestGate,
  evaluateOpenGate,
  gmgnUnavailableGate,
  isDuplicateAlert,
  isPriceInRange,
  isStaleAlert,
  isTerminalOpenError,
  isWinTrigger,
  parseRunnerAlertPayload,
  priceAboveUpperRatio,
  runnerBinArrayAction,
  selectSolOpenPool,
  selectSolOpenPools,
  shouldChaseEntryDrift,
  shouldCloseFollowup,
  SOL_MINT,
  sumDlmmTvl,
} from '../src/runner/gates.js'
import { parseGmgnTokenInfo } from '../src/runner/gmgn.js'
import { getRunnerOpenRecovery, markRunnerOpenExitHandled } from '../src/meteora/open.js'

const payload = {
  chainId: 'sol',
  mint: 'Mint111111111111111111111111111111111111111',
  symbol: 'RUN',
  volumeUsd: 200_000,
  marketCapUsd: 200_000,
  athMarketCapUsd: 400_000,
  holders: 2500,
  top10HolderPct: 28.4,
  totalFeeSol: 25,
  liquidityUsd: 80_000,
  reason: 'volume spike',
  alertedAt: 1_710_000_000,
}

test('rejects ingest on mcap, holders, and fee', () => {
  const base = {
    enabled: true,
    secretOk: true,
    payload,
    minMcapUsd: 150_000,
    minHolders: 1_000,
    minFeeSol: 20,
    activeRunnerCount: 0,
    maxActive: 1,
    sameMintBusy: false,
  }
  assert.equal(evaluateIngestGate({ ...base, payload: { ...payload, marketCapUsd: 149_999 } }).ok, false)
  assert.equal(evaluateIngestGate({ ...base, payload: { ...payload, holders: 999 } }).ok, false)
  assert.equal(evaluateIngestGate({ ...base, payload: { ...payload, totalFeeSol: 19.99 } }).ok, false)
  assert.equal(evaluateIngestGate(base).ok, true)
})

test('skips open when ATH drop exceeds 50% or DLMM TVL is above 100k', () => {
  const base = { minMcapUsd: 150_000, maxAthDrop: 0.5, maxDlmmTvlUsd: 100_000 }
  assert.equal(evaluateOpenGate({ ...base, marketCapUsd: 200_001, athMarketCapUsd: 400_000, totalTvlUsd: 10_000 }).ok, true)
  assert.equal(evaluateOpenGate({ ...base, marketCapUsd: 200_001, athMarketCapUsd: 400_000, totalTvlUsd: 100_001 }).ok, false)
  assert.equal(evaluateOpenGate({ ...base, marketCapUsd: 200_001, athMarketCapUsd: 400_000, totalTvlUsd: 100_000 }).ok, true)
  assert.equal(evaluateOpenGate({ ...base, marketCapUsd: 200_000, athMarketCapUsd: 400_000, totalTvlUsd: 0 }).ok, false)
  const dropped = evaluateOpenGate({ ...base, marketCapUsd: 199_999, athMarketCapUsd: 400_000, totalTvlUsd: 0 })
  assert.equal(dropped.ok, false)
  if (!dropped.ok) assert.match(dropped.reason, /ath drop/)
  const missingAth = evaluateOpenGate({ ...base, marketCapUsd: 200_000, athMarketCapUsd: null, totalTvlUsd: 0 })
  assert.equal(missingAth.ok, false)
  const lowMcap = evaluateOpenGate({ ...base, marketCapUsd: 149_999, athMarketCapUsd: 400_000, totalTvlUsd: 0 })
  assert.equal(lowMcap.ok, false)
  const invalidTvl = evaluateOpenGate({ ...base, marketCapUsd: 200_001, athMarketCapUsd: 400_000, totalTvlUsd: Number.NaN })
  assert.equal(invalidTvl.ok, false)
  if (!invalidTvl.ok) assert.equal(invalidTvl.retryable, true)
})

test('sums all DLMM TVL including USDC pools and picks the highest SOL pool', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const pools = [
    { poolPubkey: 'sol-low', tokenXMint: 'Mint', tokenYMint: SOL_MINT, tvlUsd: 10_000, blacklisted: false },
    { poolPubkey: 'sol-high', tokenXMint: 'Mint', tokenYMint: SOL_MINT, tvlUsd: 40_000, blacklisted: false },
    { poolPubkey: 'usdc', tokenXMint: 'Mint', tokenYMint: usdc, tvlUsd: 30_000, blacklisted: false },
    { poolPubkey: 'dead', tokenXMint: 'Mint', tokenYMint: SOL_MINT, tvlUsd: 99_000, blacklisted: true },
  ]
  assert.equal(sumDlmmTvl(pools), 179_000)
  assert.equal(selectSolOpenPool(pools)?.poolPubkey, 'sol-high')
  assert.deepEqual(selectSolOpenPools(pools).map(pool => pool.poolPubkey), ['sol-high', 'sol-low'])
  assert.equal(Number.isNaN(sumDlmmTvl([{ ...pools[0], tvlUsd: Number.NaN }])), true)
})

test('treats range-cost errors as terminal and pending opens as non-retry submits', () => {
  assert.equal(isTerminalOpenError('Range requires 2 setup transactions; reduce the percentage range'), true)
  assert.equal(isTerminalOpenError('Range requires 2 positions; reduce the percentage range'), true)
  assert.equal(classifyOpenFailure(new Error('Range requires 2 setup transactions; reduce the percentage range'), 0, 3), 'terminal')
  const pending = new Error('open submission sig requires reconciliation: confirm timeout')
  pending.name = 'OpenSubmissionPendingError'
  assert.equal(classifyOpenFailure(pending, 0, 3), 'pending')
  assert.equal(classifyOpenFailure(new Error('RPC request failed'), 0, 3), 'retry')
  assert.equal(classifyOpenFailure(new Error('RPC request failed'), 2, 3), 'give_up')
})

test('maps missing bin arrays to wait, hold, and finish runner actions', () => {
  assert.equal(runnerBinArrayAction('first'), 'wait')
  assert.equal(runnerBinArrayAction('chase'), 'hold')
  assert.equal(runnerBinArrayAction('followup'), 'finish')
})

test('chases first-position entry drift up to 3 times and stops after in-range', () => {
  const base = { cycleStage: 'open_first' as const, firstChaseCount: 0, firstEverInRange: false, maxChase: 3, threshold: 0.04 }
  assert.ok(Math.abs(priceAboveUpperRatio(1.05, 1) - 0.05) < 1e-12)
  assert.equal(shouldChaseEntryDrift({ ...base, driftPct: 0.041 }), true)
  assert.equal(shouldChaseEntryDrift({ ...base, driftPct: 0.04 }), false)
  assert.equal(shouldChaseEntryDrift({ ...base, firstChaseCount: 3, driftPct: 0.1 }), false)
  assert.equal(shouldChaseEntryDrift({ ...base, firstEverInRange: true, driftPct: 0.1 }), false)
  assert.equal(shouldChaseEntryDrift({ ...base, cycleStage: 'open_followup', driftPct: 0.1 }), false)
  assert.equal(isPriceInRange(10, 1, 10), true)
  assert.equal(isPriceInRange(11, 1, 10), false)
})

test('counts only TP and trailing as wins and stops reopen at 3', () => {
  assert.equal(isWinTrigger('TP'), true)
  assert.equal(isWinTrigger('TRAILING_STOP'), true)
  assert.equal(isWinTrigger('SL'), false)
  assert.equal(isWinTrigger('BIN_RANGE'), false)
  assert.equal(isWinTrigger('RUNNER_ENTRY_DRIFT'), false)
  assert.equal(isWinTrigger('RUNNER_CYCLE'), false)
  assert.equal(decideRunnerClose('TP', 2, 3), 'reopen_eval')
  assert.equal(decideRunnerClose('TRAILING_STOP', 3, 3), 'cycle_done')
  assert.equal(decideRunnerClose('RUNNER_ENTRY_DRIFT', 0, 3), 'chase_first')
  assert.equal(decideRunnerClose('SL', 0, 3), 'cycle_done')
  assert.equal(decideRunnerClose('MANUAL', 0, 3), 'cycle_done')
  const gate = evaluateOpenGate({
    marketCapUsd: 200_001,
    athMarketCapUsd: 400_000,
    totalTvlUsd: 10_000,
    minMcapUsd: 150_000,
    maxAthDrop: 0.5,
    maxDlmmTvlUsd: 100_000,
  })
  assert.equal(canReopenAfterWin({ winCount: 2, maxWins: 3, vol5mUsd: 151_000, minVol5mUsd: 150_000, openGate: gate }).ok, true)
  assert.equal(canReopenAfterWin({ winCount: 3, maxWins: 3, vol5mUsd: 151_000, minVol5mUsd: 150_000, openGate: gate }).ok, false)
  assert.equal(canReopenAfterWin({ winCount: 1, maxWins: 3, vol5mUsd: 150_000, minVol5mUsd: 150_000, openGate: gate }).ok, false)
})

test('closes follow-up only when TVL or volume trips and PnL is positive', () => {
  const base = { totalTvlUsd: 100_001, vol5mUsd: 200_000, pnlPercent: 1, maxDlmmTvlUsd: 100_000, exitMinVol5mUsd: 100_000 }
  assert.equal(shouldCloseFollowup(base), true)
  assert.equal(shouldCloseFollowup({ ...base, pnlPercent: 0 }), false)
  assert.equal(shouldCloseFollowup({ ...base, totalTvlUsd: 50_000, vol5mUsd: 99_999 }), true)
  assert.equal(shouldCloseFollowup({ ...base, totalTvlUsd: 50_000, vol5mUsd: 100_000 }), false)
  assert.equal(shouldCloseFollowup({ ...base, totalTvlUsd: 50_000, vol5mUsd: null }), false)
})

test('computes entry drift for quote-Y and inverted quote-X prices', () => {
  assert.ok(entryDriftFromPrices({
    quoteSide: 'Y',
    currentPoolPrice: 1.05,
    lowerBinPrice: 0.6,
    upperBinPrice: 1,
  }) > 0.04)
  assert.ok(entryDriftFromPrices({
    quoteSide: 'X',
    currentPoolPrice: 1 / 1.05,
    lowerBinPrice: 1,
    upperBinPrice: 1.4,
  }) > 0.04)
  assert.equal(gmgnUnavailableGate().retryable, true)
})

test('parses GMGN openapi token info and ranking fallbacks', () => {
  const parsed = parseGmgnTokenInfo({
    data: {
      circulating_supply: 1_000_000,
      holder_count: 2500,
      ath_price: 0.4,
      price: { price: 0.2, volume_5m: 180_000 },
    },
  })
  assert.ok(parsed)
  assert.equal(parsed.marketCapUsd, 200_000)
  assert.equal(parsed.athMarketCapUsd, 400_000)
  assert.equal(parsed.volume5mUsd, 180_000)
  assert.equal(parsed.holders, 2500)
  assert.equal(parseGmgnTokenInfo({ code: 100, data: {} }), null)
  assert.equal(parseGmgnTokenInfo({ data: { price: { volume_5m: null }, holder_count: null } }), null)
})

test('keeps known pool addresses and marks partial metadata as incomplete', () => {
  const result = combinePoolDiscovery({
    previousKnown: ['a', 'b'],
    discoveredAddresses: ['b', 'c'],
    hydrated: [{ poolPubkey: 'a', tokenXMint: 'Mint', tokenYMint: SOL_MINT, tvlUsd: 10, blacklisted: false }],
    failedAddresses: ['b'],
    lookupFailed: false,
  })
  assert.equal(result.incomplete, true)
  assert.deepEqual(result.knownAddresses.sort(), ['a', 'b', 'c'])
  const refreshed = combinePoolDiscovery({
    previousKnown: ['obsolete'],
    discoveredAddresses: ['fresh'],
    hydrated: [{ poolPubkey: 'fresh', tokenXMint: 'Mint', tokenYMint: SOL_MINT, tvlUsd: 10, blacklisted: false }],
    failedAddresses: [],
    lookupFailed: false,
    authoritativeRefresh: true,
  })
  assert.deepEqual(refreshed.knownAddresses, ['fresh'])
})

test('rejects duplicate and stale runner alerts', () => {
  assert.equal(isDuplicateAlert(100, 100), true)
  assert.equal(isDuplicateAlert(100, 101), false)
  const now = Date.now()
  assert.equal(isStaleAlert(Math.floor(now / 1000), now), false)
  assert.equal(isStaleAlert(Math.floor(now / 1000) - 7200, now), true)
})

test('ignores the intentionally closed open when a runner cycle reopens', () => {
  const db = getDb()
  const owner = `recovery-test-${randomUUID()}`
  const cycleId = randomUUID()
  const positionPubkey = `position-${randomUUID()}`
  const openKey = `open_attempt:${positionPubkey}`
  db.prepare(`
    INSERT INTO positions (
      position_pubkey, pool_pubkey, token_x_mint, token_y_mint, owner,
      status, last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?)
  `).run(positionPubkey, 'pool-test', 'runner-mint', SOL_MINT, owner, Date.now(), Date.now(), Date.now())
  db.prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)').run(
    openKey,
    JSON.stringify({
      positionPubkey,
      poolPubkey: 'pool-test',
      owner,
      runnerCycleId: cycleId,
      runnerMint: 'runner-mint',
      stage: 'finalized',
    }),
    Date.now(),
  )
  try {
    assert.equal(getRunnerOpenRecovery(owner, cycleId, 'runner-mint', positionPubkey), null)
    assert.equal(getRunnerOpenRecovery(owner, cycleId, 'runner-mint')?.status, 'closed')
    markRunnerOpenExitHandled(positionPubkey)
    assert.equal(getRunnerOpenRecovery(owner, cycleId, 'runner-mint'), null)
  } finally {
    db.prepare('DELETE FROM sync_state WHERE key = ?').run(openKey)
    db.prepare('DELETE FROM positions WHERE position_pubkey = ?').run(positionPubkey)
  }
})

test('parses alert payloads and ignores busy mint or disabled agent', () => {
  const parsed = parseRunnerAlertPayload(payload)
  assert.equal('error' in parsed, false)
  assert.equal('error' in parseRunnerAlertPayload({ ...payload, volumeUsd: '200000' }), true)
  const withEvent = parseRunnerAlertPayload({ ...payload, eventId: 'alert-1' })
  assert.equal('error' in withEvent, false)
  if (!('error' in withEvent)) assert.equal(withEvent.eventId, 'alert-1')
  const disabled = evaluateIngestGate({
    enabled: false,
    secretOk: true,
    payload,
    minMcapUsd: 150_000,
    minHolders: 1_000,
    minFeeSol: 20,
    activeRunnerCount: 0,
    maxActive: 1,
    sameMintBusy: false,
  })
  assert.equal(disabled.ok, false)
  if (!disabled.ok) assert.equal(disabled.status, 503)
  const busy = evaluateIngestGate({
    enabled: true,
    secretOk: true,
    payload,
    minMcapUsd: 150_000,
    minHolders: 1_000,
    minFeeSol: 20,
    activeRunnerCount: 0,
    maxActive: 1,
    sameMintBusy: true,
  })
  assert.equal(busy.ok, false)
  if (!busy.ok) assert.equal(busy.status, 202)
})
