// CEX WebSocket feeds: Binance, OKX, Bybit
// Emits cex_price events → scanner uses as synthetic pool price
import WebSocket from 'ws'
import { emit } from './events.js'
import { setConfig } from './db.js'

const _prices = {}

function connectBinance() {
  const pairs = ['ethusdt','btcusdt','bnbusdt']
  const ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${pairs.map(p=>p+'@bookTicker').join('/')}`)
  ws.on('open', () => console.log('[CEX] Binance connected'))
  ws.on('message', raw => {
    try {
      const { data } = JSON.parse(raw.toString())
      if (!data?.b) return
      const sym = data.s?.replace('USDT','').replace('BTC','BTC')
      const price = parseFloat(data.b)
      if (!sym||!price) return
      _prices[sym] = price
      updateStored()
      emit('cex_price', { symbol:sym, price, source:'binance' })
    } catch {}
  })
  ws.on('close', () => setTimeout(connectBinance, 3000))
  ws.on('error', () => {})
}

function connectOKX() {
  const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public')
  ws.on('open', () => {
    console.log('[CEX] OKX connected')
    ws.send(JSON.stringify({ op:'subscribe', args:[{channel:'tickers',instId:'ETH-USDT'}] }))
  })
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      const d = m.data?.[0]
      if (!d?.bidPx) return
      const price = parseFloat(d.bidPx)
      _prices.ETH = (_prices.ETH||price)*0.7 + price*0.3 // smooth
      updateStored()
      emit('cex_price', { symbol:'ETH', price, source:'okx' })
    } catch {}
  })
  ws.on('close', () => setTimeout(connectOKX, 3000))
  ws.on('error', () => {})
}

function connectBybit() {
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/spot')
  ws.on('open', () => {
    console.log('[CEX] Bybit connected')
    ws.send(JSON.stringify({ op:'subscribe', args:['tickers.ETHUSDT'] }))
  })
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw.toString())
      const price = parseFloat(m.data?.bid1Price||0)
      if (!price) return
      emit('cex_price', { symbol:'ETH', price, source:'bybit' })
    } catch {}
  })
  ws.on('close', () => setTimeout(connectBybit, 3000))
  ws.on('error', () => {})
}

function updateStored() {
  if (Object.keys(_prices).length) {
    setConfig('prices', JSON.stringify(_prices))
  }
}

export function startCEXFeed() {
  console.log('[CEX] Connecting to Binance · OKX · Bybit')
  connectBinance()
  setTimeout(connectOKX,  500)
  setTimeout(connectBybit, 1000)
}

export const getCEXPrices = () => _prices
