// Vanguard bootstrap — RS1 coordinator
// Triggered by: chain_funded (primary) + arb_opportunity (secondary)
// ETH-specific: Flashbots bundle path
import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getActive, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, contractExists } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit, on } from './events.js'
import { computeAddr, directDeploy, cascadeAll, recoverAll, startSelfHeal, isLive, getLive, getStatus } from './deployer.js'
import { depositLP } from './revenue.js'
import { executeArb } from './vaults.js'

// ETH RPC pool
const ETH_RPCS=[
  process.env.ALCHEMY_ETH_KEY&&process.env.ALCHEMY_ETH_KEY!=='demo'?`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}`:null,
  'https://eth.drpc.org','https://eth.llamarpc.com','https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com','https://cloudflare-eth.com',
].filter(Boolean)

async function ethRPC(m,p=[],ms=4000){
  try{ return await Promise.any(ETH_RPCS.map(url=>
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p}),signal:AbortSignal.timeout(ms)})
    .then(r=>r.json()).then(d=>{ if(d.error)throw new Error(d.error.message); return d.result })
  ))}catch(e){ throw new Error(`ETH-RPC all failed: ${e.message}`) }
}

const TIPS=[1500000000n,2000000000n,3000000000n,5000000000n]
async function getGas(attempt=0){
  const tip=TIPS[Math.min(attempt,3)]
  try{
    const b=await ethRPC('eth_getBlockByNumber',['latest',false])
    const raw=b?.baseFeePerGas
    const base=(!raw||raw==='0x0'||raw==='0x')?1000000000n:BigInt(raw)
    return{maxFeePerGas:base*2n+tip,maxPriorityFeePerGas:tip}
  }catch{ return{maxFeePerGas:tip*3n,maxPriorityFeePerGas:tip} }
}

const BUILDERS=['https://rpc.titanbuilder.xyz','https://rpc.buildernet.org',
  'https://rpc.beaverbuild.org','https://rsync-builder.xyz']

async function submitBundle(txs,block){
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendBundle',
    params:[{txs,blockNumber:'0x'+block.toString(16),minTimestamp:0,maxTimestamp:Math.floor(Date.now()/1000)+60}]})
  const res=await Promise.allSettled(BUILDERS.map(url=>
    fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(3000)})
    .then(r=>r.json()).then(d=>({url,ok:!!d.result})).catch(()=>({url,ok:false}))
  ))
  return res.filter(r=>r.status==='fulfilled'&&r.value.ok).map(r=>r.value.url.split('/')[2])
}

function buildDeploy(bytecode,salt,chain){
  const CREATE2='0x4e59b44847b379578588920cA78FbF26c0B4956C'
  const args=encodeAbiParameters(parseAbiParameters('address,address,address,address,address'),
    [chain.router||'0x0000000000000000000000000000000000000001',
     chain.usdc  ||'0x0000000000000000000000000000000000000001',
     chain.weth  ||'0x0000000000000000000000000000000000000001',
     chain.flash ||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aave  ||'0x0000000000000000000000000000000000000001'])
  const init=bytecode+args.slice(2),len=Math.floor((init.length-2)/2)
  return {CREATE2,data:'0x4af63f02'+salt.slice(2).padStart(64,'0')+'0'.repeat(63)+'40'+len.toString(16).padStart(64,'0')+init.slice(2).padEnd(Math.ceil(len/32)*64,'0')}
}

function buildArbCalldata(opp,contractAddr){
  const sel='0x'+keccak256(new TextEncoder().encode(
    'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
  )).slice(2,10)
  return sel+encodeAbiParameters(
    parseAbiParameters('address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'),
    [opp.flashToken,opp.flashAmountWei,opp.poolBuy,opp.poolSell,
     opp.assetToken,opp.buyFee,opp.sellFee,opp.minBuyAmount,opp.minSellUsdc,contractAddr]
  ).slice(2)
}

// Pool pairs for arb params from mega-swap event
const PAIRS={
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640':{chain:'ethereum',partner:'0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',buyFee:500,sellFee:3000,tvl:80e6},
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8':{chain:'ethereum',partner:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',buyFee:3000,sellFee:500,tvl:150e6},
  '0xc6962004f452be9203591991d15f6b388e09e8d0':{chain:'arbitrum',partner:'0x2f5e87C9312fa29aed5c179E456625D79015299c',buyFee:500,sellFee:3000,tvl:30e6},
  '0x2f5e87c9312fa29aed5c179e456625d79015299c':{chain:'arbitrum',partner:'0xC6962004f452bE9203591991D15f6b388e09E8D0',buyFee:3000,sellFee:500,tvl:80e6},
  '0x45dda9cb7c25131df268515131f647d726f50608':{chain:'polygon',partner:'0x50eaEDB835021E4A108B7290636d62E9765cc6d7',buyFee:500,sellFee:3000,tvl:15e6},
  '0x50eaedb835021e4a108b7290636d62e9765cc6d7':{chain:'polygon',partner:'0x45dDa9cb7c25131DF268515131f647d726f50608',buyFee:3000,sellFee:500,tvl:30e6},
  '0x4c36388be6f416a29c8d8eee81c771ce6be14b5':{chain:'base',partner:'0xd0b53D9277642d899DF5C87A3966A349A798F224',buyFee:500,sellFee:3000,tvl:20e6},
  '0xd0b53d9277642d899df5c87a3966a349a798f224':{chain:'base',partner:'0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B5',buyFee:3000,sellFee:500,tvl:50e6},
}

function buildArbParams(swapUSD,poolAddr,chain){
  const pair=PAIRS[poolAddr?.toLowerCase()]
  if(!pair||pair.chain!==chain.name)return null
  const cexP=parseFloat(JSON.parse(getConfig('prices')||'{}').ETH||0)||0
  if(!cexP)return null
  const flash=Math.min(pair.tvl*0.08,20e6)
  if(flash<50000)return null
  return{
    flashToken:chain.usdc, assetToken:chain.weth,
    flashAmountWei:BigInt(Math.floor(flash*1e6)),
    poolBuy:poolAddr, poolSell:pair.partner,
    buyFee:pair.buyFee, sellFee:pair.sellFee,
    minBuyAmount:BigInt(Math.floor((flash/cexP)*0.97*1e18)),
    minSellUsdc:BigInt(Math.floor(flash*1.001*1e6)),
    estimatedProfit:Math.floor(flash*0.005)
  }
}

// ETH Flashbots
const _ethTs={ts:0}
async function deployETH(opp){
  if(isLive('ethereum')||Date.now()-_ethTs.ts<13000)return null
  _ethTs.ts=Date.now()
  const artifact=getArtifact(),chain=getChain('ethereum'),exec=getExecutorAddress(),wallet=getWalletClient('ethereum')
  if(!artifact||!chain||!exec||!wallet){_ethTs.ts=0;return null}
  const c=computeAddr(artifact.bytecode)
  if(!c){_ethTs.ts=0;return null}
  if(await contractExists('ethereum',c.addr).catch(()=>false)){
    setContractAddr('ethereum',c.addr);await cascadeAll('ethereum');_ethTs.ts=0;return c.addr
  }
  try{
    const[nonceHex,blockHex,g]=await Promise.all([
      ethRPC('eth_getTransactionCount',[exec,'pending']),
      ethRPC('eth_blockNumber',[]),
      getGas(0)
    ])
    const nonce=parseInt(nonceHex,16),blockNum=parseInt(blockHex,16)
    console.log(`[BOOTSTRAP] ETH nonce=${nonce} block=${blockNum} maxFee=${g.maxFeePerGas/1000000000n}gwei`)
    const{CREATE2,data:dd}=buildDeploy(artifact.bytecode,c.salt,chain)
    const ad=opp?buildArbCalldata(opp,c.addr):null
    let sd=await wallet.signTransaction({to:CREATE2,data:dd,nonce,gas:700000n,chainId:1,...g}).catch(()=>null)
    let sa=ad?await wallet.signTransaction({to:c.addr,data:ad,nonce:nonce+1,gas:900000n,chainId:1,...g}).catch(()=>null):null
    if(!sd){_ethTs.ts=0;return null}
    const bundle=sa?[sd,sa]:[sd]
    for(let i=0;i<4;i++){
      const target=blockNum+i+1
      const wins=await submitBundle(bundle,target)
      if(wins.length)console.log(`[BOOTSTRAP] ETH attempt ${i+1}/4 block=${target} → ${wins.join(',')}`)
      await new Promise(r=>setTimeout(r,12500))
      if(await contractExists('ethereum',c.addr).catch(()=>false)){
        setContractAddr('ethereum',c.addr)
        console.log('[BOOTSTRAP] ✓ ETH LIVE:',c.addr)
        emit('deploy_success',{chain:'ethereum',address:c.addr,method:'flashbots'})
        await cascadeAll('ethereum')
        _ethTs.ts=0; return c.addr
      }
      if(i<3){const ng=await getGas(i+1);const[nd,na]=await Promise.all([wallet.signTransaction({to:CREATE2,data:dd,nonce,gas:700000n,chainId:1,...ng}).catch(()=>null),sa?wallet.signTransaction({to:c.addr,data:ad,nonce:nonce+1,gas:900000n,chainId:1,...ng}).catch(()=>null):null]);if(nd)sd=nd;if(na)sa=na;Object.assign(g,ng)}
    }
  }catch(e){console.error('[BOOTSTRAP] ETH error:',e.message?.slice(0,80))}
  _ethTs.ts=0; return null
}

export const getBootstrapStatus = getStatus

export async function initBootstrap(){
  const artifact=getArtifact()
  if(!artifact){console.error('[BOOTSTRAP] No artifact');return}
  const c=computeAddr(artifact.bytecode)
  if(c){console.log('[BOOTSTRAP] CREATE2 (all chains):',c.addr);setConfig('create2_address',c.addr)}
  const recovered=await recoverAll(c?.addr)
  console.log(`[BOOTSTRAP] ${recovered}/${getActive().length} chains recovered`)
  if(recovered>0){const live=getLive();if(live[0])await cascadeAll(live[0]).catch(()=>{})}

  // PRIMARY: balance detected → deploy → cascade all
  on('chain_funded',async({chain:chainName})=>{
    if(isLive(chainName))return
    console.log(`[BOOTSTRAP] Funding on ${chainName} → deploying`)
    const result=await directDeploy(chainName)
    if(result){
      emit('first_deploy',{chain:chainName,address:result})
      depositLP(0)  // initialize LP vault
      await cascadeAll(chainName)
    }
  })

  // SECONDARY: measured gap → execute arb immediately if deployed
  on('arb_opportunity',async opp=>{
    if(isLive(opp.chain)){
      await executeArb(opp.chain,'sv4',opp).catch(()=>{})
      return
    }
    if(opp.chain==='ethereum'){
      deployETH(opp).catch(()=>{})
    }
  })

  // ETH: also try Flashbots on mega-swap
  on('mega_swap',({chain,swapUSD,log,poolAddr})=>{
    if(chain==='ethereum'&&!isLive('ethereum')&&swapUSD>1e8){
      const ch=getChain('ethereum')
      const opp=buildArbParams(swapUSD,poolAddr,ch||{name:'ethereum'})
      if(opp)deployETH(opp).catch(()=>{})
    }
  })

  startSelfHeal()
  console.log('[BOOTSTRAP] PRIMARY: fund executor on any chain')
  console.log('[BOOTSTRAP] SECONDARY: gap detected → crossPoolArb via Balancer')
  console.log('[BOOTSTRAP] Self-heals every 60s indefinitely')
}
