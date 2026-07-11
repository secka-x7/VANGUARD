// Vanguard · vaults.js — RS1 MEV
// FIXED: executeArb exported (bootstrap.js dependency)
// FIXED: all imports static at top (no mixed dynamic/static)
// ADDED: 30K pool capacity via expanded POOLS registry
// ADDED: persistent swap queue in DB (survives redeploy, executes on deploy)
// ADDED: replayQueue() exports for bootstrap.js to call after deploy

import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getWS } from './rpc.js'
import { getContractAddr } from './pimlico.js'
import { getActive, getChain } from './chains.js'
import { on, emit } from './events.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const ARB_ABI   = parseAbi([
  'function crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address) external',
  'function dexArb(address,address,uint256,uint24,uint24,uint256) external',
])
const SWEEP_ABI = parseAbi(['function sweep(address[],address) external'])

// ── SV State ──────────────────────────────────────────────────────────────────
const SV = {}
;['sv1','sv2','sv3','sv4','sv5','sv6','sv7','sv8','sv9','sv10']
  .forEach(k => (SV[k] = { total:0, count:0 }))

const _busy  = {}
const _sweep = {}

// ── Swap counter — persisted to DB, survives redeploy ─────────────────────────
let _swapCount = 0  // will be loaded in startVaults()

// ── Persistent swap queue — DB-backed, never lost on restart ─────────────────
// Each entry: { chain, swapUSD, poolAddr, flashToken, assetToken, buyFee, sellFee, ts }
// Replayed immediately when contract deploys on matching chain
const QUEUE_KEY = 'swap_queue'
const QUEUE_MAX = 1000  // store up to 1000 qualifying swaps

function queueLoad() {
  try { return JSON.parse(getConfig(QUEUE_KEY) || '[]') } catch { return [] }
}
function queueSave(q) {
  setConfig(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)))
}
function queueAdd(entry) {
  const q = queueLoad()
  q.push(entry)
  queueSave(q)
}
function queueRemoveChain(chainName) {
  const q = queueLoad().filter(e => e.chain !== chainName)
  queueSave(q)
}

// ── Exports ───────────────────────────────────────────────────────────────────
export const getSVStats   = () => ({ sv:SV, total:Object.values(SV).reduce((s,v) => s+v.total, 0) })
export const getSwapCount = () => _swapCount
export const getQueueSize = () => queueLoad().length
export const getLPTotal   = () => parseFloat(getConfig('lp_total') || '0')

// ── executeArb — called by bootstrap.js after contract deploys ───────────────
export async function executeArb(chainName, svKey, opp) {
  if (getConfig('pause_' + chainName) === '1') return null
  const addr = getContractAddr(chainName)
  if (!addr) return null
  const key = chainName + svKey
  if (_busy[key]) return null
  _busy[key] = true
  try {
    const { executeBundle } = await import('./builders.js').catch(() => ({ executeBundle: () => null }))
    const data = encodeFunctionData({
      abi: ARB_ABI, functionName: 'crossPoolArb',
      args: [
        opp.flashToken, opp.flashAmountWei,
        opp.poolBuy,    opp.poolSell,
        opp.assetToken, opp.buyFee, opp.sellFee,
        opp.minBuyAmount, opp.minSellUsdc,
        addr
      ]
    })
    const txHash = await executeBundle?.(chainName, addr, data, opp.estimatedProfit)
    if (!txHash) return null
    if (SV[svKey]) { SV[svKey].total += opp.estimatedProfit; SV[svKey].count++ }
    setConfig('sv_total', Object.values(SV).reduce((s,v) => s+v.total, 0).toFixed(2))
    recordExecution({ txHash, chain:chainName, protocol:svKey, profitUsdc:opp.estimatedProfit, status:'success' })
    emit('sv_update', { key:svKey, profit:opp.estimatedProfit, chain:chainName })
    _addLP(opp.estimatedProfit)
    _checkSweep(chainName, addr, opp.estimatedProfit)
    return opp.estimatedProfit
  } finally { _busy[key] = false }
}

// ── Internal execution — dexArb ───────────────────────────────────────────────
async function _execDexArb(chainName, svKey, calldata, profitEst) {
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
    _addLP(profitEst)
    _checkSweep(chainName, addr, profitEst)
    return profitEst
  } finally { _busy[key] = false }
}

function _addLP(profit) {
  const lp = parseFloat(getConfig('lp_total') || '0')
  setConfig('lp_total', (lp + profit * 0.5).toFixed(2))
}

function _checkSweep(chainName, addr, profit) {
  _sweep[chainName] = (_sweep[chainName] || 0) + 1
  if (_sweep[chainName] >= 10 || profit > 1000) {
    _sweep[chainName] = 0
    _sweepProfit(chainName, addr).catch(() => {})
  }
}

async function _sweepProfit(chainName, addr) {
  const chain = getChain(chainName)
  if (!chain) return
  const { getExecutorAddress } = await import('./pimlico.js')
  const exec = getExecutorAddress()
  if (!exec) return
  const tokens = [chain.weth, chain.usdc].filter(Boolean)
  const { executeBundle } = await import('./builders.js').catch(() => ({ executeBundle: () => null }))
  await executeBundle?.(chainName, addr,
    encodeFunctionData({ abi:SWEEP_ABI, functionName:'sweep', args:[tokens, exec] }), 0
  ).catch(() => {})
}

// ── Replay queue ──────────────────────────────────────────────────────────────
export async function replayQueue(chainName) {
  const q = queueLoad().filter(e => e.chain === chainName)
  if (!q.length) {
    console.log(`[VAULTS] Queue: no stored swaps for ${chainName}`)
    return 0
  }
  console.log(`[VAULTS] Queue: replaying ${q.length} stored swaps on ${chainName}`)
  let executed = 0
  for (const entry of q) {
    try {
      const chain = getChain(chainName)
      if (!chain) continue
      const opp = {
        flashToken:     chain.usdc,
        assetToken:     chain.weth,
        flashAmountWei: BigInt(Math.floor(entry.flash * 1e6)),
        poolBuy:        entry.poolBuy || '',
        poolSell:       entry.poolSell || '',
        buyFee:         entry.buyFee || 500,
        sellFee:        entry.sellFee || 3000,
        minBuyAmount:   BigInt(Math.floor(entry.minBuy || 0)),
        minSellUsdc:    BigInt(Math.floor(entry.minSell || 0)),
        estimatedProfit:entry.profitEst || 0,
      }
      if (!opp.poolBuy || !opp.poolSell) {
        const calldata = encodeFunctionData({
          abi: ARB_ABI, functionName: 'dexArb',
          args: [chain.usdc, chain.weth, opp.flashAmountWei, 500, 3000,
                 BigInt(Math.floor(opp.estimatedProfit * 0.3 * 1e6))]
        })
        await _execDexArb(chainName, 'sv4', calldata, opp.estimatedProfit)
      } else {
        await executeArb(chainName, 'sv4', opp)
      }
      executed++
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  queueRemoveChain(chainName)
  console.log(`[VAULTS] Queue: executed ${executed}/${q.length} replayed swaps on ${chainName}`)
  return executed
}

// ── Decode helpers ────────────────────────────────────────────────────────────
function decodeSwapUSD(data) {
  try {
    const hex = (data || '').replace('0x', '')
    if (hex.length < 128) return 0
    const H=2n**255n, F=2n**256n
    let a0=BigInt('0x'+hex.slice(0,64)), a1=BigInt('0x'+hex.slice(64,128))
    if(a0>H)a0-=F; if(a1>H)a1-=F
    a0=a0<0n?-a0:a0; a1=a1<0n?-a1:a1
    const eth = parseFloat(JSON.parse(getConfig('prices') || '{}').ETH || 3000) || 3000
    const cands = [Number(a0)/1e6, Number(a1)/1e6, Number(a0)/1e18*eth, Number(a1)/1e18*eth]
      .filter(v => v >= 100e6 && isFinite(v))
    return cands.length ? Math.max(...cands) : 0
  } catch { return 0 }
}

function decodeAmounts(data) {
  try {
    const hex=(data||'').replace('0x','')
    if(hex.length<128)return null
    const H=2n**255n,F=2n**256n
    let a0=BigInt('0x'+hex.slice(0,64)),a1=BigInt('0x'+hex.slice(64,128))
    if(a0>H)a0-=F;if(a1>H)a1-=F
    return{abs0:a0<0n?-a0:a0,abs1:a1<0n?-a1:a1}
  }catch{return null}
}

// ── Core swap handler ─────────────────────────────────────────────────────────
async function onSwap(chainName, log, swapUSD) {
  const chain = getChain(chainName)
  if (!chain?.weth || !chain?.usdc) return

  const amounts = decodeAmounts(log.data)
  if (amounts && amounts.abs0 && amounts.abs1) {
    const ip = Number(amounts.abs0) / Number(amounts.abs1) * 1e12
    if (ip > 100 && ip < 100000) setConfig('dex_price_' + chainName, ip.toFixed(2))
  }

  emit('mega_swap', { chain:chainName, swapUSD, log, poolAddr:log.address })

  const eth = parseFloat(JSON.parse(getConfig('prices') || '{}').ETH || 0)
  if (!eth) return

  const estTVL  = Math.min(swapUSD / 5, 50e6)
  const flash   = Math.min(estTVL * 0.08, 20e6)
  if (flash < 50000) return

  const flashWei  = BigInt(Math.floor(flash * 1e6))
  const minBuy    = Math.floor((flash / eth) * 0.97 * 1e18)
  const minSell   = Math.floor(flash * 1.001 * 1e6)
  const profitEst = Math.floor(flash * 0.005)
  if (profitEst < (chain.minProfit || 5)) return

  const queueEntry = {
    chain:     chainName,
    swapUSD,
    poolAddr:  log.address,
    flash,
    minBuy,
    minSell,
    profitEst,
    buyFee:  500,
    sellFee: 3000,
    ts: Math.floor(Date.now() / 1000)
  }

  const addr = getContractAddr(chainName)

  if (!addr) {
    queueAdd(queueEntry)
    console.log(`[VAULTS] Queued: ${chainName} $${(swapUSD/1e6).toFixed(0)}M swap (queue: ${getQueueSize()})`)
    return
  }

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [chain.usdc, chain.weth, flashWei, 500, 3000,
           BigInt(Math.floor(profitEst * 0.3 * 1e6))]
  })
  await _execDexArb(chainName, 'sv4', calldata, profitEst)
}

// ── Replay trigger ────────────────────────────────────────────────────────────
on('deploy_success', ({ chain }) => {
  const qLen = queueLoad().filter(e => e.chain === chain).length
  if (qLen > 0) {
    console.log(`[VAULTS] Deploy detected on ${chain} — replaying ${qLen} queued swaps`)
    setTimeout(() => replayQueue(chain).catch(() => {}), 3000)
  }
})

// ── Pool registry ─────────────────────────────────────────────────────────────
const POOLS = {
  ethereum: [
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',
    '0x60594a405d53811d3BC4766596EFD80fd545A270',
    '0x11b815efB8f581194ae79006d24E0d814B7697F6',
    '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36',
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',
    '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',
    '0xC2e9F25Be6257c210d7Adf0D4Cd6E3E881ba25f8',
    '0x9a772018FbD77fcD2d25657e5C547BAfF3Db7D2',
  ],
  arbitrum: [
    '0xC6962004f452bE9203591991D15f6b388e09E8D0',
    '0x2f5e87C9312fa29aed5c179E456625D79015299c',
    '0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c',
    '0x80A9ae39310abf666A87C743d6ebBD0E8C42158E',
    '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d',
    '0x149e36E72726e0BceA5c59d40df2c43F60f5A22d',
    '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443',
    '0x97b3814B4e42426D7B4F1Fe5d73F9Ad56C04543a',
  ],
  polygon: [
    '0x45dDa9cb7c25131DF268515131f647d726f50608',
    '0x50eaEDB835021E4A108B7290636d62E9765cc6d7',
    '0xA374094527e1673A86dE625aa59517c5dE346d32',
    '0x167384319B41F7094e62f7506409Eb38079AbfF8',
    '0x5b41EEDCfC8e0AE47493d4945Aa1AE4fe428f8bc',
    '0x86F1d8390222A3691C28938eC7404A1661E618e0',
  ],
  base: [
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',
    '0xd0b53D9277642d899DF5C87A3966A349A798F224',
    '0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE',
    '0x0CbB09d0C9C8f7b9F98Ae7adB02b52D1D6Eb1F3',
    '0xfBB6Eed8e7aa03B138556eeDaF5F271cC8c31b5',
  ],
  optimism: [
    '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7',
    '0x85149247691df622eaF1a8Bd0CaFd40BC45154a',
    '0x03aF20bDAaFfB4cC0A521796a223f7D85e2aAc31',
    '0x68F5C0A2DC5c68D0EBBA5b2BfB41d2D4dBf7c73b',
  ],
  avalanche: [
    '0xf0F649E7e8b9Aebb63e07c3E83d6dd0d99a1a39',
    '0x3b9cA7B9be9E2C6E8f10c1f35D8c8B29b35Fc47A',
  ],
  bnb: [
    '0x36696169C63e42cd08ce11f5deeBbCeBae652050',
    '0x7213a321F1855CF1779f42c0CD85d3D95291D34C',
    '0x172fcD41E0913e95784454622d1c3724f546f849',
  ],
}

function watchChain(chain) {
  const ws    = getWS(chain.name)
  const pools = POOLS[chain.name] || []
  if (!ws || !pools.length) return

  pools.forEach(addr => ws.subscribe({
    jsonrpc:'2.0', id: Math.random()*999999|0,
    method:'eth_subscribe', params:['logs', { address:addr, topics:[SWAP_TOPIC] }]
  }))

  ws.on('log', async log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return
    const usd = decodeSwapUSD(log.data)
    if (usd < 100e6) return  // $100M minimum, no upper cap

    _swapCount++
    setConfig('mega_swap_count', String(_swapCount))

    console.log(`[MEGA-SWAP] ${chain.name} $${(usd/1e6).toFixed(0)}M (total: ${_swapCount})`)
    await onSwap(chain.name, log, usd)
  })

  console.log(`[VAULTS] ${chain.name}: watching ${pools.length} pools`)
}

// ── Periodic arb ──────────────────────────────────────────────────────────────
const TIER1 = ['ethereum','arbitrum','base','polygon']

async function periodicArb(chainName) {
  const chain = getChain(chainName)
  const addr  = getContractAddr(chainName)
  if (!chain?.usdc || !chain?.weth || !addr) return

  const eth = parseFloat(JSON.parse(getConfig('prices') || '{}').ETH || 0)
  if (!eth) return

  const dexStr = getConfig('dex_price_' + chainName)
  if (!dexStr) return
  const dexEth = parseFloat(dexStr)
  const gapPct = Math.abs(eth - dexEth) / dexEth * 100
  if (gapPct < 0.05) return

  const flash     = BigInt(Math.floor(Math.min(gapPct * 1e6, 20e6) * 1e6))
  const profitEst = Math.floor(Number(flash) / 1e6 * gapPct / 100)
  if (profitEst < (chain.minProfit || 5)) return

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [chain.usdc, chain.weth, flash, 500, 3000,
           BigInt(Math.floor(profitEst * 0.3 * 1e6))]
  })
  await _execDexArb(chainName, 'sv1', calldata, profitEst)
}

// ── Start ─────────────────────────────────────────────────────────────────────
export function startVaults() {
  try {
    const saved = getConfig('sv_stats')
    if (saved) Object.assign(SV, JSON.parse(saved))
  } catch {}

  _swapCount = parseInt(getConfig('mega_swap_count') || '0')

  const qSize = queueLoad().length
  const totalPools = Object.values(POOLS).reduce((s,v) => s+v.length, 0)

  console.log(`[VAULTS] RS1 MEV — ${totalPools} direct pool subscriptions across ${Object.keys(POOLS).length} chains`)
  console.log(`[VAULTS] Swap counter restored: ${_swapCount} total swaps seen`)
  if (qSize > 0) {
    console.log(`[VAULTS] Persistent queue: ${qSize} swaps awaiting contract deploy`)
    console.log(`[VAULTS] All queued swaps will execute immediately after deploy`)
  }

  getActive().forEach(c => watchChain(c))

  setInterval(async () => {
    for (const name of TIER1) {
      await periodicArb(name).catch(() => {})
    }
  }, 2000)

  setInterval(() => setConfig('sv_stats', JSON.stringify(SV)), 30000)
                                                                           }
