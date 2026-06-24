// X7-SV · deployer.js — delegates to bootstrap.js (Architecture 1)
// Kept for backward compatibility — all logic is now in bootstrap.js

export { initBootstrap as startDeployer, triggerBootstrap, getBootstrapStatus } from './bootstrap.js'

export { initBootstrap as startDeployer, triggerBootstrap, getBootstrapStatus } from './bootstrap.js'

import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { compile } from './compiler.js'
import { computeCreate2Address, buildDeployCalldata, contractExists, setContractAddr, getContractAddr, getWalletClient, getPublicClient, sendTx, waitTx } from './pimlico.js'
import { executeBundle } from './builders.js'
import { getActiveChains, getChain } from './chains.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './index.js'

const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const _deploying = new Set()

// Build constructor args for X7.sol
function buildConstructorArgs(chain) {
  return encodeAbiParameters(
    parseAbiParameters('address,address,address,address'),
    [
      chain.router || '0x0000000000000000000000000000000000000001',
      chain.usdc   || '0x0000000000000000000000000000000000000001',
      chain.flashAddr || '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
      chain.aavePool  || '0x0000000000000000000000000000000000000001'
    ]
  )
}

export async function deployChain(chainName) {
  if (_deploying.has(chainName)) return null
  const existing = getContractAddr(chainName)
  if (existing) return existing

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY]', chainName, 'compile failed'); return null }

  const chain = getChain(chainName)
  if (!chain) return null

  _deploying.add(chainName)
  setConfig('deploy_status_' + chainName, 'deploying')

  try {
    const constructorArgs = buildConstructorArgs(chain)
    const { addr, salt } = computeCreate2Address(artifact.bytecode)
    const deployCalldata = buildDeployCalldata(artifact.bytecode, constructorArgs, salt)

    console.log('[DEPLOY]', chainName, '→ predicted address:', addr)

    // For Ethereum: bootstrap bundle (deploy + execute in same bundle, profit pays for deploy)
    if (chainName === 'ethereum' && chain.weth && chain.usdc) {
      // Build bootstrapExecute calldata
      const { encodeFunctionData, parseAbi } = await import('viem')
      const execData = encodeFunctionData({
        abi: parseAbi(['function bootstrapExecute(address,address,uint256,uint24,uint24,uint256) external']),
        functionName: 'bootstrapExecute',
        args: [chain.weth, chain.usdc, BigInt(100000e18), 500, 3000, 8000n]
      })

      // Build signed deploy tx
      const wallet = getWalletClient(chainName)
      const client = getPublicClient(chainName)
      if (!wallet || !client) throw new Error('No client')

      const nonce = await client.getTransactionCount({ address: wallet.account.address })
      const gas = { maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 2000000000n }
      const deployTx = await wallet.signTransaction({ to: CREATE2_FACTORY, data: deployCalldata, nonce, gas: 500000n, chainId: 1, ...gas })

      // Submit bootstrap bundle: [deploy, execute] — profit pays builder
      const result = await executeBundle(chainName, addr, execData, 1000, deployTx)
      if (result) {
        setContractAddr(chainName, addr)
        _deploying.delete(chainName)
        setConfig('deploy_status_' + chainName, 'live')
        console.log('[DEPLOY]', chainName, 'LIVE (zero-seed bootstrap):', addr)
        emit('deploy_success', { chain: chainName, address: addr })
        setTimeout(() => fundAllChains(addr).catch(() => {}), 5000)
        return addr
      }
    }

    // For L2s: direct deploy (gas is cents, funded from Ethereum profit via bridge)
    const hash = await sendTx(chainName, CREATE2_FACTORY, deployCalldata)
    if (!hash) throw new Error('sendTx returned null')

    const receipt = await waitTx(chainName, hash)
    if (!receipt || receipt.status === 'reverted') throw new Error('deploy reverted')

    // Verify contract exists at predicted address
    const exists = await contractExists(chainName, addr)
    if (!exists) throw new Error('contract not found at CREATE2 address')

    setContractAddr(chainName, addr)
    setConfig('deploy_status_' + chainName, 'live')
    _deploying.delete(chainName)
    console.log('[DEPLOY]', chainName, 'LIVE:', addr)
    emit('deploy_success', { chain: chainName, address: addr })
    return addr
  } catch (e) {
    console.error('[DEPLOY]', chainName, e.message?.slice(0, 100))
    setConfig('deploy_status_' + chainName, 'failed')
    _deploying.delete(chainName)
    return null
  }
}

// After first profit, bridge to fund all other chains
async function fundAllChains(fromContract) {
  const chains = getActiveChains().filter(c => c.name !== 'ethereum' && !getContractAddr(c.name))
  for (const chain of chains) {
    console.log('[DEPLOY] Queuing', chain.name, 'via bridge...')
    setConfig('bridge_queued_' + chain.name, 'true')
    emit('chain_funding', { chain: chain.name })
    // Small delay between chain deployments
    await new Promise(r => setTimeout(r, 3000))
    deployChain(chain.name).catch(e => console.log('[DEPLOY]', chain.name, e.message?.slice(0, 60)))
  }
}

export async function startDeployer() {
  const artifact = await compile()
  if (!artifact) return

  const chains = getActiveChains()
  const { addr } = computeCreate2Address(artifact.bytecode)
  console.log('[DEPLOY] X7.sol CREATE2 address (all chains):', addr)

  // Try immediate deploy for chains that already have balance
  for (const chain of chains) {
    const existing = getContractAddr(chain.name)
    if (existing) {
      console.log('[DEPLOY]', chain.name, 'already live:', existing)
      continue
    }
    // Check balance
    try {
      const bal = BigInt(await import('./rpc.js').then(m => m.rpcCall(chain.name, 'eth_getBalance', [
        (await import('./pimlico.js').then(m => m.getExecutorAddress())), 'latest'
      ])) || '0x0')
      if (bal > 0n) {
        deployChain(chain.name).catch(() => {})
      }
    } catch {}
  }
}
