# Proof of Drought

**Drought cover for Fiji's sugarcane farmers that pays itself, the moment two independent satellite records agree the rain has failed.**

IEEE ClimateChain Global Hackathon 2026 · Track: **Climate Data & Environmental Monitoring** ("environmental data is fragmented and difficult to verify")

---

## The problem

Fiji's 1997–98 El Niño drought ran for eleven consecutive months, from September 1997 to August 1998. In the worst-hit west, 90% of people were on food and water rations. The sugar industry forecast a F$104 million loss, and families working the cane farms saw their income fall from about F$5,000 to below F$1,500 a year. **Fiji's Cabinet declared a natural disaster on 22 September 1998, a year after the drought began.** The crop rehabilitation programme started in late September, and the UN found its benefits had not reached the most vulnerable farm labourers. *(Source: UN OCHA, Fiji Drought Situation Report No. 2, 16 December 1998.)*

Parametric insurance, which pays on a measured trigger instead of an assessed claim, already exists in the Pacific: the Pacific Catastrophe Risk Insurance Company covers governments, UNDP's Pacific Insurance and Climate Adaptation Programme has paid out in Fiji in 2023 and 2025, and a microinsurance scheme paid 15,295 people in Papua New Guinea after the 2026 drought. Its known weak points are trust in the trigger data, payouts that miss real losses (basis risk), and payments that arrive only after the damage.

## What it does

1. **Two independent data sources.** Daily rainfall and soil moisture since 1981 for Fiji's eight cane districts, from **Copernicus ERA5 / ERA5-Land** (Europe) and **NASA POWER / MERRA-2** (US).
2. **A drought index anyone can recompute.** For each district: the season's rainfall and soil moisture as percentiles of the WMO 1991–2020 baseline, averaged across both sources.
3. **A data guard (AI).** An anomaly-detection model trained on 30 years of real data flags readings that don't behave like real Fiji weather. Its verdict goes on-chain with every reading, and a flagged payout waits 14 days so it can be challenged.
4. **A smart contract that pays.** Two oracles, one per source, each post their reading, the guard's verdict and the SHA-256 fingerprint of the exact daily data behind it. When both have reported, `DroughtCover.sol` checks they agree, applies the public rules and pays every farmer in the district at once.
5. **Public verification.** Anyone can re-download the data from Copernicus and NASA and check it against the fingerprint on the ledger. The website does this live, in the browser. Reanalysis archives are occasionally revised (Open-Meteo changed some ERA5 daily rain values by about 0.1 mm between 12 and 14 October 2026, so the data here was re-downloaded on 14 October; no payout in the backtest changed). If the archive has been revised since a reading was sealed, the check says so, shows how much the totals moved, and re-ranks the new data by the same rules to show whether the payout decision would change.
6. **A live tracker for the 2026–27 season.** A strong El Niño is under way (NOAA's Niño-3.4 index was +2.8 °C in September 2026, against +1.8 °C in September 1997). The site downloads today's Copernicus and NASA readings for every district as you open it and ranks them exactly as the contract will, with a countdown to each checkpoint.
7. **A forecast and a price (AI).** A model trained on 44 seasons gives the chance a district pays this season, and the same model sets a premium that can't be gamed by buying only in El Niño years.

### The rules (in `scripts/rules.mjs` and `contracts/DroughtCover.sol`, checked to match)

| Checkpoint | Trigger | Pays |
| :--- | :--- | :--- |
| Early, end of January | District in its driest 10% | 30% of cover, while there's time to save stock and replant |
| Final, end of April | District in its driest 10% | 100% of cover, less anything paid early |
| Final, end of April | District in its driest 20% | 50% of cover |
| Any | The two sources differ by more than 25 percentile points | Nothing; the disagreement is logged on-chain |
| Any | Either source's data guard flags its reading, and a payout is due | Payout held for 14 days; after it, anyone can release it. If both guards flagged it, the insurer can reject it during the 14 days (logged on-chain) |

## Results

### 45 seasons of backtest (1982–2026), against Fiji's real cane yields (FAOSTAT)

| Season | Paid (share of cover, average over districts) | Districts paid | Cane yield vs nearby seasons | |
| :--- | ---: | ---: | ---: | :--- |
| 1983 | 56% | 6/8 | −37% | El Niño drought |
| 1987 | 44% | 7/8 | −30% | El Niño drought |
| 1992 | 50% | 8/8 | −13% | El Niño drought |
| **1998** | **100%** | **8/8** | **−29%** | **El Niño drought, early payout in January in 7/8 districts** |
| 2010 | 63% | 7/8 | −14% | El Niño drought |
| 1985 | 0% | 0/8 | −27% | Cyclones Eric and Nigel (not a drought) |
| 2012 | 0% | 0/8 | −18% | Floods (not a drought) |
| 2016 | 11% | 3/8 | −22% | Cyclone Winston (not a drought) |
| 1990 | 50% | 7/8 | +15% | Dry season, harvest held up |
| 2005 | 31% | 5/8 | 0% | Dry season, harvest held up |

- Every El Niño drought loss year was paid. The cyclone and flood loss years were not, as intended: they need a different product.
- Every payout was in a genuinely dry season (both records in the driest 20%). In two of them, 1990 and 2005, the cane coped and the harvest held up; those payouts are included in the price below.
- Average payout: **10.4% of cover per year**, the fair price before costs.
- Yields are national; payouts are per district, so district payouts can't be validated against district harvests.

### Data guard

Trained on 1991–2020; features: rainfall-vs-soil percentile gap, dryness vs the other districts, and the error of a daily water-balance regression. One model per checkpoint window (final: Nov–Apr; early: Nov–Jan). Threshold = 99th percentile of real readings. Evaluated over every season 1982–2026 (training years included):

| | Real readings flagged | Rain halved | Rain cut to 30% | Rain wiped to zero | Rain and soil both faked |
| :--- | ---: | ---: | ---: | ---: | ---: |
| ERA5, final check | 1.1% | 57% | 64% | 95% | 75% |
| NASA POWER, final check | 1.1% | 71% | 87% | 98% | 83% |
| ERA5, early check | 1.1% | 48% | 66% | 85% | 73% |
| NASA POWER, early check | 1.1% | 57% | 72% | 93% | 73% |

Each oracle posts the guard's verdict on-chain with its reading (the score as a share of the threshold). If either is flagged and a payout is due, the contract holds it for 14 days, and anyone can release it after. The insurer can reject it during that time only if **both** guards flagged it (for example after showing the data doesn't match the public archives). Payouts on unflagged data are never delayed. **In 45 years of real data, the guard flagged 16 readings and none of them was in a season that paid, so it would never have delayed a real payout.**

The guard is one of three locks: the contract also requires two independent agencies' data to agree, and every reading's fingerprint can be checked against the public archives by anyone. In the website's "fake a drought" game, hacking both feeds hard enough to trigger a payout gets the payout held and then rejected. A fake subtle enough to slip past the guard would be paid, but it stays provably different from the archives, permanently. The guard runs inside the oracles, so it protects against faked *data*; stolen oracle *keys* could post a false verdict, which is what the public seal is for.

**Threat model for the hold.** Who could stop a real payout?
- One oracle alone, or the insurer plus one colluding oracle posting a false flag: they can **delay** it by 14 days, not cancel it, because rejection needs both guards' flags.
- Both oracles plus the insurer: they could cancel it, in public, with the real data still in the archives to prove it. A real scheme would make the oracles independent organisations (or a multisig) and could hand rejection to an independent arbiter.

### Forecast: the chance a district pays this season

One input, known by early October, a month before cover is sold: the Niño-3.4 sea-surface temperature anomaly averaged over August and September (NOAA CPC). Logistic regression over every district and season since 1983, tested by leaving one whole season out at a time.

- In an ordinary season, 17% of districts are paid. For 2026–27 the model says **61%**.
- Skill against always guessing the average: 5.5% better (Brier score, on seasons it never saw). Modest, and reported as such: the 1987–88 and 2023–24 seasons had strong El Niños and brought no drought payouts.
- This year's El Niño is stronger than any in the training seasons, so it is treated as being as strong as the strongest one seen (1997) rather than extrapolated.
- We tried adding each district's September soil moisture. It barely changed the skill and its weight pointed the wrong way, so it was left out.

### Pricing that can't be gamed

If everyone can see El Niño coming, people will buy cover only in El Niño years. Over 1983–2026:

| Buyers who only join when Niño-3.4 ≥ +1 °C | Paid out per F$1 of premium |
| :--- | ---: |
| One flat price (10.6% of cover a year) | **3.15** (the pool goes broke) |
| Priced by the forecast before each season | **1.03** |

Sales close on 1 November, before the season's rain is known. This season's forecast price is about F$380 per F$1,000 of cover before costs. A price that high in an El Niño year is where government or donor premium support matters most.

### At Fiji's scale

Fiji has about 10,200 active cane growers. With F$1,000 of cover each, spread evenly across the eight districts, the 1998 season would have paid **F$2.7 million in January and F$10.2 million by the end of April**. The website's insurer view and "For insurers and funders" section run the pool over 44 seasons at this scale: priced by the forecast with a 20% margin, it needs F$14.8 million of starting capital never to run dry and pays out F$0.83 per F$1 of premium.

### Contract

`npm test` runs 17 checks against a fresh deployment: only the insurer issues policies, only the two oracles report, one oracle alone can't trigger a payout, early + final never exceeds 100%, disagreeing sources pay nothing, the pool must cover every payout before anyone is paid, a wallet that refuses payment can't block its district (its money waits for it), a flagged payout is held, can be rejected only during its challenge period and only if both guards flagged it, and is released after it, flagged data with nothing due isn't held, and the on-chain rule matches `scripts/rules.mjs`.

## What's real and what's simulated

**Real:** all weather data (Copernicus ERA5 / ERA5-Land, NASA POWER), including today's readings in the live tracker; the Niño-3.4 record (NOAA CPC); FAOSTAT yields; the 1998 figures and timeline (UN OCHA); the smart contract, executed by a real Ethereum Virtual Machine.

**Simulated:** the 96 farmers, their wallets and the money (test funds on a private chain in the browser); district points are approximate centres of each cane sector; the payout rules, the 20% pricing margin and the even split of growers across districts were set by this project, and a real scheme would set them with an insurer and the regulator.

**Not done yet:** the contract runs on a private chain in the browser, not a public testnet; alerts are in English only (Fiji Hindi and iTaukei versions need checking by native speakers first).

## Run it

Needs Node.js 20+.

```bash
npm install
npm run dev
```

Open `http://localhost:5180`. The website runs the contract in the browser with `@ethereumjs/vm`, so no wallet, keys or network are needed. `npm run build` produces a static site in `dist/` that can be hosted anywhere.

**Contract tests** (two terminals):

```bash
npm run chain
```

```bash
npm test
```

**Rebuild the data from scratch:**

```bash
npm run data:climate
```

```bash
npm run data:yield -- path/to/Production_Crops_Livestock_E_Oceania_NOFLAG.csv
```

```bash
npm run data
```

`data:climate` also downloads the Niño-3.4 record. `data:yield` needs FAOSTAT's bulk file ([download](https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Oceania.zip), unzip). `npm run data` rebuilds the index, retrains the guard and the forecast, recompiles the contract, repacks `public/data/` and checks that the live tracker ranks every past checkpoint the way the contract did.

## Repository layout

```
contracts/DroughtCover.sol    the smart contract (and its compiled ABI)
scripts/fetch-climate.mjs     daily ERA5 + NASA POWER data → data/climate/
scripts/fetch-yield.mjs       FAOSTAT cane yields → data/yield.json
scripts/build-index.mjs       drought index, payouts, backtest, replays → data/index.json
scripts/train-guard.mjs       trains and evaluates the data guard, scores every real reading → data/guard.json
scripts/fetch-nino.mjs        NOAA CPC Niño-3.4 monthly anomalies → data/nino34-sstoi.txt
scripts/build-forecast.mjs    the payout forecast and pricing → data/forecast.json
scripts/build-now.mjs         the live tracker's baseline → public/data/now.json
scripts/check-now.mjs         checks the live tracker against every past checkpoint
scripts/rules.mjs             the payout rules (mirrored in the contract)
scripts/test-contract.mjs     17 rule checks on a local chain
src/guard.js                  the data guard model (shared by training and the browser)
src/now.js                    the live tracker's ranking (shared by the check and the browser)
src/evm.js                    in-browser Ethereum (EthereumJS VM)
src/main.js, index.html       the website
```

## Sources, licences and acknowledgements

| Source | Use | Terms |
| :--- | :--- | :--- |
| Copernicus ERA5 and ERA5-Land, via the [Open-Meteo](https://open-meteo.com/) archive API | Rainfall, soil moisture | Contains modified Copernicus Climate Change Service information 2026. Open-Meteo data: CC BY 4.0 |
| [NASA POWER](https://power.larc.nasa.gov/) (MERRA-2) | Rainfall, root-zone soil wetness | These data were obtained from the NASA Langley Research Center POWER Project funded through the NASA Earth Science / Applied Science Program |
| [NOAA Climate Prediction Center](https://www.cpc.ncep.noaa.gov/data/indices/), monthly Niño-3.4 (OISST v2.1, 1991–2020 normal) and the ENSO Diagnostic Discussion of 8 Oct 2026 | El Niño forecast input; El Niño status | US Government work |
| [FAOSTAT](https://www.fao.org/faostat/), Crops and livestock products | Fiji sugarcane yields | FAO statistical database terms of use |
| UN OCHA, *Fiji – Drought OCHA Situation Report No. 2*, 16 Dec 1998 | 1998 timeline and figures | Cited |
| Fiji Times, "Awards for cane growers", Oct 2025 | About 10,200 active cane farmers (Prime Minister Sitiveni Rabuka) | Cited |
| [Sentinel-2 cloudless](https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024) | Satellite basemap | CC BY-NC-SA 4.0 |

Libraries: [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) VM, tx, block, util (MPL-2.0) and common (MIT); [ethers](https://ethers.org/) (MIT); [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause); [Vite](https://vitejs.dev/) (MIT); [solc-js](https://github.com/ethereum/solc-js) (MIT); [Hardhat](https://hardhat.org/) (MIT, local test chain only).

### AI tools disclosure

This project was built with **Claude Code** (Anthropic) as a coding assistant: it wrote most of the code and these docs under my direction, and I reviewed and tested the results. The app itself uses no generative AI; the data guard (anomaly detection) and the forecast (logistic regression) are small statistical models trained locally on the public data above.

## Licence

Code: [MIT](LICENSE).
