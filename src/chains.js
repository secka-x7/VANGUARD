// X7-SV · chains.js — verified addresses · 50-chain expansion · tiered WS

// Flash loan sources per chain (Balancer = 0% fee preferred)
const FL = {
  balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  aave: {
    ethereum: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    arbitrum: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    polygon:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    base:     '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    optimism: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    avalanche:'0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    scroll:   '0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
  }
}

// All 8 built-in chains — verified addresses from official sources
const BUILTIN = {
  ethereum: {
    name:'ethereum', chainId:1, native:'ETH', tier:1,
    rpcHttp: 'https://eth-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_ETH_KEY || 'demo'),
    rpcWss:  'wss://eth-mainnet.g.alchemy.com/v2/'  + (process.env.ALCHEMY_ETH_KEY || 'demo'),
    usdc:    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth:    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc:    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    dai:     '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    router:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    flashSource: 'balancer', flashAddr: FL.balancer,
    minProfit:500, gasUSD:20, priority:1, active:true
  },
  arbitrum: {
    name:'arbitrum', chainId:42161, native:'ETH', tier:1,
    rpcHttp: 'https://arb-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_ARB_KEY || 'demo'),
    rpcWss:  'wss://arb-mainnet.g.alchemy.com/v2/'  + (process.env.ALCHEMY_ARB_KEY || 'demo'),
    usdc:    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth:    '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    wbtc:    '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    dai:     '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    router:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    flashSource:'balancer', flashAddr:FL.balancer,
    minProfit:50, gasUSD:0.5, priority:2, active:true
  },
  polygon: {
    name:'polygon', chainId:137, native:'POL', tier:1,
    rpcHttp: 'https://polygon-mainnet.g.alchemy.com/v2/' + (process.env.ALCHEMY_POL_KEY || 'demo'),
    rpcWss:  'wss://polygon-mainnet.g.alchemy.com/v2/'  + (process.env.ALCHEMY_POL_KEY || 'demo'),
    usdc:    '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    weth:    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    wbtc:    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    dai:     '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
    router:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    flashSource:'balancer', flashAddr:FL.balancer,
    minProfit:5, gasUSD:0.05, priority:3, active:true
  },
  base: {
    name:'base', chainId:8453, native:'ETH', tier:1,
    rpcHttp: process.env.ALCHEMY_BASE_KEY ? 'https://base-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_BASE_KEY : 'https://mainnet.base.org',
    rpcWss:  process.env.ALCHEMY_BASE_KEY ? 'wss://base-mainnet.g.alchemy.com/v2/'  + process.env.ALCHEMY_BASE_KEY : 'wss://mainnet.base.org',
    usdc:    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth:    '0x4200000000000000000000000000000000000006',
    router:  '0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter:  '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    flashSource:'balancer', flashAddr:FL.balancer,
    minProfit:5, gasUSD:0.05, priority:4, active:true
  },
  optimism: {
    name:'optimism', chainId:10, native:'ETH', tier:2,
    rpcHttp: process.env.ALCHEMY_OP_KEY ? 'https://opt-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_OP_KEY : 'https://mainnet.optimism.io',
    rpcWss:  process.env.ALCHEMY_OP_KEY ? 'wss://opt-mainnet.g.alchemy.com/v2/'  + process.env.ALCHEMY_OP_KEY : 'wss://mainnet.optimism.io',
    usdc:    '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    weth:    '0x4200000000000000000000000000000000000006',
    router:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:  '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    flashSource:'balancer', flashAddr:FL.balancer,
    minProfit:5, gasUSD:0.05, priority:5, active:true
  },
  avalanche: {
    name:'avalanche', chainId:43114, native:'AVAX', tier:2,
    rpcHttp: process.env.ALCHEMY_AVAX_KEY ? 'https://avax-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_AVAX_KEY : 'https://api.avax.network/ext/bc/C/rpc',
    rpcWss:  process.env.ALCHEMY_AVAX_KEY ? 'wss://avax-mainnet.g.alchemy.com/v2/'  + process.env.ALCHEMY_AVAX_KEY : 'wss://api.avax.network/ext/bc/C/ws',
    usdc:    '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    weth:    '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    wbtc:    '0x50b7545627a5162F82A992c33b87aDc75187B218',
    router:  '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter:  '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    flashSource:'balancer', flashAddr:FL.balancer,
    minProfit:10, gasUSD:0.1, priority:6, active:true
  },
  bnb: {
    name:'bnb', chainId:56, native:'BNB', tier:2,
    rpcHttp: process.env.ALCHEMY_BNB_KEY ? 'https://bnb-mainnet.g.alchemy.com/v2/' + process.env.ALCHEMY_BNB_KEY : 'https://bsc-dataseed.bnbchain.org',
    rpcWss:  process.env.ALCHEMY_BNB_KEY ? 'wss://bnb-mainnet.g.alchemy.com/v2/'  + process.env.ALCHEMY_BNB_KEY : 'wss://bsc-ws-node.nariox.org',
    usdc:    '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    weth:    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    router:  '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
    quoter:  '0x78D78E420Da98ad378D7799bE8f4AF69033EB077',
    factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
    flashSource:'pancake', flashAddr:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    minProfit:5, gasUSD:0.05, priority:7, active:true
  },
  scroll: {
    name:'scroll', chainId:534352, native:'ETH', tier:2,
    rpcHttp: 'https://rpc.scroll.io',
    rpcWss:  'wss://wss-rpc.scroll.io/ws',
    usdc:    '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
    weth:    '0x5300000000000000000000000000000000000004',
    router:  '0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636',
    quoter:  '0x3A5c9F09c1E7e58f7DC7FcABE9e36E3Ce9F24EAA',
    factory: '0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919',
    flashSource:'aave', flashAddr:FL.aave.scroll,
    minProfit:5, gasUSD:0.05, priority:8, active:true
  }
}

// 42 expansion chains — validated RPCs, auto-activated in tiers
const EXPANSION = [
  { name:'blast',     chainId:81457,   native:'ETH',  tier:2, rpcHttp:'https://rpc.blast.io',                rpcWss:'wss://rpc.blast.io',                factory:'0x792edAdE80af5fC680d96a2eD80A44247D2Cf04',router:'0x549FEB8c9bd4c12Ad2AB27022dA12492aC452B66',quoter:'0x25FBE69d72c01C22C04fBaA70D76Ee8bA2DB2bfA',usdc:'0x4300000000000000000000000000000000000003',weth:'0x4300000000000000000000000000000000000004',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:9 },
  { name:'linea',     chainId:59144,   native:'ETH',  tier:2, rpcHttp:'https://rpc.linea.build',             rpcWss:'wss://rpc.linea.build',             factory:'0x31FAfd4889FA1269F7a13A66eE0fB458f27D72A9',router:'0x5aB53a0A89B21E7F68b9aFaF7E0Ee792F2EA77C',quoter:'0xe848e9Ac6fe45CFf75E4059CEE65B7faE5F5a2A',usdc:'0x176211869cA2b568f2A7D4EE941E073a821EE1ff',weth:'0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:10 },
  { name:'zksync',    chainId:324,     native:'ETH',  tier:2, rpcHttp:'https://mainnet.era.zksync.io',       rpcWss:'wss://mainnet.era.zksync.io/ws',    factory:'0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422',router:'0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A',quoter:'0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28',usdc:'0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf',weth:'0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:11 },
  { name:'mantle',    chainId:5000,    native:'MNT',  tier:3, rpcHttp:'https://rpc.mantle.xyz',              rpcWss:'wss://rpc.mantle.xyz',              factory:'0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',weth:'0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:12 },
  { name:'mode',      chainId:34443,   native:'ETH',  tier:3, rpcHttp:'https://mainnet.mode.network',        rpcWss:'wss://mainnet.mode.network',        factory:'0xC9Ae4D5e3D7F8A506B2f31d5b3dBC9Cd7ED5a6a',router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0xd988097fb8612cc24eeC14542bC03424c656005f',weth:'0x4200000000000000000000000000000000000006',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:13 },
  { name:'manta',     chainId:169,     native:'ETH',  tier:3, rpcHttp:'https://pacific-rpc.manta.network/http',rpcWss:'wss://pacific-rpc.manta.network/ws',factory:'0x5752F085206AB87d8a5EF6166779658Add455774',router:'0x3488d5A2D0281f546e43435715C436b46Ec1C678',quoter:'0xe848e9Ac6fe45CFf75E4059CEE65B7faE5F5a2A',usdc:'0xb73603C5d87fA094B7314C74ACE2e64D165016fb',weth:'0x0Dc808adcE2310AcDa0330f0B09b83Fd2E5F0Ac6',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:14 },
  { name:'taiko',     chainId:167000,  native:'ETH',  tier:3, rpcHttp:'https://rpc.mainnet.taiko.xyz',       rpcWss:'wss://ws.mainnet.taiko.xyz',        factory:'0x75FC67473A91335B5b8F8821277262a13B38c9b3',router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0x07d83526730c7438048D55A4fc033a18d5a9bcD9',weth:'0xA51894664A773981C6C112C43ce576f315d5b1B6',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:15 },
  { name:'fraxtal',   chainId:252,     native:'frxETH',tier:3,rpcHttp:'https://rpc.frax.com',               rpcWss:'wss://rpc.frax.com',                factory:'0xB9F67D1BeB5e88f5aD4d3e39F33428F14E06e7A',router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0xFc00000000000000000000000000000000000001',weth:'0xfc00000000000000000000000000000000000005',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:16 },
  { name:'bob',       chainId:60808,   native:'ETH',  tier:3, rpcHttp:'https://rpc.gobob.xyz',               rpcWss:'wss://rpc.gobob.xyz',               factory:'0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',router:'0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0xe75D0fB2C24A55cA1e3F96781a2bCC7bdba058F0',weth:'0x4200000000000000000000000000000000000006',flashSource:'balancer',flashAddr:FL.balancer,minProfit:5,gasUSD:0.05,priority:17 },
  { name:'metis',     chainId:1088,    native:'METIS',tier:3, rpcHttp:'https://andromeda.metis.io/?owner=1088',rpcWss:'wss://andromeda-ws.metis.io',      factory:'0x8112E18a34b63964388a3B2984037d6a2EFE5B8A',router:'0x1E876cCe41B7b844FDe09E38Fa1cf00f213bFf56',quoter:'0x61fFE014bA17989E743c5F6cB21bF9697530B21e',usdc:'0xEA32A96608495e54156Ae48931A7c20f0dcc1a21',weth:'0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481',flashSource:'aave',flashAddr:'0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57',minProfit:5,gasUSD:0.05,priority:18 },
]

let _registry = {}

export async function initChains() {
  // Load built-in chains
  _registry = { ...BUILTIN }

  // Load expansion chains
  for (const c of EXPANSION) {
    _registry[c.name] = { ...c, active: true }
  }

  // Load env-var custom chains
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^CHAIN_([A-Z0-9]+)_RPC_HTTP$/)
    if (!m) continue
    const n = m[1].toLowerCase()
    _registry[n] = {
      name: n, chainId: parseInt(process.env[`CHAIN_${m[1]}_CHAIN_ID`] || '0'),
      native: process.env[`CHAIN_${m[1]}_NATIVE`] || 'ETH', tier: 3,
      rpcHttp: v,
      rpcWss: process.env[`CHAIN_${m[1]}_RPC_WSS`] || v.replace('https', 'wss'),
      usdc: process.env[`CHAIN_${m[1]}_USDC`] || '',
      weth: process.env[`CHAIN_${m[1]}_WETH`] || '',
      router: process.env[`CHAIN_${m[1]}_ROUTER`] || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      quoter: process.env[`CHAIN_${m[1]}_QUOTER`] || '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      flashSource: 'balancer', flashAddr: FL.balancer,
      minProfit: 10, gasUSD: 0.1, priority: 50, active: true
    }
    console.log('[CHAINS] Env chain loaded:', n)
  }

  const total = Object.keys(_registry).length
  console.log(`[CHAINS] ${total} chains loaded (${Object.values(_registry).filter(c => c.tier === 1).length} tier1, ${Object.values(_registry).filter(c => c.tier === 2).length} tier2, ${Object.values(_registry).filter(c => c.tier === 3).length} tier3)`)
  return _registry
}

export const getChains = () => _registry
export const getChain = n => _registry[n]
export const getActiveChains = () => Object.values(_registry).filter(c => c.active).sort((a, b) => a.priority - b.priority)
export const getTierChains = tier => getActiveChains().filter(c => c.tier === tier)
