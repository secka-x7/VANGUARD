import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getTotalRevenue, getTodayRevenue, getRecentExecutions,
         getWithdrawals, getConfig, query, isReady } from './db.js'
import { getAutoWithdraw, setAutoWithdraw, withdraw } from './treasury.js'
import { getExecutorAddress } from './pimlico.js'

const __dir  = dirname(fileURLToPath(import.meta.url))
const HTML   = readFileSync(join(__dir, 'dashboard/index.html'), 'utf8')
const app    = express()
const server = createServer(app)
const wss    = new WebSocketServer({ server })
const clients= new Set()
app.use(express.json())

wss.on('connection', ws => {
  clients.add(ws)
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

export function broadcast(type, data) {
  const m = JSON.stringify({ type, data, ts: Date.now() })
  for (const c of clients) if (c.readyState===1) try { c.send(m) } catch {}
}

app.get('/health', (_,res) => res.status(200).json({
  status:'operational', uptime:Math.floor(process.uptime()),
  ts: new Date().toISOString(), dbReady: isReady()
}))

app.get('/api/overview', (req,res) => {
  if (!isReady()) return res.json({ initializing:true, totalRevenue:0, todayRevenue:0 })
  try {
    const chains = ['polygon','arbitrum','ethereum','avalanche']
    res.json({
      totalRevenue:     getTotalRevenue(),
      todayRevenue:     getTodayRevenue(),
      recentExecutions: getRecentExecutions(15),
      prices:     JSON.parse(getConfig('prices')||'{}'),
      apex:       { insight: getConfig('apex_insight')||'Scanning.', action: getConfig('apex_action')||'--' },
      borrowers:  query('SELECT COUNT(*) as c FROM borrowers')[0]?.c||0,
      executor:   getExecutorAddress(),
      autoWithdraw: getAutoWithdraw(),
      chains: chains.reduce((a,c) => ({
        ...a, [c]: {
          ws:      getConfig('ws_'+c)||'starting',
          contract:getConfig('contract_'+c)||'deploying',
          wr_aave: getConfig('wr_'+c+'_aave')||'0.400',
          yield:   getConfig('yield_deployed_'+c)||'0'
        }
      }), {})
    })
  } catch(e) { res.status(500).json({ error:e.message, totalRevenue:0, todayRevenue:0 }) }
})

app.get('/api/executions', (req,res) => {
  if (!isReady()) return res.json({ executions:[], stats:{total:0,success:0,profit:0,winRate:'0%'} })
  try {
    const executions = query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 200')
    const total   = query('SELECT COUNT(*) as c FROM executions')[0]?.c||0
    const success = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c||0
    const profit  = query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'")[0]?.t||0
    res.json({ executions, stats:{total,success,profit,
      winRate: total>0 ? ((success/total)*100).toFixed(1)+'%':'0%'} })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('/api/treasury', (req,res) => {
  if (!isReady()) return res.json({ totalRevenue:0, todayRevenue:0, byChain:{}, withdrawals:[] })
  try {
    const chains = ['polygon','arbitrum','ethereum','avalanche']
    res.json({
      totalRevenue:  getTotalRevenue(),
      todayRevenue:  getTodayRevenue(),
      byChain: chains.reduce((a,c) => ({
        ...a, [c]: Number(query(
          "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success'",[c]
        )[0]?.t)||0
      }),{}),
      withdrawals:  getWithdrawals(10),
      autoWithdraw: getAutoWithdraw(),
      x7tBurned:    Number(getConfig('x7t_burned')||0)
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/withdraw', async (req,res) => {
  try {
    const { amount } = req.body
    if (!amount || isNaN(+amount) || +amount<=0)
      return res.status(400).json({ error:'Valid amount required' })
    const result = await withdraw(+amount)
    broadcast('withdrawal', { amount, id:result.key })
    res.json({ success:true, ...result })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req,res) => {
  const current = getAutoWithdraw()
  setAutoWithdraw(!current)
  broadcast('auto_withdraw_toggle', { enabled:!current })
  res.json({ autoWithdraw:!current })
})

app.get('/api/system', (req,res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    res.json({
      uptime:   Math.floor(process.uptime()),
      memory:   (process.memoryUsage().heapUsed/1024/1024).toFixed(0)+'MB',
      executor: getExecutorAddress(),
      dbReady:  isReady(),
      autoWithdraw: getAutoWithdraw(),
      apexLog:  query('SELECT * FROM apex_log ORDER BY created_at DESC LIMIT 20'),
      contracts:['polygon','arbitrum','ethereum','avalanche'].reduce((a,c)=>({
        ...a,[c]:getConfig('contract_'+c)||'--'}),{})
    })
  } catch(e) { res.status(500).json({ error:e.message }) }
})

app.get('*', (_,res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.send(HTML)
})

export function startDashboard() {
  const PORT = parseInt(process.env.PORT)||3000
  server.listen(PORT, '0.0.0.0', () =>
    console.log('[DASHBOARD] Live on port '+PORT)
  )
  setInterval(async () => {
    try {
      broadcast('tick', {
        revenue: getTotalRevenue(),
        today:   getTodayRevenue(),
        ts:      Date.now()
      })
    } catch {}
  }, 5000)
  return server
}
