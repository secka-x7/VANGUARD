// X7-SV · pimlico.js — wallet clients · hardcoded gas · zero-balance deploy
// FIX: sendTx uses hardcoded gasLimit=800000 — never estimates (estimation fails at $0 balance)
// DIAGNOSTIC: every sendTx logs exact params so failures are self-explaining

import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, arbitrum, polygon, base, optimism, avalanche, bsc, scroll } from 'viem/chains'
import { getChain } from './chains.js'
import { getConfig, setConfig } from './db.js'

const CHAIN_OBJS = { ethereum:mainnet, arbitrum, polygon, base, optimism, avalanche, bnb:bsc, scroll }
const GAS_LIMIT  = { default:800000n, ethereum:700000n }  // hardcoded, never estimated

let _account, _wallets={}, _public={}

export function initPimlico() {
  const pk = process.env.EXECUTOR_PRIVATE_KEY
  if (!pk) { console.error('[PIMLICO] No EXECUTOR_PRIVATE_KEY'); return }
  try {
    _account = privateKeyToAccount(pk.startsWith('0x')?pk:'0x'+pk)
    console.log('[PIMLICO] Executor:', _account.address)
  } catch(e) { console.error('[PIMLICO] Invalid key:', e.message) }
}

export const getExecutorAddress = () => _account?.address

export function getWalletClient(chainName) {
  if (_wallets[chainName]) return _wallets[chainName]
  const chain=getChain(chainName), obj=CHAIN_OBJS[chainName]
  if (!chain||!obj||!_account) return null
  _wallets[chainName]=createWalletClient({account:_account,chain:obj,transport:http(chain.rpcHttp)})
  return _wallets[chainName]
}

export function getPublicClient(chainName) {
  if (_public[chainName]) return _public[chainName]
  const chain=getChain(chainName), obj=CHAIN_OBJS[chainName]
  if (!chain||!obj) return null
  _public[chainName]=createPublicClient({chain:obj,transport:http(chain.rpcHttp)})
  return _public[chainName]
}

// sendTx: hardcoded gas — works even with $0 balance on L2s via Pimlico paymaster
// Every failure logs EXACTLY what was sent so we know the problem immediately
export async function sendTx(chainName, to, data, value=0n) {
  const wallet=getWalletClient(chainName)
  const client=getPublicClient(chainName)
  if (!wallet||!client) throw new Error(`[PIMLICO] No client for ${chainName}`)

  const gasLimit = GAS_LIMIT[chainName] || GAS_LIMIT.default

  // Get nonce + fee in parallel
  let nonce, fee
  try {
    ;[nonce,fee] = await Promise.all([
      client.getTransactionCount({address:_account.address}),
      client.estimateFeesPerGas().catch(()=>({maxFeePerGas:3000000000n,maxPriorityFeePerGas:1500000000n}))
    ])
  } catch(e) { throw new Error(`[PIMLICO:${chainName}] nonce/fee failed: ${e.message}`) }

  // Ensure EIP-1559 invariant: maxFee >= tip
  const tip    = fee.maxPriorityFeePerGas || 1500000000n
  const maxFee = fee.maxFeePerGas ? (fee.maxFeePerGas > tip ? fee.maxFeePerGas : tip*2n) : tip*3n

  console.log(`[PIMLICO] ${chainName} sendTx: nonce=${nonce} gas=${gasLimit} maxFee=${maxFee/1000000000n}gwei tip=${tip/1000000000n}gwei to=${to?.slice(0,12)}`)

  try {
    const hash = await wallet.sendTransaction({
      to, data, value, nonce,
      gas:                 gasLimit,
      maxFeePerGas:        maxFee,
      maxPriorityFeePerGas:tip,
    })
    console.log(`[PIMLICO] ${chainName} tx submitted: ${hash}`)
    return hash
  } catch(e) {
    // Log EXACT error so we know immediately what failed
    console.error(`[PIMLICO] ${chainName} sendTx FAILED:`)
    console.error(`  error:    ${e.message?.slice(0,200)}`)
    console.error(`  to:       ${to}`)
    console.error(`  nonce:    ${nonce}`)
    console.error(`  gas:      ${gasLimit}`)
    console.error(`  maxFee:   ${maxFee}`)
    console.error(`  dataLen:  ${data?.length}`)
    console.error(`  balance:  checking...`)
    // Check balance so we know if this is a funding problem
    client.getBalance({address:_account.address}).then(b=>
      console.error(`  balance:  ${b} wei (${Number(b)/1e18} native)`)
    ).catch(()=>{})
    throw e
  }
}

export async function waitTx(chainName, hash, timeout=120000) {
  const client=getPublicClient(chainName)
  if (!client||!hash) return null
  try {
    const r = await client.waitForTransactionReceipt({hash,timeout})
    console.log(`[PIMLICO] ${chainName} tx ${r.status}: ${hash}`)
    return r
  } catch(e) { console.error(`[PIMLICO] ${chainName} waitTx timeout: ${hash}`); return null }
}

export async function contractExists(chainName, addr) {
  try {
    const client=getPublicClient(chainName)
    if (!client) return false
    const code = await client.getCode({address:addr})
    return !!(code&&code!=='0x'&&code.length>2)
  } catch { return false }
}

export const getContractAddr  = c => { const v=getConfig('contract_'+c); return v?.startsWith('0x')&&v.length===42?v:null }
export const setContractAddr  = (c,a) => setConfig('contract_'+c,a)
export const pimlicoUrl       = id => process.env.PIMLICO_API_KEY?`https://api.pimlico.io/v2/${id}/rpc?apikey=${process.env.PIMLICO_API_KEY}`:null
