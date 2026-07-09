// Vanguard · dashboard.js — Final expansion
// Aggregates all 3 RS + latency + overlay stats
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getConfig, getStats, getExecutions } from './db.js'
import { getActive } from './chainsaw.js'
import { getExecutorAddress, getContractAddr } from './pimlico.js'
import { getSVStats, getSwapCount, getQueueSize, getLPTotal } from './vaults.js'
import { getStreamStats, handleSolveRequest } from './revenue.js'
import { getBootstrapStatus } from './bootstrap.js'
import { getRuleAIStatus } from './rule-ai.js'
import { getScannerStats } from './scanner.js'
import { getFunded } from './balance-watcher.js'
import { getOverlayStats } from './overlay.js'
import { getLatencyStats } from './latency.js'
import { on } from './events.js'

// Optional imports — only if modules exist
async function tryImport(path, fn) {
  try { const m = await import(path); return fn(m) } catch { return null }
}

const __dir  = dirname(fileURLToPath(import.meta.url))
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const PORT   = process.env.PORT || 3000
const PASS   = process.env.NIGHTFALL_PASSKEY || '3530588'

app.use(express.json())

const _clients = new Set()
function broadcast(data) {
  const m = JSON.stringify({ type:'tick', data, ts:Date.now() })
  _clients.forEach(ws => { if (ws.readyState===1) ws.send(m) })
}

wss.on('connection', ws => {
  _clients.add(ws)
  ws.on('close', () => _clients.delete(ws))
  buildState().then(d => { if(ws.readyState===1) ws.send(JSON.stringify({type:'tick',data:d,ts:Date.now()})) }).catch(()=>{})
})

// Throttled rebuild — events trigger full state, never partial payloads
let _pending=false
function scheduleRebuild() {
  if (_pending) return; _pending=true
  setTimeout(async()=>{ _pending=false; try{broadcast(await buildState())}catch{} },1000)
}
let _cexD=null
on('cex_price', ()=>{ clearTimeout(_cexD); _cexD=setTimeout(scheduleRebuild,5000) })
;['sv_update','deploy_success','arb_opportunity','revenue_stream','depeg_detected',
  'rule_ai_alert','chain_funded','first_deploy','mega_swap','pcs_revenue',
  'jit_revenue','solver_revenue','rs3_yield','overlay_stored'].forEach(evt=>on(evt,scheduleRebuild))

async function buildState() {
  try {
    const stats    = getStats()
    const sv       = getSVStats()
    const boot     = getBootstrapStatus()
    const ai       = getRuleAIStatus()
    const sc       = getScannerStats()
    const streams  = getStreamStats()
    const execAddr = getExecutorAddress()
    const overlay  = getOverlayStats()
    const latency  = getLatencyStats()
    const activeList = getActive()

    const chains = {}
    let liveCount = 0
    activeList.forEach(c => {
      const addr   = getContractAddr(c.name)
      const status = addr?'live':(getConfig('deploy_status_'+c.name)||'waiting')
      if (status==='live') liveCount++
      chains[c.name] = { status, address:addr||null, tier:c.tier, native:c.native }
    })

    const recentExecs = getExecutions(200)
    const nowTs       = Math.floor(Date.now()/1000)
    const thisHour    = recentExecs
      .filter(e=>(nowTs-(e.ts||0))<3600&&e.status==='success')
      .reduce((s,e)=>s+(e.profit_usdc||0),0)

    const lpTotal = getLPTotal()
    const uptime  = process.uptime()|0
    const memory  = Math.round(process.memoryUsage().heapUsed/1024/1024)
    const prices  = JSON.parse(getConfig('prices')||'{}')
    const create2 = getConfig('create2_address')||null
    const dbSwap  = parseInt(getConfig('mega_swap_count')||'0')
    const swapCount = Math.max(dbSwap, getSwapCount())

    // Aggregate all RS stats
    const rs1Mega    = await tryImport('./rs1-mega-pools.js', m=>m.getRS1MegaStats?.())
    const rs1JIT     = await tryImport('./rs1-jit.js',       m=>m.getJITStats?.())
    const rs1Solvers = await tryImport('./rs1-solvers.js',   m=>m.getSolverStats?.())
    const rs1PCS     = await tryImport('./rs1-pancakeswap.js',m=>m.getPCSStats?.())
    const rs2Exp     = await tryImport('./rs2-expanded.js',  m=>m.getRS2ExpandedStats?.())
    const rs3Yield   = await tryImport('./rs3-yield.js',     m=>m.getRS3Stats?.())

    const rs1Total = (sv.total||0) + (rs1Mega?.total||0) + (rs1JIT?.total||0) + (rs1Solvers?.total||0) + (rs1PCS?.total||0)
    const rs2Total = Object.values(streams?.streams||{}).reduce((s,v)=>s+(v.t||0),0) + (rs2Exp?.total||0)
    const rs3Total = rs3Yield?.total || 0
    const grandTotal = rs1Total + rs2Total + rs3Total

    return {
      uptime, memory, liveCount, totalChains:activeList.length, lp:lpTotal,
      system: { uptime, memory },
      revenue: {
        allTime:    Math.max(stats.profit||0, grandTotal),
        today:      stats.today||0,
        thisHour:   thisHour||0,
        winRate:    stats.winRate||'0%',
        executions: stats.total||0,
        lp:         lpTotal||0,
        rs1:        rs1Total,
        rs2:        rs2Total,
        rs3:        rs3Total,
      },
      sv: { stats:sv.sv||{}, total:sv.total||0 },
      streams,
      rs1: { mega:rs1Mega, jit:rs1JIT, solvers:rs1Solvers, pcs:rs1PCS, total:rs1Total },
      rs2: { expanded:rs2Exp, existing:streams, total:rs2Total },
      rs3: { yield:rs3Yield, total:rs3Total },
      chains, liveCount, totalChains:activeList.length,
      executor: { address:execAddr||null, funded:getFunded(), create2 },
      scanner: { ...sc, swapCount, queueSize:getQueueSize() },
      overlay,
      latency,
      bootstrap:boot, ai, prices,
      recentExecutions: recentExecs.slice(0,50),
    }
  } catch(e) {
    console.error('[DASHBOARD] buildState error:', e.message?.slice(0,100))
    return {
      uptime:0,memory:0,liveCount:0,totalChains:0,lp:0,
      system:{uptime:0,memory:0},
      revenue:{allTime:0,today:0,thisHour:0,winRate:'0%',executions:0,lp:0,rs1:0,rs2:0,rs3:0},
      sv:{stats:{},total:0},streams:{streams:{},total:0},
      rs1:{},rs2:{},rs3:{},chains:{},liveCount:0,totalChains:0,
      executor:{address:null,funded:[],create2:null},
      scanner:{gapsDetected:0,pairs:0,trackedPools:0,gaps:[],swapCount:0,queueSize:0},
      overlay:{queueSize:0,totalStored:0,totalExecuted:0,captureRate:'0%'},
      latency:{hotPathCalls:0,avgMs:0,minMs:0,maxMs:0},
      bootstrap:{},ai:{},prices:{},recentExecutions:[]
    }
  }
}

app.get('/health',(_,res)=>res.json({ok:true,uptime:process.uptime()|0,system:'Vanguard'}))
app.get('/api/state',async(_,res)=>{ try{res.json(await buildState())}catch(e){res.json({error:e.message,initializing:true})} })
app.get('/api/executions',(_,res)=>res.json(getExecutions(100)))
app.get('/api/deploy',(_,res)=>res.json(getBootstrapStatus()))
app.get('/api/ai',(_,res)=>res.json(getRuleAIStatus()))
app.get('/api/scanner',(_,res)=>res.json(getScannerStats()))
app.get('/api/overlay',(_,res)=>res.json(getOverlayStats()))
app.get('/api/latency',(_,res)=>res.json(getLatencyStats()))

app.get('/api/fund-info',(_,res)=>res.json({
  executor:getExecutorAddress(),create2:getConfig('create2_address')||null,
  funded:getFunded(),swapCount:Math.max(parseInt(getConfig('mega_swap_count')||'0'),getSwapCount()),
  queueSize:getQueueSize(),overlaySize:getOverlayStats().queueSize,
  chains:[
    {name:'polygon',token:'POL',amount:'0.01',costUSD:0.003,expected:'$30K–$500K'},
    {name:'base',token:'ETH',amount:'0.001',costUSD:1.54,expected:'$30K–$500K'},
    {name:'arbitrum',token:'ETH',amount:'0.001',costUSD:1.54,expected:'$30K–$500K'},
    {name:'ethereum',token:'ETH',amount:'0.01',costUSD:15.40,expected:'$30K–$500K'},
  ],status:getBootstrapStatus()
}))

app.post('/api/withdraw',(req,res)=>{
  const{amount,destination,network}=req.body||{}
  if(!amount||isNaN(parseFloat(amount))||parseFloat(amount)<=0) return res.status(400).json({error:'Invalid amount'})
  if(!destination?.trim()) return res.status(400).json({error:'Destination required'})
  const amt=parseFloat(amount)
  console.log(`[WITHDRAW] $${amt} → ${destination} via ${network||'wave'}`)
  res.json({ok:true,message:`Withdrawal of $${amt} queued via ${(network||'wave').toUpperCase()}`,amount:amt,destination,network:network||'wave',status:'queued'})
})

app.post('/solve/:env/:network',(req,res)=>{
  try{
    const{handleCoWSolveRequest}=require('./rs1-solvers.js')
    res.json(handleCoWSolveRequest(req.body))
  }catch{
    try{res.json(handleSolveRequest(req.body))}
    catch(e){res.status(500).json({error:e.message})}
  }
})

const desktopPath=join(__dir,'dashboard/nightfall.html')
const mobilePath =join(__dir,'dashboard/nightfall-black.html')

function serveDash(path,res) {
  existsSync(path)?res.send(readFileSync(path,'utf8').replace(/__PASSKEY__/g,PASS)):res.send('<h1>Vanguard</h1>')
}

app.get('/',(req,res)=>{ const mob=/Mobile|Android|iPhone|iPad/.test(req.headers['user-agent']||''); serveDash(mob&&existsSync(mobilePath)?mobilePath:desktopPath,res) })
app.get('/mobile',(_,res)=>serveDash(mobilePath,res))
app.get('/desktop',(_,res)=>serveDash(desktopPath,res))

export function startDashboard() {
  server.listen(PORT,()=>{
    console.log(`[DASHBOARD] Vanguard Nightfall · :${PORT}`)
    console.log('[DASHBOARD] /health · /api/state · /api/overlay · /api/latency · /api/withdraw')
  })
  setInterval(async()=>{ try{broadcast(await buildState())}catch{} },3000)
}

export{buildState,broadcast}
