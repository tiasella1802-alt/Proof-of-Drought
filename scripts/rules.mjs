// The payout rules. The same numbers are written into the smart contract (contracts/DroughtCover.sol), so the
// backtest in data/index.json is exactly what the contract would have paid.
// Index = district dryness percentile against 1991–2020 (0 = driest). Payouts are shares of each farmer's cover.
export const RULES = {
  early: { at: 0.10, pay: 0.30 },    // end of January: driest 10% → pay 30% now, before the crop fails
  severe: { at: 0.10, pay: 1.00 },   // end of April: driest 10% → full cover (less anything paid early)
  moderate: { at: 0.20, pay: 0.50 }, // end of April: driest 20% → half cover
  maxGap: 0.25,                      // the two independent sources must agree within 25 percentile points, or nothing pays
}
