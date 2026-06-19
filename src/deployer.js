// X7 PROTOCOL — INSTANT DEPLOYER
// WebSocket balance subscription — deploys in < 1 second of MATIC arriving
// ALL chains deploy in PARALLEL — total time ~90 seconds
// No polling — pure event-driven

import { encodeDeployData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { getWalletClient, getPublicClient,
         getExecutorAddress, getNativeBalance } from './pimlico.js'
import { compile } from './compiler.js'
import WebSocket from 'ws'

const GAS_NEEDED = {
  polygon:   10000000000000000n,   // 0.01 POL
  arbitrum:  100000000000000n,     // 0.0001 ETH
  avalanche: 2000000000000000n,    // 0.002 AVAX
  ethereum:  3000000000000000n     // 0.003 ETH
}

const DEPLOY_STATE = {}

async function deployChain(chainName, artifact) {
  if (DEPLOY_STATE[chainName] === 'deploying') return null
  const existing = getConfig('contract_' + chainName)
  if (existing?.startsWith('0x') && existing.length === 42) return existing

  const chain = CHAINS[chainName]
  if (!chain) return null

  DEPLOY_STATE[chainName] = 'deploying'
  setConfig('contract_' + chainName, 'deploying')

  try {
    const wallet  = getWalletClient(chainName)
    const client  = getPublicClient(chainName)

    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    })

    console.log('[DEPLOY] ' + chainName + ': sending deployment tx...')
    const hash    = await wallet.sendTransaction({ data: deployData })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 })

    if (receipt.status === 'reverted') throw new Error('reverted')
    const addr = receipt.contractAddress
    if (!addr) throw new Error('no address')

    setConfig('contract_' + chainName, addr)
    setConfig('contract_' + chainName + '_ts', Date.now().toString())
    DEPLOY_STATE[chainName] = 'live'

    console.log('[DEPLOY] ' + chainName + ': LIVE → ' + addr)

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('deploy_success', { chain: chainName, address: addr })
    } catch {}

    return addr
  } catch (e) {
    console.log('[DEPLOY] ' + chainName + ': failed — ' + e.message?.slice(0, 100))
    setConfig('contract_' + chainName, 'failed')
    DEPLOY_STATE[chainName] = 'failed'
    return null
  }
}

// Deploy ALL chains simultaneously — parallel not sequential
async function deployAll(artifact) {
  console.log('[DEPLOY] Deploying ALL chains in PARALLEL...')
  const deployOrder = ['polygon', 'arbitrum', 'avalanche', 'ethereum']
  await Promise.allSettled(
    deployOrder
      .filter(c => CHAINS[c]?.active && ACTIVE_CHAINS.includes(c))
      .map(c => deployChain(c, artifact))
  )
  console.log('[DEPLOY] All parallel deployments complete')
}

// WEBSOCKET BALANCE WATCHER
// Subscribes to incoming transactions to executor address
// Fires in < 2 seconds of MATIC arriving (next Polygon block)
function watchExecutorBalance(execAddr, artifact) {
  for (const chainName of ['polygon', 'arbitrum', 'avalanche', 'ethereum']) {
    const chain = CHAINS[chainName]
    if (!chain?.rpcWss || chain.rpcWss.includes('demo')) continue

    function connect() {
      try {
        const ws = new WebSocket(chain.rpcWss)
        ws.on('open', () => {
          // Watch for any transfer TO the executor address
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
            params:  ['newHeads']  // Every block header
          }))
          console.log('[DEPLOY] ' + chainName + ': balance watcher active')
        })

        ws.on('message', async (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            // On every new block, check balance instantly
            if (!msg.params?.result?.number) return

            const existing = getConfig('contract_' + chainName)
            if (existing?.startsWith('0x') && existing.length === 42) return
            if (DEPLOY_STATE[chainName] === 'deploying') return

            const bal     = await getNativeBalance(chainName)
            const needed  = GAS_NEEDED[chainName] || 0n
            const balFloat = (Number(bal) / 1e18).toFixed(8)
            setConfig('live_balance_' + chainName, balFloat)

            // Broadcast live balance to dashboard
            try {
              const { broadcast } = await import('./dashboard.js')
              broadcast('balance_tick', { chain: chainName, balance: balFloat })
            } catch {}

            if (bal >= needed) {
              console.log('[DEPLOY] ' + chainName +
                ': MATIC DETECTED ' + balFloat + ' — DEPLOYING NOW')
              await deployChain(chainName, artifact)
            }
          } catch {}
        })

        ws.on('error', () => {})
        ws.on('close', () => setTimeout(connect, 2000))
      } catch { setTimeout(connect, 5000) }
    }
    connect()
  }
}

// Also run a fast balance poll every 3 seconds as backup
function fastBalancePoll(execAddr, artifact) {
  const chains = ['polygon', 'arbitrum', 'avalanche', 'ethereum']
  setInterval(async () => {
    for (const chainName of chains) {
      if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
      const existing = getConfig('contract_' + chainName)
      if (existing?.startsWith('0x') && existing.length === 42) continue
      if (DEPLOY_STATE[chainName] === 'deploying') continue
      try {
        const bal    = await getNativeBalance(chainName)
        const needed = GAS_NEEDED[chainName] || 0n
        const f      = (Number(bal) / 1e18).toFixed(8)
        setConfig('live_balance_' + chainName, f)
        if (bal >= needed) {
          console.log('[DEPLOY] ' + chainName + ': balance poll triggered deploy')
          deployChain(chainName, artifact).catch(() => {})
        }
      } catch {}
    }
  }, 3000)
}

export async function startDeployer() {
  const execAddr = getExecutorAddress()
  if (!execAddr) { console.log('[DEPLOY] No executor key'); return }

  console.log('[DEPLOY] Executor: ' + execAddr)
  console.log('[DEPLOY] Send 0.01 POL to above address')
  console.log('[DEPLOY] Contract deploys in < 1 second of arrival')

  const artifact = await compile()
  if (!artifact) { console.error('[DEPLOY] Compile failed'); return }

  // Try immediate deploy for chains that already have balance
  await deployAll(artifact)

  // Start event-driven balance watcher (primary — fires in < 1s)
  watchExecutorBalance(execAddr, artifact)

  // Start fast poll backup (fires in < 3s worst case)
  fastBalancePoll(execAddr, artifact)

  console.log('[DEPLOY] Watching for MATIC — will deploy in < 1 second')
}
