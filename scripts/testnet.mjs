// Runs Proof of Drought on a public test network (Ethereum Sepolia by default), so anyone can see it on a block explorer.
//
//   node scripts/testnet.mjs deploy [reason] deploys DroughtCover with three oracle wallets and a few demo policies
//                                            (a previous deployment is kept on record as replaced, with the reason)
//   node scripts/testnet.mjs seal            seals this season's forecast and pre-season readings on the record, timestamped
//   node scripts/testnet.mjs report <stage>  each oracle posts its record's reading for the 2026–27 season (early | final)
//
// Keys come from the environment or from .env.testnet (never committed; see .gitignore):
//   DEPLOYER_KEY  a wallet holding test ETH from a faucet (it becomes the insurer and pays everyone's gas)
//   ERA5_KEY, POWER_KEY, CHIRPS_KEY  the three oracles (created by `deploy` if missing, and saved to .env.testnet)
//   RPC_URL       optional, defaults to a public Sepolia endpoint
// Results (addresses, transaction links) are written to public/data/testnet.json, which the website shows.
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import solc from 'solc'
import { DISTRICTS } from './districts.mjs'
import { district as track, SEASON_START } from '../src/now.js'

const ENV = '.env.testnet', OUT = 'public/data/testnet.json', INPUTS = 'public/data/sealed-inputs.json'
if (existsSync(ENV)) for (const line of readFileSync(ENV, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(\S+)/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2] }
const RPC = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 })
const { chainId } = await provider.getNetwork()
const NET = { 11155111n: { name: 'Ethereum Sepolia (test network)', explorer: 'https://sepolia.etherscan.io' }, 84532n: { name: 'Base Sepolia (test network)', explorer: 'https://sepolia.basescan.org' } }[chainId] ?? { name: `chain ${chainId}`, explorer: '' }
const need = (k) => { if (!process.env[k]) { console.error(`Missing ${k}: put it in ${ENV} or the environment.`); process.exit(1) } return process.env[k] }
const ART = JSON.parse(readFileSync('contracts/DroughtCover.json', 'utf8'))
const state = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { sealed: [], reports: [] }
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 1))
const tx = (hash) => (NET.explorer ? `${NET.explorer}/tx/${hash}` : hash)
const sha = (x) => '0x' + createHash('sha256').update(JSON.stringify(x)).digest('hex')
const pm = (x) => Math.round(x * 1000)
const cmd = process.argv[2]

if (cmd === 'deploy') {
  const insurer = new ethers.Wallet(need('DEPLOYER_KEY'), provider)
  console.log(`${NET.name}: insurer ${insurer.address}, balance ${ethers.formatEther(await provider.getBalance(insurer.address))} ETH`)
  // A new deployment replaces the old one; the old one stays on record, with why it was replaced.
  if (state.address) {
    state.previous = [...(state.previous ?? []), { address: state.address, contract: state.contract, deployed: state.deployed, sealed: state.sealed.length,
      replaced: new Date().toISOString(), reason: process.argv.slice(3).join(' ') || 'replaced' }]
    state.sealed = [], state.reports = []
  }
  const oracles = {}
  for (const k of ['ERA5_KEY', 'POWER_KEY', 'CHIRPS_KEY']) {
    if (!process.env[k]) { process.env[k] = ethers.Wallet.createRandom().privateKey; appendFileSync(ENV, `${k}=${process.env[k]}\n`) }
    oracles[k] = new ethers.Wallet(process.env[k], provider)
  }
  const c = await new ethers.ContractFactory(ART.abi, ART.bytecode, insurer).deploy(oracles.ERA5_KEY.address, oracles.POWER_KEY.address, oracles.CHIRPS_KEY.address)
  await c.waitForDeployment()
  const address = await c.getAddress()
  console.log(`DroughtCover at ${address}`)
  // Gas money for each oracle, a small pool, and one demo policy per district (test ETH stands in for Fiji dollars).
  for (const w of Object.values(oracles)) if ((await provider.getBalance(w.address)) < ethers.parseEther('0.002')) await (await insurer.sendTransaction({ to: w.address, value: ethers.parseEther('0.004') })).wait()
  await (await insurer.sendTransaction({ to: address, value: ethers.parseEther('0.002') })).wait()
  for (let d = 0; d < DISTRICTS.length; d++) await (await c.issue(ethers.Wallet.createRandom().address, d, ethers.parseEther('0.0002'))).wait()
  Object.assign(state, { network: NET.name, chainId: Number(chainId), explorer: NET.explorer, address, contract: NET.explorer ? `${NET.explorer}/address/${address}` : address,
    deployed: new Date().toISOString(), deployTx: tx(c.deploymentTransaction().hash),
    oracles: { era5: oracles.ERA5_KEY.address, power: oracles.POWER_KEY.address, chirps: oracles.CHIRPS_KEY.address },
    constructorArgs: ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address'], [oracles.ERA5_KEY.address, oracles.POWER_KEY.address, oracles.CHIRPS_KEY.address]).slice(2),
    compiler: `v${solc.version().replace('.Emscripten.clang', '')}` })
  save()
  // What Etherscan's "Verify and Publish" (Solidity, Standard-Json-Input) needs: the exact compiler input.
  writeFileSync('contracts/DroughtCover.standard-input.json', JSON.stringify({ language: 'Solidity', sources: { 'DroughtCover.sol': { content: readFileSync('contracts/DroughtCover.sol', 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }, null, 1))
  console.log(`Etherscan verification: contracts/DroughtCover.standard-input.json, compiler ${state.compiler}, constructor arguments:\n${state.constructorArgs}`)
  console.log(`saved ${OUT}. Oracle keys are in ${ENV} (keep it private).`)
} else if (cmd === 'seal') {
  if (!state.address) throw new Error('deploy first')
  const insurer = new ethers.Wallet(need('DEPLOYER_KEY'), provider)
  const W = { era5: new ethers.Wallet(need('ERA5_KEY'), provider), power: new ethers.Wallet(need('POWER_KEY'), provider) }
  const c = new ethers.Contract(state.address, ART.abi, provider)
  const FC = JSON.parse(readFileSync('data/forecast.json', 'utf8')), NOW = JSON.parse(readFileSync('public/data/now.json', 'utf8'))
  const what = (s) => ethers.encodeBytes32String(s)
  const inputs = { forecast: null, preSeason: {} }
  // The forecast: the chance each district pays this season, and the fingerprint of the model's inputs and weights.
  const modelInputs = { weights: FC.weights, cap: FC.cap, nino: FC.now.nino, months: FC.now.months }, model = sha(modelInputs)
  inputs.forecast = modelInputs
  for (let d = 0; d < DISTRICTS.length; d++) {
    const r = await (await c.connect(insurer).seal(what('forecast'), FC.now.season, d, pm(FC.now.districts[d].chance), model)).wait()
    state.sealed.push({ what: 'forecast', season: FC.now.season, district: DISTRICTS[d].key, value: FC.now.districts[d].chance, dataHash: model, tx: tx(r.hash), at: new Date().toISOString() })
    console.log(`forecast ${DISTRICTS[d].name}: ${Math.round(FC.now.districts[d].chance * 100)}%  ${r.hash}`)
  }
  // Pre-season readings, 1 September to the latest day: each oracle seals its own record's dryness and data fingerprint.
  for (let d = 0; d < DISTRICTS.length; d++) {
    const n = NOW.districts[DISTRICTS[d].key], got = track({ era5: n.era5.snapshot, power: n.power.snapshot }, n, 0)
    for (const src of ['era5', 'power']) {
      const rows = n[src].snapshot.slice(0, got.to)
      ;(inputs.preSeason[DISTRICTS[d].key] ??= {})[src] = rows
      const r = await (await c.connect(W[src]).seal(what(`pre-season ${src}`), NOW.season, d, pm(got[src].dryness), sha(rows))).wait()
      state.sealed.push({ what: `pre-season ${src}`, season: NOW.season, district: DISTRICTS[d].key, value: +got[src].dryness.toFixed(3), upTo: rows.at(-1)[0], dataHash: sha(rows), tx: tx(r.hash), at: new Date().toISOString() })
      console.log(`pre-season ${src} ${DISTRICTS[d].name}: ${pm(got[src].dryness)}  ${r.hash}`)
    }
  }
  save()
  writeFileSync(INPUTS, JSON.stringify(inputs))
} else if (cmd === 'report') {
  const stage = process.argv[3]
  if (!['early', 'final'].includes(stage) || !state.address) throw new Error('usage: report early|final (after deploy)')
  const IDX = JSON.parse(readFileSync('data/index.json', 'utf8')), season = IDX.seasons.find((s) => s.season === 2027)?.[stage]
  if (!season) throw new Error(`No ${stage} readings for 2026–27 in data/index.json yet: run npm run data:climate, node scripts/fetch-chirps.mjs and npm run data:index once the window has closed.`)
  const GUARD = JSON.parse(readFileSync('data/guard.json', 'utf8'))
  const W = { era5: new ethers.Wallet(need('ERA5_KEY'), provider), power: new ethers.Wallet(need('POWER_KEY'), provider), chirps: process.env.CHIRPS_KEY && new ethers.Wallet(process.env.CHIRPS_KEY, provider) }
  const c = new ethers.Contract(state.address, ART.abi, provider)
  for (const r of season) {
    const d = DISTRICTS.findIndex((x) => x.key === r.district)
    for (const src of ['era5', 'power', 'chirps']) {
      const s = r.sources[src]
      if (!s || !W[src] || state.reports.some((x) => x.stage === stage && x.district === r.district && x.src === src)) continue
      const verdict = src === 'chirps' ? 0 : Math.min(65535, Math.round((GUARD.scores[stage]['2027']?.[d]?.[src === 'era5' ? 0 : 1] ?? 0) * 1000))
      const rc = await (await c.connect(W[src]).report(2027, stage === 'early' ? 0 : 1, d, pm(s.dryness), verdict, s.hash)).wait()
      state.reports.push({ stage, district: r.district, src, dryness: s.dryness, dataHash: s.hash, tx: tx(rc.hash), at: new Date().toISOString() })
      console.log(`${stage} ${src} ${r.district}: ${pm(s.dryness)}  ${rc.hash}`)
    }
  }
  save()
} else {
  console.log('usage: node scripts/testnet.mjs deploy | seal | report early|final')
}
