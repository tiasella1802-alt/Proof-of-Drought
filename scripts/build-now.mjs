// What the live tracker needs to compute "what the contract sees today" in the browser, from data it downloads live:
// the 1991–2020 baseline as daily values from 1 September to 30 April, so any window (since 1 September before the
// season, since 1 November once it starts) can be ranked exactly as build-index.mjs ranks a checkpoint. Also a
// snapshot of the current season so far, used if the live download fails. 29 February is dropped so days line up.
//   node scripts/build-now.mjs   → public/data/now.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'

const climate = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const lastDay = climate[DISTRICTS[0].key].era5.time.at(-1)
// The season being tracked ends in April of `season`: from May onwards that's next year's.
const season = +lastDay.slice(0, 4) + (+lastDay.slice(5, 7) >= 5 ? 1 : 0)
const BASE = Array.from({ length: 30 }, (_, i) => 1991 + i)

// Daily rows from 1 Sep (y-1) to 30 Apr (y), without 29 Feb.
function rows(src, d, y) {
  const s = climate[d][src], from = `${y - 1}-09-01`, to = `${y}-04-30`, out = []
  for (let i = 0; i < s.time.length; i++) { const t = s.time[i]; if (t >= from && t <= to && !t.endsWith('-02-29')) out.push([t, s.rain[i], s.soil[i]]) }
  return out
}
const pack = (src, d, y) => { const r = rows(src, d, y); return [r.map((x) => Math.round((x[1] ?? 0) * 100)), r.map((x) => (x[2] == null ? null : Math.round(x[2] * 1e4)))] }

const out = { built: new Date().toISOString(), season, lastDay, baseline: '1991–2020', days: 242, note: 'rain in hundredths of mm, soil × 10 000', districts: {} }
for (const d of DISTRICTS) {
  out.districts[d.key] = {}
  for (const src of ['era5', 'power']) out.districts[d.key][src] = { base: BASE.map((y) => pack(src, d.key, y)), snapshot: rows(src, d.key, season) }
}
writeFileSync('public/data/now.json', JSON.stringify(out))
console.log(`now.json: season ${season - 1}–${String(season).slice(2)}, data to ${lastDay}, ${(readFileSync('public/data/now.json').length / 1024).toFixed(0)} KB`)
