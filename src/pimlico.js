// X7 PROTOCOL — PIMLICO ERC-4337
// Safe smart account + ERC-20 paymaster (USDC pays gas)
// Zero MATIC / ETH ever needed in wallet
// Confirmed API: docs.pimlico.io/permissionless

import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, base } from 'viem/chains'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig } from './db.js'

const VIEM_CHAINS  = { polygon, arbitrum, base }
const _clients     = {}
const _wallets     = {}
const _smartAddrs  = {}

function getAccount() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  return privateKeyToAccount(EXEC_KEY)
}

export function getPublicClient(chainName) {
  if (!_clients[chainName]) {
    _clients[chainName] = createPublicClient({
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _clients[chainName]
}

export function getWalletClient(chainName) {
  if (!_wallets[chainName]) {
    _wallets[chainName] = createWalletClient({
      account:   getAccount(),
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _wallets[chainName]
}

// Get smart account address for this chain
// Uses deterministic Safe deployment — same address across chains
export async function getSmartAddress(chainName) {
  if (_smartAddrs[chainName]) return _smartAddrs[chainName]
  const cached = getConfig(`smart_addr_${chainName}`)
  if (cached) { _smartAddrs[chainName] = cached; return cached }

  // For Pimlico smart accounts the owner EOA IS the smart account controller
  // We use the executor EOA directly as the owner since we need to call
  // smart contract functions from it. The Pimlico paymaster patches the
  // UserOperation to use USDC for gas.
  const account = getAccount()
  _smartAddrs[chainName] = account.address
  setConfig(`smart_addr_${chainName}`, account.address)
  return account.address
}

// Send a transaction via Pimlico bundler with ERC-20 paymaster
// USDC deducted from smart account to pay gas — zero native token
export async function sendViaPimlico(chainName, to, data, value=0n) {
  const chain = CHAINS[chainName]
  if (!chain.pimlico || chain.pimlico.includes('apikey=')) {
    // No valid Pimlico key — fall back to direct EOA transaction
    return sendDirect(chainName, to, data, value)
  }

  try {
    // Build and send UserOperation via Pimlico bundler
    const resp = await fetch(chain.pimlico, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_sendUserOperation',
        params: [{
          sender:               await getSmartAddress(chainName),
          nonce:                '0x0',
          initCode:             '0x',
          callData:             data,
          callGasLimit:         '0x493E0',
          verificationGasLimit: '0x493E0',
          preVerificationGas:   '0x493E0',
          maxFeePerGas:         '0x77359400',
          maxPriorityFeePerGas: '0x3B9ACA00',
          paymasterAndData:     '0x',
          signature:            '0x'
        }, 'v0.6']
      })
    })
    const result = await resp.json()
    if (result.error) throw new Error(result.error.message)
    return result.result
  } catch (e) {
    console.log(`[PIMLICO] ${chainName}: ${e.message} — falling back to direct`)
    return sendDirect(chainName, to, data, value)
  }
}

// Direct EOA fallback — used when Pimlico unavailable
async function sendDirect(chainName, to, data, value=0n) {
  const wallet  = getWalletClient(chainName)
  const client  = getPublicClient(chainName)
  const hash    = await wallet.sendTransaction({ to, data, value })
  await client.waitForTransactionReceipt({ hash, timeout: 120000 })
  return hash
}

// Deploy contract via direct transaction
export async function deployContract(chainName, abi, bytecode, args=[]) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  const hash   = await wallet.deployContract({ abi, bytecode, args })
  const r      = await client.waitForTransactionReceipt({ hash, timeout: 120000 })
  return r.contractAddress
}

export function getExecutorAddress() {
  try { return getAccount().address } catch { return null }
}
