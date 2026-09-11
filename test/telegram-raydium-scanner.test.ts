import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatRaydiumPoolScan,
  registerRaydiumScanCommand,
} from '../src/telegram/raydiumScanner.js'

type ScanResult = Parameters<typeof formatRaydiumPoolScan>[0]
type Scan = Parameters<typeof registerRaydiumScanCommand>[2]

type Message = {
  chat: { id: number | string }
  from?: { id: number }
  text?: string
}

type SentMessage = {
  chatId: number | string
  text: string
  options?: Record<string, unknown>
}

type EditMessage = {
  text: string
  options: Record<string, unknown>
}

type TextHandler = (message: Message) => unknown

class FakeBot {
  readonly handlers: Array<{ pattern: RegExp; handler: TextHandler }> = []
  readonly sent: SentMessage[] = []
  readonly edits: EditMessage[] = []
  sendMessageImpl: (chatId: number | string, text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }> = async (chatId, text, options) => {
    this.sent.push({ chatId, text, options })
    return { message_id: this.sent.length }
  }

  onText(pattern: RegExp, handler: TextHandler): void {
    this.handlers.push({ pattern, handler })
  }

  async sendMessage(chatId: number | string, text: string, options?: Record<string, unknown>): Promise<{ message_id: number }> {
    return this.sendMessageImpl(chatId, text, options)
  }

  async editMessageText(text: string, options: Record<string, unknown>): Promise<void> {
    this.edits.push({ text, options })
  }

  trigger(text: string, chatId = 100, userId = 200): Promise<unknown> | undefined {
    const registration = this.handlers.find(({ pattern }) => pattern.test(text))
    if (!registration) return undefined
    return Promise.resolve(registration.handler({
      chat: { id: chatId },
      from: { id: userId },
      text,
    }))
  }
}

function pool(overrides: Partial<ScanResult['pools'][number]> = {}): ScanResult['pools'][number] {
  return {
    poolId: 'Pool11111111111111111111111111111111111111111',
    symbolA: 'SOL',
    symbolB: 'USDC',
    tvlUsd: 100_000,
    volume1hUsd: 50_000,
    estimatedLpFees1hUsd: 125,
    estimatedYieldPctPerHour: 0.125,
    tradeFeeRate: 10_000,
    ...overrides,
  }
}

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    pools: [pool()],
    partial: false,
    startedAt: Date.parse('2026-09-11T00:00:00.000Z'),
    completedAt: Date.parse('2026-09-11T00:01:00.000Z'),
    stats: {
      discovered: 1,
      eligible: 1,
      checked: 1,
      failed: 0,
      belowVolume: 0,
      dynamicFee: 0,
      invalid: 0,
    },
    ...overrides,
  }
}

function register(
  bot: FakeBot,
  scan: Scan,
  allowed: (chatId: number | string, userId: number | string | undefined) => boolean = () => true,
): void {
  registerRaydiumScanCommand(bot as unknown as Parameters<typeof registerRaydiumScanCommand>[0], allowed, scan)
}

test('requires authorization before starting a scan', async () => {
  const bot = new FakeBot()
  let calls = 0
  register(bot, async () => {
    calls++
    return result()
  }, (chatId, userId) => String(chatId) === '100' && String(userId ?? '') === '200')

  await bot.trigger('/scan_pools_ray', 101, 200)
  await bot.trigger('/scan_pools_ray', 100, 201)

  assert.equal(calls, 0)
  assert.equal(bot.sent.length, 0)
})

test('matches the bare command and a bot-suffixed command', async () => {
  const bot = new FakeBot()
  let calls = 0
  register(bot, async () => {
    calls++
    return result()
  })

  const bare = bot.trigger('/scan_pools_ray')
  assert.ok(bare)
  await bare
  const suffixed = bot.trigger('/scan_pools_ray@lp_monitor_bot')
  assert.ok(suffixed)
  await suffixed

  assert.equal(calls, 2)
  assert.equal(bot.sent.filter(message => message.text.startsWith('Memindai Raydium')).length, 2)
})

test('does not match near-miss commands or command arguments', () => {
  const bot = new FakeBot()
  register(bot, async () => result())

  assert.equal(bot.trigger('/scan_pools_raydium'), undefined)
  assert.equal(bot.trigger('/scan_pools_ray_extra'), undefined)
  assert.equal(bot.trigger('/scan_pools_ray extra'), undefined)
  assert.equal(bot.trigger('scan_pools_ray'), undefined)
  assert.equal(bot.handlers.length, 1)
})

test('prevents a duplicate scan in the same chat while allowing it after completion', async () => {
  const bot = new FakeBot()
  let resolveScan: ((value: ScanResult) => void) | undefined
  let calls = 0
  const pending = new Promise<ScanResult>(resolve => { resolveScan = resolve })
  register(bot, async () => {
    calls++
    if (calls === 1) return pending
    return result()
  })

  const first = bot.trigger('/scan_pools_ray')
  const duplicate = bot.trigger('/scan_pools_ray')
  assert.ok(first)
  assert.ok(duplicate)
  resolveScan?.(result())
  await first
  await duplicate

  assert.equal(calls, 1)
  assert.equal(bot.sent.filter(message => message.text.startsWith('Memindai Raydium')).length, 1)

  const afterCompletion = bot.trigger('/scan_pools_ray')
  assert.ok(afterCompletion)
  await afterCompletion
  assert.equal(calls, 2)
})

test('cleans up after a scan failure so a later scan can run', async () => {
  const bot = new FakeBot()
  let calls = 0
  register(bot, async () => {
    calls++
    if (calls === 1) throw new Error('indexer unavailable')
    return result()
  })

  const first = bot.trigger('/scan_pools_ray')
  assert.ok(first)
  await first
  assert.ok(bot.sent.some(message => message.text === 'Scan Raydium gagal. Coba /scan_pools_ray lagi nanti.'))

  const second = bot.trigger('/scan_pools_ray')
  assert.ok(second)
  await second
  assert.equal(calls, 2)
  assert.ok(bot.sent.some(message => message.text.includes('Pool ditemukan: 1')))
})

test('escapes HTML metadata and keeps every formatted message within Telegram size budget', () => {
  const formatted = formatRaydiumPoolScan(result({
    pools: [pool({
      symbolA: '<SOL & "fast">',
      symbolB: 'USDC > LP',
      poolId: 'Pool<&>"',
    })],
  }))

  assert.ok(formatted.every(message => message.length <= 3800))
  const text = formatted.join('\n')
  assert.match(text, /&lt;SOL &amp; &quot;fast&quot;&gt;/)
  assert.match(text, /USDC &gt; LP/)
  assert.match(text, /Pool&lt;&amp;&gt;&quot;/)
  assert.doesNotMatch(text, /<SOL & "fast">/)
})

test('reports both filters and an empty partial scan', () => {
  const formatted = formatRaydiumPoolScan(result({
    pools: [],
    partial: true,
    stats: {
      discovered: 14,
      eligible: 8,
      checked: 5,
      failed: 3,
      belowVolume: 6,
      dynamicFee: 1,
      invalid: 2,
    },
  })).join('\n')

  assert.match(formatted, /TVL ≥ US\$5\.000/)
  assert.match(formatted, /volume aktual 1h ≥ US\$20\.000/)
  assert.match(formatted, /Scan parsial/)
  assert.match(formatted, /Tidak ada pool yang memenuhi kedua filter/)
  assert.match(formatted, /volume rendah 6/)
})

test('formats all ten ranked pools across any required Telegram chunks', () => {
  const pools = Array.from({ length: 10 }, (_, index) => pool({
    poolId: `Pool${String(index + 1).padStart(2, '0')}11111111111111111111111111111111111111111`,
    symbolA: `TOKEN${index + 1}`,
    estimatedYieldPctPerHour: 1 - index / 100,
  }))
  const formatted = formatRaydiumPoolScan(result({
    pools,
    stats: {
      discovered: 10,
      eligible: 10,
      checked: 10,
      failed: 0,
      belowVolume: 0,
      dynamicFee: 0,
      invalid: 0,
    },
  }))

  assert.ok(formatted.length >= 1)
  assert.ok(formatted.every(message => message.length <= 3800))
  const text = formatted.join('\n')
  for (let index = 1; index <= 10; index++) {
    assert.match(text, new RegExp(`<b>${index}\\. TOKEN${index}/USDC</b>`))
  }
  assert.match(text, /Top 10 yield\/jam/)
})
