import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { config } from '../config.js'
import { getWalletOperation } from '../executionLock.js'
import { loadKnownPositions } from '../meteora/discovery.js'
import { executeExit } from '../meteora/exit.js'
import { executeOpenPosition, OpenSubmissionPendingError, pendingOpenExists, prepareOpenPosition } from '../meteora/open.js'
import { getPool } from '../meteora/positions.js'
import { sendNotification } from '../telegram.js'
import type { QuoteCurrency, TriggerType } from '../types.js'
import {
  canReopenAfterWin,
  classifyOpenFailure,
  decideRunnerClose,
  evaluateIngestGate,
  evaluateOpenGate,
  isPriceInRange,
  isWinTrigger,
  parseRunnerAlertPayload,
  selectSolOpenPool,
  shouldChaseEntryDrift,
  shouldCloseFollowup,
  sumDlmmTvl,
  type RunnerAlertPayload,
} from './gates.js'
import { busyRunnerStages, createRunnerCycle, deleteRunnerCycle, findCycleByPosition, listRunnerCycles, saveRunnerCycle, type RunnerCycle } from './cycle.js'
import { fetchGmgnSnapshot } from './gmgn.js'
import { discoverMintPools, entryDriftPct, readActiveBin } from './resolvePool.js'

function formatSolAmount(amount: number): string {
  return amount.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
}

export function ingestRunnerAlert(body: unknown, secretOk: boolean, owner: string): { status: number; message: string } {
  if (!config.runnerAgentEnabled) return { status: 503, message: 'runner agent disabled' }
  const parsed = parseRunnerAlertPayload(body)
  if ('error' in parsed) return { status: 400, message: parsed.error }
  const cycles = listRunnerCycles()
  const busy = busyRunnerStages(cycles)
  const gate = evaluateIngestGate({
    enabled: true,
    secretOk,
    payload: parsed,
    minMcapUsd: config.runnerMinMcapUsd,
    minHolders: config.runnerMinHolders,
    minFeeSol: config.runnerMinFeeSol,
    activeRunnerCount: busy.filter(cycle => cycle.owner === owner).length,
    maxActive: config.runnerMaxActive,
    sameMintBusy: busy.some(cycle => cycle.owner === owner && cycle.mint === parsed.mint),
  })
  if (!gate.ok) {
    if (gate.status === 202) {
      sendNotification(
        `⏭ <b>Runner Skip</b>\n\n<code>${parsed.mint}</code>\n${parsed.symbol}\nReason: <code>${gate.reason}</code>`
      )
    }
    return { status: gate.status, message: gate.reason }
  }
  const cycle = createRunnerCycle(owner, parsed.mint, parsed.symbol)
  saveRunnerCycle(cycle)
  sendNotification(
    `🚨 <b>Runner Alert</b>\n\n<b>${parsed.symbol}</b>\nMint: <code>${parsed.mint}</code>\nMcap: <b>$${Math.round(parsed.marketCapUsd).toLocaleString()}</b>\nHolders: <b>${parsed.holders}</b>\nWaiting for DLMM pool.`
  )
  return { status: 202, message: 'accepted' }
}

export async function tickRunnerAgent(connection: Connection, wallet: Keypair): Promise<void> {
  if (!config.runnerAgentEnabled) return
  const owner = wallet.publicKey.toBase58()
  for (const cycle of listRunnerCycles().filter(item => item.owner === owner)) {
    try {
      if (cycle.stage === 'waiting_pool') await advanceWaitingPool(connection, wallet, cycle)
      else if (cycle.stage === 'reopen_eval') await advanceReopen(connection, wallet, cycle)
      else if (cycle.stage === 'open_first') await monitorFirst(connection, wallet, cycle)
      else if (cycle.stage === 'open_followup') await monitorFollowup(connection, wallet, cycle)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown'
      cycle.lastError = message
      saveRunnerCycle(cycle)
      console.log(`[runner] ${cycle.symbol} tick failed: ${message}`)
    }
  }
}

export async function notifyRunnerExit(positionPubkey: string, triggerType: TriggerType): Promise<void> {
  const cycle = findCycleByPosition(positionPubkey)
  if (!cycle) return
  if (isWinTrigger(triggerType)) cycle.winCount += 1
  const decision = decideRunnerClose(triggerType, cycle.winCount, config.runnerMaxWins)
  if (decision === 'chase_first') {
    cycle.stage = 'open_first'
    cycle.positionPubkey = null
    saveRunnerCycle(cycle)
    sendNotification(`🔁 <b>Runner Chase</b>\n\n<b>${cycle.symbol}</b>\nChase ${cycle.firstChaseCount}/${config.runnerFirstChaseMax} — opening again as first position.`)
    return
  }
  if (decision === 'reopen_eval') {
    cycle.stage = 'reopen_eval'
    cycle.positionPubkey = null
    saveRunnerCycle(cycle)
    sendNotification(`✅ <b>Runner Win ${cycle.winCount}/${config.runnerMaxWins}</b>\n\n<b>${cycle.symbol}</b>\nTrigger: <code>${triggerType}</code>`)
    return
  }
  finishCycle(cycle, `closed (${triggerType})`)
}

async function advanceWaitingPool(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  const waited = Date.now() - (cycle.waitingSince || cycle.createdAt)
  if (waited >= config.runnerPoolWaitMs) {
    finishCycle(cycle, 'pool wait timeout')
    return
  }
  const pools = await refreshPools(connection, cycle)
  if (pools.length === 0) return
  if (!selectSolOpenPool(pools)) {
    finishCycle(cycle, 'no SOL DLMM pool')
    return
  }
  await openForCycle(connection, wallet, cycle, 'first')
}

async function advanceReopen(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  await openForCycle(connection, wallet, cycle, 'followup')
}

async function monitorFirst(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  if (!cycle.positionPubkey) {
    await openForCycle(connection, wallet, cycle, 'first')
    return
  }
  const position = loadKnownPositions().find(row => row.positionPubkey === cycle.positionPubkey)
  if (!position) return
  if (position.status === 'closed' || position.status === 'error') {
    finishCycle(cycle, `position ${position.status}`)
    return
  }
  const activeBinId = await readActiveBin(connection, position.poolPubkey)
  const bins = await readPositionBins(connection, position.poolPubkey, position.positionPubkey)
  if (bins && activeBinId !== null && isPriceInRange(activeBinId, bins.lowerBinId, bins.upperBinId)) {
    if (!cycle.firstEverInRange) {
      cycle.firstEverInRange = true
      saveRunnerCycle(cycle)
    }
    return
  }
  if (!bins || activeBinId === null) return
  const drift = await entryDriftPct(connection, position.poolPubkey, bins.upperBinId)
  if (drift === null || !shouldChaseEntryDrift({
    cycleStage: 'open_first',
    firstChaseCount: cycle.firstChaseCount,
    firstEverInRange: cycle.firstEverInRange,
    maxChase: config.runnerFirstChaseMax,
    driftPct: drift,
    threshold: config.runnerEntryDriftPct,
  })) return
  await chaseFirst(connection, wallet, cycle, position)
}

async function monitorFollowup(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  if (Date.now() - cycle.lastFollowupAt < config.runnerFollowupPollMs) return
  cycle.lastFollowupAt = Date.now()
  saveRunnerCycle(cycle)
  if (!cycle.positionPubkey) {
    await openForCycle(connection, wallet, cycle, 'followup')
    return
  }
  const position = loadKnownPositions().find(row => row.positionPubkey === cycle.positionPubkey)
  if (!position) return
  if (position.status === 'closed' || position.status === 'error') {
    finishCycle(cycle, `position ${position.status}`)
    return
  }
  const pools = await refreshPools(connection, cycle, false)
  const snapshot = await fetchGmgnSnapshot(cycle.mint)
  cycle.lastTvlUsd = sumDlmmTvl(pools)
  cycle.lastVol5mUsd = snapshot?.volume5mUsd ?? null
  saveRunnerCycle(cycle)
  const pnl = position.lastPnlPercent
  if (pnl === null) return
  if (shouldCloseFollowup({
    totalTvlUsd: cycle.lastTvlUsd,
    vol5mUsd: cycle.lastVol5mUsd,
    pnlPercent: pnl,
    maxDlmmTvlUsd: config.runnerMaxDlmmTvlUsd,
    exitMinVol5mUsd: config.runnerExitMinVol5mUsd,
  })) {
    const result = await executeExit(
      connection,
      wallet,
      position.positionPubkey,
      position.poolPubkey,
      position.tokenXMint,
      position.tokenYMint,
      'RUNNER_CYCLE',
      pnl,
      position.quoteCurrency,
      position.basisQuote,
      position.lastEstimatedExitQuote || 0,
    )
    if (result.success) finishCycle(cycle, 'tvl/vol stop')
  }
}

async function chaseFirst(
  connection: Connection,
  wallet: Keypair,
  cycle: RunnerCycle,
  position: { positionPubkey: string; poolPubkey: string; tokenXMint: string; tokenYMint: string; quoteCurrency: QuoteCurrency; basisQuote: number; lastPnlPercent: number | null; lastEstimatedExitQuote: number | null },
): Promise<void> {
  const live = await liveOpenGate(connection, cycle)
  if (!live.ok) {
    sendNotification(`⏸ <b>Runner Chase Cancelled</b>\n\n<b>${cycle.symbol}</b>\nReason: <code>${live.reason}</code>\nHolding until price re-enters range.`)
    return
  }
  const owner = wallet.publicKey.toBase58()
  if (getWalletOperation(owner) || pendingOpenExists(owner)) return
  const result = await executeExit(
    connection,
    wallet,
    position.positionPubkey,
    position.poolPubkey,
    position.tokenXMint,
    position.tokenYMint,
    'RUNNER_ENTRY_DRIFT',
    position.lastPnlPercent || 0,
    position.quoteCurrency,
    position.basisQuote,
    position.lastEstimatedExitQuote || 0,
    true,
  )
  if (!result.success) return
  cycle.firstChaseCount += 1
  cycle.positionPubkey = null
  saveRunnerCycle(cycle)
  sendNotification(`🔁 <b>Runner Entry Drift</b>\n\n<b>${cycle.symbol}</b>\nPrice > ${config.runnerEntryDriftPct * 100}% above upper.\nChase ${cycle.firstChaseCount}/${config.runnerFirstChaseMax}. Close without swap.`)
}

async function openForCycle(connection: Connection, wallet: Keypair, cycle: RunnerCycle, kind: 'first' | 'followup'): Promise<void> {
  const owner = wallet.publicKey.toBase58()
  if (getWalletOperation(owner) || pendingOpenExists(owner)) return
  const live = await liveOpenGate(connection, cycle)
  if (!live.ok) {
    if (kind === 'followup') finishCycle(cycle, live.reason)
    else if (cycle.stage === 'waiting_pool' || !cycle.positionPubkey) finishCycle(cycle, live.reason)
    else sendNotification(`⏸ <b>Runner Open Gate</b>\n\n<b>${cycle.symbol}</b>\nReason: <code>${live.reason}</code>`)
    return
  }
  if (kind === 'followup') {
    const reopen = canReopenAfterWin({
      winCount: cycle.winCount,
      maxWins: config.runnerMaxWins,
      vol5mUsd: cycle.lastVol5mUsd,
      minVol5mUsd: config.runnerReopenMinVol5mUsd,
      openGate: live,
    })
    if (!reopen.ok) {
      finishCycle(cycle, reopen.reason)
      return
    }
  }
  const pool = selectSolOpenPool(await refreshPools(connection, cycle, false))
  if (!pool) {
    if (kind === 'first' && cycle.stage === 'waiting_pool') return
    finishCycle(cycle, 'no SOL DLMM pool')
    return
  }
  try {
    const preview = await prepareOpenPosition(
      connection,
      wallet.publicKey,
      pool.poolPubkey,
      formatSolAmount(config.runnerOpenAmountSol),
      config.runnerRangePercent,
      config.runnerStrategy,
    )
    const result = await executeOpenPosition(connection, wallet, preview)
    cycle.poolPubkey = pool.poolPubkey
    cycle.positionPubkey = result.positionPubkey
    cycle.stage = kind === 'followup' ? 'open_followup' : 'open_first'
    cycle.waitingSince = null
    cycle.lastError = null
    saveRunnerCycle(cycle)
    sendNotification(
      `✅ <b>Runner Open ${kind === 'first' ? 'First' : 'Follow-up'}</b>\n\n` +
      `<b>${cycle.symbol}</b>\n` +
      `Position: <code>${result.positionPubkey}</code>\n` +
      `Pool: <code>${pool.poolPubkey}</code>\n` +
      `Range: <b>${result.preview.minBinId}-${result.preview.maxBinId}</b>\n` +
      `Size: <b>${config.runnerOpenAmountSol} SOL</b>\n` +
      `Open: <a href="https://solscan.io/tx/${result.signature}">tx</a>`
    )
  } catch (err) {
    if (err instanceof OpenSubmissionPendingError) {
      cycle.positionPubkey = err.positionPubkey
      cycle.stage = kind === 'followup' ? 'open_followup' : 'open_first'
      cycle.lastError = err.message
      saveRunnerCycle(cycle)
      sendNotification(`⏳ <b>Runner Open Pending</b>\n\n<b>${cycle.symbol}</b>\nPosition: <code>${err.positionPubkey}</code>`)
      return
    }
    const classified = classifyOpenFailure(err, cycle.firstOpenRetryCount, config.runnerFirstOpenRetryMax)
    const message = err instanceof Error ? err.message : 'unknown'
    cycle.lastError = message
    if (classified === 'terminal' || classified === 'give_up') {
      finishCycle(cycle, message)
      return
    }
    cycle.firstOpenRetryCount += 1
    saveRunnerCycle(cycle)
    sendNotification(`⚠️ <b>Runner Open Retry ${cycle.firstOpenRetryCount}/${config.runnerFirstOpenRetryMax}</b>\n\n<b>${cycle.symbol}</b>\nReason: <code>${message}</code>`)
  }
}

async function liveOpenGate(connection: Connection, cycle: RunnerCycle): Promise<{ ok: true } | { ok: false; reason: string }> {
  const snapshot = await fetchGmgnSnapshot(cycle.mint)
  const pools = await refreshPools(connection, cycle, false)
  cycle.lastTvlUsd = sumDlmmTvl(pools)
  cycle.lastVol5mUsd = snapshot?.volume5mUsd ?? cycle.lastVol5mUsd
  saveRunnerCycle(cycle)
  return evaluateOpenGate({
    marketCapUsd: snapshot?.marketCapUsd ?? null,
    athMarketCapUsd: snapshot?.athMarketCapUsd ?? null,
    totalTvlUsd: cycle.lastTvlUsd,
    minMcapUsd: config.runnerMinMcapUsd,
    maxAthDrop: config.runnerMaxAthDrop,
    maxDlmmTvlUsd: config.runnerMaxDlmmTvlUsd,
  })
}

async function refreshPools(connection: Connection, cycle: RunnerCycle, force = false): Promise<import('./gates.js').DiscoveredDlmmPool[]> {
  const now = Date.now()
  const shouldGpa = force || now - cycle.lastGpaAt >= config.runnerGpaRefreshMs || cycle.knownPoolPubkeys.length === 0
  const pools = await discoverMintPools(connection, cycle.mint, cycle.knownPoolPubkeys, shouldGpa)
  cycle.knownPoolPubkeys = [...new Set(pools.map(pool => pool.poolPubkey))]
  if (shouldGpa) cycle.lastGpaAt = now
  cycle.lastTvlUsd = sumDlmmTvl(pools)
  saveRunnerCycle(cycle)
  return pools
}

async function readPositionBins(connection: Connection, poolPubkey: string, positionPubkey: string): Promise<{ lowerBinId: number; upperBinId: number } | null> {
  try {
    const pool = await getPool(connection, new PublicKey(poolPubkey))
    const position = await pool.getPosition(new PublicKey(positionPubkey))
    return {
      lowerBinId: position.positionData.lowerBinId,
      upperBinId: position.positionData.upperBinId,
    }
  } catch {
    return null
  }
}

function finishCycle(cycle: RunnerCycle, reason: string): void {
  deleteRunnerCycle(cycle.owner, cycle.mint)
  sendNotification(`🛑 <b>Runner Cycle Done</b>\n\n<b>${cycle.symbol}</b>\nMint: <code>${cycle.mint}</code>\nWins: <b>${cycle.winCount}/${config.runnerMaxWins}</b>\nReason: <code>${reason}</code>`)
  console.log(`[runner] ${cycle.symbol} cycle done: ${reason}`)
}

export function runnerHasWork(): boolean {
  return busyRunnerStages(listRunnerCycles()).length > 0
}
