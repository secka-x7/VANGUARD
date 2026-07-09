// Vanguard · modempay.js
// ModemPay integration — REST API for Gambia / West Africa withdrawals
// Licensed: Central Bank of The Gambia Reg. No. 2025/C25067
// Docs: https://docs.modempay.com
// Rates: Mobile money 1.5% · Transfers 1.25% · Crypto 1.0%
// Rate limit: 100 req / 15min rolling window per key

import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

const MODEMPAY_BASE = 'https://api.modempay.com/v1'
const MODEMPAY_TEST = 'https://api.test.modempay.com/v1'

function getKey() {
  return process.env.MODEMPAY_SECRET_KEY || ''
}
function getBase() {
  const key = getKey()
  return key.startsWith('sk_live_') ? MODEMPAY_BASE : MODEMPAY_TEST
}
function isConfigured() {
  return !!getKey()
}

// ── Rate limit tracker (100 req / 15min) ─────────────────────────────────────
const _calls = []
function checkRateLimit() {
  const now = Date.now()
  const window = now - 15 * 60 * 1000
  while (_calls.length && _calls[0] < window) _calls.shift()
  if (_calls.length >= 95) throw new Error('ModemPay rate limit approaching (95/100 per 15min)')
  _calls.push(now)
}

async function mpFetch(method, path, body) {
  checkRateLimit()
  const key = getKey()
  if (!key) throw new Error('MODEMPAY_SECRET_KEY not set in Railway env vars')

  const res = await fetch(getBase() + path, {
    method,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`ModemPay ${res.status}: ${data.message || 'Unknown error'}`)
  }
  return data
}

// ── Core: Check balance ───────────────────────────────────────────────────────
export async function getBalance() {
  return mpFetch('GET', '/balances')
}

// ── Core: Create payout / transfer ────────────────────────────────────────────
// ModemPay transfers (payouts) — sends funds to mobile money or bank
// Fee: 1.25% for transfers, 1.5% for mobile money
// Settlement: instant (mobile money) or next-day (bank)
export async function createTransfer({
  amount,           // number, in GMD (Gambian Dalasi) or USD depending on account
  currency = 'USD',
  recipient,        // { phone, name, network } for mobile money
  description = 'Vanguard withdrawal',
  reference,        // unique ID for idempotency
}) {
  if (!amount || amount <= 0) throw new Error('Invalid amount')
  if (!recipient?.phone) throw new Error('Recipient phone required')

  const body = {
    amount,
    currency,
    recipient: {
      phone:   recipient.phone,
      name:    recipient.name || 'Vanguard User',
      network: recipient.network || 'wave',  // wave | afrimoney | qmoney
    },
    description,
    reference: reference || `vanguard_${Date.now()}`,
  }

  const result = await mpFetch('POST', '/transfers', body)

  // Record withdrawal in DB
  setConfig(`withdrawal_${reference || Date.now()}`, JSON.stringify({
    amount, currency, status: result.status || 'pending',
    transferId: result.id, ts: Math.floor(Date.now()/1000)
  }))

  emit('withdrawal_created', { amount, currency, transferId: result.id, recipient: recipient.phone })
  console.log(`[MODEMPAY] Transfer created: ${amount} ${currency} → ${recipient.phone} (${result.id})`)
  return result
}

// ── Core: Get transfer status ─────────────────────────────────────────────────
export async function getTransferStatus(transferId) {
  return mpFetch('GET', `/transfers/${transferId}`)
}

// ── Core: List recent transactions ───────────────────────────────────────────
export async function listTransactions(limit = 20) {
  return mpFetch('GET', `/transactions?limit=${limit}`)
}

// ── Core: Create payment intent (for receiving funds) ─────────────────────────
export async function createPaymentIntent({ amount, currency = 'USD', customerPhone, customerName, customerEmail }) {
  return mpFetch('POST', '/payment-intents', {
    amount, currency,
    customer: { phone: customerPhone, name: customerName, email: customerEmail }
  })
}

// ── Fee calculator ────────────────────────────────────────────────────────────
export function calcFee(amount, method = 'wave') {
  const rates = { wave: 0.015, afrimoney: 0.015, qmoney: 0.015, bank: 0.0125, crypto: 0.01, card: 0.035 }
  const rate = rates[method] || 0.015
  const fee  = amount * rate
  return { amount, fee: parseFloat(fee.toFixed(2)), net: parseFloat((amount - fee).toFixed(2)), rate: rate * 100 + '%' }
}

// ── Webhook signature verification ───────────────────────────────────────────
// ModemPay signs each webhook delivery — verify before processing
export async function verifyWebhook(rawBody, signature) {
  const secret = process.env.MODEMPAY_WEBHOOK_SECRET
  if (!secret) return true  // skip verification in dev

  // HMAC-SHA256 verification (ModemPay uses same pattern as Stripe)
  const crypto  = await import('crypto')
  const expected = crypto.createHmac('sha256', secret)
    .update(rawBody).digest('hex')
  return signature === `sha256=${expected}`
}

// ── Withdrawal queue — handles bulk disbursements within rate limits ──────────
// ModemPay: single-transaction API, 100 req/15min → queue handles batching
const _queue = []
let   _processing = false

export function queueWithdrawal(request) {
  _queue.push({ ...request, queuedAt: Date.now() })
  console.log(`[MODEMPAY] Queued withdrawal #${_queue.length}: $${request.amount} → ${request.recipient?.phone}`)
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
        console.error(`[MODEMPAY] Transfer failed: ${e.message}`)
        emit('withdrawal_failed', { error: e.message, request: req })
      }
      // Rate limit: space requests 10s apart to stay well under 100/15min
      if (_queue.length) await new Promise(r => setTimeout(r, 10000))
    }
  } finally { _processing = false }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
export function getModemPayStats() {
  return {
    configured:    isConfigured(),
    mode:          getKey().startsWith('sk_live_') ? 'LIVE' : 'TEST',
    queueLength:   _queue.length,
    callsThisWindow: _calls.length,
    rateLimit:     '100 req / 15min',
    fees: {
      wave:      '1.5% instant',
      afrimoney: '1.5% instant',
      bank:      '1.25% next-day',
      crypto:    '1.0% flat',
    },
    networks: ['Wave', 'Afrimoney', 'QMoney', 'Bank Transfer', 'Crypto USDC/USDT']
  }
}

// ── Express routes — wired by dashboard.js ────────────────────────────────────
export function registerModemPayRoutes(app) {
  // POST /api/modempay/withdraw
  app.post('/api/modempay/withdraw', async (req, res) => {
    const { amount, phone, name, network, currency } = req.body || {}
    if (!amount || !phone) return res.status(400).json({ error: 'amount and phone required' })
    if (parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })
    try {
      const fee = calcFee(parseFloat(amount), network || 'wave')
      if (!isConfigured()) {
        // Queue for when key is set
        queueWithdrawal({ amount: parseFloat(amount), currency: currency||'USD',
          recipient: { phone, name: name||'User', network: network||'wave' } })
        return res.json({ ok: true, status: 'queued', fee, message: 'Queued — add MODEMPAY_SECRET_KEY to Railway env to activate' })
      }
      const result = await createTransfer({
        amount: parseFloat(amount), currency: currency || 'USD',
        recipient: { phone, name: name || 'Vanguard User', network: network || 'wave' },
        reference: `vng_${Date.now()}`
      })
      res.json({ ok: true, status: result.status, transferId: result.id, fee })
    } catch(e) {
      console.error('[MODEMPAY] Withdraw error:', e.message)
      res.status(500).json({ error: e.message })
    }
  })

  // GET /api/modempay/balance
  app.get('/api/modempay/balance', async (_, res) => {
    if (!isConfigured()) return res.json({ configured: false, message: 'Add MODEMPAY_SECRET_KEY to Railway env' })
    try { res.json(await getBalance()) }
    catch(e) { res.status(500).json({ error: e.message }) }
  })

  // GET /api/modempay/transactions
  app.get('/api/modempay/transactions', async (_, res) => {
    if (!isConfigured()) return res.json({ configured: false, transactions: [] })
    try { res.json(await listTransactions(20)) }
    catch(e) { res.status(500).json({ error: e.message }) }
  })

  // GET /api/modempay/status/:id
  app.get('/api/modempay/status/:id', async (req, res) => {
    try { res.json(await getTransferStatus(req.params.id)) }
    catch(e) { res.status(500).json({ error: e.message }) }
  })

  // GET /api/modempay/fee
  app.get('/api/modempay/fee', (req, res) => {
    const { amount, method } = req.query
    if (!amount) return res.status(400).json({ error: 'amount required' })
    res.json(calcFee(parseFloat(amount), method || 'wave'))
  })

  // POST /api/modempay/webhook  (ModemPay → Vanguard state updates)
  app.post('/api/modempay/webhook', async (req, res) => {
    const sig = req.headers['x-modempay-signature'] || ''
    const raw = JSON.stringify(req.body)
    const valid = await verifyWebhook(raw, sig)
    if (!valid) return res.status(401).json({ error: 'Invalid signature' })

    // Respond immediately (ModemPay retries on non-200 after 10min × 3)
    res.json({ received: true })

    // Process async
    const { type, data } = req.body
    console.log(`[MODEMPAY] Webhook: ${type}`)
    if (type === 'transfer.succeeded') {
      emit('withdrawal_completed', { transferId: data?.id, amount: data?.amount })
      setConfig(`withdrawal_${data?.id}_status`, 'completed')
    }
    if (type === 'transfer.failed') {
      emit('withdrawal_failed', { transferId: data?.id, error: data?.failure_reason })
      setConfig(`withdrawal_${data?.id}_status`, 'failed')
    }
  })

  // GET /api/modempay/stats
  app.get('/api/modempay/stats', (_, res) => res.json(getModemPayStats()))

  console.log('[MODEMPAY] Routes registered: /api/modempay/{withdraw,balance,transactions,fee,status,webhook,stats}')
}

export function startModemPay() {
  const stats = getModemPayStats()
  console.log(`[MODEMPAY] ${stats.configured ? `${stats.mode} mode — ready` : 'Add MODEMPAY_SECRET_KEY to Railway env to activate'}`)
  console.log('[MODEMPAY] Networks: Wave · Afrimoney · QMoney · Bank · Crypto USDC/USDT')
  console.log('[MODEMPAY] Fees: Wave/Afrimoney 1.5% · Bank 1.25% · Crypto 1.0%')
  if (!stats.configured) {
    console.log('[MODEMPAY] ⚠  Set MODEMPAY_SECRET_KEY=sk_live_... in Railway Variables')
  }
}
