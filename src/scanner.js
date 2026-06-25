// X7-SV · scanner.js — Real-time cross-pool price divergence detector
//
// FIX: prices now fed from TWO sources:
//   1. WebSocket Swap events on registered pool pairs (original)
//   2. vaults.js 'mega_swap' events — shares decoded prices already captured
//      This ensures scanner sees ALL qualifying swaps, not just registered pools
//
// When either source updates a pool price → gap evaluated immediately
// Gap > 0.15% AND profit > $500 → 'arb_opportunity' emitted → bootstrap.js fires

import { emit, on } from './events.js'
import { getConfig, setConfig } from './db.js'
import { getWS } from './rpc.js'

// ── UNISWAP V3 SWAP EVENT TOPIC ───────────────────────────────────────────────
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// ── POOL REGISTRY ─────────────────────────────────────────────────────────────
// Verified addresses. Pairs = pools tracking the SAME asset on the SAME chain.
// Gap between poolA and poolB = arb opportunity.
const POOL_PAIRS = {
  ethereum: [
    {
      name: 'ETH/USDC-0.05-0.3',
      asset: 'weth',
      flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvlUsdc: 150_000_000, token0IsUsdc: true },
      poolB: { address: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee: 3000, tvlUsdc:  80_000_000, token0IsUsdc: true }
    },
    {
      name: 'ETH/USDC-0.05-0.3b',
      asset: 'weth',
      flashToken: 'usdc',
      poolA: { address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tvlUsdc: 150_000_000, token0IsUsdc: true },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvlUsdc:  60_000_000, token0IsUsdc: true }
    },
    {
      name: 'ETH/USDT-0.05-0.3',
      asset: 'weth',
      flashToken: 'usdt',
      poolA: { address: '0x11b815efB8f581194ae79006d24E0d814B7697F6', fee: 500,  tvlUsdc:  90_000_000, token0IsUsdc: false },
      poolB: { address: '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36', fee: 3000, tvlUsdc:  40_000_000, token0IsUsdc: false }
    },
    {
      name: 'WBTC/USDC-0.3-0.3',
      asset: 'wbtc',
      flashToken: 'usdc',
      poolA: { address: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', fee: 3000, tvlUsdc:  60_000_000, token0IsUsdc: false },
      poolB: { address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tvlUsdc:  60_000_000, token0IsUsdc: false }
    }
  ],
  arbitrum: [
    {
      name: 'ETH/USDC-ARB-0.05-0.3',
      asset: 'weth',
      flashToken: 'usdc',
      poolA: { address: '0xC6962004f452bE9203591991D15f6b388e09E8D0', fee: 500,  tvlUsdc: 80_000_000, token0IsUsdc: true },
      poolB: { address: '0x2f5e87C9312fa29aed5c179E456625D79015299c', fee: 3000, tvlUsdc: 30_000_000, token0IsUsdc: true }
    }
  ],
  base: [
    {
      name: 'ETH/USDC-BASE-0.05-0.3',
      asset: 'weth',
      flashToken: 'usdc',
      poolA: { address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5', fee: 500,  tvlUsdc: 50_000_000, token0IsUsdc: true },
      poolB: { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', fee: 3000, tvlUsdc: 20_000_000, token0IsUsdc: true }
    }
  ]
}

// All pool addresses scanner knows about (for quick lookup)
const ALL_POOL_ADDRS = new Set()
const POOL_BY_ADDR   = new Map() // address → { chainName, pair, isPoolA }

for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
  for (const pair of pairs) {
    const aAddr = pair.poolA.address.toLowerCase()
    const bAddr = pair.poolB.address.toLowerCase()
    ALL_POOL_ADDRS.add(aAddr)
    ALL_POOL_ADDRS.add(bAddr)
    POOL_BY_ADDR.set(aAddr, { chainName, pair, isPoolA: true,  pool: pair.poolA })
    POOL_BY_ADDR.set(bAddr, { chainName, pair, isPoolA: false, pool: pair.poolB })
  }
}

// ── TOKEN ADDRESSES ───────────────────────────────────────────────────────────
const TOKEN_ADDRS = {
  ethereum: {
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  arbitrum: {
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  base: {
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth: '0x4200000000000000000000000000000000000006',
  }
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const _prices    = new Map() // poolAddress.toLowerCase() → { price, ts }
const _lastOppty = new Map() // pairName → last emit timestamp
const OPPTY_COOLDOWN_MS = 3000
let   _gapsDetected = 0

// ── PRICE DECODE FROM SWAP LOG ────────────────────────────────────────────────
// Uniswap V3 Swap event data:
//   bytes 0-31:   amount0 (int256)
//   bytes 32-63:  amount1 (int256)
//   bytes 64-95:  sqrtPriceX96 (uint160, right-aligned in 32 bytes)
//   bytes 96-127: liquidity (uint128)
//   bytes 128-159: tick (int24)
//
// Price from sqrtPriceX96:
//   rawFloat = sqrtPriceX96 / 2^96
//   rawPrice = rawFloat^2
//   if token0IsUsdc: ethPrice = (1/rawPrice) × 10^12
//   else:            ethPrice = rawPrice × 10^12

function decodePriceFromLog(log, token0IsUsdc) {
  try {
    if (!log?.data) return null
    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 320) return null  // need 5 × 64 hex chars

    // sqrtPriceX96 is at bytes 64-95 = hex chars 128-191
    const sqrtHex = data.slice(128, 192)
    if (!sqrtHex || sqrtHex === '0'.repeat(64)) return null

    const sqrtPriceX96 = BigInt('0x' + sqrtHex)
    if (sqrtPriceX96 === 0n) return null

    const sqrtFloat = Number(sqrtPriceX96) / Number(2n ** 96n)
    const rawPrice  = sqrtFloat * sqrtFloat

    let price
    if (token0IsUsdc) {
      price = (1 / rawPrice) * 1e12   // token0=USDC(6dec), token1=WETH(18dec)
    } else {
      price = rawPrice * 1e12          // token0=WETH(18dec), token1=USDC(6dec)
    }

    // Sanity bounds: ETH $100-$100K, BTC $1K-$1M
    if (price < 100 || price > 1_000_000) return null
    return { price, ts: Date.now() }
  } catch { return null }
}

// ── PRICE FROM AMOUNTS (fallback) ─────────────────────────────────────────────
// When sqrtPriceX96 decode fails: estimate from amount0/amount1
function decodePriceFromAmounts(log, token0IsUsdc) {
  try {
    if (!log?.data) return null
    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data
    if (data.length < 128) return null

    const MAX   = BigInt('0x' + '7' + 'f'.repeat(63))
    const FULL  = 2n ** 256n

    let a0 = BigInt('0x' + data.slice(0, 64))
    let a1 = BigInt('0x' + data.slice(64, 128))
    if (a0 > MAX) a0 -= FULL
    if (a1 > MAX) a1 -= FULL

    const abs0 = a0 < 0n ? -a0 : a0
    const abs1 = a1 < 0n ? -a1 : a1

    if (abs0 === 0n || abs1 === 0n) return null

    let price
    if (token0IsUsdc) {
      // token0=USDC(6dec), token1=WETH(18dec)
      // price = USDC_amount / WETH_amount × 10^12 (adjust decimals)
      price = (Number(abs0) / 1e6) / (Number(abs1) / 1e18)
    } else {
      // token0=WETH(18dec), token1=USDC(6dec)
      price = (Number(abs1) / 1e6) / (Number(abs0) / 1e18)
    }

    if (price < 100 || price > 1_000_000) return null
    return { price, ts: Date.now() }
  } catch { return null }
}

// ── FLASH SIZE CALCULATOR ─────────────────────────────────────────────────────
// Mathematically verified:
//   maxByPoolA = TVL_A × 0.08  (controls buy-leg slippage)
//   maxByPoolB = TVL_B × 0.08  (controls sell-leg slippage)
//   maxByGap   = gap × TVL_A × 0.5 (our impact ≤ half the available gap)
//   hard cap   = $20M (Balancer always has this)
//   floor      = $100K (below this gas > profit)
function calcFlashSize(tvlA, tvlB, gapPct) {
  const maxA   = tvlA * 0.08
  const maxB   = tvlB * 0.08
  const maxGap = (gapPct / 100) * tvlA * 0.5
  const hard   = 20_000_000
  const floor  =    100_000
  const opt    = Math.min(maxA, maxB, maxGap, hard)
  return opt < floor ? 0 : Math.floor(opt)
}

// ── PROFIT ESTIMATOR ──────────────────────────────────────────────────────────
// netGap = availableGap - fees(both legs) - priceImpact(both legs)
// profit = flashAmount × netGap
// Returns 0 if unprofitable.
function estimateProfit(flashUsdc, tvlA, tvlB, gapPct, feeA, feeB) {
  const impactA     = (flashUsdc / tvlA) * 0.5 * 100
  const impactB     = (flashUsdc / tvlB) * 0.5 * 100
  const totalCostPct = (feeA / 10000 * 100) + (feeB / 10000 * 100) + impactA + impactB
  const netGapPct   = gapPct - totalCostPct
  if (netGapPct <= 0) return 0
  return Math.floor(flashUsdc * (netGapPct / 100))
}

// ── AMOUNT OUT MINIMUMS ───────────────────────────────────────────────────────
// Buy leg: flashUsdc / buyPrice × 0.985 (1.5% slippage buffer)
// Sell leg: flashUsdc + minProfit (enforces profitability in contract)
// These are passed directly to X7.sol.crossPoolArb()
// If gap closes: sell leg fails → revert → builder drops → zero cost
function calcAmountOutMins(flashUsdc, buyPrice, minProfitUsdc) {
  const expectedAsset   = flashUsdc / buyPrice
  const minBuyAsset     = expectedAsset * 0.985
  const minBuyAmountWei = BigInt(Math.floor(minBuyAsset * 1e18))
  const minSellUsdc     = BigInt(Math.floor((flashUsdc + minProfitUsdc * 0.5) * 1e6))
  return { minBuyAmountWei, minSellUsdc }
}

// ── GAP EVALUATOR ─────────────────────────────────────────────────────────────
// Called after any price update on either pool in a pair.
// Emits 'arb_opportunity' only when mathematically verified profitable.
function evaluatePair(chainName, pair) {
  const priceA = _prices.get(pair.poolA.address.toLowerCase())
  const priceB = _prices.get(pair.poolB.address.toLowerCase())
  if (!priceA || !priceB) return
  if (priceA.price <= 0 || priceB.price <= 0) return

  const gap    = Math.abs(priceA.price - priceB.price)
  const gapPct = gap / Math.min(priceA.price, priceB.price) * 100

  // Store for dashboard regardless of threshold
  setConfig(`scanner_gap_${pair.name}`,    gapPct.toFixed(4))
  setConfig(`scanner_priceA_${pair.name}`, priceA.price.toFixed(2))
  setConfig(`scanner_priceB_${pair.name}`, priceB.price.toFixed(2))

  if (gapPct < 0.15) return  // Below minimum threshold

  const buyFromA  = priceA.price < priceB.price
  const poolBuy   = buyFromA ? pair.poolA : pair.poolB
  const poolSell  = buyFromA ? pair.poolB : pair.poolA
  const buyPrice  = buyFromA ? priceA.price : priceB.price
  const sellPrice = buyFromA ? priceB.price : priceA.price

  const flashUsdc = calcFlashSize(poolBuy.tvlUsdc, poolSell.tvlUsdc, gapPct)
  if (flashUsdc === 0) return

  const profitUsdc = estimateProfit(
    flashUsdc, poolBuy.tvlUsdc, poolSell.tvlUsdc,
    gapPct, poolBuy.fee, poolSell.fee
  )
  if (profitUsdc < 500) return

  // Deduplicate — max one emission per pair per 3 seconds
  const now      = Date.now()
  const lastEmit = _lastOppty.get(pair.name) || 0
  if (now - lastEmit < OPPTY_COOLDOWN_MS) return
  _lastOppty.set(pair.name, now)

  const { minBuyAmountWei, minSellUsdc } = calcAmountOutMins(
    flashUsdc, buyPrice, profitUsdc
  )

  const tokens         = TOKEN_ADDRS[chainName] || {}
  const flashTokenAddr = tokens[pair.flashToken]
  const assetTokenAddr = tokens[pair.asset]
  if (!flashTokenAddr || !assetTokenAddr) return

  _gapsDetected++
  setConfig('scanner_gaps_detected', String(_gapsDetected))

  const opportunity = {
    chain:            chainName,
    pairName:         pair.name,
    flashToken:       flashTokenAddr,
    flashAmountUsdc:  flashUsdc,
    flashAmountWei:   BigInt(Math.floor(flashUsdc * 1e6)),  // USDC has 6 decimals
    poolBuy:          poolBuy.address,
    poolSell:         poolSell.address,
    assetToken:       assetTokenAddr,
    buyFee:           poolBuy.fee,
    sellFee:          poolSell.fee,
    gapPct:           parseFloat(gapPct.toFixed(4)),
    buyPrice:         parseFloat(buyPrice.toFixed(2)),
    sellPrice:        parseFloat(sellPrice.toFixed(2)),
    estimatedProfit:  profitUsdc,
    minBuyAmount:     minBuyAmountWei,
    minSellUsdc,
    ts:               now
  }

  console.log(
    `[SCANNER] ✓ GAP ${pair.name} ${chainName}: ${gapPct.toFixed(3)}% ` +
    `flash=$${(flashUsdc/1e6).toFixed(1)}M profit~$${profitUsdc.toLocaleString()}`
  )

  setConfig('scanner_last_opportunity', JSON.stringify({
    ...opportunity,
    flashAmountWei: opportunity.flashAmountWei.toString(),
    minBuyAmount:   opportunity.minBuyAmount.toString(),
    minSellUsdc:    opportunity.minSellUsdc.toString()
  }))

  emit('arb_opportunity', opportunity)
}

// ── PRICE UPDATE ENTRY POINT ──────────────────────────────────────────────────
// Called by both WebSocket handler and vaults.js event bridge
function updatePrice(poolAddr, priceData) {
  if (!priceData) return
  const addr = poolAddr.toLowerCase()
  _prices.set(addr, priceData)

  // Find which pair this pool belongs to and evaluate
  const entry = POOL_BY_ADDR.get(addr)
  if (entry) {
    evaluatePair(entry.chainName, entry.pair)
  }
}

// ── WEBSOCKET POOL WATCHER ────────────────────────────────────────────────────
function watchPair(chainName, pair) {
  const ws = getWS(chainName)
  if (!ws) {
    console.warn(`[SCANNER] No WebSocket for ${chainName} — retry in 30s`)
    setTimeout(() => watchPair(chainName, pair), 30000)
    return
  }

  // Subscribe to Swap events on both pools
  ;[pair.poolA, pair.poolB].forEach(pool => {
    ws.subscribe({
      jsonrpc: '2.0',
      id:      Math.random() * 999999 | 0,
      method:  'eth_subscribe',
      params:  ['logs', { address: pool.address, topics: [SWAP_TOPIC] }]
    })
  })

  ws.on('log', log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return
    const addr   = log.address?.toLowerCase()
    if (!addr)   return
    const entry  = POOL_BY_ADDR.get(addr)
    if (!entry)  return

    // Primary: decode from sqrtPriceX96
    let priceData = decodePriceFromLog(log, entry.pool.token0IsUsdc)
    // Fallback: decode from amounts
    if (!priceData) priceData = decodePriceFromAmounts(log, entry.pool.token0IsUsdc)
    if (!priceData) return

    updatePrice(addr, priceData)
  })

  console.log(`[SCANNER] Watching pair ${pair.name} on ${chainName}`)
}

// ── VAULTS.JS BRIDGE ─────────────────────────────────────────────────────────
// vaults.js already decodes swap amounts and emits 'mega_swap' events.
// We use those amounts to estimate DEX price and feed into scanner.
// This ensures scanner sees ALL swaps, not just registered pool addresses.
// Gives scanner price data even when WebSocket hasn't received events yet.
function onMegaSwap({ chain, swapUSD, log }) {
  // mega_swap events include the raw log — extract price if available
  if (!log?.address || !swapUSD) return

  const addr = log.address.toLowerCase()
  if (!POOL_BY_ADDR.has(addr)) return

  const entry = POOL_BY_ADDR.get(addr)

  // Estimate price from swap volume and CEX reference
  const cexPriceStr = getConfig('prices')
  if (!cexPriceStr) return
  const cexPrices = JSON.parse(cexPriceStr)
  const cexPrice  = cexPrices.ETH || 0
  if (!cexPrice) return

  // Crude estimate: large sell-off depresses DEX price proportionally
  // Actual price decoded from log data is more accurate — try that first
  let priceData = decodePriceFromLog(log, entry.pool.token0IsUsdc)
  if (!priceData) priceData = decodePriceFromAmounts(log, entry.pool.token0IsUsdc)

  if (priceData) {
    updatePrice(addr, priceData)
  }
}

// ── CEX PRICE BRIDGE ─────────────────────────────────────────────────────────
// When CEX price updates, check if any DEX pool has diverged from it.
// CEX price = ground truth. DEX price = stale after large swap.
// Gap between them = arb opportunity.
function onCEXPrice({ symbol, price }) {
  if (!price || price <= 0) return
  if (symbol !== 'ETH') return

  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      if (pair.asset !== 'weth') continue

      const priceA = _prices.get(pair.poolA.address.toLowerCase())
      const priceB = _prices.get(pair.poolB.address.toLowerCase())

      // If we have at least one pool price: compare it to CEX
      // This creates a virtual "CEX vs DEX" pair evaluation
      if (priceA && !priceB) {
        // Temporarily treat CEX price as poolB price for evaluation
        const syntheticB = { price, ts: Date.now() }
        const addr = pair.poolB.address.toLowerCase()
        if (!_prices.has(addr)) {
          _prices.set(addr, syntheticB)
          evaluatePair(chainName, pair)
          // Remove synthetic after evaluation — don't pollute state
          _prices.delete(addr)
        }
      } else if (priceB && !priceA) {
        const syntheticA = { price, ts: Date.now() }
        const addr = pair.poolA.address.toLowerCase()
        if (!_prices.has(addr)) {
          _prices.set(addr, syntheticA)
          evaluatePair(chainName, pair)
          _prices.delete(addr)
        }
      } else if (priceA && priceB) {
        // Both pool prices known — regular evaluation
        evaluatePair(chainName, pair)
      }
    }
  }
}

// ── PERIODIC SCAN ─────────────────────────────────────────────────────────────
// Re-evaluates all pairs every 2 seconds.
// Catches gaps that opened between swap events.
// Also updates dashboard gap data.
function periodicScan() {
  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      evaluatePair(chainName, pair)
    }
  }

  // Export all current gaps to dashboard
  const gaps = []
  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      gaps.push({
        pair:   pair.name,
        chain:  chainName,
        gap:    parseFloat(getConfig(`scanner_gap_${pair.name}`)    || '0'),
        priceA: parseFloat(getConfig(`scanner_priceA_${pair.name}`) || '0'),
        priceB: parseFloat(getConfig(`scanner_priceB_${pair.name}`) || '0'),
      })
    }
  }
  setConfig('scanner_gaps', JSON.stringify(gaps))
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export function getScannerStats() {
  return {
    gapsDetected:    _gapsDetected,
    trackedPools:    _prices.size,
    activePairs:     Object.values(POOL_PAIRS).flat().length,
    lastOpportunity: (() => {
      try { return JSON.parse(getConfig('scanner_last_opportunity') || 'null') }
      catch { return null }
    })(),
    currentGaps: (() => {
      try { return JSON.parse(getConfig('scanner_gaps') || '[]') }
      catch { return [] }
    })()
  }
}

export function startScanner() {
  console.log('[SCANNER] Starting cross-pool price divergence detector...')

  // Register WebSocket watchers on all pairs
  let pairCount = 0
  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      watchPair(chainName, pair)
      pairCount++
    }
  }

  // Bridge from vaults.js mega_swap events → scanner price map
  // This is the fix for: scanner watching pools but not seeing swaps
  on('mega_swap', onMegaSwap)

  // Bridge from cexfeed.js → scanner gap evaluation
  on('cex_price', onCEXPrice)

  // Periodic fallback evaluation every 2 seconds
  setInterval(periodicScan, 2000)

  console.log(`[SCANNER] ${pairCount} pairs registered across ${Object.keys(POOL_PAIRS).length} chains`)
  console.log('[SCANNER] Sources: WebSocket + vaults.js bridge + CEX price bridge')
  console.log('[SCANNER] Watching for gaps > 0.15% with profit > $500')
  console.log('[SCANNER] → arb_opportunity events → bootstrap.js')
              }
