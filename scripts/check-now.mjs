// Checks the live tracker (src/now.js) ranks every past checkpoint the way the contract did (scripts/build-index.mjs).
//   node scripts/check-now.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { district, SEASON_START } from '../src/now.js'
const NOW = JSON.parse(readFileSync('public/data/now.json', 'utf8')), IDX = JSON.parse(readFileSync('data/index.json', 'utf8'))
const climate = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const rows = (src, d, y, to) => { const s = climate[d][src], o = []; for (let i = 0; i < s.time.length; i++) { const t = s.time[i]; if (t >= `${y - 1}-09-01` && t <= to && !t.endsWith('-02-29')) o.push([t, s.rain[i], s.soil[i]]) } return o }
let worst = 0, n = 0
for (const s of IDX.seasons) for (const [stage, end] of [['early', '-01-31'], ['final', '-04-30']]) if (s[stage]) s[stage].forEach((r, k) => {
  const d = r.district, live = { era5: rows('era5', d, s.season, s.season + end), power: rows('power', d, s.season, s.season + end) }
  const got = district(live, NOW.districts[d], SEASON_START), diff = Math.abs(got.index - r.index)
  worst = Math.max(worst, diff); n++
  if (diff > 0.02) console.log(s.season, stage, d, got.index.toFixed(3), r.index)
})
console.log(`${n} checkpoints, worst difference ${worst.toFixed(3)}`)
for (const d of Object.keys(NOW.districts)) { const live = { era5: NOW.districts[d].era5.snapshot, power: NOW.districts[d].power.snapshot }; const r = district(live, NOW.districts[d], 0); console.log(d, 'since 1 Sep to day', r.to, r.index.toFixed(3), 'gap', r.gap.toFixed(2), Math.round(r.era5.rain), 'mm') }
