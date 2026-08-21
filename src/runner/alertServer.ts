import http from 'node:http'
import { config } from '../config.js'
import { ingestRunnerAlert } from './agent.js'
import { getWallet } from '../solana/wallet.js'

const MAX_BODY_BYTES = 64_000
let server: http.Server | null = null

export function startRunnerAlertServer(): void {
  if (!config.runnerAgentEnabled || server) return
  server = http.createServer((req, res) => {
    void handle(req, res)
  })
  server.on('error', err => {
    console.error(`[runner] alert server failed: ${err instanceof Error ? err.message : 'unknown'}`)
    server = null
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.timeout = 15_000
  server.listen(config.runnerAlertPort, config.runnerAlertBind, () => {
    console.log(`[runner] alert server ${config.runnerAlertBind}:${config.runnerAlertPort}`)
  })
}

export function stopRunnerAlertServer(): void {
  server?.close()
  server = null
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/runner-alert') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const secretOk = (req.headers['x-runner-secret'] || '') === config.runnerAlertSecret
  if (!secretOk) {
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, message: 'invalid secret' }))
    return
  }
  try {
    const raw = await readBody(req, MAX_BODY_BYTES)
    const body = raw ? JSON.parse(raw) : {}
    const owner = getWallet().publicKey.toBase58()
    const result = ingestRunnerAlert(body, true, owner)
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: result.status === 202, message: result.message }))
  } catch (err) {
    const status = err && typeof err === 'object' && 'statusCode' in err && err.statusCode === 413 ? 413 : 400
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : 'invalid json' }))
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', chunk => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        settled = true
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', err => {
      if (!settled) reject(err)
    })
  })
}
