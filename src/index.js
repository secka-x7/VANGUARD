// X7 PROTOCOL — ENTRY POINT
import { startDashboard, broadcast } from './dashboard.js'

console.log('X7 PROTOCOL STARTING')
startDashboard()
console.log('/health live')

setTimeout(boot, 1500)

async function boot() {
  try { const {initDB}=await import('./db.js'); await initDB() }
  catch(e){ console.error('DB fatal:',e.message); process.exit(1) }

  const need=['EXECUTOR_PRIVATE_KEY','MODEM_PAY_SECRET_KEY','MODEM_PAY_WAVE_NUMBER']
  const missing=need.filter(k=>!process.env[k])
  if(missing.length) console.warn('[BOOT] Missing vars:',missing.join(', '))

  try {
    const {getExecutorAddress}=await import('./pimlico.js')
    console.log('[BOOT] Executor: ' + getExecutorAddress())
    console.log('[BOOT] Send 0.01 POL to above address to start')
  } catch {}

  try { const {startApex}=await import('./apex.js'); await startApex() }
  catch(e){ console.error('[APEX]:',e.message) }

  try { const {compile}=await import('./compiler.js'); await compile() }
  catch(e){ console.warn('[COMPILE]:',e.message) }

  try {
    const {startBootstrap}=await import('./bootstrap.js')
    await startBootstrap()
  } catch(e){ console.warn('[BOOTSTRAP]:',e.message) }

  try { const {startYield}=await import('./yield.js'); startYield() }
  catch(e){ console.warn('[YIELD]:',e.message) }

  try { const {startLearner}=await import('./learner.js'); startLearner() }
  catch(e){ console.warn('[LEARNER]:',e.message) }

  try { await startEngine() }
  catch(e){ console.error('[ENGINE]:',e.message) }

  console.log('X7 PROTOCOL OPERATIONAL')
}

async function startEngine() {
  const {startScanner}         = await import('./scanner.js')
  const {execute}              = await import('./executor.js')
  const {checkAutoWithdraw}    = await import('./treasury.js')
  const {setConfig,getConfig}  = await import('./db.js')
  const {recordMissedLiquidation} = await import('./bootstrap.js')

  const tier0=[], tier1=[], tier2=[]
  let busy=false

  const enqueue = opp => {
    // tier0: HF < 0.85 — execute instantly, maximum profit
    // tier1: HF < 0.95 — 100% close factor
    // tier2: HF < 1.0  — 50% close factor
    const q = opp.hf < 0.85 ? tier0 : opp.tier1 ? tier1 : tier2
    if (!q.find(o=>o.borrower===opp.borrower&&o.chainName===opp.chainName)) {
      q.push(opp)
      const tier = opp.hf < 0.85 ? 0 : opp.tier1 ? 1 : 2
      console.log('[QUEUE] ' + opp.chainName + '/' + opp.protocol +
        ' ' + opp.borrower.slice(0,10) + ' HF=' + opp.hf?.toFixed(4) + ' tier' + tier)
      broadcast('opportunity', {chain:opp.chainName, hf:opp.hf, tier})
    }
  }

  setInterval(async () => {
    if (busy) return
    const opp = tier0.shift() || tier1.shift() || tier2.shift()
    if (!opp) return
    busy = true
    try {
      const contract = getConfig('contract_' + opp.chainName)
      if (!contract || !contract.startsWith('0x')) {
        const est = opp.coll ? opp.coll * 0.05 : 20
        recordMissedLiquidation(opp.chainName, est)
        return
      }
      const result = await execute(opp)
      if (result?.success) {
        broadcast('execution', {chain:opp.chainName, profit:result.profitUSDC})
        await checkAutoWithdraw().catch(()=>{})
        setConfig('cascade_trigger_' + opp.chainName, Date.now())
      }
    } catch(e){ console.error('[QUEUE]:',e.message) }
    finally { busy=false }
  }, 300) // 300ms — faster queue processing

  startScanner(enqueue)
  console.log('[ENGINE] started — 3-tier queue, 300ms cycle')
}

process.on('uncaughtException',  e=>console.error('[UNCAUGHT]:',e.message))
process.on('unhandledRejection', e=>console.error('[REJECTION]:',String(e).slice(0,200)))
process.on('SIGTERM', ()=>{ console.log('SIGTERM'); process.exit(0) })
