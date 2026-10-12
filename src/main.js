import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import { chain, demoKey, addressOf } from './evm.js'
import { inSeason, seasonAgg, features, score, pct } from './guard.js'

maplibregl.setWorkerUrl(workerUrl) // Vite's dependency bundling hides MapLibre's own worker file

const $ = (id) => document.getElementById(id)
const get = (f) => fetch(`/data/${f}`).then((r) => r.json())
const [IDX, GUARD, DAYS, YIELD, ART] = await Promise.all(['index.json', 'guard.json', 'days.json', 'yield.json', 'contract.json'].map(get))
const D = IDX.districts, KEYS = D.map((d) => d.key)
const SEASON = Object.fromEntries(IDX.seasons.map((s) => [s.season, s]))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const F = (n) => `F$${Math.round(n).toLocaleString()}`
const pm = (x) => Math.round(x * 1000) // dryness 0..1 → per mille, as the contract wants
const ord = (x) => { const n = Math.max(1, Math.round(x * 100)), s = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'; return `${n}${s}` }
const short = (h) => `${h.slice(0, 8)}…${h.slice(-4)}`
const opts = (el, list, sel) => (el.innerHTML = list.map(([v, t]) => `<option value="${v}"${v == sel ? ' selected' : ''}>${t}</option>`).join(''))

// Dryness percentile → colour (driest = burnt red, middle = sand, wettest = blue).
const STOPS = [[0, [122, 32, 6]], [0.15, [194, 65, 12]], [0.35, [233, 185, 138]], [0.55, [239, 229, 212]], [0.8, [158, 195, 220]], [1, [47, 111, 159]]]
function colour(x) {
  let i = 0
  while (i < STOPS.length - 2 && x > STOPS[i + 1][0]) i++
  const [a, ca] = STOPS[i], [b, cb] = STOPS[i + 1], t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return `rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * t)).join(',')})`
}
const textOn = (x) => (x < 0.3 || x > 0.75 ? '#fff' : '#1f1a14')

// ---------- the in-browser chain: one insurer, two oracles, 12 test farmers per district, F$1,000 cover each ----------
const UNIT = 10n ** 18n, COVER = 1000n
const K = { insurer: demoKey('insurer'), era5: demoKey('era5 oracle'), power: demoKey('nasa oracle') }
const farmerKey = (d, i) => demoKey(`farmer ${d}-${i}`)
async function newChain(farmersPerDistrict = 12) {
  const c = await chain()
  for (const k of Object.values(K)) await c.fund(addressOf(k), 10n ** 9n * UNIT)
  const dc = await c.deploy(K.insurer, ART, [addressOf(K.era5), addressOf(K.power)])
  await c.transfer(K.insurer, dc.address, 500_000n * UNIT) // the pool
  for (let d = 0; d < D.length; d++) for (let i = 0; i < farmersPerDistrict; i++) await dc.write(K.insurer, 'issue', [addressOf(farmerKey(d, i)), d, COVER * UNIT])
  return { c, dc }
}

// ---------- 1. replay ----------
const STORY = { 1983: 'El Niño', 1987: 'El Niño', 1992: 'El Niño', 1998: 'El Niño · 11-month drought', 2010: 'El Niño', 2016: 'El Niño + Cyclone Winston' }
const BA = KEYS.indexOf('ba')
let run = 0, playing = false, step = -1, season = 1998, state = null, markers = []

const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', bounds: [[177.15, -18.45], [179.7, -16.15]],
  fitBoundsOptions: { padding: 40 }, attributionControl: { compact: true }, cooperativeGestures: true })
map.on('load', () => {
  markers = D.map((d) => {
    const el = document.createElement('div')
    el.className = 'dmk'
    el.innerHTML = `<i></i><span>${d.name}</span>`
    return new maplibregl.Marker({ element: el, anchor: 'top' }).setLngLat([d.lon, d.lat]).addTo(map)
  })
  paintMonth()
})

$('seasons').innerHTML = Object.keys(IDX.replays).map((y) => `<button data-y="${y}" class="${+y === season ? 'on' : ''}">${y}<small>${STORY[y] ?? ''}</small></button>`).join('')
$('seasons').onclick = (e) => { const b = e.target.closest('button'); if (b) startSeason(+b.dataset.y) }
const monthName = (y, i) => { const m = [11, 12, 1, 2, 3, 4][i]; return `${MONTHS[m - 1]} ${m >= 11 ? y - 1 : y}` }

function renderMonths() {
  $('rp-months').innerHTML = [0, 1, 2, 3, 4, 5].map((i) => `<li data-i="${i}" class="${i === 2 || i === 5 ? 'ck' : ''}${i < step ? ' done' : ''}${i === step ? ' now' : ''}">` +
    `${monthName(season, i).split(' ')[0]}<small>${i === 2 ? 'early check' : i === 5 ? 'final check' : '&nbsp;'}</small></li>`).join('')
}
function paintMonth() {
  const rows = step >= 0 ? IDX.replays[season][step].districts : null
  markers.forEach((m, k) => {
    const el = m.getElement(), x = rows?.[k].index
    el.querySelector('i').style.background = x == null ? '#cfc3b0' : colour(x)
    el.querySelector('i').style.color = x == null ? '#1f1a14' : textOn(x)
    el.querySelector('i').textContent = x == null ? '—' : ord(x)
    el.classList.toggle('paid', !!state?.paidDistricts.has(k))
  })
  $('rp-month').textContent = step >= 0 ? monthName(season, step) : `Season ${season - 1}–${String(season).slice(2)}`
  renderMonths()
}
function log(cls, block, text) {
  const li = document.createElement('li')
  li.className = cls
  li.innerHTML = `<i>#${block}</i><span>${text}</span>`
  $('ledger').prepend(li)
}
function sms(html) {
  const ol = $('sms')
  ol.querySelector('.sys')?.remove()
  const li = document.createElement('li')
  li.innerHTML = html
  ol.append(li)
  ol.scrollTop = ol.scrollHeight
}
function totals() {
  $('t-farmers').textContent = state.farmersPaid.size
  $('t-paid').textContent = F(state.paid)
  $('t-block').textContent = `#${state.c.block}`
}

async function startSeason(y) {
  const my = ++run
  season = y, step = -1, playing = false
  $('rp-play').textContent = '▶ Play'
  for (const b of $('seasons').children) b.classList.toggle('on', +b.dataset.y === y)
  $('ledger').innerHTML = ''
  $('sms').innerHTML = '<li class="sys">No messages yet.</li>'
  $('ph-bal').textContent = 'F$0'
  $('chain-st').textContent = 'starting the chain…'
  state = null
  paintMonth()
  const { c, dc } = await newChain()
  if (my !== run) return
  state = { c, dc, paid: 0, farmersPaid: new Set(), paidDistricts: new Set(), ba: 0 }
  $('chain-st').textContent = `contract ${short(dc.address)}`
  log('rep', dc.deployTx.block, `DroughtCover deployed · ${D.length * 12} farmers covered · pool F$500,000`)
  totals()
}

// One checkpoint: both oracles post each district's reading; the contract settles and pays.
async function checkpoint(stage, my) {
  const rows = SEASON[season]?.[stage]
  if (!rows) return
  for (let k = 0; k < rows.length; k++) {
    if (my !== run) return
    const r = rows[k], s = stage === 'early' ? 0 : 1
    await state.dc.write(K.era5, 'report', [season, s, k, pm(r.sources.era5.dryness), r.sources.era5.hash])
    const res = await state.dc.write(K.power, 'report', [season, s, k, pm(r.sources.power.dryness), r.sources.power.hash])
    const settled = res.events.find((e) => e.name === 'Settled'), paid = res.events.filter((e) => e.name === 'Paid')
    const disagree = res.events.some((e) => e.name === 'SourcesDisagree')
    const name = D[k].name, idx = Number(settled.args.index) / 1000
    if (disagree) log('bad', res.block, `${name}: sources disagree (${pm(r.sources.era5.dryness)} vs ${pm(r.sources.power.dryness)}) · nothing paid`)
    else if (paid.length) {
      const amt = paid.reduce((a, e) => a + Number(e.args.amount / UNIT), 0)
      state.paid += amt
      paid.forEach((e) => state.farmersPaid.add(Number(e.args.id)))
      state.paidDistricts.add(k)
      log('pay', res.block, `${name}: ${ord(idx)} driest → ${Number(settled.args.share) / 10}% of cover · ${paid.length} farmers paid ${F(amt)} · ${short(res.hash)}`)
      if (k === BA) {
        const each = Number(paid[0].args.amount / UNIT)
        state.ba += each
        $('ph-bal').textContent = F(state.ba)
        sms(stage === 'early'
          ? `Proof of Drought: rain and soil moisture at Ba since November are among the <b>driest ${Math.max(1, Math.round(idx * 100))}%</b> of seasons on record. Copernicus and NASA agree. <b>${F(each)}</b> (30% of your cover) is in your wallet now, for water, feed and seed. Final check end of April.<small>block #${res.block} · ${short(res.hash)}</small>`
          : `Proof of Drought: the season ended among the <b>driest ${Math.max(1, Math.round(idx * 100))}%</b> on record at Ba. <b>${F(each)}</b> sent, bringing you to ${F(state.ba)} this season.<small>block #${res.block} · ${short(res.hash)}</small>`)
      }
    } else {
      log('rep', res.block, `${name}: ${ord(idx)} percentile · no payout due`)
      if (k === BA && stage === 'final' && !state.ba) sms(`Proof of Drought: Ba's season ended at the ${ord(idx)} percentile, not a drought. No payout this season.<small>block #${res.block}</small>`)
    }
    totals()
    paintMonth()
    await new Promise((r) => setTimeout(r, 120))
  }
}

async function advance() {
  if (!state || step >= 5) return false
  const my = run
  step++
  paintMonth()
  if (step === 2) await checkpoint('early', my)
  if (step === 5) await checkpoint('final', my)
  return my === run
}
$('rp-play').onclick = async () => {
  if (playing) { playing = false; $('rp-play').textContent = '▶ Play'; return }
  if (!state) return
  if (step >= 5) await startSeason(season)
  playing = true
  $('rp-play').textContent = '❚❚ Pause'
  const my = run
  while (playing && my === run && step < 5) {
    if (!(await advance())) return
    await new Promise((r) => setTimeout(r, 1300))
  }
  if (my === run) playing = false, $('rp-play').textContent = step >= 5 ? '↻ Replay' : '▶ Play'
}
$('rp-months').onclick = async (e) => {
  const i = +e.target.closest('li')?.dataset.i
  if (!state || Number.isNaN(i) || playing) return
  while (step < i) if (!(await advance())) return
}
startSeason(season)

// ---------- 2. 45-year backtest ----------
const DROUGHT = [1983, 1987, 1992, 1998, 2010], STORM = { 1985: 'Cyclones Eric & Nigel', 2012: 'Floods', 2016: 'Cyclone Winston' }
{
  const S = IDX.seasons.filter((s) => s.final)
  const caught = DROUGHT.filter((y) => SEASON[y].payout > 0)
  const falseAlarms = S.filter((s) => s.payout >= 0.25 && s.yieldChange != null && s.yieldChange >= 0)
  const avg = S.reduce((a, s) => a + s.payout, 0) / S.length
  $('stats').innerHTML =
    `<div class="stat good"><b>${caught.length} of ${DROUGHT.length}</b><span>El Niño drought losses paid: ${DROUGHT.map((y) => `${y} (${Math.round(SEASON[y].payout * 100)}%)`).join(', ')}</span></div>` +
    `<div class="stat good"><b>${Object.keys(STORM).map((y) => `${Math.round(SEASON[y].payout * 100)}%`).join(' · ')}</b><span>paid in the cyclone and flood loss years ${Object.keys(STORM).join(', ')}: another peril, another product</span></div>` +
    `<div class="stat bad"><b>${falseAlarms.length}</b><span>false alarms: ${falseAlarms.map((s) => `${s.season} paid ${Math.round(s.payout * 100)}%, yields ${s.yieldChange >= 0 ? '+' : ''}${Math.round(s.yieldChange * 100)}%`).join('; ')}</span></div>` +
    `<div class="stat"><b>${(avg * 100).toFixed(1)}%</b><span>of cover paid out per year on average: the fair price before costs (${F(avg * 1000)} a year for F$1,000)</span></div>`

  const W = 1100, H = 300, L = 40, top = 20, mid = 160, scale = 120, step = (W - L - 10) / S.length
  const x = (i) => L + i * step + step * 0.15, bw = step * 0.7
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Payouts and cane yield changes by season, 1982 to ${S.at(-1).season}">`
  S.forEach((s, i) => { if (STORM[s.season]) svg += `<rect x="${L + i * step}" y="${top}" width="${step}" height="${H - top - 30}" fill="#c7d6e2" opacity=".5"/>` })
  svg += `<line x1="${L}" x2="${W - 10}" y1="${mid}" y2="${mid}" stroke="#1f1a14"/>`
  svg += `<text x="4" y="${top + 8}">100%</text><text x="4" y="${mid - 4}">paid</text><text x="4" y="${mid + 14}">yield</text><text x="4" y="${mid + scale * 0.4 + 4}">−40%</text>`
  S.forEach((s, i) => {
    const h = s.payout * (mid - top - 10)
    svg += `<rect x="${x(i)}" y="${mid - h}" width="${bw}" height="${h}" fill="#17603a"><title>${s.season}: paid ${Math.round(s.payout * 100)}% of cover</title></rect>`
    if (s.yieldChange != null) {
      const v = Math.max(-0.45, Math.min(0.3, s.yieldChange)), yh = Math.abs(v) * scale
      svg += `<rect x="${x(i) + bw * 0.25}" y="${v < 0 ? mid : mid - yh}" width="${bw * 0.5}" height="${yh}" fill="${v < 0 ? '#b4410f' : '#d9c7ad'}"><title>${s.season}: cane yield ${v >= 0 ? '+' : ''}${Math.round(s.yieldChange * 100)}% vs nearby seasons</title></rect>`
    }
    if (s.season % 5 === 0 || DROUGHT.includes(s.season) || STORM[s.season]) svg += `<text x="${x(i) + bw / 2}" y="${H - 10}" text-anchor="middle">${s.season}</text>`
    if (DROUGHT.includes(s.season)) svg += `<text class="lbl" x="${x(i) + bw / 2}" y="${mid - s.payout * (mid - top - 10) - 6}" text-anchor="middle">${Math.round(s.payout * 100)}%</text>`
    if (STORM[s.season]) svg += `<text class="lbl" x="${L + i * step + step / 2}" y="${H - 34}" text-anchor="middle" style="font-size:9px">${STORM[s.season].split(' ')[0]}</text>`
  })
  $('chart').innerHTML = svg + '</svg>'
}

// ---------- 3. try to cheat ----------
const NORMAL = Object.keys(DAYS).map(Number)
opts($('c-dist'), D.map((d, k) => [k, d.name]), BA)
opts($('c-season'), NORMAL.map((y) => [y, `${y - 1}–${String(y).slice(2)}${y === 2011 ? ' (a normal season)' : STORY[y] ? ` (${STORY[y]})` : ''}`]), 2011)
let cheatChain = null
const cheatState = () => {
  const k = +$('c-dist').value, y = +$('c-season').value, src = $('c-src').value, other = src === 'era5' ? 'power' : 'era5'
  const f = +$('c-rain').value / 100, ds = +$('c-soil').value, both = $('c-both').checked
  // The two sources measure soil on different scales (ERA5-Land m³/m³, NASA a 0–1 wetness index), so a careful attacker
  // scales the soil edit to each source's own spread in the baseline, making the two fakes agree.
  const spread = (s) => { const v = GUARD.sources[s].base[k].soil, m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }
  const fake = (rows, s = src) => { const d = ds * spread(s) / spread(src)
    return rows.map(([t, r, x]) => inSeason(t, y) ? [t, r == null ? r : +(r * f).toFixed(2), x == null ? x : +(x - d).toFixed(4)] : [t, r, x]) }
  const guardFor = (s, rows) => {
    const g = GUARD.sources[s], seasons = KEYS.map((key) => seasonAgg(DAYS[y][key][s], y))
    seasons[k] = seasonAgg(rows, y)
    const x = features(k, seasons, g.base, rows, y, g.physics[k]), sc = score(x, g.model)
    const [rain, soil] = seasons[k], dry = (pct(rain, g.base[k].rain) + pct(soil, g.base[k].soil)) / 2
    return { score: sc, threshold: g.threshold, flagged: sc > g.threshold, dry }
  }
  const real = SEASON[y].final[k]
  const mine = guardFor(src, fake(DAYS[y][KEYS[k]][src]))
  const theirs = both ? guardFor(other, fake(DAYS[y][KEYS[k]][other], other)) : { dry: real.sources[other].dryness, flagged: false, honest: true }
  return { k, y, src, other, both, tampered: f < 1 || ds > 0, mine, theirs, real }
}
function renderCheat() {
  const s = cheatState(), name = D[s.k].name, gap = Math.abs(pm(s.mine.dry) - pm(s.theirs.dry))
  $('c-rain-v').textContent = `${$('c-rain').value}%`
  $('c-soil-v').textContent = (+$('c-soil').value).toFixed(2)
  const l1 = $('lock1'), l2 = $('lock2'), l3 = $('lock3')
  const fill = Math.min(100, (s.mine.score / (s.mine.threshold * 2)) * 100)
  l1.querySelector('.meter i').style.width = `${fill}%`
  l1.querySelector('.meter i').style.background = s.mine.flagged ? 'var(--dry)' : 'var(--paid)'
  l1.querySelector('.meter b').style.left = '50%'
  const flagged = s.mine.flagged || (s.both && s.theirs.flagged)
  l1.className = `lock ${!s.tampered ? '' : flagged ? 'held' : 'broken'}`
  l1.querySelector('p').innerHTML = !s.tampered ? 'Trained on 30 years of real data from all eight districts. Change the sliders to fake a drought.'
    : flagged ? `<b>Flagged.</b> Anomaly score ${s.mine.score.toFixed(1)} (limit ${s.mine.threshold.toFixed(1)}): this doesn't behave like real ${name} weather. ${s.both ? 'Public watchdogs running this model flag the payout for investigation.' : 'An honest oracle would refuse to post it, and public watchdogs flag it.'}`
    : `<b>Not flagged</b> (score ${s.mine.score.toFixed(1)}, limit ${s.mine.threshold.toFixed(1)}). A subtle fake can slip past the model, so it is never the only lock.`
  l2.className = `lock ${!s.tampered ? '' : gap > 250 ? 'held' : 'broken'}`
  l2.querySelector('p').innerHTML = !s.tampered ? `Your feed: ${ord(s.mine.dry)} percentile. The other: ${ord(s.theirs.dry)}. The contract pays only if they agree within 25 points.`
    : s.both ? (gap > 250
      ? `<b>Held.</b> You control both feeds, but your two fakes still disagree (${ord(s.mine.dry)} vs ${ord(s.theirs.dry)}): the same edit lands differently on two independent records. The contract refuses.`
      : `<b>Bypassed:</b> you control both feeds and made them agree (${ord(s.mine.dry)} vs ${ord(s.theirs.dry)}). This is why the two sources come from different agencies on different continents.`)
    : gap > 250 ? `<b>Held.</b> Your fake says ${ord(s.mine.dry)} percentile; the independent ${s.other === 'power' ? 'NASA' : 'Copernicus'} record says ${ord(s.theirs.dry)}. ${(gap / 10).toFixed(0)} points apart: the contract refuses.`
    : `<b>Not blocked:</b> your fake (${ord(s.mine.dry)}) is within 25 points of the honest record (${ord(s.theirs.dry)}), so a drought this mild is what the data already says.`
  l3.className = `lock ${s.tampered ? 'held' : ''}`
  l3.querySelector('p').innerHTML = s.tampered ? `<b>Permanent evidence.</b> Your reading's fingerprint no longer matches the public archive. Anyone who re-downloads ${name}'s data can prove the fraud, forever, from the ledger.`
    : 'Every reading on the ledger carries a SHA-256 fingerprint of its daily data. Anyone can re-download the archive and compare.'
}
for (const id of ['c-dist', 'c-season', 'c-src', 'c-rain', 'c-soil', 'c-both']) $(id).oninput = () => { renderCheat(); $('c-verdict').innerHTML = '' }
renderCheat()
$('c-go').onclick = async () => {
  const s = cheatState(), btn = $('c-go')
  btn.disabled = true
  $('c-verdict').textContent = 'Submitting to the contract…'
  try {
    cheatChain ??= await newChain(3)
    const { dc } = cheatChain, season = 3000 + Math.floor(Math.random() * 60000) // a fresh checkpoint each try
    const keyFor = (src) => (src === 'era5' ? K.era5 : K.power)
    const fakeHash = '0x' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`fake ${Date.now()}`)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    // You control the oracle for your feed, so it posts the fake whatever the guard says.
    await dc.write(keyFor(s.src), 'report', [season, 1, s.k, pm(s.mine.dry), fakeHash])
    const otherHash = s.both ? fakeHash : s.real.sources[s.other].hash
    const res = await dc.write(keyFor(s.other), 'report', [season, 1, s.k, pm(s.theirs.dry), otherHash])
    const paid = res.events.filter((e) => e.name === 'Paid'), dis = res.events.some((e) => e.name === 'SourcesDisagree')
    const amt = paid.reduce((a, e) => a + Number(e.args.amount / UNIT), 0)
    $('c-verdict').innerHTML = dis ? `<b>Blocked by the contract.</b> The two sources disagreed, so nothing was paid and the disagreement is now on the ledger for anyone to investigate.<small>SourcesDisagree · block #${res.block} · ${res.hash}</small>`
      : paid.length ? `<b>${s.both ? 'You got paid' : 'Paid'}: ${F(amt)}</b> to ${paid.length} test farmers. ${s.both ? 'With both feeds hacked the contract had no way to tell. But the fake fingerprints are on the ledger forever, and the data guard flags it publicly. That is fraud anyone can prove.' : 'Your fake was close enough to the real record that both sources agreed.'}<small>block #${res.block} · ${res.hash}</small>`
      : `<b>No payout.</b> Even with your fake, the agreed reading wasn't a drought.<small>block #${res.block} · ${res.hash}</small>`
  } catch (e) {
    $('c-verdict').textContent = `The chain refused: ${e.message}`
  }
  btn.disabled = false
}

// ---------- 4. verify a reading against the public archives, live ----------
const SEASONS = IDX.seasons.map((s) => s.season)
opts($('v-season'), SEASONS.filter((y) => SEASON[y].final).map((y) => [y, `${y - 1}–${String(y).slice(2)}`]).reverse(), 1998)
opts($('v-dist'), D.map((d, k) => [k, d.name]), BA)
const sha = async (rows) => '0x' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))))].map((b) => b.toString(16).padStart(2, '0')).join('')
async function liveRows(src, d, y, last) {
  const from = `${y - 1}-11-01`, to = `${y}-${String(last).padStart(2, '0')}-${last === 1 ? 31 : 30}`
  if (src === 'era5') {
    const base = `https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${from}&end_date=${to}&timezone=Pacific%2FFiji`
    const [p, s] = await Promise.all([fetch(`${base}&daily=precipitation_sum&models=era5`).then((r) => r.json()), fetch(`${base}&daily=soil_moisture_0_to_100cm_mean&models=era5_land`).then((r) => r.json())])
    return p.daily.time.map((t, i) => [t, p.daily.precipitation_sum[i], s.daily.soil_moisture_0_to_100cm_mean[i]])
  }
  const j = await fetch(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,GWETROOT&community=AG&longitude=${d.lon}&latitude=${d.lat}&start=${from.replaceAll('-', '')}&end=${to.replaceAll('-', '')}&format=JSON`).then((r) => r.json())
  const { PRECTOTCORR: r, GWETROOT: w } = j.properties.parameter, fill = j.header.fill_value
  return Object.keys(r).map((k) => [`${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`, r[k] === fill ? null : r[k], w[k] === fill ? null : w[k]])
}
function renderVerify(live) {
  const y = +$('v-season').value, stage = $('v-stage').value, k = +$('v-dist').value, r = SEASON[y][stage]?.[k]
  if (!r) return ($('v-out').innerHTML = '<div class="v-sum bad">No reading for that checkpoint yet.</div>')
  const card = (src, title) => {
    const s = r.sources[src], l = live?.[src]
    return `<div class="v-card"><h3>${title}</h3><dl><dt>Rainfall</dt><dd>${s.rain} mm (${ord(s.rainPct)} percentile)</dd><dt>Soil moisture</dt><dd>${s.soil} (${ord(s.soilPct)} percentile)</dd>` +
      `<dt>Dryness</dt><dd>${pm(s.dryness)} / 1000</dd><dt>Fingerprint on ledger</dt><dd>${s.hash}</dd>` +
      (l ? `<dt>Re-downloaded just now</dt><dd>${l.error ? `<span class="no">${l.error}</span>` : `${l.hash}<br><span class="${l.hash === s.hash ? 'ok' : 'no'}">${l.hash === s.hash ? '✓ identical' : `✗ differs (${l.diff})`}</span>`}</dd>` : '') + '</dl></div>'
  }
  const due = r.due ? `${Math.round(r.due * 100)}% of cover` : 'nothing'
  $('v-out').innerHTML = `<div class="v-sum${r.agree ? '' : ' bad'}">${D[k].name}, ${stage} check ${y}: index ${pm(r.index)} / 1000 (${ord(r.index)} percentile), sources ${r.agree ? 'agree' : 'disagree'} (gap ${pm(r.gap)}) → contract pays ${due}.</div>` +
    card('era5', 'Copernicus ERA5 / ERA5-Land') + card('power', 'NASA POWER (MERRA-2)')
}
for (const id of ['v-season', 'v-stage', 'v-dist']) $(id).oninput = () => renderVerify()
renderVerify()
$('v-go').onclick = async () => {
  const y = +$('v-season').value, stage = $('v-stage').value, k = +$('v-dist').value, r = SEASON[y][stage][k], last = stage === 'early' ? 1 : 4
  $('v-go').disabled = true
  $('v-go').textContent = 'Downloading from Copernicus and NASA…'
  const live = {}
  for (const src of ['era5', 'power']) {
    try {
      // Same window as scripts/build-index.mjs: 1 November to the end of the checkpoint month.
      const end = `${y}-${String(last).padStart(2, '0')}-31`
      const rows = (await liveRows(src, D[k], y, last)).filter(([t]) => t >= `${y - 1}-11-01` && t <= end)
      const hash = await sha(rows), saved = r.sources[src]
      const rain = rows.reduce((a, x) => a + (x[1] ?? 0), 0)
      live[src] = { hash, diff: `rainfall now ${rain.toFixed(1)} mm vs ${saved.rain} mm` }
    } catch (e) { live[src] = { error: `download failed: ${e.message}` } }
  }
  renderVerify(live)
  $('v-go').disabled = false
  $('v-go').textContent = 'Re-download and check'
}

// ---------- 5. your farm ----------
opts($('f-dist'), D.map((d, k) => [k, d.name]), BA)
function renderFarm() {
  const k = +$('f-dist').value, cover = +$('f-cover').value
  const rows = IDX.seasons.filter((s) => s.final).map((s) => {
    const e = s.early?.[k], f = s.final[k], share = Math.max(e?.due ?? 0, f.due)
    return { y: s.season, early: e?.due ? cover * e.due : 0, total: cover * share, idx: f.index, yc: s.yieldChange }
  })
  const paidRows = rows.filter((r) => r.total > 0), total = rows.reduce((a, r) => a + r.total, 0)
  $('f-out').innerHTML = `<div class="f-sum"><div class="stat good"><b>${F(total)}</b><span>paid to you over ${rows.length} seasons, in ${paidRows.length} of them</span></div>` +
    `<div class="stat"><b>${F(total / rows.length)}</b><span>a year on average: the fair price of ${F(cover)} cover before costs</span></div>` +
    `<div class="stat"><b>${paidRows.filter((r) => r.early).length}</b><span>season${paidRows.filter((r) => r.early).length === 1 ? '' : 's'} with an early January payout</span></div></div>` +
    `<div class="f-table"><table><thead><tr><th>Season</th><th>Dryness at ${D[k].name}</th><th>Paid in Jan</th><th>Paid in total</th><th>Fiji cane yield</th></tr></thead><tbody>` +
    paidRows.map((r) => `<tr><td>${r.y - 1}–${String(r.y).slice(2)}</td><td>${ord(r.idx)} percentile</td><td class="n">${r.early ? F(r.early) : '—'}</td><td class="n pay">${F(r.total)}</td>` +
      `<td class="n ${r.yc != null && r.yc < 0 ? 'neg' : ''}">${r.yc == null ? '—' : `${r.yc >= 0 ? '+' : ''}${Math.round(r.yc * 100)}%`}</td></tr>`).join('') + '</tbody></table></div>'
}
$('f-dist').oninput = $('f-cover').oninput = renderFarm
renderFarm()
