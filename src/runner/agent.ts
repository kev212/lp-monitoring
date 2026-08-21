import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { config } from '../config.js'
import { getWalletOperation } from '../executionLock.js'
import { loadKnownPositions } from '../meteora/discovery.js'
import { executeExit } from '../meteora/exit.js'
import { executeOpenPosition, getRunnerOpenRecovery, OpenSubmissionPendingError, pendingOpenExists, prepareOpenPosition } from '../meteora/open.js'
import { getFreshPool } from '../meteora/positions.js'
import { sendNotification } from '../telegram.js'
import type { QuoteCurrency, TriggerType } from '../types.js'
import {
  canReopenAfterWin,
  classifyOpenFailure,
  decideRunnerClose,
  evaluateIngestGate,
  evaluateOpenGate,
  gmgnUnavailableGate,
  isDuplicateAlert,
  isPriceInRange,
  isStaleAlert,
  isWinTrigger,
  parseRunnerAlertPayload,
  selectSolOpenPool,
  shouldChaseEntryDrift,
  shouldCloseFollowup,
  sumDlmmTvl,
  tvlIncompleteGate,
} from './gates.js'
import { busyRunnerStages, createRunnerCycle, createRunnerCycleAtomically, deleteRunnerCycle, findCycleByPosition, getLastAlertedAt, listRunnerCycles, saveRunnerCycle, type RunnerCycle } from './cycle.js'
import { fetchGmgnSnapshot } from './gmgn.js'
import { discoverMintPools, entryDriftPct, readActiveBin } from './resolvePool.js'

function formatSolAmount(amount: number): string {
  return amount.toFixed(9).replace(/0+$/, '').replace(/\.$/, '')
}

export function ingestRunnerAlert(body: unknown, secretOk: boolean, owner: string): { status: number; message: string } {
  if (!config.runnerAgentEnabled) return { status: 503, message: 'runner agent disabled' }
  const parsed = parseRunnerAlertPayload(body)
  if ('error' in parsed) return { status: 400, message: parsed.error }
  try {
    new PublicKey(parsed.mint)
  } catch {
    return { status: 400, message: 'mint is not a valid Solana public key' }
  }
  if (isStaleAlert(parsed.alertedAt, Date.now())) {
    return { status: 202, message: 'stale alert' }
  }
  if (isDuplicateAlert(getLastAlertedAt(owner, parsed.mint), parsed.alertedAt)) {
    return { status: 202, message: 'duplicate alert' }
  }
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
  const eventId = parsed.eventId || `${parsed.mint}:${parsed.alertedAt}:${parsed.volumeUsd}:${parsed.marketCapUsd}:${parsed.reason}`
  const cycle = createRunnerCycle(owner, parsed.mint, parsed.symbol)
  if (!createRunnerCycleAtomically(cycle, parsed, eventId)) {
    return { status: 202, message: 'duplicate alert' }
  }
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
      if (!cycle.positionPubkey && Date.now() - (cycle.waitingSince || cycle.createdAt) >= config.runnerPoolWaitMs) {
        finishCycle(cycle, `${message}; no-position retry timeout`)
      } else {
        saveRunnerCycle(cycle)
      }
      console.log(`[runner] ${cycle.symbol} tick failed: ${message}`)
    }
  }
}

export async function notifyRunnerExit(positionPubkey: string, triggerType: TriggerType): Promise<void> {
  const cycle = findCycleByPosition(positionPubkey)
  if (!cycle) return
  if (cycle.lastHandledExitPubkey === positionPubkey) return
  cycle.lastHandledExitPubkey = positionPubkey
  if (isWinTrigger(triggerType)) cycle.winCount += 1
  const decision = decideRunnerClose(triggerType, cycle.winCount, config.runnerMaxWins)
  if (decision === 'chase_first') {
    cycle.firstChaseCount += 1
    cycle.stage = 'open_first'
    cycle.positionPubkey = null
    cycle.waitingSince = Date.now()
    saveRunnerCycle(cycle)
    sendNotification(`🔁 <b>Runner Chase</b>\n\n<b>${cycle.symbol}</b>\nChase ${cycle.firstChaseCount}/${config.runnerFirstChaseMax} — opening again as first position.`)
    return
  }
  if (decision === 'reopen_eval') {
    cycle.stage = 'reopen_eval'
    cycle.positionPubkey = null
    cycle.waitingSince = Date.now()
    saveRunnerCycle(cycle)
    sendNotification(`✅ <b>Runner Win ${cycle.winCount}/${config.runnerMaxWins}</b>\n\n<b>${cycle.symbol}</b>\nTrigger: <code>${triggerType}</code>`)
    return
  }
  finishCycle(cycle, `closed (${triggerType})`)
}

async function advanceWaitingPool(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  const bound = bindCyclePosition(wallet.publicKey.toBase58(), cycle, 'first')
  if (bound !== 'open') {
    if (bound === 'closed') finishCycle(cycle, 'recovered position is closed')
    else if (bound === 'error') finishCycle(cycle, 'recovered position requires review')
    return
  }
  const waited = Date.now() - (cycle.waitingSince || cycle.createdAt)
  if (waited >= config.runnerPoolWaitMs) {
    finishCycle(cycle, 'pool wait timeout')
    return
  }
  const discovery = await refreshPools(connection, cycle)
  if (discovery.incomplete || !selectSolOpenPool(discovery.pools)) return
  await openForCycle(connection, wallet, cycle, 'first')
}

async function advanceReopen(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  const bound = bindCyclePosition(wallet.publicKey.toBase58(), cycle, 'followup')
  if (bound !== 'open') {
    if (bound === 'closed') finishCycle(cycle, 'recovered position is closed')
    else if (bound === 'error') finishCycle(cycle, 'recovered position requires review')
    return
  }
  await openForCycle(connection, wallet, cycle, 'followup')
}

async function monitorFirst(connection: Connection, wallet: Keypair, cycle: RunnerCycle): Promise<void> {
  const bound = bindCyclePosition(wallet.publicKey.toBase58(), cycle, 'first')
  if (bound === 'wait') return
  if (bound === 'missing') {
    finishCycle(cycle, 'position disappeared during open reconciliation; review wallet before reopening')
    return
  }
  if (bound === 'closed') {
    finishCycle(cycle, 'position is closed')
    return
  }
  if (bound === 'error') {
    finishCycle(cycle, 'position requires review')
    return
  }
  if (!cycle.positionPubkey) {
    await openForCycle(connection, wallet, cycle, 'first')
    return
  }
  const position = loadKnownPositions().find(row => row.positionPubkey === cycle.positionPubkey)
  if (!position) {
    finishCycle(cycle, 'position disappeared; review wallet before reopening')
    return
  }
  if (position.status === 'exiting' || position.status === 'opening') return
  if (position.status === 'closed') return
  if (position.status === 'error') {
    finishCycle(cycle, 'position error')
    return
  }
  const activeBinId = await readActiveBin(connection, position.poolPubkey)
  const bins = await readPositionBins(connection, position.poolPubkey, position.positionPubkey)
  if (bins && activeBinId !== null && isPriceInRange(activeBinId, bins.lowerBinId, bins.upperBinId)) {
    if (!cycle.firstEverInRange) {
      cycle.firstEverInRange = true
      cycle.chaseCancelNotified = false
      saveRunnerCycle(cycle)
    }
    return
  }
  if (!bins || activeBinId === null) return
  const drift = await entryDriftPct(connection, position.poolPubkey, bins.lowerBinId, bins.upperBinId)
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
  const bound = bindCyclePosition(wallet.publicKey.toBase58(), cycle, 'followup')
  if (bound === 'wait') return
  if (bound === 'missing') {
    finishCycle(cycle, 'position disappeared during open reconciliation; review wallet before reopening')
    return
  }
  if (bound === 'closed') {
    finishCycle(cycle, 'position is closed')
    return
  }
  if (bound === 'error') {
    finishCycle(cycle, 'position requires review')
    return
  }
  if (!cycle.positionPubkey) {
    await openForCycle(connection, wallet, cycle, 'followup')
    return
  }
  const position = loadKnownPositions().find(row => row.positionPubkey === cycle.positionPubkey)
  if (!position) {
    finishCycle(cycle, 'position disappeared; review wallet before reopening')
    return
  }
  if (position.status === 'exiting' || position.status === 'opening') return
  if (position.status === 'closed') return
  if (position.status === 'error') {
    finishCycle(cycle, 'position error')
    return
  }
  const discovery = await refreshPools(connection, cycle, false)
  const snapshot = await fetchGmgnSnapshot(cycle.mint)
  const liveVolume = snapshot?.volume5mUsd ?? null
  cycle.lastVol5mUsd = liveVolume
  if (!discovery.incomplete) cycle.lastTvlUsd = sumDlmmTvl(discovery.pools)
  saveRunnerCycle(cycle)
  const pnl = position.lastPnlPercent
  if (pnl === null) return
  const tvlUsd = discovery.incomplete ? null : sumDlmmTvl(discovery.pools)
  if (shouldCloseFollowup({
    totalTvlUsd: tvlUsd,
    vol5mUsd: liveVolume,
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
  if (!live.gate.ok) {
    if (live.gate.retryable) return
    if (!cycle.chaseCancelNotified) {
      cycle.chaseCancelNotified = true
      saveRunnerCycle(cycle)
      sendNotification(`⏸ <b>Runner Chase Cancelled</b>\n\n<b>${cycle.symbol}</b>\nReason: <code>${live.gate.reason}</code>\nHolding until price re-enters range.`)
    }
    return
  }
  cycle.chaseCancelNotified = false
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
  if (result.success) {
    await notifyRunnerExit(position.positionPubkey, 'RUNNER_ENTRY_DRIFT')
    return
  }
  if (result.pendingRecovery) {
    sendNotification(`⏳ <b>Runner Chase Close Pending</b>\n\n<b>${cycle.symbol}</b>\nWaiting for finality before reopening.`)
  }
}

async function openForCycle(connection: Connection, wallet: Keypair, cycle: RunnerCycle, kind: 'first' | 'followup'): Promise<void> {
  const owner = wallet.publicKey.toBase58()
  if (cycle.cycleId.startsWith('legacy:') && !cycle.positionPubkey) {
    finishCycle(cycle, 'legacy runner cycle has no durable open identity; review wallet before reopening')
    return
  }
  if (getWalletOperation(owner) || pendingOpenExists(owner)) return
  const live = await liveOpenGate(connection, cycle)
  if (!live.gate.ok) {
    if (live.gate.retryable) {
      cycle.lastError = live.gate.reason
      if (!cycle.positionPubkey && Date.now() - (cycle.waitingSince || cycle.createdAt) >= config.runnerPoolWaitMs) {
        finishCycle(cycle, `${live.gate.reason}; no-position retry timeout`)
        return
      }
      saveRunnerCycle(cycle)
      return
    }
    if (kind === 'followup') finishCycle(cycle, live.gate.reason)
    else if (cycle.stage === 'waiting_pool' || !cycle.positionPubkey) finishCycle(cycle, live.gate.reason)
    else sendNotification(`⏸ <b>Runner Open Gate</b>\n\n<b>${cycle.symbol}</b>\nReason: <code>${live.gate.reason}</code>`)
    return
  }
  if (kind === 'followup') {
    const reopen = canReopenAfterWin({
      winCount: cycle.winCount,
      maxWins: config.runnerMaxWins,
      vol5mUsd: live.volume5mUsd,
      minVol5mUsd: config.runnerReopenMinVol5mUsd,
      openGate: live.gate,
    })
    if (!reopen.ok) {
      finishCycle(cycle, reopen.reason)
      return
    }
  }
  const pool = selectSolOpenPool(live.pools)
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
    const result = await executeOpenPosition(connection, wallet, preview, false, {
      runnerCycleId: cycle.cycleId,
      runnerMint: cycle.mint,
    })
    cycle.poolPubkey = pool.poolPubkey
    cycle.positionPubkey = result.positionPubkey
    cycle.stage = kind === 'followup' ? 'open_followup' : 'open_first'
    cycle.waitingSince = null
    cycle.lastError = null
    cycle.firstOpenRetryCount = 0
    cycle.chaseCancelNotified = false
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

async function liveOpenGate(connection: Connection, cycle: RunnerCycle): Promise<{
  gate: import('./gates.js').OpenGateResult
  pools: import('./gates.js').DiscoveredDlmmPool[]
  volume5mUsd: number | null
}> {
  const snapshot = await fetchGmgnSnapshot(cycle.mint)
  const discovery = await refreshPools(connection, cycle, false)
  const volume5mUsd = snapshot?.volume5mUsd ?? null
  cycle.lastVol5mUsd = volume5mUsd
  if (!discovery.incomplete) cycle.lastTvlUsd = sumDlmmTvl(discovery.pools)
  saveRunnerCycle(cycle)
  if (!snapshot) return { gate: gmgnUnavailableGate(), pools: discovery.pools, volume5mUsd }
  if (discovery.incomplete) return { gate: tvlIncompleteGate(), pools: discovery.pools, volume5mUsd }
  return {
    gate: evaluateOpenGate({
      marketCapUsd: snapshot.marketCapUsd,
      athMarketCapUsd: snapshot.athMarketCapUsd,
      totalTvlUsd: sumDlmmTvl(discovery.pools),
      minMcapUsd: config.runnerMinMcapUsd,
      maxAthDrop: config.runnerMaxAthDrop,
      maxDlmmTvlUsd: config.runnerMaxDlmmTvlUsd,
    }),
    pools: discovery.pools,
    volume5mUsd,
  }
}

async function refreshPools(connection: Connection, cycle: RunnerCycle, force = false): Promise<import('./gates.js').PoolDiscoveryResult> {
  const now = Date.now()
  const interval = cycle.knownPoolPubkeys.length === 0 ? config.runnerPoolPollMs : config.runnerGpaRefreshMs
  const shouldGpa = force || now - cycle.lastGpaAt >= interval
  const discovery = await withRunnerTimeout(
    discoverMintPools(connection, cycle.mint, cycle.knownPoolPubkeys, shouldGpa),
    15_000,
    'pool discovery timeout',
  )
  cycle.knownPoolPubkeys = discovery.knownAddresses
  if (shouldGpa) cycle.lastGpaAt = now
  if (!discovery.incomplete) cycle.lastTvlUsd = sumDlmmTvl(discovery.pools)
  saveRunnerCycle(cycle)
  return discovery
}

function bindCyclePosition(owner: string, cycle: RunnerCycle, kind: 'first' | 'followup'): 'ready' | 'wait' | 'missing' | 'closed' | 'error' | 'open' {
  if (!cycle.positionPubkey) {
    const recovery = getRunnerOpenRecovery(owner, cycle.cycleId, cycle.mint)
    if (recovery) {
      cycle.positionPubkey = recovery.positionPubkey
      cycle.poolPubkey = recovery.poolPubkey
      cycle.stage = kind === 'followup' ? 'open_followup' : 'open_first'
      saveRunnerCycle(cycle)
      if (recovery.status === 'closed') return 'closed'
      if (recovery.status === 'error') return 'error'
      return recovery.status === 'monitoring' ? 'ready' : 'wait'
    }
    return 'open'
  }
  const position = loadKnownPositions().find(row => row.positionPubkey === cycle.positionPubkey)
  if (!position) return 'missing'
  if (position.owner !== owner || (position.tokenXMint !== cycle.mint && position.tokenYMint !== cycle.mint)) return 'error'
  if (position.status === 'opening' || position.status === 'exiting') return 'wait'
  if (position.status === 'closed') return 'closed'
  if (position.status === 'error') return 'error'
  return 'ready'
}

async function readPositionBins(connection: Connection, poolPubkey: string, positionPubkey: string): Promise<{ lowerBinId: number; upperBinId: number } | null> {
  try {
    const pool = await getFreshPool(connection, new PublicKey(poolPubkey))
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
  deleteRunnerCycle(cycle.owner, cycle.mint, cycle.cycleId)
  sendNotification(`🛑 <b>Runner Cycle Done</b>\n\n<b>${cycle.symbol}</b>\nMint: <code>${cycle.mint}</code>\nWins: <b>${cycle.winCount}/${config.runnerMaxWins}</b>\nReason: <code>${reason}</code>`)
  console.log(`[runner] ${cycle.symbol} cycle done: ${reason}`)
}

export function runnerHasWork(): boolean {
  return busyRunnerStages(listRunnerCycles()).length > 0
}

async function withRunnerTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
