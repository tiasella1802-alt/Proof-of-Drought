// Tries to break DroughtCover's rules on a fresh deployment. Needs the local chain: npm run chain
//   node scripts/test-contract.mjs
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { compile } from './compile.mjs'
import { local } from './chain-config.mjs'

const { DroughtCover, Refuser } = compile({
  'DroughtCover.sol': readFileSync('contracts/DroughtCover.sol', 'utf8'),
  // A farmer "wallet" that rejects every transfer, to check it can't block the rest of the district.
  'Refuser.sol': 'pragma solidity ^0.8.24; contract Refuser { receive() external payable { revert("no"); } function pull(address c) external { (bool ok,) = c.call(abi.encodeWithSignature("withdraw()")); require(ok); } }',
})
const { provider, insurer, era5, power, stranger } = local()
const EARLY = 0, FINAL = 1, LAUTOKA = 0, BA = 2, LABASA = 6
const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s)), eth = (n) => ethers.parseEther(String(n))

const c = await new ethers.ContractFactory(DroughtCover.abi, DroughtCover.bytecode, insurer).deploy(era5.address, power.address)
await c.waitForDeployment()
await (await insurer.sendTransaction({ to: await c.getAddress(), value: eth(20) })).wait()
const as = (s) => c.connect(s)
const farmers = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().address)
for (const f of farmers.slice(0, 3)) await (await c.issue(f, LAUTOKA, eth(1))).wait()
await (await c.issue(farmers[3], BA, eth(2))).wait()
const bal = (a) => provider.getBalance(a)
const events = (rc, name) => rc.logs.map((l) => { try { return c.interface.parseLog(l) } catch {} }).filter((e) => e?.name === name)

let fails = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`) } catch (e) { fails++; console.log(`  FAIL  ${name}\n        ${e.shortMessage || e.message}`) }
}
async function reverts(p, error) {
  try { await (await p).wait() } catch (e) {
    let got = e.revert?.name
    try { got ??= c.interface.parseError(e.data ?? e.info?.error?.data)?.name } catch {}
    if (got === error) return
    throw new Error(`reverted with ${got ?? e.shortMessage}, wanted ${error}`)
  }
  throw new Error(`did not revert, wanted ${error}`)
}

console.log('DroughtCover rules')
await check('only the insurer issues policies', () => reverts(as(stranger).issue(stranger.address, 0, 1), 'NotInsurer'))
await check('only the two oracles can report', () => reverts(as(stranger).report(1998, EARLY, LAUTOKA, 50, h('x')), 'NotOracle'))
await check('a reading needs its data fingerprint', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 50, ethers.ZeroHash), 'BadReading'))
await check('one oracle alone cannot trigger a payout', async () => {
  const before = await bal(farmers[0])
  await (await as(era5).report(1998, EARLY, LAUTOKA, 60, h('era5 jan'))).wait()
  if ((await bal(farmers[0])) !== before) throw new Error('paid on one source')
})
await check('an oracle cannot report twice', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 10, h('again')), 'AlreadyReported'))
await check('second source agrees: early 30% paid to every farmer in the district at once', async () => {
  const rc = await (await as(power).report(1998, EARLY, LAUTOKA, 80, h('power jan'))).wait()
  const paid = events(rc, 'Paid')
  if (paid.length !== 3) throw new Error(`${paid.length} paid`)
  for (const f of farmers.slice(0, 3)) if ((await bal(f)) !== eth(0.3)) throw new Error('wrong amount')
  if ((await bal(farmers[3])) !== 0n) throw new Error('paid another district')
})
await check('a settled checkpoint cannot be reported again', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 5, h('late')), 'AlreadySettled'))
await check('final checkpoint pays the rest (100% total, not 130%)', async () => {
  await (await as(era5).report(1998, FINAL, LAUTOKA, 30, h('era5 apr'))).wait()
  await (await as(power).report(1998, FINAL, LAUTOKA, 30, h('power apr'))).wait()
  for (const f of farmers.slice(0, 3)) if ((await bal(f)) !== eth(1)) throw new Error(`balance ${ethers.formatEther(await bal(f))}`)
})
await check('sources disagree: nothing pays and it is logged', async () => {
  await (await as(era5).report(1998, FINAL, BA, 20, h('era5 fake'))).wait() // e.g. a tampered "driest on record"
  const rc = await (await as(power).report(1998, FINAL, BA, 600, h('power apr ba'))).wait()
  if (!events(rc, 'SourcesDisagree').length) throw new Error('no SourcesDisagree')
  if ((await bal(farmers[3])) !== 0n) throw new Error('paid despite disagreement')
})
await check('moderate drought: half cover', async () => {
  await (await as(era5).report(2010, FINAL, BA, 180, h('a'))).wait()
  await (await as(power).report(2010, FINAL, BA, 150, h('b'))).wait()
  if ((await bal(farmers[3])) !== eth(1)) throw new Error(`balance ${ethers.formatEther(await bal(farmers[3]))}`)
})
await check('normal season: nothing pays', async () => {
  await (await as(era5).report(2011, FINAL, BA, 640, h('c'))).wait()
  const rc = await (await as(power).report(2011, FINAL, BA, 700, h('d'))).wait()
  if (events(rc, 'Paid').length) throw new Error('paid in a normal season')
})
await check('the pool must cover every payout before anyone is paid', async () => {
  const big = ethers.Wallet.createRandom().address
  await (await c.issue(big, LABASA, eth(1000))).wait()
  await (await as(era5).report(1998, FINAL, LABASA, 10, h('e'))).wait()
  await reverts(as(power).report(1998, FINAL, LABASA, 10, h('f')), 'PoolTooSmall')
  if ((await bal(big)) !== 0n) throw new Error('partially paid')
})
await check('a wallet that refuses payment cannot block the district; its money waits for it', async () => {
  const ref = await new ethers.ContractFactory(Refuser.abi, Refuser.bytecode, insurer).deploy()
  await ref.waitForDeployment()
  const normal = ethers.Wallet.createRandom().address, R = await ref.getAddress()
  await (await c.issue(R, 4, eth(1))).wait()
  await (await c.issue(normal, 4, eth(1))).wait()
  await (await as(era5).report(1998, FINAL, 4, 10, h('g'))).wait()
  const rc = await (await as(power).report(1998, FINAL, 4, 10, h('i'))).wait()
  if ((await bal(normal)) !== eth(1)) throw new Error('normal farmer not paid')
  if (!events(rc, 'Held').length || (await c.owed(R)) !== eth(1)) throw new Error('refused payment not held')
})
await check('the published rule matches scripts/rules.mjs', async () => {
  const { RULES } = await import('./rules.mjs')
  const pm = (x) => Math.round(x * 1000)
  const want = [[EARLY, pm(RULES.early.at), pm(RULES.early.pay)], [EARLY, pm(RULES.early.at) + 1, 0], [FINAL, pm(RULES.severe.at), pm(RULES.severe.pay)],
    [FINAL, pm(RULES.moderate.at), pm(RULES.moderate.pay)], [FINAL, pm(RULES.moderate.at) + 1, 0]]
  for (const [s, i, p] of want) if (Number(await c.shareDue(s, i)) !== p) throw new Error(`shareDue(${s},${i}) != ${p}`)
  if (Number(await c.MAX_GAP()) !== pm(RULES.maxGap)) throw new Error('MAX_GAP differs')
})

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
