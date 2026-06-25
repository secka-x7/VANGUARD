// X7-SV · bootstrap.js — ZERO SEED · ANY CHAIN · PARALLEL RACE
//
// REDESIGN:
//   Listens to 'arb_opportunity' from scanner on ALL chains
//   Races deployment across whichever chain fires first
//   ETH, ARB, BASE, POLYGON — all in parallel
//   First chain to get included → propagates to all others
//   Sub-400ms from gap detection to bundle submission

import {
  keccak256, encodePacked,
  encodeAbiParameters, parseAbiParameters
} from 'viem'
import { getActiveChains, getChain }             from './chains.js'
import { getContractAddr, setContractAddr,
         getExecutorAddress, getWalletClient,
         contractExists }                        from './pimlico.js'
import { compile, getArtifact }                  from './compiler.js'
import { getConfig, setConfig }                  from './db.js'
import { emit, on }                              from './events.js'

const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// ── RPC POOLS — ALL CHAINS ────────────────────────────────────────────────────
const RPC_POOLS = {
  ethereum: [
    process.env.ALCHEMY_ETH_KEY  ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}` : null,
    process.env.INFURA_KEY       ? `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}` : null,
    'https://eth.drpc.org',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
    'https://cloudflare-eth.com',
    'https://1rpc.io/eth',
  ].filter(Boolean),
  arbitrum: [
    process.env.ALCHEMY_ARB_KEY  ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}` : null,
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.drpc.org',
    'https://rpc.ankr.com/arbitrum',
    'https://arbitrum.llamarpc.com',
    'https://arbitrum.publicnode.com',
    'https://1rpc.io/arb',
  ].filter(Boolean),
  polygon: [
    process.env.ALCHEMY_POLY_KEY ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POLY_KEY}` : null,
    'https://polygon-rpc.com',
    'https://polygon.drpc.org',
    'https://rpc.ankr.com/polygon',
    'https://polygon.llamarpc.com',
    'https://polygon.publicnode.com',
    'https://1rpc.io/matic',
  ].filter(Boolean),
  base: [
    process.env.ALCHEMY_BASE_KEY ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : null,
    'https://mainnet.base.org',
    'https://base.drpc.org',
    'https://rpc.ankr.com/base',
    'https://base.llamarpc.com',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
  ].filter(Boolean),
}

// Builders per chain
const BUILDERS = {
  ethereum: [
    'https://rpc.titanbuilder.xyz',
    'https://rpc.beaverbuild.org',
    'https://rpc.buildernet.org',
    'https://rsync-builder.xyz',
    'https://relay.flashbots.net',
    'https://mev-share.flashbots.net',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://relay.flashbots.net',
  ],
  polygon: [
    'https://polygon-rpc.com',
    'https://rpc.ankr.com/polygon',
  ],
  base: [
    'https://mainnet.base.org',
    'https://rpc.ankr.com/base',
  ],
}

// Chain IDs
const CHAIN_IDS = {
  ethereum: 1,
  arbitrum: 42161,
  polygon:  137,
  base:     8453,
}

// ── RACE RPC ──────────────────────────────────────────────────────────────────
async function rpc(chainName, method, params = [], ms = 3000) {
  const providers = RPC_POOLS[chainName] || RPC_POOLS.ethereum
  const calls = providers.map(url =>
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal:  AbortSignal.timeout(ms)
    })
    .then(r => r.json())
    .then(d => {
      if (d.error || d.result === undefined) throw new Error(d.error?.message || 'no result')
      return d.result
    })
  )
  return Promise.any(calls)
}

// ── GAS ───────────────────────────────────────────────────────────────────────
const TIPS = [1_500_000_000n, 2_000_000_000n, 3_000_000_000n, 5_000_000_000n]

async function gasParams(chainName, attempt = 0) {
  const tip = TIPS[Math.min(attempt, TIPS.length - 1)]
  try {
    const block   = await rpc(chainName, 'eth_getBlockByNumber', ['latest', false])
    const baseFee = BigInt(block?.baseFeePerGas || '0x3b9aca00')
    return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip }
  } catch {
    return { maxFeePerGas: tip * 3n, maxPriorityFeePerGas: tip }
  }
}

// ── CREATE2 ───────────────────────────────────────────────────────────────────
let _computedAddr = null
let _salt         = null

function computeCreate2(bytecode) {
  const executor = getExecutorAddress()
  if (!executor) return null
  const salt         = keccak256(encodePacked(['address','string'], [executor, 'x7sv_v3']))
  const bytecodeHash = keccak256(bytecode)
  const preimage     = encodePacked(
    ['bytes1','address','bytes32','bytes32'],
    ['0xff', CREATE2_FACTORY, salt, bytecodeHash]
  )
  const addr = '0x' + keccak256(preimage).slice(-40)
  _salt = salt
  return { addr: addr.toLowerCase(), salt }
}

function deployCalldata(bytecode, constructorArgs, salt) {
  const selector   = '0x4af63f02'
  const initCode   = bytecode + constructorArgs.slice(2)
  const saltPadded = salt.slice(2).padStart(64, '0')
  const offset     = '0000000000000000000000000000000000000000000000000000000000000040'
  const len        = Math.floor((initCode.length - 2) / 2)
  const lenHex     = len.toString(16).padStart(64, '0')
  const dataHex    = initCode.slice(2).padEnd(Math.ceil(len / 32) * 64, '0')
  return selector + saltPadded + offset + lenHex + dataHex
}

function arbCalldata(opp, contractAddr, executor) {
  // crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)
  const selector = keccak256(
    new TextEncoder().encode(
      'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
    )
  ).slice(0, 10)

  const args = encodeAbiParameters(
    parseAbiParameters('address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'),
    [
      opp.flashToken,
      opp.flashAmountWei,
      opp.poolBuy,
      opp.poolSell,
      opp.assetToken,
      opp.buyFee,
      opp.sellFee,
      opp.minBuyAmount,
      opp.minSellUsdc,
      executor
    ]
  )
  return selector + args.slice(2)
}

// ── BUNDLE SUBMIT ─────────────────────────────────────────────────────────────
async function submitBundle(chainName, txs, blockNum) {
  const builders = BUILDERS[chainName] || BUILDERS.ethereum
  const blockHex = '0x' + blockNum.toString(16)

  const results = await Promise.allSettled(
    builders.map(url =>
      fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'eth_sendBundle',
          params:  [{
            txs,
            blockNumber:  blockHex,
            minTimestamp: 0,
            maxTimestamp: Math.floor(Date.now() / 1000) + 120
          }]
        }),
        signal: AbortSignal.timeout(2000)
      })
      .then(r => r.json())
      .then(d => ({ url, ok: !d.error }))
      .catch(() => ({ url, ok: false }))
    )
  )

  return results
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url.split('/')[2])
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const _inFlight  = new Set()  // chains with active bundle
const _live      = new Set()  // deployed chains
const _deploying = new Set()  // chains being deployed via direct tx

// ── CORE: EXECUTE BOOTSTRAP ON ANY CHAIN ─────────────────────────────────────
async function bootstrapChain(opp) {
  const { chain } = opp

  if (_live.has(chain))     return  // Already deployed
  if (_inFlight.has(chain)) return  // Bundle already in flight

  const artifact = getArtifact()
  if (!artifact) {
    console.log('[BOOTSTRAP] No artifact — compiler not ready')
    return
  }

  const computed = computeCreate2(artifact.bytecode)
  if (!computed) return

  // Check if already deployed
  const exists = await contractExists(chain, computed.addr).catch(() => false)
  if (exists) {
    setContractAddr(chain, computed.addr)
    _live.add(chain)
    console.log(`[BOOTSTRAP] ${chain} already deployed at ${computed.addr}`)
    emit('deploy_success', { chain, address: computed.addr, method: 'existing' })
    onChainLive(chain, computed.addr)
    return
  }

  _inFlight.add(chain)

  const executor = getExecutorAddress()
  const wallet   = getWalletClient(chain)
  const chainCfg = getChain(chain)

  if (!wallet || !chainCfg || !executor) {
    _inFlight.delete(chain)
    return
  }

  console.log(
    `[BOOTSTRAP] ${chain} | gap=${opp.gapPct}% | ` +
    `flash=$${(opp.flashAmountUsdc/1e6).toFixed(1)}M | ` +
    `profit~$${opp.profitUsdc.toLocaleString()}`
  )

  try {
    // Get nonce + block + gas in parallel — fastest possible
    const [nonceHex, blockHex, gas] = await Promise.all([
      rpc(chain, 'eth_getTransactionCount', [executor, 'pending']),
      rpc(chain, 'eth_blockNumber', []),
      gasParams(chain, 0)
    ])

    const nonce    = parseInt(nonceHex, 16)
    const blockNum = parseInt(blockHex, 16)
    const chainId  = CHAIN_IDS[chain] || 1

    // Constructor args
    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chainCfg.router   || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
        chainCfg.usdc     || opp.flashToken,
        chainCfg.weth     || opp.assetToken,
        opp.balancer      || '0x0000000000000000000000000000000000000000',
        opp.aave          || '0x0000000000000000000000000000000000000000'
      ]
    )

    const deployData = deployCalldata(artifact.bytecode, constructorArgs, computed.salt)
    const arbData    = arbCalldata(opp, computed.addr, executor)

    // Sign both txs simultaneously
    const [signedDeploy, signedArb] = await Promise.all([
      wallet.signTransaction({
        to: CREATE2_FACTORY, data: deployData,
        nonce, gas: 600000n, chainId, ...gas
      }),
      wallet.signTransaction({
        to: computed.addr, data: arbData,
        nonce: nonce + 1, gas: 900000n, chainId, ...gas
      })
    ])

    const bundle = [signedDeploy, signedArb]

    // Submit to next 3 blocks simultaneously — max coverage
    const targets = [blockNum + 1, blockNum + 2, blockNum + 3]
    console.log(`[BOOTSTRAP] ${chain} submitting to blocks ${targets.join(',')} nonce=${nonce}`)

    await Promise.all(targets.map(b => submitBundle(chain, bundle, b)))

    // Block time per chain
    const blockMs = { ethereum: 12000, arbitrum: 250, polygon: 2000, base: 2000 }[chain] || 5000

    // Check inclusion across 4 blocks with escalating tips
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(r => setTimeout(r, blockMs))

      const deployed = await contractExists(chain, computed.addr).catch(() => false)
      if (deployed) {
        setContractAddr(chain, computed.addr)
        _live.add(chain)
        _inFlight.delete(chain)
        console.log(`[BOOTSTRAP] ✓ ${chain.toUpperCase()} LIVE: ${computed.addr}`)
        emit('deploy_success', { chain, address: computed.addr, method: 'bundle-arb' })
        onChainLive(chain, computed.addr)
        return
      }

      if (attempt < 3) {
        // Escalate tip and resubmit
        const newGas = await gasParams(chain, attempt + 1)
        const [newDeploy, newArb] = await Promise.all([
          wallet.signTransaction({
            to: CREATE2_FACTORY, data: deployData,
            nonce, gas: 600000n, chainId, ...newGas
          }).catch(() => null),
          wallet.signTransaction({
            to: computed.addr, data: arbData,
            nonce: nonce + 1, gas: 900000n, chainId, ...newGas
          }).catch(() => null)
        ])

        if (newDeploy && newArb) {
          const nextTarget = blockNum + attempt + 4
          console.log(`[BOOTSTRAP] ${chain} escalate attempt ${attempt+2} → block ${nextTarget}`)
          await submitBundle(chain, [newDeploy, newArb], nextTarget)
        }
      }
    }

    console.log(`[BOOTSTRAP] ${chain} — 4 attempts done, waiting for next gap`)
    _inFlight.delete(chain)

  } catch (e) {
    console.error(`[BOOTSTRAP] ${chain} error:`, e.message?.slice(0, 100))
    _inFlight.delete(chain)
  }
}

// ── AFTER ANY CHAIN GOES LIVE ─────────────────────────────────────────────────
function onChainLive(chain, addr) {
  console.log(`[BOOTSTRAP] ${chain} live — cascading to all other chains`)

  // Deploy all remaining chains via direct tx (no arb needed — we have funds now)
  const remaining = getActiveChains().filter(c =>
    !_live.has(c.name) && !_deploying.has(c.name)
  )

  remaining.forEach((c, i) => {
    setTimeout(() => deployDirect(c.name), i * 500)
  })
}

// ── DIRECT DEPLOY (post first chain live) ────────────────────────────────────
async function deployDirect(chainName) {
  if (_live.has(chainName) || _deploying.has(chainName)) return
  _deploying.add(chainName)

  const artifact = getArtifact()
  if (!artifact) { _deploying.delete(chainName); return }

  const computed = computeCreate2(artifact.bytecode)
  if (!computed) { _deploying.delete(chainName); return }

  const exists = await contractExists(chainName, computed.addr).catch(() => false)
  if (exists) {
    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    _deploying.delete(chainName)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'existing' })
    return
  }

  try {
    const chainCfg = getChain(chainName)
    const executor = getExecutorAddress()
    const wallet   = getWalletClient(chainName)
    if (!wallet || !chainCfg || !executor) throw new Error('missing config')

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chainCfg.router   || '0x0000000000000000000000000000000000000001',
        chainCfg.usdc     || '0x0000000000000000000000000000000000000001',
        chainCfg.weth     || '0x0000000000000000000000000000000000000001',
        chainCfg.flashAddr|| '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        chainCfg.aavePool || '0x0000000000000000000000000000000000000001'
      ]
    )

    const deployData  = deployCalldata(artifact.bytecode, constructorArgs, computed.salt)
    const [nonceHex, blockHex, gas] = await Promise.all([
      rpc(chainName, 'eth_getTransactionCount', [executor, 'pending']),
      rpc(chainName, 'eth_blockNumber', []),
      gasParams(chainName, 0)
    ])

    const nonce   = parseInt(nonceHex, 16)
    const chainId = CHAIN_IDS[chainName] || 1

    const signed = await wallet.signTransaction({
      to: CREATE2_FACTORY, data: deployData,
      nonce, gas: 600000n, chainId, ...gas
    })

    // Send directly — we have funds from first chain's arb profit
    const hash = await rpc(chainName, 'eth_sendRawTransaction', [signed])
    if (!hash) throw new Error('no tx hash')

    console.log(`[BOOTSTRAP] ${chainName} deploy tx: ${hash.slice(0, 18)}`)

    // Wait for confirmation
    const blockMs = { ethereum: 12000, arbitrum: 250, polygon: 2000, base: 2000 }[chainName] || 5000
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, blockMs))
      const ok = await contractExists(chainName, computed.addr).catch(() => false)
      if (ok) {
        setContractAddr(chainName, computed.addr)
        _live.add(chainName)
        _deploying.delete(chainName)
        console.log(`[BOOTSTRAP] ✓ ${chainName} LIVE (direct): ${computed.addr}`)
        emit('deploy_success', { chain: chainName, address: computed.addr, method: 'direct' })
        return
      }
    }
    throw new Error('timeout')
  } catch (e) {
    console.error(`[BOOTSTRAP] ${chainName} direct deploy failed:`, e.message?.slice(0, 80))
    _deploying.delete(chainName)
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export function getBootstrapStatus() {
  const artifact = getArtifact()
  const computed = artifact ? computeCreate2(artifact.bytecode) : null
  return {
    computedAddress: computed?.addr || 'compiling...',
    liveChains:      [..._live],
    inFlightChains:  [..._inFlight],
    deployingChains: [..._deploying],
    allChains: getActiveChains().map(c => ({
      name:    c.name,
      status:  _live.has(c.name)      ? 'live'
             : _inFlight.has(c.name)  ? 'bundle-in-flight'
             : _deploying.has(c.name) ? 'deploying'
             : 'waiting',
      address: getContractAddr(c.name) || null
    }))
  }
}

// Keep vaults.js compatibility
export async function onMegaSwapDetected() {}

export async function initBootstrap() {
  console.log('[BOOTSTRAP] Initializing — zero seed · all chains · parallel race')

  const artifact = await compile()
  if (!artifact) {
    console.error('[BOOTSTRAP] Compile failed — fix compiler.js first')
    return
  }

  const computed = computeCreate2(artifact.bytecode)
  if (computed) {
    _computedAddr = computed.addr
    setConfig('create2_address', computed.addr)
    console.log('[BOOTSTRAP] CREATE2 address:', computed.addr)
  }

  // Restore already-deployed chains
  let restored = 0
  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name) || computed?.addr
    if (!stored) continue
    const exists = await contractExists(chain.name, stored).catch(() => false)
    if (exists) {
      setContractAddr(chain.name, stored)
      _live.add(chain.name)
      restored++
      console.log(`[BOOTSTRAP] ${chain.name} RESTORED: ${stored}`)
      emit('deploy_success', { chain: chain.name, address: stored, method: 'restored' })
    }
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(`[BOOTSTRAP] ${restored} chains restored | ${getActiveChains().length - restored} waiting`)

  if (_live.size > 0 && _live.size < getActiveChains().length) {
    // Some chains live, propagate to rest
    const remaining = getActiveChains().filter(c => !_live.has(c.name))
    remaining.forEach((c, i) => setTimeout(() => deployDirect(c.name), i * 500))
  }

  // THE MAIN TRIGGER — any chain, any gap
  on('arb_opportunity', opp => {
    if (_live.has(opp.chain)) return // already live on this chain
    bootstrapChain(opp).catch(e =>
      console.error(`[BOOTSTRAP] ${opp.chain}:`, e.message?.slice(0, 80))
    )
  })

  console.log('[BOOTSTRAP] Listening for arb_opportunity on ALL chains')
  console.log('[BOOTSTRAP] First gap wins — zero seed · zero ETH required')

  // Self-heal every 60s
  setInterval(async () => {
    const artifact = getArtifact()
    if (!artifact) return
    const computed = computeCreate2(artifact.bytecode)
    if (!computed) return
    for (const chain of getActiveChains()) {
      if (_live.has(chain.name)) continue
      const exists = await contractExists(chain.name, computed.addr).catch(() => false)
      if (exists) {
        setContractAddr(chain.name, computed.addr)
        _live.add(chain.name)
        emit('deploy_success', { chain: chain.name, address: computed.addr, method: 'healed' })
      }
    }
  }, 60000)
                              }
