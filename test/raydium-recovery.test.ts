import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.js'
import { closeDb, setSyncValue } from '../src/db/client.js'
import { getWalletOperation } from '../src/executionLock.js'
import { RaydiumSwapRouteWorseError, type RaydiumFundingBaseline, type RaydiumRebalancePlan } from '../src/raydium/execute.js'
import {
  getRaydiumIntent,
  getRaydiumPositionState,
  listRaydiumIntents,
  reconcilePendingRaydiumRebalances,
  saveRaydiumIntent,
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

const baseline: RaydiumFundingBaseline = {
  mintA: 'mint-a',
  mintB: 'mint-b',
  mintAProgramId: 'prog-a',
  mintBProgramId: 'prog-b',
  amountA: 0n,
  amountB: 1_000n,
}

const storedBaseline = {
  mintA: 'mint-a',
  mintB: 'mint-b',
  mintAProgramId: 'prog-a',
  mintBProgramId: 'prog-b',
  amountA: '0',
  amountB: '1000',
}

const atomicPlan: RaydiumRebalancePlan = {
  mode: 'atomic',
  anchor: { tickLower: 960, tickUpper: 1020 },
  swapInputMint: 'mint-b',
  swapInputSide: 'MintB',
  swapAmountIn: '500',
  expectedSwapOut: '100',
  postSwapTick: 1000,
  liquidity: '123456',
  depositA: '50',
  depositB: '950',
  nftMint: 'new-nft',
  signedTransaction: 'atomic-base64',
  blockhash: 'blockhash',
  lastValidBlockHeight: 123,
}

const splitPlan: RaydiumRebalancePlan = {
  ...atomicPlan,
  mode: 'split',
  signedTransaction: 'swap-base64',
  followUp: {
    nftMint: 'new-nft',
    signedTransaction: 'open-base64',
    blockhash: 'blockhash',
    lastValidBlockHeight: 123,
  },
}

function services(overrides: Partial<RaydiumRebalanceServices> = {}): RaydiumRebalanceServices {
  return {
    readFundingBaseline: async () => baseline,
    submitClose: async () => ({ signature: 'close-sig', amountA: 0n, amountB: 1_000n }),
    measureFunding: async () => ({ amountA: 0n, amountB: 1_000n }),
    prepareRebalance: async () => ({ plan: atomicPlan }),
    submitSigned: async () => ({ signature: 'open-sig' }),
    positionExists: async () => true,
    notify: () => undefined,
    ...overrides,
  }
}

function seedIntent(intent: Partial<RaydiumRebalanceIntent> & Pick<RaydiumRebalanceIntent, 'owner'>): void {
  const now = Date.now()
  setSyncValue(`raydium_rebalance:${intent.owner}`, JSON.stringify({
    version: 2,
    owner: intent.owner,
    leaseId: null,
    oldNftMint: 'old-nft',
    poolId: 'pool-1',
    pairLabel: 'A/B',
    direction: 'up',
    stage: 'close_requested',
    baseline: storedBaseline,
    amountA: null,
    amountB: null,
    plan: null,
    closeSignature: null,
    swapSignature: null,
    openSignature: null,
    closeSubmittedAt: null,
    attempts: 0,
    nextRetryAt: 0,
    lastError: null,
    lastNotifyKey: null,
    lastNotifyAt: null,
    createdAt: now,
    updatedAt: now,
    ...intent,
  }))
}

test('closes, plans, and submits an in-range atomic rebalance', async () => {
  await database(async () => {
    let closeCalls = 0
    let prepareCalls = 0
    let submitCalls = 0
    const started = await startRaydiumRebalance({
      owner: 'owner-1',
      nftMint: 'old-nft',
      poolId: 'pool-1',
      pairLabel: 'A/B',
      direction: 'up',
    }, services({
      positionExists: async nftMint => nftMint === 'old-nft',
      submitClose: async params => {
        closeCalls++
        assert.equal(params.baseline.amountB, 1_000n)
        return { signature: 'close-sig', amountA: 0n, amountB: 1_000n }
      },
      prepareRebalance: async params => {
        prepareCalls++
        assert.equal(params.amountA, 0n)
        assert.equal(params.amountB, 1_000n)
        return { plan: atomicPlan }
      },
      submitSigned: async (plan, transaction) => {
        submitCalls++
        assert.equal(plan.nftMint, 'new-nft')
        assert.equal(transaction, 'atomic-base64')
        return { signature: 'open-sig' }
      },
    }))

    assert.equal(started, true)
    assert.equal(closeCalls, 1)
    assert.equal(prepareCalls, 1)
    assert.equal(submitCalls, 1)
    assert.equal(getRaydiumIntent('owner-1'), null)
    assert.equal(listRaydiumIntents().length, 0)
    assert.equal(getWalletOperation('owner-1'), null)
    const state = getRaydiumPositionState('new-nft')
    assert.ok((state?.cooldownUntil ?? 0) > Date.now())
  })
})

test('verifies an already-landed atomic position without resubmitting', async () => {
  await database(async () => {
    seedIntent({
      owner: 'owner-2',
      stage: 'open_pending',
      amountA: '0',
      amountB: '1000',
      plan: atomicPlan,
    })
    let submitCalls = 0
    await reconcilePendingRaydiumRebalances('owner-2', services({
      submitSigned: async () => {
        submitCalls++
        return { signature: 'unused' }
      },
    }))
    assert.equal(submitCalls, 0)
    assert.equal(getRaydiumIntent('owner-2'), null)
    assert.ok((getRaydiumPositionState('new-nft')?.cooldownUntil ?? 0) > Date.now())
  })
})

test('split fallback submits the swap first and the open on the next pass', async () => {
  await database(async () => {
    const signatures: string[] = []
    const service = services({
      positionExists: async nftMint => nftMint === 'old-nft',
      prepareRebalance: async () => ({ plan: splitPlan }),
      submitSigned: async (plan, transaction) => {
        signatures.push(transaction)
        return { signature: transaction === 'swap-base64' ? 'swap-sig' : 'open-sig' }
      },
    })
    await startRaydiumRebalance({ owner: 'owner-3', nftMint: 'old-nft', poolId: 'pool-1', pairLabel: 'A/B', direction: 'down' }, service)
    const pending = getRaydiumIntent('owner-3')
    assert.equal(pending?.stage, 'swap_pending')
    assert.equal(pending?.swapSignature, 'swap-sig')
    assert.deepEqual(signatures, ['swap-base64'])

    saveRaydiumIntent({ ...(pending as RaydiumRebalanceIntent), nextRetryAt: 0 })
    await reconcilePendingRaydiumRebalances('owner-3', service)
    assert.deepEqual(signatures, ['swap-base64', 'open-base64'])
    assert.equal(getRaydiumIntent('owner-3'), null)
    assert.ok((getRaydiumPositionState('new-nft')?.cooldownUntil ?? 0) > Date.now())
  })
})

test('aborts the cycle when the direct route is materially worse than Jupiter', async () => {
  await database(async () => {
    const notifications: string[] = []
    await startRaydiumRebalance({ owner: 'owner-4', nftMint: 'old-nft', poolId: 'pool-1', pairLabel: 'A/B', direction: 'up' }, services({
      positionExists: async nftMint => nftMint === 'old-nft',
      prepareRebalance: async () => { throw new RaydiumSwapRouteWorseError(2.5) },
      notify: message => notifications.push(message),
    }))
    assert.equal(getRaydiumIntent('owner-4'), null)
    assert.equal(getWalletOperation('owner-4'), null)
    assert.ok(notifications.some(message => message.includes('Dibatalkan')))
  })
})

test('waits for the close proceeds before planning', async () => {
  await database(async () => {
    let prepareCalls = 0
    const service = services({
      positionExists: async nftMint => nftMint === 'old-nft',
      submitClose: async () => ({ signature: 'close-sig', amountA: 0n, amountB: 0n }),
      prepareRebalance: async () => {
        prepareCalls++
        return { plan: atomicPlan }
      },
    })
    await startRaydiumRebalance({ owner: 'owner-5', nftMint: 'old-nft', poolId: 'pool-1', pairLabel: 'A/B', direction: 'up' }, service)
    const pending = getRaydiumIntent('owner-5')
    assert.equal(pending?.stage, 'close_submitted')
    assert.equal(prepareCalls, 0)

    saveRaydiumIntent({ ...(pending as RaydiumRebalanceIntent), nextRetryAt: 0 })
    await reconcilePendingRaydiumRebalances('owner-5', service)
    assert.equal(prepareCalls, 1)
    assert.equal(getRaydiumIntent('owner-5'), null)
  })
})

test('keeps a durable intent and refuses a second start while retrying', async () => {
  await database(async () => {
    let closeCalls = 0
    const retrying = services({
      positionExists: async nftMint => nftMint === 'old-nft',
      submitClose: async () => {
        closeCalls++
        throw new Error('RPC timeout')
      },
    })
    const trigger = { owner: 'owner-6', nftMint: 'old-nft', poolId: 'pool-1', pairLabel: 'A/B', direction: 'up' as const }
    assert.equal(await startRaydiumRebalance(trigger, retrying), true)
    const intent = getRaydiumIntent('owner-6')
    assert.equal(intent?.stage, 'close_requested')
    assert.equal(intent?.attempts, 1)
    assert.ok((intent?.nextRetryAt ?? 0) > Date.now())
    assert.equal(closeCalls, 1)

    assert.equal(await startRaydiumRebalance(trigger, retrying), false)
    await reconcilePendingRaydiumRebalances('owner-6', retrying)
    assert.equal(closeCalls, 1)
    assert.equal(getRaydiumIntent('owner-6')?.attempts, 1)
  })
})
