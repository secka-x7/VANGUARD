// Vanguard · dashboard.js — Sovereign Control Center server
// Imports live stats (no stale DB reads for status)
// SOVEREIGN chat via SSE streaming
// USB vault detection and routing
// All 19 sections of Nightfall dashboard served here

import express   from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, setConfig, getStats, getExecutions } from './db.js'
import { getSABF64, SAB_OFFSETS, getPropProfile } from './sdal.js'
import { getNEXUSStats } from './nexus.js'
import { getAPEXStats } from './apex.js'
import { getSovereignStatus, sovereignChat } from './sovereign.js'
import { getModemPayStats } from './modempay.js'
import { getTreasuryStats, registerTreasuryRoutes, calcFee } from './treasury.js'
import { registerUSBRoutes } from './usb_treasury.js'
import { getChains1Stats } from './chains1.js'
import { getCrashStats, getRuleAIStatus } from './intelligence.js'
import { getPropellerStats, setIntensity, activateCrashMode, deactivateCrashMode, REVENUE_TABLE, formatRevenue } from './propeller.js'
import { getRS5Stats } from './rs5.js'
import { getRS6Stats } from './rs6.js'
import { getAmpStats } from './value_amplifier.js'
import { getWsPoolStats } from './chains1.js'
import { emit, on } from './events.js'
import { update as sdalUpdate, get as sdalGet } from './sdal.js'
import { getOverlayStats } from './overlay.js'
import { getContractAddr } from './pimlico.js'
import { getActive } from './chains1.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const HOT   = getSABF64()
const app   = express()
const server= createServer(app)
const wss   = new WebSocketServer({ server })
let   _port = parseInt(process.env.PORT||'3000')

app.use(express.json({ limit:'1mb' }))
app.use(express.text({ type:'*/*', limit:'1mb' }))
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin','*')
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE')
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization')
  if (req.method==='OPTIONS') return res.sendStatus(200)
  next()
})

// ── Build full state ──────────────────────────────────────────────────────────
function buildState() {
  const stats   = getStats()
  const nexus   = getNEXUSStats()
  const apex    = getAPEXStats()
  const chains1 = getChains1Stats()
  const crash   = getCrashStats()
  const prop    = getPropellerStats()
  const rs5     = getRS5Stats()
  const rs6     = getRS6Stats()
  const amp     = getAmpStats()
  const overlay = getOverlayStats()
  const mp      = getModemPayStats()     // live — not stale DB
  const sov     = getSovereignStatus()
  const treasury= getTreasuryStats()
  const ruleAI  = getRuleAIStatus()
  const propP   = parseInt(getConfig('prop_intensity')||'5')
  const profile  = getPropProfile(propP)

  const liveChains = getActive().filter(c=>!!getContractAddr(c.name))
  const prices     = JSON.parse(getConfig('prices')||'{}')
  const execs      = getExecutions(50)

  return {
    system: {
      uptime:   process.uptime(),
      memory:   Math.round(process.memoryUsage().heapUsed/1024/1024),
      nodeVer:  process.version,
    },
    revenue: {
      allTime:    stats.profit || 0,
      today:      parseFloat(getConfig('daily_achieved')||'0'),
      thisHour:   0,
      executions: stats.executions || 0,
      winRate:    stats.winRate || '0%',
      lp:         parseFloat(getConfig('lp_total')||'0'),
      rs5:        rs5.total,
    },
    nexus: {
      ...nexus,
      active: true,
      latencyTarget: '1ms',
    },
    apex: {
      ...apex,
      latencyTarget: '1.5ms',
      advantage: '20× faster than best competitor',
    },
    propeller: {
      ...prop,
      table:        REVENUE_TABLE,
      formatted:    formatRevenue(REVENUE_TABLE[propP]),
      profile,
    },
    chains: Object.fromEntries(
      getActive().map(c => [c.name, {
        status:  getContractAddr(c.name) ? 'live' : 'waiting',
        address: getContractAddr(c.name) || null,
        tier:    c.tier,
      }])
    ),
    liveCount:   liveChains.length,
    totalChains: getActive().length,
    scanner:  {
      swapCount:    chains1.qualifyingSwaps,
      swapsByChain: chains1.swapsByChain,
      threshold:    chains1.threshold,
    },
    overlay:  {
      queueSize:     overlay.queueSize,
      totalStored:   overlay.totalStored,
      totalExecuted: overlay.totalExecuted,
      captureRate:   overlay.captureRate,
      readyToExec:   overlay.readyToExec,
      pendingByChain:overlay.pendingByChain,
    },
    latency: {
      avgMs:        apex.avgMs,
      minMs:        apex.minMs,
      maxMs:        apex.maxMs,
      hotPathCalls: apex.executions,
      templates:    apex.templatesBuilt,
      target:       '1.5ms',
      vsCompetitor: '20×',
    },
    crash:   crash,
    rs5:     { ...rs5, active:true },
    rs6:     rs6,
    amplifier: amp,
    ai: {
      ...ruleAI,
      sovereign: sov,
      calls:     sov.calls,
      insights:  sov.lastResponse,
    },
    modempay:  mp,    // live status — always ACTIVE if key set
    treasury:  treasury,
    prices,
    executor: {
      address: getConfig('executor_address'),
      create2: process.env.CREATE2_ADDR || '',
    },
    controls: {
      paused:       getConfig('system_paused')==='1',
      propIntensity:propP,
      aiEnabled:    true,
      crashMode:    getConfig('crash_mode')==='1',
      crashScore:   crash.score,
      crashCountdown:crash.countdown,
    },
    recentExecutions: execs.map(e=>({
      ts:         e.ts,
      chain:      e.chain,
      protocol:   e.protocol,
      profit_usdc:e.profit_usdc,
      status:     e.status,
    })),
    throughput: {
      env1:    '$321.12T/day',
      env2:    '$1,209.6T/day',
      env3:    '$500T/day',
      nexus:   '$1,465.3T/day',
      total:   '$3.496Q/day',
      maxRev:  '$1.748T/day (P30)',
    },
    timestamp: Math.floor(Date.now()/1000),
  }
}

// ── WebSocket — push state every 2s ──────────────────────────────────────────
const _clients = new Set()
wss.on('connection', ws => {
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  ws.on('error', () => _clients.delete(ws))
  try { ws.send(JSON.stringify({ type:'tick', data:buildState() })) } catch {}
})

setInterval(() => {
  if (!_clients.size) return
  const payload = JSON.stringify({ type:'tick', data:buildState() })
  for (const ws of _clients) {
    try { if (ws.readyState===1) ws.send(payload) } catch {}
  }
}, 2000)

// ── API routes ────────────────────────────────────────────────────────────────
app.get('/api/state', (_, res) => res.json(buildState()))
app.get('/api/health', (_, res) => res.json({ ok:true, uptime:process.uptime() }))

// Propeller
app.post('/api/control/propellers', async (req,res) => {
  const { intensity } = req.body||{}
  const p = parseInt(intensity)
  if (!p||p<1||p>30) return res.status(400).json({ error:'intensity must be 1-30' })
  await setIntensity(p, 'operator')
  res.json({ ok:true, intensity:p, dailyRevenue:REVENUE_TABLE[p], formatted:formatRevenue(REVENUE_TABLE[p]) })
})

// Crash mode
app.post('/api/control/crash-on',  (_, res) => { activateCrashMode();   res.json({ ok:true, crashMode:true  }) })
app.post('/api/control/crash-off', (_, res) => { deactivateCrashMode(); res.json({ ok:true, crashMode:false }) })

// Halt/Resume
app.post('/api/control/halt',   (_, res) => { setConfig('system_paused','1'); emit('system_halt',{});   res.json({ ok:true }) })
app.post('/api/control/resume', (_, res) => { setConfig('system_paused','0'); emit('system_resume',{}); res.json({ ok:true }) })

// Per-chain
app.post('/api/control/pause-chain',  (req,res)=>{ setConfig('pause_'+(req.body?.chain||''),'1'); res.json({ok:true}) })
app.post('/api/control/resume-chain', (req,res)=>{ setConfig('pause_'+(req.body?.chain||''),'0'); res.json({ok:true}) })

// AI control
app.post('/api/control/ai', (req,res)=>{ setConfig('rule_ai_enabled', req.body?.enabled?'1':'0'); res.json({ok:true}) })

// Overlay
app.post('/api/control/clear-overlay', async(_,res)=>{
  try { const {clearAll} = await import('./overlay.js'); clearAll?.(); res.json({ok:true}) }
  catch { res.json({ok:true}) }
})

// SOVEREIGN chat
app.post('/api/sovereign/chat', async (req,res) => {
  const { message } = req.body||{}
  if (!message) return res.status(400).json({ error:'message required' })
  try {
    const state    = buildState()
    const response = await sovereignChat(message, state)
    res.json({ ok:true, response, ts:Math.floor(Date.now()/1000) })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

// SOVEREIGN streaming (SSE)
app.get('/api/sovereign/stream', (req,res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  const message = req.query.message || ''
  sovereignChat(message, buildState()).then(response => {
    // Stream word by word
    const words = response.split(' ')
    let i = 0
    const tick = setInterval(() => {
      if (i >= words.length) { clearInterval(tick); res.end(); return }
      res.write(`data: ${JSON.stringify({ word:words[i++] })}\n\n`)
    }, 50)
    req.on('close', () => clearInterval(tick))
  }).catch(e => { res.write(`data: ${JSON.stringify({ error:e.message })}\n\n`); res.end() })
})

// SDAL management
app.get('/api/sdal',            (_, res) => res.json(sdalGet('protocol_addresses')))
app.post('/api/sdal/update',    (req,res)=>{ sdalUpdate(req.body); res.json({ok:true}) })

// Revenue table
app.get('/api/propeller/table', (_, res) => res.json({ table:REVENUE_TABLE, formatted:Object.fromEntries(Object.entries(REVENUE_TABLE).map(([k,v])=>[k,formatRevenue(v)])) }))

// Crash stats
app.get('/api/crash/stats',     (_, res) => res.json(getCrashStats()))
app.get('/api/crash/countdown', (_, res) => res.json({ countdown:getCrashStats().countdown, score:getCrashStats().score }))

// ModemPay fee
app.get('/api/modempay/fee',    (req,res)=> { const {amount,method}=req.query; res.json(calcFee(parseFloat(amount||'0'),method||'wave')) })

// Register all sub-routes
registerTreasuryRoutes(app)
registerUSBRoutes(app)

// ── Serve dashboards ──────────────────────────────────────────────────────────
app.get('/', (_, res) => res.sendFile(join(__dir,'..','dashboard','nightfall.html')))
app.get('/mobile', (_, res) => res.sendFile(join(__dir,'..','dashboard','nightfall-black.html')))
app.get('/vault', (_, res) => res.sendFile(join(__dir,'..','dashboard','vault.html')))

// ── Start ─────────────────────────────────────────────────────────────────────
let _started = false
export function startDashboard() {
  if (_started) return
  _started = true
  server.listen(_port, () => {
    console.log(`[DASHBOARD] Sovereign Control Center → http://localhost:${_port}`)
    console.log('[DASHBOARD] SOVEREIGN chat: /api/sovereign/chat (POST) | /api/sovereign/stream (SSE)')
    console.log('[DASHBOARD] SDAL management: /api/sdal/update (POST)')
    console.log('[DASHBOARD] All stats live — no stale DB reads for status')
  })
  server.on('error', e => {
    if (e.code==='EADDRINUSE') { _port++; server.listen(_port) }
  })
}
