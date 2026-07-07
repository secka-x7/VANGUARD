// Vanguard · vaults.js — RS1 MEV
// FIX: _swapCount persisted to DB (survives redeploy)
// FIX: swap queue persisted to DB (pre-deploy swaps never lost)
// FIX: getSwapCount() exported for dashboard.js buildState()
import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getWS } from './rpc.js'
import { getContractAddr } from './pimlico.js'
import { getActive, getChain } from './chains.js'
import { emit } from './events.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const ARB_ABI   = parseAbi([
  'function crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address) external',
  'function dexArb(address,address,uint256,uint24,uint24,uint256) external',
])
const SWEEP_ABI = parseAbi(['function sweep(address[],address) external'])

// ── State ─────────────────────────────────────────────────────────────────────
const SV = {}
;['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9','sv10']
  .forEach(k => (SV[k] = { total:0, count:0 }))

const _busy  = {}
const _sweep = {}

// Swap counter — restored from DB on boot (survives redeploy)
let _swapCount = parseInt(getConfig('mega_swap_count') || '0')

// Persistent swap queue — pre-deploy swaps stored in DB, never lost
// Each entry: { chain, swapUSD, poolAddr, ts }
// Max 500 entries — cap prevents unbounded DB growth
const QUEUE_KEY = 'swap_queue'
const QUEUE_MAX = 500

function loadQueue() {
  try { return JSON.parse(getConfig(QUEUE_KEY) || '[]') } catch { return [] }
}

function saveQueue(q) {
  setConfig(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)))
}

function enqueueSwap(evt) {
  const q = loadQueue()
  q.push({ chain:evt.chain, swapUSD:evt.swapUSD, poolAddr:evt.poolAddr, ts:Math.floor(Date.now()/1000) })
  saveQueue(q)
}

function clearQueue() {
  setConfig(QUEUE_KEY, '[]')
}

// ── Exports ───────────────────────────────────────────────────────────────────
export const getSVStats   = () => ({ sv:SV, total:Object.values(SV).reduce((s,v)=>s+v.total,0) })
export const getSwapCount = () => _swapCount
export const getQueueSize = () => loadQueue().length

// Called by deployer after contract goes live — replays all queued swaps
export async function replayQueue(chainName) {
  const q = loadQueue()
  if (!q.length) return
  const forChain = q.filter(e => e.chain === chainName)
  if (!forChain.length) {
    console.log(`[VAULTS] No queued swaps for ${chainName}`)
    return
  }
  console.log(`[VAULTS] Replaying ${forChain.length} queued swaps on ${chainName}`)
  // Remove replayed entries from queue
  const remaining = q.filter(e => e.chain !== chainName)
  saveQueue(remaining)
  // Re-emit each as arb trigger — bootstrap.js will pick them up
  for (const evt of forChain) {
    emit('replay_swap', { chain:evt.chain, swapUSD:evt.swapUSD, poolAddr:evt.poolAddr })
    await new Promise(r => setTimeout(r, 200))  // stagger to avoid nonce collision
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────
async function execute(chainName, svKey, calldata, profitEst) {
  if (getConfig('pause_' + chainName) === '1') return null
  const addr = getContractAddr(chainName)
  if (!addr) return null
  const key = chainName + svKey
  if (_busy[key]) return null
  _busy[key] = true
  try {
    const { executeBundle } = await import('./builders.js').catch(() => ({ executeBundle: () => null }))
    const txHash = await executeBundle?.(chainName, addr, calldata, profitEst)
    if (!txHash) return null
    if (SV[svKey]) { SV[svKey].total += profitEst; SV[svKey].count++ }
    setConfig('sv_total', Object.values(SV).reduce((s,v) => s+v.total, 0).toFixed(2))
    recordExecution({ txHash, chain:chainName, protocol:svKey, profitUsdc:profitEst, status:'success' })
    emit('sv_update', { key:svKey, profit:profitEst, chain:chainName })
    // 50% of profit → LP vault
    const lp = parseFloat(getConfig('lp_total') || '0')
    setConfig('lp_total', (lp + profitEst * 0.5).toFixed(2))
    _sweep[chainName] = (_sweep[chainName] || 0) + 1
    if (_sweep[chainName] >= 10 || profitEst > 1000) {
      _sweep[chainName] = 0
      sweepProfit(chainName, addr).catch(() => {})
    }
    return profitEst
  } finally { _busy[key] = false }
}

async function sweepProfit(chainName, addr) {
  const chain = getChain(chainName)
  if (!chain) return
  const { getExecutorAddress } = await import('./pimlico.js')
  const exec = getExecutorAddress()
  if (!exec) return
  const tokens = [chain.weth, chain.usdc].filter(Boolean)
  const { executeBundle } = await import('./builders.js').catch(() => ({ executeBundle: () => null }))
  await executeBundle?.(chainName, addr,
    encodeFunctionData({ abi:SWEEP_ABI, functionName:'sweep', args:[tokens,exec] }), 0
  ).catch(() => {})
}

// ── Swap decode ───────────────────────────────────────────────────────────────
function decodeSwapUSD(data) {
  try {
    const hex = (data || '').replace('0x', '')
    if (hex.length < 128) return 0
    const H = 2n**255n, F = 2n**256n
    let a0 = BigInt('0x' + hex.slice(0,64)), a1 = BigInt('0x' + hex.slice(64,128))
    if (a0 > H) a0 -= F; if (a1 > H) a1 -= F
    a0 = a0 < 0n ? -a0 : a0; a1 = a1 < 0n ? -a1 : a1
    const eth = parseFloat(JSON.parse(getConfig('prices') || '{}').ETH || 3000) || 3000
    const cands = [
      Number(a0)/1e6, Number(a1)/1e6,
      Number(a0)/1e18*eth, Number(a1)/1e18*eth
    ].filter(v => v > 1e8 && v < 2e9)
    return cands.length ? Math.max(...cands) : 0
  } catch { return 0 }
}

// ── Core swap handler ─────────────────────────────────────────────────────────
async function onSwap(chainName, log, swapUSD) {
  const chain = getChain(chainName)
  if (!chain?.weth || !chain?.usdc) return

  // Persist to queue regardless of deploy state
  // If contract is not live: queued for replay after deploy
  // If contract is live: execute immediately AND save to queue for record
  enqueueSwap({ chain:chainName, swapUSD, poolAddr:log.address })

  // Update dex price for CEX-DEX stream
  const amounts = decodeAmounts(log.data)
  if (amounts) {
    const ip = Number(amounts.abs0) / Number(amounts.abs1) * 1e12
    if (ip > 100 && ip < 100000) setConfig('dex_price_' + chainName, ip.toFixed(2))
  }

  // Emit for scanner bridge + bootstrap
  emit('mega_swap', { chain:chainName, swapUSD, log, poolAddr:log.address })

  // Only execute arb if contract is deployed on this chain
  const addr = getContractAddr(chainName)
  if (!addr) return  // queued above — will execute after deploy

  if (!chain.usdc || !chain.weth) return
  const flash = BigInt(Math.floor(Math.min(swapUSD * 0.0008, 20e6) * 1e6))
  if (flash < BigInt(50000 * 1e6)) return
  const prices = JSON.parse(getConfig('prices') || '{}')
  const eth = parseFloat(prices.ETH || 0)
  if (!eth) return

  const profitEst = Math.floor(Number(flash) / 1e6 * 0.005)
  if (profitEst < (chain.minProfit || 5)) return

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [chain.usdc, chain.weth, flash, 500, 3000, BigInt(Math.floor(profitEst * 0.3 * 1e6))]
  })
  await execute(chainName, 'sv4', calldata, profitEst)
}

function decodeAmounts(data) {
  try {
    const hex = (data || '').replace('0x', '')
    if (hex.length < 128) return null
    const H=2n**255n, F=2n**256n
    let a0=BigInt('0x'+hex.slice(0,64)), a1=BigInt('0x'+hex.slice(64,128))
    if(a0>H)a0-=F; if(a1>H)a1-=F
    return { abs0:a0<0n?-a0:a0, abs1:a1<0n?-a1:a1 }
  } catch { return null }
}

// ── Pool registry ─────────────────────────────────────────────────────────────
const POOLS = {
  ethereum:['0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640','0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8','0x4585FE77225b41b697C938B018E2ac67Ac5a20c0'],
  arbitrum:['0xC6962004f452bE9203591991D15f6b388e09E8D0','0x2f5e87C9312fa29aed5c179E456625D79015299c'],
  polygon: ['0x45dDa9cb7c25131DF268515131f647d726f50608','0x50eaEDB835021E4A108B7290636d62E9765cc6d7'],
  base:    ['0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5','0xd0b53D9277642d899DF5C87A3966A349A798F224'],
}

function watchChain(chain) {
  const ws    = getWS(chain.name)
  const pools = POOLS[chain.name] || []
  if (!ws || !pools.length) return
  pools.forEach(addr => ws.subscribe({
    jsonrpc:'2.0', id:Math.random()*99999|0,
    method:'eth_subscribe', params:['logs', { address:addr, topics:[SWAP_TOPIC] }]
  }))
  ws.on('log', async log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return
    const usd = decodeSwapUSD(log.data)
    if (usd < 1e8 || usd > 2e9) return

    // Increment counter and persist to DB
    _swapCount++
    setConfig('mega_swap_count', String(_swapCount))

    console.log(`[MEGA-SWAP] ${chain.name} $${(usd/1e6).toFixed(0)}M (total: ${_swapCount})`)
    await onSwap(chain.name, log, usd)
  })
  console.log(`[VAULTS] ${chain.name}: watching ${pools.length} pools`)
}

// ── Replay handler — fires after deploy_success ───────────────────────────────
// Wired up here so vaults.js manages its own queue lifecycle
import { on } from './events.js'

on('deploy_success', async ({ chain }) => {
  // Small delay to let contract initialization settle
  setTimeout(() => replayQueue(chain).catch(() => {}), 3000)
})

// ── Start ─────────────────────────────────────────────────────────────────────
export function startVaults() {
  // Restore SV stats from DB
  try {
    const saved = getConfig('sv_stats')
    if (saved) Object.assign(SV, JSON.parse(saved))
  } catch {}

  const queueSize = loadQueue().length
  console.log(`[VAULTS] RS1 MEV — watching mega-pool swaps on all chains`)
  console.log(`[VAULTS] Swap counter restored: ${_swapCount} total swaps seen`)
  if (queueSize > 0) {
    console.log(`[VAULTS] Persistent queue: ${queueSize} swaps awaiting deploy`)
  }

  getActive().forEach(c => watchChain(c))
  setInterval(() => setConfig('sv_stats', JSON.stringify(SV)), 30000)
    }
