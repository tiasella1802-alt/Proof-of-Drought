// The payout rules. The same numbers are written into the smart contract (contracts/DroughtCover.sol), so the
// backtest in data/index.json is exactly what the contract would have paid.
// Index = district dryness percentile against 1991–2020 (0 = driest). Payouts are shares of each farmer's cover.
export const RULES = {
  early: { at: 0.10, pay: 0.30 },    // end of January: driest 10% → pay 30% now, before the crop fails
  severe: { at: 0.10, pay: 1.00 },   // end of April: driest 10% → full cover (less anything paid early)
  moderate: { at: 0.20, pay: 0.50 }, // end of April: driest 20% → half cover
  maxGap: 0.25,                      // two records "agree" when they are within 25 percentile points
}

// Which records decide. Copernicus ERA5 and NASA POWER (rain and soil moisture) decide when they agree; CHIRPS
// (satellite and rain-gauge rainfall) is the third witness. If ERA5 and NASA disagree, CHIRPS breaks the tie: the
// pair that agrees decides (the closer pair if both do). If no two agree, nothing pays. Until CHIRPS is published for
// the window (a few weeks after month end), a disagreement waits for it. Dryness values are 0–1.
export function decide({ era5, power, chirps }) {
  const g = (a, b) => Math.abs(a - b), ok = (a, b) => g(a, b) <= RULES.maxGap + 1e-9
  if (ok(era5, power)) return { index: (era5 + power) / 2, deciders: ['era5', 'power'], gap: g(era5, power),
    chirpsAgrees: chirps == null ? null : ok(chirps, (era5 + power) / 2) }
  if (chirps == null) return { index: null, deciders: [], gap: g(era5, power), pending: true }
  const pairs = [['era5', era5], ['power', power]].filter(([, v]) => ok(v, chirps)).sort((a, b) => g(a[1], chirps) - g(b[1], chirps))
  if (!pairs.length) return { index: null, deciders: [], gap: g(era5, power) }
  const [name, v] = pairs[0]
  return { index: (v + chirps) / 2, deciders: [name, 'chirps'], gap: g(v, chirps), tieBreak: true }
}

export function shareDue(stage, index) {
  if (index == null) return 0
  if (stage === 'early') return index <= RULES.early.at ? RULES.early.pay : 0
  return index <= RULES.severe.at ? RULES.severe.pay : index <= RULES.moderate.at ? RULES.moderate.pay : 0
}
