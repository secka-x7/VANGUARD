import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { deployContract, getPublicClient } from './pimlico.js'
import { compile } from './compiler.js'

export async function deployAll() {
  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] Compile failed'); return }

  for (const chainName of ['polygon','arbitrum','base','ethereum']) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    const existing = getConfig(`contract_${chainName}`)
    if (existing && existing !== 'failed') {
      console.log(`[DEPLOY] ${chainName}: already deployed at ${existing}`)
      continue
    }
    try {
      const chain = CHAINS[chainName]
      const addr  = await deployContract(
        chainName, artifact.abi, artifact.bytecode,
        [chain.aavePool || '0x0000000000000000000000000000000000000001',
         chain.router, chain.usdc]
      )
      if (addr) {
        setConfig(`contract_${chainName}`, addr)
        console.log(`[DEPLOY] ${chainName}: deployed at ${addr}`)
      }
    } catch (e) {
      console.log(`[DEPLOY] ${chainName}: failed — ${e.message?.slice(0,100)}`)
      setConfig(`contract_${chainName}`, 'failed')
    }
    await new Promise(r => setTimeout(r, 3000))
  }
}
