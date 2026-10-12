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
3. **A data guard (AI).** An anomaly-detection model trained on 30 years of real data flags readings that don't behave like real Fiji weather.
4. **A smart contract that pays.** Two oracles, one per source, each post their reading with the SHA-256 fingerprint of the exact daily data behind it. When both have reported, `DroughtCover.sol` checks they agree, applies the public rules and pays every farmer in the district at once.
5. **Public verification.** Anyone can re-download the data from Copernicus and NASA and check it against the fingerprint on the ledger. The website does this live, in the browser.

### The rules (in `scripts/rules.mjs` and `contracts/DroughtCover.sol`, checked to match)

| Checkpoint | Trigger | Pays |
| :--- | :--- | :--- |
| Early, end of January | District in its driest 10% | 30% of cover, while there's time to save stock and replant |
| Final, end of April | District in its driest 10% | 100% of cover, less anything paid early |
| Final, end of April | District in its driest 20% | 50% of cover |
| Any | The two sources differ by more than 25 percentile points | Nothing; the disagreement is logged on-chain |

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
| 1990 | 50% | 7/8 | +15% | **False alarm** |
| 2005 | 31% | 5/8 | 0% | **False alarm** |

- Every El Niño drought loss year was paid. The cyclone and flood loss years were not, as intended: they need a different product.
- Two clear false alarms in 45 seasons. They are published, not hidden.
- Average payout: **10.4% of cover per year**, the fair price before costs.
- Yields are national; payouts are per district, so district payouts can't be validated against district harvests.

### Data guard

Trained on 1991–2020; features: rainfall-vs-soil percentile gap, dryness vs the other districts, and the error of a daily water-balance regression. Threshold = 99th percentile of real readings. Evaluated over every season 1982–2026 (training years included):

| | Real readings flagged | Rain halved | Rain cut to 30% | Rain wiped to zero | Rain and soil both faked |
| :--- | ---: | ---: | ---: | ---: | ---: |
| ERA5 | 1.1% | 57% | 64% | 95% | 75% |
| NASA POWER | 1.1% | 71% | 87% | 98% | 83% |

The guard alone is not enough, which is why it is one of three locks: the contract also requires two independent agencies' data to agree, and every reading's fingerprint can be checked against the public archives by anyone. An attacker who controls *both* data feeds can get a payout through the contract, but the fake data is flagged by the guard and provably different from the archives, permanently.

### Contract

`npm test` runs 14 checks against a fresh deployment: only the insurer issues policies, only the two oracles report, one oracle alone can't trigger a payout, early + final never exceeds 100%, disagreeing sources pay nothing, the pool must cover every payout before anyone is paid, a wallet that refuses payment can't block its district (its money waits for it), and the on-chain rule matches `scripts/rules.mjs`.

## What's real and what's simulated

**Real:** all weather data (Copernicus ERA5 / ERA5-Land, NASA POWER); FAOSTAT yields; the 1998 figures and timeline (UN OCHA); the smart contract, executed by a real Ethereum Virtual Machine.

**Simulated:** the 96 farmers, their wallets and the money (test funds on a private chain in the browser); district points are approximate centres of each cane sector; the payout rules were set by this project and a real scheme would set them with an insurer and the regulator.

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

`data:yield` needs FAOSTAT's bulk file ([download](https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Oceania.zip), unzip). `npm run data` rebuilds the index, retrains the guard, recompiles the contract and repacks `public/data/`.

## Repository layout

```
contracts/DroughtCover.sol    the smart contract (and its compiled ABI)
scripts/fetch-climate.mjs     daily ERA5 + NASA POWER data → data/climate/
scripts/fetch-yield.mjs       FAOSTAT cane yields → data/yield.json
scripts/build-index.mjs       drought index, payouts, backtest, replays → data/index.json
scripts/train-guard.mjs       trains and evaluates the data guard → data/guard.json
scripts/rules.mjs             the payout rules (mirrored in the contract)
scripts/test-contract.mjs     14 rule checks on a local chain
src/guard.js                  the data guard model (shared by training and the browser)
src/evm.js                    in-browser Ethereum (EthereumJS VM)
src/main.js, index.html       the website
```

## Sources, licences and acknowledgements

| Source | Use | Terms |
| :--- | :--- | :--- |
| Copernicus ERA5 and ERA5-Land, via the [Open-Meteo](https://open-meteo.com/) archive API | Rainfall, soil moisture | Contains modified Copernicus Climate Change Service information 2026. Open-Meteo data: CC BY 4.0 |
| [NASA POWER](https://power.larc.nasa.gov/) (MERRA-2) | Rainfall, root-zone soil wetness | These data were obtained from the NASA Langley Research Center POWER Project funded through the NASA Earth Science / Applied Science Program |
| [FAOSTAT](https://www.fao.org/faostat/), Crops and livestock products | Fiji sugarcane yields | FAO statistical database terms of use |
| UN OCHA, *Fiji – Drought OCHA Situation Report No. 2*, 16 Dec 1998 | 1998 timeline and figures | Cited |
| [OpenFreeMap](https://openfreemap.org/) / © OpenStreetMap contributors | Basemap | ODbL |

Libraries: [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) VM, tx, util (MPL-2.0) and common (MIT); [ethers](https://ethers.org/) (MIT); [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause); [Vite](https://vitejs.dev/) (MIT); [solc-js](https://github.com/ethereum/solc-js) (MIT); [Hardhat](https://hardhat.org/) (MIT, local test chain only).

### AI tools disclosure

This project was built with **Claude Code** (Anthropic) as a coding assistant: it wrote most of the code and these docs under my direction, and I reviewed and tested the results. The app itself uses no generative AI; the data guard is a statistical anomaly-detection model trained locally on the public data above.

## Licence

Code: [MIT](LICENSE).
