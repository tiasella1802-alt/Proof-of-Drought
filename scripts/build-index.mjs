// Turns the raw daily data into the drought index, the payout decisions and the 40-year backtest.
//   node scripts/build-index.mjs   → data/index.json
//
// Season for crush year Y = the main growing months, November (Y-1) to April (Y). Checkpoints:
//   early: end of January (Nov–Jan)   final: end of April (Nov–Apr)
// For each district and checkpoint, readings from three independent records: rainfall total and mean soil moisture
// from A: Copernicus ERA5 / ERA5-Land and B: NASA POWER / MERRA-2 (both reanalyses: weather models that combine
// satellite, station and balloon observations), and rainfall from C: CHIRPS (satellite estimates blended with rain
// gauges). Each reading becomes a percentile against the same window in the WMO 1991–2020 baseline (0 = driest).
// A and B's dryness = mean of their rainfall and soil percentiles; C's = its rainfall percentile.
// Which records decide, and the index, follow decide() in rules.mjs: A and B when they agree, CHIRPS breaks a tie.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { DISTRICTS } from './districts.mjs'
import { RULES, decide, shareDue } from './rules.mjs'

const climate = Object.fromEntries(readdirSync('data/climate').map((f) => {
  const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8'))
  return [j.district.key, j.sources]
}))
const chirps = Object.fromEntries(readdirSync('data/chirps').map((f) => { const j = JSON.parse(readFileSync(`data/chirps/${f}`, 'utf8')); return [j.district.key, j] }))
const yields = Object.fromEntries(JSON.parse(readFileSync('data/yield.json', 'utf8')).years.map((r) => [r.year, r.yield_t_ha]))
const STAGES = { early: 1, final: 4 } // last month of the window
const lastDay = Object.values(climate)[0].era5.time.at(-1)

const inSeason = (t, y, last) => { const yy = +t.slice(0, 4), m = +t.slice(5, 7); return (yy === y - 1 && m >= 11) || (yy === y && m <= last) }
const complete = (y, last) => `${y}-${String(last).padStart(2, '0')}-28` <= lastDay

// The exact daily inputs behind one reading, so anyone can re-fetch them and check the hash posted on-chain.
function window(src, d, y, last) {
  const s = climate[d][src], rows = []
  for (let i = 0; i < s.time.length; i++) if (inSeason(s.time[i], y, last)) rows.push([s.time[i], s.rain[i], s.soil[i]])
  return rows
}
function reading(src, d, y, last) {
  const rows = window(src, d, y, last), rain = rows.reduce((a, r) => a + (r[1] ?? 0), 0), soil = rows.filter((r) => r[2] != null)
  return { rain: +rain.toFixed(1), soil: +(soil.reduce((a, r) => a + r[2], 0) / soil.length).toFixed(4),
    hash: '0x' + createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}
// CHIRPS: rainfall only. Its window counts only once CHIRPS has published every day of it.
function chirpsReading(d, y, last) {
  const c = chirps[d], end = `${y}-${String(last).padStart(2, '0')}-${last === 1 ? 31 : 30}`
  if (c.time.at(-1) < end) return null
  const rows = []
  for (let i = 0; i < c.time.length; i++) if (inSeason(c.time[i], y, last)) rows.push([c.time[i], c.rain[i]])
  return { rain: +rows.reduce((a, r) => a + (r[1] ?? 0), 0).toFixed(1), hash: '0x' + createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}
const pct = (v, base) => +(base.filter((b) => b <= v).length / base.length).toFixed(3)

const BASE = []; for (let y = 1991; y <= 2020; y++) BASE.push(y)
const baseVals = {}
for (const d of Object.keys(climate)) for (const [stage, last] of Object.entries(STAGES)) for (const src of ['era5', 'power']) {
  const rs = BASE.map((y) => reading(src, d, y, last))
  baseVals[`${d}/${stage}/${src}`] = { rain: rs.map((r) => r.rain), soil: rs.map((r) => r.soil) }
}
for (const d of Object.keys(climate)) for (const [stage, last] of Object.entries(STAGES)) baseVals[`${d}/${stage}/chirps`] = { rain: BASE.map((y) => chirpsReading(d, y, last).rain) }

function assess(d, y, stage) {
  const last = STAGES[stage], src = {}
  for (const s of ['era5', 'power']) {
    const r = reading(s, d, y, last), b = baseVals[`${d}/${stage}/${s}`]
    const rainPct = pct(r.rain, b.rain), soilPct = pct(r.soil, b.soil)
    src[s] = { ...r, rainPct, soilPct, dryness: +((rainPct + soilPct) / 2).toFixed(3) }
  }
  const c = chirpsReading(d, y, last)
  if (c) { const rainPct = pct(c.rain, baseVals[`${d}/${stage}/chirps`].rain); src.chirps = { ...c, rainPct, dryness: rainPct } }
  const v = decide({ era5: src.era5.dryness, power: src.power.dryness, chirps: src.chirps?.dryness })
  const index = v.index == null ? null : +v.index.toFixed(3)
  return { district: d, season: y, stage, index, gap: +v.gap.toFixed(3), agree: index != null, due: shareDue(stage, index), deciders: v.deciders,
    tieBreak: !!v.tieBreak, pending: !!v.pending, chirpsAgrees: v.chirpsAgrees ?? null, sources: src }
}

const seasons = []
for (let y = 1982; y <= +lastDay.slice(0, 4) + 1; y++) {
  if (!complete(y, STAGES.early)) break
  const rows = {}
  for (const stage of Object.keys(STAGES)) if (complete(y, STAGES[stage])) rows[stage] = DISTRICTS.map((d) => assess(d.key, y, stage))
  // Each farmer is paid the larger of what's due at each checkpoint (the final pays the rest after an early payout).
  const paid = DISTRICTS.map((d, i) => Math.max(rows.early?.[i].due ?? 0, rows.final?.[i].due ?? 0))
  // Yield change vs the median of the 3 seasons either side (removes long-run trends in area and practice).
  const near = []; for (let k = y - 3; k <= y + 3; k++) if (k !== y && yields[k]) near.push(yields[k])
  near.sort((a, b) => a - b)
  const yieldChange = yields[y] && near.length >= 4 ? +((yields[y] - near[near.length >> 1]) / near[near.length >> 1]).toFixed(3) : null
  seasons.push({ season: y, yield: yields[y] ?? null, yieldChange, payout: +(paid.reduce((a, b) => a + b, 0) / paid.length).toFixed(3),
    districtsPaid: paid.filter((p) => p > 0).length, early: rows.early, final: rows.final ?? null })
}

// Monthly replay: cumulative season-to-date index at the end of each month, Nov→Apr, for every district.
function monthly(y) {
  return [11, 12, 1, 2, 3, 4].map((m) => {
    const last = m >= 11 ? null : m
    if (last === null) { // Nov/Dec: compare the partial window against the same partial window in the baseline
      return { month: m, districts: DISTRICTS.map((d) => partial(d.key, y, m)) }
    }
    return { month: m, districts: DISTRICTS.map((d) => partial(d.key, y, m)) }
  })
}
function partial(d, y, m) {
  const inWin = (t, yy) => { const a = +t.slice(0, 4), mm = +t.slice(5, 7); return m >= 11 ? a === yy - 1 && mm >= 11 && mm <= m : (a === yy - 1 && mm >= 11) || (a === yy && mm <= m) }
  const val = (src, yy) => { const s = climate[d][src]; let r = 0, sm = 0, n = 0
    for (let i = 0; i < s.time.length; i++) if (inWin(s.time[i], yy)) { r += s.rain[i] ?? 0; if (s.soil[i] != null) sm += s.soil[i], n++ }
    return [r, sm / n] }
  const out = {}
  for (const src of ['era5', 'power']) {
    const [r, s] = val(src, y), b = BASE.map((yy) => val(src, yy))
    out[src] = +((pct(r, b.map((v) => v[0])) + pct(s, b.map((v) => v[1]))) / 2).toFixed(3)
  }
  return { district: d, era5: out.era5, power: out.power, index: +((out.era5 + out.power) / 2).toFixed(3) }
}

// Every complete season can be replayed, so visitors can pick any year.
const replays = Object.fromEntries(seasons.filter((s) => s.final).map((s) => [s.season, monthly(s.season)]))
writeFileSync('data/index.json', JSON.stringify({ built: new Date().toISOString(), lastDay, baseline: '1991–2020', rules: RULES, districts: DISTRICTS, seasons, replays }))

// Backtest summary in the terminal.
console.log('season  payout  districts  yield change')
for (const s of seasons) if (s.payout > 0 || (s.yieldChange ?? 0) <= -0.15)
  console.log(`${s.season}    ${String(Math.round(s.payout * 100)).padStart(3)}%    ${s.districtsPaid}/8       ${s.yieldChange == null ? '—' : Math.round(s.yieldChange * 100) + '%'}`)
