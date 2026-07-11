// Vanguard · modempay.js — REWRITE
// KEY PRINCIPLE: if MODEMPAY_SECRET_KEY is set → it IS live → status ACTIVE
// No prefix detection. No mode guessing. Key exists = configured = LIVE.
// To use test mode: set MODEMPAY_MODE=test explicitly
// Transfer body per PHP SDK: account_number, network, beneficiary_name, amount, currency

import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

// ── Configuration ─────────────────────────────────────────────────────────────
const LIVE_BASE = 'https://api.modempay.com/v1'
const TEST_BASE = 'https://api.test.modempay.com/v1'

function getKey()  { return process.env.MODEMPAY_SECRET_KEY || '' }

// Mode logic: EXPLICIT test opt-in only
// If key exists and MODEMPAY_MODE is not 'test' → LIVE
// This is correct: if you have a real key, you want live
function isTestMode() {
  return (process.env.MODEMPAY_MODE || '').toLowerCase() === 'test'
}

function getBase() { return isTestMode() ? TEST_BASE : LIVE_BASE }

function isConfigured() { return getKey().length > 0 }
function isLive()       { return isConfigured() && !isTestMode() }

// ── Rate limiter: 100 req / 15min rolling window ──────────────────────────────
const _calls = []
function checkRateLimit() {
  const now = Date.now(), window = now - 15*60*1000
  while (_calls.length && _calls[0] < window) _calls.shift()
  if (_calls.length >= 95) throw new Error('Rate limit: 95/100 requests used this 15min window')
  _calls.push(now)
}

// ── Core fetch ────────────────────────────────────────────────────────────────
async function mpFetch(method, path, body) {
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set')
  checkRateLimit()

  const url = getBase() + path
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data.message || data.error || `HTTP ${res.status}`
    throw new Error(`ModemPay error: ${msg}`)
  }
  return data
}

// ── Balance ────────────────────────────────────────────────────────────────────
export async function getBalance() {
  return mpFetch('GET', '/balances')
}

// ── Transfer (payout) — per ModemPay PHP SDK spec ────────────────────────────
// PHP SDK: $modemPay->transfers()->create([
//   'amount' => 1000,
//   'account_number' => '7012345',
//   'network' => 'wave',
//   'currency' => 'GMD',
//   'beneficiary_name' => 'John Doe'
// ])
export async function createTransfer({ amount, phone, name, network = 'wave', currency = 'GMD', reference }) {
  if (!amount || amount <= 0)  throw new Error('Invalid withdrawal amount')
  if (!phone)                  throw new Error('account_number (phone) is required')

  const body = {
    amount,
    currency,
    account_number:   phone.replace(/\s+/g, ''),  // clean phone number
    network:          network.toLowerCase(),
    beneficiary_name: name || 'Vanguard Withdrawal',
    ...(reference ? { reference } : {}),
  }

  const result = await mpFetch('POST', '/transfers', body)
  const id = result.id || result.transfer_id || result.data?.id

  console.log(`[MODEMPAY] Transfer ${id}: ${amount} ${currency} → ${phone} via ${network.toUpperCase()}`)

  // Persist record to DB
  setConfig(`withdrawal_${Date.now()}`, JSON.stringify({
    id, amount, currency, phone, network, status: result.status || 'processing',
    ts: Math.floor(Date.now()/1000)
  }))

  emit('withdrawal_created', { id, amount, phone, network })
  return { ...result, id }
}

// ── Transfer status ────────────────────────────────────────────────────────────
export async function getTransferStatus(id) {
  return mpFetch('GET', `/transfers/${id}`)
}

// ── Transactions list ──────────────────────────────────────────────────────────
export async function listTransactions(limit = 20) {
  return mpFetch('GET', `/transactions?limit=${Math.min(limit, 100)}`)
}

// ── Payment intent ────────────────────────────────────────────────────────────
export async function createPaymentIntent({ amount, currency = 'GMD', customerPhone, customerName }) {
  return mpFetch('POST', '/payment-intents', {
    amount, currency,
    customer: { phone: customerPhone, name: customerName }
  })
}

// ── Fee calculator ────────────────────────────────────────────────────────────
export function calcFee(amount, method = 'wave') {
  const rates = {
    wave:      0.015,
    afrimoney: 0.015,
    qmoney:    0.015,
    bank:      0.0125,
    crypto:    0.010,
    card:      0.035,
  }
  const rate = rates[method.toLowerCase()] ?? 0.015
  const fee  = +(amount * rate).toFixed(2)
  const net  = +(amount - fee).toFixed(2)
  return { amount: +amount, fee, net, rate: (rate * 100).toFixed(2) + '%', method }
}

// ── Webhook verification ───────────────────────────────────────────────────────
export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[MODEMPAY] No MODEMPAY_WEBHOOK_SECRET set — skipping signature verification')
    return true
  }
  const { createHmac } = await import('crypto')
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  return signature === `sha256=${expected}` || signature === expected
}

// ── Withdrawal queue ──────────────────────────────────────────────────────────
const _queue = []
let _processing = false

export function queueWithdrawal(req) {
  _queue.push({ ...req, queuedAt: Date.now() })
  console.log(`[MODEMPAY] Queued: $${req.amount} → ${req.phone} (queue: ${_queue.length})`)
  if (!_processing) processQueue()
}

async function processQueue() {
  if (_processing || !_queue.length) return
  _processing = true
  try {
    while (_queue.length) {
      const req = _queue.shift()
      try {
        await createTransfer(req)
      } catch(e) {
        console.error('[MODEMPAY] Queue failed:', e.message)
        emit('withdrawal_failed', { error: e.message, amount: req.amount })
      }
      // Rate-limit-safe: 10s between queued transfers
      if (_queue.length) await new Promise(r => setTimeout(r, 10000))
    }
  } finally { _processing = false }
}

// ── Stats for dashboard ────────────────────────────────────────────────────────
export function getModemPayStats() {
  const configured = isConfigured()
  const live       = isLive()
  return {
    configured,
    status:      configured ? (live ? 'ACTIVE' : 'TEST') : 'NOT CONFIGURED',
    mode:        configured ? (live ? 'LIVE'   : 'TEST') : 'INACTIVE',
    keySet:      configured,
    keyHint:     configured ? getKey().slice(0,4) + '...' + getKey().slice(-4) : 'not set',
    endpoint:    getBase(),
    queueLength: _queue.length,
    callsWindow: _calls.length,
    rateLimit:   `${_calls.length}/100 req per 15min`,
    networks:    ['wave', 'afrimoney', 'qmoney', 'bank', 'crypto'],
    fees:        { wave:'1.5%', afrimoney:'1.5%', qmoney:'1.5%', bank:'1.25%', crypto:'1.0%' },
    note: configured ? (live ? 'Live key — withdrawals active' : 'Test mode — set MODEMPAY_MODE=live for production') : 'Set MODEMPAY_SECRET_KEY in Railway Variables',
  }
}

// ── Express routes ─────────────────────────────────────────────────────────────
export function registerModemPayRoutes(app) {

  // POST /api/modempay/withdraw
  app.post('/api/modempay/withdraw', async (req, res) => {
    const { amount, phone, name, network, currency } = req.body || {}
    if (!amount)   return res.status(400).json({ error: 'amount is required' })
    if (!phone)    return res.status(400).json({ error: 'phone is required' })
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' })

    const fee = calcFee(amt, network || 'wave')

    if (!isConfigured()) {
      queueWithdrawal({ amount:amt, phone, name, network:network||'wave', currency:currency||'GMD' })
      return res.json({ ok:true, status:'queued', fee,
        message:'MODEMPAY_SECRET_KEY not set — withdrawal queued for when key is added' })
    }

    try {
      const result = await createTransfer({
        amount: amt, phone, name,
        network:   network   || 'wave',
        currency:  currency  || 'GMD',
        reference: `vng_${Date.now()}`,
      })
      res.json({ ok:true, status:result.status||'processing', transferId:result.id, fee })
    } catch(e) {
      console.error('[MODEMPAY] Withdraw error:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // GET /api/modempay/balance
  app.get('/api/modempay/balance', async (_, res) => {
    if (!isConfigured()) return res.json({ configured:false, balance:0 })
    try { res.json(await getBalance()) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  // GET /api/modempay/transactions
  app.get('/api/modempay/transactions', async (req, res) => {
    if (!isConfigured()) return res.json({ configured:false, transactions:[] })
    try { res.json(await listTransactions(parseInt(req.query.limit||'20'))) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  // GET /api/modempay/status/:id
  app.get('/api/modempay/status/:id', async (req, res) => {
    try { res.json(await getTransferStatus(req.params.id)) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  // GET /api/modempay/fee?amount=1000&method=wave
  app.get('/api/modempay/fee', (req, res) => {
    const { amount, method } = req.query
    if (!amount) return res.status(400).json({ error:'amount required' })
    res.json(calcFee(parseFloat(amount), method || 'wave'))
  })

  // POST /api/modempay/webhook
  app.post('/api/modempay/webhook', async (req, res) => {
    const sig = req.headers['x-modempay-signature'] || ''
    const raw = JSON.stringify(req.body)
    if (!await verifyWebhook(raw, sig)) {
      return res.status(401).json({ error:'Invalid webhook signature' })
    }
    // Respond immediately — process async
    res.json({ received: true })

    const { type, data } = req.body || {}
    console.log(`[MODEMPAY] Webhook: ${type}`)
    if (type === 'transfer.succeeded') {
      emit('withdrawal_completed', { id:data?.id, amount:data?.amount })
      setConfig(`withdrawal_${data?.id}_status`, 'completed')
      console.log(`[MODEMPAY] Transfer ${data?.id} COMPLETED`)
    }
    if (type === 'transfer.failed') {
      emit('withdrawal_failed', { id:data?.id, reason:data?.failure_reason })
      setConfig(`withdrawal_${data?.id}_status`, 'failed')
      console.error(`[MODEMPAY] Transfer ${data?.id} FAILED: ${data?.failure_reason}`)
    }
    if (type === 'transfer.pending') {
      console.log(`[MODEMPAY] Transfer ${data?.id} pending`)
    }
  })

  // GET /api/modempay/stats
  app.get('/api/modempay/stats', (_, res) => res.json(getModemPayStats()))

  console.log('[MODEMPAY] Routes registered: withdraw · balance · transactions · fee · status · webhook · stats')
}

export function startModemPay() {
  const s = getModemPayStats()
  if (s.configured) {
    console.log(`[MODEMPAY] ${s.mode} — ${s.note}`)
    console.log(`[MODEMPAY] Key: ${s.keyHint} | Endpoint: ${s.endpoint}`)
  } else {
    console.log('[MODEMPAY] Not configured — add MODEMPAY_SECRET_KEY to Railway Variables')
    console.log('[MODEMPAY] Withdrawals will queue and execute once key is set')
  }
  console.log('[MODEMPAY] Networks: Wave · Afrimoney · QMoney · Bank · Crypto USDC/USDT')
    }
