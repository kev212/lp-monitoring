import type TelegramBot from 'node-telegram-bot-api'
import { scanRaydiumPools, type RaydiumPoolScanResult } from '../raydium/poolScanner.js'

type Scan = typeof scanRaydiumPools
type ScannerBot = Pick<TelegramBot, 'onText' | 'sendMessage' | 'editMessageText'>

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const usd = (value: number): string => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function formatRaydiumPoolScan(result: RaydiumPoolScanResult): string[] {
  const stats = result.stats
  const blocks = [
        `<b>Raydium CLMM — Top ${result.pools.length} yield/jam</b>\n`
        + `Filter: TVL ≥ US$5.000 · volume aktual 1h ≥ US$20.000\n`
        + `${result.partial ? '<b>Scan parsial</b>' : 'Scan selesai'} · ${stats.checked}/${stats.shortlisted} kandidat shortlist diperiksa\n`
        + `Pool ditemukan: ${stats.discovered} · eligible ${stats.eligible} · shortlist ${stats.shortlisted} (dilewati ${stats.prefilterSkipped})\n`
        + `Dilewati: volume rendah ${stats.belowVolume}, dynamic fee ${stats.dynamicFee}, data tidak valid ${stats.invalid} · gagal ${stats.failed}\n`
    + `Pengambilan: ${new Date(result.startedAt).toISOString()} – ${new Date(result.completedAt).toISOString()}\n`
    + `Sumber: Raydium (TVL/config), DEX Screener (volume 1h)`,
  ]
  for (const [index, pool] of result.pools.entries()) {
    const pair = `${escapeHtml(pool.symbolA.slice(0, 48))}/${escapeHtml(pool.symbolB.slice(0, 48))}`
    blocks.push(
      `<b>${index + 1}. ${pair}</b> · <b>${pool.estimatedYieldPctPerHour.toFixed(4)}%/jam est.</b>\n`
      + `TVL: ${usd(pool.tvlUsd)}\n`
      + `Volume aktual 1h: ${usd(pool.volume1hUsd)}\n`
      + `Fee LP estimasi 1h: ${usd(pool.estimatedLpFees1hUsd)}\n`
      + `<code>${escapeHtml(pool.poolId)}</code>\n`
      + `<a href="https://dexscreener.com/solana/${encodeURIComponent(pool.poolId)}">Lihat pool</a>`,
    )
  }
  if (result.pools.length === 0) blocks.push('Tidak ada pool yang memenuhi kedua filter dengan data valid dalam cakupan scan ini.')
  blocks.push('Fee LP est. = volume 1h × tarif fee × porsi LP. Yield est. = fee LP / TVL × 100%.\n'
    + 'Yield tingkat pool, bukan hasil posisi CLMM dengan range tertentu. Dynamic fee dikecualikan. Cache maksimal 60 detik; data indexer dapat terlambat.')
  const messages: string[] = []
  let current = ''
  for (const block of blocks) {
    if (current && current.length + block.length + 2 > 3800) {
      messages.push(current)
      current = ''
    }
    current += `${current ? '\n\n' : ''}${block}`
  }
  if (current) messages.push(current)
  return messages
}

export function registerRaydiumScanCommand(
  bot: ScannerBot,
  isAllowed: (chatId: number | string, userId: number | string | undefined) => boolean,
  scan: Scan = scanRaydiumPools,
): void {
  const activeChats = new Set<number>()
  bot.onText(/^\/scan_pools_ray(?:@\w+)?\s*$/, async msg => {
    if (!msg.chat || !isAllowed(msg.chat.id, msg.from?.id)) return
    const chatId = msg.chat.id
    if (activeChats.has(chatId)) return
    activeChats.add(chatId)
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const status = await bot.sendMessage(chatId, 'Memindai Raydium CLMM: TVL ≥ US$5.000 dan volume aktual ≥ US$20.000/jam…')
      let progress = 'Mengambil daftar pool…'
      let elapsedMinutes = 0
      let updating = false
      timer = setInterval(() => {
        elapsedMinutes++
        if (updating) return
        updating = true
        void bot.editMessageText(`Scan berjalan (${elapsedMinutes} menit). ${progress}`, {
          chat_id: chatId, message_id: status.message_id,
        }).catch(() => undefined).finally(() => { updating = false })
      }, 60_000)
      const result = await scan(p => {
          progress = `${p.discovered} pool ditemukan, ${p.checked}/${p.shortlisted} kandidat shortlist diperiksa.`
      })
      clearInterval(timer)
      for (const message of formatRaydiumPoolScan(result)) {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true })
      }
    } catch (error) {
      console.log(`[telegram] Raydium scan failed: ${error instanceof Error ? error.message : String(error)}`)
      await bot.sendMessage(chatId, 'Scan Raydium gagal. Coba /scan_pools_ray lagi nanti.').catch(() => undefined)
    } finally {
      if (timer) clearInterval(timer)
      activeChats.delete(chatId)
    }
  })
}
