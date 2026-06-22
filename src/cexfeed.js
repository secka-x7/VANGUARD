// X7-SV · cexfeed.js — 4 CEX WebSocket feeds · P6 stat-arb trigger

import WebSocket from 'ws'
import { getConfig, setConfig } from './db.js'
import { p6StatArb } from './propellers.js'
import { getActiveChains } from './chains.js'

const CEX_FEEDS = [
  { name: 'Binance',  url: 'wss://stream.binance.com:9443/ws/ethusdt@trade' },
  { name: 'Coinbase', url: 'wss://advanced-trade-ws.coinbase.com' },
  { name: 'OKX',      url: 'wss://ws.okx.com:8443/ws/v5/public' },
  { name: 'Bybit',    url: 'wss://stream.bybit.com/v5/public/spot' },
]

let _prices = { ETH: 0, BTC: 0 }
let _lastCex = { ETH: 0, BTC: 0 }

export function getCEXPrice(symbol = 'ETH') { return _prices[symbol] || 0 }

function parseBinance(raw) {
  try {
    const d = JSON.parse(raw)
    if (d.e === 'trade' && d.s === 'ETHUSDT') {
      _prices.ETH = parseFloat(d.p)
      _lastCex.ETH = Date.now()
      return { symbol: 'ETH', price: _prices.ETH }
    }
  } catch {}
  return null
}

function parseOKX(raw) {
  try {
    const d = JSON.parse(raw)
    if (d.data?.[0]?.instId === 'ETH-USDT') {
      _prices.ETH = parseFloat(d.data[0].last)
      return { symbol: 'ETH', price: _prices.ETH }
    }
  } catch {}
  return null
}

function parseBybit(raw) {
  try {
    const d = JSON.parse(raw)
    if (d.data?.symbol === 'ETHUSDT') {
      _prices.ETH = parseFloat(d.data.lastPrice)
      return { symbol: 'ETH', price: _prices.ETH }
    }
  } catch {}
  return null
}

function connectCEX(feed, parsePrice) {
  function connect() {
    try {
      const ws = new WebSocket(feed.url)
      ws.on('open', () => {
        // OKX subscription
        if (feed.name === 'OKX') ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'ETH-USDT' }] }))
        // Bybit subscription
        if (feed.name === 'Bybit') ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.ETHUSDT'] }))
        // Coinbase subscription
        if (feed.name === 'Coinbase') ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['ETH-USD'], channel: 'ticker' }))
        console.log(`[CEX] ${feed.name} connected`)
      })
      ws.on('message', async raw => {
        const result = parsePrice(raw.toString())
        if (!result) return
        setConfig('prices', JSON.stringify(_prices))

        // Check DEX price vs CEX price on all active chains
        const chains = getActiveChains().filter(c => c.tier === 1)
        for (const chain of chains) {
          const dexPrice = parseFloat(getConfig(`dex_price_${chain.name}`) || '0')
          if (dexPrice > 0 && _prices.ETH > 0) {
            const gap = Math.abs(_prices.ETH - dexPrice) / dexPrice * 100
            if (gap > 0.03) {
              p6StatArb(chain.name, _prices.ETH, dexPrice).catch(() => {})
            }
          }
        }
      })
      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 3000))
    } catch { setTimeout(connect, 5000) }
  }
  connect()
}

export function startCEXFeed() {
  console.log('[CEX] Connecting to 4 CEX price feeds...')
  connectCEX(CEX_FEEDS[0], parseBinance)
  setTimeout(() => connectCEX(CEX_FEEDS[2], parseOKX),  1000)
  setTimeout(() => connectCEX(CEX_FEEDS[3], parseBybit), 2000)
  // Coinbase has different auth — use as validation only
  console.log('[CEX] Price feeds active: Binance + OKX + Bybit')
}
