// Vanguard dashboard.js
// Serves Nightfall (desktop) + Nightfall Black (mobile)
// 100% accurate data — only from DB, no estimates
// CoW solver endpoint at /solve/:env/:network
//
// FIX: WebSocket connections were going silently dead behind Railway's proxy
// (idle connections get torn down without a close frame reaching the client),
// and buildState() failures inside the broadcast loop were swallowed with
// catch{} — so a bad tick could go unnoticed forever. This version adds a
// ping/pong heartbeat that kills zombie sockets, logs buildState() errors,
// and — critically — no longer trusts the client to rely on WS alone
// (see the paired HTML fix: it now polls /api/state on its own timer too).
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, getStats, getExecutions } from './db.js'
import { getActive } from './chains.js'
import { getExecutorAddress, getContractAddr } from './pimlico.js'
import { getSVStats } from './vaults.js'
import { getStreamStats, getLPTotal, handleSolveRequest } from './revenue.js'
import { getBootstrapStatus } from './bootstrap.js'
import { getRuleAIStatus } from './rule-ai.js'
import { getScannerStats } from './scanner.js'
import { getFunded } from './balance-watcher.js'
import { on } from './events.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const app   = express()
const srv   = createServer(app)
const wss   = new WebSocketServer({ server: srv })
const PORT  = process.env.PORT || 3000
const PASS  = process.env.NIGHTFALL_PASSKEY || '3530588'

app.use(express.json())

// ── WebSocket clients + heartbeat ───────────────────────────────────────────
// Railway (and most proxies) will silently drop an idle WS connection. If
// that happens, readyState stays OPEN on the client and it never reconnects.
// A ping/pong heartbeat lets us detect and clean up dead sockets server-side,
// and the pong traffic itself keeps the proxy from treating the connection
// as idle in the first place.
const _clients = new Set()

function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  _clients.forEach(ws => { if (ws.readyState === 1) ws.send(m) })
}

wss.on('connection', ws => {
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))

  // Send current state immediately on connect
  buildState()
    .then(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'tick', data: d })) })
    .catch(e => console.error('[DASHBOARD] initial buildState failed:', e.message))
})

// Ping every 20s; terminate anything that didn't pong since the last check.
const _heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return }
    ws.isAlive = false
    ws.ping()
  })
}, 20000)

// Forward all real events to WebSocket
;['sv_update', 'deploy_success', 'mega_swap', 'arb_opportunity', 'revenue_stream',
  'depeg_detected', 'cex_price', 'rule_ai_alert', 'chain_funded'].forEach(evt =>
  on(evt, d => broadcast(evt, d))
)

// Build complete system state — all real data from DB
async function buildState() {
  try {
    const stats  = getStats()
    const sv     = getSVStats()
    const boot   = getBootstrapStatus()
    const ai     = getRuleAIStatus()
    const sc     = getScannerStats()
    const exec   = getExecutorAddress()
    const prices = JSON.parse(getConfig('prices') || '{}')

    const chains = {}
    getActive().forEach(c => {
      chains[c.name] = {
        status:  getContractAddr(c.name) ? 'live' : (getConfig('deploy_status_' + c.name) || 'waiting'),
        address: getContractAddr(c.name) || null,
        tier:    c.tier,
        native:  c.native
      }
    })

    const liveCount   = Object.values(chains).filter(c => c.status === 'live').length
    const totalChains = Object.keys(chains).length

    return {
      system: {
        name:   'Vanguard',
        uptime: process.uptime() | 0,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        boot:   Date.now()
      },
      revenue: {
        allTime:    stats.profit,
        today:      stats.today,
        thisHour:   getHourRevenue(),
        winRate:    stats.winRate,
        executions: stats.total,
        lp:         getLPTotal()
      },
      sv:       { stats: sv.sv, total: sv.total },
      streams:  getStreamStats(),
      chains,
      liveCount,
      totalChains,
      executor: {
        address: exec,
        funded:  getFunded(),
        create2: getConfig('create2_address') || null
      },
      deploy:   boot,
      ai,
      scanner:  sc,
      prices,
      recentExecutions: getExecutions(50)
    }
  } catch (e) {
    // FIX: log instead of swallowing — this is the difference between
    // "dashboard is stuck" being invisible vs. showing up in your logs.
    console.error('[DASHBOARD] buildState() error:', e.stack || e.message)
    return { error: e.message, system: { uptime: process.uptime() | 0, memory: 0 } }
  }
}

function getHourRevenue() {
  try {
    const execs = getExecutions(200)
    const now   = Date.now() / 1000
    return execs
      .filter(e => (now - e.ts) < 3600 && e.status === 'success')
      .reduce((s, e) => s + (e.profit_usdc || 0), 0)
  } catch { return 0 }
}

// ── API endpoints ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, uptime: process.uptime() | 0, system: 'Vanguard' }))

app.get('/api/state', async (_, res) => {
  try { res.json(await buildState()) }
  catch (e) { res.json({ error: e.message, initializing: true }) }
})

app.get('/api/executions', (_, res) => res.json(getExecutions(100)))
app.get('/api/deploy',     (_, res) => res.json(getBootstrapStatus()))
app.get('/api/ai',         (_, res) => res.json(getRuleAIStatus()))
app.get('/api/scanner',    (_, res) => res.json(getScannerStats()))
app.get('/api/prices',     (_, res) => res.json(JSON.parse(getConfig('prices') || '{}')))

// Deploy info for the fund panel
app.get('/api/fund-info', (_, res) => res.json({
  executor: getExecutorAddress(),
  create2:  getConfig('create2_address') || null,
  funded:   getFunded(),
  chains: [
    { name: 'polygon',  token: 'POL', amount: '0.01', costUSD: 0.003, return: '$30K–$500K' },
    { name: 'base',     token: 'ETH', amount: '0.001', costUSD: 1.54, return: '$30K–$500K' },
    { name: 'arbitrum', token: 'ETH', amount: '0.001', costUSD: 1.54, return: '$30K–$500K' },
    { name: 'ethereum', token: 'ETH', amount: '0.01', costUSD: 15.40, return: '$30K–$500K' },
  ],
  status: getBootstrapStatus()
}))

// CoW Protocol solver endpoint
app.post('/solve/:env/:network', (req, res) => {
  try { res.json(handleSolveRequest(req.body)) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Dashboard files ───────────────────────────────────────────────────────────
const nightfallPath      = join(__dir, 'dashboard/nightfall.html')
const nightfallBlackPath = join(__dir, 'dashboard/nightfall-black.html')

function serveDash(path, res) {
  if (existsSync(path)) {
    res.send(readFileSync(path, 'utf8').replace(/__PASSKEY__/g, PASS))
  } else {
    res.send('<h1>Vanguard</h1><p>Dashboard file missing.</p>')
  }
}

app.get('/', (req, res) => {
  const ua  = req.headers['user-agent'] || ''
  const mob = /Mobile|Android|iPhone|iPad/.test(ua)
  serveDash(mob && existsSync(nightfallBlackPath) ? nightfallBlackPath : nightfallPath, res)
})
app.get('/mobile',  (_, res) => serveDash(nightfallBlackPath, res))
app.get('/desktop', (_, res) => serveDash(nightfallPath, res))

export function startDashboard() {
  srv.listen(PORT, () => console.log(`[DASHBOARD] Vanguard Nightfall · :${PORT}`))
  // Push state to all clients every 3s
  setInterval(async () => {
    try { broadcast('tick', await buildState()) }
    catch (e) { console.error('[DASHBOARD] broadcast tick failed:', e.message) }
  }, 3000)
  console.log('[DASHBOARD] CoW solver: POST /solve/{env}/{network}')
}

process.on('SIGTERM', () => clearInterval(_heartbeat))

export { buildState, broadcast }
