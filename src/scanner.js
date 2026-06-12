// X7 PROTOCOL — SCANNER
// Three protocols, four chains, one unified priority queue
// WebSocket for real-time events + 30s polling for at-risk positions
// 10-block chunks for Alchemy free tier compliance
// Tier-1 queue: HF < 0.95 (100% close factor) — executed first
// Tier-2 queue: HF 0.95-1.0 (50% close factor) — executed second

import { createPublicClient, http } from 'viem'
import { CHAINS, ACTIVE_CHAINS, TOPICS } from './config.js'
import { upsertBorrower, getAtRisk, setConfig, getConfig } from './db.js'
import WebSocket from 'ws'

const POOL_ABI = [
  { name:'getUserAccountData', type:'function', stateMutability:'view',
    inputs:[{name:'user',type:'address'}],
    outputs:[
      {name:'totalCollateralBase',type:'uint256'},
      {name:'totalDebtBase',type:'uint256'},
      {name:'availableBorrowsBase',type:'uint256'},
      {name:'currentLiquidationThreshold',type:'uint256'},
      {name:'ltv',type:'uint256'},
      {name:'healthFactor',type:'uint256'}
    ]
  }
]

const DATA_ABI = [
  { name:'getAllReservesTokens', type:'function', stateMutability:'view',
    inputs:[], outputs:[{name:'',type:'tuple[]',components:[
      {name:'symbol',type:'string'},{name:'tokenAddress',type:'address'}
    ]}]
  },
  { name:'getUserReserveData', type:'function', stateMutability:'view',
    inputs:[{name:'asset',type:'address'},{name:'user',type:'address'}],
    outputs:[
      {name:'currentATokenBalance',type:'uint256'},
      {name:'currentStableDebt',type:'uint256'},
      {name:'currentVariableDebt',type:'uint256'},
      {name:'principalStableDebt',type:'uint256'},
      {name:'scaledVariableDebt',type:'uint256'},
      {name:'stableBorrowRate',type:'uint256'},
      {name:'liquidityRate',type:'uint256'},
      {name:'stableRateLastUpdated',type:'uint40'},
      {name:'usageAsCollateralEnabled',type:'bool'}
    ]
  }
]

const COMPOUND_ABI = [
  { name:'isLiquidatable', type:'function', stateMutability:'view',
    inputs:[{name:'account',type:'address'}], outputs:[{name:'',type:'bool'}] }
]

const BORROW_EVENT = {
  name:'Borrow', type:'event',
  inputs:[
    {name:'reserve',type:'address',indexed:true},
    {name:'user',type:'address',indexed:false},
    {name:'onBehalfOf',type:'address',indexed:true},
    {name:'amount',type:'uint256',indexed:false},
    {name:'interestRateMode',type:'uint8',indexed:false},
    {name:'borrowRate',type:'uint256',indexed:false},
    {name:'referralCode',type:'uint16',indexed:true}
  ]
}

const _clients = {}
function client(chainName) {
  if (!_clients[chainName])
    _clients[chainName] = createPublicClient({ transport: http(CHAINS[chainName].rpcHttp) })
  return _clients[chainName]
}

// Check Aave health factor — updates DB
export async function checkAaveHF(chainName, address) {
  try {
    const r = await client(chainName).readContract({
      address: CHAINS[chainName].aavePool, abi: POOL_ABI,
      functionName: 'getUserAccountData', args: [address]
    })
    const hf   = Number(r[5]) / 1e18
    const coll = Number(r[0]) / 1e8
    const debt = Number(r[1]) / 1e8
    upsertBorrower(address, chainName, 'aave', hf, coll, debt)
    return { hf, coll, debt, liq: hf > 0 && hf < 1.0, tier1: hf > 0 && hf < 0.95 }
  } catch { return null }
}

// Get Aave user reserves for executor params
export async function getAaveReserves(chainName, address) {
  try {
    const chain   = CHAINS[chainName]
    const c       = client(chainName)
    const tokens  = await c.readContract({
      address: chain.aaveData, abi: DATA_ABI,
      functionName: 'getAllReservesTokens', args: []
    })
    const out = []
    for (const t of tokens) {
      try {
        const d = await c.readContract({
          address: chain.aaveData, abi: DATA_ABI,
          functionName: 'getUserReserveData',
          args: [t.tokenAddress, address]
        })
        out.push({
          asset: t.tokenAddress, symbol: t.symbol,
          aTokenBalance:        d[0],
          variableDebt:         d[2],
          collateralEnabled:    d[8]
        })
      } catch {}
    }
    return out
  } catch { return null }
}

// Seed borrowers from recent blocks — 10-block chunks for free Alchemy
async function seedFromBlocks(chainName) {
  try {
    const c      = client(chainName)
    const latest = await c.getBlockNumber()
    const total  = 50n
    let   from   = latest - total
    const addrs  = new Set()
    while (from < latest) {
      const to = from + 9n > latest ? latest : from + 9n
      try {
        const logs = await c.getLogs({
          address:   CHAINS[chainName].aavePool,
          event:     BORROW_EVENT, fromBlock: from, toBlock: to
        })
        logs.forEach(l => { const a = l.args.onBehalfOf||l.args.user; if(a) addrs.add(a) })
      } catch {}
      from = to + 1n
      await new Promise(r => setTimeout(r, 250))
    }
    addrs.forEach(a => upsertBorrower(a, chainName, 'aave', 999))
    console.log(`[${chainName.toUpperCase()}] Seeded ${addrs.size} borrowers`)
  } catch {}
}

// WebSocket: real-time event listener
const _ws = {}
function startWS(chainName, onLiq) {
  const chain = CHAINS[chainName]
  function connect() {
    try {
      const ws = new WebSocket(chain.rpcWss)
      _ws[chainName] = ws
      ws.on('open', () => {
        setConfig(`ws_${chainName}`, 'connected')
        console.log(`[${chainName.toUpperCase()}] WebSocket connected`)
        ws.send(JSON.stringify({ jsonrpc:'2.0',id:1,method:'eth_subscribe',
          params:['logs',{ address: chain.aavePool, topics: [TOPICS.LIQUIDATION] }] }))
        ws.send(JSON.stringify({ jsonrpc:'2.0',id:2,method:'eth_subscribe',
          params:['logs',{ address: chain.aavePool, topics: [TOPICS.BORROW] }] }))
      })
      ws.on('message', async raw => {
        try {
          const msg = JSON.parse(raw.toString())
          if (!msg.params?.result) return
          const log = msg.params.result
          if (!log.topics?.[0]) return
          if (log.topics[0] === TOPICS.LIQUIDATION) {
            const borrower = '0x' + log.topics[3]?.slice(26)
            if (borrower?.length === 42) {
              const r = await checkAaveHF(chainName, borrower)
              if (r?.liq && onLiq) onLiq({ chainName, borrower, protocol:'aave', ...r })
            }
          }
          if (log.topics[0] === TOPICS.BORROW) {
            const borrower = '0x' + log.topics[2]?.slice(26)
            if (borrower?.length === 42) upsertBorrower(borrower, chainName, 'aave', 999)
          }
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => {
        setConfig(`ws_${chainName}`, 'reconnecting')
        setTimeout(connect, 5000)
      })
    } catch { setTimeout(connect, 10000) }
  }
  connect()
}

// Polling scanner: checks at-risk positions every 30s
function startPoller(chainName, protocol, onLiq) {
  async function scan() {
    const atRisk = getAtRisk(chainName, protocol)
    if (atRisk.length > 0)
      console.log(`[${chainName.toUpperCase()}] Scanning ${atRisk.length} ${protocol} positions`)
    for (const pos of atRisk) {
      if (protocol === 'aave') {
        const r = await checkAaveHF(chainName, pos.address)
        if (r?.liq && onLiq) onLiq({ chainName, borrower: pos.address, protocol, ...r })
      }
      await new Promise(r => setTimeout(r, 200))
    }
  }
  scan()
  setInterval(scan, 30000)
}

export function startScanner(onLiquidatable) {
  for (const chainName of ACTIVE_CHAINS) {
    const chain = CHAINS[chainName]
    if (chain.aavePool) {
      seedFromBlocks(chainName).catch(() => {})
      startWS(chainName, onLiquidatable)
      startPoller(chainName, 'aave', onLiquidatable)
      console.log(`[${chainName.toUpperCase()}] Aave scanner started`)
    }
    await new Promise(r => setTimeout(r, 600))
  }
}
