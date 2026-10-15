import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { chain, demoKey, addressOf } from './evm.js'
import { inSeason, seasonAgg, features, score, pct } from './guard.js'
import { decide } from '../scripts/rules.mjs'
import { Interface } from 'ethers'
import { district as trackDistrict, dryness as rankRows, SEASON_START } from './now.js'

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
const K = { insurer: demoKey('insurer'), era5: demoKey('era5 oracle'), power: demoKey('nasa oracle'), chirps: demoKey('chirps oracle') }
async function newChain(perDistrict) {
  const c = await chain()
  for (const k of Object.values(K)) await c.fund(addressOf(k), 10n ** 9n * UNIT)
  const dc = await c.deploy(K.insurer, ART, [addressOf(K.era5), addressOf(K.power), addressOf(K.chirps)])
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
const pad = () => (innerWidth > 980 ? { top: 150, bottom: 150, left: Math.min(540, innerWidth * 0.4), right: 360 } : { top: 40, bottom: 50, left: 30, right: 50 })
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
    `${monthName(i).split(' ')[0]}<small>${i === 2 ? 'early<span class="wide"> check</span>' : i === 5 ? 'final<span class="wide"> check</span>' : ''}</small></li>`).join('')
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
      $('pl-note').textContent = `${label}: the climate records are reporting to the contract…`
      return
    }
    s.className = `status ${got ? 'paid' : 'calm'}`
    $('pl-note').textContent = got ? `${label}: the climate records agree ${name} is in ${was(x)}. ${F(got)} paid to you.`
      : step === 2 ? `${label}: ${name} isn't in a severe drought yet. Nothing paid, still watching.`
      : st?.you ? `${label}: season over at ${name}. You've been paid ${F(st.you)}.` : `${label}: ${name} had a ${kind(x)} season. No payout needed.`
    return
  }
  s.className = `status${x <= 0.2 ? ' alarm' : ''}`
  $('pl-note').textContent = `The records are watching the rain. So far ${name} is ${drierThan(x)}.`
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
  for (const t of document.querySelectorAll('.dm .cash')) t.remove() // one tag at a time: the districts sit close together
  const tag = document.createElement('b')
  tag.className = 'cash'
  tag.textContent = `+${F(amount)}`
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
    // Each oracle posts its reading, its data guard's verdict and the seal of the raw data behind it. Copernicus and NASA
    // first; CHIRPS (published a few weeks after the month ends) breaks a tie if they disagree, or is logged as a witness.
    await st.dc.write(K.era5, 'report', [year, s, k, pm(r.sources.era5.dryness), realVerdict(stage, year, k, 'era5'), r.sources.era5.hash])
    const first = await st.dc.write(K.power, 'report', [year, s, k, pm(r.sources.power.dryness), realVerdict(stage, year, k, 'power'), r.sources.power.hash])
    const third = r.sources.chirps ? await st.dc.write(K.chirps, 'report', [year, s, k, pm(r.sources.chirps.dryness), 0, r.sources.chirps.hash]) : null
    const evs = [...first.events, ...(third?.events ?? [])], has = (n) => evs.some((e) => e.name === n)
    const res = third?.events.some((e) => e.name === 'Settled' || e.name === 'Paid') ? third : first
    const settled = evs.find((e) => e.name === 'Settled'), paid = evs.filter((e) => e.name === 'Paid')
    const name = D[k].name, when = stage === 'early' ? `31 Jan ${year}` : `30 Apr ${year}`
    if (!settled) { log('bad', first.block, `${name} · Copernicus and NASA disagree · waiting for the CHIRPS satellite record to break the tie`); tally(); paint(); continue }
    st.settled++
    const idx = Number(settled.args.index) / 1000, w = evs.find((e) => e.name === 'Witness')
    const how = has('AwaitingTieBreak') ? 'Copernicus and NASA disagreed, CHIRPS broke the tie' : `Copernicus and NASA agree${w ? (w.args.agrees ? ', CHIRPS confirms' : ', CHIRPS disagrees') : ''}`
    if (has('SourcesDisagree')) st.disagree++, log('bad', res.block, `${name} · no two of the three records agree · nothing paid`)
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
      log('pay', res.block, `${name} · ${how}: ${kind(idx)} · ${paid.length} farmers paid ${F(amt)} · ${short(res.hash)}`)
      if (k === farm) {
        const each = Number(paid[0].args.amount / UNIT)
        st.you += each
        st.got[stage === 'early' ? 2 : 5] = each
        $('ph-bal').classList.add('bump'); setTimeout(() => $('ph-bal').classList.remove('bump'), 400)
        $('ph-date').textContent = `Your cane farm · ${when}`
        notify(`${F(each)} received.`, stage === 'early'
          ? `Drought confirmed at ${name}: ${drierThan(idx)}. The climate records agree. Use it for water, feed and seed.`
          : `The season ended ${drierThan(idx)}. That's ${F(st.you)} this season.`, when)
      }
    } else {
      log('', res.block, `${name} · ${how}: ${kind(idx)} · no payout needed`)
      if (k === farm && stage === 'final' && !st.you) notify('No payout this season.', `${name} had a ${kind(idx)} season. Your cover continues.`, when)
    }
    tally()
    paint()
    await wait(paid.length ? 450 : 120) // let each payout's tag be seen before the next district
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
const goLabel = () => (farm === BA && year === 1998 ? 'Watch the 1998 drought' : `Play ${D[farm].name}, ${season(year)}`)
function setPlay(on) {
  $('pl-play').innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zM14 5h3v14h-3z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
  $('pl-play').setAttribute('aria-label', on ? 'Pause' : 'Play')
  $('go').querySelector('span').textContent = on ? 'Playing…' : step >= 5 ? 'Play it again' : goLabel()
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
$('try-other').onclick = () => {
  const open = $('try').hidden
  $('try').hidden = !open
  $('try-other').setAttribute('aria-expanded', open)
  $('try-other').textContent = open ? 'Hide the picker' : 'Try another farm or year'
  document.querySelector('.pitch').classList.toggle('picking', open) // make room: the intro has been read by now
}
drawStrip()
load(year)
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
    `<div class="tk"><b>Every payout was a genuinely dry season</b><p>In ${falseAlarms.join(" and ")} the climate records correctly saw a dry season and it paid out, but the cane coped and the harvest held up. Those payouts are built into the price below.</p></div>`
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
    return { score: sc, limit: g.threshold, flagged: sc > g.threshold, rain, dry: (pct(rain, g.base[k].rain) + pct(soil, g.base[k].soil)) / 2 }
  }
  const real = SEASON[y].final[k]
  const mine = judge(src, fake(DAYS[y][KEYS[k]][src], src))
  const theirs = both ? judge(other, fake(DAYS[y][KEYS[k]][other], other)) : { dry: real.sources[other].dryness, flagged: false, score: 0, limit: 1 }
  // The third record, CHIRPS (satellite and rain gauges), isn't hacked: it reports what really fell.
  const sat = real.sources.chirps.dryness, d = decide({ era5: mine.dry, power: theirs.dry, chirps: sat })
  return { f, both, tampered: f < 1, mine, theirs, real, sat, d, agree: d.deciders[0] === 'era5' && d.deciders[1] === 'power', outvoted: d.deciders.includes('chirps'), wouldPay: d.index != null && d.index <= 0.2 }
}
// Each shield says what it actually does: only the second record can stop money moving; the AI check and the seal catch and expose.
function shield(id, state, html, held = 'Stopped you') {
  const el = $(id)
  el.className = `shield${state ? ` ${state}` : ''}`
  el.querySelector('p').innerHTML = html + (state ? `<br><span class="st">${state === 'stop' ? held : 'Got past'}</span>` : '')
}
function renderGame() {
  const a = attack()
  $('g-rain-v').textContent = a.f === 1 ? 'the true amount' : a.f === 0 ? 'no rain at all' : `only ${Math.round(a.f * 100)}% of the true amount`
  $('g-result').innerHTML = ''
  $('g-result').className = 'result'
  if (!a.tampered) {
    shield('s1', '', 'Trained on 30 years of real Fiji weather. Spots data that doesn\'t behave like the real thing.')
    shield('s2', '', `Three independent records watch Ba: Copernicus (Europe), NASA (USA) and the CHIRPS satellite record. Two must agree. Right now all say Ba's season was ${was(a.real.index)}.`)
    shield('s3', '', 'Every reading is sealed against the public archives, so anyone can check it later.')
    return
  }
  const caught = a.mine.flagged || (a.both && a.theirs.flagged)
  shield('s1', caught ? 'stop' : 'pass', caught ? `<b>Caught.</b> This doesn't look like real Ba weather (strangeness ${a.mine.score.toFixed(1)}; anything over ${a.mine.limit.toFixed(1)} gets flagged). This warning is recorded publicly, and any payout waits 14 days so it can be checked.`
    : `<b>Slipped past.</b> Small fakes can look natural (strangeness ${a.mine.score.toFixed(1)}; the flag goes up over ${a.mine.limit.toFixed(1)}). The other two shields still apply.`, 'Caught you')
  shield('s2', a.outvoted ? 'stop' : a.agree && a.wouldPay ? 'pass' : a.d.index == null ? 'stop' : '', a.outvoted
    ? `<b>Outvoted.</b> You say Ba's season was ${was(a.mine.dry)}. NASA and the CHIRPS satellite record both say ${was(a.d.index)}. Two of three decide, so your record is ignored.`
    : a.d.index == null ? '<b>Blocked.</b> No two of the three records agree, so nothing pays.'
    : a.wouldPay ? `<b>Bypassed.</b> You faked both so they agree on a ${kind(a.d.index)}. The CHIRPS satellite record, when it arrives, says ${was(a.sat)}: that goes on the record too.`
    : `Your fake is too small to matter: the records still agree it was ${was(a.d.index)}.`, 'Outvoted you')
  shield('s3', 'stop', '<b>Exposed.</b> Your data no longer matches the seal, and anyone can check it against Copernicus and NASA to prove it was faked.', 'Exposed you')
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
    let res = await gameChain.dc.write(K.power, 'report', [season, 1, G.k, pm(a.theirs.dry), v2, a.both && a.tampered ? fakeSeal : a.real.sources.power.hash])
    const r = $('g-result'), waiting = res.events.some((e) => e.name === 'AwaitingTieBreak')
    // Copernicus and NASA disagree: the contract waits for the satellite record to break the tie.
    if (waiting) res = await gameChain.dc.write(K.chirps, 'report', [season, 1, G.k, pm(a.sat), 0, a.real.sources.chirps.hash])
    const paid = res.events.filter((e) => e.name === 'Paid'), amt = paid.reduce((s, e) => s + Number(e.args.amount / UNIT), 0)
    const decided = res.events.find((e) => e.name === 'Settled')
    if (waiting && decided && Number(decided.args.b) === 2 && !paid.length) r.className = 'result no', r.innerHTML = `<b>Nothing paid. You were outvoted.</b> Your record disagreed with NASA, so the contract waited for the CHIRPS satellite record. It sided with NASA: Ba's season was ${was(Number(decided.args.index) / 1000)}. Your attempt stays on the public record.<span class="tx">Decided in block #${res.block}</span>`
    else if (res.events.some((e) => e.name === 'SourcesDisagree')) r.className = 'result no', r.innerHTML = '<b>Nothing paid.</b> No two of the three records agree, so the contract refused. Your attempt is now on the public record for anyone to investigate.'
    else if (res.events.some((e) => e.name === 'PayoutHeld')) {
      r.className = 'result no'
      r.innerHTML = `<b>Payout held for 14 days: the AI flagged the data.</b> Your faked Copernicus and NASA records agree on a drought, but the guard says they don't look like real Ba weather, and its verdict is on-chain. No money moves while anyone can challenge it.<span class="tx">Held in block #${res.block}</span>`
      await wait(1800)
      const bothFlagged = v1 > 1000 && v2 > 1000
      if (!bothFlagged) {
        r.innerHTML += `<span class="step"><b>Only one guard flagged it,</b> so the insurer can't reject it alone (that stops an insurer and one oracle cancelling real payouts). It waits out the 14 days, but the seal still proves your data was faked.</span>`
        return
      }
      const rej = await gameChain.dc.write(K.insurer, 'reject', [season, 1, G.k])
      if (rej.events.some((e) => e.name === 'PayoutRejected'))
        r.innerHTML += `<span class="step"><b>Day 3:</b> both guards flagged it, so the insurer may reject it. It downloads the records from Copernicus and NASA: your Copernicus data says ${Math.round(a.mine.rain)} mm of rain fell, the public archive says ${Math.round(a.real.sources.era5.rain)} mm. That's ${Math.round(a.real.sources.era5.rain - a.mine.rain)} mm apart, nothing like the 0.1 mm here and there that archives sometimes revise. It rejects the payout. You got F$0.</span><span class="tx">Rejected in block #${rej.block}</span>`
    }
    else if (paid.length) r.className = 'result yes', r.innerHTML = `<b>You got ${F(amt)}.</b> Your fake was subtle enough to get past the AI check too, so nothing was held. Anyone who checks the seal against Copernicus and NASA can still prove the data was faked.`
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
const liveRows = (src, d, y) => (src === 'chirps' ? chirpsRows(d, `${y - 1}-11-01`, `${y}-04-30`) : fetchRows(src, d, `${y - 1}-11-01`, `${y}-04-30`))
// CHIRPS daily rainfall via ClimateSERV (NASA/USAID SERVIR): submit a job, wait for it, read it. Same cell and rounding as scripts/fetch-chirps.mjs.
async function chirpsRows(d, from, to) {
  const API = 'https://climateserv.servirglobal.net/api', us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`, hh = 0.025
  const box = { type: 'Polygon', coordinates: [[[d.lon - hh, d.lat - hh], [d.lon + hh, d.lat - hh], [d.lon + hh, d.lat + hh], [d.lon - hh, d.lat + hh], [d.lon - hh, d.lat - hh]]] }
  const q = new URLSearchParams({ datatype: 0, begintime: us(from), endtime: us(to), intervaltype: 0, operationtype: 5, dateType_Category: 'default', isZip_CurrentDataType: false, geometry: JSON.stringify(box) })
  const json = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
  const [id] = await json(`${API}/submitDataRequest/?${q}`)
  for (let i = 0; i < 60; i++) { const [p] = await json(`${API}/getDataRequestProgress/?id=${id}`); if (p >= 100) break; if (p < 0) throw new Error('ClimateSERV job failed'); await wait(2000) }
  const { data } = await json(`${API}/getDataFromRequest/?id=${id}`)
  return data.map((r) => [`${r.year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`, r.value.avg < 0 ? null : +r.value.avg.toFixed(2)])
}
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
  const NAMES = { era5: 'Copernicus ERA5 (Europe)', power: 'NASA POWER (USA)', chirps: 'CHIRPS satellite record (UC Santa Barbara)' }
  const rows = [], dry = {}
  let exact = true, failed = false
  NOWDATA ??= await get('now.json') // the 1991–2020 baseline, to re-rank revised data the way the contract did
  for (const src of ['era5', 'power', 'chirps']) {
    const s = rec.sources[src]
    if (!s) continue
    if (src === 'chirps') btn.textContent = 'Asking the satellite archive…'
    try {
      const live = (await liveRows(src, D[k], y)).filter(([t]) => t >= `${y - 1}-11-01` && t <= `${y}-04-31`)
      const hash = await sha(live), ok = hash === s.hash, rain = live.reduce((a, x) => a + (x[1] ?? 0), 0)
      exact &&= ok
      if (ok) {
        dry[src] = s.dryness
        rows.push(`<div class="ck-row ok"><span class="ic">✓</span><div><b>${NAMES[src]}: identical to the sealed record</b>` +
          `<span>${Math.round(rain)} mm of rain from November to April</span><code>${hash}</code></div></div>`)
      } else {
        // Archives are sometimes revised (often by 0.1 mm here and there). Say how much, and whether it matters.
        if (src === 'chirps') {
          dry[src] = s.dryness // no baseline shipped for CHIRPS: keep its sealed ranking, report the change in rainfall
          rows.push(`<div class="ck-row rev"><span class="ic">≈</span><div><b>${NAMES[src]}: the archive has been revised since this was sealed</b>` +
            `<span>${rain.toFixed(1)} mm of rain now, ${s.rain.toFixed(1)} mm when sealed.</span><code>now ${hash}<br>sealed ${s.hash}</code></div></div>`)
          continue
        }
        const days = live.filter(([t]) => !t.endsWith('-02-29')), padded = [...Array(SEASON_START).fill([null, null, null]), ...days]
        dry[src] = rankRows(padded, NOWDATA.districts[KEYS[k]][src].base, SEASON_START, padded.length).dryness
        const same = kind(dry[src]) === kind(s.dryness)
        rows.push(`<div class="ck-row ${same ? 'rev' : 'bad'}"><span class="ic">≈</span><div><b>${NAMES[src]}: the archive has been revised since this was sealed</b>` +
          `<span>${rain.toFixed(1)} mm of rain now, ${s.rain.toFixed(1)} mm when sealed. ${same ? `Still ranked ${kind(dry[src])}, the same as when sealed.` : `Now ranked ${kind(dry[src])}; it was ${kind(s.dryness)} when sealed.`}</span>` +
          `<code>now ${hash}<br>sealed ${s.hash}</code></div></div>`)
      }
    } catch (e) {
      failed = true
      rows.push(`<div class="ck-row bad"><span class="ic">!</span><div><b>${NAMES[src]}: couldn't download</b><span>${e.message}</span></div></div>`)
    }
  }
  const verdict = (due) => (due ? `paid ${Math.round(due * 100)}% of the cover` : 'paid nothing')
  // What the contract would decide from today's archive, by the same rules.
  const now = decide({ era5: dry.era5, power: dry.power, chirps: dry.chirps }), R = IDX.rules
  const dueNow = now.index == null ? 0 : now.index <= R.severe.at ? R.severe.pay : now.index <= R.moderate.at ? R.moderate.pay : 0
  $('ck-rows').innerHTML = rows.join('') + `<div class="ck-sum">${failed ? 'One of the archives didn\'t answer. Try again in a moment.'
    : exact ? `Every record matches exactly. The contract ${verdict(rec.due)} for ${D[k].name} that season, based on real, unaltered data.`
    : dueNow === rec.due ? `The archive has been revised slightly since the seal was made, which happens with reanalysis data. The decision doesn't change: by the same rules, today's data also ${verdict(dueNow).replace('paid', 'pays')}. The seal proves exactly which data the contract used.`
    : `The revised archive would change the decision (${verdict(dueNow).replace('paid', 'pays')} instead of ${verdict(rec.due).replace('paid ', '')}). The seal proves which data the contract actually used, so any dispute can be settled.`}</div>`
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
  document.querySelector('.nino .k').textContent = `How much warmer than normal the Pacific is, ${LONG[last]}`
  document.querySelector('.nino .then span').textContent = `${LONG[last]} ${then.year}, before the 1998 drought`
  // Drawn at fixed proportions (it scales as a whole), with a degrees scale, months and labelled lines.
  const W = 640, H = 190, L = 44, R = 64, T = 12, B = 26, lo = -1, hi = 3
  const x = (i) => L + (i / 11) * (W - L - R), y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B)
  const line = (m, n) => m.slice(0, n).map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const grid = [-1, 0, 1, 2, 3].map((v) => `<line x1="${L}" x2="${W - R + 8}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'zero' : 'grid'}"/><text x="${L - 8}" y="${y(v) + 4}" class="yl">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}°</text>`).join('')
  const months = 'JFMAMJJASOND'.split('').map((m, i) => `<text x="${x(i)}" y="${H - 6}" class="ml">${m}</text>`).join('')
  $('nino-spark').innerHTML = grid + months +
    `<polyline points="${line(then.months, 12)}" class="then"/><text x="${x(11) + 8}" y="${y(then.months[11]) + 4}" class="tl then">${then.year}</text>` +
    `<polyline points="${line(now.months, last + 1)}" class="now"/><circle cx="${x(last)}" cy="${y(now.months[last])}" r="5" class="now"/>` +
    `<text x="${x(last) + 10}" y="${y(now.months[last]) - 8}" class="tl now">${now.year}</text>`
}
// Countdown to the dates that matter (midnight in Fiji).
const DATES = [
  ['Sales close', Date.UTC(NS - 1, 9, 31, 12), `1 November ${NS - 1}`],
  ['Early check', Date.UTC(NS, 0, 31, 12), `31 January ${NS}`],
  ['Final check', Date.UTC(NS, 3, 30, 12), `30 April ${NS}`],
]
function clock() {
  $('now-clock').innerHTML = DATES.map(([what, at, when]) => {
    const ms = at - Date.now(), d = Math.ceil(ms / 864e5)
    return `<span class="cd${ms <= 0 ? ' done' : ''}">${what} (${when}): <b>${ms <= 0 ? 'done ✓' : `in ${d} ${d === 1 ? 'day' : 'days'}`}</b></span>`
  }).join('')
}
clock()
setInterval(clock, 60_000)
// The forecast and the price.
{
  const chance = FC.now.districts.reduce((a, d) => a + d.chance, 0) / D.length, price = FC.now.districts.reduce((a, d) => a + d.price, 0) / D.length
  const P = FC.pricing, n = FC.history.length
  const quiet = FC.history.filter((h) => h.nino >= 1 && h.districts.every((d) => !d.paid)).map((h) => season(h.season))
  $('fc-chance').textContent = `${Math.round(chance * 100)}%`
  $('fc-base').textContent = `${Math.round(FC.base * 100)}%`
  $('fc-text').innerHTML = `We taught a simple computer model using ${n} past seasons. It learned that when the Pacific Ocean is warmer than usual in August and September (El Niño), droughts are much more likely. This year the ocean is warmer than in any of them. It can be wrong: in ${quiet.join(' and ')} the ocean was warm too, and no drought payout was needed.`
  $('fc-price').textContent = F(price * 1000)
  if (price > FC.pricing.flat) $('fc-sponsor').innerHTML = `With a premium sponsor, a farmer pays <b>${F(FC.pricing.flat * 1000)}</b>, the normal-year price, and the sponsor pays the other <b>${F((price - FC.pricing.flat) * 1000)}</b>. <a href="#funders">How sponsors work ↓</a>`
  $('fc-why').innerHTML = `If the price never changed, people would only buy when a drought was coming, and the pool would pay out about F$${Math.round(P.flatLossRatio)} for every F$1 it took in. So the price rises in risky years and falls in calm ones. Sales close on 1 November, before anyone knows how much rain will fall.`
}
// Today's readings, ranked like a checkpoint. The saved copy shows straight away; today's download replaces it when it lands.
let NOWDATA = null
async function track() {
  NOWDATA ??= await get('now.json')
  const saved = D.map((d) => ({ era5: NOWDATA.districts[d.key].era5.snapshot, power: NOWDATA.districts[d.key].power.snapshot }))
  showNow(saved, 'saved')
  const from = `${NS - 1}-09-01`, to = [fijiDay(Date.now()), `${NS}-04-30`].sort()[0]
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25_000)
  const clean = (rows) => rows.filter(([t]) => t >= from && t <= to && !t.endsWith('-02-29'))
  try {
    const got = await Promise.all(D.map(async (d) => {
      const [era5, power] = await Promise.all(['era5', 'power'].map((s) => fetchRows(s, d, from, to, ctl.signal)))
      return { era5: clean(era5), power: clean(power) }
    }))
    showNow(got, 'live')
  } catch { showNow(saved, 'offline') }
  clearTimeout(timer)
}
function showNow(got, mode) {
  const started = got.every((g) => g.era5.length > SEASON_START && g.power.length > SEASON_START)
  const res = got.map((g, k) => trackDistrict(g, NOWDATA.districts[KEYS[k]], started ? SEASON_START : 0))
  const upto = res.map((r, k) => r && got[k].era5[r.to - 1][0]).filter(Boolean).sort()[0]
  const dry = res.filter((r) => r && r.index <= 0.2).length
  const cap = (t) => t[0].toUpperCase() + t.slice(1)
  // Before 1 November nothing can trigger yet, so don't use the trigger's words ("drought") for pre-season dryness.
  const label = (x) => (!started && x <= 0.2 ? 'very dry' : kind(x))
  $('now-grid').innerHTML = `<p class="now-sum">${started ? `Season so far, 1 November to ${dayName(upto)}` : `Going into the season, 1 September to ${dayName(upto)}`}: ` +
    `<b>${dry} of ${D.length} districts</b> are drier than 80% of years in the 30-year record.</p>` +
    res.map((r, k) => r ? `<div class="nd"><div class="nd-h"><b>${D[k].name}</b><span>${D[k].island}</span></div>` +
      `<div class="nd-v" style="--c:${colour(r.index)}">${cap(label(r.index))}</div><p>${drierThan(r.index)}</p>` +
      `<div class="nd-bar"><i style="width:${Math.max(3, (1 - r.index) * 100)}%;background:${colour(r.index)}"></i></div>` +
      `<div class="nd-src"><span>Copernicus <b>${Math.round(r.era5.rain)} mm</b></span><span>NASA <b>${Math.round(r.power.rain)} mm</b></span>` +
      `<em class="${r.gap <= IDX.rules.maxGap ? 'ok' : 'no'}">${r.gap <= IDX.rules.maxGap ? 'Records agree' : 'Records disagree'}</em></div></div>` : '').join('')
  $('now-src').innerHTML = mode === 'live'
    ? `<span class="live red"></span>Downloaded live from Copernicus ERA5 (via Open-Meteo) and NASA POWER, readings to ${dayName(upto)}. The last few days may still be corrected by the agencies.${started ? '' : ' From 1 November this switches to the season window the contract judges.'}`
    : mode === 'saved' ? `Saved readings to ${dayName(upto)}. Checking Copernicus and NASA for newer ones…`
    : `Saved readings to ${dayName(upto)}: the archives didn't answer just now. Reload to try again.`
}
// Sealed on a public test network: this season's forecast and pre-season readings, timestamped (see scripts/testnet.mjs).
fetch('/data/testnet.json').then((r) => (r.ok ? r.json() : null)).then((t) => {
  if (!t?.address) return
  const forecast = t.sealed.filter((x) => x.what === 'forecast'), readings = t.sealed.filter((x) => x.what.startsWith('pre-season'))
  const when = forecast[0]?.at ? new Date(forecast[0].at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
  const posted = t.reports?.length ? ` The oracles have since posted ${t.reports.length} readings for this season.` : ' Come back after 31 January 2027 to see whether it was right.'
  const old = t.previous?.at(-1)
  $('sealed').hidden = false
  $('sealed').innerHTML = `<b>Sealed on ${when}, before the rain falls.</b> This forecast and ${readings.length} pre-season readings are on ${t.network}, timestamped. Nobody can change them, including us.${posted}` +
    `<span class="links"><a href="${t.contract}" target="_blank" rel="noopener">The contract</a> · <a href="https://repo.sourcify.dev/${t.chainId}/${t.address}" target="_blank" rel="noopener">its verified source code</a>${forecast[0] ? ` · <a href="${forecast[0].tx}" target="_blank" rel="noopener">the sealed forecast</a>` : ''} · <button class="lnk" id="seal-check">Check these seals yourself</button></span>` +
    (old ? `<small>This replaces a first version from earlier the same day. ${old.reason}. <a href="${old.contract}" target="_blank" rel="noopener">The first version</a> stays on the record.</small>` : '') +
    '<div class="seal-out" id="seal-out" hidden></div>'
  $('seal-check').onclick = () => checkSeals(t)
}).catch(() => {})
// Recomputes every seal's fingerprint from the inputs published with the site, then reads the same seal from the
// blockchain itself (not from us) and compares the two.
async function checkSeals(t) {
  const out = $('seal-out'), btn = $('seal-check')
  out.hidden = false
  out.textContent = 'Reading the blockchain…'
  btn.disabled = true
  try {
    const RPC = { 11155111: 'https://ethereum-sepolia-rpc.publicnode.com', 84532: 'https://sepolia.base.org' }[t.chainId]
    const rpc = (method, params) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()).then((j) => j.result)
    const inputs = await get('sealed-inputs.json'), iface = new Interface(ART.abi)
    let ok = 0, firstTime = null
    for (const s of t.sealed) {
      const data = s.what === 'forecast' ? inputs.forecast : inputs.preSeason[s.district]?.[s.what.split(' ')[1]]
      const mine = await sha(data)
      const receipt = await rpc('eth_getTransactionReceipt', [s.tx.split('/tx/')[1]])
      const log = receipt?.logs.map((l) => { try { return iface.parseLog(l) } catch { return null } }).find((e) => e?.name === 'Sealed')
      if (log && log.args[4] === mine && Number(log.args[3]) === Math.round(s.value * 1000) && receipt.to.toLowerCase() === t.address.toLowerCase()) ok++
      if (log && !firstTime) firstTime = Number(log.args[6])
    }
    const at = firstTime ? new Date(firstTime * 1000).toUTCString().replace(' GMT', ' UTC') : '?'
    out.className = `seal-out ${ok === t.sealed.length ? 'ok' : 'bad'}`
    out.innerHTML = ok === t.sealed.length
      ? `<b>✓ All ${ok} seals match.</b> We recomputed each fingerprint from the forecast and readings published with this site, and read the same seals straight from the blockchain. They were written at ${at}, before the season began, and haven't changed.`
      : `<b>${ok} of ${t.sealed.length} seals match.</b> Any that don't would show the published data was changed after sealing.`
  } catch (e) { out.textContent = `Couldn't reach the blockchain just now (${e.message}). Try again in a moment.` }
  btn.disabled = false
}
// Start soon after the page loads (not on scroll), so the cards are filled long before anyone reaches them.
setTimeout(() => track().catch(() => {}), 1200)

// ---------- 6. 1998 at Fiji's real scale ----------
{
  const s = SEASON[1998], per = GROWERS / D.length
  const jan = s.early.reduce((a, r) => a + r.due, 0) * per * 1000, all = s.final.reduce((a, r, k) => a + Math.max(r.due, s.early[k].due), 0) * per * 1000
  $('scale').innerHTML = `<span>At Fiji's real scale</span><p>About ${GROWERS.toLocaleString()} cane growers with F$1,000 of cover each: <b>${millions(jan)}</b> in January 1998 and <b>${millions(all)}</b> by the end of April, each paid the day its check closed.</p>`
}

// ---------- 7. for insurers and funders: does the pool survive? ----------
let fPrice = 'forecast'
function funders() {
  const L = +$('f-load').value / 100, onlyElNino = $('f-elnino').checked, sponsored = $('f-sponsor').checked && fPrice === 'forecast', per = GROWERS / D.length, P = FC.pricing
  $('f-sponsor').closest('label').hidden = fPrice !== 'forecast'
  let fromSponsors = 0, sponsorSeasons = 0, farmerMax = 0
  $('f-load-v').textContent = `${Math.round(L * 100)}%`
  // Each season: premiums collected at sale (before the season, priced by that year's forecast), then payouts by the rules.
  const rows = FC.history.map((h) => {
    const buys = !onlyElNino || h.nino >= 1
    const prem = buys ? h.districts.reduce((a, d) => a + (fPrice === 'flat' ? P.flat : d.chance * P.shareWhenPaid), 0) * (1 + L) * per * 1000 : 0
    // A sponsor pays whatever the forecast price is above the normal-year price, so farmers never pay more than that.
    if (buys && sponsored) {
      const extra = h.districts.reduce((a, d) => a + Math.max(0, d.chance * P.shareWhenPaid - P.flat), 0) * (1 + L) * per * 1000
      if (extra > 0) fromSponsors += extra, sponsorSeasons++
      farmerMax = Math.max(farmerMax, Math.min(P.flat, Math.max(...h.districts.map((d) => d.chance * P.shareWhenPaid))) * (1 + L) * 1000)
    }
    const pay = buys ? h.districts.reduce((a, d) => a + d.paid, 0) * per * 1000 : 0
    return { season: h.season, prem, pay }
  })
  let cum = 0, low = 0
  for (const r of rows) cum += r.prem - r.pay, (r.cum = cum), (low = Math.min(low, cum))
  const capital = -low, worst = rows.reduce((a, r) => (r.pay > a.pay ? r : a))
  const totPrem = rows.reduce((a, r) => a + r.prem, 0), totPay = rows.reduce((a, r) => a + r.pay, 0)
  // Chart: the pool (starting with just enough capital never to run dry) and each season's payouts.
  const W = 900, H = 320, top = 16, bot = 30, left = 78, raw = Math.max(...rows.map((r) => capital + r.cum), ...rows.map((r) => r.pay), 1)
  const p10 = 10 ** Math.floor(Math.log10(raw / 4)), tick = [1, 2, 2.5, 5, 10].map((m) => m * p10).find((t) => raw / t <= 4.5), max = Math.ceil(raw / tick) * tick
  const bw = (W - left - 10) / rows.length, x = (i) => left + i * bw + bw / 2, y = (v) => H - bot - (v / max) * (H - top - bot)
  const pool = rows.map((r, i) => `${x(i)},${y(capital + r.cum)}`).join(' ')
  const grid = Array.from({ length: Math.round(max / tick) + 1 }, (_, k) => k * tick)
    .map((v) => `<line class="grid" x1="${left - 4}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}"/><text class="yl" x="${left - 10}" y="${y(v) + 4}">F${+(v / 1e6).toFixed(1)}M</text>`).join('')
  // The hardest year: where the pool runs lowest, which is what the starting capital has to cover.
  const hard = rows.reduce((a, r, i) => (r.cum < rows[a].cum ? i : a), 0), hx = x(hard), hy = y(capital + rows[hard].cum)
  const right = hard > rows.length * 0.6
  const note = capital > 0 ? `${rows[hard].season}: the hardest year. The ${millions(capital)} set aside at the start covers it.` : 'The pool never needed money set aside'
  $('f-svg').innerHTML = grid + rows.map((r, i) => r.pay ? `<rect class="out" x="${x(i) - bw * 0.32}" y="${y(r.pay)}" width="${bw * 0.64}" height="${H - bot - y(r.pay)}"><title>${r.season}: paid ${millions(r.pay)}</title></rect>` : '').join('') +
    `<polygon class="pool-a" points="${x(0)},${H - bot} ${pool} ${x(rows.length - 1)},${H - bot}"/><polyline class="pool" points="${pool}"/>` +
    `<line class="axis" x1="20" x2="${W - 6}" y1="${H - bot}" y2="${H - bot}"/>` +
    rows.map((r, i) => (r.season % 5 === 0 || r.season === 1998) && r.season !== 2000 ? `<text x="${x(i)}" y="${H - 10}" class="${r.season === 1998 ? 'hl' : ''}">${r.season}</text>` : '').join('') +
    (capital > 0 ? `<line class="lead" x1="${hx}" x2="${hx}" y1="${hy - 8}" y2="${top + 34}"/><circle class="hard" cx="${hx}" cy="${hy}" r="6"/>` +
      `<text class="note" x="${hx + (right ? -10 : 10)}" y="${top + 40}" text-anchor="${right ? 'end' : 'start'}">${note}</text>` : '')
  const ratio = totPay / totPrem, profit = totPrem - totPay
  const back = ratio <= 1 ? `${Math.round(ratio * 100)} cents` : `F$${ratio.toFixed(2)}`
  $('f-sponsor-out').hidden = !sponsored
  if (sponsored) $('f-sponsor-out').innerHTML = `<b>Sponsors:</b> ${millions(fromSponsors)} over ${rows.length} seasons, in the ${sponsorSeasons} riskiest years only. With it, no farmer ever paid more than <b>${F(farmerMax)}</b> a year for F$1,000 of cover. On a blockchain, every sponsor dollar can be traced to the district and season it protected. A government could fund this from climate finance such as the new UN Fund for responding to Loss and Damage.`
  $('f-verdict').className = `f-verdict ${ratio <= 1 ? 'good' : 'bad'}`
  $('f-verdict').innerHTML = ratio <= 1
    ? `<b>✓ The pool works.</b> For every F$1 farmers pay, ${back} is paid back to them. The rest pays for running the scheme and the insurer's profit.${onlyElNino ? ' Even if people only buy in El Niño years, the forecast price keeps it safe.' : ''}`
    : `<b>✗ This loses money.</b> For every F$1 farmers pay, the pool pays out ${back}.${fPrice === 'flat' && onlyElNino ? ' That\'s what happens with the same price every year: people only buy when a drought is coming. It\'s why our price follows the El Niño forecast.' : ''}`
  $('f-stats').innerHTML = `<div><b>${millions(worst.pay)}</b><span>the most ever paid out in one season (${worst.season - 1}–${String(worst.season).slice(2)})</span></div>` +
    `<div><b>${millions(capital)}</b><span>the insurer sets aside on day one, so it can always pay everyone, even in its worst year</span></div>` +
    `<div class="${profit >= 0 ? 'good' : 'bad'}"><b>${profit >= 0 ? '+' : '−'}${millions(Math.abs(profit))}</b><span>${profit >= 0 ? 'profit' : 'loss'} after ${rows.length} seasons: what farmers paid, minus what they were paid</span></div>` +
    `<div class="${ratio <= 1 ? 'good' : 'bad'}"><b>${back}</b><span>paid back to farmers for every F$1 they pay</span></div>`
}
$('f-price').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; fPrice = b.dataset.p; for (const x of $('f-price').children) x.classList.toggle('on', x === b); funders() }
$('f-load').oninput = $('f-elnino').oninput = $('f-sponsor').oninput = funders
funders()

// ---------- 8. moving through the story: cards flip into place, chapters, count-ups ----------
const still = matchMedia('(prefers-reduced-motion: reduce)').matches
// Marks elements to flip in as they scroll into view. Groups stagger, like cards being dealt.
function deal(selector, kind = '') {
  if (still) return
  document.querySelectorAll(selector).forEach((group) => [...(group.matches('[data-deal]') ? group.children : [group])].forEach((el, i) => {
    el.classList.add('rv'); if (kind) el.classList.add(kind)
    el.style.setProperty('--i', Math.min(i, kind === 'flip' ? 60 : 12))
    seen.observe(el)
  }))
}
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    seen.unobserve(e.target)
    e.target.classList.add('in')
    // once it has landed, hand the element back to its normal styles (hover effects and so on)
    const done = (t) => { if (t.target !== e.target || t.propertyName !== 'transform') return; e.target.removeEventListener('transitionend', done); e.target.classList.remove('rv', 'in', 'flip', 'left', 'right') }
    e.target.addEventListener('transitionend', done)
    const n = e.target.querySelector?.('.count-up'); if (n) countUp(n)
  }
}, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
function countUp(el) {
  const to = +el.dataset.to, t0 = performance.now(), dur = 900
  const step = (t) => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(to * (1 - (1 - p) ** 3)); if (p < 1) requestAnimationFrame(step) }
  requestAnimationFrame(step)
}
for (const el of ['.years', '.takeaways', '.calc-out', '.shields', '.ai-row', '.f-stats', '.r-grid']) document.querySelector(el)?.setAttribute('data-deal', '')
deal('main .head')
deal('.big-line')
deal('.c-side.then', 'left'); deal('.c-side.now', 'right')
deal('.scale'); deal('.years', 'flip'); deal('.ykey'); deal('.takeaways'); deal('.calc')
deal('.ctl', 'left'); deal('.shields')
deal('.ai-row'); deal('.clock'); deal('.nino'); deal('.now-grid')
deal('.f-ctl'); deal('.f-chart'); deal('.f-verdict'); deal('.f-stats'); deal('.audit')
deal('.ck'); deal('.r-grid')
// The 61% counts up the first time it's seen.
{
  const b = $('fc-chance'), to = parseInt(b.textContent)
  b.innerHTML = `<span class="count-up" data-to="${to}">${to}</span>%`
}
// The chapter rail: shows where you are in the story.
{
  const links = [...document.querySelectorAll('#rail a')]
  const where = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) for (const a of links) a.classList.toggle('on', a.dataset.s === e.target.id)
  }, { rootMargin: '-45% 0px -50% 0px' })
  for (const a of links) where.observe($(a.dataset.s))
  const show = () => $('rail').classList.toggle('show', scrollY > $('stage').offsetHeight * 0.6)
  addEventListener('scroll', show, { passive: true })
  show()
}
