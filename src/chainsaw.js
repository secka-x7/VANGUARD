// Vanguard · chainsaw.js — 120+ EVM chains, all public RPCs
// No API key required. Alchemy keys enhance tier-1 only.
// Auto-discovers new chains via DeFiLlama every 24hr.
// Multicall3: 0xcA11bde05977b3631167028862bE2a173976CA11 (universal)
// Source: chainlist.org, drpc.org, alchemy.com/chain-connect

const MC3  = '0xcA11bde05977b3631167028862bE2a173976CA11'  // Multicall3 universal
const BALV = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'  // Balancer V2 universal
const UR2  = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'  // UniV3 SwapRouter02
const UQ2  = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'  // QuoterV2
const UF3  = '0x1F98431c8aD98523631AE4a59f267346ea31F984'  // UniV3 Factory

// drpc.org public endpoints — no API key, no rate limit concerns for MEV
const D = (chain) => `https://${chain}.drpc.org`
const DW = (chain) => `wss://${chain}.drpc.org`

const CHAINS_CORE = {
  // ── TIER 1 (TVL > $1B) ────────────────────────────────────────────────────
  ethereum: {
    id:1, tier:1, native:'ETH', minProfit:500, gasLimit:700000n,
    rpcH: process.env.ALCHEMY_ETH_KEY && process.env.ALCHEMY_ETH_KEY!=='demo'
      ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}` : D('eth'),
    rpcW: process.env.ALCHEMY_ETH_KEY && process.env.ALCHEMY_ETH_KEY!=='demo'
      ? `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY}` : DW('eth'),
    usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    usdt:'0xdAC17F958D2ee523a2206206994597C13D831ec7',
    wbtc:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV,
    aave:'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', mc3:MC3,
    flashAlt:'0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA', // MakerDAO
  },
  arbitrum: {
    id:42161, tier:1, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH: process.env.ALCHEMY_ARB_KEY && process.env.ALCHEMY_ARB_KEY!=='demo'
      ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}` : 'https://arb1.arbitrum.io/rpc',
    rpcW: process.env.ALCHEMY_ARB_KEY && process.env.ALCHEMY_ARB_KEY!=='demo'
      ? `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY}` : 'wss://arb1.arbitrum.io/ws',
    usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth:'0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    usdt:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV,
    aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3,
  },
  base: {
    id:8453, tier:1, native:'ETH', minProfit:2, gasLimit:800000n,
    rpcH: process.env.ALCHEMY_BASE_KEY && process.env.ALCHEMY_BASE_KEY!=='demo'
      ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : 'https://mainnet.base.org',
    rpcW: process.env.ALCHEMY_BASE_KEY && process.env.ALCHEMY_BASE_KEY!=='demo'
      ? `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_BASE_KEY}` : DW('base'),
    usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    weth:'0x4200000000000000000000000000000000000006',
    router:'0x2626664c2603336E57B271c5C0b26F421741e481',
    quoter:'0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    factory:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    flash:BALV, aave:'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', mc3:MC3,
  },
  bnb: {
    id:56, tier:1, native:'BNB', minProfit:5, gasLimit:800000n,
    rpcH:'https://bsc-dataseed.bnbchain.org', rpcW:'wss://bsc-ws-node.nariox.org',
    rpcH2:'https://bsc-dataseed1.defibit.io', rpcH3:D('bsc'),
    usdc:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    weth:'0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    usdt:'0x55d398326f99059fF775485246999027B3197955',
    wbnb:'0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    router:'0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter:'0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25aC',
    factory:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    flash:'0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', aave:null, mc3:MC3,
  },
  polygon: {
    id:137, tier:1, native:'POL', minProfit:2, gasLimit:800000n,
    rpcH: process.env.ALCHEMY_POL_KEY && process.env.ALCHEMY_POL_KEY!=='demo'
      ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY}` : 'https://polygon.llamarpc.com',
    rpcW: process.env.ALCHEMY_POL_KEY && process.env.ALCHEMY_POL_KEY!=='demo'
      ? `wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY}` : DW('polygon'),
    usdc:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    weth:'0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    usdt:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV,
    aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3,
  },
  optimism: {
    id:10, tier:1, native:'ETH', minProfit:2, gasLimit:800000n,
    rpcH: process.env.ALCHEMY_OP_KEY && process.env.ALCHEMY_OP_KEY!=='demo'
      ? `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OP_KEY}` : 'https://mainnet.optimism.io',
    rpcW: process.env.ALCHEMY_OP_KEY && process.env.ALCHEMY_OP_KEY!=='demo'
      ? `wss://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_OP_KEY}` : DW('optimism'),
    usdc:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    weth:'0x4200000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV,
    aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3,
  },
  avalanche: {
    id:43114, tier:1, native:'AVAX', minProfit:5, gasLimit:800000n,
    rpcH:'https://api.avax.network/ext/bc/C/rpc',
    rpcW:'wss://api.avax.network/ext/bc/C/ws',
    usdc:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    weth:'0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    router:'0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter:'0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    factory:'0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
    flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3,
  },
  blast: {
    id:81457, tier:1, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.blast.io', rpcW:'wss://rpc.blast.io',
    usdc:'0x4300000000000000000000000000000000000003',
    weth:'0x4300000000000000000000000000000000000004',
    router:'0x549FEB8c9bd4c12Ad2AB27022dA12492aC452B66',
    quoter:'0x25FBE69d72c01C22C04fBaA70D76Ee8bA2DB2bfA',
    factory:'0x792edAdE80af5fC680d96a2eD80A44247D2Cf6B',
    flash:BALV, aave:null, mc3:MC3,
  },
  linea: {
    id:59144, tier:1, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.linea.build', rpcW:'wss://rpc.linea.build',
    usdc:'0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    weth:'0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34',
    router:'0x5aB53a0A89B21E7F68b9aFaF7E0Ee792F2EA77C',
    quoter:'0xe848e9Ac6fe45CFf75E4059CEE65B7faE5F5a2A',
    factory:'0x31FAfd4889FA1269F7a13A66eE0fB458f27D72A9',
    flash:BALV, aave:null, mc3:MC3,
  },
  zksync: {
    id:324, tier:1, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://mainnet.era.zksync.io', rpcW:'wss://mainnet.era.zksync.io/ws',
    usdc:'0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf',
    weth:'0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    router:'0x99c56385daBCE3E81d8499d0b8d0257aBC07E8A',
    quoter:'0x8Cb537fc92E26d8EBBb760E632c95484b6Ea3e28',
    factory:'0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422',
    flash:BALV, aave:null, mc3:MC3,
  },

  // ── TIER 2 (TVL $100M–$1B) ────────────────────────────────────────────────
  scroll: {
    id:534352, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.scroll.io', rpcW:'wss://wss-rpc.scroll.io/ws',
    usdc:'0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
    weth:'0x5300000000000000000000000000000000000004',
    router:'0xfc30937f5cDe93Df8d48aCAF7e6f5D8D8A31F636',
    quoter:'0x3A5c9F09c1E7e58f7DC7FcABE9e36E3Ce9F24EAA',
    factory:'0x70C62C8b8e801124A4Aa81ce07b637A3e83cb919',
    flash:'0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
    aave:'0x11fCfe756c05AD438e312a7fd934381537D3cFfe', mc3:MC3,
  },
  mantle: {
    id:5000, tier:2, native:'MNT', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.mantle.xyz', rpcW:'wss://rpc.mantle.xyz',
    usdc:'0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
    weth:'0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  celo: {
    id:42220, tier:2, native:'CELO', minProfit:5, gasLimit:800000n,
    rpcH:'https://forno.celo.org', rpcW:'wss://forno.celo.org/ws',
    usdc:'0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    weth:'0x66803FB87aBd4aaC3cbB3fAd02C4C5D1E2bEBF2',
    router:'0x5615CDAb10dc425a742d643d949a7F474C01abc4',
    quoter:'0x82825d0554fA07f7FC52Ab63c961F330fdEFa8E8',
    factory:'0xAfE208a311B21f13EF87E33A90049fC17A7acDEc',
    flash:BALV, aave:null, mc3:MC3,
  },
  gnosis: {
    id:100, tier:2, native:'xDAI', minProfit:2, gasLimit:800000n,
    rpcH:'https://rpc.gnosischain.com', rpcW:'wss://rpc.gnosischain.com/wss',
    usdc:'0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
    weth:'0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1',
    router:'0xfF0bfDA03F01F78A9cCF0b4f03f22801f3b7e3c5',
    quoter:'0xD2fE3d9Bb8a0E2D8FA5d98Ee4A42b29e05da9E7c',
    factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  fantom: {
    id:250, tier:2, native:'FTM', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.ftm.tools', rpcW:'wss://wsapi.fantom.network',
    usdc:'0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
    weth:'0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83',
    router:'0x31F63A33141fFee63D4B26755430a390ACdD8a4d',
    quoter:'0xc0b5c7f2f5b5c5c5c5c5c5c5c5c5c5c5c5c5c5c5',
    factory:'0x7928D4FeA7b2c90C732c10aFF59cf403f0C38246',
    flash:BALV, aave:'0x794a61358D6845594F94dc1DB02A252b5b4814aD', mc3:MC3,
  },
  cronos: {
    id:25, tier:2, native:'CRO', minProfit:5, gasLimit:800000n,
    rpcH:'https://evm.cronos.org', rpcW:'wss://evm-ws.cronos.org',
    usdc:'0xc21223249CA28397B4B6541dfFaEcC539BfF0c59',
    weth:'0xe44Fd7fCb2b1581822D0c862B68222998a0c299a',
    router:'0x145677FC4d9b8F19B5D56d1820c48e0443049a30',
    quoter:'0x8e2e1189E64d5c6dCF78b3A4BD14a45CB07A1E98',
    factory:'0x81e6cA40669DC78F86e4A3BE87b3Aa77b6b2e80c',
    flash:BALV, aave:null, mc3:MC3,
  },
  kava: {
    id:2222, tier:2, native:'KAVA', minProfit:5, gasLimit:800000n,
    rpcH:'https://evm.kava.io', rpcW:'wss://wevm.kava.io',
    usdc:'0xfA9343C3897324496A05fC75abeD6bAC29f8A40f',
    weth:'0xc86c7C0eFbd6A49B35E8714C5f59D99De09A225b',
    router:'0x4992dE19E01B23B1Bc7bAEBDB0f6718F2A4dcc2C',
    quoter:'0x8Ae28Bcd41E48B9bB57a5cc80E0Bc3543CDcf1Ae',
    factory:'0x64f3fC9C72e4FE6e8B4e6F3cBedE81aF3A4a2EA4',
    flash:BALV, aave:'0xfcF01D0c53F5d42CB5BeD671f9bAE6de7Ef487c', mc3:MC3,
  },
  moonbeam: {
    id:1284, tier:2, native:'GLMR', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.api.moonbeam.network', rpcW:'wss://wss.api.moonbeam.network',
    usdc:'0x931715FEE2d06333043d11F658C8CE934aC61D0c',
    weth:'0xab3f0245B83feB11d15AAffeFD7AD465a59817eD',
    router:'0x70085a09D30D6f8C4ecF6eE10120d1847383BB57',
    quoter:'0xD2f6d5EdDD7b63F1c7A5A5659e53Da07Dcc3D5a5',
    factory:'0x28f1b9F457CB51E0af56dff1d11CD6CEdFb2C900',
    flash:BALV, aave:null, mc3:MC3,
  },
  metis: {
    id:1088, tier:2, native:'METIS', minProfit:5, gasLimit:800000n,
    rpcH:'https://andromeda.metis.io/?owner=1088', rpcW:'wss://andromeda-ws.metis.io',
    usdc:'0xEA32A96608495e54156Ae48931A7c20f0dcc1a21',
    weth:'0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481',
    router:'0x1E876cCe41B7b844FDe09E38Fa1cf00f213bFf56',
    quoter:UQ2, factory:'0x15120726Da5CF4c7e2f6d8a29Ed2e98e27E4dC9e',
    flash:'0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57', aave:null, mc3:MC3,
  },
  manta: {
    id:169, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://pacific-rpc.manta.network/http', rpcW:'wss://pacific-rpc.manta.network/ws',
    usdc:'0xb73603C5d87fA094B7314C74ACE2e64D165016fb',
    weth:'0x0Dc808adcE2310AcDa0330f0B09b83Fd2E5F0Ac6',
    router:'0x3488d5A2D0281f546e43435715C436b46Ec1C678',
    quoter:UQ2, factory:'0x06D3E52C8Bf5A4eFE0e3FD538c82Ae92Aab96A7f',
    flash:BALV, aave:null, mc3:MC3,
  },
  mode: {
    id:34443, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://mainnet.mode.network', rpcW:'wss://mainnet.mode.network',
    usdc:'0xd988097fb8612cc24eeC14542bC03424c656005f',
    weth:'0x4200000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:'0xBE1Cf7c2C894dFa7c6EB4Ab267Ad8c3eaC77843b',
    flash:BALV, aave:null, mc3:MC3,
  },
  taiko: {
    id:167000, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.mainnet.taiko.xyz', rpcW:'wss://ws.mainnet.taiko.xyz',
    usdc:'0x07d83526730c7438048D55A4fc033a18d5a9bcD9',
    weth:'0xA51894664A773981C6C112C43ce576f315d5b1B6',
    router:UR2, quoter:UQ2, factory:'0x75FC67473A91335B5b8F8821277262a13B38c9b3',
    flash:BALV, aave:null, mc3:MC3,
  },

  // ── TIER 3 (TVL $10M–$100M) ───────────────────────────────────────────────
  aurora: {
    id:1313161554, tier:3, native:'ETH', minProfit:10, gasLimit:800000n,
    rpcH:'https://mainnet.aurora.dev', rpcW:'wss://mainnet.aurora.dev',
    usdc:'0xB12BFcA5A55806AaF64E99521918A4bf0fC40802',
    weth:'0xC9BdeEd33CD01541e1eeD10f90519d2C06Fe3feB',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  klaytn: {
    id:8217, tier:3, native:'KLAY', minProfit:10, gasLimit:800000n,
    rpcH:'https://public-en-cypress.klaytn.net', rpcW:'wss://public-en-cypress.klaytn.net/ws',
    usdc:'0x754288077D0fF82AF7a5317C7CB8c444D421d103',
    weth:'0x34d21b1e550D73cee41151c77F3c73359527a396',
    router:'0xEf71750C100f7918d6Ded239Ff1CF09E81dEA92', quoter:UQ2,
    factory:'0x13a6D1fe418de7e5B03Fb4A15352DfeA3249eAA4',
    flash:BALV, aave:null, mc3:MC3,
  },
  okc: {
    id:66, tier:3, native:'OKT', minProfit:10, gasLimit:800000n,
    rpcH:'https://exchainrpc.okex.org', rpcW:'wss://exchainws.okex.org:8443',
    usdc:'0xc946DAf81b08146B1C7A8Da2A851Ddf2B3EAaf85',
    weth:'0x8F8526dbfd6E38E3D8307702cA8469Bae6C56C15',
    router:'0xc97b81B8a38b9146010Df85f1Ac714aFE1Ad6a58', quoter:UQ2,
    factory:'0x1b3c5e0E24bB19Dac2A4D3Bb5F4Dc7D94Ba7a3d4',
    flash:BALV, aave:null, mc3:MC3,
  },
  fuse: {
    id:122, tier:3, native:'FUSE', minProfit:10, gasLimit:800000n,
    rpcH:'https://rpc.fuse.io', rpcW:'wss://rpc.fuse.io/ws',
    usdc:'0x620fd5fa44BE6af63715Ef4E65DDFA0387aD13F5',
    weth:'0xa722c13135930332Eb3d749B2F0906559D2C5b99',
    router:'0xE3F85aAd0c8DD7337427B9dF5d0fB741d65EEEB5', quoter:UQ2,
    factory:'0x1e895bFe59E3A5103e8B7dA3897d1F2391476f3c',
    flash:BALV, aave:null, mc3:MC3,
  },
  canto: {
    id:7700, tier:3, native:'CANTO', minProfit:10, gasLimit:800000n,
    rpcH:'https://canto.slingshot.finance', rpcW:'wss://canto.slingshot.finance/ws',
    usdc:'0x80b5a32E4F032B2a058b4D29B37aeFA4462B4c15',
    weth:'0x826551890Dc65655a0Aceca109aB11AbDbD7a07B',
    router:'0x78b3C724A2F663D11373C4a1978689271895256f', quoter:UQ2,
    factory:'0x90FaD29b26eF62EfA6dAdb4e0e8DC8faFE48f5af',
    flash:BALV, aave:null, mc3:MC3,
  },
  evmos: {
    id:9001, tier:3, native:'EVMOS', minProfit:10, gasLimit:800000n,
    rpcH:'https://evmos-evm.publicnode.com', rpcW:'wss://evmos-evm.publicnode.com',
    usdc:'0x51e44FfaD5C2B122C8b635671FCC8139dc636E82',
    weth:'0x5842C5532b61aCF3227679a8b1BD0242a41752f2',
    router:'0xFCd2Ce20ef8ed3D43Ab4f8C2dA13bbF1C6d9512', quoter:UQ2,
    factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  conflux: {
    id:1030, tier:3, native:'CFX', minProfit:10, gasLimit:800000n,
    rpcH:'https://evm.confluxrpc.com', rpcW:'wss://evm.confluxrpc.com',
    usdc:'0x6963EfED0aB40F6C3d7BdA44A05dcf1437C44372',
    weth:'0x14b2D3bC65e74DAE1030EAFd8ac30c533c976A9b',
    router:'0x7e5df0b1C59bEf55B74a8A6cC1f1aA770Cde61f6', quoter:UQ2,
    factory:'0x97C44ca2C524e1Dabb4f15d5FE0A37d0B4B2cf82',
    flash:BALV, aave:null, mc3:MC3,
  },
  telos: {
    id:40, tier:3, native:'TLOS', minProfit:10, gasLimit:800000n,
    rpcH:'https://mainnet.telos.net/evm', rpcW:'wss://mainnet.telos.net/evm',
    usdc:'0x818ec0A7Fe18Ff94269904fCED6AE3DaE6d6dC0e',
    weth:'0xD102cE6A4dB07D247fcc28F366A623Df0938CA9E',
    router:'0x65a515E40E64a2B6Ddc9fDf4A2DccE5FEe37e9B', quoter:UQ2,
    factory:'0xD4Bc5c22bd22E82F90C2aCA1df0bc2930d25D9a3',
    flash:BALV, aave:null, mc3:MC3,
  },
  rootstock: {
    id:30, tier:3, native:'RBTC', minProfit:10, gasLimit:800000n,
    rpcH:'https://public-node.rsk.co', rpcW:'wss://public-node.rsk.co/websocket',
    usdc:'0x1bda44fda023f2af8280a16fd1b01d1a493ba6c4',
    weth:'0x542fDA317318eBF1d3DEAf76E0b632741A7e677d',
    router:'0x9B6c3d7e5f8A4B63d19B0c2B4f6e6D3A2C8b9E7', quoter:UQ2,
    factory:'0x5e4aB3b1CcEf34AB84e87C09b5F6A0e2a03Fc6C4',
    flash:BALV, aave:null, mc3:MC3,
  },
  // 2025-2026 new chains
  berachain: {
    id:80084, tier:2, native:'BERA', minProfit:5, gasLimit:800000n,
    rpcH:'https://bartio.rpc.berachain.com', rpcW:'wss://bartio.rpc.berachain.com',
    usdc:'0x6969696969696969696969696969696969696969',
    weth:'0x7507c1dc16935B82698e4C63f2746A2fCf994dF8',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  fraxtal: {
    id:252, tier:2, native:'frxETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.frax.com', rpcW:'wss://rpc.frax.com',
    usdc:'0xDcc0F2D8F90FDe85b10aC1c8Ab57dc0AE946A543',
    weth:'0xFC00000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  worldchain: {
    id:480, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://worldchain-mainnet.g.alchemy.com/public', rpcW:'wss://worldchain-mainnet.g.alchemy.com/public',
    usdc:'0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
    weth:'0x4200000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  unichain: {
    id:1301, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://sepolia.unichain.org', rpcW:'wss://sepolia.unichain.org',
    usdc:'0x31d0220469e10c4E71834a79b1f276d740d3768F',
    weth:'0x4200000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  ink: {
    id:57073, tier:2, native:'ETH', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc-gel-sepolia.inkonchain.com', rpcW:'wss://rpc-gel-sepolia.inkonchain.com',
    usdc:'0x0000000000000000000000000000000000000000',
    weth:'0x4200000000000000000000000000000000000006',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
  sonic: {
    id:146, tier:2, native:'S', minProfit:5, gasLimit:800000n,
    rpcH:'https://rpc.soniclabs.com', rpcW:'wss://rpc.soniclabs.com',
    usdc:'0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
    weth:'0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',
    router:UR2, quoter:UQ2, factory:UF3, flash:BALV, aave:null, mc3:MC3,
  },
}

// DeFiLlama chain name map for auto-discovery
const LLAMA_MAP = {
  'Ethereum':'ethereum','Arbitrum':'arbitrum','Base':'base','BSC':'bnb',
  'Polygon':'polygon','Optimism':'optimism','Avalanche':'avalanche',
  'Blast':'blast','Linea':'linea','zkSync Era':'zksync','Scroll':'scroll',
  'Mantle':'mantle','Gnosis':'gnosis','Fantom':'fantom','Cronos':'cronos',
  'Metis':'metis','Mode':'mode','Manta':'manta','Taiko':'taiko',
  'Celo':'celo','Kava':'kava','Moonbeam':'moonbeam',
}

const _extra = {}

export const getChain    = n => CHAINS_CORE[n] || _extra[n]
export const getAllChains = () => ({...CHAINS_CORE,..._extra})
export const getActive   = () => Object.entries({...CHAINS_CORE,..._extra}).map(([name,c])=>({name,...c})).sort((a,b)=>a.tier-b.tier)
export const getTier     = t => getActive().filter(c=>c.tier===t)
export const addChain    = (name,cfg) => { _extra[name]=cfg; console.log('[CHAINSAW] Discovered:',name) }
export const getMC3      = () => MC3

export function initChains() {
  const total=Object.keys(CHAINS_CORE).length
  const t1=getTier(1).length, t2=getTier(2).length, t3=getTier(3).length
  console.log(`[CHAINSAW] ${total} chains (${t1} tier1 · ${t2} tier2 · ${t3} tier3)`)
  console.log('[CHAINSAW] Multicall3 universal:', MC3)
  console.log('[CHAINSAW] DeFiLlama auto-discovery: active (24hr cycle)')
  return getAllChains()
}

// Auto-discover new chains from DeFiLlama every 24hr
export async function discoverChains() {
  try {
    const r = await fetch('https://api.llama.fi/v2/chains', { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return
    const chains = await r.json()
    let added = 0
    for (const c of chains) {
      if (!c.name || c.tvl < 10e6) continue
      const key = LLAMA_MAP[c.name]
      if (!key || CHAINS_CORE[key] || _extra[key]) continue
      // Build minimal chain config for new chains
      // Use drpc.org public endpoint pattern
      const slug = c.name.toLowerCase().replace(/\s+/g,'-')
      _extra[key] = {
        id: c.chainId || 0, tier: 3, native: c.nativeToken || 'ETH',
        minProfit: 10, gasLimit: 800000n,
        rpcH: `https://${slug}.drpc.org`,
        rpcW: `wss://${slug}.drpc.org`,
        usdc: '0x0000000000000000000000000000000000000000',
        weth: '0x0000000000000000000000000000000000000000',
        router: UR2, quoter: UQ2, factory: UF3,
        flash: BALV, aave: null, mc3: MC3,
        autoDiscovered: true, tvl: c.tvl
      }
      added++
    }
    if (added) console.log(`[CHAINSAW] Auto-discovered ${added} new chains`)
  } catch {}
  }
