// Daily rainfall and soil moisture for every cane district, 1981 to last month, from two independent sources:
//   A. Copernicus ERA5 (rainfall) + ERA5-Land (soil moisture, 0–100 cm), via the Open-Meteo archive API
//   B. NASA POWER (MERRA-2): corrected rainfall + root-zone soil wetness
// Writes data/climate/<district>.json. No keys needed.
//   node scripts/fetch-climate.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'

const START = '1981-01-01'
const end = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10) // archives lag a few days
const ymd = (s) => s.replaceAll('-', '')

async function json(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url)
    if (r.ok) return r.json()
    if (i >= tries) throw new Error(`${r.status} ${url}`)
    await new Promise((res) => setTimeout(res, 3000 * (i + 1)))
  }
}

async function era5(d) {
  const base = `https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${START}&end_date=${end}&timezone=Pacific%2FFiji`
  const [p, s] = await Promise.all([
    json(`${base}&daily=precipitation_sum&models=era5`),
    json(`${base}&daily=soil_moisture_0_to_100cm_mean&models=era5_land`),
  ])
  return { time: p.daily.time, rain: p.daily.precipitation_sum, soil: s.daily.soil_moisture_0_to_100cm_mean,
    grid: { era5: [p.latitude, p.longitude], era5_land: [s.latitude, s.longitude] } }
}

async function power(d) {
  const j = await json(`https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR,GWETROOT&community=AG&longitude=${d.lon}&latitude=${d.lat}&start=${ymd(START)}&end=${ymd(end)}&format=JSON`)
  const { PRECTOTCORR: r, GWETROOT: w } = j.properties.parameter, fill = j.header.fill_value
  const days = Object.keys(r)
  return { time: days.map((k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`), rain: days.map((k) => (r[k] === fill ? null : r[k])),
    soil: days.map((k) => (w[k] === fill ? null : w[k])) }
}

mkdirSync('data/climate', { recursive: true })
for (const d of DISTRICTS) {
  const [a, b] = await Promise.all([era5(d), power(d)])
  writeFileSync(`data/climate/${d.key}.json`, JSON.stringify({ district: d, fetched: new Date().toISOString(),
    sources: {
      era5: { name: 'Copernicus ERA5 rainfall + ERA5-Land soil moisture (0–100 cm)', via: 'Open-Meteo archive API', grid: a.grid, ...a },
      power: { name: 'NASA POWER (MERRA-2) corrected rainfall + root-zone soil wetness', via: 'NASA POWER daily API', ...b },
    } }))
  console.log(`${d.name}: ERA5 ${a.time.length} days, NASA POWER ${b.time.length} days`)
}
