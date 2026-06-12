import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { getTotalRevenue, getTodayRevenue, getRecentExecutions,
         getWithdrawals, getConfig, query, isReady } from './db.js'
import { getAutoWithdraw, setAutoWithdraw, withdraw } from './treasury.js'
import { getExecutorAddress } from './pimlico.js'

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

// HEALTH — always responds, even before DB ready
app.get('/health', (_,res) => res.status(200).json({
  status:'operational', uptime: Math.floor(process.uptime()),
  ts: new Date().toISOString(), dbReady: isReady()
}))

app.get('/api/overview', (req,res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    const chains = ['polygon','arbitrum','ethereum','base']
    res.json({
      totalRevenue:     getTotalRevenue(),
      todayRevenue:     getTodayRevenue(),
      recentExecutions: getRecentExecutions(15),
      prices:     JSON.parse(getConfig('prices')||'{}'),
      apex:       { insight: getConfig('apex_insight')||'Scanning.', action: getConfig('apex_action')||'—' },
      borrowers:  query('SELECT COUNT(*) as c FROM borrowers')[0]?.c||0,
      executor:   getExecutorAddress(),
      autoWithdraw: getAutoWithdraw(),
      chains: chains.reduce((a,c) => ({
        ...a, [c]: {
          ws:       getConfig(`ws_${c}`)||'starting',
          contract: getConfig(`contract_${c}`)||'deploying',
          wr_aave:  getConfig(`wr_${c}_aave`)||'0.400',
          yield:    getConfig(`yield_deployed_${c}`)||'0'
        }
      }), {})
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/executions', (req,res) => {
  if (!isReady()) return res.json({ executions:[], stats:{} })
  try {
    const executions = query('SELECT * FROM executions ORDER BY created_at DESC LIMIT 200')
    const total   = query('SELECT COUNT(*) as c FROM executions')[0]?.c||0
    const success = query("SELECT COUNT(*) as c FROM executions WHERE status='success'")[0]?.c||0
    const profit  = query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'"  )[0]?.t||0
    res.json({ executions, stats:{ total, success, profit,
      winRate: total>0 ? ((success/total)*100).toFixed(1)+'%':'0%' }})
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/treasury', (req,res) => {
  if (!isReady()) return res.json({})
  try {
    const chains = ['polygon','arbitrum','ethereum','base']
    res.json({
      totalRevenue:  getTotalRevenue(),
      todayRevenue:  getTodayRevenue(),
      byChain:       chains.reduce((a,c) => ({
        ...a, [c]: Number(query(
          "SELECT SUM(profit_usdc) as t FROM executions WHERE chain=? AND status='success'",[c]
        )[0]?.t)||0
      }),{}),
      withdrawals:   getWithdrawals(10),
      autoWithdraw:  getAutoWithdraw(),
      x7tBurned:     Number(getConfig('x7t_burned')||0)
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/withdraw', async (req,res) => {
  try {
    const { amount } = req.body
    if (!amount || isNaN(+amount) || +amount <= 0)
      return res.status(400).json({ error:'Valid amount required' })
    const result = await withdraw(+amount)
    broadcast('withdrawal', { amount, id: result.key })
    res.json({ success:true, ...result })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/toggle-auto-withdraw', (req,res) => {
  const current = getAutoWithdraw()
  setAutoWithdraw(!current)
  broadcast('auto_withdraw_toggle', { enabled: !current })
  res.json({ autoWithdraw: !current })
})

app.get('/api/system', (req,res) => {
  if (!isReady()) return res.json({ initializing:true })
  try {
    res.json({
      uptime:    Math.floor(process.uptime()),
      memory:    (process.memoryUsage().heapUsed/1024/1024).toFixed(0)+'MB',
      executor:  getExecutorAddress(),
      dbReady:   isReady(),
      autoWithdraw: getAutoWithdraw(),
      apexLog:   query('SELECT * FROM apex_log ORDER BY created_at DESC LIMIT 20'),
      contracts: ['polygon','arbitrum','ethereum','base'].reduce((a,c)=>({
        ...a,[c]:getConfig(`contract_${c}`)||'—'}),{})
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Dashboard HTML — single string, served from memory
const HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>X7 PROTOCOL</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080808;--s1:#0d0d0d;--s2:#121212;--b:#1e1e1e;
  --blue:#2563eb;--bluel:#3b82f6;--blueg:rgba(37,99,235,.08);
  --green:#10b981;--red:#ef4444;--yellow:#f59e0b;
  --t1:#f1f5f9;--t2:#64748b;--t3:#334155;
  --mono:'JetBrains Mono',monospace
}
html,body{height:100%;background:var(--bg);color:var(--t1);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow-x:hidden}
.layout{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.sidebar{background:var(--s1);border-right:1px solid var(--b);
  display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.logo-wrap{padding:20px;border-bottom:1px solid var(--b)}
.logo{font-size:16px;font-weight:700;letter-spacing:3px;color:var(--bluel)}
.logo-sub{font-size:9px;color:var(--t3);letter-spacing:2px;margin-top:3px}
nav{flex:1;padding:8px 0}
.ni{display:flex;align-items:center;gap:10px;padding:11px 20px;
  cursor:pointer;color:var(--t2);font-size:12px;font-weight:500;
  transition:.15s;border-left:2px solid transparent;letter-spacing:.5px}
.ni:hover{background:var(--blueg);color:var(--t1)}
.ni.on{background:var(--blueg);color:var(--bluel);border-left-color:var(--blue)}
.sb-foot{padding:16px;border-top:1px solid var(--b)}
.live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;
  background:var(--green);animation:pulse 2s infinite;margin-right:6px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.main{padding:24px;overflow-y:auto}
.page{display:none}.page.on{display:block}
.ph{margin-bottom:20px}
.pt{font-size:18px;font-weight:700;letter-spacing:.5px}
.ps{font-size:12px;color:var(--t2);margin-top:3px}
.rev-bar{background:var(--s2);border:1px solid var(--b);border-radius:8px;
  padding:14px 20px;margin-bottom:20px;display:flex;gap:28px;flex-wrap:wrap;align-items:center}
.rv{min-width:120px}
.rl{font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px}
.rv-val{font-size:20px;font-weight:700;font-family:var(--mono);color:var(--green)}
.rv-val.blue{color:var(--bluel)}
.rd{width:1px;height:36px;background:var(--b)}
.g2{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.card{background:var(--s1);border:1px solid var(--b);border-radius:8px;padding:18px}
.card.sm{padding:14px}
.ct{font-size:9px;color:var(--t3);text-transform:uppercase;
  letter-spacing:1.5px;margin-bottom:8px}
.cv{font-size:22px;font-weight:700;font-family:var(--mono)}
.cv.g{color:var(--green)}.cv.b{color:var(--bluel)}.cv.y{color:var(--yellow)}
.cs{font-size:11px;color:var(--t2);margin-top:3px}
.feed{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto}
.fi{display:flex;align-items:center;gap:8px;padding:9px 12px;
  background:var(--s2);border-radius:6px;font-size:11px;border-left:2px solid var(--b)}
.fi.ok{border-left-color:var(--green)}
.fi.fail{border-left-color:var(--red)}
.fc{font-size:9px;padding:2px 6px;border-radius:3px;
  background:var(--blueg);color:var(--bluel);font-weight:700;letter-spacing:.5px}
.fprof{color:var(--green);font-weight:700;font-family:var(--mono);margin-left:auto}
.fprof.z{color:var(--t3)}
.chain-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.cc{background:var(--s2);border:1px solid var(--b);border-radius:8px;padding:12px}
.cc-name{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--bluel);margin-bottom:8px}
.cc-row{display:flex;justify-content:space-between;font-size:10px;padding:2px 0}
.cc-label{color:var(--t3)}.cc-val{color:var(--t1);font-family:var(--mono)}
.cc-val.ok{color:var(--green)}.cc-val.no{color:var(--red)}.cc-val.wait{color:var(--yellow)}
.tbl{width:100%;border-collapse:collapse;font-size:11px}
.tbl th{padding:8px 10px;text-align:left;color:var(--t3);font-weight:500;
  border-bottom:1px solid var(--b);font-size:9px;letter-spacing:1px;text-transform:uppercase}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--b);font-family:var(--mono)}
.tbl tr:hover td{background:var(--s2)}
.badge{font-size:9px;padding:2px 7px;border-radius:3px}
.bs{background:rgba(16,185,129,.12);color:var(--green)}
.bf{background:rgba(239,68,68,.12);color:var(--red)}
.bp{background:rgba(245,158,11,.12);color:var(--yellow)}
.tr-panel{background:var(--s2);border:1px solid var(--blue);border-radius:8px;padding:22px}
.tr-title{font-size:14px;font-weight:700;color:var(--bluel);letter-spacing:.5px;margin-bottom:4px}
.tr-sub{font-size:11px;color:var(--t2);margin-bottom:18px}
.avail{font-size:24px;font-weight:700;font-family:var(--mono);color:var(--green);margin-bottom:16px}
.inp{width:100%;background:var(--s1);border:1px solid var(--b);border-radius:6px;
  padding:11px 14px;color:var(--t1);font-size:15px;font-family:var(--mono);
  outline:none;transition:.2s;margin-bottom:10px}
.inp:focus{border-color:var(--blue);box-shadow:0 0 0 2px var(--blueg)}
.qrow{display:flex;gap:6px;margin-bottom:12px}
.q{flex:1;padding:8px;background:var(--s1);border:1px solid var(--b);
  border-radius:5px;color:var(--t2);font-size:11px;cursor:pointer;transition:.15s}
.q:hover{border-color:var(--blue);color:var(--bluel)}
.btn{width:100%;padding:13px;background:var(--blue);border:none;
  border-radius:6px;color:#fff;font-size:13px;font-weight:700;
  cursor:pointer;transition:.15s;letter-spacing:1px;text-transform:uppercase}
.btn:hover{background:var(--bluel)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-sm{width:auto;padding:9px 18px;font-size:11px}
.toggle-row{display:flex;align-items:center;justify-content:space-between;
  padding:14px;background:var(--s1);border:1px solid var(--b);border-radius:6px;margin-bottom:14px}
.toggle-label{font-size:12px;font-weight:600}
.toggle-sub{font-size:10px;color:var(--t2);margin-top:2px}
.toggle{width:44px;height:24px;background:var(--b);border:none;border-radius:12px;
  cursor:pointer;position:relative;transition:.2s}
.toggle.on{background:var(--blue)}
.toggle::after{content:'';position:absolute;width:18px;height:18px;background:#fff;
  border-radius:9px;top:3px;left:3px;transition:.2s}
.toggle.on::after{left:23px}
.msg{padding:10px 14px;border-radius:6px;font-size:12px;margin-top:8px;display:none}
.msg.ok{background:rgba(16,185,129,.1);color:var(--green);display:block}
.msg.er{background:rgba(239,68,68,.1);color:var(--red);display:block}
.mn{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--s1);
  border-top:1px solid var(--b);padding:8px 0 env(safe-area-inset-bottom);z-index:100}
.mn .tabs{display:flex}
.mn .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;
  padding:8px;cursor:pointer;color:var(--t3);font-size:9px;font-weight:500;
  background:none;border:none;letter-spacing:.5px}
.mn .tab.on{color:var(--blue)}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-thumb{background:var(--b);border-radius:2px}
@media(max-width:768px){
  .layout{grid-template-columns:1fr}
  .sidebar{display:none}.mn{display:block}
  .main{padding:14px;padding-bottom:72px}
  .g4,.g3{grid-template-columns:repeat(2,1fr)}
  .g2{grid-template-columns:1fr}
  .chain-grid{grid-template-columns:repeat(2,1fr)}
  .rev-bar{gap:14px}.rd{display:none}
}
</style></head><body>
<div class="layout">
<aside class="sidebar">
  <div class="logo-wrap">
    <div class="logo">X7 PROTOCOL</div>
    <div class="logo-sub">LIQUIDATION ENGINE</div>
  </div>
  <nav>
    <div class="ni on" onclick="go('overview')">OVERVIEW</div>
    <div class="ni" onclick="go('executions')">EXECUTIONS</div>
    <div class="ni" onclick="go('treasury')">TREASURY</div>
    <div class="ni" onclick="go('system')">SYSTEM</div>
  </nav>
  <div class="sb-foot">
    <div style="font-size:10px;color:var(--t3)">
      <span class="live-dot"></span>LIVE
    </div>
  </div>
</aside>

<main class="main">

<div class="page on" id="p-overview">
  <div class="ph"><div class="pt">OVERVIEW</div><div class="ps">Real-time liquidation engine — all chains</div></div>
  <div class="rev-bar">
    <div class="rv"><div class="rl">ALL TIME</div><div class="rv-val" id="t-total">$0.00</div></div>
    <div class="rd"></div>
    <div class="rv"><div class="rl">TODAY</div><div class="rv-val" id="t-today">$0.00</div></div>
    <div class="rd"></div>
    <div class="rv"><div class="rl">ETH PRICE</div><div class="rv-val blue" id="t-eth">—</div></div>
    <div class="rd"></div>
    <div class="rv"><div class="rl">BORROWERS</div><div class="rv-val blue" id="t-borrow">0</div></div>
  </div>
  <div class="chain-grid" id="chain-grid"></div>
  <div class="g2">
    <div class="card">
      <div class="ct">LIVE EXECUTION FEED</div>
      <div class="feed" id="feed">
        <div style="color:var(--t3);font-size:11px;padding:20px;text-align:center">
          Scanning for liquidatable positions
        </div>
      </div>
    </div>
    <div class="card">
      <div class="ct">APEX INTELLIGENCE</div>
      <div id="apex-insight" style="font-size:13px;color:var(--bluel);line-height:1.7;margin-bottom:12px">
        Initializing
      </div>
      <div class="ct" style="margin-top:12px">MARKET PRICES</div>
      <div id="prices-grid"></div>
    </div>
  </div>
</div>

<div class="page" id="p-executions">
  <div class="ph"><div class="pt">EXECUTIONS</div><div class="ps">All liquidation history</div></div>
  <div class="g3" style="margin-bottom:16px">
    <div class="card sm"><div class="ct">TOTAL</div><div class="cv" id="e-total">0</div></div>
    <div class="card sm"><div class="ct">WIN RATE</div><div class="cv g" id="e-wr">0%</div></div>
    <div class="card sm"><div class="ct">TOTAL PROFIT</div><div class="cv g" id="e-profit">$0</div></div>
  </div>
  <div class="card">
    <div class="ct">EXECUTION LOG</div>
    <div style="overflow-x:auto">
      <table class="tbl">
        <thead><tr><th>CHAIN</th><th>PROTOCOL</th><th>BORROWER</th><th>PROFIT</th><th>STATUS</th><th>TIME</th></tr></thead>
        <tbody id="exec-body"></tbody>
      </table>
    </div>
  </div>
</div>

<div class="page" id="p-treasury">
  <div class="ph"><div class="pt">TREASURY</div><div class="ps">Revenue management and Wave withdrawal</div></div>
  <div class="g2">
    <div>
      <div class="card" style="margin-bottom:14px">
        <div class="ct">REVENUE BREAKDOWN</div>
        <div class="cv g" id="tr-total">$0.00</div>
        <div class="cs">all time</div>
        <div style="margin-top:14px" id="tr-chains"></div>
      </div>
      <div class="card">
        <div class="ct">YIELD DEPLOYED</div>
        <div id="tr-yield" style="font-size:12px;color:var(--t2)">Loading</div>
      </div>
    </div>
    <div class="tr-panel">
      <div class="tr-title">WITHDRAWAL</div>
      <div class="tr-sub">Transfer USDC to Wave — arrives in GMD</div>
      <div class="toggle-row">
        <div>
          <div class="toggle-label">AUTO PARTIAL</div>
          <div class="toggle-sub">Withdraw 30% every $500 earned</div>
        </div>
        <button class="toggle" id="auto-toggle" onclick="toggleAuto()"></button>
      </div>
      <div class="avail">AVAILABLE: <span id="wd-avail">$0.00</span></div>
      <input class="inp" type="number" id="wd-amt" placeholder="Amount (USDC)" min="1" step="0.01">
      <div class="qrow">
        <button class="q" onclick="pct(25)">25%</button>
        <button class="q" onclick="pct(50)">50%</button>
        <button class="q" onclick="pct(75)">75%</button>
        <button class="q" onclick="pct(100)">MAX</button>
      </div>
      <button class="btn" id="wd-btn" onclick="doWithdraw()">WITHDRAW TO WAVE</button>
      <div style="font-size:10px;color:var(--t3);margin-top:8px">
        Modem Pay relay — Wave Mobile Money — GMD — estimated 5-10 minutes
      </div>
      <div class="msg" id="wd-msg"></div>
      <div style="margin-top:14px" id="wd-hist"></div>
    </div>
  </div>
</div>

<div class="page" id="p-system">
  <div class="ph"><div class="pt">SYSTEM</div><div class="ps">Runtime metrics and configuration</div></div>
  <div class="g4" style="margin-bottom:16px">
    <div class="card sm"><div class="ct">UPTIME</div><div class="cv b" id="sys-up">0m</div></div>
    <div class="card sm"><div class="ct">MEMORY</div><div class="cv b" id="sys-mem">0 MB</div></div>
    <div class="card sm"><div class="ct">DB STATUS</div><div class="cv g" id="sys-db">—</div></div>
    <div class="card sm"><div class="ct">EXECUTOR</div><div class="cv" id="sys-exec" style="font-size:11px">—</div></div>
  </div>
  <div class="g2">
    <div class="card">
      <div class="ct">CONTRACT ADDRESSES</div>
      <div id="sys-contracts" style="font-size:11px;font-family:var(--mono);color:var(--t2)"></div>
    </div>
    <div class="card">
      <div class="ct">WIN RATES</div>
      <div id="sys-wr" style="font-size:12px"></div>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <div class="ct">APEX LOG</div>
    <div style="max-height:250px;overflow-y:auto" id="sys-log"></div>
  </div>
</div>

</main>
</div>

<div class="mn">
  <div class="tabs">
    <button class="tab on" onclick="go('overview')">OVERVIEW</button>
    <button class="tab" onclick="go('executions')">EXECUTE</button>
    <button class="tab" onclick="go('treasury')">TREASURY</button>
    <button class="tab" onclick="go('system')">SYSTEM</button>
  </div>
</div>

<script>
let _avail=0, _auto=false
const ws = (() => {
  const p = location.protocol==='https:'?'wss:':'ws:'
  const s = new WebSocket(p+'//'+location.host)
  s.onmessage = e => {
    try {
      const {type,data} = JSON.parse(e.data)
      if (type==='tick') { set('t-total',fmt(data.revenue)); set('t-today',fmt(data.today)) }
      if (type==='withdrawal') showMsg('Transfer sent to Wave','ok')
      if (type==='auto_withdraw_toggle') { _auto=data.enabled; renderToggle() }
    } catch {}
  }
  s.onclose = () => setTimeout(()=>location.reload(),4000)
  return s
})()

function go(id) {
  document.querySelectorAll('.page,.ni,.tab').forEach(el => el.classList.remove('on'))
  document.getElementById('p-'+id)?.classList.add('on')
  document.querySelectorAll(`[onclick="go('${id}')"]`).forEach(el=>el.classList.add('on'))
  load(id)
}
async function api(p) { try{return await(await fetch(p)).json()}catch{return null} }
function fmt(n) {
  const v=parseFloat(n)||0
  if(v>=1e6) return '$'+(v/1e6).toFixed(2)+'M'
  if(v>=1e3) return '$'+(v/1e3).toFixed(1)+'K'
  return '$'+v.toFixed(2)
}
function ago(ts){
  const s=Math.floor((Date.now()-ts*1000)/1000)
  if(s<60) return s+'s'
  if(s<3600) return Math.floor(s/60)+'m'
  return Math.floor(s/3600)+'h'
}
function set(id,v){const e=document.getElementById(id);if(e)e.textContent=v}
function renderToggle(){
  const t=document.getElementById('auto-toggle')
  if(t){t.className='toggle'+(_auto?' on':'');t.title=_auto?'ON':'OFF'}
}

async function load(page) {
  if(page==='overview')   await loadOV()
  if(page==='executions') await loadEX()
  if(page==='treasury')   await loadTR()
  if(page==='system')     await loadSY()
}

async function loadOV() {
  const d = await api('/api/overview'); if(!d||d.initializing) return
  set('t-total', fmt(d.totalRevenue)); set('t-today', fmt(d.todayRevenue))
  set('t-borrow', (d.borrowers||0).toLocaleString())
  const p = d.prices||{}
  set('t-eth', p.ETH?'$'+Number(p.ETH).toLocaleString():'—')
  _auto = d.autoWithdraw; renderToggle()

  const cg = document.getElementById('chain-grid')
  if(cg && d.chains) {
    cg.innerHTML = Object.entries(d.chains).map(([c,info])=>{
      const ws = info.ws||'starting'
      const ct = info.contract||'deploying'
      const wsSt = ws==='connected'?'ok':ws==='reconnecting'?'wait':'no'
      const ctSt = ct&&ct!=='deploying'&&ct!=='failed'?'ok':ct==='failed'?'no':'wait'
      return `<div class="cc">
        <div class="cc-name">${c.toUpperCase()}</div>
        <div class="cc-row"><span class="cc-label">WEBSOCKET</span><span class="cc-val ${wsSt}">${ws}</span></div>
        <div class="cc-row"><span class="cc-label">CONTRACT</span><span class="cc-val ${ctSt}">${ct&&ct.length>10?ct.slice(0,8)+'...':ct}</span></div>
        <div class="cc-row"><span class="cc-label">WIN RATE</span><span class="cc-val">${(parseFloat(info.wr_aave||0.4)*100).toFixed(0)}%</span></div>
        <div class="cc-row"><span class="cc-label">YIELD</span><span class="cc-val ok">$${parseFloat(info.yield||0).toFixed(0)}</span></div>
      </div>`
    }).join('')
  }

  const fe = document.getElementById('feed')
  if(fe && d.recentExecutions?.length>0) {
    fe.innerHTML = d.recentExecutions.map(e=>`
      <div class="fi ${e.status==='success'?'ok':'fail'}">
        <span class="fc">${(e.chain||'?').toUpperCase().slice(0,3)}</span>
        <span style="color:var(--t2)">${e.protocol||'aave'}</span>
        <span style="color:var(--t3)">${e.borrower?e.borrower.slice(0,10)+'...':''}</span>
        <span class="fprof ${e.profit_usdc>0?'':'z'}">${e.profit_usdc>0?'+'+fmt(e.profit_usdc):e.status}</span>
      </div>`).join('')
  }

  set('apex-insight', d.apex?.insight||'Scanning')
  const pg = document.getElementById('prices-grid')
  if(pg) pg.innerHTML = Object.entries(p)
    .filter(([k])=>['ETH','BTC','MATIC','LINK'].includes(k))
    .map(([k,v])=>`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid var(--b)">
      <span style="color:var(--t3)">${k}</span>
      <span style="font-family:var(--mono)">$${Number(v).toLocaleString()}</span>
    </div>`).join('')
}

async function loadEX() {
  const d=await api('/api/executions'); if(!d) return
  set('e-total', d.stats?.total||0)
  set('e-wr',    d.stats?.winRate||'0%')
  set('e-profit',fmt(d.stats?.profit))
  const tb=document.getElementById('exec-body')
  if(tb) tb.innerHTML=(d.executions||[]).map(e=>`<tr>
    <td><span class="fc">${(e.chain||'?').toUpperCase().slice(0,3)}</span></td>
    <td style="color:var(--t2)">${e.protocol||'aave'}</td>
    <td style="color:var(--t3)">${e.borrower?e.borrower.slice(0,14)+'...':'—'}</td>
    <td style="color:var(--green)">${fmt(e.profit_usdc)}</td>
    <td><span class="badge b${e.status==='success'?'s':e.status==='failed'?'f':'p'}">${e.status}</span></td>
    <td style="color:var(--t3)">${e.created_at?ago(e.created_at):'—'}</td>
  </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;color:var(--t3);padding:20px">No executions yet</td></tr>'
}

async function loadTR() {
  const d=await api('/api/treasury'); if(!d) return
  _avail=d.totalRevenue||0; _auto=d.autoWithdraw; renderToggle()
  set('tr-total',fmt(d.totalRevenue)); set('wd-avail',fmt(d.totalRevenue))
  const ce=document.getElementById('tr-chains')
  if(ce) ce.innerHTML=Object.entries(d.byChain||{}).map(([c,v])=>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid var(--b)">
      <span style="color:var(--t3)">${c.toUpperCase()}</span>
      <span style="font-family:var(--mono);color:var(--green)">${fmt(v)}</span>
    </div>`).join('')
  const ye=document.getElementById('tr-yield')
  if(ye) ye.innerHTML='<div style="font-size:11px;color:var(--t2)">Aave supply active on Polygon, Arbitrum, Base</div>'
  const he=document.getElementById('wd-hist')
  if(he && d.withdrawals?.length) {
    he.innerHTML='<div style="font-size:9px;color:var(--t3);margin-bottom:8px;letter-spacing:1px">RECENT WITHDRAWALS</div>'+
      d.withdrawals.slice(0,4).map(w=>`
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--b);font-size:11px">
          <span style="font-family:var(--mono)">${fmt(w.usdc_amount)}</span>
          <span style="color:var(--t3)">GMD ${(w.gmd_amount||0).toLocaleString()}</span>
          <span class="badge b${w.status==='completed'?'s':w.status==='failed'?'f':'p'}">${w.status}</span>
        </div>`).join('')
  }
}

async function loadSY() {
  const d=await api('/api/system'); if(!d||d.initializing) return
  set('sys-up', Math.floor((d.uptime||0)/60)+'m')
  set('sys-mem', (d.memory||'0MB'))
  set('sys-db',  d.dbReady?'READY':'INIT')
  set('sys-exec',d.executor?d.executor.slice(0,16)+'...':'not set')
  const ce=document.getElementById('sys-contracts')
  if(ce) ce.innerHTML=Object.entries(d.contracts||{}).map(([c,a])=>
    `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--b)">
      <span style="color:var(--t3)">${c.toUpperCase()}</span>
      <span>${a&&a.length>10?a.slice(0,14)+'...':a||'—'}</span>
    </div>`).join('')
  const wre=document.getElementById('sys-wr')
  if(wre) {
    const chains=['polygon','arbitrum','ethereum','base']
    wre.innerHTML=chains.map(c=>`
      <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--b);font-size:11px">
        <span style="color:var(--t3)">${c.toUpperCase()}</span>
        <div style="display:flex;gap:10px">
          ${['aave','compound','morpho'].map(p=>
            `<span style="font-family:var(--mono)">${p[0].toUpperCase()}: ${(parseFloat(d[c+'_wr_'+p]||0.4)*100).toFixed(0)}%</span>`
          ).join('')}
        </div>
      </div>`).join('')
  }
  const le=document.getElementById('sys-log')
  if(le) le.innerHTML=(d.apexLog||[]).map(l=>
    `<div style="padding:6px 10px;border-bottom:1px solid var(--b);font-size:10px;font-family:var(--mono);color:var(--t2)">
      <span style="color:var(--bluel)">[${(l.subsystem||'apex').toUpperCase()}]</span>
      ${l.action||''} ${l.result?'→ '+String(l.result).slice(0,50):''}
    </div>`).join('')||'<div style="padding:10px;font-size:10px;color:var(--t3)">Initializing</div>'
}

function pct(p){
  const e=document.getElementById('wd-amt')
  if(e) e.value=(_avail*p/100).toFixed(2)
}
async function toggleAuto(){
  const r=await fetch('/api/toggle-auto-withdraw',{method:'POST'})
  const d=await r.json()
  _auto=d.autoWithdraw; renderToggle()
}
async function doWithdraw(){
  const amt=parseFloat(document.getElementById('wd-amt')?.value)
  const btn=document.getElementById('wd-btn')
  if(!amt||amt<=0){showMsg('Enter valid amount','er');return}
  btn.disabled=true;btn.textContent='SENDING...'
  document.getElementById('wd-msg').className='msg'
  try{
    const r=await fetch('/api/withdraw',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:amt})})
    const d=await r.json()
    if(d.success){showMsg('Transfer sent — arrives via Wave in 5-10 minutes','ok');document.getElementById('wd-amt').value='';setTimeout(loadTR,2000)}
    else showMsg(d.error||'Transfer failed','er')
  }catch(e){showMsg(e.message,'er')}
  finally{btn.disabled=false;btn.textContent='WITHDRAW TO WAVE'}
}
function showMsg(txt,cls){const e=document.getElementById('wd-msg');if(e){e.textContent=txt;e.className='msg '+cls}}
setInterval(()=>load(document.querySelector('.page.on')?.id?.slice(2)||'overview'),10000)
setInterval(async()=>{
  const d=await api('/api/overview')
  if(d&&!d.initializing){set('t-total',fmt(d.totalRevenue));set('t-today',fmt(d.todayRevenue))}
},5000)
loadOV()
</script></body></html>`

app.get('*', (_,res) => {
  res.setHeader('Content-Type','text/html')
  res.send(HTML)
})

export function startDashboard() {
  const PORT = parseInt(process.env.PORT)||3000
  server.listen(PORT, '0.0.0.0', () =>
    console.log(`[DASHBOARD] Live on port ${PORT}`)
  )
  setInterval(async () => {
    try {
      const { getTotalRevenue:tr, getTodayRevenue:td } = await import('./db.js')
      broadcast('tick', { revenue: tr(), today: td(), ts: Date.now() })
    } catch {}
  }, 5000)
  return server
}
