import { encodeFunctionData, parseAbi } from 'viem'
import { CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient, getExecutorAddress } from './pimlico.js'

const SUPPLY_ABI = parseAbi([
  'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode) external'
])
const ERC20_ABI  = parseAbi([
  'function approve(address spender,uint256 amount) external returns (bool)',
  'function balanceOf(address) external view returns (uint256)'
])
const RESERVE_ABI = [{
  name:'getReserveData', type:'function', stateMutability:'view',
  inputs:[{name:'asset',type:'address'}],
  outputs:[{type:'uint256'},{type:'uint128'},{type:'uint128'},
    {type:'uint128'},{type:'uint128'},{type:'uint128'},
    {type:'uint40'},{type:'uint16'},{type:'address'},
    {type:'address'},{type:'address'},{type:'address'},
    {type:'uint128'},{type:'uint128'},{type:'uint128'}]
}]

export async function deployIdle(chainName) {
  try {
    const chain  = CHAINS[chainName]
    if (!chain?.aavePool || chain.gasMethod !== 'pimlico') return
    const c      = getPublicClient(chainName)
    const addr   = getExecutorAddress()
    if (!addr) return

    const bal    = await c.readContract({ address:chain.usdc, abi:ERC20_ABI, functionName:'balanceOf', args:[addr] })
    const usdc   = Number(bal) / 1e6
    const deploy = usdc - 500 // keep $500 liquid

    if (deploy < 50) return // minimum $50 to deploy

    const amt = BigInt(Math.floor(deploy * 1e6))
    // Approve then supply
    const appData = encodeFunctionData({ abi:ERC20_ABI, functionName:'approve', args:[chain.aavePool, amt] })
    await sendViaPimlico(chainName, chain.usdc, appData)
    const supData = encodeFunctionData({ abi:SUPPLY_ABI, functionName:'supply', args:[chain.usdc, amt, addr, 0] })
    await sendViaPimlico(chainName, chain.aavePool, supData)

    setConfig(`yield_deployed_${chainName}`, deploy.toFixed(2))
    console.log(`[YIELD] ${chainName}: deployed $${deploy.toFixed(0)} to Aave supply`)
  } catch (e) {
    console.log(`[YIELD] ${chainName}: ${e.message?.slice(0,80)}`)
  }
}

export function startYield() {
  setInterval(async () => {
    for (const c of ['polygon','arbitrum','base']) {
      await deployIdle(c).catch(()=>{})
    }
  }, 600000)
}
