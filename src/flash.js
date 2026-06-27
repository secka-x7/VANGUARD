// Unified flash loan router: Balancer(0%) → UniV3(0%) → Aave(0.09%) → MakerDAO(0.05%)
// Selects optimal source per opportunity. Self-heals if source unavailable.
import { getChain } from './chains.js'

// Flash source priority per chain
const SOURCES = {
  ethereum:  ['balancer','univ3','aave','maker'],
  arbitrum:  ['balancer','univ3','aave'],
  polygon:   ['balancer','univ3','aave'],
  base:      ['balancer','univ3','aave'],
  optimism:  ['balancer','univ3','aave'],
  avalanche: ['balancer','univ3','aave'],
  bnb:       ['pancake','univ3'],
  scroll:    ['aave','univ3'],
  default:   ['univ3','balancer'],
}

// Flash addresses
const MAKER_FLASH  = '0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA'  // MakerDAO flash mint
const MAKER_DAI    = '0x6B175474E89094C44Da98b954EedeAC495271d0F'

export function getFlashSources(chainName) {
  return SOURCES[chainName] || SOURCES.default
}

// Build flash loan calldata selector for X7.sol
export function selectFlashSource(chainName, tokenAddr, amount) {
  const chain   = getChain(chainName)
  const sources = getFlashSources(chainName)
  
  for (const src of sources) {
    if (src === 'balancer' && chain?.flash && chain.flash !== chain.aave) {
      return { source: 'balancer', addr: chain.flash, fee: 0n }
    }
    if (src === 'aave' && chain?.aave) {
      return { source: 'aave', addr: chain.aave, fee: 9n } // 0.09% in bps/10
    }
    if (src === 'maker' && tokenAddr === MAKER_DAI) {
      return { source: 'maker', addr: MAKER_FLASH, fee: 5n } // 0.05%
    }
    if (src === 'univ3') {
      return { source: 'univ3', addr: chain?.router || '0x', fee: 5n } // pool fee varies
    }
    if (src === 'pancake' && chainName === 'bnb') {
      return { source: 'pancake', addr: chain?.flash || '0x', fee: 1n }
    }
  }
  return null
}

export const flashFee = (source, amount) => {
  const fees = { balancer:0n, univ3:0n, maker:5n, aave:9n, pancake:1n }
  return amount * (fees[source]||9n) / 10000n
}
