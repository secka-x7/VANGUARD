// X7-SV · scanner.js — ALL chains · ALL pairs · sub-50ms · active slot0 fetch
//
// KEY FIXES:
//   1. Uses rpc.js multi-handler (fixed above) — no longer overwritten by vaults.js
//   2. When Pool A fires, actively fetches Pool B price via slot0() RPC
//      instead of waiting for Pool B to emit a Swap event
//   3. Same ws.on('log') pattern as vaults.js — proven to receive logs

import { rpcCall, getWS }        from './rpc.js'
import { getConfig, setConfig }  from './db.js'
import { emit }                  from './events.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// slot0() selector — returns sqrtPriceX96 as first return value
const SLOT0_SELECTOR = '0x3850c7bd'

// ── POOL PAIRS ────────────────────────────────────────────────────────────────
// Both pools in each pair track the SAME asset pair on the SAME chain
// Pool A and Pool B differ only in fee tier → price gaps form after large swaps
const POOL_PAIRS = {
  ethereum: [
    {
      name: 'ETH/USDC-0.05%-0.3%',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvl: 150_000_000, token0IsFlash: true  },
      poolB: { address: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee: 3000, tvl: 80_000_000,  token0IsFlash: true  },
    },
    {
      name: 'ETH/USDC-0.05%-0.3%b',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvl: 150_000_000, token0IsFlash: true  },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvl: 60_000_000,  token0IsFlash: true  },
    },
    {
      name: 'WBTC/USDC-0.3%-0.3%',
      asset: 'wbtc', flashToken: 'usdc',
      poolA: { address: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', fee: 3000, tvl: 60_000_000,  token0IsFlash: false },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvl: 60_000_000,  token0IsFlash: false },
    },
  ],
  arbitrum: [
    {
      name: 'ETH/USDC-ARB-0.05%-0.3%',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0xC6962004f452bE9203591991D15f6b388e09E8D0', fee: 500,  tvl: 80_000_000,  token0IsFlash: true  },
      poolB: { address: '0x2f5e87C9312fa29aed5c179E456625D79015299c', fee: 3000, tvl: 30_000_000,  token0IsFlash: true  },
    },
  ],
  polygon: [
    {
      name: 'ETH/USDC-POLY-0.05%-0.3%',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x45dDa9cb7c25131DF268515131f647d726f50608', fee: 500,  tvl: 50_000_000,  token0IsFlash: true  },
      poolB: { address: '0x50eaEDB835021E4A108B7290636d62E9765cc6d7', fee: 3000, tvl: 20_000_000,  token0IsFlash: true  },
    },
  ],
  base: [
    {
      name: 'ETH/USDC-BASE-0.05%-0.3%',
      asset: 'weth', flashToken: 'usdc',
      poolA: { address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5', fee: 500,  tvl: 50_000_000,  token0IsFlash: true  },
      poolB: { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', fee: 3000, tvl: 20_000_000,  token0IsFlash: true  },
    },
  ],
}

// Token addresses per chain
const TOKENS = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  arbitrum: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  polygon: {
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth: '0x4200000000000000000000000000000000000006',
  },
}

const BALANCER = {
  ethereum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  arbitrum: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  polygon:  '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  base:     null,
}

const AAVE = {
  ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  polygon:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const _prices   = new Map()  // `${chain}:${poolAddr}` → { price, ts }
const _lastEmit = new Map()  // pairName → ts
const COOLDOWN  = 2000

// ── PRICE FROM sqrtPriceX96 ───────────────────────────────────────────────────
// Same data layout as vaults.js decodeAmounts — verified correct
// Swap event data: amount0(32) amount1(32) sqrtPriceX96(32) liquidity(32) tick(32)
function priceFromSqrt(sqrtPriceX96Hex, token0IsFlash) {
  try {
    const sq  = BigInt('0x' + sqrtPriceX96Hex)
    if (sq === 0n) return null
    const f   = Number(sq) / Number(2n ** 96n)
    const raw = f * f
    // token0IsFlash=true  → token0=USDC(6dec), token1=WETH(18dec) → price = 1/raw * 1e12
    // token0IsFlash=false → token0=WETH(18dec), token1=USDC(6dec) → price = raw * 1e12
    const price = token0IsFlash ? (1 / raw) * 1e12 : raw * 1e12
    if (price < 100 || price > 1_000_000) return null
    return price
  } catch { return null }
}

// ── DECODE PRICE FROM SWAP LOG ────────────────────────────────────────────────
function decodeLogPrice(log, token0IsFlash) {
  try {
    if (!log.data) return null
    const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (hex.length < 320) return null
    // sqrtPriceX96 at chars 128-192 (after amount0[64] + amount1[64])
    const sqrtHex = hex.slice(128, 192)
    return priceFromSqrt(sqrtHex, token0IsFlash)
  } catch { return null }
}

// ── FETCH PRICE VIA slot0() RPC ───────────────────────────────────────────────
// Called when we have a fresh price for Pool A but Pool B is stale/missing
// slot0() returns: sqrtPriceX96, tick, observationIndex, ...
// ABI: function slot0() returns (uint160,int24,uint16,uint16,uint16,uint8,bool)
async function fetchSlot0Price(chainName, poolAddr, token0IsFlash) {
  try {
    const result = await rpcCall(chainName, 'eth_call', [
      { to: poolAddr, data: SLOT0_SELECTOR },
      'latest'
    ])
    if (!result || result === '0x') return null
    // result is ABI-encoded: first 32 bytes = sqrtPriceX96 (uint160)
    const hex     = result.startsWith('0x') ? result.slice(2) : result
    const sqrtHex = hex.slice(0, 64)
    return priceFromSqrt(sqrtHex, token0IsFlash)
  } catch { return null }
}

// ── OPPORTUNITY CALCULATOR ────────────────────────────────────────────────────
function calcOpportunity(chainName, pair, priceA, priceB) {
  const gap    = Math.abs(priceA - priceB)
  const minP   = Math.min(priceA, priceB)
  const gapPct = gap / minP * 100

  if (gapPct < 0.15) return null

  const buyFromA = priceA < priceB
  const poolBuy  = buyFromA ? pair.poolA : pair.poolB
  const poolSell = buyFromA ? pair.poolB : pair.poolA
  const buyPrice = buyFromA ? priceA : priceB

  // Flash size: 8% of smaller pool TVL, $100K floor, $20M cap
  const minTVL    = Math.min(poolBuy.tvl, poolSell.tvl)
  const flashUsdc = Math.min(Math.max(minTVL * 0.08, 100_000), 20_000_000)

  // Cost: pool fees + price impact (quadratic approx)
  const impactBuy  = (flashUsdc / poolBuy.tvl)  * 0.5 * 100
  const impactSell = (flashUsdc / poolSell.tvl) * 0.5 * 100
  const feePct     = (poolBuy.fee + poolSell.fee) / 10000 * 100
  const flashFee   = BALANCER[chainName] ? 0 : 0.09
  const netGap     = gapPct - feePct - impactBuy - impactSell - flashFee

  if (netGap <= 0) return null

  const profitUsdc = Math.floor(flashUsdc * netGap / 100)
  if (profitUsdc < 500) return null

  // amountOutMinimums — 2% slippage buffer, demand only 50% of estimate
  const expectedAsset  = flashUsdc / buyPrice
  const assetDecimals  = pair.asset === 'wbtc' ? 1e8 : 1e18
  const minBuyAmount   = BigInt(Math.floor(expectedAsset * 0.98 * assetDecimals))
  const flashAmountWei = BigInt(Math.floor(flashUsdc * 1e6))
  const minSellUsdc    = flashAmountWei + BigInt(Math.floor(profitUsdc * 0.5 * 1e6))

  const tokens = TOKENS[chainName] || {}

  return {
    chain:           chainName,
    pairName:        pair.name,
    flashToken:      tokens[pair.flashToken],
    assetToken:      tokens[pair.asset],
    flashAmountUsdc: flashUsdc,
    flashAmountWei,
    poolBuy:         poolBuy.address,
    poolSell:        poolSell.address,
    buyFee:          poolBuy.fee,
    sellFee:         poolSell.fee,
    gapPct:          parseFloat(gapPct.toFixed(4)),
    buyPrice:        parseFloat(buyPrice.toFixed(2)),
    profitUsdc,
    minBuyAmount,
    minSellUsdc,
    balancer:        BALANCER[chainName] || null,
    aave:            AAVE[chainName]     || null,
    ts:              Date.now()
  }
}

// ── EVALUATE PAIR ─────────────────────────────────────────────────────────────
// Called immediately when ANY pool in the pair gets a fresh price
// Fetches the OTHER pool via slot0() if stale — never waits
async function evaluatePair(chainName, pair, updatedPool) {
  const keyA = `${chainName}:${pair.poolA.address.toLowerCase()}`
  const keyB = `${chainName}:${pair.poolB.address.toLowerCase()}`
  const now  = Date.now()

  let priceA = _prices.get(keyA)?.price
  let priceB = _prices.get(keyB)?.price

  const staleA = !priceA || (now - (_prices.get(keyA)?.ts || 0)) > 30000
  const staleB = !priceB || (now - (_prices.get(keyB)?.ts || 0)) > 30000

  // Actively fetch whichever pool is stale — don't wait for its Swap event
  if (staleA && updatedPool !== 'A') {
    const p = await fetchSlot0Price(chainName, pair.poolA.address, pair.poolA.token0IsFlash)
    if (p) { priceA = p; _prices.set(keyA, { price: p, ts: now }) }
  }
  if (staleB && updatedPool !== 'B') {
    const p = await fetchSlot0Price(chainName, pair.poolB.address, pair.poolB.token0IsFlash)
    if (p) { priceB = p; _prices.set(keyB, { price: p, ts: now }) }
  }

  if (!priceA || !priceB) return

  const opp = calcOpportunity(chainName, pair, priceA, priceB)
  if (!opp) return

  // Cooldown per pair
  const last = _lastEmit.get(pair.name) || 0
  if (now - last < COOLDOWN) return
  _lastEmit.set(pair.name, now)

  const total = parseInt(getConfig('scanner_gaps_detected') || '0') + 1
  setConfig('scanner_gaps_detected', String(total))

  console.log(
    `[SCANNER] *** GAP ${pair.name} | ${opp.gapPct.toFixed(3)}% | ` +
    `flash $${(opp.flashAmountUsdc/1e6).toFixed(1)}M | ` +
    `profit ~$${opp.profitUsdc.toLocaleString()} | ${chainName}`
  )

  emit('arb_opportunity', opp)
}

// ── WATCH CHAIN ───────────────────────────────────────────────────────────────
// Exact same ws.on('log') pattern as vaults.js
// rpc.js now supports multiple handlers — both vaults and scanner receive logs
function watchChain(chainName) {
  const pairs = POOL_PAIRS[chainName]
  if (!pairs?.length) return

  const ws = getWS(chainName)
  if (!ws) {
    console.warn(`[SCANNER] No WS for ${chainName} — retry 15s`)
    setTimeout(() => watchChain(chainName), 15000)
    return
  }

  // Collect all unique pool addresses + build lookup
  const allPools    = new Set()
  const poolToPairs = new Map() // poolAddr → [{ pair, side:'A'|'B', pool }]

  for (const pair of pairs) {
    for (const [side, pool] of [['A', pair.poolA], ['B', pair.poolB]]) {
      const addr = pool.address.toLowerCase()
      allPools.add(pool.address)
      if (!poolToPairs.has(addr)) poolToPairs.set(addr, [])
      poolToPairs.get(addr).push({ pair, side, pool })
    }
  }

  // Subscribe to all pools on this chain
  allPools.forEach(addr => {
    ws.subscribe({
      jsonrpc: '2.0',
      id:      Math.random() * 99999 | 0,
      method:  'eth_subscribe',
      params:  ['logs', { address: addr, topics: [SWAP_TOPIC] }]
    })
  })

  // Register handler — rpc.js now calls ALL handlers, not just the last one
  ws.on('log', log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return
    const poolAddr = log.address?.toLowerCase()
    if (!poolAddr) return

    const entries = poolToPairs.get(poolAddr)
    if (!entries?.length) return

    for (const { pair, side, pool } of entries) {
      const price = decodeLogPrice(log, pool.token0IsFlash)
      if (!price) continue

      const key = `${chainName}:${poolAddr}`
      _prices.set(key, { price, ts: Date.now() })

      // Evaluate immediately — fetch other pool's price if stale
      evaluatePair(chainName, pair, side).catch(() => {})
    }
  })

  console.log(`[SCANNER] ${chainName}: ${allPools.size} pools · ${pairs.length} pairs`)
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export function getScannerStats() {
  return {
    gapsDetected:  parseInt(getConfig('scanner_gaps_detected') || '0'),
    trackedPrices: _prices.size,
    activePairs:   Object.values(POOL_PAIRS).flat().length,
  }
}

export function startScanner() {
  console.log('[SCANNER] Starting — ALL chains · ALL pairs · active slot0 fetch')

  for (const chainName of Object.keys(POOL_PAIRS)) {
    watchChain(chainName)
  }

  const totalPairs = Object.values(POOL_PAIRS).flat().length
  const totalPools = Object.values(POOL_PAIRS).flat().reduce((s) => s + 2, 0)
  console.log(`[SCANNER] ${totalPairs} pairs · ${totalPools} pools · ${Object.keys(POOL_PAIRS).length} chains`)
  console.log('[SCANNER] Gap threshold: 0.15% | Min profit: $500 | slot0 active fetch on stale pools')
  }
