// X7 PROTOCOL — DATABASE
// sql.js: pure JS SQLite, no native deps, no Python needed
// _ready gate: all functions return empty until DB is initialized
// Single source of truth: zero duplicate exports

import { createRequire } from 'module'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const require    = createRequire(import.meta.url)
const __dir      = dirname(fileURLToPath(import.meta.url))
const DATA_DIR   = existsSync('/data') ? '/data' : join(__dir, '../data')
const DB_PATH    = join(DATA_DIR, 'x7.db')
const SCHEMA     = join(__dir, '../database/schema.sql')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

let db       = null
let _ready   = false

function log(m) { console.log(`[DB] ${new Date().toISOString()} ${m}`) }

export async function initDB() {
  const initSql = require('sql.js')
  const SQL     = await initSql()
  db            = existsSync(DB_PATH)
    ? new SQL.Database(readFileSync(DB_PATH))
    : new SQL.Database()
  db.run(readFileSync(SCHEMA, 'utf8'))
  _save()
  setInterval(_save, 15000)
  _ready = true
  log(`ready → ${DB_PATH}`)
}

function _save() {
  if (!db) return
  try { writeFileSync(DB_PATH, Buffer.from(db.export())) } catch {}
}

function _q(sql, p = []) {
  if (!_ready) return []
  try {
    const s = db.prepare(sql)
    s.bind(p)
    const rows = []
    while (s.step()) rows.push(s.getAsObject())
    s.free()
    return rows
  } catch (e) { log(`query error: ${e.message}`); return [] }
}

function _r(sql, p = []) {
  if (!_ready) return
  try { db.run(sql, p) } catch (e) { log(`run error: ${e.message}`) }
}

export function getConfig(k) {
  const r = _q('SELECT value FROM system_config WHERE key=?', [k])
  return r[0]?.value ?? null
}

export function setConfig(k, v) {
  _r(`INSERT OR REPLACE INTO system_config (key,value,updated_at)
      VALUES (?,?,strftime('%s','now'))`, [k, String(v)])
}

export function recordExecution(d) {
  _r(`INSERT INTO executions
      (tx_hash,chain,protocol,borrower,collateral_asset,debt_asset,
       profit_usdc,gas_usdc,status,error_msg)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [d.txHash||null, d.chain, d.protocol||'aave', d.borrower||null,
     d.collateralAsset||null, d.debtAsset||null,
     d.profitUsdc||0, d.gasUsdc||0, d.status||'pending', d.errorMsg||null])
  _save()
}

// THE EXPORT THAT CRASHED THE PREVIOUS SYSTEM
export function recordRevenue(chain, profitUsdc, protocol='aave') {
  if (!profitUsdc || profitUsdc <= 0) return
  const burned = Number(getConfig('x7t_burned')||0) + (profitUsdc * 0.01)
  setConfig('x7t_burned', burned.toFixed(6))
  console.log(`[PROFIT] +$${Number(profitUsdc).toFixed(2)} on ${chain}/${protocol}`)
}

export function getTotalRevenue() {
  return Number(_q(`SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'`)[0]?.t)||0
}

export function getTodayRevenue() {
  return Number(_q(`SELECT SUM(profit_usdc) as t FROM executions
    WHERE status='success' AND created_at>=strftime('%s','now','start of day')`)[0]?.t)||0
}

export function getRecentExecutions(n=20) {
  return _q(`SELECT * FROM executions ORDER BY created_at DESC LIMIT ?`, [n])
}

export function upsertBorrower(address, chain, protocol, hf, coll=0, debt=0) {
  _r(`INSERT OR REPLACE INTO borrowers
      (address,chain,protocol,health_factor,collateral_usd,debt_usd,last_checked)
      VALUES (?,?,?,?,?,?,strftime('%s','now'))`,
    [address, chain, protocol, hf, coll, debt])
}

export function getAtRisk(chain, protocol, maxHF=1.05) {
  return _q(`SELECT * FROM borrowers WHERE chain=? AND protocol=?
     AND health_factor<? AND health_factor>0
     ORDER BY health_factor ASC LIMIT 500`, [chain, protocol, maxHF])
}

export function recordWithdrawal(k, usdc, gmd) {
  _r(`INSERT OR IGNORE INTO withdrawals (idempotency_key,usdc_amount,gmd_amount)
      VALUES (?,?,?)`, [k, usdc, gmd])
  _save()
}

export function updateWithdrawal(k, tid, status, err=null) {
  _r(`UPDATE withdrawals SET transfer_id=?,status=?,error=? WHERE idempotency_key=?`,
    [tid, status, err, k])
  _save()
}

export function getWithdrawals(n=20) {
  return _q(`SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT ?`, [n])
}

export function logApex(sub, action, result) {
  _r(`INSERT INTO apex_log (subsystem,action,result) VALUES (?,?,?)`,
    [sub, action, JSON.stringify(result)])
}

export function query(sql, p=[]) { return _q(sql, p) }
export function isReady() { return _ready }
