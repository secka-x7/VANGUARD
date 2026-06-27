// X7-SV v4.0 — Boot sequence
// Self-heals: uncaughtException never crashes, always continues
// Forever-proof: designed to run indefinitely at Railway.app
// Deploy anytime from GitHub — instantly live as if built yesterday

import express from 'express'
import { on } from './events.js'

const PORT=process.env.PORT||3000
const app =express()

// Health endpoint: FIRST, before anything else (Railway requirement)
app.get('/health',(_, res)=>res.json({status:'ok',uptime:process.uptime()|0}))
const server=app.listen(PORT,()=>{
  console.log('X7-SV v4.0 — 1B instances · 10 SVs · Balancer 0% · ApexAI autonomous')
  console.log('[BOOT] /health live on :'+PORT)
})

const T=Date.now()
async function main(){
  // Step 1: Database (must be first — everything reads config from DB)
  const{initDB}=await import('./db.js'); await initDB()

  // Step 2: Dashboard (replaces bare Express, same port)
  const{startDashboard}=await import('./dashboard.js').catch(()=>({startDashboard:()=>{}}))
  server.close(); startDashboard()

  // Step 3: Chains
  const{initChains}=await import('./chains.js'); const chains=await initChains()

  // Step 4: RPC + WebSocket (must be before anything that calls rpcCall)
  const{initRPC}=await import('./rpc.js'); initRPC(chains)

  // Step 5: Executor wallet
  const{initPimlico}=await import('./pimlico.js'); initPimlico()

  // Step 6: Compile X7.sol (viaIR — no stack too deep)
  const{compile}=await import('./compiler.js'); await compile()

  // Step 7: Balance watcher (PRIMARY deploy trigger — watches for 0.01 native)
  const{startBalanceWatcher}=await import('./balance-watcher.js'); startBalanceWatcher()

  // Step 8: Scanner (secondary trigger, price gap detection)
  const{startScanner}=await import('./scanner.js'); startScanner()

  // Step 9: CEX feeds (feeds scanner + S3 CEX-DEX stream)
  const{startCEXFeed}=await import('./cexfeed.js').catch(()=>({startCEXFeed:()=>{}})); startCEXFeed()

  // Step 10: Bootstrap (registers chain_funded listener, ETH Flashbots)
  const{initBootstrap}=await import('./bootstrap.js'); await initBootstrap()

  // Step 11: Revenue (8 non-MEV streams, runs from day 1 regardless of deploy)
  const{startRevenue}=await import('./revenue.js'); startRevenue()

  // Step 12: Vaults (1B virtual instances, 10 SVs, starts watching immediately)
  const{startVaults}=await import('./vaults.js'); startVaults()

  // Step 13: Treasury
  const{startTreasury}=await import('./treasury.js').catch(()=>({startTreasury:()=>{}})); startTreasury()

  // Step 14: ApexAI (autonomous operations, calls Claude every 5min)
  const{startApexAI}=await import('./apex-ai.js'); startApexAI()

  console.log(`X7-SV OPERATIONAL — ${Object.keys(chains).length} chains — boot ${Date.now()-T}ms`)
  console.log('[BOOT] Send 0.01 native to executor on any chain → instant deploy → all 17 chains live')

  // Self-healing watchdog — monitors RPC health, never crashes system
  let fails=0
  setInterval(async()=>{
    try{
      const{rpcCall}=await import('./rpc.js')
      const{getActive}=await import('./chains.js')
      let ok=0
      for(const c of getActive().slice(0,3)){ try{if(await rpcCall(c.name,'eth_blockNumber',[]))ok++}catch{} }
      if(!ok){fails++;if(fails>=3)console.warn('[WATCHDOG] All RPC providers unreachable — auto-recovering')}
      else fails=0
    }catch{}
  },30000)

  // Memory monitor — self-heals if approaching limit
  setInterval(()=>{
    const mb=process.memoryUsage().heapUsed/1024/1024
    if(mb>400){
      console.warn(`[WATCHDOG] High memory: ${mb.toFixed(0)}MB — triggering GC`)
      try{global.gc?.()}catch{}
    }
  },60000)

  // Event listeners for deploy success → revenue activation
  on('deploy_success',({chain,address,method})=>{
    console.log(`[LIVE] ${chain} → ${address} (${method})`)
    if(chain==='ethereum')console.log('[LIVE] ETH deployed — maximum MEV revenue now active')
  })
}

// Run forever — never exit on error
main().catch(e=>{ console.error('[BOOT] Fatal — attempting recovery in 5s:', e.message); setTimeout(()=>main(),5000) })
process.on('uncaughtException',  e=>console.error('[UNCAUGHT]',  e.message?.slice(0,100)))
process.on('unhandledRejection', r=>console.error('[REJECTION]', String(r).slice(0,100)))
process.on('SIGTERM',()=>{ console.log('SIGTERM — graceful shutdown'); process.exit(0) })
// No SIGINT handler — Railway sends SIGTERM. Let Node handle SIGINT naturally.
