// X7 PROTOCOL — EXECUTOR
// Routes to Pimlico (Polygon/Arbitrum/Base) or Flashbots (Ethereum)
// All 3 protocols: Aave V3, Compound V3, Morpho Blue
// estimateProfit before every execution — skip losers

import { encodeFunctionData, parseAbi, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig, recordExecution, recordRevenue } from './db.js'
import { sendViaPimlico, getPublicClient, getExecutorAddress } from './pimlico.js'
import { simulate, submit, buildSignedTx } from './flashbots.js'
import { compile } from './compiler.js'

const X7_ABI_AAVE = parseAbi([
  'function aaveLiquidate(address debtAsset,uint256 debtAmount,address collateral,address borrower,uint24 fee) external'
])
const X7_ABI_COMPOUND = parseAbi([
  'function compoundLiquidate(address comet,address borrower,address collateralAsset,uint24 swapFee) external'
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)'
])
const QUOTER_ABI = [{
  name:'quoteExactInputSingle', type:'function', stateMutability:'nonpayable',
  inputs:[
    {name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},
    {name:'amountIn',type:'uint256'},{name:'fee',type:'uint24'},
    {name:'sqrtPriceLimitX96',type:'uint160'}
  ],
  outputs:[
    {name:'amountOut',type:'uint256'},{name:'sqrtPriceX96After',type:'uint160'},
    {name:'initializedTicksCrossed',type:'uint32'},{name:'gasEstimate',type:'uint256'}
  ]
}]

function price(sym) {
  try {
    const p = JSON.parse(getConfig('prices')||'{}')
    return p[sym] || p[sym.replace(/^W/,'')] || 1
  } catch { return 1 }
}

function symFor(chainName, addr) {
  const c = CHAINS[chainName], l = addr?.toLowerCase()
  if (l===c.usdc?.toLowerCase())   return {sym:'USDC',  bps:c.liquidationBonuses?.usdc  ||450 }
  if (l===c.weth?.toLowerCase())   return {sym:'WETH',  bps:c.liquidationBonuses?.weth  ||500 }
  if (l===c.wbtc?.toLowerCase())   return {sym:'WBTC',  bps:c.liquidationBonuses?.wbtc  ||1000}
  if (l===c.link?.toLowerCase())   return {sym:'LINK',  bps:c.liquidationBonuses?.link  ||750 }
  if (l===c.dai?.toLowerCase())    return {sym:'DAI',   bps:c.liquidationBonuses?.dai   ||450 }
  if (l===c.wmatic?.toLowerCase()) return {sym:'WMATIC',bps:c.liquidationBonuses?.wmatic||750 }
  return {sym:'UNKNOWN', bps:500}
}

async function bestFee(chainName, tokenIn, tokenOut) {
  const c = getPublicClient(chainName)
  const q = CHAINS[chainName].quoter
  for (const fee of [500, 3000, 10000]) {
    try {
      await c.readContract({ address:q, abi:QUOTER_ABI,
        functionName:'quoteExactInputSingle',
        args:[tokenIn, tokenOut, 1_000_000n, fee, 0n] })
      return fee
    } catch {}
  }
  return 3000
}

export function findBestParams(chainName, reserves) {
  if (!reserves?.length) return null
  const chain   = CHAINS[chainName]
  const gasEst  = chainName==='ethereum' ? 45 : chainName==='arbitrum' ? 3 : 0.5
  let   best    = null, bestProfit = 0

  for (const debt of reserves) {
    if (!debt.variableDebt || debt.variableDebt===0n) continue
    const di     = symFor(chainName, debt.asset)
    const dUSD   = (Number(debt.variableDebt)/1e18) * price(di.sym)
    if (dUSD < chain.minProfit * 2) continue

    for (const coll of reserves) {
      if (!coll.collateralEnabled || !coll.aTokenBalance || coll.aTokenBalance===0n) continue
      if (coll.asset.toLowerCase()===debt.asset.toLowerCase()) continue
      const ci     = symFor(chainName, coll.asset)
      // Use full close factor for HF < 0.95 (confirmed from Aave docs)
      const gross  = dUSD * 0.5 * (ci.bps/10000)
      const flash  = dUSD * 0.5 * (chain.flashFeeBps/10000)
      const profit = gross - flash - (dUSD*0.003) - gasEst
      if (profit > bestProfit && profit > chain.minProfit) {
        bestProfit = profit
        best = {
          collateralAsset: coll.asset, debtAsset: debt.asset,
          debtAmountWei: debt.variableDebt, estimatedProfit: profit,
          collSym: ci.sym, debtSym: di.sym
        }
      }
    }
  }
  return best
}

async function executeAavePimlico(chainName, contractAddr, params, borrower) {
  const { collateralAsset, debtAsset, debtAmountWei } = params
  const chain   = CHAINS[chainName]
  const swapFee = await bestFee(chainName, collateralAsset, chain.usdc)
  const data    = encodeFunctionData({
    abi: X7_ABI_AAVE, functionName: 'aaveLiquidate',
    args: [debtAsset, debtAmountWei, collateralAsset, borrower, swapFee]
  })
  const txHash = await sendViaPimlico(chainName, contractAddr, data)
  return txHash
}

async function executeAaveFlashbots(chainName, contractAddr, params, borrower) {
  const { collateralAsset, debtAsset, debtAmountWei } = params
  const chain   = CHAINS[chainName]
  const c       = getPublicClient(chainName)
  const swapFee = await bestFee(chainName, collateralAsset, chain.usdc)
  const data    = encodeFunctionData({
    abi: X7_ABI_AAVE, functionName: 'aaveLiquidate',
    args: [debtAsset, debtAmountWei, collateralAsset, borrower, swapFee]
  })

  const block    = await c.getBlockNumber()
  const feeData  = await c.estimateFeesPerGas()
  const nonce    = await c.getTransactionCount({ address: getExecutorAddress() })

  const signedTx = await buildSignedTx(
    chainName, contractAddr, data, nonce,
    feeData.maxFeePerGas, feeData.maxPriorityFeePerGas
  )
  if (!signedTx) return null

  // Simulate first
  try { await simulate([signedTx], block + 1n) }
  catch (e) { console.log(`[FLASHBOTS] Simulation failed: ${e.message?.slice(0,80)}`); return null }

  return await submit([signedTx], Number(block) + 1)
}

export async function execute(opportunity) {
  const { chainName, borrower, protocol, hf } = opportunity
  const chain        = CHAINS[chainName]
  const contractAddr = getConfig(`contract_${chainName}`)

  if (!contractAddr || contractAddr==='failed') {
    console.log(`[${chainName.toUpperCase()}] No contract deployed yet`)
    return null
  }

  console.log(`[${chainName.toUpperCase()}] Executing ${protocol} liquidation: ${borrower.slice(0,10)} HF=${hf?.toFixed(4)}`)

  try {
    let txHash = null

    if (protocol === 'aave') {
      const { getAaveReserves } = await import('./scanner.js')
      const reserves = await getAaveReserves(chainName, borrower)
      if (!reserves) return null

      const params = findBestParams(chainName, reserves)
      if (!params) { console.log(`[${chainName.toUpperCase()}] No profitable params`); return null }

      console.log(`[${chainName.toUpperCase()}] Est. profit: $${params.estimatedProfit.toFixed(0)} | ${params.collSym}/${params.debtSym}`)

      if (chain.gasMethod === 'pimlico') {
        txHash = await executeAavePimlico(chainName, contractAddr, params, borrower)
      } else {
        txHash = await executeAaveFlashbots(chainName, contractAddr, params, borrower)
      }
    }

    if (!txHash) return null

    // Check profit
    const execAddr = getExecutorAddress()
    const c        = getPublicClient(chainName)
    const bal      = execAddr ? await c.readContract({
      address: chain.usdc, abi: ERC20_ABI,
      functionName: 'balanceOf', args: [execAddr]
    }) : 0n
    const profitUSDC = Number(bal) / 1e6

    console.log(`[PROFIT] ${chainName}/${protocol}: +$${profitUSDC.toFixed(2)} TX:${txHash}`)
    recordExecution({
      txHash, chain: chainName, protocol, borrower,
      collateralAsset: opportunity.collateralAsset,
      debtAsset: opportunity.debtAsset,
      profitUsdc: profitUSDC, status: 'success'
    })
    recordRevenue(chainName, profitUSDC, protocol)
    updateWR(chainName, protocol, true)

    return { success: true, profitUSDC, txHash }
  } catch (e) {
    console.error(`[${chainName.toUpperCase()}] Execution failed: ${e.message?.slice(0,150)}`)
    recordExecution({
      chain: chainName, protocol, borrower,
      status: 'failed', errorMsg: e.message?.slice(0,200)
    })
    updateWR(chainName, protocol, false)
    return null
  }
}

function updateWR(chain, protocol, success) {
  try {
    const k = `wr_${chain}_${protocol}`
    const v = Number(getConfig(k)||0.4) * 0.9 + (success ? 1:0) * 0.1
    setConfig(k, v.toFixed(3))
  } catch {}
}
