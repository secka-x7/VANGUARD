// sql.js WASM SQLite + Postgres backup
// FIX: NO strftime() — WASM omits date functions. Timestamps from JS only.
// Self-heals: WASM corruption → auto-recreate database
import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import pg from 'pg'

const require  = createRequire(import.meta.url)
const DIR      = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
const PATH     = DIR + '/x7sv.db'
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

let _db, _pg, _SQL

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT, ts INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS executions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT, chain TEXT, protocol TEXT,
    profit_usdc REAL DEFAULT 0, status TEXT, ts INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_exec ON executions(chain, ts);
`

export async function initDB() {
  _SQL = await require('sql.js')()
  _db  = existsSync(PATH)
    ? new _SQL.Database(readFileSync(PATH))
    : new _SQL.Database()
  _db.run(SCHEMA)
  _save()
  if (process.env.DATABASE_URL) {
    try {
      _pg = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
      await _pg.query(`
        CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT, ts BIGINT DEFAULT 0);
        CREATE TABLE IF NOT EXISTS executions(
          id SERIAL PRIMARY KEY, tx_hash TEXT, chain TEXT, protocol TEXT,
          profit_usdc REAL DEFAULT 0, status TEXT, ts BIGINT DEFAULT 0
        );`)
      const n = _db.exec('SELECT COUNT(*) FROM config')[0]?.values[0][0] || 0
      if (!n) {
        const rows = await _pg.query('SELECT key,value FROM config')
        const s = _db.prepare('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)')
        rows.rows.forEach(r => s.run([r.key, r.value, Date.now()/1000|0]))
        s.free(); _save()
      }
      console.log('[DB] Postgres connected')
    } catch(e) { console.log('[DB] Postgres optional:', e.message?.slice(0,60)) }
  }
  setInterval(_save, 5000)
  console.log('[DB] Ready')
}

function _save() {
  if (!_db) return
  try { writeFileSync(PATH, Buffer.from(_db.export())) } catch {}
}

const _q = []
let   _t = null
function _flush() {
  _t = null
  if (!_q.length || !_db) return
  try {
    _db.run('BEGIN')
    _q.splice(0).forEach(({s,p}) => _db.run(s,p))
    _db.run('COMMIT')
  } catch(e) {
    try { _db.run('ROLLBACK') } catch {}
    // Self-heal: recreate DB if WASM corrupted
    if (!e.message || e.message === 'undefined' || e.message.includes('memory')) {
      console.warn('[DB] Self-heal: recreating database')
      try { _db = new _SQL.Database(); _db.run(SCHEMA) } catch {}
    }
  }
}

function _w(s, p) {
  _q.push({s,p})
  if (!_t) _t = setTimeout(_flush, 100)
}

export function setConfig(k, v) {
  const ts = Date.now()/1000|0
  _w('INSERT OR REPLACE INTO config(key,value,ts) VALUES(?,?,?)', [k, String(v), ts])
  _pg?.query('INSERT INTO config(key,value,ts) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,ts=$3',
    [k, String(v), ts]).catch(()=>{})
}

export function getConfig(k) {
  try { return _db?.exec(`SELECT value FROM config WHERE key='${k.replace(/'/g,"''")}'`)[0]?.values[0]?.[0] ?? null }
  catch { return null }
}

export function recordExecution(d) {
  const ts = Date.now()/1000|0
  _w('INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,ts) VALUES(?,?,?,?,?,?)',
    [d.txHash||'', d.chain||'', d.protocol||'', d.profitUsdc||0, d.status||'success', ts])
  _pg?.query('INSERT INTO executions(tx_hash,chain,protocol,profit_usdc,status,ts) VALUES($1,$2,$3,$4,$5,$6)',
    [d.txHash||'', d.chain||'', d.protocol||'', d.profitUsdc||0, d.status||'success', ts]).catch(()=>{})
}

export function getStats() {
  try {
    const now = Date.now()/1000|0
    const r = _db.exec(`SELECT COUNT(*) total,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) wins,
      COALESCE(SUM(profit_usdc),0) profit,
      COALESCE(SUM(CASE WHEN ts>${now-86400} THEN profit_usdc ELSE 0 END),0) today
      FROM executions`)[0]?.values[0]||[0,0,0,0]
    return { total:r[0]||0, winRate:r[0]?Math.round((r[1]/r[0])*100)+'%':'0%', profit:r[2]||0, today:r[3]||0 }
  } catch { return { total:0, winRate:'0%', profit:0, today:0 } }
}

export function getExecutions(limit=50) {
  try {
    const s = _db.prepare('SELECT * FROM executions ORDER BY ts DESC LIMIT ?')
    s.bind([limit]); const rows=[]
    while (s.step()) rows.push(s.getAsObject())
    s.free(); return rows
  } catch { return [] }
}
