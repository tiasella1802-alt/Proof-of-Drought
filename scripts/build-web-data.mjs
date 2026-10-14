// Packs what the website needs into public/data/ (served as-is by Vite):
//   index.json   drought index, payouts, backtest, monthly replays (from build-index.mjs)
//   guard.json   the trained data-guard model (from train-guard.mjs)
//   days.json    daily rows [date, rain, soil] per district and source for the demo seasons, Nov–Apr plus the day
//                before (the water-balance model needs yesterday), so the browser can re-run the guard on faked data
//   yield.json   FAOSTAT cane yields
//   forecast.json the El Niño payout forecast and pricing (from build-forecast.mjs)
//   contract.json DroughtCover ABI + bytecode
//   node scripts/build-web-data.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'

export const DEMO_SEASONS = [1983, 1987, 1992, 1998, 2010, 2011, 2016]
const raw = Object.fromEntries(readdirSync('data/climate').map((f) => { const j = JSON.parse(readFileSync(`data/climate/${f}`, 'utf8')); return [j.district.key, j.sources] }))
const days = {}
for (const y of DEMO_SEASONS) {
  days[y] = {}
  for (const d of DISTRICTS) {
    days[y][d.key] = {}
    for (const src of ['era5', 'power']) {
      const s = raw[d.key][src], from = `${y - 1}-10-31`, to = `${y}-04-30`
      days[y][d.key][src] = s.time.map((t, i) => [t, s.rain[i], s.soil[i]]).filter(([t]) => t >= from && t <= to)
    }
  }
}
mkdirSync('public/data', { recursive: true })
writeFileSync('public/data/days.json', JSON.stringify(days))
for (const f of ['index.json', 'guard.json', 'yield.json', 'forecast.json']) copyFileSync(`data/${f}`, `public/data/${f}`)
const { abi, bytecode } = JSON.parse(readFileSync('contracts/DroughtCover.json', 'utf8'))
writeFileSync('public/data/contract.json', JSON.stringify({ abi, bytecode }))
for (const f of readdirSync('public/data')) console.log(`public/data/${f}  ${(readFileSync(`public/data/${f}`).length / 1024).toFixed(0)} KB`)
