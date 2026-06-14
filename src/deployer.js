// X7 PROTOCOL — DEPLOYER
// Deploys X7.sol via Pimlico smart account (gas paid in USDC)
// Falls back to EOA if smart account not available
// Contract address stored in DB and Railway env

import { encodeFunctionData, encodeDeployData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient, getWalletClient,
         getExecutorAddress, getSmartAddress } from './pimlico.js'
import { compile } from './compiler.js'

export async function deployToChain(chainName) {
  // Check if already deployed
  const existing = getConfig('contract_' + chainName)
  if (existing && existing !== 'failed' && existing.startsWith('0x')) {
    console.log('[DEPLOY] ' + chainName + ': already at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  const artifact = await compile()
  if (!artifact) {
    console.error('[DEPLOY] compile failed')
    return null
  }

  console.log('[DEPLOY] ' + chainName + ': deploying via Pimlico smart account...')

  try {
    const client  = getPublicClient(chainName)

    // Encode constructor call with contract bytecode
    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args:     [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    })

    // Send via Pimlico — gas paid in USDC from smart account
    // If smart account has no USDC yet, falls back to verifying paymaster
    // then to direct EOA (which will fail if no native token)
    const txHash = await sendViaPimlico(chainName, null, deployData)

    if (!txHash) throw new Error('No tx hash returned')

    // Get contract address from receipt
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash, timeout: 120000
    })

    const addr = receipt.contractAddress
    if (!addr) throw new Error('No contract address in receipt')

    setConfig('contract_' + chainName, addr)
    console.log('[DEPLOY] ' + chainName + ': deployed at ' + addr)
    return addr

  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + e.message?.slice(0, 120))
    // Don't mark as permanently failed — retry next boot
    return null
  }
}

export async function deployAll() {
  console.log('[DEPLOY] Starting deployment on all chains...')
  const order = ['polygon', 'arbitrum', 'avalanche', 'ethereum']
  for (const chainName of order) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ' error: ' + e.message?.slice(0, 80))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
}

// Allow manually setting contract address via env variable
// Set CONTRACT_POLYGON=0x... in Railway Variables to skip deployment
export function loadManualContracts() {
  const envMap = {
    polygon:   process.env.CONTRACT_POLYGON,
    arbitrum:  process.env.CONTRACT_ARBITRUM,
    ethereum:  process.env.CONTRACT_ETHEREUM,
    avalanche: process.env.CONTRACT_AVALANCHE
  }
  for (const [chain, addr] of Object.entries(envMap)) {
    if (addr && addr.startsWith('0x') && addr.length === 42) {
      setConfig('contract_' + chain, addr)
      console.log('[DEPLOY] ' + chain + ': manual contract loaded: ' + addr)
    }
  }
      }
