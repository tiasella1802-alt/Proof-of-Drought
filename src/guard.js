// Data guard: an anomaly-detection model that flags weather data that doesn't behave like real Fiji weather.
// Shared by the training script (Node) and the browser, so the "try to fake a drought" demo runs the real model.
//
// For one data source, one district and one season window (Nov–Apr for the final check, Nov–Jan for the early one) it looks at three things real data keeps consistent:
//   1. rain vs soil:  the season's rainfall percentile minus its soil-moisture percentile (dry rain → dry soil)
//   2. neighbours:    the district's dryness minus the mean of the other districts (seasons are regional)
//   3. physics:       how well each day's soil-moisture change follows from that day's and the day before's rain,
//                     using a per-district water-balance regression fitted on 1991–2020 (log mean squared error)
// Training learns the mean and covariance of these three features over real seasons. A reading's anomaly score is its
// Mahalanobis distance from that cloud; above the threshold (the 99th percentile of real readings) it is flagged.

// last = the window's last month: 4 (April, final check) or 1 (January, early check).
export const inSeason = (t, y, last = 4) => { const yy = +t.slice(0, 4), m = +t.slice(5, 7); return (yy === y - 1 && m >= 11) || (yy === y && m <= last) }

// Least squares for the daily water balance: Δsoil = a·ln(1+rain) + b·ln(1+rain yesterday) + c·(soil yesterday − mean) + d
export function fitPhysics(days, from = 1991, to = 2020) {
  let mean = 0, n = 0
  for (const d of days) if (d[2] != null) mean += d[2], n++
  mean /= n
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0, 0], X = [], Y = []
  for (let i = 1; i < days.length; i++) {
    const [t, r, s] = days[i], [, r1, s1] = days[i - 1], yr = +t.slice(0, 4)
    if (yr < from || yr > to || s == null || s1 == null || r == null || r1 == null) continue
    const x = [Math.log1p(r), Math.log1p(r1), s1 - mean, 1], y = s - s1
    X.push(x), Y.push(y)
    for (let a = 0; a < 4; a++) { B[a] += x[a] * y; for (let b = 0; b < 4; b++) A[a][b] += x[a] * x[b] }
  }
  const w = solve(A, B)
  let ss = 0
  X.forEach((x, k) => { const e = Y[k] - x.reduce((s, v, i) => s + v * w[i], 0); ss += e * e })
  return { w, mean, sd: Math.sqrt(ss / X.length) }
}

function solve(A, B) { // Gauss–Jordan with partial pivoting, small dense systems
  A = A.map((r) => r.slice()), B = B.slice()
  const n = B.length
  for (let i = 0; i < n; i++) {
    let p = i
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r
    ;[A[i], A[p]] = [A[p], A[i]], [B[i], B[p]] = [B[p], B[i]]
    for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; B[r] -= f * B[i] }
  }
  return B.map((b, i) => b / A[i][i])
}

// Season totals from daily rows [date, rain mm, soil] (rain summed, soil averaged).
export function seasonAgg(days, y, last = 4) {
  let rain = 0, soil = 0, n = 0
  for (const [t, r, s] of days) if (inSeason(t, y, last)) { rain += r ?? 0; if (s != null) soil += s, n++ }
  return [rain, soil / n]
}

// Log mean squared standardised error of the water balance over the season (≈0 for real data).
export function physicsScore(days, y, m, last = 4) {
  let ss = 0, n = 0
  for (let i = 1; i < days.length; i++) {
    const [t, r, s] = days[i], [, r1, s1] = days[i - 1]
    if (!inSeason(t, y, last) || s == null || s1 == null) continue
    const p = m.w[0] * Math.log1p(r ?? 0) + m.w[1] * Math.log1p(r1 ?? 0) + m.w[2] * (s1 - m.mean) + m.w[3]
    const e = (s - s1 - p) / m.sd
    ss += e * e, n++
  }
  return Math.log(ss / n)
}

export const pct = (v, base) => base.filter((b) => b <= v).length / base.length

// The three features for district k. seasons[j] = [rain, soil] for every district this season (k's may be tampered);
// base[j] = { rain: [...], soil: [...] } baseline totals; days = k's daily rows (possibly tampered); phys = k's model.
export function features(k, seasons, base, days, y, phys, last = 4) {
  const dry = seasons.map(([r, s], j) => { const rp = pct(r, base[j].rain), sp = pct(s, base[j].soil); return { rp, sp, d: (rp + sp) / 2 } })
  const others = dry.filter((_, j) => j !== k)
  return [dry[k].rp - dry[k].sp, dry[k].d - others.reduce((a, o) => a + o.d, 0) / others.length, physicsScore(days, y, phys, last)]
}

export function fitGaussian(rows) {
  const n = rows.length, mean = rows[0].map((_, i) => rows.reduce((a, r) => a + r[i], 0) / n)
  const cov = mean.map((_, i) => mean.map((_, j) => rows.reduce((a, r) => a + (r[i] - mean[i]) * (r[j] - mean[j]), 0) / (n - 1)))
  return { mean, inv: invert3(cov) }
}

function invert3([[a, b, c], [d, e, f], [g, h, i]]) {
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C
  return [[A, -(b * i - c * h), b * f - c * e], [B, a * i - c * g, -(a * f - c * d)], [C, -(a * h - b * g), a * e - b * d]].map((r) => r.map((v) => v / det))
}

export function score(x, { mean, inv }) {
  const d = x.map((v, i) => v - mean[i])
  return Math.sqrt(d.reduce((s, _, i) => s + d[i] * inv[i].reduce((t, _, j) => t + inv[i][j] * d[j], 0), 0))
}
