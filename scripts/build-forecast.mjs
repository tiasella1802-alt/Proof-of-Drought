// The forecast: "chance your district pays this season", known before the season starts.
//   node scripts/build-forecast.mjs   → data/forecast.json
//
// One input, known by early October, a month before cover is sold for the season (Nov–Apr):
//   nino  the Niño-3.4 sea-surface temperature anomaly, mean of August and September (NOAA CPC)
// Model: logistic regression over every district and season since 1983 (the Niño record starts in 1982). Skill is
// measured honestly by leaving one whole season out at a time. We also tried adding each district's September soil
// moisture: it barely changed the skill and its weight pointed the wrong way (wetter soil, more payouts), so it's left
// out. It is still reported, as context for the live tracker. An El Niño stronger than any in the training seasons is
// treated as being as strong as the strongest one seen, rather than extrapolated.
// The same model prices the cover: expected payout = chance it pays × the average share paid when it does.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'

const IDX = JSON.parse(readFileSync('data/index.json', 'utf8'))
const climate = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const N34 = {}
for (const line of readFileSync('data/nino34-sstoi.txt', 'utf8').trim().split('\n').slice(1)) {
  const c = line.trim().split(/\s+/)
  N34[`${c[0]}-${c[1].padStart(2, '0')}`] = +c[9]
}
const nino = (y) => (N34[`${y - 1}-08`] + N34[`${y - 1}-09`]) / 2 // for the season ending in April of year y
const septSoil = (src, d, yr) => { const s = climate[d][src]; let t = 0, n = 0
  for (let i = 0; i < s.time.length; i++) if (s.time[i].startsWith(`${yr}-09`) && s.soil[i] != null) t += s.soil[i], n++
  return t / n }
const pct = (v, base) => base.filter((b) => b <= v).length / base.length
const BASE = Array.from({ length: 30 }, (_, i) => 1990 + i)
const septBase = Object.fromEntries(DISTRICTS.flatMap((d) => ['era5', 'power'].map((s) => [`${d.key}/${s}`, BASE.map((yr) => septSoil(s, d.key, yr))])))
const soil = (y, d) => (['era5', 'power'].reduce((a, s) => a + pct(septSoil(s, d, y - 1), septBase[`${d}/${s}`]), 0) / 2)

// One row per season and district.
const paidShare = (s, k) => Math.max(s.early?.[k].due ?? 0, s.final[k].due)
const rows = IDX.seasons.filter((s) => s.final && Number.isFinite(nino(s.season))).flatMap((s) =>
  DISTRICTS.map((d, k) => ({ season: s.season, k, nino: nino(s.season), soil: soil(s.season, d.key), share: paidShare(s, k), paid: paidShare(s, k) > 0 ? 1 : 0 })))

const sig = (z) => 1 / (1 + Math.exp(-z))
function fit(data) {
  // Newton's method on [1, nino], with a small ridge penalty on the slope.
  let w = [0, 0]
  for (let it = 0; it < 50; it++) {
    let g0 = 0, g1 = 0.1 * w[1], h00 = 0, h01 = 0, h11 = 0.1
    for (const r of data) { const p = sig(w[0] + w[1] * r.nino), e = p - r.paid, v = p * (1 - p)
      g0 += e, g1 += e * r.nino, h00 += v, h01 += v * r.nino, h11 += v * r.nino * r.nino }
    const det = h00 * h11 - h01 * h01, s0 = (h11 * g0 - h01 * g1) / det, s1 = (h00 * g1 - h01 * g0) / det
    w = [w[0] - s0, w[1] - s1]
    if (Math.abs(s0) + Math.abs(s1) < 1e-10) break
  }
  return [...w, Math.max(...data.map((r) => r.nino))] // weights, and the strongest El Niño the model has seen
}
const prob = (w, r) => sig(w[0] + w[1] * Math.min(r.nino, w[2]))

const w = fit(rows)
const seasons = [...new Set(rows.map((r) => r.season))]
// Leave-one-season-out: each season is forecast by a model that never saw it.
const loso = new Map()
for (const y of seasons) { const wy = fit(rows.filter((r) => r.season !== y)); for (const r of rows.filter((r) => r.season === y)) loso.set(r, prob(wy, r)) }
const base = rows.reduce((a, r) => a + r.paid, 0) / rows.length
const brier = rows.reduce((a, r) => a + (loso.get(r) - r.paid) ** 2, 0) / rows.length
const brierClim = rows.reduce((a, r) => a + (base - r.paid) ** 2, 0) / rows.length
const whenPaid = rows.filter((r) => r.paid), shareWhenPaid = whenPaid.reduce((a, r) => a + r.share, 0) / whenPaid.length
const avgShare = rows.reduce((a, r) => a + r.share, 0) / rows.length

// Pricing. If buyers can see El Niño coming and only buy in El Niño years, a flat price loses money.
const elNino = rows.filter((r) => r.nino >= 1)
const lossRatio = (set, premium) => set.reduce((a, r) => a + r.share, 0) / set.reduce((a, r) => a + premium(r), 0)
const pricing = {
  flat: +avgShare.toFixed(4),
  shareWhenPaid: +shareWhenPaid.toFixed(3),
  elNinoSeasons: [...new Set(elNino.map((r) => r.season))],
  // Paid out per F$1 of premium, for buyers who only join when El Niño is showing (Niño-3.4 ≥ +1 °C in Aug–Sep):
  flatLossRatio: +lossRatio(elNino, () => avgShare).toFixed(2),
  forecastLossRatio: +lossRatio(elNino, (r) => loso.get(r) * shareWhenPaid).toFixed(2),
  // and for everyone, every year, priced by the forecast:
  forecastLossRatioAll: +lossRatio(rows, (r) => loso.get(r) * shareWhenPaid).toFixed(2),
}

// This season: the first one whose cover hasn't been sold yet.
const lastSeason = Math.max(...IDX.seasons.map((s) => s.season))
const next = IDX.seasons.at(-1).final ? lastSeason + 1 : lastSeason
const now = { season: next, nino: +nino(next).toFixed(2), months: [`${next - 1}-08`, `${next - 1}-09`].map((m) => [m, N34[m]]),
  districts: DISTRICTS.map((d) => { const r = { nino: nino(next), soil: soil(next, d.key) }, p = prob(w, r)
    return { key: d.key, soil: +r.soil.toFixed(3), chance: +p.toFixed(3), price: +(p * shareWhenPaid).toFixed(4) } }) }

const history = seasons.map((y) => ({ season: y, nino: +nino(y).toFixed(2),
  districts: rows.filter((r) => r.season === y).map((r) => ({ soil: +r.soil.toFixed(3), chance: +loso.get(r).toFixed(3), paid: r.share })) }))

// Month by month, this year's El Niño against 1997's (the one before Fiji's 1998 drought).
const series = (yr) => Array.from({ length: 12 }, (_, i) => N34[`${yr}-${String(i + 1).padStart(2, '0')}`] ?? null)
const compare = { then: { year: 1997, months: series(1997) }, now: { year: next - 1, months: series(next - 1) } }

writeFileSync('data/forecast.json', JSON.stringify({ compare, built: new Date().toISOString(), inputs: ['Niño-3.4 anomaly, Aug–Sep (NOAA CPC)'], context: 'now.districts[].soil is September soil moisture (percentile, both sources), shown for context only: the model does not use it',
  weights: w.slice(0, 2).map((v) => +v.toFixed(4)), cap: +w[2].toFixed(2), base: +base.toFixed(3), skill: { brier: +brier.toFixed(4), brierClimatology: +brierClim.toFixed(4), score: +(1 - brier / brierClim).toFixed(3) },
  pricing, now, history }))

console.log(`weights ${w.slice(0, 2).map((v) => v.toFixed(2)).join(', ')} (Niño capped at ${w[2].toFixed(2)}) · seasons ${seasons[0]}–${seasons.at(-1)}`)
console.log(`base rate ${(base * 100).toFixed(1)}% · Brier ${brier.toFixed(3)} vs ${brierClim.toFixed(3)} (always-the-average) → skill ${((1 - brier / brierClim) * 100).toFixed(0)}%`)
console.log(`pricing: flat ${(avgShare * 100).toFixed(1)}% · El Niño-only buyers paid ${pricing.flatLossRatio}× premium (flat) vs ${pricing.forecastLossRatio}× (forecast-priced) · all years ${pricing.forecastLossRatioAll}×`)
for (const h of history.filter((h) => h.nino >= 1 || h.districts.some((d) => d.paid))) console.log(`  ${h.season} nino ${h.nino.toFixed(2)}  chance ${h.districts.map((d) => Math.round(d.chance * 100)).join(' ')}  paid ${h.districts.map((d) => Math.round(d.paid * 100)).join(' ')}`)
console.log(`${now.season}: Niño ${now.nino} → ${now.districts.map((d) => `${d.key} ${Math.round(d.chance * 100)}% (soil ${Math.round(d.soil * 100)})`).join(', ')}`)
