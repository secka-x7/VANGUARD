// X7 PROTOCOL — FLASHBOTS BUNDLE BUILDER
// Used by all 4 strategies: cexdex, backrun, jit, liquidate
// Submits bundles to relay.flashbots.net
// Gas paid from profit via block.coinbase transfer
// Falls back to direct EOA on non-Ethereum chains

import { createWalletClient, http, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { CHAINS, EXEC_KEY } from './config.js'
import { getWalletClient, getPublicClient } from './pimlico.js'

const RELAY = 'https://relay.flashbots.net'

function getAuthKey() {
  const key = process.env.FLASHBOTS_AUTH_KEY || EXEC_KEY
  if (!key) return null
  return privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key)
}

async function sign(payload) {
  const auth = getAuthKey()
  if (!auth) return ''
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const hash = keccak256(toBytes('\x19Ethereum Signed Message:\n' + body.length + body))
  const sig  = await auth.signMessage({ message: { raw: toBytes(hash) } })
  return auth.address + ':' + sig
}

async function flashbotsSubmit(signedTxs, targetBlock) {
  for (let i = 0; i < 3; i++) {
    const blockHex = '0x' + (targetBlock + i).toString(16)
    const body     = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method:  'eth_sendBundle',
      params:  [{ txs: signedTxs, blockNumber: blockHex }]
    })
    try {
      const sig  = await sign(body)
      const resp = await fetch(RELAY, {
        method: 'POST',
        headers: { 'Content-Type':'application/json',
                   'X-Flashbots-Signature': sig },
        body
      })
      const data = await resp.json()
      if (data.result?.bundleHash) {
        console.log('[FLASHBOTS] Bundle: ' + data.result.bundleHash)
        return data.result.bundleHash
      }
    } catch {}
    await new Promise(r => setTimeout(r, 12000))
  }
  return null
}

// Main function used by all 4 strategies
export async function buildAndSubmitBundle(chainName, contractAddr, data, includeTxHash) {
  const chain = CHAINS[chainName]
  if (!chain) return null

  try {
    const wallet = getWalletClient(chainName)
    const client = getPublicClient(chainName)

    if (chainName === 'ethereum') {
      // Ethereum: use Flashbots private relay
      const block  = await client.getBlockNumber()
      const fees   = await client.estimateFeesPerGas()
      const nonce  = await client.getTransactionCount({
        address: wallet.account.address })

      const signed = await wallet.signTransaction({
        to: contractAddr, data, nonce,
        maxFeePerGas:         fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gas: 500000n, chainId: 1
      })

      const txs = includeTxHash
        ? [includeTxHash, signed]
        : [signed]

      return flashbotsSubmit(txs, Number(block) + 1)
    } else {
      // Other chains: direct EOA transaction
      const hash    = await wallet.sendTransaction({ to: contractAddr, data })
      const receipt = await client.waitForTransactionReceipt({
        hash, timeout: 60000 })
      return receipt.status === 'success' ? hash : null
    }
  } catch (e) {
    console.log('[FLASHBOTS] ' + chainName + ': ' + e.message?.slice(0, 100))
    return null
  }
    }
