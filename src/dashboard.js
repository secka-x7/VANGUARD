// ═══════════════════════════════════════════════════════════════════════════
// Vanguard dashboard.js
// Serves Nightfall (desktop) + Nightfall Black (mobile)
// 100% accurate data — only from DB, no estimates
// CoW solver endpoint at /solve/:env/:network
//
// FIX (websocket freeze bug): WebSocket connections were going silently dead
// behind Railway's proxy (idle connections get torn down without a close
// frame reaching the client), and buildState() failures inside the broadcast
// loop were swallowed with catch{} — so a bad tick could go unnoticed
// forever. The dashboard would render once successfully, then freeze on that
// stale snapshot with no error and no recovery.
//
// This file has two parts:
//   PART 1 (below)  — the server: src/dashboard.js
//                      Drop this in as a full replacement.
//   PART 2 (bottom) — the client patch: replace the existing connect()
//                      function inside the <script> block of BOTH
//                      src/dashboard/nightfall.html and
//                      src/dashboard/nightfall-black.html with the code
//                      in the PART 2 block below. Everything else in
//                      those HTML files (render(), fmt(), etc.) stays
//                      the same.
// ═══════════════════════════════════════════════════════════════════════════


// ─── PART 1: SERVER — src/dashboard.js ─────────────────────────────────────

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
//
// FIX (RPC-outage total-blackout bug): this used to be one big try/catch.
// The moment ANY single call touched an RPC client (getActive/getContractAddr
// via chains.js/pimlico.js) and the RPCs were unreachable — which the
// watchdog logs confirm was actually happening — the whole function threw,
// and every tick fell into the catch block returning near-empty data. DB
// reads (stats, executions, config) have nothing to do with RPC health and
// were being needlessly wiped out too. Now each section is independent:
// a dead RPC degrades ONLY the chains/executor section, everything else
// (revenue, streams, scanner, AI, executions) keeps working normally.
function safe(fn, fallback, label) {
  try { return fn() }
  catch (e) {
    console.error(`[DASHBOARD] section "${label}" failed:`, e.message)
    return fallback
  }
}

async function buildState() {
  const stats  = safe(() => getStats(), { profit: 0, today: 0, winRate: '—', total: 0 }, 'stats')
  const sv     = safe(() => getSVStats(), { sv: {}, total: 0 }, 'sv')
  const boot   = safe(() => getBootstrapStatus(), {}, 'bootstrap')
  const ai     = safe(() => getRuleAIStatus(), {}, 'ai')
  const sc     = safe(() => getScannerStats(), { gapsDetected: 0, pairs: 0, trackedPools: 0, gaps: [] }, 'scanner')
  const prices = safe(() => JSON.parse(getConfig('prices') || '{}'), {}, 'prices')

  // RPC-dependent section — this is the one the watchdog logs implicate.
  // If chains/pimlico calls fail because RPCs are down, chains just come
  // back as "unknown" instead of taking the entire dashboard down with it.
  const chains = safe(() => {
    const out = {}
    getActive().forEach(c => {
      out[c.name] = {
        status:  getContractAddr(c.name) ? 'live' : (getConfig('deploy_status_' + c.name) || 'waiting'),
        address: getContractAddr(c.name) || null,
        tier:    c.tier,
        native:  c.native
      }
    })
    return out
  }, {}, 'chains')

  const exec   = safe(() => getExecutorAddress(), null, 'executor')
  const funded = safe(() => getFunded(), [], 'funded')

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
      lp:         safe(() => getLPTotal(), 0, 'lpTotal')
    },
    sv:       { stats: sv.sv, total: sv.total },
    streams:  safe(() => getStreamStats(), {}, 'streams'),
    chains,
    liveCount,
    totalChains,
    rpcDegraded: totalChains === 0 && !exec,   // surfaced to the UI as a banner, not a blank screen
    executor: {
      address: exec,
      funded,
      create2: safe(() => getConfig('create2_address'), null, 'create2') || null
    },
    deploy:   boot,
    ai,
    scanner:  sc,
    prices,
    recentExecutions: safe(() => getExecutions(50), [], 'executions')
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
  try {
    const d = await buildState()
    res.json({ ...d, ts: Date.now() })  // FIX: needed by the client's renderGuarded() staleness check
  }
  catch (e) { res.json({ error: e.message, initializing: true, ts: Date.now() }) }
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


/* ═══════════════════════════════════════════════════════════════════════════
   PART 2: CLIENT PATCH — for nightfall.html AND nightfall-black.html
   ═══════════════════════════════════════════════════════════════════════════

   This is NOT server code — it does not belong in dashboard.js at runtime.
   It is reference code to copy into the <script> block of BOTH HTML files,
   replacing their existing `connect()` function (and the loose `_ws, _state`
   declaration above it). Everything else in those files — render(), fmt(),
   fmtT(), fmtUp(), set(), nav()/showTab(), etc. — stays exactly as-is.

   HISTORY OF WHY THIS LOOKS THE WAY IT DOES:

   v1 problem: the old client fetched /api/state exactly once, on connect,
   then relied entirely on the WebSocket for every update after that. If the
   socket goes idle-dead behind Railway's proxy (readyState stays OPEN, no
   close event ever fires), the dashboard freezes on whatever it last
   received — one good render, then nothing, forever.

   v1 fix: poll /api/state on its own independent 5s timer regardless of WS
   health, so the WebSocket becomes a "get updates faster than 5s"
   optimization instead of a single point of failure. Added a watchdog that
   detects a socket gone quiet despite claiming to be open and forces a
   reconnect.

   v2 problem: running polling AND WebSocket ticks concurrently introduced a
   NEW bug — a race condition. Two independent async responses landing in
   whatever order the network happens to deliver them means render() could
   apply an OLDER payload on top of a newer one (a slow poll response
   arriving after a fresher WS tick, for example) — this is what caused data
   to visibly flash in and out within a fraction of a second.

   v2 fix: every payload is stamped with the time it was generated on the
   server (`ts`). render() is now routed through renderGuarded(), which
   drops anything older than the last payload actually applied — regardless
   of which source it came from or when it happened to arrive.

   ---------------------------------------------------------------------------

   let _ws, _state = {}
   let _lastMsgAt = Date.now()
   let _lastRenderTs = 0          // guards against out-of-order renders
   let _pollTimer = null
   let _wsCheckTimer = null

   function connect() {
     startPolling()      // <-- always-on fallback, independent of WS health
     connectWS()
   }

   function startPolling() {
     if (_pollTimer) return
     const poll = () => fetch('/api/state')
       .then(r => r.json())
       .then(d => renderGuarded(d, d.ts || Date.now()))
       .catch(() => {})
     poll()
     _pollTimer = setInterval(poll, 5000)
   }

   function connectWS() {
     const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
     _ws = new WebSocket(`${proto}//${location.host}`)

     _ws.onopen = () => { _lastMsgAt = Date.now() }

     _ws.onmessage = e => {
       _lastMsgAt = Date.now()
       try {
         const m = JSON.parse(e.data)
         // server stamps {type, data, ts} on every broadcast — use its ts
         // (when the server actually built the state) rather than arrival
         // time, so slow-network delivery can't make an old tick look new.
         if (m.data) renderGuarded(m.data, m.ts || Date.now())
       } catch {}
     }

     _ws.onclose = () => setTimeout(connectWS, 3000)
     _ws.onerror = () => _ws.close()

     // Watchdog: if we haven't heard from the socket in 30s despite it
     // claiming to be OPEN, it's a zombie connection (proxy silently
     // dropped it). Force-close and let onclose reconnect. Polling keeps
     // the UI fresh in the meantime either way.
     if (_wsCheckTimer) clearInterval(_wsCheckTimer)
     _wsCheckTimer = setInterval(() => {
       if (_ws.readyState === 1 && Date.now() - _lastMsgAt > 30000) {
         _ws.close()
       }
     }, 10000)
   }

   // Only render if this payload is newer than the last one we actually
   // applied. Anything older — a slow poll response, a WS tick delayed
   // behind a poll, etc. — is silently dropped instead of flickering the
   // UI backward.
   function renderGuarded(d, ts) {
     if (!d) return
     if (ts && ts < _lastRenderTs) return   // stale — ignore
     _lastRenderTs = ts || Date.now()
     render(d)
   }

   --------------------------------------------------------------------------- */
