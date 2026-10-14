import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { chain, demoKey, addressOf } from './evm.js'
import { inSeason, seasonAgg, features, score, pct } from './guard.js'
import { district as trackDistrict, SEASON_START } from './now.js'

maplibregl.setWorkerUrl(workerUrl) // Vite's dependency bundling hides MapLibre's own worker file

const $ = (id) => document.getElementById(id)
const get = (f) => fetch(`/data/${f}`).then((r) => r.json())
const [IDX, GUARD, DAYS, ART, FC] = await Promise.all(['index.json', 'guard.json', 'days.json', 'contract.json', 'forecast.json'].map(get))
const D = IDX.districts, KEYS = D.map((d) => d.key), BA = KEYS.indexOf('ba')
const SEASON = Object.fromEntries(IDX.seasons.map((s) => [s.season, s]))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const F = (n) => `F$${Math.round(n).toLocaleString()}`
const pm = (x) => Math.round(x * 1000) // 0..1 → per mille, as the contract wants
const short = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`
const opts = (el, list, sel) => (el.innerHTML = list.map(([v, t]) => `<option value="${v}"${v == sel ? ' selected' : ''}>${t}</option>`).join(''))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const GROWERS = 10_200 // active cane growers in Fiji, about (Prime Minister, Fiji Times, Oct 2025)
const millions = (n) => `F$${(n / 1e6).toFixed(1)} million`
// The data guard's verdict as an oracle posts it: score as a share of the flag threshold, per mille (above 1000 = flagged).
const verdict = (x) => Math.min(65535, Math.round(x * 1000))
const realVerdict = (stage, y, k, src) => verdict(GUARD.scores[stage][y]?.[k]?.[src === 'era5' ? 0 : 1] ?? 0)

// Plain words for an index (0 = driest season in the 1991–2020 record, 1 = wettest).
const drierThan = (x) => `drier than ${Math.min(99, Math.round((1 - x) * 100))}% of years in the 30-year record`
const kind = (x) => (x <= 0.1 ? 'severe drought' : x <= 0.2 ? 'drought' : x <= 0.35 ? 'dry' : x <= 0.65 ? 'normal' : 'wet')
const was = (x) => (x <= 0.2 ? `a ${kind(x)}` : kind(x)) // "was a drought" but "was wet"
const STOPS = [[0, [190, 24, 12]], [0.1, [255, 61, 46]], [0.22, [246, 196, 69]], [0.42, [216, 221, 230]], [0.72, [130, 186, 255]], [1, [78, 168, 255]]]
function colour(x) {
  let i = 0
  while (i < STOPS.length - 2 && x > STOPS[i + 1][0]) i++
  const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1], t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return `rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * t)).join(',')})`
}

// ---------- the in-browser chain: one insurer, two data oracles, test farmers with F$1,000 cover each ----------
const UNIT = 10n ** 18n, COVER = 1000n
const K = { insurer: demoKey('insurer'), era5: demoKey('era5 oracle'), power: demoKey('nasa oracle') }
async function newChain(perDistrict) {
  const c = await chain()
  for (const k of Object.values(K)) await c.fund(addressOf(k), 10n ** 9n * UNIT)
  const dc = await c.deploy(K.insurer, ART, [addressOf(K.era5), addressOf(K.power)])
  await c.transfer(K.insurer, dc.address, 500_000n * UNIT)
  for (let d = 0; d < D.length; d++) for (let i = 0; i < perDistrict; i++) await dc.write(K.insurer, 'issue', [addressOf(demoKey(`farmer ${d}-${i}`)), d, COVER * UNIT])
  return { c, dc }
}

// ---------- 1. the stage: pick a farm and a season, watch the contract decide ----------
const YEARS = Object.keys(IDX.replays).map(Number)
let run = 0, playing = false, step = -1, year = 1998, farm = BA, st = null, markers = [], touched = false
const MONTH_I = [11, 12, 1, 2, 3, 4]
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const season = (y) => `${y - 1}–${String(y).slice(2)}`
const monthName = (i) => { const m = MONTH_I[i]; return `${MONTHS[m - 1]} ${m >= 11 ? year - 1 : year}` }
const monthLong = (i) => { const m = MONTH_I[i]; return `${LONG[m - 1]} ${m >= 11 ? year - 1 : year}` }

// Real Copernicus Sentinel-2 imagery as the basemap (EOX cloudless mosaic).
const SAT = {
  version: 8,
  sources: { s2: { type: 'raster', tileSize: 256, maxzoom: 14, tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)' } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#071022' } }, { id: 's2', type: 'raster', source: 's2', paint: { 'raster-saturation': -0.15, 'raster-contrast': 0.08 } }],
}
// Keep the cane belt clear of the picker (left), the phone (right), the status (top) and the dock (bottom).
const pad = () => (innerWidth > 980 ? { top: 150, bottom: 150, left: Math.min(540, innerWidth * 0.4), right: 360 } : 30)
const BOUNDS = [[177.25, -18.3], [179.5, -16.3]]
const map = new maplibregl.Map({ container: 'map', style: SAT, bounds: BOUNDS, fitBoundsOptions: { padding: pad() }, attributionControl: { compact: true }, cooperativeGestures: true })
addEventListener('resize', () => map.fitBounds(BOUNDS, { padding: pad(), duration: 0 }))
// Markers are plain HTML, so they show straight away; clicking one picks that farm.
markers = D.map((d, k) => {
  const el = document.createElement('div')
  el.className = 'dm'
  el.innerHTML = `<i title="Pick ${d.name}"></i><span>${d.name}</span>`
  el.querySelector('i').onclick = () => pickFarm(k)
  return new maplibregl.Marker({ element: el, anchor: 'top' }).setLngLat([d.lon, d.lat]).addTo(map)
})

// The picker: farms as chips, seasons as a strip of bars (taller and redder = drier at the chosen farm).
$('farms').innerHTML = D.map((d, k) => `<button data-k="${k}">${d.name}</button>`).join('')
$('farms').onclick = (e) => { const b = e.target.closest('button'); if (b) pickFarm(+b.dataset.k) }
function drawStrip() {
  $('strip').innerHTML = YEARS.map((y) => {
    const x = SEASON[y].final[farm].index
    return `<button data-y="${y}" class="${y === year ? 'on' : ''}" style="--h:${Math.round(8 + (1 - x) * 92)}%;--c:${colour(x)}" title="${season(y)}: ${drierThan(x).replace(' in the 30-year record', '')}" aria-label="${season(y)}"></button>`
  }).join('')
  for (const b of $('farms').children) b.classList.toggle('on', +b.dataset.k === farm)
  markers.forEach((m, k) => m.getElement().classList.toggle('sel', k === farm))
  $('yr-lab').textContent = season(year)
}
$('strip').onclick = (e) => { const b = e.target.closest('button'); if (b) pickYear(+b.dataset.y) }
function pickFarm(k) { touched = true; if (k === farm) return; farm = k; drawStrip(); load(year) }
function pickYear(y) { touched = true; if (y === year) return; year = y; drawStrip(); load(y) }

function paint() {
  const rows = step >= 0 ? IDX.replays[year][step].districts : null
  markers.forEach((m, k) => {
    const el = m.getElement(), x = rows?.[k].index
    el.querySelector('i').style.background = x == null ? '#d8dde6' : colour(x)
    el.classList.toggle('severe', x != null && x <= 0.1 && !st?.paidD.has(k))
    el.classList.toggle('dry', x != null && x > 0.1 && x <= 0.25)
    el.classList.toggle('paid', !!st?.paidD.has(k))
  })
  $('pl-months').innerHTML = MONTH_I.map((_, i) => `<li data-i="${i}" class="${i === 2 || i === 5 ? 'ck' : ''}${i < step ? ' done' : ''}${i === step ? ' now' : ''}">` +
    `${monthName(i).split(' ')[0]}<small>${i === 2 ? 'early check' : i === 5 ? 'final check' : ''}</small></li>`).join('')
  $('pl-progress').style.width = `${((step + 1) / 6) * 100}%`
  narrate(rows)
}

// The status card tells the story of each month, for the chosen farm.
function narrate(rows) {
  const s = $('status'), name = D[farm].name
  if (step < 0) {
    s.className = 'status'
    $('pl-month').textContent = `${name}, ${season(year)}`
    $('pl-note').textContent = 'Press play to watch the season, month by month'
    return
  }
  const x = rows[farm].index, got = st?.got[step]
  $('pl-month').textContent = monthLong(step)
  if (step === 2 || step === 5) {
    const label = step === 2 ? 'Early check' : 'Final check'
    if (st?.checking) {
      s.className = 'status alarm'
      $('pl-note').textContent = `${label}: both satellite records are reporting to the contract…`
      return
    }
    s.className = `status ${got ? 'paid' : 'calm'}`
    $('pl-note').textContent = got ? `${label}: both satellite records agree ${name} is in ${was(x)}. ${F(got)} paid to you.`
      : step === 2 ? `${label}: ${name} isn't in a severe drought yet. Nothing paid, still watching.`
      : st?.you ? `${label}: season over at ${name}. You've been paid ${F(st.you)}.` : `${label}: ${name} had a ${kind(x)} season. No payout needed.`
    return
  }
  s.className = `status${x <= 0.2 ? ' alarm' : ''}`
  $('pl-note').textContent = `Satellites are watching. So far ${name} is ${drierThan(x)}.`
}

function notify(title, body, when) {
  const ol = $('sms')
  ol.querySelector('.idle')?.remove()
  const li = document.createElement('li')
  li.innerHTML = `<div class="n-h"><i></i>Proof of Drought<em>${when}</em></div><b>${title}</b> ${body}`
  ol.prepend(li)
}
function log(cls, block, text) {
  const li = document.createElement('li')
  li.className = cls
  li.innerHTML = `<i>#${block}</i><span>${text}</span>`
  $('record-log').prepend(li)
}
function tally() {
  $('pl-paid').textContent = F(st.paid)
  $('pl-you').textContent = F(st.you)
  $('ph-bal').textContent = F(st.you)
  insurer()
}
// The insurer's view on the phone: the same contract, read from the pool's side.
async function insurer() {
  if (!st) return
  const s = st
  $('in-paid').textContent = F(s.paid)
  $('in-farmers').textContent = `${s.ids.size} of ${D.length * 12}`
  $('in-settled').textContent = `${s.settled} of ${D.length * 2}`
  $('in-disagree').textContent = s.disagree
  $('in-held').textContent = s.held
  $('in-scale').textContent = s.paid ? millions((s.paid / (D.length * 12)) * GROWERS) : 'F$0'
  const pool = await s.c.balance(s.dc.address)
  if (s === st) $('in-pool').textContent = F(Number(pool / UNIT))
}
for (const b of document.querySelectorAll('.views button')) b.onclick = () => {
  const ins = b.dataset.v === 'insurer'
  for (const x of document.querySelectorAll('.views button')) x.classList.toggle('on', x === b), x.setAttribute('aria-selected', x === b)
  $('ins').hidden = !ins
  document.querySelector('.phone').classList.toggle('insurer', ins)
}
function cashPop(k, amount) {
  const el = markers[k]?.getElement()
  if (!el) return
  const tag = document.createElement('b')
  tag.className = 'cash'
  tag.textContent = `+${F(amount)}`
  tag.style.marginBottom = `${(k % 3) * 20}px` // the west-coast districts sit close together: stagger their tags
  el.append(tag)
  setTimeout(() => tag.remove(), 2700)
}

async function load(y) {
  const my = ++run
  year = y, step = -1, playing = false
  setPlay(false)
  $('sms').innerHTML = '<li class="idle">No alerts yet.</li>'
  $('ph-bal').textContent = 'F$0'
  $('pl-you').textContent = 'F$0'
  $('pl-paid').textContent = 'F$0'
  $('ph-date').textContent = `Your cane farm · ${season(y)}`
  $('ph-time').textContent = D[farm].name
  $('record-log').innerHTML = ''
  st = null
  paint()
  const { c, dc } = await newChain(12)
  if (my !== run) return
  st = { c, dc, paid: 0, you: 0, got: {}, paidD: new Set(), ids: new Set(), settled: 0, disagree: 0, held: 0 }
  log('', dc.deployTx.block, `Contract deployed · ${D.length * 12} test farmers insured for F$1,000 each`)
  tally()
}

// A checkpoint: both data sources post each district's reading; the contract decides and pays.
async function checkpoint(stage, my) {
  const rows = SEASON[year]?.[stage]
  if (!rows) return
  st.checking = true
  for (let k = 0; k < rows.length; k++) {
    if (my !== run) return
    const r = rows[k], s = stage === 'early' ? 0 : 1
    // Each oracle posts its reading, its data guard's verdict and the seal of the raw data behind it.
    await st.dc.write(K.era5, 'report', [year, s, k, pm(r.sources.era5.dryness), realVerdict(stage, year, k, 'era5'), r.sources.era5.hash])
    const res = await st.dc.write(K.power, 'report', [year, s, k, pm(r.sources.power.dryness), realVerdict(stage, year, k, 'power'), r.sources.power.hash])
    st.settled++
    const settled = res.events.find((e) => e.name === 'Settled'), paid = res.events.filter((e) => e.name === 'Paid')
    const idx = Number(settled.args.index) / 1000, name = D[k].name, when = stage === 'early' ? `31 Jan ${year}` : `30 Apr ${year}`
    if (res.events.some((e) => e.name === 'SourcesDisagree')) st.disagree++, log('bad', res.block, `${name} · the two records disagree · nothing paid`)
    else if (res.events.some((e) => e.name === 'PayoutHeld')) {
      st.held++
      log('bad', res.block, `${name} · ${kind(idx)}, but the AI guard flagged the data · payout held 14 days for review`)
      if (k === farm) notify('Payout on hold.', `The data for ${name} looks unusual, so your payout waits 14 days in case anyone challenges it.`, when)
    } else if (paid.length) {
      for (const e of paid) st.ids.add(e.args.id)
      const amt = paid.reduce((a, e) => a + Number(e.args.amount / UNIT), 0)
      st.paid += amt
      st.paidD.add(k)
      cashPop(k, amt)
      log('pay', res.block, `${name} · both records agree: ${kind(idx)} · ${paid.length} farmers paid ${F(amt)} · ${short(res.hash)}`)
      if (k === farm) {
        const each = Number(paid[0].args.amount / UNIT)
        st.you += each
        st.got[stage === 'early' ? 2 : 5] = each
        $('ph-bal').classList.add('bump'); setTimeout(() => $('ph-bal').classList.remove('bump'), 400)
        $('ph-date').textContent = `Your cane farm · ${when}`
        notify(`${F(each)} received.`, stage === 'early'
          ? `Drought confirmed at ${name}: ${drierThan(idx)}. Both satellite records agree. Use it for water, feed and seed.`
          : `The season ended ${drierThan(idx)}. That's ${F(st.you)} this season.`, when)
      }
    } else {
      log('', res.block, `${name} · ${kind(idx)} · no payout needed`)
      if (k === farm && stage === 'final' && !st.you) notify('No payout this season.', `${name} had a ${kind(idx)} season. Your cover continues.`, when)
    }
    tally()
    paint()
    await wait(120)
  }
  st.checking = false
  paint() // every district settled: now say what happened at your farm
}

async function advance() {
  if (!st || step >= 5) return false
  const my = run
  step++
  paint()
  if (step === 2) await checkpoint('early', my)
  if (step === 5) await checkpoint('final', my)
  return my === run
}
function setPlay(on) {
  $('pl-play').innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
  $('pl-play').setAttribute('aria-label', on ? 'Pause' : 'Play')
  $('go').querySelector('span').textContent = on ? 'Playing…' : step >= 5 ? 'Play it again' : 'Play my season'
  $('go').classList.toggle('pulse', !on && step < 0)
}
async function play() {
  if (playing) return (playing = false), setPlay(false)
  while (!st) await wait(100)
  if (step >= 5) await load(year)
  while (!st) await wait(100)
  playing = true
  setPlay(true)
  const my = run
  while (playing && my === run && step < 5) {
    if (!(await advance())) return
    await wait(step === 2 || step === 5 ? 1900 : 1200)
  }
  if (my === run) playing = false, setPlay(false)
}
$('pl-play').onclick = $('go').onclick = () => { touched = true; play() }
$('pl-months').onclick = async (e) => {
  const i = +e.target.closest('li')?.dataset.i
  if (!st || Number.isNaN(i) || playing) return
  touched = true
  if (i < step) await load(year)
  while (st && step < i) if (!(await advance())) return
}
$('pl-rec').onclick = () => {
  const el = $('record-log'), show = el.hidden
  el.hidden = !show
  $('pl-rec').textContent = show ? 'Hide record' : 'On-chain record'
}
drawStrip()
load(year)
// If nobody has picked anything after a few seconds, play the 1998 drought at Ba to show what happens
// (not for people who prefer reduced motion).
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) (async () => { while (!st) await wait(150); await wait(3500); if (!touched && step < 0 && !playing) play() })()
// The top bar turns solid once you scroll past the stage.
const topBar = document.querySelector('.top')
const solid = () => topBar.classList.toggle('solid', scrollY > $('stage').offsetHeight - 140)
addEventListener('scroll', solid, { passive: true })
solid()

// ---------- 2. track record ----------
const DROUGHT = [1983, 1987, 1992, 1998, 2010], STORM = { 1985: 'Cyclones Eric and Nigel', 2012: 'Floods', 2016: 'Cyclone Winston' }
{
  const S = IDX.seasons.filter((s) => s.final)
  $('years').innerHTML = S.map((s) => {
    const p = s.payout, fell = s.yieldChange != null && s.yieldChange <= -0.1
    const tip = `${s.season}: paid ${Math.round(p * 100)}% of cover` + (s.yieldChange == null ? '' : ` · cane harvest ${s.yieldChange >= 0 ? '+' : ''}${Math.round(s.yieldChange * 100)}%`) + (STORM[s.season] ? ` · ${STORM[s.season]}` : '')
    return `<div class="yr${p >= 0.4 ? ' hi' : p > 0 ? ' lo' : ''}${STORM[s.season] ? ' storm' : ''}" title="${tip}">’${String(s.season).slice(2)}${fell ? '<i class="dot"></i>' : ''}</div>`
  }).join('')
  const falseAlarms = S.filter((s) => s.payout >= 0.25 && s.yieldChange != null && s.yieldChange >= 0).map((s) => s.season)
  const caught = DROUGHT.filter((y) => SEASON[y].payout > 0)
  $('takeaways').innerHTML =
    `<div class="tk good"><b>Paid in all ${caught.length} drought years</b><p>${caught.join(', ')}: every El Niño drought that cut Fiji's cane harvest.</p></div>` +
    `<div class="tk good"><b>Quiet when it wasn't drought</b><p>Cyclones and floods in ${Object.keys(STORM).join(', ')} hurt harvests too, but need a different kind of cover. It paid ${Object.keys(STORM).map((y) => `${Math.round(SEASON[y].payout * 100)}%`).join(', ')}.</p></div>` +
    `<div class="tk"><b>Every payout was a genuinely dry season</b><p>In ${falseAlarms.join(" and ")} the satellites correctly saw a dry season and it paid out, but the cane coped and the harvest held up. Those payouts are built into the price below.</p></div>`
}
opts($('f-dist'), D.map((d, k) => [k, d.name]), BA)
function calc() {
  const k = +$('f-dist').value, S = IDX.seasons.filter((s) => s.final)
  const got = S.map((s) => 1000 * Math.max(s.early?.[k].due ?? 0, s.final[k].due))
  const total = got.reduce((a, b) => a + b, 0), times = got.filter((g) => g > 0).length
  $('calc').innerHTML = `<div><b>${F(total)}</b><span>received over ${S.length} years</span></div><div><b>${times}</b><span>payouts, in the worst seasons</span></div>` +
    `<div><b>${F(total / S.length)}</b><span>a year: the fair price of the cover, before costs</span></div>`
}
$('f-dist').oninput = calc
calc()

// ---------- 3. can it be cheated? (Ba, the 2010–11 season: a normal, wet year) ----------
const G = { k: BA, y: 2011, src: 'era5', other: 'power' }
let gameChain = null
function attack() {
  const { k, y, src, other } = G, f = +$('g-rain').value / 100, both = $('g-both').checked
  // A careful attacker lowers soil moisture along with the rain, scaled to each record's own spread (the two use different units).
  const spread = (s) => { const v = GUARD.sources[s].base[k].soil, m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }
  const fake = (rows, s) => { const d = (1 - f) * 2.5 * spread(s)
    return rows.map(([t, r, x]) => inSeason(t, y) ? [t, r == null ? r : +(r * f).toFixed(2), x == null ? x : +(x - d).toFixed(4)] : [t, r, x]) }
  const judge = (s, rows) => {
    const g = GUARD.sources[s], seasons = KEYS.map((key) => seasonAgg(DAYS[y][key][s], y))
    seasons[k] = seasonAgg(rows, y)
    const sc = score(features(k, seasons, g.base, rows, y, g.physics[k]), g.model), [rain, soil] = seasons[k]
    return { score: sc, limit: g.threshold, flagged: sc > g.threshold, dry: (pct(rain, g.base[k].rain) + pct(soil, g.base[k].soil)) / 2 }
  }
  const real = SEASON[y].final[k]
  const mine = judge(src, fake(DAYS[y][KEYS[k]][src], src))
  const theirs = both ? judge(other, fake(DAYS[y][KEYS[k]][other], other)) : { dry: real.sources[other].dryness, flagged: false, score: 0, limit: 1 }
  const gap = Math.abs(pm(mine.dry) - pm(theirs.dry)), index = (mine.dry + theirs.dry) / 2
  return { f, both, tampered: f < 1, mine, theirs, real, gap, agree: gap <= 250, wouldPay: gap <= 250 && index <= 0.2 }
}
// Each shield says what it actually does: only the second record can stop money moving; the AI check and the seal catch and expose.
function shield(id, state, html, held = 'Stopped you') {
  const el = $(id)
  el.className = `shield${state ? ` ${state}` : ''}`
  el.querySelector('p').innerHTML = html + (state ? `<br><span class="st">${state === 'stop' ? held : 'Got past'}</span>` : '')
}
function renderGame() {
  const a = attack()
  $('g-rain-v').textContent = a.f === 1 ? '100% of what fell' : `${Math.round(a.f * 100)}% of what fell`
  $('g-result').innerHTML = ''
  $('g-result').className = 'result'
  if (!a.tampered) {
    shield('s1', '', 'Trained on 30 years of real Fiji weather. Spots data that doesn\'t behave like the real thing.')
    shield('s2', '', `The contract only pays if the European and American records agree. Right now both say Ba's season was ${was(a.real.index)}.`)
    shield('s3', '', 'Every reading is sealed against the public archives, so anyone can check it later.')
    return
  }
  const caught = a.mine.flagged || (a.both && a.theirs.flagged)
  shield('s1', caught ? 'stop' : 'pass', caught ? `<b>Caught.</b> This doesn't look like real Ba weather (score ${a.mine.score.toFixed(1)}, limit ${a.mine.limit.toFixed(1)}). The verdict goes on-chain: any payout waits 14 days so it can be challenged.`
    : `<b>Slipped past.</b> Small fakes can look natural (score ${a.mine.score.toFixed(1)}, limit ${a.mine.limit.toFixed(1)}). That's why it's not the only shield.`, 'Caught you')
  shield('s2', a.agree ? (a.wouldPay ? 'pass' : '') : 'stop', !a.agree
    ? `<b>Blocked.</b> ${a.both ? 'Even faked, the two records' : `NASA says Ba's season was ${was(a.theirs.dry)}; you say ${was(a.mine.dry)}. They`} don't agree, so nothing pays.`
    : a.wouldPay ? `<b>Bypassed.</b> You faked both records so they agree on a ${kind((a.mine.dry + a.theirs.dry) / 2)}.`
    : `Your fake is too small to matter: the records still agree it was ${was((a.mine.dry + a.theirs.dry) / 2)}.`)
  shield('s3', 'stop', '<b>Exposed.</b> Your data no longer matches the seal anyone can check against Copernicus and NASA. The fraud is provable forever.', 'Exposed you')
}
$('g-rain').oninput = $('g-both').oninput = renderGame
renderGame()
$('g-go').onclick = async () => {
  const a = attack(), btn = $('g-go')
  btn.disabled = true
  btn.textContent = 'Sending to the contract…'
  try {
    gameChain ??= await newChain(3)
    const season = 3000 + Math.floor(Math.random() * 60000) // a fresh checkpoint every try
    const seal = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then((b) => '0x' + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''))
    const fakeSeal = a.tampered ? await seal(`faked ${Date.now()}`) : a.real.sources.era5.hash
    // The oracles run the data guard on what they received and post its verdict with the reading.
    const v1 = a.tampered ? verdict(a.mine.score / a.mine.limit) : realVerdict('final', G.y, G.k, 'era5')
    const v2 = a.both && a.tampered ? verdict(a.theirs.score / a.theirs.limit) : realVerdict('final', G.y, G.k, 'power')
    await gameChain.dc.write(K.era5, 'report', [season, 1, G.k, pm(a.mine.dry), v1, fakeSeal])
    const res = await gameChain.dc.write(K.power, 'report', [season, 1, G.k, pm(a.theirs.dry), v2, a.both && a.tampered ? fakeSeal : a.real.sources.power.hash])
    const paid = res.events.filter((e) => e.name === 'Paid'), amt = paid.reduce((s, e) => s + Number(e.args.amount / UNIT), 0)
    const r = $('g-result')
    if (res.events.some((e) => e.name === 'SourcesDisagree')) r.className = 'result no', r.innerHTML = '<b>Nothing paid.</b> The contract saw two records that disagree and refused. Your attempt is now on the public record for anyone to investigate.'
    else if (res.events.some((e) => e.name === 'PayoutHeld')) {
      r.className = 'result no'
      r.innerHTML = `<b>Payout held for 14 days: the AI flagged the data.</b> Both records agree on a drought, but the guard says they don't look like real Ba weather, and its verdict is on-chain. No money moves while anyone can challenge it.<span class="tx">Held in block #${res.block}</span>`
      await wait(1800)
      const rej = await gameChain.dc.write(K.insurer, 'reject', [season, 1, G.k])
      if (rej.events.some((e) => e.name === 'PayoutRejected'))
        r.innerHTML += `<span class="step"><b>Day 3:</b> the insurer downloads both records from Copernicus and NASA. They don't match the seals you posted, so it rejects the payout. You got F$0.</span><span class="tx">Rejected in block #${rej.block}</span>`
    }
    else if (paid.length) r.className = 'result yes', r.innerHTML = `<b>You got ${F(amt)}.</b> Your fake was subtle enough to get past the AI check too, so nothing was held. But the seal proves the data was faked: anyone who checks it can prove the fraud, forever.`
    else r.className = 'result no', r.innerHTML = `<b>Nothing paid.</b> Even with your fake, it wasn't a drought. ${a.tampered ? '' : 'Try moving the slider.'}`
  } catch (e) {
    $('g-result').className = 'result no'
    $('g-result').textContent = `The contract refused: ${e.message}`
  }
  btn.disabled = false
  btn.textContent = 'Claim the payout'
}

// ---------- 4. check it yourself, against the public archives, live ----------
opts($('ck-dist'), D.map((d, k) => [k, d.name]), BA)
opts($('ck-season'), IDX.seasons.filter((s) => s.final).map((s) => [s.season, `${s.season - 1}–${String(s.season).slice(2)}`]).reverse(), 1998)
const ckWhat = () => { const k = +$('ck-dist').value, y = +$('ck-season').value; $('ck-what').textContent = `${D[k].name}, November ${y - 1} – April ${y}`; $('ck-rows').innerHTML = '' }
$('ck-dist').oninput = $('ck-season').oninput = ckWhat
$('ck-other').onclick = () => { $('ck-pick').hidden = !$('ck-pick').hidden }
const sha = async (rows) => '0x' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))))].map((b) => b.toString(16).padStart(2, '0')).join('')
const liveRows = (src, d, y) => fetchRows(src, d, `${y - 1}-11-01`, `${y}-04-30`)
// Daily [date, rain, soil] straight from the public archives (both allow requests from any web page).
async function fetchRows(src, d, from, to, signal) {
  const json = (u) => fetch(u, { signal }).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
  if (src === 'era5') {
    const base = `https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${from}&end_date=${to}&timezone=Pacific%2FFiji`
    const [p, s] = await Promise.all([json(`${base}&daily=precipitation_sum&models=era5`), json(`${base}&daily=soil_moisture_0_to_100cm_mean&models=era5_land`)])
    return p.daily.time.map((t, i) => [t, p.daily.precipitation_sum[i], s.daily.soil_moisture_0_to_100cm_mean[i]])
  }
  const j = await json(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,GWETROOT&community=AG&longitude=${d.lon}&latitude=${d.lat}&start=${from.replaceAll('-', '')}&end=${to.replaceAll('-', '')}&format=JSON`)
  const { PRECTOTCORR: r, GWETROOT: w } = j.properties.parameter, fill = j.header.fill_value
  return Object.keys(r).map((k) => [`${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`, r[k] === fill ? null : r[k], w[k] === fill ? null : w[k]])
}
$('ck-go').onclick = async () => {
  const k = +$('ck-dist').value, y = +$('ck-season').value, rec = SEASON[y].final[k], btn = $('ck-go')
  btn.disabled = true
  btn.textContent = 'Downloading…'
  const NAMES = { era5: 'Copernicus ERA5 (Europe)', power: 'NASA POWER (USA)' }
  const rows = []
  let all = true
  for (const src of ['era5', 'power']) {
    const s = rec.sources[src]
    try {
      const live = (await liveRows(src, D[k], y)).filter(([t]) => t >= `${y - 1}-11-01` && t <= `${y}-04-31`)
      const hash = await sha(live), ok = hash === s.hash, rain = live.reduce((a, x) => a + (x[1] ?? 0), 0)
      all &&= ok
      rows.push(`<div class="ck-row ${ok ? 'ok' : 'bad'}"><span class="ic">${ok ? '✓' : '✗'}</span><div><b>${NAMES[src]}: ${ok ? 'matches the sealed record' : 'differs from the sealed record'}</b>` +
        `<span>${Math.round(rain)} mm of rain from November to April${ok ? '' : ` (sealed: ${Math.round(s.rain)} mm)`}</span><code>${hash}</code></div></div>`)
    } catch (e) {
      all = false
      rows.push(`<div class="ck-row bad"><span class="ic">!</span><div><b>${NAMES[src]}: couldn't download</b><span>${e.message}</span></div></div>`)
    }
  }
  const verdict = rec.due ? `paid ${Math.round(rec.due * 100)}% of the cover` : 'paid nothing'
  $('ck-rows').innerHTML = rows.join('') + `<div class="ck-sum">${all ? `Both records match. The contract ${verdict} for ${D[k].name} that season, based on real, unaltered data.` : 'Something doesn\'t match. That is exactly what the seal is for: anyone can spot it.'}</div>`
  btn.disabled = false
  btn.textContent = 'Download and check'
}

// ---------- 5. right now: the 2026–27 season, live ----------
const FIJI = 12 * 3600e3 // Fiji is UTC+12
const fijiDay = (ms) => new Date(ms + FIJI).toISOString().slice(0, 10)
const dayName = (iso) => { const [y, m, d] = iso.split('-'); return `${+d} ${LONG[m - 1]} ${y}` }
const degC = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}°C`
const NS = FC.now.season // the season ending in April of this year
{
  // This year's El Niño against 1997's, month by month.
  const { then, now } = FC.compare, last = now.months.findLastIndex((v) => v != null)
  $('nino-now').textContent = degC(now.months[last])
  $('nino-now-l').textContent = `${LONG[last]} ${now.year}`
  $('nino-then').textContent = degC(then.months[last])
  document.querySelector('.nino .k').textContent = `Pacific Ocean warmth (Niño-3.4), ${LONG[last]}`
  document.querySelector('.nino .then span').textContent = `${LONG[last]} ${then.year}, before the 1998 drought`
  const x = (i) => 6 + (i / 11) * 288, y = (v) => 70 - ((v + 1) / 4) * 64
  const line = (m, n) => m.slice(0, n).map((v, i) => `${x(i)},${y(v)}`).join(' ')
  $('nino-spark').innerHTML = `<line x1="0" x2="300" y1="${y(0)}" y2="${y(0)}" class="zero"/><polyline points="${line(then.months, 12)}" class="then"/>` +
    `<polyline points="${line(now.months, last + 1)}" class="now"/><circle cx="${x(last)}" cy="${y(now.months[last])}" r="4" class="now"/>`
}
// Countdown to the dates that matter (midnight in Fiji).
const DATES = [
  ['Cover sales close, season starts', Date.UTC(NS - 1, 9, 31, 12), `1 November ${NS - 1}`],
  ['Early check: 30% if severe', Date.UTC(NS, 0, 31, 12), `31 January ${NS}`],
  ['Final check', Date.UTC(NS, 3, 30, 12), `30 April ${NS}`],
]
function clock() {
  $('now-clock').innerHTML = DATES.map(([what, at, when]) => {
    const ms = at - Date.now(), d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5)
    return `<div class="cd${ms <= 0 ? ' done' : ''}"><b>${ms <= 0 ? '✓' : d}</b><span>${ms <= 0 ? 'done' : `${d === 1 ? 'day' : 'days'} ${h} h`}</span><p>${what}<small>${when}</small></p></div>`
  }).join('')
}
clock()
setInterval(clock, 60_000)
// The forecast and the price.
{
  const chance = FC.now.districts.reduce((a, d) => a + d.chance, 0) / D.length, price = FC.now.districts.reduce((a, d) => a + d.price, 0) / D.length
  const P = FC.pricing, n = FC.history.length
  const quiet = FC.history.filter((h) => h.nino >= 1 && h.districts.every((d) => !d.paid)).map((h) => h.season - 1)
  $('fc-chance').textContent = `${Math.round(chance * 100)}%`
  $('fc-base').textContent = `${Math.round(FC.base * 100)}%`
  $('fc-text').innerHTML = `A small model trained on ${n} seasons (${season(FC.history[0].season)} to ${season(FC.history.at(-1).season)}) learned one thing: the warmer the Pacific in August and September, the likelier Fiji's cane districts are to be paid. ` +
    `This year's reading (${degC(FC.now.nino)}) is beyond anything in its record, so it's treated as 1997-strength rather than guessed at. ` +
    `It's a chance, not a promise: strong El Niños in ${quiet.join(' and ')} brought no drought payouts. ` +
    `Tested on seasons it never saw, it beats always guessing the average by ${Math.round(FC.skill.score * 100)}%: modest, and honest.`
  $('fc-price').textContent = F(price * 1000)
  $('fc-why').innerHTML = `One flat price (${F(P.flat * 1000)} a year) only works if everyone buys every year. If people buy only when El Niño is showing, a flat-priced pool pays out <b>${P.flatLossRatio}×</b> what it takes in and goes broke. ` +
    `Priced by the forecast, those same buyers get back <b>${P.forecastLossRatio}×</b> what they pay: fair to them, safe for the pool. Sales close on 1 November, before the season's rain is known. ` +
    `A price this high in an El Niño year is where government or donor premium support matters most.`
}
// Today's readings: downloaded live from both archives, ranked like a checkpoint. Loaded when the section comes near.
let NOWDATA = null
async function track() {
  NOWDATA ??= await get('now.json')
  const from = `${NS - 1}-09-01`, to = [fijiDay(Date.now()), `${NS}-04-30`].sort()[0]
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20_000)
  const clean = (rows) => rows.filter(([t]) => t >= from && t <= to && !t.endsWith('-02-29'))
  let live = true
  const got = await Promise.all(D.map(async (d) => {
    try {
      const [era5, power] = await Promise.all(['era5', 'power'].map((s) => fetchRows(s, d, from, to, ctl.signal)))
      return { era5: clean(era5), power: clean(power) }
    } catch { live = false; return { era5: NOWDATA.districts[d.key].era5.snapshot, power: NOWDATA.districts[d.key].power.snapshot } }
  }))
  clearTimeout(timer)
  const started = got.every((g) => g.era5.length > SEASON_START && g.power.length > SEASON_START)
  const res = got.map((g, k) => trackDistrict(g, NOWDATA.districts[KEYS[k]], started ? SEASON_START : 0))
  const upto = res.map((r, k) => r && got[k].era5[r.to - 1][0]).filter(Boolean).sort()[0]
  const dry = res.filter((r) => r && r.index <= 0.2).length
  const cap = (t) => t[0].toUpperCase() + t.slice(1)
  $('now-grid').innerHTML = `<p class="now-sum">${started ? `Season so far, 1 November to ${dayName(upto)}` : `Going into the season, 1 September to ${dayName(upto)}`}: ` +
    `<b>${dry} of ${D.length} districts</b> are drier than 80% of years in the 30-year record.</p>` +
    res.map((r, k) => r ? `<div class="nd"><div class="nd-h"><b>${D[k].name}</b><span>${D[k].island}</span></div>` +
      `<div class="nd-v" style="--c:${colour(r.index)}">${cap(kind(r.index))}</div><p>${drierThan(r.index)}</p>` +
      `<div class="nd-bar"><i style="width:${Math.max(3, (1 - r.index) * 100)}%;background:${colour(r.index)}"></i></div>` +
      `<div class="nd-src"><span>Copernicus <b>${Math.round(r.era5.rain)} mm</b></span><span>NASA <b>${Math.round(r.power.rain)} mm</b></span>` +
      `<em class="${r.gap <= IDX.rules.maxGap ? 'ok' : 'no'}">${r.gap <= IDX.rules.maxGap ? 'Records agree' : 'Records disagree'}</em></div></div>` : '').join('')
  $('now-src').innerHTML = live
    ? `<span class="live red"></span>Downloaded live just now from Copernicus ERA5 (via Open-Meteo) and NASA POWER, readings to ${dayName(upto)}. The newest days are preliminary and can still be revised. Ranked against 1991–2020, exactly as the contract ranks a checkpoint.${started ? '' : ' From 1 November this switches to the season window the contract judges.'}`
    : `Couldn't reach the archives just now, so this is the copy saved on ${dayName(NOWDATA.lastDay)}. Reload to try again.`
}
new IntersectionObserver((e, o) => {
  if (!e.some((x) => x.isIntersecting)) return
  o.disconnect()
  track().catch((err) => { $('now-grid').innerHTML = `<p class="now-wait">Couldn't load today's readings: ${err.message}</p>` })
}, { rootMargin: '800px' }).observe($('now'))

// ---------- 6. 1998 at Fiji's real scale ----------
{
  const s = SEASON[1998], per = GROWERS / D.length
  const jan = s.early.reduce((a, r) => a + r.due, 0) * per * 1000, all = s.final.reduce((a, r, k) => a + Math.max(r.due, s.early[k].due), 0) * per * 1000
  $('scale').innerHTML = `<span>At Fiji's real scale</span><p>About ${GROWERS.toLocaleString()} cane growers with F$1,000 of cover each: <b>${millions(jan)}</b> in January 1998 and <b>${millions(all)}</b> by the end of April, each paid the day its check closed.</p>`
}

// ---------- 7. for insurers and funders: does the pool survive? ----------
let fPrice = 'forecast'
function funders() {
  const L = +$('f-load').value / 100, onlyElNino = $('f-elnino').checked, per = GROWERS / D.length, P = FC.pricing
  $('f-load-v').textContent = `${Math.round(L * 100)}%`
  // Each season: premiums collected at sale (before the season, priced by that year's forecast), then payouts by the rules.
  const rows = FC.history.map((h) => {
    const buys = !onlyElNino || h.nino >= 1
    const prem = buys ? h.districts.reduce((a, d) => a + (fPrice === 'flat' ? P.flat : d.chance * P.shareWhenPaid), 0) * (1 + L) * per * 1000 : 0
    const pay = buys ? h.districts.reduce((a, d) => a + d.paid, 0) * per * 1000 : 0
    return { season: h.season, prem, pay }
  })
  let cum = 0, low = 0
  for (const r of rows) cum += r.prem - r.pay, (r.cum = cum), (low = Math.min(low, cum))
  const capital = -low, worst = rows.reduce((a, r) => (r.pay > a.pay ? r : a))
  const totPrem = rows.reduce((a, r) => a + r.prem, 0), totPay = rows.reduce((a, r) => a + r.pay, 0)
  // Chart: the pool (starting with just enough capital never to run dry) and each season's payouts.
  const W = 900, H = 300, top = 16, bot = 30, max = Math.max(...rows.map((r) => capital + r.cum), ...rows.map((r) => r.pay), 1)
  const bw = (W - 40) / rows.length, x = (i) => 30 + i * bw + bw / 2, y = (v) => H - bot - (v / max) * (H - top - bot)
  const pool = rows.map((r, i) => `${x(i)},${y(capital + r.cum)}`).join(' ')
  $('f-svg').innerHTML = rows.map((r, i) => r.pay ? `<rect class="out" x="${x(i) - bw * 0.32}" y="${y(r.pay)}" width="${bw * 0.64}" height="${H - bot - y(r.pay)}"><title>${r.season}: paid ${millions(r.pay)}</title></rect>` : '').join('') +
    `<polygon class="pool-a" points="${x(0)},${H - bot} ${pool} ${x(rows.length - 1)},${H - bot}"/><polyline class="pool" points="${pool}"/>` +
    `<line class="axis" x1="20" x2="${W - 6}" y1="${H - bot}" y2="${H - bot}"/>` +
    rows.map((r, i) => (r.season % 5 === 0 || r.season === 1998) && r.season !== 2000 ? `<text x="${x(i)}" y="${H - 10}" class="${r.season === 1998 ? 'hl' : ''}">${r.season}</text>` : '').join('')
  const ratio = totPay / totPrem, end = capital + cum
  $('f-stats').innerHTML = `<div><b>${millions(worst.pay)}</b><span>worst season (${worst.season - 1}–${String(worst.season).slice(2)})</span></div>` +
    `<div><b>${millions(capital)}</b><span>capital needed up front so the pool never runs dry</span></div>` +
    `<div class="${end >= capital ? 'good' : 'bad'}"><b>${millions(end)}</b><span>in the pool after ${rows.length} seasons</span></div>` +
    `<div class="${ratio <= 1 ? 'good' : 'bad'}"><b>${ratio.toFixed(2)}×</b><span>paid out per F$1 of premium</span></div>`
}
$('f-price').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; fPrice = b.dataset.p; for (const x of $('f-price').children) x.classList.toggle('on', x === b); funders() }
$('f-load').oninput = $('f-elnino').oninput = funders
funders()
