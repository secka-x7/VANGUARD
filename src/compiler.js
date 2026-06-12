import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const require  = createRequire(import.meta.url)
const __dir    = dirname(fileURLToPath(import.meta.url))
let   _cached  = null

export async function compile() {
  if (_cached) return _cached
  const solc    = require('solc')
  const source  = readFileSync(join(__dir, '../contracts/X7.sol'), 'utf8')
  const input   = {
    language: 'Solidity',
    sources:  { 'X7.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 },
                outputSelection: { '*': { '*': ['abi','evm.bytecode.object'] } } }
  }
  const out  = JSON.parse(solc.compile(JSON.stringify(input)))
  const errs = (out.errors||[]).filter(e => e.severity==='error')
  if (errs.length) { console.error('[COMPILE]', errs[0].message); return null }
  const c    = out.contracts['X7.sol']['X7']
  _cached    = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }
  console.log('[COMPILE] X7.sol compiled successfully')
  return _cached
}
