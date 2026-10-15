// Tries to break DroughtCover's rules on a fresh deployment. Needs the local chain: npm run chain
//   node scripts/test-contract.mjs
import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
import { compile } from './compile.mjs'
import { local } from './chain-config.mjs'
import { RULES, decide, shareDue as jsShare } from './rules.mjs'

const { DroughtCover, Refuser } = compile({
  'DroughtCover.sol': readFileSync('contracts/DroughtCover.sol', 'utf8'),
  // A farmer "wallet" that rejects every transfer, to check it can't block the rest of the district.
  'Refuser.sol': 'pragma solidity ^0.8.24; contract Refuser { receive() external payable { revert("no"); } function pull(address c) external { (bool ok,) = c.call(abi.encodeWithSignature("withdraw()")); require(ok); } }',
})
const { provider, insurer, era5, power, chirps, stranger } = local()
const EARLY = 0, FINAL = 1, LAUTOKA = 0, BA = 2, LABASA = 6
const OK = 200, FLAGGED = 1300 // data-guard verdicts (per mille of the flag threshold)
const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s)), eth = (n) => ethers.parseEther(String(n))

const c = await new ethers.ContractFactory(DroughtCover.abi, DroughtCover.bytecode, insurer).deploy(era5.address, power.address, chirps.address)
await c.waitForDeployment()
await (await insurer.sendTransaction({ to: await c.getAddress(), value: eth(2000) })).wait()
const as = (s) => c.connect(s)
const send = async (p) => (await p).wait()
const farmers = Array.from({ length: 4 }, () => ethers.Wallet.createRandom().address)
for (const f of farmers.slice(0, 3)) await send(c.issue(f, LAUTOKA, eth(1)))
await send(c.issue(farmers[3], BA, eth(2)))
const bal = (a) => provider.getBalance(a)
const events = (rc, name) => rc.logs.map((l) => { try { return c.interface.parseLog(l) } catch {} }).filter((e) => e?.name === name)
const later = async (days) => { await provider.send('evm_increaseTime', [days * 86400]); await provider.send('evm_mine', []) }
const newFarmer = async (district, cover = 1) => { const f = ethers.Wallet.createRandom().address; await send(c.issue(f, district, eth(cover))); return f }

let fails = 0, count = 0
async function check(name, fn) {
  count++
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
await check('only the three oracles can report', () => reverts(as(stranger).report(1998, EARLY, LAUTOKA, 50, OK, h('x')), 'NotOracle'))
await check('a reading needs its data fingerprint', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 50, OK, ethers.ZeroHash), 'BadReading'))
await check('one oracle alone cannot trigger a payout', async () => {
  const before = await bal(farmers[0])
  await send(as(era5).report(1998, EARLY, LAUTOKA, 60, OK, h('era5 jan')))
  if ((await bal(farmers[0])) !== before) throw new Error('paid on one source')
})
await check('an oracle cannot report twice', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 10, OK, h('again')), 'AlreadyReported'))
await check('ERA5 and NASA agree: early 30% paid to every farmer in the district at once, without waiting for CHIRPS', async () => {
  const rc = await send(as(power).report(1998, EARLY, LAUTOKA, 80, OK, h('power jan')))
  if (events(rc, 'Paid').length !== 3) throw new Error(`${events(rc, 'Paid').length} paid`)
  for (const f of farmers.slice(0, 3)) if ((await bal(f)) !== eth(0.3)) throw new Error('wrong amount')
  if ((await bal(farmers[3])) !== 0n) throw new Error('paid another district')
})
await check('a settled checkpoint cannot be reported again by ERA5 or NASA', () => reverts(as(era5).report(1998, EARLY, LAUTOKA, 5, OK, h('late')), 'AlreadySettled'))
await check('CHIRPS arriving weeks later is logged as a witness to the decision', async () => {
  const rc = await send(as(chirps).report(1998, EARLY, LAUTOKA, 90, 0, h('chirps jan')))
  const w = events(rc, 'Witness')
  if (w.length !== 1 || !w[0].args.agrees) throw new Error('no agreeing witness')
})
await check('final checkpoint pays the rest (100% total, not 130%)', async () => {
  await send(as(era5).report(1998, FINAL, LAUTOKA, 30, OK, h('era5 apr')))
  await send(as(power).report(1998, FINAL, LAUTOKA, 30, OK, h('power apr')))
  for (const f of farmers.slice(0, 3)) if ((await bal(f)) !== eth(1)) throw new Error(`balance ${ethers.formatEther(await bal(f))}`)
})
await check('ERA5 and NASA disagree: nothing is paid yet, the checkpoint waits for CHIRPS', async () => {
  await send(as(era5).report(1998, FINAL, BA, 20, OK, h('era5 fake'))) // e.g. a tampered "driest on record"
  const rc = await send(as(power).report(1998, FINAL, BA, 600, OK, h('power apr ba')))
  if (!events(rc, 'AwaitingTieBreak').length) throw new Error('not waiting')
  if ((await bal(farmers[3])) !== 0n) throw new Error('paid before the tie-break')
})
await check('a faked record is outvoted: CHIRPS sides with NASA (a wet season), nothing pays', async () => {
  const rc = await send(as(chirps).report(1998, FINAL, BA, 640, 0, h('chirps apr ba')))
  const s = events(rc, 'Settled')[0]
  if (!s || Number(s.args.a) !== 1 || Number(s.args.b) !== 2) throw new Error('NASA and CHIRPS did not decide')
  if ((await bal(farmers[3])) !== 0n) throw new Error('paid on the faked record')
})
await check('a broken record cannot block an honest payout: ERA5 and CHIRPS agree on a drought, farmers are paid', async () => {
  const f = await newFarmer(3)
  await send(as(chirps).report(2010, FINAL, 3, 40, 0, h('c1'))) // CHIRPS in first this time
  await send(as(era5).report(2010, FINAL, 3, 60, OK, h('e1')))
  const rc = await send(as(power).report(2010, FINAL, 3, 700, OK, h('p1'))) // NASA broken
  if (!events(rc, 'Paid').length || (await bal(f)) !== eth(1)) throw new Error('honest payout blocked')
})
await check('no two records agree: nothing pays and it is logged', async () => {
  const f = await newFarmer(5)
  await send(as(era5).report(2001, FINAL, 5, 10, OK, h('a')))
  await send(as(power).report(2001, FINAL, 5, 500, OK, h('b')))
  const rc = await send(as(chirps).report(2001, FINAL, 5, 950, 0, h('c')))
  if (!events(rc, 'SourcesDisagree').length || (await bal(f)) !== 0n) throw new Error('paid without agreement')
})
await check('moderate drought: half cover', async () => {
  await send(as(era5).report(2010, FINAL, BA, 180, OK, h('a')))
  await send(as(power).report(2010, FINAL, BA, 150, OK, h('b')))
  if ((await bal(farmers[3])) !== eth(1)) throw new Error(`balance ${ethers.formatEther(await bal(farmers[3]))}`)
})
await check('normal season: nothing pays', async () => {
  await send(as(era5).report(2011, FINAL, BA, 640, OK, h('c')))
  const rc = await send(as(power).report(2011, FINAL, BA, 700, OK, h('d')))
  if (events(rc, 'Paid').length) throw new Error('paid in a normal season')
})
await check('the pool must cover every payout before anyone is paid', async () => {
  const big = await newFarmer(LABASA, 5000)
  await send(as(era5).report(1998, FINAL, LABASA, 10, OK, h('e')))
  await reverts(as(power).report(1998, FINAL, LABASA, 10, OK, h('f')), 'PoolTooSmall')
  if ((await bal(big)) !== 0n) throw new Error('partially paid')
})
await check('a wallet that refuses payment cannot block the district; its money waits for it', async () => {
  const ref = await new ethers.ContractFactory(Refuser.abi, Refuser.bytecode, insurer).deploy()
  await ref.waitForDeployment()
  const R = await ref.getAddress(), normal = ethers.Wallet.createRandom().address
  await send(c.issue(R, 4, eth(1)))
  await send(c.issue(normal, 4, eth(1)))
  await send(as(era5).report(1998, FINAL, 4, 10, OK, h('g')))
  const rc = await send(as(power).report(1998, FINAL, 4, 10, OK, h('i')))
  if ((await bal(normal)) !== eth(1)) throw new Error('normal farmer not paid')
  if (!events(rc, 'Held').length || (await c.owed(R)) !== eth(1)) throw new Error('refused payment not held')
})
await check('one flag: a payout is held until the challenge period is over and CHIRPS is in; the insurer cannot reject it; then it is paid', async () => {
  const f = await newFarmer(5)
  await send(as(era5).report(1998, FINAL, 5, 20, FLAGGED, h('j')))
  const rc = await send(as(power).report(1998, FINAL, 5, 30, OK, h('k')))
  if (!events(rc, 'PayoutHeld').length || events(rc, 'Paid').length) throw new Error('not held')
  await reverts(c.release(1998, FINAL, 5), 'ChallengeOpen')
  await reverts(as(stranger).reject(1998, FINAL, 5), 'NotInsurer')
  await reverts(c.reject(1998, FINAL, 5), 'NeedsTwoSignals')
  await later(14)
  await reverts(c.release(1998, FINAL, 5), 'AwaitingChirps') // the satellite record isn't in yet
  await send(as(chirps).report(1998, FINAL, 5, 40, 0, h('k2'))) // it agrees: a real drought
  await reverts(c.reject(1998, FINAL, 5), 'NeedsTwoSignals')
  await later(3)
  await reverts(c.reject(1998, FINAL, 5), 'ChallengeClosed')
  await send(as(stranger).release(1998, FINAL, 5))
  if ((await bal(f)) !== eth(1)) throw new Error('not paid after release')
  await reverts(c.release(1998, FINAL, 5), 'NothingHeld')
})
await check('one flag plus CHIRPS disagreeing, even when CHIRPS arrives after the 14 days: the insurer can reject', async () => {
  const f = await newFarmer(7)
  await send(as(era5).report(2011, FINAL, 7, 30, FLAGGED, h('l')))
  await send(as(power).report(2011, FINAL, 7, 60, OK, h('m')))
  await reverts(c.reject(2011, FINAL, 7), 'NeedsTwoSignals')
  await later(20) // CHIRPS is published weeks after the month ends
  await reverts(c.release(2011, FINAL, 7), 'AwaitingChirps')
  const rc = await send(as(chirps).report(2011, FINAL, 7, 820, 0, h('n'))) // the satellite record saw a wet season
  if (!events(rc, 'Witness').length || events(rc, 'Witness')[0].args.agrees) throw new Error('no dissent logged')
  if (!events(await send(c.reject(2011, FINAL, 7)), 'PayoutRejected').length) throw new Error('not rejected')
  await later(14)
  await reverts(c.release(2011, FINAL, 7), 'NothingHeld')
  if ((await bal(f)) !== 0n) throw new Error('paid after rejection')
})
await check('both deciding readings flagged: the insurer can reject during the challenge period', async () => {
  await send(as(era5).report(2012, FINAL, 1, 20, FLAGGED, h('o')))
  await send(as(power).report(2012, FINAL, 1, 20, FLAGGED, h('p')))
  if (!events(await send(c.reject(2012, FINAL, 1)), 'PayoutRejected').length) throw new Error('not rejected')
})
await check('flagged data with nothing due is not held (normal seasons are never delayed)', async () => {
  await send(as(era5).report(2013, FINAL, 7, 700, FLAGGED, h('q')))
  const rc = await send(as(power).report(2013, FINAL, 7, 650, OK, h('r')))
  if (events(rc, 'PayoutHeld').length) throw new Error('held with nothing due')
})
await check('sponsor money is logged against the district and season it paid for', async () => {
  const f = await newFarmer(LABASA === 6 ? 6 : 6, 1), donor = stranger
  await send(as(donor).sponsor(LAUTOKA, { value: eth(0.5) }))
  if ((await c.sponsored(LAUTOKA)) !== eth(0.5)) throw new Error('not recorded')
  const g = await newFarmer(LAUTOKA)
  await send(as(era5).report(2020, FINAL, LAUTOKA, 50, OK, h('s')))
  const rc = await send(as(power).report(2020, FINAL, LAUTOKA, 60, OK, h('t')))
  const used = events(rc, 'SponsorFundsUsed')
  if (!used.length || used[0].args.amount !== eth(0.5) || Number(used[0].args.district) !== LAUTOKA || Number(used[0].args.season) !== 2020) throw new Error('sponsor use not traced')
  if ((await c.sponsored(LAUTOKA)) !== 0n || (await bal(g)) !== eth(1) || !f) throw new Error('accounting off')
})
await check('if CHIRPS never arrives, a held payout is released after the longest wait, not blocked forever', async () => {
  const f = await newFarmer(3)
  await send(as(era5).report(2015, FINAL, 3, 30, FLAGGED, h('u')))
  await send(as(power).report(2015, FINAL, 3, 40, OK, h('v')))
  await later(14 + 30)
  await reverts(c.release(2015, FINAL, 3), 'AwaitingChirps')
  await later(31)
  await send(as(stranger).release(2015, FINAL, 3))
  if ((await bal(f)) !== eth(1)) throw new Error('not paid')
})
await check('sponsor money is ring-fenced: another district cannot spend it', async () => {
  // a fresh contract with a small pool, so the sponsor money is most of it
  const k = await new ethers.ContractFactory(DroughtCover.abi, DroughtCover.bytecode, insurer).deploy(era5.address, power.address, chirps.address)
  await k.waitForDeployment()
  const K = (s) => k.connect(s), ka = await k.getAddress()
  await send(insurer.sendTransaction({ to: ka, value: eth(1) }))      // the insurer's own pool: F$1 equivalent
  await send(K(stranger).sponsor(BA, { value: eth(5) }))              // a donor protects Ba
  const other = ethers.Wallet.createRandom().address, ba = ethers.Wallet.createRandom().address
  await send(k.issue(other, LAUTOKA, eth(3)))
  await send(k.issue(ba, BA, eth(5)))
  await send(K(era5).report(1998, FINAL, LAUTOKA, 10, OK, h('w')))
  try { await send(K(power).report(1998, FINAL, LAUTOKA, 10, OK, h('x'))); throw new Error('Lautoka spent Ba\'s sponsor money') }
  catch (e) { if (!/PoolTooSmall|reverted|revert/i.test(e.shortMessage || e.message) || /spent/.test(e.message)) throw e }
  await send(K(era5).report(1998, FINAL, BA, 10, OK, h('y')))
  const rc = await send(K(power).report(1998, FINAL, BA, 10, OK, h('z')))
  if ((await bal(ba)) !== eth(5) || (await k.totalSponsored()) !== 0n) throw new Error('Ba not paid from its sponsor money')
  if (!rc.logs.length) throw new Error('no logs')
})
await check('a forecast can be sealed on the record, timestamped, only by the insurer or an oracle', async () => {
  await reverts(as(stranger).seal(ethers.encodeBytes32String('forecast'), 2027, BA, 610, h('model')), 'NotAllowed')
  const rc = await send(c.seal(ethers.encodeBytes32String('forecast'), 2027, BA, 610, h('model')))
  const e = events(rc, 'Sealed')[0], block = await provider.getBlock(rc.blockNumber)
  if (!e || Number(e.args.value) !== 610 || Number(e.args[6]) !== Number(block.timestamp)) throw new Error(`not sealed with its time (${e?.args[6]} vs ${block.timestamp})`)
})
await check('the contract decides exactly as scripts/rules.mjs on 40 random three-record seasons', async () => {
  let rnd = 7; const r = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 40; i++) {
    // district 6 holds the oversized policy from the pool test, so leave it out
    const k = [0, 1, 2, 3, 4, 5, 7][i % 7], d = [r(), r(), r()].map((x) => Math.round(x * 1000)), season = 3000 + i, f = await newFarmer(k)
    const want = decide({ era5: d[0] / 1000, power: d[1] / 1000, chirps: d[2] / 1000 })
    await send(as(era5).report(season, FINAL, k, d[0], OK, h(`e${i}`)))
    await send(as(power).report(season, FINAL, k, d[1], OK, h(`p${i}`)))
    const rc = await send(as(chirps).report(season, FINAL, k, d[2], 0, h(`c${i}`)))
    const o = await c.outcomes(season, FINAL, k)
    const got = Number(await c.paidShare(season, (await c.policyCount()) - 1n))
    // the contract's integer index for the pair the JS rule chose
    const ix = { era5: 0, power: 1, chirps: 2 }, pair = want.deciders.map((n) => d[ix[n]])
    const expect = want.index == null ? 0 : Number(await c.shareDue(FINAL, Math.floor((pair[0] + pair[1]) / 2)))
    if (Number(got) !== expect) throw new Error(`season ${i}: [${d}] contract paid ${got}, rules say ${expect}`)
    if (want.index != null && Math.abs(Number(o.index) - want.index * 1000) > 1) throw new Error(`season ${i}: index ${o.index} vs ${want.index}`)
    if (!rc) throw new Error('no receipt')
  }
})
await check('the published rule matches scripts/rules.mjs', async () => {
  const pm = (x) => Math.round(x * 1000)
  const want = [[EARLY, pm(RULES.early.at), pm(RULES.early.pay)], [EARLY, pm(RULES.early.at) + 1, 0], [FINAL, pm(RULES.severe.at), pm(RULES.severe.pay)],
    [FINAL, pm(RULES.moderate.at), pm(RULES.moderate.pay)], [FINAL, pm(RULES.moderate.at) + 1, 0]]
  for (const [s, i, p] of want) if (Number(await c.shareDue(s, i)) !== p || pm(jsShare(s ? 'final' : 'early', i / 1000)) !== p) throw new Error(`shareDue(${s},${i}) != ${p}`)
  if (Number(await c.MAX_GAP()) !== pm(RULES.maxGap)) throw new Error('MAX_GAP differs')
})

console.log(fails ? `\n${fails} of ${count} failed` : `\nall ${count} passed`)
process.exit(fails ? 1 : 0)
