// X7 PROTOCOL — PIMLICO (Verifying Paymaster)
// Pimlico sponsors gas from free credits (10M ops free)
// Zero MATIC, zero ETH, zero USDC needed ever
// After credits used: switch paymasterContext to ERC-20

import { createPublicClient, createWalletClient, http, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, mainnet, avalanche } from 'viem/chains'
import { createSmartAccountClient } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig } from './db.js'

const VIEM_CHAINS = { polygon, arbitrum, ethereum: mainnet, avalanche }
const _pub = {}, _wal = {}, _smart = {}, _addrs = {}

function account() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  const k = EXEC_KEY.startsWith('0x') ? EXEC_KEY : '0x' + EXEC_KEY
  return privateKeyToAccount(k)
}

export function getPublicClient(chainName) {
  if (!_pub[chainName]) _pub[chainName] = createPublicClient({
    chain: VIEM_CHAINS[chainName], transport: http(CHAINS[chainName].rpcHttp)
  })
  return _pub[chainName]
}

export function getWalletClient(chainName) {
  if (!_wal[chainName]) _wal[chainName] = createWalletClient({
    account: account(), chain: VIEM_CHAINS[chainName],
    transport: http(CHAINS[chainName].rpcHttp)
  })
  return _wal[chainName]
}

async function getSmartClient(chainName) {
  if (_smart[chainName]) return _smart[chainName]
  const chain = CHAINS[chainName]
  if (!chain?.pimlico || chain.pimlico.endsWith('apikey=')) return null

  try {
    const pub = getPublicClient(chainName)

    // Smart account owned by executor key — deterministic address
    const smartAccount = await toSimpleSmartAccount({
      client:     pub,
      owner:      account(),
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    _addrs[chainName] = smartAccount.address
    setConfig('smart_addr_' + chainName, smartAccount.address)
    console.log('[PIMLICO] ' + chainName + ' smart account: ' + smartAccount.address)

    // Pimlico bundler + paymaster client
    const pimlico = createPimlicoClient({
      transport:  http(chain.pimlico),
      chain:      VIEM_CHAINS[chainName],
      entryPoint: { address: entryPoint07Address, version: '0.7' }
    })

    // VERIFYING PAYMASTER — Pimlico pays from your free credits
    // No USDC, no MATIC, no ETH needed in any wallet
    const smartClient = createSmartAccountClient({
      account:          smartAccount,
      chain:            VIEM_CHAINS[chainName],
      bundlerTransport: http(chain.pimlico),
      paymaster:        pimlico
      // No paymasterContext = verifying paymaster (free credits)
      // Add paymasterContext: { token: chain.usdc } after first profits arrive
    })

    _smart[chainName] = smartClient
    return smartClient
  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ' init failed: ' + e.message?.slice(0, 100))
    return null
  }
}

// Send via Pimlico verifying paymaster — Pimlico pays gas free
// Falls back to direct EOA only if Pimlico unavailable
export async function sendViaPimlico(chainName, to, data, value = 0n) {
  try {
    const client = await getSmartClient(chainName)
    if (client) {
      const hash = await client.sendTransaction({ to, data, value })
      console.log('[PIMLICO] ' + chainName + ': tx sent → ' + hash)
      return hash
    }
  } catch (e) {
    console.log('[PIMLICO] ' + chainName + ': ' + e.message?.slice(0, 120))
  }
  // Fallback — direct EOA (needs native gas)
  return sendDirect(chainName, to, data, value)
}

async function sendDirect(chainName, to, data, value = 0n) {
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const h = await w.sendTransaction({ to, data, value })
  await c.waitForTransactionReceipt({ hash: h, timeout: 120000 })
  return h
}

export function getExecutorAddress() {
  try { return account().address } catch { return null }
}

export async function getSmartAddress(chainName) {
  if (_addrs[chainName]) return _addrs[chainName]
  const cached = getConfig('smart_addr_' + chainName)
  if (cached) { _addrs[chainName] = cached; return cached }
  await getSmartClient(chainName).catch(() => {})
  return _addrs[chainName] || getExecutorAddress()
}
