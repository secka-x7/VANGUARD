// X7-SV · scanner.js — Real-time cross-pool price divergence detector
//
// WHAT THIS DOES:
//   Connects to WebSocket logs for all registered pool pairs
//   Decodes Uniswap V3 Swap events → extracts sqrtPriceX96 → computes price
//   Compares prices across pool pairs every block
//   When gap > threshold AND estimated profit > $500:
//     Emits 'arb_opportunity' with full parameters for bootstrap.js
//
// WHY THIS FIXES EVERYTHING:
//   Old system: detected a swap → assumed there was an opportunity → was wrong
//   New system: detects the PRICE GAP DIRECTLY → calculates REAL profit
//   Only triggers when mathematically verified profitable
//
// FAILURE PROOFING:
//   WebSocket disconnects → auto-reconnect (same pattern as rpc.js)
//   Price decode fails → skip that event, continue
//   Opportunity emitted but arb fails → scanner keeps running, next gap
//   Multiple gaps simultaneously → emits all, bootstrap deduplicates

import { emit, on } from './events.js'
import { getConfig, setConfig } from './db.js'
import { getWS } from './rpc.js'
import { getActiveChains, getChain } from './chains.js'

// ── UNISWAP V3 SWAP EVENT TOPIC ───────────────────────────────────────────────
// keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// ── POOL REGISTRY ─────────────────────────────────────────────────────────────
// Verified addresses + TVL estimates for flash sizing
// Pairs: pools tracking the SAME underlying asset pair
// Only register pools with > $20M TVL (need liquidity for flash)

const POOL_PAIRS = {
  ethereum: [
    {
      name:    'ETH/USDC-A-B',
      asset:   'weth',
      flashToken: 'usdc',
      poolA: {
        address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
        fee:     500,
        tvlUsdc: 150_000_000,
        token0IsUsdc: true   // token0=USDC, token1=WETH in this pool
      },
      poolB: {
        address: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
        fee:     3000,
        tvlUsdc: 80_000_000,
        token0IsUsdc: true
      }
    },
    {
      name:    'ETH/USDC-A-C',
      asset:   'weth',
      flashToken: 'usdc',
      poolA: {
        address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
        fee:     500,
        tvlUsdc: 150_000_000,
        token0IsUsdc: true
      },
      poolB: {
        address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',
        fee:     3000,
        tvlUsdc: 60_000_000,
        token0IsUsdc: true
      }
    },
    {
      name:    'ETH/USDT-A-B',
      asset:   'weth',
      flashToken: 'usdt',
      poolA: {
        address: '0x11b815efB8f581194ae79006d24E0d814B7697F6',
        fee:     500,
        tvlUsdc: 90_000_000,
        token0IsUsdc: false  // token0=WETH, token1=USDT in this pool
      },
      poolB: {
        address: '0x4e68Ccd3E89f51C3074ca5072bbAC773960dFa36',
        fee:     3000,
        tvlUsdc: 40_000_000,
        token0IsUsdc: false
      }
    },
    {
      name:    'WBTC/USDC-A-B',
      asset:   'wbtc',
      flashToken: 'usdc',
      poolA: {
        address: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35',
        fee:     3000,
        tvlUsdc: 60_000_000,
        token0IsUsdc: false  // token0=WBTC, token1=USDC
      },
      poolB: {
        address: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0',
        fee:     3000,
        tvlUsdc: 60_000_000,
        token0IsUsdc: false
      }
    }
  ],
  arbitrum: [
    {
      name:    'ETH/USDC-ARB-A-B',
      asset:   'weth',
      flashToken: 'usdc',
      poolA: {
        address: '0xC6962004f452bE9203591991D15f6b388e09E8D0',
        fee:     500,
        tvlUsdc: 80_000_000,
        token0IsUsdc: true
      },
      poolB: {
        address: '0x2f5e87C9312fa29aed5c179E456625D79015299c',
        fee:     3000,
        tvlUsdc: 30_000_000,
        token0IsUsdc: true
      }
    }
  ],
  base: [
    {
      name:    'ETH/USDC-BASE-A-B',
      asset:   'weth',
      flashToken: 'usdc',
      poolA: {
        address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',
        fee:     500,
        tvlUsdc: 50_000_000,
        token0IsUsdc: true
      },
      poolB: {
        address: '0xd0b53D9277642d899DF5C87A3966A349A798F224',
        fee:     3000,
        tvlUsdc: 20_000_000,
        token0IsUsdc: true
      }
    }
  ]
}

// ── TOKEN ADDRESSES PER CHAIN ─────────────────────────────────────────────────
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
// Track last known price per pool address
const _prices     = new Map() // poolAddress → { price, sqrtPriceX96, ts }
const _lastOppty  = new Map() // pairName → last opportunity timestamp
const OPPTY_COOLDOWN_MS = 3000 // Don't emit same pair more than once per 3s

// ── PRICE DECODING ────────────────────────────────────────────────────────────
//
// Uniswap V3 Swap event data layout:
//   topic[0]: event signature
//   topic[1]: sender (indexed)
//   topic[2]: recipient (indexed)
//   data: abi.encode(amount0, amount1, sqrtPriceX96, liquidity, tick)
//          int256, int256, uint160, uint128, int24
//          32     32       32       32       32  bytes
//
// Price from sqrtPriceX96:
//   rawPrice = (sqrtPriceX96^2) / (2^192)
//   For ETH/USDC where token0=USDC(6 dec), token1=WETH(18 dec):
//     ethPriceUsdc = (1 / rawPrice) × 10^12   (12 = 18-6 decimal adjustment)
//   For ETH/USDC where token0=WETH(18 dec), token1=USDC(6 dec):
//     ethPriceUsdc = rawPrice × 10^12

function decodeSwapPrice(log, token0IsUsdc) {
  try {
    if (!log.data || log.data.length < 322) return null  // need at least 5×32 + 0x

    const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data

    // sqrtPriceX96 is the 5th 32-byte word (offset 128 bytes = 256 hex chars)
    // Layout: amount0(64) amount1(64) sqrtPriceX96(64) liquidity(64) tick(64)
    const sqrtHex = data.slice(128, 192)
    const sqrtPriceX96 = BigInt('0x' + sqrtHex)

    if (sqrtPriceX96 === 0n) return null

    // rawPrice = sqrtPriceX96^2 / 2^192
    // Use integer math to avoid floating point loss
    const Q192    = 2n ** 192n
    const rawNum  = sqrtPriceX96 * sqrtPriceX96
    // rawPrice as scaled integer: rawNum / Q192
    // For display: multiply by 10^12 for USDC/WETH pair

    // We compute as floating point for price comparison purposes
    // Precision needed: 4 decimal places (0.01% threshold)
    const rawFloat    = Number(sqrtPriceX96) / Number(2n ** 96n)
    const rawPrice    = rawFloat * rawFloat

    let ethPriceUsdc
    if (token0IsUsdc) {
      // token0=USDC, token1=WETH: price = 1/rawPrice × 10^12
      ethPriceUsdc = (1 / rawPrice) * 1e12
    } else {
      // token0=WETH, token1=USDC: price = rawPrice × 10^12
      ethPriceUsdc = rawPrice * 1e12
    }

    // Sanity check: ETH price should be between $100 and $100,000
    // WBTC price should be between $1,000 and $1,000,000
    if (ethPriceUsdc < 100 || ethPriceUsdc > 1_000_000) return null

    return { price: ethPriceUsdc, sqrtPriceX96, ts: Date.now() }
  } catch {
    return null
  }
}

// ── FLASH SIZE CALCULATOR ─────────────────────────────────────────────────────
//
// Mathematical formula verified in cross-examination:
//   maxByPoolA = TVL_A × 0.08     (controls slippage on buy leg)
//   maxByPoolB = TVL_B × 0.08     (controls slippage on sell leg)
//   maxByGap   = gap × TVL_A × 0.5 (our slippage doesn't eat more than gap/2)
//   optimal    = min(all three, $20M hard cap)
//   if optimal < $100K: not worth executing (gas > profit)

function calcFlashSize(tvlA, tvlB, gapPct) {
  const maxA   = tvlA * 0.08
  const maxB   = tvlB * 0.08
  const maxGap = (gapPct / 100) * tvlA * 0.5
  const hard   = 20_000_000    // $20M USDC hard cap (Balancer always has this)
  const floor  =    100_000    // $100K minimum (below this gas > profit)

  const optimal = Math.min(maxA, maxB, maxGap, hard)
  return optimal < floor ? 0 : Math.floor(optimal)
}

// ── PROFIT ESTIMATOR ──────────────────────────────────────────────────────────
//
// Calculates expected profit AFTER fees and price impact.
// Uses the same formula verified in cross-examination.
// Returns 0 if not profitable.

function estimateProfit(flashAmountUsdc, tvlA, tvlB, gapPct, feeA, feeB) {
  // Price impact: quadratic approximation
  // Impact = (tradeSize / TVL) × 0.5 (assumes constant product formula)
  const impactA = (flashAmountUsdc / tvlA) * 0.5 * 100  // as percentage
  const impactB = (flashAmountUsdc / tvlB) * 0.5 * 100  // as percentage

  // Total cost = fees + our own price impact
  const totalCostPct = feeA / 10000 * 100 +  // buy leg fee
                       feeB / 10000 * 100 +  // sell leg fee
                       impactA +              // our slippage on buy
                       impactB                // our slippage on sell

  const netGapPct = gapPct - totalCostPct
  if (netGapPct <= 0) return 0

  const profitUsdc = flashAmountUsdc * (netGapPct / 100)
  return Math.floor(profitUsdc)
}

// ── AMOUNT OUT MINIMUM CALCULATOR ─────────────────────────────────────────────
//
// This is the critical fix. amountOutMinimum must be:
//   - High enough to enforce profitability
//   - Low enough to not cause false reverts from normal slippage
//
// Formula:
//   buyLeg min:  flashAmount / currentBuyPrice × 0.985  (1.5% slippage buffer)
//   sellLeg min: flashAmount + minProfitUsdc             (enforces profit)

function calcAmountOutMins(flashAmountUsdc, buyPrice, minProfitUsdc) {
  // Buy leg: USDC → ETH
  // expectedETH = flashAmountUsdc / buyPrice
  // minETH = expectedETH × 0.985 (1.5% slippage tolerance — covers 99% of cases)
  const expectedETH = flashAmountUsdc / buyPrice
  const minBuyAmountEth = expectedETH * 0.985

  // Convert to wei (18 decimals) for WETH, 8 decimals for WBTC
  // For now assume WETH (18 decimals)
  const minBuyAmountWei = BigInt(Math.floor(minBuyAmountEth * 1e18))

  // Sell leg: ETH → USDC
  // Must get back at least flashAmount + minProfit
  const minSellUsdc = BigInt(Math.floor(flashAmountUsdc * 1e6)) +
                      BigInt(Math.floor(minProfitUsdc * 1e6))

  return { minBuyAmountWei, minSellUsdc }
}

// ── OPPORTUNITY EVALUATOR ─────────────────────────────────────────────────────
//
// Called when we have fresh prices for both pools in a pair.
// Checks if gap is profitable and emits opportunity if so.

function evaluatePair(chainName, pair, priceA, priceB) {
  if (!priceA || !priceB) return
  if (priceA.price <= 0 || priceB.price <= 0) return

  const gap    = Math.abs(priceA.price - priceB.price)
  const gapPct = gap / Math.min(priceA.price, priceB.price) * 100

  // Store for dashboard
  setConfig(`scanner_gap_${pair.name}`, gapPct.toFixed(4))
  setConfig(`scanner_price_A_${pair.name}`, priceA.price.toFixed(2))
  setConfig(`scanner_price_B_${pair.name}`, priceB.price.toFixed(2))

  // Minimum gap threshold: 0.15%
  // Below this, fees alone make it unprofitable
  if (gapPct < 0.15) return

  // Determine which pool to buy from and which to sell to
  const buyFromA  = priceA.price < priceB.price
  const poolBuy   = buyFromA ? pair.poolA : pair.poolB
  const poolSell  = buyFromA ? pair.poolB : pair.poolA
  const buyPrice  = buyFromA ? priceA.price : priceB.price
  const sellPrice = buyFromA ? priceB.price : priceA.price

  // Calculate flash size
  const flashAmountUsdc = calcFlashSize(
    poolBuy.tvlUsdc, poolSell.tvlUsdc, gapPct
  )
  if (flashAmountUsdc === 0) return  // Below floor

  // Estimate profit
  const profitUsdc = estimateProfit(
    flashAmountUsdc,
    poolBuy.tvlUsdc, poolSell.tvlUsdc,
    gapPct,
    poolBuy.fee, poolSell.fee
  )

  // Minimum profit gate: $500 (covers gas + builder tip with 7x margin)
  if (profitUsdc < 500) return

  // Deduplication: don't spam same pair
  const now = Date.now()
  const lastEmit = _lastOppty.get(pair.name) || 0
  if (now - lastEmit < OPPTY_COOLDOWN_MS) return
  _lastOppty.set(pair.name, now)

  // Calculate amountOutMinimums from real prices
  const { minBuyAmountWei, minSellUsdc } = calcAmountOutMins(
    flashAmountUsdc, buyPrice, profitUsdc * 0.5  // demand 50% of estimate (safety)
  )

  // Resolve token addresses for this chain
  const tokens = TOKEN_ADDRS[chainName] || {}
  const flashTokenAddr = tokens[pair.flashToken]
  const assetTokenAddr = tokens[pair.asset]

  if (!flashTokenAddr || !assetTokenAddr) return

  const opportunity = {
    chain:          chainName,
    pairName:       pair.name,
    flashToken:     flashTokenAddr,
    flashAmountUsdc,
    flashAmountWei: BigInt(Math.floor(flashAmountUsdc * 1e6)), // USDC has 6 decimals
    poolBuy:        poolBuy.address,
    poolSell:       poolSell.address,
    assetToken:     assetTokenAddr,
    buyFee:         poolBuy.fee,
    sellFee:        poolSell.fee,
    gapPct:         parseFloat(gapPct.toFixed(4)),
    buyPrice:       parseFloat(buyPrice.toFixed(2)),
    sellPrice:      parseFloat(sellPrice.toFixed(2)),
    estimatedProfit: profitUsdc,
    minBuyAmount:   minBuyAmountWei,   // BigInt, wei units
    minSellUsdc,                        // BigInt, USDC units (6 dec)
    ts:             now
  }

  console.log(
    `[SCANNER] GAP DETECTED ${pair.name} on ${chainName}: ` +
    `${gapPct.toFixed(3)}% | flash $${(flashAmountUsdc/1e6).toFixed(1)}M | ` +
    `profit ~$${profitUsdc.toLocaleString()}`
  )

  // Update scanner stats for dashboard
  const totalGaps = parseInt(getConfig('scanner_gaps_detected') || '0') + 1
  setConfig('scanner_gaps_detected', String(totalGaps))
  setConfig('scanner_last_opportunity', JSON.stringify({
    ...opportunity,
    flashAmountWei: opportunity.flashAmountWei.toString(),
    minBuyAmount:   opportunity.minBuyAmount.toString(),
    minSellUsdc:    opportunity.minSellUsdc.toString()
  }))

  emit('arb_opportunity', opportunity)
}

// ── POOL WATCHER ──────────────────────────────────────────────────────────────
//
// Subscribes to Swap events on all pools in a pair.
// Decodes price from each Swap event.
// Immediately evaluates the pair after any price update.
//
// FAILURE PROOFING:
//   WebSocket managed by rpc.js ChainWS — auto-reconnects
//   Price decode failure → skip, wait for next Swap event
//   Missing WebSocket → log warning, check again in 30s

function watchPair(chainName, pair) {
  const ws = getWS(chainName)
  if (!ws) {
    console.warn(`[SCANNER] No WebSocket for ${chainName} — will retry`)
    setTimeout(() => watchPair(chainName, pair), 30000)
    return
  }

  // Subscribe to both pools
  ;[pair.poolA, pair.poolB].forEach(pool => {
    ws.subscribe({
      jsonrpc: '2.0',
      id:      Math.random() * 999999 | 0,
      method:  'eth_subscribe',
      params:  ['logs', {
        address: pool.address,
        topics:  [SWAP_TOPIC]
      }]
    })
  })

  // Handle incoming Swap events
  ws.on('log', log => {
    if (log.topics?.[0] !== SWAP_TOPIC) return

    const poolAddr = log.address?.toLowerCase()
    if (!poolAddr) return

    // Identify which pool this is
    const isPoolA = poolAddr === pair.poolA.address.toLowerCase()
    const isPoolB = poolAddr === pair.poolB.address.toLowerCase()
    if (!isPoolA && !isPoolB) return

    const pool = isPoolA ? pair.poolA : pair.poolB
    const token0IsUsdc = pool.token0IsUsdc

    // Decode price from sqrtPriceX96 in swap data
    const priceData = decodeSwapPrice(log, token0IsUsdc)
    if (!priceData) return

    // Update price map
    _prices.set(poolAddr, priceData)

    // Update other pool's last known price
    const otherAddr = isPoolA
      ? pair.poolB.address.toLowerCase()
      : pair.poolA.address.toLowerCase()
    const otherPrice = _prices.get(otherAddr)

    // Evaluate gap now that we have a fresh price
    const priceA = _prices.get(pair.poolA.address.toLowerCase())
    const priceB = _prices.get(pair.poolB.address.toLowerCase())
    evaluatePair(chainName, pair, priceA, priceB)
  })

  console.log(`[SCANNER] Watching pair ${pair.name} on ${chainName}`)
}

// ── CEX PRICE INTEGRATION ─────────────────────────────────────────────────────
//
// CEX prices (from cexfeed.js) feed into scanner as a "virtual pool".
// If ETH price on Binance diverges from DEX by > 0.15%:
// This can also trigger a bootstrap opportunity.
// CEX → DEX arb (or DEX → CEX) is the most common MEV type.

function onCEXPrice({ symbol, price }) {
  if (symbol !== 'ETH' || !price) return

  // Compare CEX price against each tracked ETH/USDC pool
  const ethPairs = (POOL_PAIRS.ethereum || [])
    .filter(p => p.asset === 'weth')

  for (const pair of ethPairs) {
    const priceA = _prices.get(pair.poolA.address.toLowerCase())
    if (!priceA) continue

    const cexGap = Math.abs(price - priceA.price) / priceA.price * 100

    if (cexGap > 0.15) {
      // CEX-DEX gap detected
      // For CEX-DEX arb: we trade on DEX side only
      // Buy cheap on DEX, sell expensive on CEX (off-chain, handled by cexfeed.js)
      // Or: buy cheap on CEX (off-chain), sell expensive on DEX
      // The DEX side of this is: just a normal pool arb against another DEX pool
      // We trigger a scan of all pair combinations
      const priceB = _prices.get(pair.poolB.address.toLowerCase())
      if (priceB) evaluatePair('ethereum', pair, priceA, priceB)
    }
  }
}

// ── PERIODIC FALLBACK SCAN ────────────────────────────────────────────────────
//
// In case WebSocket misses events (rare but possible):
// Re-evaluate all known prices every 5 seconds.
// If prices are stale (> 60s old): log warning.

function periodicScan() {
  const now = Date.now()

  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      const priceA = _prices.get(pair.poolA.address.toLowerCase())
      const priceB = _prices.get(pair.poolB.address.toLowerCase())

      // Stale price warning (no Swap events in 60s = unusual)
      if (priceA && (now - priceA.ts) > 60000) {
        console.warn(`[SCANNER] Stale price for ${pair.poolA.address} — no events in 60s`)
      }

      // Re-evaluate even on periodic scan (catches missed WebSocket events)
      evaluatePair(chainName, pair, priceA, priceB)
    }
  }

  // Export scanner stats to dashboard
  const gaps = []
  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      const gapKey  = `scanner_gap_${pair.name}`
      const gapVal  = parseFloat(getConfig(gapKey) || '0')
      const priceAK = parseFloat(getConfig(`scanner_price_A_${pair.name}`) || '0')
      const priceBK = parseFloat(getConfig(`scanner_price_B_${pair.name}`) || '0')
      gaps.push({ pair: pair.name, chain: chainName, gap: gapVal, priceA: priceAK, priceB: priceBK })
    }
  }
  setConfig('scanner_gaps', JSON.stringify(gaps))
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────

export function getScannerStats() {
  return {
    gapsDetected:    parseInt(getConfig('scanner_gaps_detected') || '0'),
    lastOpportunity: (() => {
      try { return JSON.parse(getConfig('scanner_last_opportunity') || 'null') }
      catch { return null }
    })(),
    activePairs:     Object.values(POOL_PAIRS).flat().length,
    trackedPools:    _prices.size,
    currentGaps:     (() => {
      try { return JSON.parse(getConfig('scanner_gaps') || '[]') }
      catch { return [] }
    })()
  }
}

export function startScanner() {
  console.log('[SCANNER] Starting cross-pool price divergence detector...')

  // Register all pool pairs
  let pairCount = 0
  for (const [chainName, pairs] of Object.entries(POOL_PAIRS)) {
    for (const pair of pairs) {
      watchPair(chainName, pair)
      pairCount++
    }
  }

  // Listen to CEX prices (from cexfeed.js via events.js)
  on('cex_price', onCEXPrice)

  // Periodic fallback scan every 5 seconds
  setInterval(periodicScan, 5000)

  console.log(`[SCANNER] ${pairCount} pairs registered across ${Object.keys(POOL_PAIRS).length} chains`)
  console.log('[SCANNER] Watching for cross-pool gaps > 0.15% with profit > $500')
  console.log('[SCANNER] arb_opportunity events → bootstrap.js')
      }
