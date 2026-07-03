// src/dashboard.js
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
const server= createServer(app)
const wss   = new WebSocketServer({server})
const PORT  = process.env.PORT||3000
const PASS  = process.env.NIGHTFALL_PASSKEY||'3530588'

app.use(express.json())

const clients = new Set()
export function broadcast(type,data){ const m=JSON.stringify({type,data,ts:Date.now()}); clients.forEach(ws=>{if(ws.readyState===1)ws.send(m)}) }
wss.on('connection',ws=>{ clients.add(ws); ws.on('close',()=>clients.delete(ws)); buildState().then(d=>ws.send(JSON.stringify({type:'tick',data:d}))).catch(()=>{}) })

;['sv_update','deploy_success','mega_swap','arb_opportunity','revenue_stream','depeg_detected','cex_price','rule_ai_alert'].forEach(evt=>on(evt,d=>broadcast(evt,d)))

async function buildState(){
  const stats=getStats(),sv=getSVStats(),boot=getBootstrapStatus(),ai=getRuleAIStatus(),sc=getScannerStats()
  const exec=getExecutorAddress()
  const chains={}
  getActive().forEach(c=>{chains[c.name]={status:getContractAddr(c.name)?'live':getConfig('deploy_status_'+c.name)||'waiting',address:getContractAddr(c.name)||null,tier:c.tier}})
  return{ revenue:{allTime:stats.profit,today:stats.today,winRate:stats.winRate,executions:stats.total},
    sv:{stats:sv.sv,total:sv.total}, streams:getStreamStats(),
    chains, executor:{address:exec,funded:getFunded()},
    bootstrap:boot, ai, scanner:sc,
    prices:JSON.parse(getConfig('prices')||'{}'),
    lp:getLPTotal(), uptime:process.uptime()|0,
    memory:Math.round(process.memoryUsage().heapUsed/1024/1024),
    recentExecutions:getExecutions(20) }
}

app.get('/health',(_,res)=>res.json({ok:true,uptime:process.uptime()|0}))
app.get('/api/state',async(_,res)=>{ try{res.json(await buildState())}catch{res.json({initializing:true})} })
app.get('/api/deploy',(_,res)=>res.json(getBootstrapStatus()))
app.get('/api/ai',(_,res)=>res.json(getRuleAIStatus()))

// CoW Protocol solver endpoint — register at docs.cow.fi/cow-protocol/tutorials/solvers/onboard
// Endpoint format: {base_url}/{env}/{network} e.g. /solve/prod/mainnet
app.post('/solve/:env/:network',async(req,res)=>{
  try{
    const solution=handleSolveRequest(req.body)
    res.json(solution)
  }catch(e){ res.status(500).json({error:e.message}) }
})

app.get('/api/deploy-info',(_,res)=>res.json({
  executor:getExecutorAddress(),
  cheapest:{chain:'polygon',amount:'0.01 POL',costUSD:'~$0.003',expected:'First arb $30K-$500K'},
  chains:[{name:'polygon',send:'0.01 POL',cost:'~$0.003'},{name:'base',send:'0.001 ETH',cost:'~$1.54'},{name:'arbitrum',send:'0.001 ETH',cost:'~$1.54'},{name:'ethereum',send:'0.01 ETH',cost:'~$15.40'}],
  funded:getFunded(), status:getBootstrapStatus()
}))

// Serve dashboards
const desktop=join(__dir,'dashboard/nightfall.html')
const mobile =join(__dir,'dashboard/nightfall-black.html')
app.get('/',(req,res)=>{
  const isMob=/Mobile|Android|iPhone|iPad/.test(req.headers['user-agent']||'')
  const p=isMob&&existsSync(mobile)?mobile:(existsSync(desktop)?desktop:null)
  if(p)res.send(readFileSync(p,'utf8').replace(/__PASSKEY__/g,PASS))
  else res.send('<h1>Vanguard</h1><p>Starting...</p>')
})
app.get('/mobile',(_,res)=>existsSync(mobile)?res.send(readFileSync(mobile,'utf8').replace(/__PASSKEY__/g,PASS)):res.redirect('/'))
app.get('/desktop',(_,res)=>existsSync(desktop)?res.send(readFileSync(desktop,'utf8').replace(/__PASSKEY__/g,PASS)):res.redirect('/'))

export function startDashboard(){
  server.listen(PORT,()=>console.log(`[DASHBOARD] Nightfall + Nightfall Black · :${PORT}`))
  setInterval(async()=>{ try{broadcast('tick',await buildState())}catch{} },3000)
  console.log('[DASHBOARD] CoW solver endpoint: POST /solve/{env}/{network}')
  console.log('[DASHBOARD] Register at: docs.cow.fi/cow-protocol/tutorials/solvers/onboard')
}
