import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.js'
import { closeDb, setSyncValue } from '../src/db/client.js'
import { getWalletOperation } from '../src/executionLock.js'
import {
  getRaydiumIntent,
  getRaydiumPositionState,
  listRaydiumIntents,
  reconcilePendingRaydiumRebalances,
  startRaydiumRebalance,
  type RaydiumRebalanceIntent,
  type RaydiumRebalanceServices,
} from '../src/raydium/rebalance.js'

async function database(work: () => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'raydium-recovery-'))
  const original = config.dbPath
  closeDb()
  config.dbPath = join(directory, 'test.sqlite')
  try {
    await work()
  } finally {
    closeDb()
    config.dbPath = original
    rmSync(directory, { recursive: true, force: true })
  }
}

function services(overrides: Partial<RaydiumRebalanceServices> = {}): RaydiumRebalanceServices {
  return {
    readFundingBaseline: async () => ({
      baseSide: 'MintA',
      fundingMint: 'mint-a',
      fundingMintProgramId: 'token-program',
      fundingAmountRaw: 0n,
    }),
    submitClose: async () => ({ signature: 'close-sig', baseAmountRaw: 555n }),
    measureFunding: async () => 555n,
    prepareOpen: async () => ({ nftMint: 'new-nft', submit: async () => 'open-sig' }),
    positionExists: async () => true,
    notify: () => undefined,
    ...overrides,
  }
}

function seedIntent(intent: Partial<RaydiumRebalanceIntent> & Pick<RaydiumRebalanceIntent, 'owner'>): void {
  const now = Date.now()
  setSyncValue(`raydium_rebalance:${intent.owner}`, JSON.stringify({
    version: 1,
    owner: intent.owner,
    leaseId: null,
    oldNftMint: 'old-nft',
    poolId: 'pool-1',
    pairLabel: 'A/B',
    direction: 'up',
    stage: 'close_requested',
    tickLower: 840,
    tickUpper: 900,
    baseSide: 'MintB',
    preFundingBalanceRaw: null,
    fundingMint: null,
    fundingMintProgramId: null,
    baseAmountRaw: null,
    newNftMint: null,
    closeSignature: null,
    closeSubmittedAt: null,
    openSignature: null,
    attempts: 0,
    nextRetryAt: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...intent,
  }))
}

test('records a baseline, closes, reopens once, and arms the new position', async () => {
  await database(async () => {
    let baselineCalls = 0
    let closeCalls = 0
    let prepareCalls = 0
    let submitCalls = 0
    const started = await startRaydiumRebalance({
      owner: 'owner-1',
      nftMint: 'old-nft',
      poolId: 'pool-1',
      pairLabel: 'A/B',
      currentTick: 1000,
      tickSpacing: 60,
      direction: 'down',
      gapPercent: 0.5,
    }, services({
      readFundingBaseline: async () => {
        baselineCalls++
        return { baseSide: 'MintA', fundingMint: 'usdc', fundingMintProgramId: 'token-program', fundingAmountRaw: 1000n }
      },
      submitClose: async params => {
        closeCalls++
        assert.equal(params.preFundingAmountRaw, 1000n)
        return { signature: 'close-sig', baseAmountRaw: 555n }
      },
      prepareOpen: async params => {
        prepareCalls++
        assert.equal(params.baseSide, 'MintA')
        assert.equal(params.baseAmountRaw, 555n)
        assert.deepEqual({ lower: params.tickLower, upper: params.tickUpper }, { lower: 1020, upper: 1080 })
        return { nftMint: 'new-nft', submit: async () => { submitCalls++; return 'open-sig' } }
      },
    }))

    assert.equal(started, true)
    assert.equal(baselineCalls, 1)
    assert.equal(closeCalls, 1)
    assert.equal(prepareCalls, 1)
    assert.equal(submitCalls, 1)
    assert.equal(getRaydiumIntent('owner-1'), null)
    assert.equal(listRaydiumIntents().length, 0)
    assert.equal(getWalletOperation('owner-1'), null)
    const state = getRaydiumPositionState('new-nft')
    assert.equal(state?.direction, null)
    assert.equal(state?.since, null)
    assert.equal(state?.armedDirection, 'up')
  })
})

test('keeps measuring when the close proceeds are not visible yet', async () => {
  await database(async () => {
    let measureCalls = 0
    const trigger = {
      owner: 'owner-2',
      nftMint: 'old-nft',
      poolId: 'pool-1',
      pairLabel: 'A/B',
      currentTick: 1000,
      tickSpacing: 60,
      direction: 'up' as const,
      gapPercent: 0.5,
    }
    const firstPass = services({
      submitClose: async () => ({ signature: 'close-sig', baseAmountRaw: null }),
    })
    assert.equal(await startRaydiumRebalance(trigger, firstPass), true)
    const pending = getRaydiumIntent('owner-2')
    assert.equal(pending?.stage, 'close_submitted')
    assert.equal(pending?.closeSignature, 'close-sig')
    // Make the measurement retry due now instead of waiting the production backoff.
    seedIntent({ ...(pending as RaydiumRebalanceIntent), owner: 'owner-2', nextRetryAt: 0 })

    let prepareCalls = 0
    await reconcilePendingRaydiumRebalances('owner-2', services({
      measureFunding: async () => {
        measureCalls++
        return 777n
      },
      prepareOpen: async params => {
        prepareCalls++
        assert.equal(params.baseAmountRaw, 777n)
        return { nftMint: 'new-nft', submit: async () => 'open-sig' }
      },
    }))
    assert.equal(measureCalls, 1)
    assert.equal(prepareCalls, 1)
    assert.equal(getRaydiumIntent('owner-2'), null)
    assert.equal(getRaydiumPositionState('new-nft')?.armedDirection, 'down')
  })
})

test('reopens from a durable baseline when the position vanished before submit', async () => {
  await database(async () => {
    seedIntent({
      owner: 'owner-3',
      stage: 'close_requested',
      preFundingBalanceRaw: '1000',
      fundingMint: 'usdc',
      fundingMintProgramId: 'token-program',
    })
    let closeCalls = 0
    let prepareCalls = 0
    await reconcilePendingRaydiumRebalances('owner-3', services({
      positionExists: async () => false,
      submitClose: async () => {
        closeCalls++
        return { signature: 'never', baseAmountRaw: null }
      },
      measureFunding: async () => 250n,
      prepareOpen: async params => {
        prepareCalls++
        assert.equal(params.baseAmountRaw, 250n)
        return { nftMint: 'recovered-nft', submit: async () => 'open-sig' }
      },
    }))
    assert.equal(closeCalls, 0)
    assert.equal(prepareCalls, 1)
    assert.equal(getRaydiumIntent('owner-3'), null)
    assert.equal(getRaydiumPositionState('recovered-nft')?.armedDirection, 'down')
  })
})

test('verifies a submitted reopen by its persisted NFT instead of opening twice', async () => {
  await database(async () => {
    seedIntent({
      owner: 'owner-4',
      stage: 'open_submitted',
      newNftMint: 'persisted-nft',
      baseAmountRaw: '1000',
      preFundingBalanceRaw: '1000',
      fundingMint: 'usdc',
      fundingMintProgramId: 'token-program',
    })
    let prepareCalls = 0
    await reconcilePendingRaydiumRebalances('owner-4', services({
      prepareOpen: async () => {
        prepareCalls++
        return { nftMint: 'unused', submit: async () => 'unused' }
      },
      positionExists: async nftMint => nftMint === 'persisted-nft',
    }))
    assert.equal(prepareCalls, 0)
    assert.equal(getRaydiumIntent('owner-4'), null)
    assert.equal(getRaydiumPositionState('persisted-nft')?.armedDirection, 'down')
  })
})

test('rebuilds a reopen when the persisted NFT never landed', async () => {
  await database(async () => {
    seedIntent({ owner: 'owner-5', stage: 'open_submitted', newNftMint: 'ghost-nft', baseAmountRaw: '1000' })
    let submitCalls = 0
    await reconcilePendingRaydiumRebalances('owner-5', services({
      prepareOpen: async () => ({ nftMint: 'fresh-nft', submit: async () => { submitCalls++; return 'open-sig' } }),
      positionExists: async nftMint => nftMint === 'fresh-nft',
    }))
    assert.equal(submitCalls, 1)
    assert.equal(getRaydiumIntent('owner-5'), null)
    assert.equal(getRaydiumPositionState('fresh-nft')?.armedDirection, 'down')
  })
})

test('aborts without reopening when the old position vanished before a receipt', async () => {
  await database(async () => {
    const notifications: string[] = []
    let prepareCalls = 0
    const started = await startRaydiumRebalance({
      owner: 'owner-6',
      nftMint: 'old-nft',
      poolId: 'pool-1',
      pairLabel: 'A/B',
      currentTick: 1000,
      tickSpacing: 60,
      direction: 'up',
      gapPercent: 0.5,
    }, services({
      positionExists: async () => false,
      prepareOpen: async () => {
        prepareCalls++
        return { nftMint: 'unused', submit: async () => 'unused' }
      },
      notify: message => notifications.push(message),
    }))

    assert.equal(started, true)
    assert.equal(prepareCalls, 0)
    assert.equal(getRaydiumIntent('owner-6'), null)
    assert.equal(getWalletOperation('owner-6'), null)
    assert.ok(notifications.some(message => message.includes('Dibatalkan')))
  })
})

test('keeps a durable intent and refuses a second start while retrying', async () => {
  await database(async () => {
    let closeCalls = 0
    const retrying = services({
      submitClose: async () => {
        closeCalls++
        throw new Error('RPC timeout')
      },
    })
    const trigger = {
      owner: 'owner-7',
      nftMint: 'old-nft',
      poolId: 'pool-1',
      pairLabel: 'A/B',
      currentTick: 1000,
      tickSpacing: 60,
      direction: 'up' as const,
      gapPercent: 0.5,
    }
    assert.equal(await startRaydiumRebalance(trigger, retrying), true)
    const intent = getRaydiumIntent('owner-7')
    assert.equal(intent?.stage, 'close_requested')
    assert.equal(intent?.attempts, 1)
    assert.ok((intent?.nextRetryAt ?? 0) > Date.now())
    assert.equal(closeCalls, 1)

    assert.equal(await startRaydiumRebalance(trigger, retrying), false)
    await reconcilePendingRaydiumRebalances('owner-7', retrying)
    assert.equal(closeCalls, 1)
    assert.equal(getRaydiumIntent('owner-7')?.attempts, 1)
  })
})
