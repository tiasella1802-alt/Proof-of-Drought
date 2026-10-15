# Proof of Drought

**Drought cover for Fiji's sugarcane farmers that pays itself, as soon as independent climate records agree the rain has failed.**

IEEE ClimateChain Global Hackathon 2026 · Track: **Climate Data & Environmental Monitoring** ("environmental data is fragmented and difficult to verify")

---

## The problem

Fiji's 1997–98 El Niño drought ran for eleven consecutive months, from September 1997 to August 1998. In the worst-hit west, 90% of people were on food and water rations. The sugar industry forecast a F$104 million loss, and families working the cane farms saw their income fall from about F$5,000 to below F$1,500 a year. **Fiji's Cabinet declared a natural disaster on 22 September 1998, a year after the drought began.** The crop rehabilitation programme started in late September, and the UN found its benefits had not reached the most vulnerable farm labourers. *(Source: UN OCHA, Fiji Drought Situation Report No. 2, 16 December 1998.)*

Parametric insurance, which pays on a measured trigger instead of an assessed claim, already exists in the Pacific: the Pacific Catastrophe Risk Insurance Company covers governments, UNDP's Pacific Insurance and Climate Adaptation Programme has paid out in Fiji in 2023 and 2025, and a microinsurance scheme paid 15,295 people in Papua New Guinea after the 2026 drought. Its known weak points are trust in the trigger data, payouts that miss real losses (basis risk), and payments that arrive only after the damage.

## What it does

1. **Three independent rainfall records** for Fiji's eight cane districts, daily since 1981:
   - **Copernicus ERA5 / ERA5-Land** (Europe) and **NASA POWER / MERRA-2** (USA): *reanalyses*, weather models that combine satellite, weather-station and balloon observations. Rainfall and soil moisture.
   - **CHIRPS** (UC Santa Barbara Climate Hazards Center): satellite rainfall estimates blended with rain-gauge records, the standard rainfall dataset in index-insurance design. Published a few weeks after each month.
2. **A drought index anyone can recompute.** For each district: the season's rainfall (and soil moisture) as percentiles of the WMO 1991–2020 baseline.
3. **Two of three must agree.** Copernicus and NASA decide when they agree; CHIRPS is logged as a witness. If they disagree, CHIRPS breaks the tie. One faked or broken record can neither trigger a payout nor block an honest one.
4. **A data guard (AI).** An anomaly-detection model trained on 30 years of real data flags readings that don't behave like real Fiji weather. Its verdict goes on-chain with every reading, and a flagged payout waits 14 days so it can be challenged.
5. **A smart contract that pays.** Three oracles, one per record, each post their reading, the guard's verdict and the SHA-256 fingerprint of the exact daily data behind it. `DroughtCover.sol` applies the public rules and pays every farmer in the district at once.
6. **Public verification.** Anyone can re-download the data from Copernicus, NASA and the CHIRPS archive and check it against the fingerprint on the ledger. The website does this live, in the browser.
7. **A live tracker for the 2026–27 season.** A strong El Niño is under way (NOAA's Niño-3.4 index was +2.8 °C in September 2026, against +1.8 °C in September 1997). The site downloads today's readings for every district and ranks them exactly as the contract will, with a countdown to each checkpoint.
8. **A forecast, a fair price and sponsors.** A model trained on 44 seasons gives the chance a district pays this season; the same model sets a premium that can't be gamed, and sponsors can pay the extra in risky years so farmers never pay more than the normal-year price.
9. **Sealed before the rain falls.** The contract is live on the public Ethereum Sepolia test network, and this season's forecast and pre-season readings were sealed on it on 15 October 2026, timestamped. A scheduled job (`.github/workflows/oracles.yml`) has the three oracles post the real readings after 31 January and 30 April 2027. See [Live on Sepolia](#live-on-sepolia).

### The rules (in `scripts/rules.mjs` and `contracts/DroughtCover.sol`, tested to match)

| Checkpoint | Trigger | Pays |
| :--- | :--- | :--- |
| Early, end of January | District in its driest 10% | 30% of cover, while there's time to save stock and replant |
| Final, end of April | District in its driest 10% | 100% of cover, less anything paid early |
| Final, end of April | District in its driest 20% | 50% of cover |
| Any | Copernicus and NASA within 25 percentile points | They decide; CHIRPS is logged as a witness when it arrives |
| Any | Copernicus and NASA further apart | Wait for CHIRPS; the pair that agrees decides. If no two agree, nothing pays and the disagreement is logged |
| Any | A deciding reading flagged by the data guard, and a payout is due | Payout held for at least 14 days and until CHIRPS has reported (at most 60 days more); then anyone can release it. While it's held, the insurer can reject it only with two signals: both deciding readings flagged, or one flagged and CHIRPS disagreeing |

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
- Every payout was in a genuinely dry season. In two of them, 1990 and 2005, the cane coped and the harvest held up; those payouts are included in the price below.
- Average payout: **10.5% of cover per year**, the fair price before costs.
- **The satellite record backs the decisions.** Where CHIRPS was a witness, it agreed with the Copernicus/NASA decision at 550 of 637 checkpoints (86%). It broke 80 ties. Adding it as a tie-breaker changed one season's payout (1985–86: 13% → 16%).
- Yields are national; payouts are per district, so district payouts can't be validated against district harvests.

### Data guard

Trained on 1991–2020; features: rainfall-vs-soil percentile gap, dryness vs the other districts, and the error of a daily water-balance regression. One model per checkpoint window (final: Nov–Apr; early: Nov–Jan), for Copernicus and NASA (CHIRPS has no soil moisture, so no guard; it's checked by the two-of-three rule). Threshold = 99th percentile of real readings. Evaluated over every season 1982–2026 (training years included):

| | Real readings flagged | Rain halved | Rain cut to 30% | Rain wiped to zero | Rain and soil both faked |
| :--- | ---: | ---: | ---: | ---: | ---: |
| ERA5, final check | 1.1% | 57% | 64% | 95% | 75% |
| NASA POWER, final check | 1.1% | 71% | 87% | 98% | 83% |
| ERA5, early check | 1.1% | 48% | 66% | 85% | 73% |
| NASA POWER, early check | 1.1% | 57% | 72% | 93% | 73% |

**In 45 years of real data, the guard flagged 16 readings and none of them was in a season that paid, so it would never have delayed a real payout.**

**Who could stop a real payout?**
- One record faked or broken: it is outvoted by the other two.
- One oracle, or the insurer plus one colluding oracle posting a false flag: they can **delay** a payout (until the 14 days are up and CHIRPS is in) but can't cancel it, because rejection needs two signals.
- Faking both Copernicus and NASA: the guard flags it (in the website's game, every fake big enough to pay is held and then rejected), CHIRPS disagrees on the record, and the data no longer matches the public archives.
- The guard runs inside the oracles, so it protects against faked *data*; stolen oracle *keys* could post a false verdict, which is what the public seals and the independent third record are for. A real scheme would have independent organisations run the three oracles.

### Forecast: the chance a district pays this season

One input, known by early October, a month before cover is sold: the Niño-3.4 sea-surface temperature anomaly averaged over August and September (NOAA CPC). Logistic regression over every district and season since 1983, tested by leaving one whole season out at a time.

- In an ordinary season, 17% of districts are paid. For 2026–27 the model says **60%**.
- It is only 5% better than always guessing the average (Brier score, on seasons it never saw). The 1987–88 and 2023–24 seasons had strong El Niños and brought no drought payouts.
- This year's El Niño is stronger than any in the training seasons, so the model treats it as being as strong as the strongest one it has seen (1997).
- We tried adding each district's September soil moisture. It barely changed the skill and its weight pointed the wrong way, so it was left out.

### Pricing that can't be gamed, and sponsors

If everyone can see El Niño coming, people will buy cover only in El Niño years. Over 1983–2026:

| Buyers who only join when Niño-3.4 ≥ +1 °C | Paid out per F$1 of premium |
| :--- | ---: |
| One flat price (10.7% of cover a year) | **3.13** (the pool goes broke) |
| Priced by the forecast before each season | **1.06** |

This season's forecast price is about F$371 per F$1,000 of cover before costs, against F$107 in a normal year. **Sponsors** (a government or donor) can pay into a district's pool through `sponsor(district)`. Sponsor money is ring-fenced: only that district's payouts can use it. The contract uses it first and logs every sponsor dollar against the district and season it paid for. Run over 44 seasons at Fiji's scale with a 20% margin, sponsors would have paid F$16.9 million, in the 15 riskiest years only, and no farmer would ever have paid more than F$129 a year for F$1,000 of cover. A government could fund this from climate finance such as the UN Fund for responding to Loss and Damage, whose start-up phase has US$250 million for 2025–26.

### At Fiji's scale

Fiji has about 10,200 active cane growers. With F$1,000 of cover each, spread evenly across the eight districts, the 1998 season would have paid **F$2.7 million in January and F$10.2 million by the end of April**. Priced by the forecast with a 20% margin, the pool needs F$15.1 million set aside at the start to always pay everyone, pays back 83 cents of every F$1 in premiums, and ends 44 seasons F$9.8 million ahead.

### Contract

`npm test` runs 28 checks against a fresh deployment, including: only the insurer issues policies; only the three oracles report; one oracle alone can't trigger a payout; early + final never exceeds 100%; when Copernicus and NASA disagree the checkpoint waits for CHIRPS; a faked record is outvoted; a broken record can't block an honest payout; no two records agreeing pays nothing; the pool must cover every payout before anyone is paid; a wallet that refuses payment can't block its district; a held payout waits for CHIRPS, needs two signals to be rejected, and is released after the longest wait even if CHIRPS never arrives; sponsor money is ring-fenced to its district and traced to the season it paid for; money owed to a farmer whose wallet refused a payment is reserved until they withdraw it; forecasts are sealed with their timestamp; and on 40 random three-record seasons the contract decides exactly as `scripts/rules.mjs`.

## Live on Sepolia

| | |
| :--- | :--- |
| Contract | [`0x99f3f126366dc90718bC4b1a697130dEA25F90cf`](https://sepolia.etherscan.io/address/0x99f3f126366dc90718bC4b1a697130dEA25F90cf) on Ethereum Sepolia (test network) (version 3) |
| Verified source | [Sourcify, exact match](https://repo.sourcify.dev/11155111/0x99f3f126366dc90718bC4b1a697130dEA25F90cf) (creation and runtime bytecode) |
| Sealed | 24 records on 15 October 2026: the 2026–27 forecast for each district and 16 pre-season readings, each with the SHA-256 of its inputs ([the forecast](https://sepolia.etherscan.io/tx/0x61b9786b05958e08f63ce8e61b71edc733bdf9233d8dee35ce04921104dd5d29)) |
| Oracles | ERA5 `0xDC33B10C662805B0082f7b9cbf10230Db7a513af`, NASA `0xE49ad0777Ee477bAB964980A9C0F62595E18Da7a`, CHIRPS `0x35eb90625a9885730a960C2dfb882eeE890308aE` |

Earlier versions, deployed and sealed the same day and replaced before the season after review found bugs. They stay on the record:

| Version | Contract | Why it was replaced |
| :--- | :--- | :--- |
| 1 | [`0x8Ad7c24FF13d6879026731AF810c94E195E5AD93`](https://sepolia.etherscan.io/address/0x8Ad7c24FF13d6879026731AF810c94E195E5AD93) | sponsor money is now ring-fenced to its district, and a held payout waits for CHIRPS |
| 2 | [`0x06420f30B300AC756a083f0b327CE3389B0a3965`](https://sepolia.etherscan.io/address/0x06420f30B300AC756a083f0b327CE3389B0a3965) | money owed to a farmer whose wallet refused a payment is now reserved, so another district's payout can't spend it |

Anyone can check the seals: the website's "Check these seals yourself" button recomputes each fingerprint from `public/data/sealed-inputs.json` and compares it with the seal read straight from the blockchain.

To verify on Etherscan as well: open the contract → Contract → Verify and Publish → Solidity (Standard-Json-Input), compiler `v0.8.37+commit.f401782d`, licence MIT, upload `contracts/DroughtCover.standard-input.json`, and constructor arguments:

```
000000000000000000000000dc33b10c662805b0082f7b9cbf10230db7a513af000000000000000000000000e49ad0777ee477bab964980a9c0f62595e18da7a00000000000000000000000035eb90625a9885730a960c2dfb882eee890308ae
```

## From rain to phone

1. The three records watch the rain. *(Built.)*
2. Three oracles post readings, guard verdicts and data seals. *(Built; in this prototype the project runs all three.)*
3. The contract decides and pays every farmer in the district. *(Built; test money. A real scheme would hold a regulated digital Fiji dollar.)*
4. A licensed payout partner turns the payment into M-PAiSA or MyCash mobile money and sends an SMS. *(Proposed, not built: it needs a partner and approval from the Reserve Bank of Fiji.)*

## What's real, what's simulated, and what isn't solved

**Real:** all weather data (Copernicus ERA5 / ERA5-Land, NASA POWER, CHIRPS), including today's readings in the live tracker; the Niño-3.4 record (NOAA CPC); FAOSTAT yields; the 1998 figures and timeline (UN OCHA); the smart contract, executed by a real Ethereum Virtual Machine (in the browser, and on a public test network once deployed).

**Simulated:** the 96 test farmers, their wallets and the money; district points are approximate centres of each cane sector; the payout rules, the 20% pricing margin and the even split of growers across districts were set by this project, and a real scheme would set them with an insurer and the regulator.

**Not solved yet:**
- *Basis risk.* Yields are published only for Fiji as a whole, so district payouts can't be checked against district harvests, and 1990 and 2005 paid in a dry season the cane survived. A next step is a vegetation-health (NDVI) check of the cane at the final checkpoint.
- *Nobody in Fiji has reviewed it.* Not farmers, the Sugar Cane Growers Fund, the Fiji Meteorological Service or an insurer.
- *Independent oracles.* The project runs all three oracle keys; a real scheme needs independent operators.
- *A disagreement slows the payout.* If Copernicus and NASA disagree (about 1 in 9 past checkpoints), the decision waits for CHIRPS, published about three weeks after each month. CHIRPS's preliminary version, out within days, could cut that.
- *The AI is small on purpose*: an anomaly check and a one-input forecast that is only a little better than the average.
- *Payout to mobile money* is a proposal. Alerts are in English only (Fiji Hindi and iTaukei versions need checking by native speakers).

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

`data:climate` downloads Copernicus, NASA, CHIRPS and the Niño-3.4 record. `data:yield` needs FAOSTAT's bulk file ([download](https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Oceania.zip), unzip). `npm run data` rebuilds the index, retrains the guard and the forecast, recompiles the contract, repacks `public/data/` and checks that the live tracker ranks every past checkpoint the way the contract did.

**On a public test network** (Ethereum Sepolia by default): put a wallet's private key holding test ETH from a faucet in `.env.testnet` as `DEPLOYER_KEY=0x…` (never commit it; `.gitignore` excludes it), then:

```bash
node scripts/testnet.mjs deploy
```

```bash
node scripts/testnet.mjs seal
```

`deploy` creates the three oracle wallets (saved to `.env.testnet`) and deploys; `seal` puts this season's forecast and pre-season readings on the record. The results go to `public/data/testnet.json`, which the website shows. To have the oracles post the real readings after each checkpoint, add `DEPLOYER_KEY`, `ERA5_KEY`, `POWER_KEY` and `CHIRPS_KEY` as GitHub repository secrets; `.github/workflows/oracles.yml` runs on 8 February and 8 May (and posts CHIRPS witnesses in March and June). A monthly heartbeat commit keeps GitHub from switching the schedule off after 60 quiet days.

## Repository layout

```
contracts/DroughtCover.sol    the smart contract (and its compiled ABI)
scripts/fetch-climate.mjs     daily ERA5 + NASA POWER data → data/climate/
scripts/fetch-chirps.mjs      daily CHIRPS rainfall via ClimateSERV → data/chirps/
scripts/fetch-nino.mjs        NOAA CPC Niño-3.4 monthly anomalies → data/nino34-sstoi.txt
scripts/fetch-yield.mjs       FAOSTAT cane yields → data/yield.json
scripts/rules.mjs             the payout rules and the two-of-three decision (mirrored in the contract)
scripts/build-index.mjs       drought index, payouts, backtest, replays → data/index.json
scripts/train-guard.mjs       trains and evaluates the data guard, scores every real reading → data/guard.json
scripts/build-forecast.mjs    the payout forecast and pricing → data/forecast.json
scripts/build-now.mjs         the live tracker's baseline → public/data/now.json
scripts/check-now.mjs         checks the live tracker against every past checkpoint
scripts/test-contract.mjs     28 rule checks on a local chain
scripts/testnet.mjs           deploy, seal and report on a public test network
.github/workflows/oracles.yml the oracles' scheduled posts for the 2026–27 season
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
| [CHIRPS v2.0](https://www.chc.ucsb.edu/data/chirps), UCSB Climate Hazards Center, via NASA/USAID SERVIR [ClimateSERV](https://climateserv.servirglobal.net/) | Satellite and rain-gauge rainfall | Funk, C. et al. (2015), The climate hazards infrared precipitation with stations, *Scientific Data* 2, 150066 |
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
