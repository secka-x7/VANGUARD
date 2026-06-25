// X7-SV · bootstrap.js — Architecture 1 coordinator
// Stage 1: cross-pool arb deploy on ANY chain (parallel race)
// Delegates Stage 2+3 to deployer1a.js on first success
// No ETH-only restriction. Fastest chain wins. All others guaranteed via 1A.

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getActiveChains, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, contractExists } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'
import { computeAddr, directDeploy, onFirstDeploy, recoverDeployedChains, isLive, getStatus } from './deployer1a.js'

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// ── ETH RPC RACE POOL ────────────────────────────────────────────────────────
const ETH_RPCS = [
  process.env.ALCHEMY_ETH_KEY&&process.env.ALCHEMY_ETH_KEY!=='demo'
    ?`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}`:null,
  process.env.INFURA_KEY?`https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`:null,
  'https://eth.drpc.org','https://eth.llamarpc.com','https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com','https://cloudflare-eth.com','https://1rpc.io/eth',
].filter(Boolean)

async function ethRPC(method, params=[], ms=4000) {
  try {
    return await Promise.any(ETH_RPCS.map(url=>
      fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(ms)})
      .then(r=>r.json()).then(d=>{ if(d.error)throw new Error(d.error.message); return d.result })
    ))
  } catch { throw new Error('[RPC:eth] all exhausted') }
}

// ── GAS PARAMS ───────────────────────────────────────────────────────────────
// EIP-1559: maxFeePerGas = baseFee×2 + tip ← invariant guaranteed
const TIPS = [1500000000n,2000000000n,3000000000n,5000000000n]
async function gas(attempt=0) {
  const tip = TIPS[Math.min(attempt,3)]
  try {
    const b   = await ethRPC('eth_getBlockByNumber',['latest',false])
    const fee = BigInt(b?.baseFeePerGas||'0x3b9aca00')
    return { maxFeePerGas:fee*2n+tip, maxPriorityFeePerGas:tip }
  } catch { return { maxFeePerGas:tip*3n, maxPriorityFeePerGas:tip } }
}

// ── BUILDERS ─────────────────────────────────────────────────────────────────
const BUILDERS = [
  'https://rpc.titanbuilder.xyz','https://rpc.buildernet.org',
  'https://rpc.beaverbuild.org', 'https://rsync-builder.xyz',
  'https://relay.flashbots.net', 'https://mev-share.flashbots.net',
]
async function submitBundle(txs, block) {
  const body = JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendBundle',
    params:[{txs,blockNumber:'0x'+block.toString(16),minTimestamp:0,maxTimestamp:Math.floor(Date.now()/1000)+60}]})
  const res = await Promise.allSettled(BUILDERS.map(url=>
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(3000)})
    .then(r=>r.json()).then(d=>({url,ok:!!d.result})).catch(()=>({url,ok:false}))
  ))
  return res.filter(r=>r.status==='fulfilled'&&r.value.ok).map(r=>r.value.url.split('/')[2])
}

// ── CALLDATA BUILDERS ────────────────────────────────────────────────────────
function buildDeploy(bytecode, salt, chain) {
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,address,address,address'),
    [chain.router||'0x0000000000000000000000000000000000000001',
     chain.usdc  ||'0x0000000000000000000000000000000000000001',
     chain.weth  ||'0x0000000000000000000000000000000000000001',
     chain.flashAddr||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aavePool ||'0x0000000000000000000000000000000000000001']
  )
  const init = bytecode+args.slice(2)
  const len  = Math.floor((init.length-2)/2)
  return '0x4af63f02'+salt.slice(2).padStart(64,'0')+
    '0000000000000000000000000000000000000000000000000000000000000040'+
    len.toString(16).padStart(64,'0')+
    init.slice(2).padEnd(Math.ceil(len/32)*64,'0')
}

function buildArb(opp, addr, exec) {
  const sel = '0x'+keccak256(new TextEncoder().encode(
    'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
  )).slice(2,10)
  return sel+encodeAbiParameters(
    parseAbiParameters('address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'),
    [opp.flashToken,opp.flashAmountWei,opp.poolBuy,opp.poolSell,
     opp.assetToken,opp.buyFee,opp.sellFee,opp.minBuyAmount,opp.minSellUsdc,exec]
  ).slice(2)
}

// ── PER-CHAIN BUNDLE STATE ────────────────────────────────────────────────────
const _inFlight = new Map() // chainName → timestamp
const COOLDOWN  = 13000     // one ETH block

// ── CORE EXECUTE: any chain, any opportunity ──────────────────────────────────
async function execute(opp) {
  const { chain } = opp
  if (isLive(chain)) return null
  if (Date.now()-(_inFlight.get(chain)||0) < COOLDOWN) return null

  const artifact = getArtifact()
  const chainCfg = getChain(chain)
  const exec     = getExecutorAddress()
  if (!artifact||!chainCfg||!exec) return null

  const computed = computeAddr(artifact.bytecode)
  if (!computed) return null

  // Already deployed? activate immediately
  if (await contractExists(chain, computed.addr).catch(()=>false)) {
    setContractAddr(chain, computed.addr)
    await onFirstDeploy(chain)
    emit('deploy_success',{chain,address:computed.addr,method:'already-live'})
    return computed.addr
  }

  _inFlight.set(chain, Date.now())

  // ETH uses Flashbots bundle (MEV infra). L2s use direct tx (gas is cents).
  if (chain !== 'ethereum') {
    // L2: direct tx — no bundle needed, gas < $0.05
    const result = await directDeploy(chain)
    if (result) {
      await onFirstDeploy(chain)
      _inFlight.delete(chain)
      return result
    }
    _inFlight.delete(chain)
    return null
  }

  // ETH: Flashbots bundle with cross-pool arb
  const wallet = getWalletClient('ethereum')
  if (!wallet) { _inFlight.delete(chain); return null }

  try {
    const [nonceHex, blockHex, g] = await Promise.all([
      ethRPC('eth_getTransactionCount',[exec,'pending']),
      ethRPC('eth_blockNumber',[]),
      gas(0)
    ])
    const nonce    = parseInt(nonceHex,16)
    const blockNum = parseInt(blockHex,16)

    const deployData = buildDeploy(artifact.bytecode, computed.salt, chainCfg)
    const arbData    = buildArb(opp, computed.addr, exec)

    const sign = async (to, data, n, g_) =>
      wallet.signTransaction({to,data,nonce:n,gas:n===nonce?600000n:900000n,chainId:1,...g_})

    let [sDeploy, sArb] = await Promise.all([
      sign(CREATE2, deployData, nonce,   g),
      sign(computed.addr, arbData, nonce+1, g)
    ]).catch(()=>[null,null])

    if (!sDeploy||!sArb) { _inFlight.delete(chain); return null }

    for (let i=0; i<4; i++) {
      const target = blockNum+i+1
      const wins   = await submitBundle([sDeploy,sArb], target)
      submitBundle([sDeploy,sArb], target+1).catch(()=>{}) // double coverage
      if (wins.length) console.log(`[BOOTSTRAP] ETH block=${target} tip=${g.maxPriorityFeePerGas/1000000000n}gwei → ${wins.join(',')}`)

      await new Promise(r=>setTimeout(r,12500))

      if (await contractExists('ethereum', computed.addr).catch(()=>false)) {
        setContractAddr('ethereum', computed.addr)
        console.log('[BOOTSTRAP] ✓ ETH LIVE:', computed.addr)
        emit('deploy_success',{chain:'ethereum',address:computed.addr,method:'arb-bundle'})
        await onFirstDeploy('ethereum')
        _inFlight.delete(chain)
        return computed.addr
      }

      if (i<3) {
        const ng = await gas(i+1)
        console.log(`[BOOTSTRAP] ETH escalate → ${ng.maxPriorityFeePerGas/1000000000n}gwei`)
        ;[sDeploy,sArb] = await Promise.all([
          sign(CREATE2,deployData,nonce,ng).catch(()=>null),
          sign(computed.addr,arbData,nonce+1,ng).catch(()=>null)
        ])
        if (!sDeploy||!sArb) break
        Object.assign(g,ng)
      }
    }
  } catch(e) { console.error('[BOOTSTRAP] ETH error:',e.message?.slice(0,80)) }

  _inFlight.delete(chain)
  return null
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────
export const getBootstrapStatus = getStatus

export async function initBootstrap() {
  const artifact = getArtifact()
  if (!artifact) { console.error('[BOOTSTRAP] No artifact — compile failed'); return }

  const computed = computeAddr(artifact.bytecode)
  if (computed) {
    console.log('[BOOTSTRAP] CREATE2 address (all chains):', computed.addr)
    console.log('[BOOTSTRAP] RPC pool:', ETH_RPCS.length, 'providers (race mode)')
    setConfig('create2_address', computed.addr)
  }

  // Recover any already-deployed chains (handles Railway redeploy)
  const recovered = await recoverDeployedChains(computed?.addr)
  const live = getStatus().liveChains
  console.log(`[BOOTSTRAP] ${recovered}/${getActiveChains().length} chains recovered`)

  if (recovered > 0) {
    // Some chains already live — trigger cascade for the rest
    const anchor = live[0]
    if (anchor) await onFirstDeploy(anchor).catch(()=>{})
  } else {
    console.log('[BOOTSTRAP] ETH waiting for scanner gap (0.15%) or L2 gap (0.01%)')
    console.log('[BOOTSTRAP] Executor wallet: $0.00 required')
  }

  // MAIN TRIGGER: any chain, any gap → execute immediately
  // No ETH-only filter. Fastest chain wins.
  on('arb_opportunity', opp => {
    if (!isLive(opp.chain)) execute(opp).catch(()=>{})
  })

  console.log('[BOOTSTRAP] Listening: all 17 chains race simultaneously')
  console.log('[BOOTSTRAP] First gap → deploy → cascade → all chains < 5min')

  // Self-heal: retry failed chains every 60s
  setInterval(async () => {
    const status = getStatus()
    for (const c of status.allChains) {
      if (c.status==='failed'&&!isLive(c.name)) {
        console.log('[BOOTSTRAP] Self-heal retry:', c.name)
        await directDeploy(c.name).catch(()=>{})
      }
    }
  }, 60000)
}

// Keep for backward compat — now no-op (scanner handles triggers)
export const onMegaSwapDetected = async () => {}
