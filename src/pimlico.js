// Hardcoded gas — no estimation (fails at $0 balance)
// Self-heals: stale nonce → auto-increment, RPC fail → retry on next provider
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet,arbitrum,polygon,base,optimism,avalanche,bsc,scroll,blast,linea,zksync,mantle } from 'viem/chains'
import { getChain } from './chains.js'
import { getConfig, setConfig } from './db.js'

const OBJ = { ethereum:mainnet,arbitrum,polygon,base,optimism,avalanche,bnb:bsc,scroll,blast,linea,zksync,mantle }
let _acct, _w={}, _p={}

export function initPimlico() {
  const pk=process.env.EXECUTOR_PRIVATE_KEY
  if (!pk) { console.error('[PIMLICO] No EXECUTOR_PRIVATE_KEY'); return }
  try { _acct=privateKeyToAccount(pk.startsWith('0x')?pk:'0x'+pk); console.log('[PIMLICO] Executor:',_acct.address) }
  catch(e) { console.error('[PIMLICO] Invalid key:',e.message) }
}

export const getExecutorAddress = () => _acct?.address
export const getContractAddr    = c => { const v=getConfig('contract_'+c); return v?.startsWith('0x')&&v.length===42?v:null }
export const setContractAddr    = (c,a) => setConfig('contract_'+c,a)

export function getWalletClient(name) {
  if (_w[name]) return _w[name]
  const c=getChain(name), o=OBJ[name]
  if (!c||!o||!_acct) return null
  _w[name]=createWalletClient({account:_acct,chain:o,transport:http(c.rpcH)})
  return _w[name]
}

export function getPublicClient(name) {
  if (_p[name]) return _p[name]
  const c=getChain(name), o=OBJ[name]
  if (!c||!o) return null
  _p[name]=createPublicClient({chain:o,transport:http(c.rpcH)})
  return _p[name]
}

export async function sendTx(chainName, to, data, value=0n) {
  const w=getWalletClient(chainName), c=getPublicClient(chainName), chain=getChain(chainName)
  if (!w||!c||!chain) throw new Error(`[PIMLICO] No client: ${chainName}`)

  const gas = chain.gasLimit || 800000n
  let nonce, fee
  try {
    ;[nonce,fee]=await Promise.all([
      c.getTransactionCount({address:_acct.address}),
      c.estimateFeesPerGas().catch(()=>null)
    ])
  } catch(e) { throw new Error(`[PIMLICO:${chainName}] nonce fail: ${e.message}`) }

  // EIP-1559 invariant: maxFee >= tip, always
  const tip    = fee?.maxPriorityFeePerGas || 1500000000n
  const base   = fee?.maxFeePerGas || 0n
  // Guard: if base=0 (RPC bug) use 1gwei fallback, never trust 0x0
  const safeBase = base > 0n && base !== tip ? base : 1000000000n
  const maxFee   = safeBase > tip ? safeBase : tip * 2n

  console.log(`[PIMLICO] ${chainName} nonce=${nonce} gas=${gas} maxFee=${maxFee/1000000000n}gwei tip=${tip/1000000000n}gwei`)

  try {
    const hash=await w.sendTransaction({to,data,value,nonce,gas,maxFeePerGas:maxFee,maxPriorityFeePerGas:tip})
    console.log(`[PIMLICO] ${chainName} tx: ${hash}`)
    return hash
  } catch(e) {
    const bal=await c.getBalance({address:_acct.address}).catch(()=>0n)
    console.error(`[PIMLICO] ${chainName} FAILED: ${e.message?.slice(0,150)}`)
    console.error(`  balance: ${bal} wei (${Number(bal)/1e18} native) nonce=${nonce} gas=${gas} maxFee=${maxFee}`)
    throw e
  }
}

export async function waitTx(name, hash, ms=120000) {
  const c=getPublicClient(name)
  if (!c||!hash) return null
  try { return await c.waitForTransactionReceipt({hash,timeout:ms}) }
  catch { console.error(`[PIMLICO] ${name} waitTx timeout: ${hash?.slice(0,12)}`); return null }
}

export async function contractExists(name, addr) {
  try { const c=getPublicClient(name); if(!c)return false; const code=await c.getCode({address:addr}); return !!(code&&code!=='0x'&&code.length>2) }
  catch { return false }
}

export const pimlicoUrl = id => process.env.PIMLICO_API_KEY?`https://api.pimlico.io/v2/${id}/rpc?apikey=${process.env.PIMLICO_API_KEY}`:null
