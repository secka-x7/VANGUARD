// Vanguard · modempay.js — FINAL. Live only. No test mode. No prefix detection.
//
// PRINCIPLE:
//   MODEMPAY_SECRET_KEY is set → API is live → status ACTIVE.
//   Period. No key prefix checking. No mode env var. No KYC messaging.
//   The key is live, KYC is done, everything is working.
//   Single endpoint: https://api.modempay.com/v1 — always.
//
// Transfer body per PHP SDK:
//   account_number, network, beneficiary_name, amount, currency
//
// Dashboard: configured=true → status='ACTIVE', mode='LIVE' always.

import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const API = 'https://api.modempay.com/v1'  // live only, always

function getKey() {
  // Strip whitespace and quotes — Railway UI sometimes adds these
  return (process.env.MODEMPAY_SECRET_KEY || '').trim().replace(/^["']|["']$/g, '')
}

function isConfigured() { return getKey().length > 0 }

// ── Rate limit: 100 req / 15min ────────────────────────────────────────────────
const _calls = []
function checkRate() {
  const now = Date.now(), win = now - 900000
  while (_calls.length && _calls[0] < win) _calls.shift()
  if (_calls.length >= 95) throw new Error('Rate limit: 95/100 used this 15min window')
  _calls.push(now)
}

// ── Core fetch ─────────────────────────────────────────────────────────────────
async function mpFetch(method, path, body) {
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set in Railway Variables')
  checkRate()

  const res = await fetch(API + path, {
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
    throw new Error(`ModemPay ${res.status}: ${data.message || data.error || JSON.stringify(data).slice(0,120)}`)
  }
  return data
}

// ── API Methods ────────────────────────────────────────────────────────────────

export async function getBalance() {
  return mpFetch('GET', '/balances')
}

// Transfer — per PHP SDK: account_number, network, beneficiary_name, amount, currency
export async function createTransfer({ amount, currency = 'GMD', phone, name, network = 'wave', reference }) {
  if (!amount || amount <= 0) throw new Error('amount must be positive')
  if (!phone)                 throw new Error('phone (account_number) is required')

  const result = await mpFetch('POST', '/transfers', {
    amount,
    currency,
    account_number:   String(phone).trim(),
    network:          network.toLowerCase(),
    beneficiary_name: name || 'Vanguard User',
    reference:        reference || `vng_${Date.now()}`,
  })

  const id = result.id || result.transfer_id || result.data?.id || 'submitted'
  console.log(`[MODEMPAY] Transfer ${id}: ${amount} ${currency} → ${phone} via ${network.toUpperCase()}`)

  setConfig(`mp_withdrawal_${Date.now()}`, JSON.stringify({
    id, amount, currency, phone, network,
    status: result.status || 'processing',
    ts:     Math.floor(Date.now() / 1000),
  }))

  emit('withdrawal_created', { id, amount, phone, network })
  return { ...result, id }
}

export async function getTransferStatus(id) {
  return mpFetch('GET', `/transfers/${id}`)
}

export async function listTransactions(limit = 20) {
  return mpFetch('GET', `/transactions?limit=${Math.min(limit, 100)}`)
}

export async function createPaymentIntent({ amount, currency = 'GMD', customerPhone, customerName }) {
  return mpFetch('POST', '/payment-intents', {
    amount, currency,
    customer: { phone: customerPhone, name: customerName },
  })
}

// ── Fee calculator ─────────────────────────────────────────────────────────────
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
  return { amount: +amount, fee, net: +(amount - fee).toFixed(2), rate: (rate*100)+'%', method }
}

// ── Webhook verification — HMAC-SHA512 ────────────────────────────────────────
export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) return true
  const { createHmac } = await import('crypto')
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex')
  return signature === expected || signature === `sha256=${expected}`
}

// ── Withdrawal queue ───────────────────────────────────────────────────────────
const _queue  = []
let   _busy   = false

export function queueWithdrawal(req) {
  _queue.push({ ...req, queuedAt: Date.now() })
  console.log(`[MODEMPAY] Queued: ${req.amount} ${req.currency||'GMD'} → ${req.phone} (q:${_queue.length})`)
  if (!_busy) processQueue()
}

async function processQueue() {
  if (_busy || !_queue.length) return
  _busy = true
  try {
    while (_queue.length) {
      const req = _queue.shift()
      try { await createTransfer(req) }
      catch(e) { console.error('[MODEMPAY] Queue failed:', e.message) }
      if (_queue.length) await new Promise(r => setTimeout(r, 10000))
    }
  } finally { _busy = false }
}

// ── Stats for dashboard ────────────────────────────────────────────────────────
export function getModemPayStats() {
  const configured = isConfigured()
  return {
    configured,
    status:      configured ? 'ACTIVE'   : 'NOT CONFIGURED',
    mode:        configured ? 'LIVE'     : 'INACTIVE',
    endpoint:    API,
    keyHint:     configured ? getKey().slice(0,4) + '...' + getKey().slice(-4) : 'NOT SET',
    queueLength: _queue.length,
    callsWindow: _calls.length,
    rateLimit:   '100 req / 15min',
    networks:    ['wave', 'afrimoney', 'qmoney', 'bank', 'crypto'],
    fees:        { wave:'1.5%', afrimoney:'1.5%', qmoney:'1.5%', bank:'1.25%', crypto:'1.0%' },
  }
}

// ── Express routes ─────────────────────────────────────────────────────────────
export function registerModemPayRoutes(app) {

  app.post('/api/modempay/withdraw', async (req, res) => {
    const { amount, phone, name, network, currency } = req.body || {}
    if (!amount || !phone)
      return res.status(400).json({ error: 'amount and phone required' })
    const amt = parseFloat(amount)
    if (!amt || amt <= 0)
      return res.status(400).json({ error: 'Invalid amount' })

    const fee = calcFee(amt, network || 'wave')

    if (!isConfigured()) {
      queueWithdrawal({ amount:amt, currency:currency||'GMD', phone, name, network:network||'wave' })
      return res.json({ ok:true, status:'queued', fee,
        message:'Add MODEMPAY_SECRET_KEY to Railway Variables to activate' })
    }

    try {
      const result = await createTransfer({
        amount:amt, currency:currency||'GMD', phone, name,
        network:   network   || 'wave',
        reference: `vng_${Date.now()}`,
      })
      res.json({ ok:true, status:result.status||'submitted', transferId:result.id, fee })
    } catch(e) {
      console.error('[MODEMPAY] Withdraw error:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  app.get('/api/modempay/balance', async (_, res) => {
    if (!isConfigured()) return res.json({ configured:false })
    try { res.json(await getBalance()) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/transactions', async (req, res) => {
    if (!isConfigured()) return res.json({ configured:false, transactions:[] })
    try { res.json(await listTransactions(parseInt(req.query.limit||'20'))) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/status/:id', async (req, res) => {
    try { res.json(await getTransferStatus(req.params.id)) }
    catch(e) { res.status(500).json({ error:e.message }) }
  })

  app.get('/api/modempay/fee', (req, res) => {
    const { amount, method } = req.query
    if (!amount) return res.status(400).json({ error:'amount required' })
    res.json(calcFee(parseFloat(amount), method || 'wave'))
  })

  app.post('/api/modempay/webhook', async (req, res) => {
    const sig = req.headers['x-modem-signature'] ||
                req.headers['x-modempay-signature'] || ''
    const raw = JSON.stringify(req.body)
    if (!await verifyWebhook(raw, sig))
      return res.status(401).json({ error:'Invalid signature' })

    res.json({ received: true })
    const { type, data } = req.body || {}
    console.log(`[MODEMPAY] Webhook: ${type}`)
    if (type === 'transfer.succeeded') emit('withdrawal_completed', { id:data?.id, amount:data?.amount })
    if (type === 'transfer.failed')    emit('withdrawal_failed',    { id:data?.id, reason:data?.failure_reason })
    if (type === 'payment_intent.succeeded') emit('payment_received', { id:data?.id, amount:data?.amount })
  })

  app.get('/api/modempay/stats', (_, res) => res.json(getModemPayStats()))

  console.log('[MODEMPAY] Routes: /api/modempay/{withdraw,balance,transactions,fee,status,webhook,stats}')
}

export function startModemPay() {
  if (isConfigured()) {
    const key = getKey()
    console.log(`[MODEMPAY] ACTIVE — live endpoint: ${API}`)
    console.log(`[MODEMPAY] Key: ${key.slice(0,4)}...${key.slice(-4)} | Networks: Wave · Afrimoney · QMoney · Bank · Crypto`)
  } else {
    console.log('[MODEMPAY] Awaiting MODEMPAY_SECRET_KEY in Railway Variables')
  }
        }
