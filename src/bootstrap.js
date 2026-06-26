// X7-SV · bootstrap.js — First Swap = All 17 Chains
// PRE-DESIGN: all txs signed at boot → submitted simultaneously on first swap
// DIAGNOSTIC: logs exact failure reason for every step
// PRIMARY: mega_swap → submitAllOnFirstSwap (milliseconds)
// SECONDARY: arb_opportunity from scanner (measured gap)
// ETH PATH: Flashbots bundle (arb covers gas)
// L2 PATH: pre-signed direct deploy (hardcoded gas)

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getActiveChains, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, contractExists } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'
import { computeAddr, presignAllChains, submitAllOnFirstSwap, directDeploy, onFirstDeploy, recoverDeployedChains, isLive, getStatus, queueSwap } from './deployer1a.js'

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// ── ETH RPC RACE POOL ────────────────────────────────────────────────────────
const ETH_RPCS = [
  process.env.ALCHEMY_ETH_KEY&&process.env.ALCHEMY_ETH_KEY!=='demo'
    ?`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}`:null,
  process.env.INFURA_KEY?`https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`:null,
  'https://eth.drpc.org','https://eth.llamarpc.com','https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com','https://cloudflare-eth.com','https://1rpc.io/eth',
].filter(Boolean)

async function ethRPC(method,params=[],ms=4000) {
  try {
    return await Promise.any(ETH_RPCS.map(url=>
      fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(ms)})
      .then(r=>r.json()).then(d=>{ if(d.error)throw new Error(d.error.message); return d.result })
    ))
  } catch(e) { throw new Error(`[ETH-RPC] all ${ETH_RPCS.length} providers failed: ${e.message}`) }
}

// ── GAS — EIP-1559 INVARIANT ─────────────────────────────────────────────────
const TIPS=[1500000000n,2000000000n,3000000000n,5000000000n]
async function getGas(attempt=0) {
  const tip=TIPS[Math.min(attempt,3)]
  try {
    const b=await ethRPC('eth_getBlockByNumber',['latest',false])
    const base=BigInt(b?.baseFeePerGas||'0x3b9aca00')
    const maxFee=base*2n+tip
    console.log(`[BOOTSTRAP] gas attempt=${attempt} base=${base/1000000000n}gwei tip=${tip/1000000000n}gwei maxFee=${maxFee/1000000000n}gwei`)
    return {maxFeePerGas:maxFee,maxPriorityFeePerGas:tip}
  } catch(e) {
    console.warn(`[BOOTSTRAP] gas estimation failed: ${e.message} — using fallback`)
    return {maxFeePerGas:tip*3n,maxPriorityFeePerGas:tip}
  }
}

// ── BUILDERS ─────────────────────────────────────────────────────────────────
const BUILDERS=['https://rpc.titanbuilder.xyz','https://rpc.buildernet.org',
  'https://rpc.beaverbuild.org','https://rsync-builder.xyz',
  'https://relay.flashbots.net','https://mev-share.flashbots.net']

async function submitBundle(txs,block) {
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendBundle',
    params:[{txs,blockNumber:'0x'+block.toString(16),minTimestamp:0,maxTimestamp:Math.floor(Date.now()/1000)+60}]})
  const res=await Promise.allSettled(BUILDERS.map(url=>
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(3000)})
    .then(r=>r.json()).then(d=>({url,ok:!!d.result,result:d.result,error:d.error})).catch(e=>({url,ok:false,error:e.message}))
  ))
  const wins=res.filter(r=>r.status==='fulfilled'&&r.value.ok).map(r=>r.value.url.split('/')[2])
  const errs=res.filter(r=>r.status==='fulfilled'&&!r.value.ok).map(r=>`${r.value.url.split('/')[2]}:${JSON.stringify(r.value.error)?.slice(0,60)}`)
  if (errs.length) console.log(`[BOOTSTRAP] Bundle rejections: ${errs.join(' | ')}`)
  return wins
}

// ── CALLDATA ─────────────────────────────────────────────────────────────────
function buildDeploy(bytecode,salt,chain) {
  const args=encodeAbiParameters(parseAbiParameters('address,address,address,address,address'),
    [chain.router||'0x0000000000000000000000000000000000000001',
     chain.usdc  ||'0x0000000000000000000000000000000000000001',
     chain.weth  ||'0x0000000000000000000000000000000000000001',
     chain.flashAddr||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aavePool ||'0x0000000000000000000000000000000000000001'])
  const init=bytecode+args.slice(2), len=Math.floor((init.length-2)/2)
  return '0x4af63f02'+salt.slice(2).padStart(64,'0')+'0'.repeat(63)+'40'+
    len.toString(16).padStart(64,'0')+init.slice(2).padEnd(Math.ceil(len/32)*64,'0')
}

function buildCrossPoolArb(opp,contractAddr,exec) {
  const sel='0x'+keccak256(new TextEncoder().encode(
    'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
  )).slice(2,10)
  return sel+encodeAbiParameters(
    parseAbiParameters('address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'),
    [opp.flashToken,opp.flashAmountWei,opp.poolBuy,opp.poolSell,
     opp.assetToken,opp.buyFee,opp.sellFee,opp.minBuyAmount,opp.minSellUsdc,exec]
  ).slice(2)
}

// ── ETH FLASHBOTS BUNDLE ─────────────────────────────────────────────────────
const _ethInFlight={ts:0}
async function deployETH(opp) {
  if (isLive('ethereum')||Date.now()-_ethInFlight.ts<13000) return null
  _ethInFlight.ts=Date.now()

  const artifact=getArtifact(),chain=getChain('ethereum'),exec=getExecutorAddress(),wallet=getWalletClient('ethereum')
  if (!artifact||!chain||!exec||!wallet) {
    console.error('[BOOTSTRAP] ETH: missing deps',{artifact:!!artifact,chain:!!chain,exec:!!exec,wallet:!!wallet})
    return null
  }

  const computed=computeAddr(artifact.bytecode)
  if (!computed) return null

  if (await contractExists('ethereum',computed.addr).catch(()=>false)) {
    setContractAddr('ethereum',computed.addr); await onFirstDeploy('ethereum'); return computed.addr
  }

  try {
    const [nonceHex,blockHex,g]=await Promise.all([
      ethRPC('eth_getTransactionCount',[exec,'pending']),
      ethRPC('eth_blockNumber',[]),
      getGas(0)
    ])
    const nonce=parseInt(nonceHex,16), blockNum=parseInt(blockHex,16)
    console.log(`[BOOTSTRAP] ETH bundle: nonce=${nonce} block=${blockNum} addr=${computed.addr}`)

    const deployData=buildDeploy(artifact.bytecode,computed.salt,chain)
    const arbData=buildCrossPoolArb(opp,computed.addr,exec)

    let sd=await wallet.signTransaction({to:CREATE2,data:deployData,nonce,gas:700000n,chainId:1,...g}).catch(e=>{
      console.error('[BOOTSTRAP] ETH sign deploy failed:',e.message?.slice(0,120)); return null
    })
    let sa=await wallet.signTransaction({to:computed.addr,data:arbData,nonce:nonce+1,gas:900000n,chainId:1,...g}).catch(e=>{
      console.error('[BOOTSTRAP] ETH sign arb failed:',e.message?.slice(0,120)); return null
    })
    if (!sd||!sa) return null

    // SIMULATE FIRST — this tells us if the arb will work
    try {
      const sim=await ethRPC('eth_callBundle',[{txs:[sd,sa],blockNumber:'0x'+blockNum.toString(16),stateBlockNumber:'latest'}])
      if (sim?.results) {
        sim.results.forEach((r,i)=>{
          if (r.revert||r.error) console.error(`[BOOTSTRAP] ETH sim tx[${i}] REVERT: ${r.revert||r.error}`)
          else console.log(`[BOOTSTRAP] ETH sim tx[${i}] OK gasUsed=${r.gasUsed}`)
        })
        const hasRevert=sim.results.some(r=>r.revert||r.error)
        if (hasRevert) {
          console.error('[BOOTSTRAP] ETH bundle simulation failed — bundle will revert')
          console.error('[BOOTSTRAP] Gap may have closed or arb params incorrect')
          _ethInFlight.ts=0
          return null
        }
        console.log('[BOOTSTRAP] ETH bundle simulation PASSED — submitting')
      }
    } catch(e) {
      // eth_callBundle not available on all providers — continue anyway
      console.warn('[BOOTSTRAP] ETH sim not available:',e.message?.slice(0,60))
    }

    for (let i=0;i<4;i++) {
      const target=blockNum+i+1
      const wins=await submitBundle([sd,sa],target)
      submitBundle([sd,sa],target+1).catch(()=>{})
      console.log(`[BOOTSTRAP] ETH attempt ${i+1}/4 block=${target} builders=${wins.join(',')||'none'}`)

      await new Promise(r=>setTimeout(r,12500))

      if (await contractExists('ethereum',computed.addr).catch(()=>false)) {
        setContractAddr('ethereum',computed.addr)
        console.log('[BOOTSTRAP] ✓ ETH LIVE:',computed.addr)
        emit('deploy_success',{chain:'ethereum',address:computed.addr,method:'flashbots'})
        await onFirstDeploy('ethereum')
        _ethInFlight.ts=0
        return computed.addr
      }

      if (i<3) {
        const ng=await getGas(i+1)
        const[nd,na]=await Promise.all([
          wallet.signTransaction({to:CREATE2,data:deployData,nonce,gas:700000n,chainId:1,...ng}).catch(()=>null),
          wallet.signTransaction({to:computed.addr,data:arbData,nonce:nonce+1,gas:900000n,chainId:1,...ng}).catch(()=>null)
        ])
        if (nd&&na){sd=nd;sa=na;Object.assign(g,ng)}
      }
    }
  } catch(e) { console.error('[BOOTSTRAP] ETH error:',e.message?.slice(0,100)) }

  _ethInFlight.ts=0
  return null
}

// ── POOL PAIRS FOR SWAP-BASED BOOTSTRAP PARAMS ────────────────────────────────
// Maps pool addr → partner pool for crossPoolArb construction
const POOL_PAIRS={
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640':{chain:'ethereum',partner:'0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',buyFee:500, sellFee:3000,tvl:80e6},
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8':{chain:'ethereum',partner:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',buyFee:3000,sellFee:500, tvl:150e6},
  '0xc6962004f452be9203591991d15f6b388e09e8d0':{chain:'arbitrum',partner:'0x2f5e87C9312fa29aed5c179E456625D79015299c',buyFee:500, sellFee:3000,tvl:30e6},
  '0x2f5e87c9312fa29aed5c179e456625d79015299c':{chain:'arbitrum',partner:'0xC6962004f452bE9203591991D15f6b388e09E8D0',buyFee:3000,sellFee:500, tvl:80e6},
  '0x45dda9cb7c25131df268515131f647d726f50608':{chain:'polygon', partner:'0x50eaEDB835021E4A108B7290636d62E9765cc6d7',buyFee:500, sellFee:3000,tvl:15e6},
  '0x50eaedb835021e4a108b7290636d62e9765cc6d7':{chain:'polygon', partner:'0x45dDa9cb7c25131DF268515131f647d726f50608',buyFee:3000,sellFee:500, tvl:30e6},
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5':{chain:'base',    partner:'0xd0b53D9277642d899DF5C87A3966A349A798F224',buyFee:500, sellFee:3000,tvl:20e6},
  '0xd0b53d9277642d899df5c87a3966a349a798f224':{chain:'base',    partner:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',buyFee:3000,sellFee:500, tvl:50e6},
}

function swapToArbParams(swapUSD,poolAddr,chainName) {
  const pair=POOL_PAIRS[poolAddr?.toLowerCase()]
  if (!pair||pair.chain!==chainName) return null
  const chain=getChain(chainName)
  if (!chain?.usdc||!chain?.weth) return null
  const cexPrice=parseFloat(getConfig('prices')?JSON.parse(getConfig('prices')).ETH:0)||0
  if (!cexPrice) { console.warn(`[BOOTSTRAP] ${chainName}: no CEX price yet — waiting`); return null }
  const flash=Math.min(pair.tvl*0.08,20e6)
  if (flash<50000) return null
  const flashWei=BigInt(Math.floor(flash*1e6))
  const minBuy  =BigInt(Math.floor((flash/cexPrice)*0.97*1e18))
  const minSell =BigInt(Math.floor(flash*1.001*1e6))
  console.log(`[BOOTSTRAP] ${chainName} arb params: flash=$${(flash/1e6).toFixed(1)}M ethPrice=$${cexPrice} minBuy=${minBuy} minSell=${minSell}`)
  return {
    flashToken:chain.usdc, assetToken:chain.weth,
    flashAmountWei:flashWei, poolBuy:poolAddr, poolSell:pair.partner,
    buyFee:pair.buyFee, sellFee:pair.sellFee,
    minBuyAmount:minBuy, minSellUsdc:minSell
  }
}

// ── MEGA_SWAP HANDLER — PRIMARY TRIGGER ──────────────────────────────────────
let _firstSwapFired=false
async function onMegaSwap({chain,swapUSD,log,poolAddr}) {
  // Queue for replay (in case deploy hasn't completed yet)
  if (!isLive(chain)) queueSwap({chain,swapUSD,log,poolAddr})

  // First swap ever → submit all 17 pre-signed deploy txs simultaneously
  if (!_firstSwapFired) {
    _firstSwapFired=true
    console.log(`[BOOTSTRAP] ★ FIRST SWAP: ${chain} $${(swapUSD/1e6).toFixed(0)}M → submitting all 17 chains`)
    await submitAllOnFirstSwap()
  }

  // ETH specifically: also attempt Flashbots arb bundle
  if (chain==='ethereum'&&!isLive('ethereum')) {
    const opp=swapToArbParams(swapUSD,poolAddr,'ethereum')
    if (opp) deployETH(opp).catch(()=>{})
  }
}

// ── ARB_OPPORTUNITY HANDLER — SECONDARY TRIGGER ──────────────────────────────
function onArbOpportunity(opp) {
  if (isLive(opp.chain)) return
  if (opp.chain==='ethereum') {
    deployETH(opp).catch(()=>{})
  } else {
    // L2 with measured gap: directDeploy (pre-signed already submitted)
    directDeploy(opp.chain).catch(()=>{})
  }
}

// ── EXPORTS ──────────────────────────────────────────────────────────────────
export const getBootstrapStatus=getStatus
export const onMegaSwapDetected=async()=>{}

export async function initBootstrap() {
  const artifact=getArtifact()
  if (!artifact) { console.error('[BOOTSTRAP] No artifact — compile failed'); return }

  const computed=computeAddr(artifact.bytecode)
  if (computed) {
    console.log('[BOOTSTRAP] CREATE2 address (all chains):',computed.addr)
    setConfig('create2_address',computed.addr)
  }

  // Recover any chains already live from prior deploys
  const recovered=await recoverDeployedChains(computed?.addr)
  console.log(`[BOOTSTRAP] ${recovered}/${getActiveChains().length} chains recovered`)

  if (recovered>0) {
    const anchor=getStatus().liveChains[0]
    if (anchor) await onFirstDeploy(anchor).catch(()=>{})
  }

  // PRE-SIGN ALL CHAINS NOW — so first swap submits all simultaneously
  await presignAllChains()

  // Register triggers
  on('mega_swap',     evt=>onMegaSwap(evt).catch(()=>{}))
  on('arb_opportunity',opp=>onArbOpportunity(opp))

  // Self-heal every 60s
  setInterval(()=>{
    getStatus().allChains
      .filter(c=>!isLive(c.name)&&getConfig('deploy_status_'+c.name)==='failed')
      .forEach(c=>directDeploy(c.name).catch(()=>{}))
  },60000)

  console.log('[BOOTSTRAP] PRE-SIGNED: all chains ready')
  console.log('[BOOTSTRAP] TRIGGER: first mega_swap → all 17 txs submitted simultaneously')
  console.log('[BOOTSTRAP] ETH: Flashbots bundle (arb covers gas)')
  console.log('[BOOTSTRAP] L2s: pre-signed direct deploy (hardcoded gas=800000)')
}
