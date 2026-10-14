// Monthly Niño-3.4 sea-surface temperature anomalies (NOAA CPC, OISST v2.1, 1991–2020 climatology), 1982 to last month.
// The El Niño signal the forecast uses: it's known months before Fiji's cane season starts.
//   node scripts/fetch-nino.mjs   → data/nino34-sstoi.txt
import { writeFileSync } from 'node:fs'

const r = await fetch('https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices')
if (!r.ok) throw new Error(`${r.status} NOAA CPC`)
const text = await r.text()
writeFileSync('data/nino34-sstoi.txt', text)
const last = text.trim().split('\n').at(-1).trim().split(/\s+/)
console.log(`Niño-3.4 to ${last[0]}-${last[1].padStart(2, '0')}: ${last[9]} °C`)
