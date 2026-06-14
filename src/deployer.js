// X7 PROTOCOL — DEPLOYER
// Uses CREATE2 factory so 'to' is never null (ERC-4337 requirement)
// Pimlico verifying paymaster pays gas from free credits
// Manual override: set CONTRACT_POLYGON=0x... in Railway Variables

import { encodeFunctionData, parseAbi, keccak256, encodeAbiParameters,
         parseAbiParameters, concat, toHex } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { sendViaPimlico, getPublicClient } from './pimlico.js'
import { compile } from './compiler.js'

// This factory exists on Polygon, Arbitrum, Avalanche, Ethereum — same address
const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const FACTORY_ABI = parseAbi([
  'function deploy(uint256 amount, bytes32 salt, bytes memory bytecode) returns (address)'
])

export function loadManualContracts() {
  const map = {
    polygon:   process.env.CONTRACT_POLYGON,
    arbitrum:  process.env.CONTRACT_ARBITRUM,
    ethereum:  process.env.CONTRACT_ETHEREUM,
    avalanche: process.env.CONTRACT_AVALANCHE
  }
  for (const [chain, addr] of Object.entries(map)) {
    if (addr?.startsWith('0x') && addr.length === 42) {
      setConfig('contract_' + chain, addr)
      console.log('[DEPLOY] ' + chain + ': manual override: ' + addr)
    }
  }
}

function computeCreate2Address(salt, bytecode) {
  const hash = keccak256(concat([
    '0xff',
    CREATE2_FACTORY,
    salt,
    keccak256(bytecode)
  ]))
  return '0x' + hash.slice(26)
}

async function isDeployed(chainName, address) {
  try {
    const code = await getPublicClient(chainName).getBytecode({ address })
    return code && code.length > 2
  } catch { return false }
}

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing !== 'failed') {
    console.log('[DEPLOY] ' + chainName + ': already at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] compile failed'); return null }

  try {
    const salt = toHex(0, { size: 32 })

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address, address, address'),
      [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    )

    const fullBytecode    = artifact.bytecode + constructorArgs.slice(2)
    const expectedAddr    = computeCreate2Address(salt, fullBytecode)

    console.log('[DEPLOY] ' + chainName + ': expected address → ' + expectedAddr)

    // Already deployed — just save and return
    if (await isDeployed(chainName, expectedAddr)) {
      setConfig('contract_' + chainName, expectedAddr)
      console.log('[DEPLOY] ' + chainName + ': already live, saved')
      return expectedAddr
    }

    // Encode call to CREATE2 factory — 'to' is a real address, not null
    const data = encodeFunctionData({
      abi:          FACTORY_ABI,
      functionName: 'deploy',
      args:         [0n, salt, fullBytecode]
    })

    console.log('[DEPLOY] ' + chainName + ': sending via Pimlico free credits...')
    const txHash = await sendViaPimlico(chainName, CREATE2_FACTORY, data, 0n)
    if (!txHash) throw new Error('no tx hash returned')

    // Wait for confirmation
    await new Promise(r => setTimeout(r, 6000))

    if (await isDeployed(chainName, expectedAddr)) {
      setConfig('contract_' + chainName, expectedAddr)
      console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + expectedAddr)
      return expectedAddr
    } else {
      // Tx sent but not confirmed yet — save optimistically
      setConfig('contract_' + chainName, expectedAddr)
      console.log('[DEPLOY] ' + chainName + ': tx sent, confirming → ' + txHash)
      return expectedAddr
    }
  } catch (e) {
    console.error('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 150))
    setConfig('contract_' + chainName, 'failed')
    return null
  }
}

export async function deployAll() {
  loadManualContracts()
  console.log('[DEPLOY] Starting deployment via Pimlico free credits...')
  for (const chainName of ['polygon', 'arbitrum', 'avalanche', 'ethereum']) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + e.message?.slice(0, 80))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
  }
