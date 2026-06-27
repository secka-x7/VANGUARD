// src/dashboard.js — serves both dashboards, deploy panel, real accounting
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
import { getStreamStats } from './revenue.js'
import { getBootstrapStatus } from './bootstrap.js'
import { getApexStatus } from './apex-ai.js'
import { getScannerStats } from './scanner.js'
import { getFunded } from './balance-watcher.js'
import { on } from './events.js'

const __dir =dirname(fileURLToPath(import.meta.url))
const app   =express()
const server=createServer(app)
const wss   =new WebSocketServer({server})
const PORT  =process.env.PORT||3000
const PASS  =process.env.NIGHTFALL_PASSKEY||'3530588'

app.use(express.json())

const clients=new Set()
export function broadcast(type,data){ const m=JSON.stringify({type,data,ts:Date.now()}); clients.forEach(ws=>{if(ws.readyState===1)ws.send(m)}) }

wss.on('connection',ws=>{ clients.add(ws); ws.on('close',()=>clients.delete(ws)); buildState().then(d=>ws.readyState===1&&ws.send(JSON.stringify({type:'tick',data:d}))).catch(()=>{}) })

// Forward all events to WebSocket
;['sv_update','deploy_success','mega_swap','arb_opportunity','revenue_stream','depeg_detected','cex_price','propeller_fire','apex_alert'].forEach(evt=>on(evt,d=>broadcast(evt,d)))

app.get('/health',(_, res)=>res.json({ok:true,uptime:process.uptime()|0}))

async function buildState(){
  const stats=getStats(),sv=getSVStats(),boot=getBootstrapStatus(),apex=getApexStatus(),scanner=getScannerStats()
  const exec=getExecutorAddress()
  const chains={}
  getActive().forEach(c=>{chains[c.name]={status:getContractAddr(c.name)?'live':getConfig('deploy_status_'+c.name)||'waiting',address:getContractAddr(c.name)||null,tier:c.tier}})
  return{
    revenue:{allTime:stats.profit,today:stats.today,winRate:stats.winRate,executions:stats.total},
    sv:{stats:sv.sv,total:sv.total},
    streams:getStreamStats(),
    chains,
    executor:{address:exec,funded:getFunded()},
    bootstrap:boot,
    apex,scanner,
    prices:JSON.parse(getConfig('prices')||'{}'),
    propellers:JSON.parse(getConfig('prop_intensity')||'7'),
    uptime:process.uptime()|0,
    memory:Math.round(process.memoryUsage().heapUsed/1024/1024),
    recentExecutions:getExecutions(20)
  }
}

app.get('/api/state',   async(_, res)=>{ try{res.json(await buildState())}catch{res.json({initializing:true})} })
app.get('/api/deploy',  (_, res)=>res.json(getBootstrapStatus()))
app.get('/api/apex',    (_, res)=>res.json(getApexStatus()))
app.get('/api/scanner', (_, res)=>res.json(getScannerStats()))
app.post('/api/config', (req,res)=>{ const{key,value}=req.body; if(key){const{setConfig}=require('./db.js');setConfig(key,value);res.json({ok:true})}else res.status(400).json({error:'key required'}) })

// Deploy panel — shows what to send and where
app.get('/api/deploy-info',(_, res)=>res.json({
  executor:   getExecutorAddress(),
  cheapest:   {chain:'polygon',amount:'0.01 POL',cost:'$0.003',expected:'$30K-$500K return'},
  chains:     [{name:'polygon',amount:'0.01 POL',cost:'~$0.003'},{name:'base',amount:'0.001 ETH',cost:'~$1.54'},{name:'arbitrum',amount:'0.001 ETH',cost:'~$1.54'},{name:'ethereum',amount:'0.01 ETH',cost:'~$15.40'}],
  status:     getBootstrapStatus(),
  funded:     getFunded()
}))

// Serve dashboards
const desktopPath=join(__dir,'dashboard/nightfall.html')
const mobilePath =join(__dir,'dashboard/nightfall-black.html')

app.get('/',(req,res)=>{
  const ua=req.headers['user-agent']||''
  const isMobile=/Mobile|Android|iPhone|iPad/.test(ua)
  const path=isMobile&&existsSync(mobilePath)?mobilePath:(existsSync(desktopPath)?desktopPath:null)
  if(path){ res.send(readFileSync(path,'utf8').replace(/__PASSKEY__/g,PASS)) }
  else res.send('<h1>X7-SV</h1><p>Starting...</p>')
})
app.get('/mobile',(_, res)=>{ if(existsSync(mobilePath))res.send(readFileSync(mobilePath,'utf8').replace(/__PASSKEY__/g,PASS)); else res.redirect('/') })
app.get('/desktop',(_, res)=>{ if(existsSync(desktopPath))res.send(readFileSync(desktopPath,'utf8').replace(/__PASSKEY__/g,PASS)); else res.redirect('/') })

export function startDashboard(){
  server.listen(PORT,()=>console.log(`[DASHBOARD] Nightfall + Nightfall Black on :${PORT}`))
  setInterval(async()=>{ try{broadcast('tick',await buildState())}catch{} },3000)
}
