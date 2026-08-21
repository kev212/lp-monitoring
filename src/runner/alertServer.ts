import http from 'node:http'
import { config } from '../config.js'
import { ingestRunnerAlert } from './agent.js'
import { getWallet } from '../solana/wallet.js'

let server: http.Server | null = null

export function startRunnerAlertServer(): void {
  if (!config.runnerAgentEnabled || server) return
  server = http.createServer((req, res) => {
    void handle(req, res)
  })
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
  let raw = ''
  try {
    raw = await readBody(req)
    const body = raw ? JSON.parse(raw) : {}
    const owner = getWallet().publicKey.toBase58()
    const result = ingestRunnerAlert(body, secretOk, owner)
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: result.status === 202, message: result.message }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : 'invalid json' }))
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
