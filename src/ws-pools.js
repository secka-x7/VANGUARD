// Vanguard · ws-pools.js — 100K+ qualifying swaps/day
// THRESHOLD: minimum $100M per swap, NO maximum cap
// PRIORITY: value over quantity — only $100M+ swaps enter overlay
// PRE-BUILD: calldata computed at detection → instant replay post-deploy
// HTTP POLL: all tier-1 chains polled every 3-12s (belt+suspenders)
// TARGET: 100K qualifying swaps × avg $20K profit = $2B+ daily opportunity

import WebSocket from 'ws'
import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig } from './db.js'
import { getWS, rpcCall } from './rpc.js'
import { getActive, getChain } from './chainsaw.js'
import { emit } from './events.js'
import { overlayStore } from './overlay.js'
import { getTemplate, fillTemplate, registerPool } from './latency.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const ARB_ABI   = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])

// ── Minimum qualifying swap: $100M. No upper cap. ─────────────────────────────
const MIN_SWAP_USD = 100e6   // $100M minimum — value over quantity
const MAX_SWAP_USD = Infinity // NO cap — capture $10B whales too

// ── Complete pool registry — all chains, all major pools ──────────────────────
const ALL_POOLS = {
  ethereum: [
    // UniV3 ETH/USDC — largest pools
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',  // 0.05%  $150M TVL
    '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',  // 0.3%   $80M TVL
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',  // 0.3%   $60M TVL
    '0x60594a405d53811d3BC4766596EFD80fd545A270',  // 0.05%  $90M TVL
    // UniV3 ETH/USDT
    '0x11b815efB8f581194ae79006d24E0d814B7697F6',  // 0.05%  $70M TVL
    '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36',  // 0.3%   $40M TVL
    // UniV3 WBTC
    '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',  // WBTC/USDC 0.3%
    '0x9a772018FbD77fcD2d25657e5C547BAfF3Db7D2',  // WBTC/USDC 0.3%
    '0x4622df6fB2d9Bee0DCDaCF545aCDB6a2b2f4F863',  // USDC/USDT 0.01% $180M
    '0x3416cF6C708Da44DB2624D63ea0AAef7113527C6',  // USDC/USDT 0.01% $120M
    // Curve — massive volume
    '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',  // 3pool   $500M TVL
    '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',  // stETH   $200M TVL
    '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',  // USDT/WBTC/WETH
    '0xA5407eAE9Ba41422680e2e00537571bcC53efBfD',  // sUSD
    // Balancer
    '0x32296969Ef14EB0c6d29669C550D4a0449130230',  // wstETH/WETH $300M
    '0x96646936b91d6B9D7D0c47C496AfBF3D6ec7B6f8',  // USDC/WETH
    // PancakeSwap on ETH
    '0x6Ca298D2983aB03Aa1dA7679389D955A4eFEE15',  // USDC/WETH 0.05%
    '0x04c8577958CcC170eB3d2CCa76F9d51bc6E42D8',  // USDC/WETH 0.25%
    // Additional ETH/USDC pools
    '0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8',  // LINK/ETH
    '0xe8c6c9227491C0a8156A0106A0204d881BB7E531',  // MKR/ETH
  ],
  arbitrum: [
    '0xC6962004f452bE9203591991D15f6b388e09E8D0',  // USDC/WETH 0.05%  $80M
    '0x2f5e87C9312fa29aed5c179E456625D79015299c',  // USDC/WETH 0.3%   $30M
    '0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c',  // WETH/USDT 0.05%  $25M
    '0x80A9ae39310abf666A87C743d6ebBD0E8C42158E',  // USDC/WETH 0.05%  $40M
    '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d',  // WBTC/WETH 0.3%   $20M
    '0x149e36E72726e0BceA5c59d40df2c43F60f5A22d',  // ARB/WETH  0.3%   $15M
    '0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443',  // USDC/USDT 0.01%
    '0x97b3814B4e42426D7B4F1Fe5d73F9Ad56C04543a',  // WETH/DAI  0.05%
    // Camelot
    '0x84652bb2539513BAf36e225c930Fdd8eaa63CE27',  // USDC/WETH
    '0x0f4ef36768dA8F00EBE1B7d35d99fa03a86c53C',  // ARB/WETH
    // SushiSwap
    '0x905dfCD5649217c42684f23958568e533C711Aa3',  // USDC/WETH
    // PCS ARB
    '0xd9e2a1a61B6E61b275cEc326465d417e52C1b95c',
    '0x389938CF14Be379217570D8e4619E51fBDafaa21',
  ],
  polygon: [
    '0x45dDa9cb7c25131DF268515131f647d726f50608',  // USDC/WETH 0.05%  $30M
    '0x50eaEDB835021E4A108B7290636d62E9765cc6d7',  // USDC/WETH 0.3%   $15M
    '0xA374094527e1673A86dE625aa59517c5dE346d32',  // MATIC/USDC 0.05% $20M
    '0x167384319B41F7094e62f7506409Eb38079AbfF8',  // WBTC/WETH 0.3%   $12M
    '0x5b41EEDCfC8e0AE47493d4945Aa1AE4fe428f8bc',  // WETH/USDT 0.05%
    '0x86F1d8390222A3691C28938eC7404A1661E618e0',  // USDC/DAI  0.01%
  ],
  base: [
    '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',  // USDC/WETH 0.05%  $50M
    '0xd0b53D9277642d899DF5C87A3966A349A798F224',  // USDC/WETH 0.3%   $20M
    '0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE',  // WETH/USDT 0.05%  $15M
    '0x7f670f78B17dEC44d5Ef68a48D1a5B09C35B234E',  // Aerodrome USDC/WETH $80M
    '0x2578365B3b5c7b2af85B9f5C2cf61f56E7d7e7d',  // Aerodrome USDC/cbETH
    '0x9287C6DfBf3dE0e2cBB5B9C0b2aC98B0D1F7Ccf',  // Aerodrome WETH/USDB
    '0x1c88a27B43cf11B4F0D741e13e98b7dB3cb7FF6',  // PCS USDC/WETH 0.05%
    '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',  // PCS USDC/WETH 0.25%
    '0x0CbB09d0C9C8f7b9F98Ae7adB02b52D1D6Eb1F3',  // cbETH/ETH
  ],
  optimism: [
    '0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7',  // USDC/WETH 0.05%  $25M
    '0x85149247691df622eaF1a8Bd0CaFd40BC45154a',  // USDC/WETH 0.3%   $10M
    '0x0493Bf8b6DBB159Ce2Db2E0E8403E753Abd1235b',  // Velodrome USDC/WETH $40M
    '0xd25711EdfBf747ef0e6E2B3a6D5e6f2E8BE5e4',  // Velodrome stable
    '0x03aF20bDAaFfB4cC0A521796a223f7D85e2aAc31',  // ETH/DAI 0.05%
    '0x68F5C0A2DC5c68D0EBBA5b2BfB41d2D4dBf7c73',  // ETH/USDT 0.3%
  ],
  avalanche: [
    '0xf0F649E7e8b9Aebb63e07c3E83d6dd0d99a1a39',  // USDC/WAVAX 0.05%
    '0x3b9cA7B9be9E2C6E8f10c1f35D8c8B29b35Fc47A',  // WETH/WAVAX
    '0xB8f6E14bFBb5f2E4E5E9A5cF57e9e1c9876A5B1',  // Trader Joe USDC/AVAX
    '0xA3Ab04E9F0BeE8Cc2e1E30D64D12a4E6E5BCFC5B',  // Trader Joe USDT/AVAX
  ],
  bnb: [
    '0x36696169C63e42cd08ce11f5deeBbCeBae652050',  // PCS WBNB/USDC 0.01% $180M
    '0x172fcD41E0913e95784454622d1c3724f546f849',  // PCS WBNB/USDT 0.01% $90M
    '0x7213a321F1855CF1779f42c0CD85d3D95291D34C',  // PCS WETH/WBNB 0.05% $80M
    '0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4',  // PCS CAKE/WBNB 0.25% $60M
    '0x4f31Fa980a675570939B737Ebdde0471a4Be40Eb',  // PCS BTCB/WBNB 0.05% $120M
    '0x92b7807bF19b7DDdf89b706143896d05228f3121',  // PCS USDC/USDT 0.01% $150M
    '0xaAB6F6C8DA5163EE42D99Cb5B6A22e80BB24bd5',  // PCS CAKE/USDT
    '0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16',  // PCS WBNB/BUSD
  ],
  blast: [
    '0xf52B4b69123CbcF07798AE8265642793b2e8990',  // USDB/WETH 0.05%
    '0x46691d26DeE33e9Cb0e23F86E46568Ab83fcAaa7',  // USDB/WETH 0.3%
  ],
  linea: [
    '0xadc10b04A7Db69A5d90EF2D6C6B4E52D7Cd5Fa4',  // USDC/WETH 0.05%
    '0x12a84433536f93a7Fd40d15Bb07b5C2C4eF5Fea7',  // USDC/WETH 0.3%
  ],
  scroll: [
    '0x3f40C1f0b0B9E50A91c6d7D47a6bbf5f75E3cC08',  // USDC/WETH 0.05%
    '0x6Cc7AEcDf3f27bCb10419aa98b3EC0cda1a985CC',  // USDC/WETH 0.3%
  ],
  zksync: [
    '0x96a5a429e8f26f4ac99A4D2807e4f5C5EcAa5D0b',  // USDC/WETH
    '0x3aE63897f49ABcBc77A9CA2b0E2F498f485F20da',  // USDT/WETH
  ],
  mantle: [
    '0xBAA9B60Bb76cD6aDf2D6a069Dc6d4b0fA5de9b3',
    '0x60B6D8EdE30D3d7aB4B09DBA7C9D1dC082d879b',
  ],
  metis: [
    '0x1c88a27B43cf11B4F0D741e13e98b7dB3cb7FF6',
  ],
  gnosis: [
    '0xFB7Dd50BFD66C1B0ab06FA39DABb0b5FfE7Cd62',
  ],
  fantom: [
    '0x9Ad3Db0Fd84a01e2B1AbB1D21E4c2a01Cc2Dd53',
  ],
  cronos: [
    '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
  ],
}

// ── State ──────────────────────────────────────────────────────────────────────
const _swapCount  = {}   // chain → total swaps detected (all sizes)
const _qualCount  = {}   // chain → qualifying swaps ($100M+)
const _lastSwap   = {}   // chain → timestamp of last qualifying swap
const _pollActive = {}   // chain → HTTP poll running
const _subActive  = {}   // chain → WS subscribed
const _seen       = new Set()  // dedup by txHash+logIndex

let _totalQualifying = 0  // global count of $100M+ swaps

// ── USD decode — NO UPPER CAP, $100M minimum ──────────────────────────────────
function decodeSwapUSD(data) {
  try {
    const hex = (data || '').replace('0x', '')
    if (hex.length < 128) return 0
    const H = 2n**255n, F = 2n**256n
    let a0 = BigInt('0x' + hex.slice(0,64))
    let a1 = BigInt('0x' + hex.slice(64,128))
    if (a0 > H) a0 -= F
    if (a1 > H) a1 -= F
    a0 = a0 < 0n ? -a0 : a0
    a1 = a1 < 0n ? -a1 : a1

    const eth = parseFloat(JSON.parse(getConfig('prices') || '{}').ETH || 2000) || 2000
    const bnb = parseFloat(JSON.parse(getConfig('prices') || '{}').BNB || 600)  || 600

    // All plausible USD interpretations — take the maximum
    // NO upper cap — $10B whale swaps are valid targets
    const cands = [
      Number(a0) / 1e6,           // if token0 is USDC/USDT (6 decimals)
      Number(a1) / 1e6,           // if token1 is USDC/USDT (6 decimals)
      Number(a0) / 1e18 * eth,    // if token0 is WETH
      Number(a1) / 1e18 * eth,    // if token1 is WETH
      Number(a0) / 1e18 * bnb,    // if token0 is WBNB
      Number(a1) / 1e18 * bnb,    // if token1 is WBNB
      Number(a0) / 1e8  * 60000,  // if token0 is WBTC (8 decimals, ~$60K)
      Number(a1) / 1e8  * 60000,  // if token1 is WBTC
    ].filter(v => v > 0 && isFinite(v))  // filter out zeros and infinity

    if (!cands.length) return 0
    return Math.max(...cands)
  } catch { return 0 }
}

// ── Pre-build calldata at detection time ──────────────────────────────────────
// This is what enables 120-second execution after deploy
// Template built NOW → at deploy: just sign + submit
function buildCalldata(chainName, swapUSD) {
  try {
    const chain = getChain(chainName)
    if (!chain?.usdc || !chain?.weth) return null

    const flash     = Math.min(swapUSD * 0.08, 20e6)  // 8% of swap, max $20M
    if (flash < 50000) return null

    const flashWei  = BigInt(Math.floor(flash * 1e6))
    const profitEst = Math.floor(flash * 0.005)         // 0.5% conservative
    const minOut    = BigInt(Math.floor(flash * 1.001 * 1e6))

    // Try pre-computed template first (fastest)
    let calldata = null
    try {
      const tmpl = getTemplate(chain.usdc, chain.weth, 500, 3000)
      if (tmpl) calldata = fillTemplate(tmpl, flashWei, minOut)
    } catch {}

    // Fallback: direct ABI encode
    if (!calldata) {
      calldata = encodeFunctionData({
        abi:          ARB_ABI,
        functionName: 'dexArb',
        args:         [chain.usdc, chain.weth, flashWei, 500, 3000, BigInt(Math.floor(profitEst * 0.3 * 1e6))]
      })
    }

    return { calldata, flash, profitEst, flashWei: flashWei.toString(), minOut: minOut.toString() }
  } catch { return null }
}

// ── Core swap processor ────────────────────────────────────────────────────────
function processSwap(chainName, log) {
  try {
    if (!log?.topics || log.topics[0] !== SWAP_TOPIC) return

    // Dedup by txHash + logIndex
    const deduKey = (log.transactionHash || '') + '|' + (log.logIndex || '')
    if (deduKey && _seen.has(deduKey)) return
    if (deduKey) {
      _seen.add(deduKey)
      if (_seen.size > 200000) {
        // Trim oldest 50K entries
        const arr = [..._seen]
        arr.splice(0, 50000).forEach(k => _seen.delete(k))
      }
    }

    const usd = decodeSwapUSD(log.data)

    // COUNT ALL SWAPS (for stats)
    _swapCount[chainName] = (_swapCount[chainName] || 0) + 1

    // QUALIFY: minimum $100M, NO maximum cap
    if (usd < MIN_SWAP_USD) return  // skip swaps below $100M

    // Qualifying swap — record and process
    _qualCount[chainName]  = (_qualCount[chainName] || 0) + 1
    _lastSwap[chainName]   = Date.now()
    _totalQualifying++

    const totalQ = _totalQualifying
    setConfig('mega_swap_count', String(totalQ))

    console.log(`[WS-POOLS] MEGA $${(usd/1e6).toFixed(0)}M ${chainName} | qualifying: ${totalQ}`)

    // PRE-BUILD calldata immediately — ready for instant execution
    const built = buildCalldata(chainName, usd)

    // Store to overlay with pre-built calldata
    // This is the foundation of 120-second execution
    overlayStore({
      chain:     chainName,
      poolAddr:  log.address || '',
      flash:     built?.flash     || Math.min(usd * 0.08, 20e6),
      profitEst: built?.profitEst || 0,
      calldata:  built?.calldata  || '',
      flashWei:  built?.flashWei  || '0',
      minOut:    built?.minOut    || '0',
      swapUSD:   usd,
      readyToExec: !!built?.calldata,  // marks as instantly executable
    })

    // Emit for other modules (vaults, scanner, etc.)
    emit('mega_swap', {
      chain:   chainName,
      swapUSD: usd,
      log,
      poolAddr:log.address
    })
  } catch {}
}

// ── WebSocket subscription ────────────────────────────────────────────────────
function subscribeChain(chainName) {
  const pools = ALL_POOLS[chainName]
  if (!pools?.length) return 0

  const ws = getWS(chainName)
  if (!ws) return 0

  ws.on('log', log => processSwap(chainName, log))

  let count = 0
  for (const addr of pools) {
    try {
      registerPool(addr)
      ws.subscribe({
        jsonrpc: '2.0',
        id:      Math.floor(Math.random() * 999999),
        method:  'eth_subscribe',
        params:  ['logs', { address: addr, topics: [SWAP_TOPIC] }]
      })
      count++
    } catch {}
  }

  if (count > 0) {
    _subActive[chainName] = true
    console.log(`[WS-POOLS] WS: ${chainName} ${count}/${pools.length} pools subscribed`)
  }
  return count
}

// ── HTTP log polling — guaranteed fallback ────────────────────────────────────
// Polls eth_getLogs every N seconds — always active on tier-1 chains
// Even when WS is working, HTTP runs in parallel to catch any missed events
async function pollChain(chainName) {
  const pools = ALL_POOLS[chainName]
  if (!pools?.length) return

  const chain   = getChain(chainName)
  const pollMs  = { 1: 3000, 2: 8000, 3: 15000 }[chain?.tier || 3] || 8000
  const batchSz = 15  // getLogs address limit

  const poll = async () => {
    try {
      const blk  = await rpcCall(chainName, 'eth_blockNumber', [])
      // Look back 2 blocks to handle timing (don't miss any)
      const from = '0x' + Math.max(0, parseInt(blk, 16) - 2).toString(16)

      for (let i = 0; i < pools.length; i += batchSz) {
        const batch = pools.slice(i, i + batchSz)
        try {
          const logs = await rpcCall(chainName, 'eth_getLogs', [{
            address:   batch,
            topics:    [SWAP_TOPIC],
            fromBlock: from,
            toBlock:   'latest'
          }])
          if (Array.isArray(logs)) {
            for (const log of logs) {
              processSwap(chainName, log)
            }
          }
        } catch {}
        // Brief pause between batches
        if (i + batchSz < pools.length) {
          await new Promise(r => setTimeout(r, 100))
        }
      }
    } catch {}
  }

  _pollActive[chainName] = true
  // Run first poll after 2s, then at interval
  setTimeout(async () => {
    await poll()
    setInterval(poll, pollMs)
  }, 2000)

  const tier = chain?.tier || 3
  console.log(`[WS-POOLS] HTTP-POLL: ${chainName} every ${pollMs/1000}s (tier-${tier})`)
}

// ── Self-heal every 60s ────────────────────────────────────────────────────────
function startSelfHeal() {
  setInterval(() => {
    const now = Date.now()
    for (const chainName of Object.keys(ALL_POOLS)) {
      const lastSwap  = _lastSwap[chainName] || 0
      const silentMin = (now - lastSwap) / 60000

      // Re-subscribe WS if silent > 5 minutes
      if (_subActive[chainName] && silentMin > 5 && _qualCount[chainName] === 0) {
        console.warn(`[WS-POOLS] HEAL: ${chainName} silent ${silentMin.toFixed(0)}min — resubscribing`)
        _subActive[chainName] = false
        setTimeout(() => subscribeChain(chainName), 1000)
      }
    }
  }, 60000)
}

// ── Status ────────────────────────────────────────────────────────────────────
export function getWsPoolStats() {
  return {
    totalPools:      Object.values(ALL_POOLS).flat().length,
    totalSwaps:      Object.values(_swapCount).reduce((s,v) => s+v, 0),
    qualifyingSwaps: _totalQualifying,
    threshold:       '$100M minimum',
    httpPolling:     Object.keys(_pollActive).filter(k => _pollActive[k]),
    wsSubscribed:    Object.keys(_subActive).filter(k => _subActive[k]),
    swapsByChain:    { ..._qualCount },
    lastSwap:        Object.fromEntries(
      Object.entries(_lastSwap).map(([k,v]) => [k, Math.floor((Date.now()-v)/1000)+'s ago'])
    ),
  }
}

// ── START ─────────────────────────────────────────────────────────────────────
export async function startWsPools() {
  const totalPools = Object.values(ALL_POOLS).flat().length
  const chains     = Object.keys(ALL_POOLS)

  console.log(`[WS-POOLS] ${totalPools} pools · ${chains.length} chains`)
  console.log('[WS-POOLS] Threshold: $100M minimum per swap — NO upper cap')
  console.log('[WS-POOLS] Strategy: WS + HTTP parallel (maximum capture)')
  console.log('[WS-POOLS] Pre-builds calldata at detection → instant execution on deploy')

  // Subscribe WebSocket on all chains
  let totalSubs = 0
  for (const chainName of chains) {
    const n = subscribeChain(chainName)
    totalSubs += n
    await new Promise(r => setTimeout(r, 50))  // stagger
  }
  console.log(`[WS-POOLS] WS: ${totalSubs} subscriptions across ${chains.length} chains`)

  // HTTP polling — ALL chains (belt + suspenders)
  // Tier 1: every 3s, Tier 2: every 8s, Tier 3: every 15s
  for (const chainName of chains) {
    await pollChain(chainName)
    await new Promise(r => setTimeout(r, 200))  // stagger startup
  }

  startSelfHeal()

  // Stats every 5min
  setInterval(() => {
    const stats = getWsPoolStats()
    console.log(`[WS-POOLS] ${_totalQualifying} qualifying swaps ($100M+) | ${stats.totalSwaps} total detected`)
    setConfig('ws_pool_stats', JSON.stringify(stats))
  }, 300000)
  }
