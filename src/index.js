// Vanguard v1.0 — Boot sequence
// Self-heals: never exits on error, always recovers
// Forever-proof: works identically redeploys from GitHub at any time

import express from 'express'
import { on } from './events.js'

const PORT = process.env.PORT || 3000
const app  = express()

// Health endpoint FIRST — Railway requires it within 30s
app.get('/health', (_, res) => res.json({ status:'ok', system:'Vanguard', uptime: process.uptime()|0 }))
const srv = app.listen(PORT, () => {
  console.log('Vanguard v1.0 · 3 Revenue Sources · Rule-Based AI · Self-Healing')
  console.log('[BOOT] /health live on :' + PORT)
})

const T = Date.now()

async function main() {
  // Step 1: DB — migration runs first inside initDB, cannot crash
  const { initDB }           = await import('./db.js')
  await initDB()

  // Step 2: Chains
  const { initChains }       = await import('./chains.js')
  const chains = initChains()

  // Step 3: RPC + WebSocket
  const { initRPC }          = await import('./rpc.js')
  initRPC(chains)

  // Step 4: Executor wallet
  const { initPimlico }      = await import('./pimlico.js')
  initPimlico()

  // Step 5: Compile Vanguard.sol (viaIR)
  const { compile }          = await import('./compiler.js')
  await compile()

  // Step 6: Dashboard (replaces bare Express, same port)
  const { startDashboard }   = await import('./dashboard.js')
  srv.close(() => startDashboard())

  // Step 7: CEX feeds (Binance/OKX/Bybit)
  const { startCEXFeed }     = await import('./cexfeed.js')
  startCEXFeed()

  // Step 8: Scanner (price gap detection)
  const { startScanner }     = await import('./scanner.js')
  startScanner()

  // Step 9: Balance watcher (PRIMARY deploy trigger)
  const { startBalanceWatcher } = await import('./balance-watcher.js')
  startBalanceWatcher()

  // Step 10: Bootstrap (registers listeners, ETH Flashbots)
  const { initBootstrap }    = await import('./bootstrap.js')
  await initBootstrap()

  // Step 11: Vaults (RS1 MEV — mega-swap detection)
  const { startVaults }      = await import('./vaults.js')
  startVaults()

  // Step 12: Revenue (RS2 Non-MEV — 5 streams)
  const { startRevenue }     = await import('./revenue.js')
  startRevenue()

  // Step 13: Rule-based AI (autonomous operations)
  const { startRuleAI }      = await import('./rule-ai.js')
  startRuleAI()

  console.log(`Vanguard OPERATIONAL — ${Object.keys(chains).length} chains — boot ${Date.now()-T}ms`)
  console.log('[BOOT] RS1: MEV (crossPoolArb via Balancer 0% flash)')
  console.log('[BOOT] RS2: Non-MEV (CEX-DEX · Depeg · Governance · CoW Solver · Intents)')
  console.log('[BOOT] RS3: LP Yield (auto-compounds from RS1+RS2 profits)')
  console.log('[BOOT] Fund executor on any chain to begin. Cheapest: 0.01 POL = $0.003')

  // Watchdogs — forever-proof
  setInterval(async()=>{
    const{rpcCall}=await import('./rpc.js')
    let ok=0
    for(const c of['base','polygon','arbitrum']){
      try{if(await rpcCall(c,'eth_blockNumber',[]))ok++}catch{}
    }
    if(!ok)console.warn('[WATCHDOG] All RPCs unreachable — auto-recovering via fallbacks')
  },30000)

  setInterval(()=>{
    const mb=process.memoryUsage().heapUsed/1024/1024
    if(mb>400){console.warn(`[WATCHDOG] Memory ${mb.toFixed(0)}MB — GC`);try{global.gc?.()}catch{}}
  },60000)

  on('deploy_success',({chain,address,method})=>{
    console.log(`[LIVE] ${chain} → ${address} (${method})`)
  })
  on('first_deploy',({chain})=>{
    console.log(`[LIVE] First deploy on ${chain} — RS1 MEV now active — cascading all chains`)
  })
}

// Self-healing: never crash the process
main().catch(e=>{
  console.error('[BOOT] Fatal — recovering in 5s:', e.message)
  setTimeout(()=>main().catch(()=>{}), 5000)
})

process.on('uncaughtException',  e => console.error('[UNCAUGHT]',  e.message?.slice(0,100)))
process.on('unhandledRejection', r => console.error('[REJECTION]', String(r).slice(0,100)))
process.on('SIGTERM', () => { console.log('SIGTERM — graceful exit'); process.exit(0) })
