// Trains the data guard (src/guard.js) on 1991–2020 and measures it honestly:
//   false flags on every real season 1982–now, and catch rates for four kinds of faked data.
// One model per checkpoint window: final (Nov–Apr) and early (Nov–Jan). Also scores every real reading, so the oracles
// can post the guard's verdict on-chain alongside the reading (as score ÷ threshold: above 1 = flagged).
//   node scripts/train-guard.mjs   → data/guard.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'
import { fitPhysics, seasonAgg, features, fitGaussian, score, inSeason } from '../src/guard.js'

const raw = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const keys = DISTRICTS.map((d) => d.key), SRC = ['era5', 'power']
const days = Object.fromEntries(SRC.map((s) => [s, keys.map((k) => raw[k][s].time.map((t, i) => [t, raw[k][s].rain[i], raw[k][s].soil[i]]))]))
const lastDay = raw[keys[0]].era5.time.at(-1)
const complete = (y, last) => `${y}-${String(last).padStart(2, '0')}-28` <= lastDay
const BASE = Array.from({ length: 30 }, (_, i) => 1991 + i)
const STAGES = { final: 4, early: 1 }

const TAMPER = {
  'rain halved': { r: (r) => r * 0.5 },
  'rain cut to 30%': { r: (r) => r * 0.3 },
  'rain wiped to zero': { r: () => 0 },
  'rain and soil both faked dry': { r: (r) => r * 0.3, s: (s) => s - 0.05 },
}
const tamper = (rows, y, t, last) => rows.map(([d, r, s]) => (inSeason(d, y, last) ? [d, t.r && r != null ? t.r(r) : r, t.s && s != null ? t.s(s) : s] : [d, r, s]))

const out = { trained: '1991–2020', features: ['rain vs soil percentile gap', 'dryness vs other districts', 'water-balance error (log)'], sources: {}, early: { sources: {} }, scores: { final: {}, early: {} } }
const phys = Object.fromEntries(SRC.map((src) => [src, days[src].map((rows) => fitPhysics(rows))]))
for (const [stage, last] of Object.entries(STAGES)) {
  const ALL = []; for (let y = 1982; complete(y, last); y++) ALL.push(y)
  for (const src of SRC) {
    const ph = phys[src]
    const base = days[src].map((rows) => { const v = BASE.map((y) => seasonAgg(rows, y, last)); return { rain: v.map((x) => x[0]), soil: v.map((x) => x[1]) } })
    const seasonsOf = (y) => days[src].map((rows) => seasonAgg(rows, y, last))
    const feat = (k, s, rows, y) => features(k, s, base, rows, y, ph[k], last)
    const model = fitGaussian(BASE.flatMap((y) => keys.map((_, k) => feat(k, seasonsOf(y), days[src][k], y))))
    const real = Object.fromEntries(ALL.map((y) => [y, keys.map((_, k) => score(feat(k, seasonsOf(y), days[src][k], y), model))]))
    const all = Object.values(real).flat()
    const threshold = all.slice().sort((a, b) => a - b)[Math.floor(0.99 * (all.length - 1))]
    for (const y of ALL) { out.scores[stage][y] ??= keys.map(() => [0, 0]); real[y].forEach((v, k) => (out.scores[stage][y][k][SRC.indexOf(src)] = +(v / threshold).toFixed(3))) }
    const caught = {}
    for (const [name, t] of Object.entries(TAMPER)) {
      let hit = 0, n = 0
      for (const y of ALL) for (let k = 0; k < keys.length; k++) {
        const fake = tamper(days[src][k], y, t, last), s = seasonsOf(y)
        s[k] = seasonAgg(fake, y, last)
        n++, hit += score(feat(k, s, fake, y), model) > threshold
      }
      caught[name] = +(hit / n).toFixed(3)
    }
    const res = { model, threshold: +threshold.toFixed(3), physics: ph, base, falseFlags: +(all.filter((v) => v > threshold).length / all.length).toFixed(3), caught }
    if (stage === 'final') out.sources[src] = res
    else out.early.sources[src] = { ...res, physics: undefined } // same daily water-balance model as the final check
    console.log(`${stage} ${src}: threshold ${threshold.toFixed(2)} · real readings flagged ${(res.falseFlags * 100).toFixed(1)}% · caught:`,
      Object.entries(caught).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', '))
  }
}
writeFileSync('data/guard.json', JSON.stringify(out))
