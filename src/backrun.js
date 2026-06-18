// X7 PROTOCOL — ATOMIC BACKRUN ENGINE
// FIX: Proper int256 signed integer decoding — no more phantom e+62 swaps
// Every large real swap on any DEX creates a corrective arbitrage opportunity
// Flash loan capital — zero wallet balance needed for capital
// Fires on every confirmed $50K+ swap

import { parseAbi, encodeFunctionData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getPublicClient, getWalletClient } from './pimlico.js'
import { buildAndSubmitBundle } from './flashbots.js'
import WebSocket from 'ws'

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
])

const BACKRUN_ABI = parseAbi([
  'function backrun(address tokenIn,address tokenOut,uint256 amountIn,uint24 buyFee,uint24 sellFee,uint256 minProfit) external'
])

// Uniswap V3 Swap event topic
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// High-volume pools per chain — confirmed addresses
const WATCHED_POOLS = {
  polygon: [
    '0x45dDa9cb7c25131DF268515131f647d726f50608', // WETH/USDC 0.05%
    '0x50eaEDB835021E4A108B7290636d62E9765cc6d7', // WETH/USDC 0.3%
    '0x847b64f9d3A95e977D157866447a5C0A5dFa0Ee4', // WBTC/WETH
    '0xA374094527e1673A86dE625aa59517c5dE346d32'  // WMATIC/USDC
  ],
  arbitrum: [
    '0xC6962004f452bE9203591991D15f6b388e09E8D0', // WETH/USDC 0.05%
    '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d', // WETH/USDC 0.3%
    '0x2f5e87C9312fa29aed5c179E456625D79015299c'  // WBTC/WETH
  ],
  ethereum: [
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', // USDC/WETH 0.05%
    '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', // USDC/WETH 0.3%
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', // WBTC/WETH 0.3%
    '0x60594a405d53811d3BC4766596EFD80fd545A270'  // DAI/WETH 0.05%
  ]
}

const SWAP_THRESHOLD_USD = 50000

// THE FIX — decode Uniswap V3 Swap event data correctly
// Swap event: amount0 (int256), amount1 (int256), sqrtPriceX96, liquidity, tick
// int256 is SIGNED — must handle two's complement or we get e+62 phantoms
function decodeSwapAmounts(data) {
  try {
    if (!data || data.length < 130) return null

    // Remove 0x prefix
    const hex = data.startsWith('0x') ? data.slice(2) : data

    // amount0 is first 64 hex chars (32 bytes) = int256
    // amount1 is next 64 hex chars (32 bytes) = int256
    const amount0Hex = hex.slice(0, 64)
    const amount1Hex = hex.slice(64, 128)

    // Convert to BigInt
    let amount0 = BigInt('0x' + amount0Hex)
    let amount1 = BigInt('0x' + amount1Hex)

    // Handle signed int256 — two's complement
    // If the high bit is set, the number is negative
    const MAX_INT256 = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
    const UINT256_MAX = BigInt('0x' + 'f'.repeat(64))

    if (amount0 > MAX_INT256) amount0 = amount0 - UINT256_MAX - 1n
    if (amount1 > MAX_INT256) amount1 = amount1 - UINT256_MAX - 1n

    // Take absolute values — we want the magnitude of the swap
    const abs0 = amount0 < 0n ? -amount0 : amount0
    const abs1 = amount1 < 0n ? -amount1 : amount1

    return { amount0, amount1, abs0, abs1 }
  } catch { return null }
}

// Estimate USD value of swap amounts
function estimateUSD(abs0, abs1, chainName) {
  const prices = JSON.parse(getConfig('prices') || '{}')
  const chain  = CHAINS[chainName]

  // Try to estimate from the larger of the two amounts
  // USDC/USDT are 6 decimals, everything else 18
  const val0_18 = Number(abs0) / 1e18
  const val1_18 = Number(abs1) / 1e18
  const val0_6  = Number(abs0) / 1e6
  const val1_6  = Number(abs1) / 1e6

  // Check if amounts look like stablecoins (6 decimals, reasonable range)
  const usdcLike0 = val0_6 > 100 && val0_6 < 1e10
  const usdcLike1 = val1_6 > 100 && val1_6 < 1e10

  if (usdcLike0) return val0_6
  if (usdcLike1) return val1_6

  // Otherwise estimate as ETH-priced asset
  const ethPrice = prices.ETH || 1800
  const est0 = val0_18 * ethPrice
  const est1 = val1_18 * ethPrice

  // Sanity check — reject anything above $1 billion as likely overflow
  const maxReasonable = 1_000_000_000
  const best = Math.max(est0, est1)
  if (best > maxReasonable || best < 0) return 0

  return best
}

async function findBackrunPath(chainName, tokenIn, tokenOut, amountIn) {
  const chain    = CHAINS[chainName]
  const client   = getPublicClient(chainName)
  const FEE_TIERS = [100, 500, 3000, 10000]

  const quotes = []
  for (const fee of FEE_TIERS) {
    try {
      const result = await client.readContract({
        address: chain.quoter, abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amountIn, 0n]
      })
      if (result && result[0]) quotes.push({ fee, out: result[0] })
    } catch {}
    await new Promise(r => setTimeout(r, 25))
  }

  if (quotes.length < 2) return null

  quotes.sort((a, b) => Number(b.out - a.out))
  const best  = quotes[0]
  const worst = quotes[quotes.length - 1]

  if (worst.out === 0n) return null

  const spread = Number(best.out - worst.out) * 10000 / Number(worst.out)
  if (spread < 3) return null // Less than 0.03% spread

  const prices   = JSON.parse(getConfig('prices') || '{}')
  const gasUSD   = chainName === 'ethereum' ? 25
                 : chainName === 'arbitrum'  ? 2 : 0.1
  // Simplified profit estimate
  const profitRaw = Number(best.out - worst.out)
  const profitUSD = (profitRaw / 1e6) - gasUSD // assuming USDC output

  const minProfit = chainName === 'ethereum' ? 30
                  : chainName === 'arbitrum'  ? 3 : 0.5

  if (profitUSD < minProfit) return null

  return {
    tokenIn, tokenOut, amountIn,
    buyFee:    worst.fee,
    sellFee:   best.fee,
    profitUSD,
    spreadBps: spread
  }
}

async function executeBackrun(chainName, opp) {
  const contractAddr = getConfig('contract_' + chainName)
  if (!contractAddr?.startsWith('0x')) {
    // Track missed revenue
    const missed = Number(getConfig('backrun_missed') || 0) + opp.profitUSD
    setConfig('backrun_missed', missed.toFixed(2))
    return null
  }

  try {
    const minProfit = BigInt(Math.floor(Math.max(0, opp.profitUSD * 0.5) * 1e6))
    const data = encodeFunctionData({
      abi: BACKRUN_ABI, functionName: 'backrun',
      args: [opp.tokenIn, opp.tokenOut, opp.amountIn,
             opp.buyFee, opp.sellFee, minProfit]
    })

    const txHash = await buildAndSubmitBundle(chainName, contractAddr, data)
    if (!txHash) return null

    const total = Number(getConfig('backrun_total') || 0) + opp.profitUSD
    const count = Number(getConfig('backrun_count') || 0) + 1
    setConfig('backrun_total', total.toFixed(2))
    setConfig('backrun_count', String(count))
    setConfig('backrun_last', JSON.stringify({
      chain: chainName, profit: opp.profitUSD,
      spread: opp.spreadBps, ts: Date.now()
    }))

    console.log('[BACKRUN] ' + chainName + ': +$' + opp.profitUSD.toFixed(2) +
      ' spread=' + opp.spreadBps.toFixed(1) + 'bps tx=' + txHash.slice(0,12))

    recordExecution({
      txHash, chain: chainName, protocol: 'backrun',
      profitUsdc: opp.profitUSD, status: 'success'
    })

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('backrun', { chain: chainName, profit: opp.profitUSD, total })
    } catch {}

    return opp.profitUSD
  } catch (e) {
    console.log('[BACKRUN] ' + chainName + ': exec failed — ' + e.message?.slice(0, 80))
    return null
  }
}

// WebSocket pool watcher with FIXED signed integer decoding
function watchPool(chainName, poolAddr) {
  const chain = CHAINS[chainName]
  if (!chain?.rpcWss || chain.rpcWss.includes('demo')) return

  function connect() {
    try {
      const ws = new WebSocket(chain.rpcWss)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'eth_subscribe',
          params:  ['logs', { address: poolAddr, topics: [SWAP_TOPIC] }]
        }))
      })

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (!msg.params?.result) return
          const log = msg.params.result
          if (log.topics?.[0] !== SWAP_TOPIC) return

          // FIXED: decode signed int256 amounts properly
          const amounts = decodeSwapAmounts(log.data)
          if (!amounts) return

          // FIXED: estimate USD with sanity checks — rejects e+62 phantom values
          const usdEst = estimateUSD(amounts.abs0, amounts.abs1, chainName)

          // Reject if below threshold OR above sanity limit ($1B)
          if (usdEst < SWAP_THRESHOLD_USD) return
          if (usdEst > 1_000_000_000) return

          console.log('[BACKRUN] Real swap on ' + chainName +
            ' ~$' + usdEst.toFixed(0) + ' — finding path')

          const ch = CHAINS[chainName]
          if (!ch.usdc || !ch.weth) return

          const opp = await findBackrunPath(
            chainName, ch.usdc, ch.weth,
            amounts.abs0 > amounts.abs1 ? amounts.abs0 : amounts.abs1
          )
          if (opp) await executeBackrun(chainName, opp)
        } catch {}
      })

      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 5000))
    } catch { setTimeout(connect, 10000) }
  }
  connect()
}

export function startBackrun() {
  console.log('[BACKRUN] Atomic backrun engine started — signed int256 fix applied')
  setConfig('backrun_status', 'active')
  setConfig('backrun_total',  '0')
  setConfig('backrun_count',  '0')
  setConfig('backrun_missed', '0')

  for (const chainName of ACTIVE_CHAINS) {
    const pools = WATCHED_POOLS[chainName] || []
    pools.forEach(pool => watchPool(chainName, pool))
    if (pools.length > 0) {
      console.log('[BACKRUN] ' + chainName + ': watching ' + pools.length + ' pools')
    }
  }
}

export function getBackrunStatus() {
  return {
    status:  getConfig('backrun_status') || 'inactive',
    total:   getConfig('backrun_total')  || '0',
    count:   getConfig('backrun_count')  || '0',
    missed:  getConfig('backrun_missed') || '0',
    last: (() => {
      try { return JSON.parse(getConfig('backrun_last') || '{}') }
      catch { return {} }
    })()
  }
}
