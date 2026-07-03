// Compiles Vanguard.sol with viaIR: true
// viaIR fixes "stack too deep" on crossPoolArb (10 params)
import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __dir   = dirname(fileURLToPath(import.meta.url))
let _artifact = null

export async function compile() {
  if (_artifact) return _artifact
  const solPath = join(__dir, '../contracts/Vanguard.sol')
  if (!existsSync(solPath)) { console.error('[COMPILER] Vanguard.sol not found'); return null }
  try {
    const solc = require('solc')
    const out  = JSON.parse(solc.compile(JSON.stringify({
      language: 'Solidity',
      sources:  { 'Vanguard.sol': { content: readFileSync(solPath,'utf8') } },
      settings: {
        outputSelection: { '*': { '*': ['abi','evm.bytecode.object'] } },
        optimizer: { enabled: true, runs: 200 },
        viaIR: true
      }
    })))
    const errs = (out.errors||[]).filter(e=>e.severity==='error')
    if (errs.length) { errs.forEach(e=>console.error('[COMPILER]',e.formattedMessage?.slice(0,200))); return null }
    const c = out.contracts['Vanguard.sol']['Vanguard']
    _artifact = { abi: c.abi, bytecode: '0x'+c.evm.bytecode.object }
    console.log('[COMPILER] Vanguard.sol compiled —', Math.round(_artifact.bytecode.length/2), 'bytes · viaIR ✓')
    return _artifact
  } catch(e) { console.error('[COMPILER] Failed:', e.message?.slice(0,150)); return null }
}

export const getArtifact = () => _artifact
