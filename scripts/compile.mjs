// Compile Solidity sources with solc-js. Used by the deploy script and the tests.
//   node scripts/compile.mjs   → contracts/DroughtCover.json (ABI + bytecode)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import solc from 'solc'

export function compile(sources) {
  const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    // evmVersion pinned to match the in-browser EVM (src/evm.js) and public testnets.
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'))
  return Object.fromEntries(Object.values(out.contracts).flatMap((file) => Object.entries(file))
    .map(([name, c]) => [name, { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }]))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { DroughtCover } = compile({ 'DroughtCover.sol': readFileSync('contracts/DroughtCover.sol', 'utf8') })
  writeFileSync('contracts/DroughtCover.json', JSON.stringify({ compiler: solc.version(), ...DroughtCover }, null, 1))
  console.log(`compiled DroughtCover with solc ${solc.version()} (${(DroughtCover.bytecode.length - 2) / 2} bytes)`)
}
