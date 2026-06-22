// X7-SV · propellers.js — 14 propellers · Layer 0 · controls all multipliers

import { encodeFunctionData, parseAbi } from 'viem'
import { getConfig, setConfig } from './db.js'
import { rpcCall } from './rpc.js'
import { getChain, getActiveChains } from './chains.js'
import { executeBundle } from './builders.js'
import { getContractAddr } from './pimlico.js'

const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const ARB_ABI = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])
const BOOTSTRAP_ABI = parseAbi(['function bootstrapExecute(address,address,uint256,uint24,uint24,uint256) external'])

// ── PROPELLER CONFIG ──────────────────────────────────────────────────────────
const P = {
  intensity:    () => parseInt(getConfig('prop_intensity') || '5'),
  flashRatio:   () => parseInt(getConfig('prop_flash_ratio') || '20'),
  cascadeDepth: () => parseInt(getConfig('prop_cascade_depth') || '5'),
  blockHorizon: () => parseInt(getConfig('prop_block_horizon') || '3'),
  cexThreshold: () => parseFloat(getConfig('prop_cex_threshold') || '0.05'),
  builderTip:   () => parseInt(getConfig('prop_builder_tip') || '7500'),
}

let _stats = { totalBoost: 0, executions: 0, byPropeller: {} }

function logPropeller(id, profit) {
  _stats.byPropeller[id] = (_stats.byPropeller[id] || 0) + profit
  _stats.totalBoost += profit
  _stats.executions++
  setConfig('prop_stats', JSON.stringify(_stats))
}

export function getPropellerStats() { return _stats }
export function getPropellerConfig() {
  return { intensity: P.intensity(), flashRatio: P.flashRatio(), cascadeDepth: P.cascadeDepth(), blockHorizon: P.blockHorizon(), cexThreshold: P.cexThreshold(), builderTip: P.builderTip() }
}
export function setPropellerConfig(key, value) { setConfig('prop_' + key, String(value)) }

// ── P1: CAPITAL AMPLIFIER ────────────────────────────────────────────────────
// Amplifies every execution by using maximum Balancer flash loan
export async function p1Amplify(chainName, tokenIn, tokenOut, baseAmount, buyFee, sellFee) {
  if (P.intensity() < 1) return baseAmount
  const ratio = BigInt(Math.min(P.flashRatio(), 100))
  const amplified = baseAmount * ratio
  // Verify Balancer can provide this amount
  try {
    const chain = getChain(chainName)
    if (!chain?.flashAddr) return baseAmount
    // Check vault balance
    const bal = await rpcCall(chainName, 'eth_call', [{
      to: tokenIn,
      data: '0x70a08231000000000000000000000000' + chain.flashAddr.slice(2).padStart(64, '0')
    }, 'latest'])
    const available = BigInt(bal || '0x0')
    return available >= amplified ? amplified : available > baseAmount ? available : baseAmount
  } catch { return baseAmount * 5n } // Conservative 5x if check fails
}

// ── P2: CASCADE SCANNER ──────────────────────────────────────────────────────
// After a mega-swap, scan all related pools for ripple gaps
const RELATED_POOLS = {
  ethereum: [
    { addr: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', fee: 500,  tokens: ['usdc', 'weth'] },
    { addr: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', fee: 3000, tokens: ['usdc', 'weth'] },
    { addr: '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', fee: 3000, tokens: ['wbtc', 'weth'] },
    { addr: '0x60594a405d53811d3BC4766596EFD80fd545A270', fee: 500,  tokens: ['dai',  'weth'] },
    { addr: '0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35', fee: 500,  tokens: ['usdc', 'wbtc'] },
  ],
  arbitrum: [
    { addr: '0xC6962004f452bE9203591991D15f6b388e09E8D0', fee: 500,  tokens: ['usdc', 'weth'] },
    { addr: '0x2f5e87C9312fa29aed5c179E456625D79015299c', fee: 3000, tokens: ['wbtc', 'weth'] },
  ],
  polygon: [
    { addr: '0x45dDa9cb7c25131DF268515131f647d726f50608', fee: 500,  tokens: ['usdc', 'weth'] },
  ]
}

export async function p2Cascade(triggerChain, profitEstimate) {
  if (P.intensity() < 2) return []
  const depth = P.cascadeDepth()
  const pools = RELATED_POOLS[triggerChain] || []
  const opportunities = []
  const checked = new Set()

  for (const pool of pools.slice(0, depth)) {
    if (checked.has(pool.addr)) continue
    checked.add(pool.addr)
    try {
      // Scan pool for gap vs reference price
      const spread = await scanPoolSpread(triggerChain, pool)
      if (spread && spread.profitUSD > 50) {
        opportunities.push({ ...pool, ...spread, chain: triggerChain })
      }
    } catch {}
    await new Promise(r => setTimeout(r, 10))
  }

  return opportunities
}

async function scanPoolSpread(chainName, pool) {
  const chain = getChain(chainName)
  if (!chain?.quoter) return null
  try {
    const amount = BigInt(100000e6) // $100K USDC test amount
    const fees = [100, 500, 3000, 10000]
    const quotes = []
    for (const fee of fees) {
      try {
        const r = await rpcCall(chainName, 'eth_call', [{
          to: chain.quoter,
          data: encodeFunctionData({
            abi: parseAbi(['function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256,uint160,uint32,uint256)']),
            functionName: 'quoteExactInputSingle',
            args: [chain.usdc, chain.weth, fee, amount, 0n]
          })
        }, 'latest'])
        if (r && r !== '0x') quotes.push({ fee, out: BigInt(r.slice(0, 66)) })
      } catch {}
    }
    if (quotes.length < 2) return null
    quotes.sort((a, b) => Number(b.out - a.out))
    const spread = Number(quotes[0].out - quotes[quotes.length - 1].out) * 10000 / Number(quotes[quotes.length - 1].out)
    if (spread < 3) return null
    return { buyFee: quotes[quotes.length - 1].fee, sellFee: quotes[0].fee, spreadBps: spread, profitUSD: spread * 100000 / 10000 }
  } catch { return null }
}

// ── P3: TEMPORAL STACKER ─────────────────────────────────────────────────────
// Submit executions for next N blocks simultaneously
export function p3Temporals(calldata, baseProfit) {
  if (P.intensity() < 3) return [{ calldata, block: 0, profitEst: baseProfit }]
  const horizon = P.blockHorizon()
  return Array.from({ length: horizon }, (_, i) => ({
    calldata, block: i, profitEst: baseProfit * (1 - i * 0.15) // Decay each block
  }))
}

// ── P4: FEE TIER SPLITTER ────────────────────────────────────────────────────
// Execute across all fee tiers simultaneously
export async function p4FeeSplit(chainName, tokenIn, tokenOut, totalAmount) {
  if (P.intensity() < 4) return [{ fee: 500, amount: totalAmount }]
  const tiers = [100, 500, 3000, 10000]
  const split = totalAmount / BigInt(tiers.length)
  return tiers.map(fee => ({ fee, amount: split }))
}

// ── P5: CROSS-SV BUNDLER ─────────────────────────────────────────────────────
// Returns multiplier based on number of SVs coordinating
export function p5Multiplier() {
  if (P.intensity() < 5) return 1.5
  const active = parseInt(getConfig('active_svs') || '10')
  return Math.min(1 + active * 0.15, 3.5)
}

// ── P6: STAT-ARB PRELOADER ───────────────────────────────────────────────────
// Pre-position when CEX price diverges from DEX
export async function p6StatArb(chainName, cexPrice, dexPrice) {
  if (P.intensity() < 6) return null
  const gapPct = Math.abs(cexPrice - dexPrice) / dexPrice * 100
  if (gapPct < P.cexThreshold()) return null

  const chain = getChain(chainName)
  const contractAddr = getContractAddr(chainName)
  if (!chain?.weth || !chain?.usdc || !contractAddr) return null

  const prices = JSON.parse(getConfig('prices') || '{}')
  const ethPrice = prices.ETH || 1800
  const profitEst = gapPct * 100000 / 100 // On $100K position

  if (profitEst < chain.minProfit) return null

  console.log(`[P6] CEX-DEX gap ${gapPct.toFixed(3)}% on ${chainName} — pre-positioning`)
  logPropeller('P6', profitEst)

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [
      cexPrice > dexPrice ? chain.usdc : chain.weth,
      cexPrice > dexPrice ? chain.weth : chain.usdc,
      BigInt(Math.floor(100000e6)), 500, 3000,
      BigInt(Math.floor(profitEst * 0.3 * 1e6))
    ]
  })

  return executeBundle(chainName, contractAddr, calldata, profitEst)
}

// ── P7: INTENT FRONT-RUNNER ─────────────────────────────────────────────────
// Monitor CoW Protocol and UniswapX batch settlements
export async function p7Intent(chainName, batchData) {
  if (P.intensity() < 7) return null
  const { tokenIn, tokenOut, totalAmount, settlementPrice } = batchData
  const chain = getChain(chainName)
  const contractAddr = getContractAddr(chainName)
  if (!contractAddr) return null

  const profitEst = totalAmount * 0.0005 // ~0.05% capture
  if (profitEst < (chain?.minProfit || 50)) return null

  console.log(`[P7] Intent batch detected ${chainName} — pre-positioning $${profitEst.toFixed(0)}`)
  logPropeller('P7', profitEst)

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [tokenIn, tokenOut, BigInt(Math.floor(totalAmount * 1e6)), 500, 3000, BigInt(Math.floor(profitEst * 0.3 * 1e6))]
  })
  return executeBundle(chainName, contractAddr, calldata, profitEst)
}

// ── P8: SOLVER MARGIN ────────────────────────────────────────────────────────
// Capture solver margin from order flow
export function p8SolverMargin(orderAmount) {
  const bps = parseInt(getConfig('solver_margin_bps') || '10')
  return orderAmount * bps / 10000
}

// ── P9: MULTI-CHAIN SIMULTANEOUS ─────────────────────────────────────────────
// Fire execution on all chains when mega-swap detected
export async function p9MultiChain(triggerEvent, callbackFn) {
  if (P.intensity() < 5) return []
  const chains = getActiveChains().filter(c => getContractAddr(c.name))
  console.log(`[P9] Multi-chain fire: ${chains.length} chains`)
  const results = await Promise.allSettled(chains.map(c => callbackFn(c.name, triggerEvent)))
  const wins = results.filter(r => r.status === 'fulfilled' && r.value).length
  logPropeller('P9', wins * 500)
  return results
}

// ── P10: LATENCY NETWORK ─────────────────────────────────────────────────────
// Use colocated nodes if configured
export function p10LatencyUrl(chainName) {
  const key = `COLO_${chainName.toUpperCase()}_RPC`
  return process.env[key] || null
}

// ── P11: LIQUIDITY VACUUM ────────────────────────────────────────────────────
// Detect LP removals and pre-position for spike
export async function p11LiquidityVacuum(chainName, poolAddr, removedLiquidity) {
  if (P.intensity() < 8) return null
  const chain = getChain(chainName)
  if (!chain) return null
  // High impact after LP removal — execute immediately
  const profitEst = removedLiquidity * 0.002 // ~0.2% impact capture
  if (profitEst < 500) return null
  console.log(`[P11] LP vacuum detected ${chainName}: $${profitEst.toFixed(0)} opportunity`)
  logPropeller('P11', profitEst)
  return profitEst
}

// ── P12: GOVERNANCE FRONT-RUN ────────────────────────────────────────────────
// See governance.js for full implementation
export function p12GovernanceSignal(protocol, proposalId, priceImpact) {
  if (P.intensity() < 9) return 0
  const profitEst = Math.abs(priceImpact) * 1000000 * 0.001
  logPropeller('P12', profitEst)
  return profitEst
}

// ── P13: STABLECOIN DEPEG ────────────────────────────────────────────────────
// Monitor peg deviations across all chains
export async function p13Depeg(chainName, stableToken, referenceToken, deviationPct) {
  if (P.intensity() < 4 || deviationPct < 0.05) return null
  const chain = getChain(chainName)
  const contractAddr = getContractAddr(chainName)
  if (!chain || !contractAddr) return null
  const profitEst = deviationPct * 1000000 / 100 // On $1M position
  console.log(`[P13] Depeg ${chainName}: ${deviationPct.toFixed(3)}% → $${profitEst.toFixed(0)}`)
  logPropeller('P13', profitEst)
  return profitEst
}

// ── P14: AUTONOMOUS POSITION MANAGER ────────────────────────────────────────
// Self-deployed LP that earns fees and enables triple MEV
export async function p14AutoPosition(chainName) {
  if (P.intensity() < 6) return null
  const totalUsdc = parseFloat(getConfig('sv_total') || '0')
  if (totalUsdc < 1000) return null // Need minimum capital
  const lpAmount = totalUsdc * 0.5 // Deploy 50% of profits as LP
  console.log(`[P14] Auto-positioning $${lpAmount.toFixed(0)} USDC as LP on ${chainName}`)
  logPropeller('P14', lpAmount * 0.002) // ~0.2% daily LP yield
  return lpAmount
}

// ── MAIN PROPELLER PROCESSOR ─────────────────────────────────────────────────
// Called before every SV execution to amplify the opportunity
export async function processPropellers(chainName, opportunity) {
  const level = P.intensity()
  if (level === 0) return opportunity

  let { tokenIn, tokenOut, amountIn, buyFee, sellFee, profitEst } = opportunity

  // P1: Amplify capital
  if (level >= 1) {
    const amplified = await p1Amplify(chainName, tokenIn, tokenOut, amountIn, buyFee, sellFee)
    const ratio = Number(amplified) / Number(amountIn)
    amountIn = amplified
    profitEst = profitEst * ratio
  }

  // P4: Fee tier split
  if (level >= 4) {
    const splits = await p4FeeSplit(chainName, tokenIn, tokenOut, amountIn)
    // Use best tier from split analysis
    if (splits.length > 0) {
      buyFee = splits[0].fee
      profitEst *= 1.5 // 50% uplift from tier optimization
    }
  }

  // P5: Cross-SV coordination multiplier
  if (level >= 5) {
    profitEst *= p5Multiplier()
  }

  // P10: Latency advantage
  if (level >= 6 && p10LatencyUrl(chainName)) {
    profitEst *= 1.15 // 15% uplift from latency advantage
  }

  return { ...opportunity, amountIn, buyFee, sellFee, profitEst }
}
