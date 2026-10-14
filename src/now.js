// The live tracker's maths: ranks "the season so far" exactly as the contract's checkpoints are ranked (scripts/build-index.mjs),
// against the 1991–2020 baseline packed by scripts/build-now.mjs. Shared by the browser and the consistency check.
export const SEASON_START = 61 // day offset of 1 November from 1 September

const pct = (v, base) => base.filter((b) => b <= v).length / base.length

// rows: daily [date, rain, soil] from 1 September (no 29 February). Counts days up to the last one with both values.
export const usable = (rows) => { let n = rows.length; while (n && (rows[n - 1][1] == null || rows[n - 1][2] == null)) n--; return n }

// One source's dryness for days [from, to): mean of its rainfall and soil-moisture percentiles.
export function dryness(rows, base, from, to) {
  let rain = 0, soil = 0, n = 0
  for (let i = from; i < to; i++) { rain += rows[i][1] ?? 0; if (rows[i][2] != null) soil += rows[i][2], n++ }
  soil /= n
  const b = base.map(([r, s]) => { let br = 0, bs = 0, bn = 0
    for (let i = from; i < to; i++) { br += r[i]; if (s[i] != null) bs += s[i], bn++ }
    return [br / 100, bs / bn / 1e4] })
  const rainPct = pct(+rain.toFixed(1), b.map((x) => +x[0].toFixed(1))), soilPct = pct(+soil.toFixed(4), b.map((x) => +x[1].toFixed(4)))
  return { rain, soil, rainPct, soilPct, dryness: (rainPct + soilPct) / 2 }
}

// Both sources for one district (base = its entry in now.json), over the same days. Returns the index the contract would compute from them.
export function district(live, base, from) {
  const to = Math.min(usable(live.era5), usable(live.power))
  if (to <= from) return null
  const era5 = dryness(live.era5, base.era5.base, from, to), power = dryness(live.power, base.power.base, from, to)
  return { to, era5, power, index: (era5.dryness + power.dryness) / 2, gap: Math.abs(era5.dryness - power.dryness) }
}
