// Vanguard Rule-Based AI — replaces Claude API dependency
// Makes operational decisions every 5 minutes based on system state
// Deterministic rules, no external API calls, zero cost
// Covers all domains Claude API handled: capital, chains, risk, strategy

import { getConfig, setConfig, getStats, getExecutions } from './db.js'
import { getStatus } from './deployer.js'
import { getActive, addChain } from './chains.js'
import { emit } from './events.js'
import { getLive } from './deployer.js'

// Rule thresholds
const RULES = {
  MIN_WIN_RATE:      40,    // % — pause chain if below
  MAX_MEMORY_MB:     400,   // MB — trigger GC
  MIN_GAPS_PER_HR:   2,     // scanner gaps/hr — check RPC if below
  PROP_INTENSITY:    7,     // default propeller intensity
  FLASH_RATIO:       20,    // P1 capital amplifier
  PAUSE_ON_LOSS_USD: 50000, // pause chain after $50K loss in 1hr
}

// Track recent performance per chain
const _chainPerf = {}

function analyzeChain(chainName) {
  const execs = getExecutions(100).filter(e=>e.chain===chainName)
  const recent = execs.filter(e=>(Date.now()/1000 - e.ts) < 3600)
  const wins   = recent.filter(e=>e.status==='success').length
  const losses = recent.filter(e=>e.status!=='success').length
  const profit = recent.reduce((s,e)=>s+(e.profit_usdc||0),0)
  const loss   = recent.filter(e=>e.profit_usdc<0).reduce((s,e)=>s+Math.abs(e.profit_usdc||0),0)
  return { wins, losses, profit, loss, total:recent.length, winRate:recent.length?wins/recent.length*100:100 }
}

function decide() {
  const stats  = getStats()
  const deploy = getStatus()
  const mem    = process.memoryUsage().heapUsed/1024/1024
  const gaps   = parseInt(getConfig('scanner_gaps')||'0')
  const prices = JSON.parse(getConfig('prices')||'{}')
  const now    = Date.now()/1000|0

  const decisions = {
    pauseChains:    [],
    resumeChains:   [],
    svWeights:      null,
    propIntensity:  RULES.PROP_INTENSITY,
    alerts:         [],
    insights:       '',
  }

  // RULE 1: Memory management
  if (mem > RULES.MAX_MEMORY_MB) {
    try { global.gc?.() } catch {}
    decisions.alerts.push({ severity:'low', message:`High memory ${mem.toFixed(0)}MB — GC triggered` })
  }

  // RULE 2: Scanner health
  const lastGapTs  = parseInt(getConfig('last_gap_ts')||'0')
  const gapAge     = now - lastGapTs
  if (gapAge > 600 && deploy.live.length > 0) {  // no gaps for 10min
    decisions.alerts.push({ severity:'medium', message:`No scanner gaps for ${(gapAge/60).toFixed(0)}min — check RPC` })
  }

  // RULE 3: Per-chain risk management
  for (const c of getActive()) {
    const perf = analyzeChain(c.name)
    _chainPerf[c.name] = perf

    // Pause if win rate too low
    if (perf.total > 10 && perf.winRate < RULES.MIN_WIN_RATE) {
      if (getConfig('pause_'+c.name) !== '1') {
        setConfig('pause_'+c.name, '1')
        decisions.pauseChains.push(c.name)
        decisions.alerts.push({ severity:'medium', message:`${c.name} paused — win rate ${perf.winRate.toFixed(0)}%` })
      }
    }

    // Resume if paused and conditions improved
    if (getConfig('pause_'+c.name)==='1' && (perf.winRate > 60 || perf.total < 3)) {
      setConfig('pause_'+c.name, '0')
      decisions.resumeChains.push(c.name)
    }

    // Pause if large loss in last hour
    if (perf.loss > RULES.PAUSE_ON_LOSS_USD) {
      setConfig('pause_'+c.name, '1')
      decisions.pauseChains.push(c.name)
      decisions.alerts.push({ severity:'high', message:`${c.name} paused — $${perf.loss.toFixed(0)} loss in 1hr` })
    }
  }

  // RULE 4: Strategy weights based on market conditions
  const ethPrice  = prices.ETH || 0
  const lastPrice = parseFloat(getConfig('last_eth_price')||'0')
  const priceChg  = lastPrice ? Math.abs(ethPrice-lastPrice)/lastPrice*100 : 0
  if (ethPrice) setConfig('last_eth_price', String(ethPrice))

  if (priceChg > 3) {
    // High volatility: favor backrun (SV4) + depeg
    decisions.svWeights = { sv4:0.35, sv5:0.15, sv6:0.25, sv1:0.15, others:0.10 }
    decisions.propIntensity = 9
    decisions.insights = `High volatility (${priceChg.toFixed(1)}%) — shifted to backrun + depeg strategy`
  } else if (priceChg < 0.5) {
    // Low volatility: favor JIT + CEX-DEX
    decisions.svWeights = { sv4:0.15, sv5:0.35, sv6:0.10, sv1:0.25, others:0.15 }
    decisions.propIntensity = 6
    decisions.insights = `Low volatility — shifted to JIT + CEX-DEX strategy`
  } else {
    decisions.svWeights = { sv4:0.25, sv5:0.25, sv6:0.20, sv1:0.20, others:0.10 }
    decisions.propIntensity = 7
    decisions.insights = `Normal conditions — balanced strategy active`
  }

  // RULE 5: Propeller intensity adjustment
  const profitToday = stats.today || 0
  if (profitToday > 100000) decisions.propIntensity = Math.min(10, decisions.propIntensity+1)
  if (profitToday < 1000 && deploy.live.length > 0) decisions.propIntensity = Math.max(5, decisions.propIntensity-1)

  // Apply decisions
  if (decisions.svWeights) {
    setConfig('sv_weights', JSON.stringify(decisions.svWeights))
    emit('rule_ai_weights', decisions.svWeights)
  }
  setConfig('prop_intensity', String(decisions.propIntensity))
  setConfig('rule_ai_last', new Date().toISOString())
  setConfig('rule_ai_insights', decisions.insights)
  setConfig('rule_ai_calls', String(parseInt(getConfig('rule_ai_calls')||'0')+1))

  // Emit alerts
  decisions.alerts.forEach(a => {
    console.log(`[RULE-AI] [${a.severity.toUpperCase()}] ${a.message}`)
    emit('rule_ai_alert', a)
  })

  if (decisions.insights) console.log('[RULE-AI]', decisions.insights)

  return decisions
}

export function startRuleAI() {
  console.log('[RULE-AI] Rule-based autonomous operations active')
  console.log('[RULE-AI] Decisions every 5min: risk, strategy, capital, propellers')
  // First decision after 30s (let system stabilize)
  setTimeout(()=>{ try{decide()}catch{} }, 30000)
  setInterval(()=>{ try{decide()}catch{} }, 300000)
}

export const getRuleAIStatus = () => ({
  enabled:  true,
  lastCall: getConfig('rule_ai_last')||'never',
  calls:    parseInt(getConfig('rule_ai_calls')||'0'),
  insights: getConfig('rule_ai_insights')||'',
  chainPerf:_chainPerf
})
