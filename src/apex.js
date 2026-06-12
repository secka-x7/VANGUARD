import { getConfig, setConfig, logApex, getTotalRevenue, getTodayRevenue } from './db.js'

let _client = null
let _last   = { priorityChain:'polygon', insight:'Initializing.', action:'Start scanners' }

export async function getDirection() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || key.length < 20) return _last
  try {
    if (!_client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      _client = new Anthropic({ apiKey: key })
    }
    const r = await _client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 150,
      messages: [{ role:'user', content:
        `X7 liquidation bot. Revenue: $${getTotalRevenue().toFixed(0)} total. ` +
        `Market: ${getConfig('market_volatility')||'moderate'}. ` +
        `Polygon WR: ${getConfig('wr_polygon_aave')||'0.4'}. ` +
        `Arbitrum WR: ${getConfig('wr_arbitrum_aave')||'0.4'}. ` +
        `Reply ONLY JSON: {"priorityChain":"polygon","insight":"one sentence","action":"one action"}`
      }]
    })
    const m = r.content[0].text.match(/\{[\s\S]*\}/)
    if (m) {
      _last = JSON.parse(m[0])
      setConfig('apex_insight', _last.insight)
      setConfig('apex_action',  _last.action)
      logApex('brain','direction',_last)
    }
  } catch {}
  return _last
}

export async function startApex() {
  setInterval(async () => {
    try {
      await getDirection()
      // Fetch prices
      const r = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin,matic-network,chainlink&vs_currencies=usd'
      )
      const d = await r.json()
      setConfig('prices', JSON.stringify({
        ETH: d['ethereum']?.usd||3000, BTC: d['bitcoin']?.usd||60000,
        MATIC: d['matic-network']?.usd||0.8, LINK: d['chainlink']?.usd||15,
        USDC:1, DAI:1, USDT:1, WBTC: d['bitcoin']?.usd||60000
      }))
    } catch {}
  }, 60000)
  await getDirection().catch(()=>{})
  console.log('[APEX] Started')
}
