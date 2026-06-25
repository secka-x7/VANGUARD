// X7-SV · rpc.js — 6-tier RPC router · tiered WebSocket · multi-handler

import WebSocket from 'ws'

const FREE_HTTP = {
  ethereum:  ['https://eth.llamarpc.com','https://rpc.ankr.com/eth','https://ethereum.publicnode.com','https://cloudflare-eth.com'],
  arbitrum:  ['https://arb1.arbitrum.io/rpc','https://rpc.ankr.com/arbitrum','https://arbitrum.publicnode.com','https://arbitrum.llamarpc.com'],
  polygon:   ['https://polygon.llamarpc.com','https://rpc.ankr.com/polygon','https://polygon.publicnode.com','https://polygon-rpc.com'],
  base:      ['https://mainnet.base.org','https://rpc.ankr.com/base','https://base.publicnode.com','https://base.llamarpc.com'],
  optimism:  ['https://mainnet.optimism.io','https://rpc.ankr.com/optimism','https://optimism.publicnode.com'],
  avalanche: ['https://api.avax.network/ext/bc/C/rpc','https://rpc.ankr.com/avalanche'],
  bnb:       ['https://bsc-dataseed.bnbchain.org','https://rpc.ankr.com/bsc','https://bsc.publicnode.com'],
  scroll:    ['https://rpc.scroll.io','https://rpc.ankr.com/scroll'],
}

const FREE_WSS = {
  ethereum:  ['wss://eth.llamarpc.com','wss://ethereum.publicnode.com'],
  arbitrum:  ['wss://arbitrum.publicnode.com','wss://arbitrum.llamarpc.com'],
  polygon:   ['wss://polygon.llamarpc.com','wss://polygon.publicnode.com'],
  base:      ['wss://base.publicnode.com','wss://base.llamarpc.com'],
  optimism:  ['wss://optimism.publicnode.com'],
  avalanche: ['wss://api.avax.network/ext/bc/C/ws'],
  bnb:       ['wss://bsc.publicnode.com'],
  scroll:    ['wss://wss-rpc.scroll.io/ws'],
}

const TIER_WS = { 1: 3, 2: 2, 3: 1 }

class RPCRouter {
  constructor(name, primary) {
    this.chain     = name
    this.providers = [primary, ...(FREE_HTTP[name]||[])].filter(Boolean)
    this.idx       = 0
    this.cooldown  = {}
  }

  avail(i) { return Date.now() > (this.cooldown[i]||0) }

  async call(method, params = []) {
    for (let i = 0; i < this.providers.length; i++) {
      const n = (this.idx + i) % this.providers.length
      if (!this.avail(n)) continue
      try {
        const r = await fetch(this.providers[n], {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
          signal:  AbortSignal.timeout(5000)
        })
        if (r.status === 429) { this.cooldown[n] = Date.now()+60000; continue }
        if (!r.ok)             { this.cooldown[n] = Date.now()+10000; continue }
        const d = await r.json()
        if (d.error?.code === -32005) { this.cooldown[n] = Date.now()+60000; continue }
        if (d.error) throw new Error(d.error.message)
        this.idx = n
        return d.result
      } catch (e) {
        if (e.name === 'AbortError' || e.message?.includes('429'))
          this.cooldown[n] = Date.now()+30000
        else
          this.cooldown[n] = Date.now()+10000
      }
    }
    throw new Error(`[RPC:${this.chain}] All providers exhausted`)
  }
}

class ChainWS {
  constructor(name, tier) {
    this.chain    = name
    this.maxConn  = TIER_WS[tier] || 1
    this.sockets  = []
    // ── FIXED: handlers is now an array per event, not a single function ──
    this.handlers = {}  // evt → [fn, fn, ...]
    this.seen     = new Set()
    this.subs     = []
  }

  dedup(key) {
    if (this.seen.has(key)) return true
    this.seen.add(key)
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value)
    return false
  }

  // ── FIXED: on() pushes to array instead of overwriting ──────────────────
  on(evt, fn) {
    if (!this.handlers[evt]) this.handlers[evt] = []
    this.handlers[evt].push(fn)
    return this
  }

  // ── FIXED: emit() calls ALL registered handlers ──────────────────────────
  _emit(evt, ...args) {
    const fns = this.handlers[evt]
    if (!fns?.length) return
    for (const fn of fns) {
      try { fn(...args) } catch {}
    }
  }

  connect(url, idx) {
    if (!url) return
    try {
      const ws = new WebSocket(url)
      this.sockets[idx] = ws
      ws.on('open', () => {
        this.subs.forEach(s => ws.send(JSON.stringify(s)))
        this._emit('connected', idx)
      })
      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString())
          const log = msg.params?.result
          if (!log) return
          const key = (log.transactionHash||'') + (log.logIndex||'') + (log.blockNumber||'')
          if (key && this.dedup(key)) return
          this._emit('log', log, idx)
        } catch {}
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(() => this.connect(url, idx), 2000 + idx*500))
    } catch { setTimeout(() => this.connect(url, idx), 5000) }
  }

  subscribe(sub) {
    this.subs.push(sub)
    this.sockets.filter(ws => ws?.readyState === 1).forEach(ws => ws.send(JSON.stringify(sub)))
  }

  start(primaryWss) {
    const endpoints = [primaryWss, ...(FREE_WSS[this.chain]||[])].filter(Boolean)
    for (let i = 0; i < Math.min(this.maxConn, endpoints.length); i++)
      setTimeout(() => this.connect(endpoints[i], i), i * 300)
    return this
  }
}

const _routers = {}, _ws = {}

export function initRPC(chains) {
  Object.values(chains).forEach(c => {
    _routers[c.name] = new RPCRouter(c.name, c.rpcHttp)
    _ws[c.name]      = new ChainWS(c.name, c.tier||3).start(c.rpcWss)
  })
  console.log(`[RPC] ${Object.keys(chains).length} chains · 6-tier router · tiered WebSocket · multi-handler`)
}

export const rpcCall = (chain, method, params) => {
  const r = _routers[chain]
  return r ? r.call(method, params) : Promise.reject(new Error('No router: ' + chain))
}

export const getWS = chain => _ws[chain]
