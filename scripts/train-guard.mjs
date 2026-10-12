// Trains the data guard (src/guard.js) on 1991–2020 and measures it honestly:
//   false flags on every real season 1982–now, and catch rates for four kinds of faked data.
//   node scripts/train-guard.mjs   → data/guard.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'
import { fitPhysics, seasonAgg, features, fitGaussian, score } from '../src/guard.js'

const raw = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const keys = DISTRICTS.map((d) => d.key), SRC = ['era5', 'power']
const days = Object.fromEntries(SRC.map((s) => [s, keys.map((k) => raw[k][s].time.map((t, i) => [t, raw[k][s].rain[i], raw[k][s].soil[i]]))]))
const lastYear = +raw[keys[0]].era5.time.at(-1).slice(0, 4) - (raw[keys[0]].era5.time.at(-1).slice(5, 7) < '05' ? 1 : 0)
const BASE = Array.from({ length: 30 }, (_, i) => 1991 + i), ALL = Array.from({ length: lastYear - 1981 }, (_, i) => 1982 + i)

const TAMPER = {
  'rain halved': { r: (r) => r * 0.5 },
  'rain cut to 30%': { r: (r) => r * 0.3 },
  'rain wiped to zero': { r: () => 0 },
  'rain and soil both faked dry': { r: (r) => r * 0.3, s: (s) => s - 0.05 },
}
const tamper = (rows, y, t) => rows.map(([d, r, s]) => (y && (+d.slice(0, 4) === y - 1 && +d.slice(5, 7) >= 11 || +d.slice(0, 4) === y && +d.slice(5, 7) <= 4))
  ? [d, t.r && r != null ? t.r(r) : r, t.s && s != null ? t.s(s) : s] : [d, r, s])

const out = { trained: '1991–2020', features: ['rain vs soil percentile gap', 'dryness vs other districts', 'water-balance error (log)'], sources: {} }
for (const src of SRC) {
  const phys = days[src].map((rows) => fitPhysics(rows))
  const base = days[src].map((rows) => { const v = BASE.map((y) => seasonAgg(rows, y)); return { rain: v.map((x) => x[0]), soil: v.map((x) => x[1]) } })
  const seasonsOf = (y) => days[src].map((rows) => seasonAgg(rows, y))
  const train = BASE.flatMap((y) => keys.map((_, k) => features(k, seasonsOf(y), base, days[src][k], y, phys[k])))
  const model = fitGaussian(train)
  const real = ALL.flatMap((y) => keys.map((_, k) => score(features(k, seasonsOf(y), base, days[src][k], y, phys[k]), model)))
  const threshold = real.slice().sort((a, b) => a - b)[Math.floor(0.99 * (real.length - 1))]
  const caught = {}
  for (const [name, t] of Object.entries(TAMPER)) {
    let hit = 0, n = 0
    for (const y of ALL) for (let k = 0; k < keys.length; k++) {
      const fake = tamper(days[src][k], y, t), s = seasonsOf(y)
      s[k] = seasonAgg(fake, y)
      n++, hit += score(features(k, s, base, fake, y, phys[k]), model) > threshold
    }
    caught[name] = +(hit / n).toFixed(3)
  }
  out.sources[src] = { model, threshold: +threshold.toFixed(3), physics: phys, base,
    falseFlags: +(real.filter((v) => v > threshold).length / real.length).toFixed(3), caught }
  console.log(`${src}: threshold ${threshold.toFixed(2)} · real readings flagged ${(out.sources[src].falseFlags * 100).toFixed(1)}% · caught:`,
    Object.entries(caught).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', '))
}
writeFileSync('data/guard.json', JSON.stringify(out))
