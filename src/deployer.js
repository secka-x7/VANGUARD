// Guaranteed deployment: directDeploy per chain, cascade after first success
// Self-heals: retries failed chains every 60s indefinitely
import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { getActive, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, contractExists, sendTx, waitTx } from './pimlico.js'
import { getArtifact } from './compiler.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const _live   = new Set()
const _dep    = new Set()

export function computeAddr(bytecode) {
  const exec = getExecutorAddress()
  if (!exec) return null
  const salt = keccak256(encodePacked(['address','string'],[exec,'vanguard_v1']))
  const hash = keccak256(encodePacked(['bytes1','address','bytes32','bytes32'],
    ['0xff', CREATE2, salt, keccak256(bytecode)]))
  return { addr: ('0x'+hash.slice(-40)).toLowerCase(), salt }
}

function buildCalldata(bytecode, salt, chain) {
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,address,address,address'),
    [chain.router  ||'0x0000000000000000000000000000000000000001',
     chain.usdc    ||'0x0000000000000000000000000000000000000001',
     chain.weth    ||'0x0000000000000000000000000000000000000001',
     chain.flash   ||'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
     chain.aave    ||'0x0000000000000000000000000000000000000001']
  )
  const init=bytecode+args.slice(2), len=Math.floor((init.length-2)/2)
  return '0x4af63f02'+salt.slice(2).padStart(64,'0')+'0'.repeat(63)+'40'+
    len.toString(16).padStart(64,'0')+init.slice(2).padEnd(Math.ceil(len/32)*64,'0')
}

export async function directDeploy(chainName) {
  if (_live.has(chainName)||_dep.has(chainName)) return getContractAddr(chainName)
  const artifact=getArtifact(), chain=getChain(chainName)
  if (!artifact||!chain) return null
  const c=computeAddr(artifact.bytecode)
  if (!c) return null
  if (await contractExists(chainName,c.addr).catch(()=>false)) {
    setContractAddr(chainName,c.addr); _live.add(chainName)
    emit('deploy_success',{chain:chainName,address:c.addr,method:'existing'})
    return c.addr
  }
  _dep.add(chainName); setConfig('deploy_status_'+chainName,'deploying')
  try {
    const data    = buildCalldata(artifact.bytecode,c.salt,chain)
    const hash    = await sendTx(chainName,CREATE2,data)
    const receipt = await waitTx(chainName,hash,120000)
    if (receipt?.status==='reverted') throw new Error('reverted')
    if (!await contractExists(chainName,c.addr).catch(()=>false)) throw new Error('not at CREATE2 addr')
    setContractAddr(chainName,c.addr); _live.add(chainName)
    setConfig('deploy_status_'+chainName,'live'); _dep.delete(chainName)
    console.log('[DEPLOY] ✓',chainName,'LIVE:',c.addr)
    emit('deploy_success',{chain:chainName,address:c.addr,method:'direct'})
    return c.addr
  } catch(e) {
    console.error('[DEPLOY]',chainName,'failed:',e.message?.slice(0,100))
    setConfig('deploy_status_'+chainName,'failed'); _dep.delete(chainName)
    return null
  }
}

export async function cascadeAll(fromChain) {
  console.log('[DEPLOY] Cascade from',fromChain,'→ all chains')
  const rest = getActive().filter(c=>!_live.has(c.name)&&c.name!==fromChain)
  // Stagger by 200ms to avoid nonce collision
  await Promise.allSettled(rest.map((c,i)=>
    new Promise(r=>setTimeout(r,i*200)).then(()=>directDeploy(c.name).catch(()=>{}))
  ))
}

export async function recoverAll(computedAddr) {
  let n=0
  await Promise.allSettled(getActive().map(async chain=>{
    const check=getContractAddr(chain.name)||computedAddr
    if (!check) return
    if (await contractExists(chain.name,check).catch(()=>false)) {
      setContractAddr(chain.name,check); _live.add(chain.name); n++
      emit('deploy_success',{chain:chain.name,address:check,method:'recovered'})
    }
  }))
  return n
}

export function startSelfHeal() {
  setInterval(async ()=>{
    for (const c of getActive()) {
      if (!_live.has(c.name)&&getConfig('deploy_status_'+c.name)==='failed') {
        await directDeploy(c.name).catch(()=>{})
      }
    }
  }, 60000)
}

export const isLive    = c => _live.has(c)
export const getLive   = () => [..._live]
export const getStatus = () => ({
  live:      [..._live],
  deploying: [..._dep],
  all: getActive().map(c=>({
    name:    c.name,
    tier:    c.tier,
    status:  _live.has(c.name)?'live':(_dep.has(c.name)?'deploying':getConfig('deploy_status_'+c.name)||'waiting'),
    address: getContractAddr(c.name)||null
  }))
})
