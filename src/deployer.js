// X7 PROTOCOL — DEPLOYER
// Called by bootstrap.js. Clean EOA deploy.

import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { deployContract } from './pimlico.js'
import { compile } from './compiler.js'

export async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing !== 'failed') {
    console.log('[DEPLOY] ' + chainName + ': already at ' + existing)
    return existing
  }
  const chain    = CHAINS[chainName]
  if (!chain) return null
  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] compile failed'); return null }
  console.log('[DEPLOY] ' + chainName + ': deploying...')
  try {
    const addr = await deployContract(chainName, artifact.abi, artifact.bytecode, [
      chain.aavePool || '0x0000000000000000000000000000000000000001',
      chain.router,
      chain.usdc
    ])
    if (addr) {
      setConfig('contract_' + chainName, addr)
      console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + addr)
      return addr
    }
    return null
  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + (e.message||'').slice(0,150))
    setConfig('contract_' + chainName, 'failed')
    return null
  }
}

export async function deployAll() {
  for (const chainName of ACTIVE_CHAINS) {
    if (chainName === 'ethereum') continue // Ethereum via Flashbots only
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + (e.message||'').slice(0,80))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
}
