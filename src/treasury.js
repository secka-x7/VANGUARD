import { createRequire } from 'module'
import { v4 as uuidv4 } from 'uuid'
import { getConfig, setConfig, recordWithdrawal, updateWithdrawal,
         getTotalRevenue, getTodayRevenue } from './db.js'

const require = createRequire(import.meta.url)

export function getAutoWithdraw() { return getConfig('auto_withdraw')==='true' }
export function setAutoWithdraw(v){ setConfig('auto_withdraw', v ? 'true':'false') }

// Called after every execution — check if auto-partial threshold hit
export async function checkAutoWithdraw() {
  if (!getAutoWithdraw()) return
  const threshold = 500
  const pct       = 0.30
  const lastWD    = Number(getConfig('last_auto_wd_at')||0)
  const today     = getTodayRevenue()
  if (today - lastWD >= threshold) {
    const amount = (today - lastWD) * pct
    await withdraw(amount)
    setConfig('last_auto_wd_at', today)
  }
}

export async function withdraw(usdcAmount) {
  const waveNum = process.env.MODEM_PAY_WAVE_NUMBER
  const secret  = process.env.MODEM_PAY_SECRET_KEY
  if (!waveNum || !secret) throw new Error('MODEM_PAY vars not set')

  const key     = uuidv4()
  const rate    = await getGMDRate()
  const gmd     = Math.floor(usdcAmount * rate)
  recordWithdrawal(key, usdcAmount, gmd)

  try {
    const MP     = require('modem-pay')
    const client = new (MP.default||MP)(secret)
    const t      = await client.transfers.initiate({
      amount: gmd, currency:'GMD', network:'wave',
      account_number:   waveNum,
      beneficiary_name: process.env.MODEM_PAY_BENEFICIARY_NAME||'X7 Protocol',
      narration:        'X7 Protocol Revenue',
      metadata:         { usdc: usdcAmount }
    }, key)
    updateWithdrawal(key, t.id, t.status)
    console.log(`[TREASURY] Withdrawal sent: $${usdcAmount} USDC → ${gmd} GMD | ${t.id}`)
    return { success:true, transferId: t.id, key }
  } catch (e) {
    updateWithdrawal(key, null, 'failed', e.message)
    throw e
  }
}

async function getGMDRate() {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    const d = await r.json()
    return d.rates?.GMD || 72
  } catch { return 72 }
}
