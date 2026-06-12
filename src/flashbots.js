// X7 PROTOCOL — FLASHBOTS EXECUTOR
// Ethereum mainnet zero-gas execution
// eth_sendBundle: gas paid from liquidation profit via block.coinbase
// Confirmed: docs.flashbots.net/flashbots-auction/searchers/advanced/rpc-endpoint

import { createWalletClient, http, keccak256, toBytes, encodePacked } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { CHAINS, EXEC_KEY } from './config.js'

const RELAY  = 'https://relay.flashbots.net'
// Throw-away key for signing Flashbots requests (not used for funds)
const FB_KEY = process.env.FLASHBOTS_AUTH_KEY || EXEC_KEY

async function fbSign(payload) {
  if (!FB_KEY) return ''
  const account = privateKeyToAccount(FB_KEY)
  const body    = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const hash    = keccak256(toBytes('\x19Ethereum Signed Message:\n' + body.length + body))
  const sig     = await account.signMessage({ message: { raw: toBytes(hash) } })
  return `${account.address}:${sig}`
}

// Simulate bundle — returns profitability before submitting
export async function simulate(signedTxs, blockNumber) {
  const sig  = await fbSign({ signedTransactions: signedTxs })
  const resp = await fetch(RELAY, {
    method: 'POST',
    headers: {
      'Content-Type':        'application/json',
      'X-Flashbots-Signature': sig
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'eth_callBundle',
      params: [{ txs: signedTxs, blockNumber: `0x${blockNumber.toString(16)}` }]
    })
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message)
  return data.result
}

// Submit bundle — retries for 5 blocks
export async function submit(signedTxs, targetBlock) {
  for (let i = 0; i < 5; i++) {
    const blockHex = `0x${(targetBlock + i).toString(16)}`
    const body     = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'eth_sendBundle',
      params:  [{ txs: signedTxs, blockNumber: blockHex }]
    })
    const sig  = await fbSign(body)
    const resp = await fetch(RELAY, {
      method: 'POST',
      headers: {
        'Content-Type':          'application/json',
        'X-Flashbots-Signature': sig
      },
      body
    })
    const data = await resp.json()
    if (data.result?.bundleHash) {
      console.log(`[FLASHBOTS] Bundle submitted: ${data.result.bundleHash} block ${targetBlock+i}`)
      return data.result.bundleHash
    }
    await new Promise(r => setTimeout(r, 12000)) // wait one block
  }
  return null
}

// Build a signed transaction for the bundle
export async function buildSignedTx(chainName, to, data, nonce, maxFee, maxPrio) {
  if (!EXEC_KEY) return null
  const account = privateKeyToAccount(EXEC_KEY)
  const wallet  = createWalletClient({
    account, chain: mainnet,
    transport: http(CHAINS[chainName].rpcHttp)
  })
  const signed = await wallet.signTransaction({
    to, data, nonce,
    maxFeePerGas:         maxFee,
    maxPriorityFeePerGas: maxPrio,
    gas:                  500000n,
    chainId:              1
  })
  return signed
}
