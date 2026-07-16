// Vanguard · vanguard_vaults.js
// Absorbs: rpc.js + vaults.js
// HTTP Router (Alchemy primary) + 10 Strategic Vaults + execution context
// Feeds opportunities to NEXUS for routing
// SV1-SV10 with ring-buffer instance management

import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getChain, rpcCall, getActive } from './chains1.js'
import { getContractAddr } from './pimlico.js'
import { emit, on } from './events.js'
import { nexusRoute, recordRevenue } from './nexus.js'
import { overlayStore } from './overlay.js'
import { getSABF64, SAB_OFFSETS } from './sdal.js'

const HOT     = getSABF64()
const ARB_ABI = parseAbi([
  'function dexArb(address,address,uint256,uint24,uint24,uint256) external',
  'function crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address) external',
])
const SWEEP_ABI = parseAbi(['function sweep(address[],address) external'])

// ── 10 Strategic Vaults ───────────────────────────────────────────────────────
const SV = {}
;['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9','sv10']
  .forEach(k => (SV[k] = { total:0, count:0, label:{
    sv1:'Velocity Arb', sv2:'Cascade Arb', sv3:'Cross-Chain', sv4:'Backrun',
    sv5:'JIT-LP', sv6:'Sandwich', sv7:'Stable Arb', sv8:'LP Snipe',
    sv9:'Derivatives', sv10:'Protocol Flow'
  }[k]||k }))

const _busy   = {}
const _sweep  = {}
let   _swapCount = parseInt(getConfig('mega_swap_count')||'0')

export const getSVStats   = () => ({ sv:SV, total:Object.values(SV).reduce((s,v)=>s+v.total,0) })
export const getSwapCount = () => _swapCount
export const getQueueSize = () => { try { return JSON.parse(getConfig('overlay_v3')||'[]').length } catch { return 0 } }
export const getLPTotal   = () => parseFloat(getConfig('lp_total')||'0')

// Execute arb via APEX (called by bootstrap after deploy)
export async function executeArb(chainName, svKey, opp) {
  if (getConfig('system_paused')==='1' || getConfig('pause_'+chainName)==='1') return null
  const addr = getContractAddr(chainName)
  if (!addr) return null
  const key  = chainName + svKey
  if (_busy[key]) return null
  _busy[key] = true
  try {
    // Route through NEXUS → APEX for 1.5ms execution
    const decision = nexusRoute({
      chain:       chainName,
      type:        svKey,
      profitEst:   opp.estimatedProfit || 0,
      flashRequired:opp.flashAmountWei ? Number(opp.flashAmountWei)/1e6 : 0,
      calldata:    opp.calldata,
      chainId:     getChain(chainName)?.id || 1,
    })
    if (!decision) return null
    const { apexExecute } = await import('./apex.js')
    const txHash = await apexExecute(decision)
    if (!txHash) return null

    if (SV[svKey]) { SV[svKey].total += (opp.estimatedProfit||0); SV[svKey].count++ }
    setConfig('sv_total', Object.values(SV).reduce((s,v)=>s+v.total,0).toFixed(2))
    recordExecution({ txHash, chain:chainName, protocol:svKey, profitUsdc:opp.estimatedProfit||0, status:'success' })
    emit('sv_update', { key:svKey, profit:opp.estimatedProfit, chain:chainName })
    recordRevenue(opp.estimatedProfit||0)
    const lp=parseFloat(getConfig('lp_total')||'0')
    setConfig('lp_total',(lp+(opp.estimatedProfit||0)*0.5).toFixed(2))
    return txHash
  } finally { _busy[key] = false }
}

// Replay queue — called on deploy_success
export async function replayQueue(chainName) {
  const { overlayPending, replayChain } = await import('./overlay.js')
  const pending = overlayPending(chainName)
  if (!pending.length) { console.log(`[VAULTS] No queued swaps for ${chainName}`); return 0 }
  console.log(`[VAULTS] Replaying ${pending.length} queued swaps on ${chainName}`)
  return replayChain(chainName, async entry => {
    const decision = nexusRoute({
      chain: chainName, type:'vault_arb', profitEst: entry.profitEst||0,
      flashRequired: entry.flash||0, calldata: entry.calldata, chainId: getChain(chainName)?.id||1,
    })
    if (!decision) return null
    const { apexExecute } = await import('./apex.js')
    return apexExecute(decision)
  })
}

// Periodic arb on tier-1 chains (every 2s)
async function periodicArb(chainName) {
  if (getConfig('system_paused')==='1') return
  if (getConfig('pause_'+chainName)==='1') return
  const chain = getChain(chainName)
  const addr  = getContractAddr(chainName)
  if (!chain?.usdc || !chain?.weth || !addr) return

  const eth = parseFloat(JSON.parse(getConfig('prices')||'{}').ETH||0)
  if (!eth) return
  const dex = parseFloat(getConfig('dex_price_'+chainName)||'0')
  if (!dex) return
  const gapPct = Math.abs(eth-dex)/dex*100
  if (gapPct < 0.05) return

  const flash     = Math.min(500000, gapPct*50000)
  const profitEst = Math.floor(flash*(gapPct-0.05)/100)
  if (profitEst < (chain.minProfit||5)) return

  nexusRoute({
    chain:chainName, type:'vault_arb', profitEst, flashRequired:flash,
    calldata:'', chainId:chain.id||1, flash,
  })
}

// Block number for APEX
export async function getBlock(chainName) {
  try { return parseInt(await rpcCall(chainName,'eth_blockNumber',[]),16) } catch { return 0 }
}

// Events
on('deploy_success', ({ chain }) => {
  const qLen = getQueueSize()
  if (qLen > 0) {
    console.log(`[VAULTS] Deploy on ${chain} — replaying ${qLen} queued swaps`)
    setTimeout(() => replayQueue(chain).catch(()=>{}), 2000)
  }
})

export function startVaults() {
  try { const s=getConfig('sv_stats'); if(s) Object.assign(SV,JSON.parse(s)) } catch {}
  _swapCount = parseInt(getConfig('mega_swap_count')||'0')

  const t1 = getActive().filter(c=>c.tier===1).map(c=>c.name)
  setInterval(async()=>{ for(const n of t1) await periodicArb(n).catch(()=>{}) }, 2000)
  setInterval(()=>setConfig('sv_stats',JSON.stringify(SV)),30000)

  console.log(`[VAULTS] 10 SVs active — feeding opportunities to NEXUS`)
  console.log(`[VAULTS] Swap counter restored: ${_swapCount}`)
  console.log('[VAULTS] replayQueue() armed — fires on deploy_success')
}
