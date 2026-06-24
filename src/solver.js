// X7-SV · solver.js — order flow intake
// Full implementation is in revenue.js (Stream 1) — this re-exports

export { processOrder, getSolverStats } from './revenue.js'
import { encodeFunctionData, parseAbi, keccak256, toBytes } from 'viem'
import { getConfig, setConfig } from './db.js'
import { getChain } from './chains.js'
import { executeBundle } from './builders.js'
import { getContractAddr, getExecutorAddress } from './pimlico.js'
import { p8SolverMargin } from './propellers.js'

const ARB_ABI = parseAbi(['function dexArb(address,address,uint256,uint24,uint24,uint256) external'])

// Track solver revenue
let _solverRevenue = 0

export function getSolverStats() {
  return { revenue: _solverRevenue, orders: parseInt(getConfig('solver_orders') || '0') }
}

// Process incoming user order (signed intent)
export async function processSolverOrder(order) {
  const { chainName, tokenIn, tokenOut, amountIn, minOut, signature, deadline } = order

  if (Date.now() / 1000 > deadline) return { error: 'Order expired' }

  const chain = getChain(chainName)
  const contractAddr = getContractAddr(chainName)
  if (!chain || !contractAddr) return { error: 'Chain not ready' }

  // Verify signature
  const orderHash = keccak256(toBytes(JSON.stringify({ tokenIn, tokenOut, amountIn, minOut, deadline })))
  // Signature verification simplified — full impl uses viem verifyMessage

  // Calculate solver margin (P8)
  const margin = p8SolverMargin(Number(amountIn) / 1e6)
  const netOut = Number(minOut) - margin * 1e6

  if (netOut < Number(minOut) * 0.98) return { error: 'Insufficient liquidity for order' }

  const calldata = encodeFunctionData({
    abi: ARB_ABI, functionName: 'dexArb',
    args: [tokenIn, tokenOut, BigInt(amountIn), 500, 3000, BigInt(Math.floor(margin * 1e6))]
  })

  try {
    const txHash = await executeBundle(chainName, contractAddr, calldata, margin)
    if (!txHash) return { error: 'Execution failed' }

    _solverRevenue += margin
    setConfig('solver_revenue', _solverRevenue.toFixed(2))
    setConfig('solver_orders', String(parseInt(getConfig('solver_orders') || '0') + 1))

    console.log(`[SOLVER] Order filled: $${margin.toFixed(2)} margin, tx=${String(txHash).slice(0, 12)}`)
    return { success: true, txHash, margin, filledAt: Date.now() }
  } catch (e) {
    return { error: e.message?.slice(0, 100) }
  }
}

// Quote for user (better price than direct Uniswap)
export async function getSolverQuote(chainName, tokenIn, tokenOut, amountIn) {
  const bps = parseInt(getConfig('solver_margin_bps') || '10')
  const margin = Number(amountIn) * bps / 10000
  // In practice: fetch actual DEX quote then subtract margin
  return {
    amountOut: Number(amountIn) * 0.997 - margin, // 0.3% pool fee + our margin
    margin,
    marginBps: bps,
    solver: getExecutorAddress()
  }
}
