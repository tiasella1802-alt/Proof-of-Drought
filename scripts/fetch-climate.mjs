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

// Retries on HTTP errors and on bodies that aren't JSON (Open-Meteo can answer 200 with "timeoutReached" on long ranges).
async function json(url, tries = 5) {
  for (let i = 0; ; i++) {
    let err
    try {
      const r = await fetch(url)
      const text = await r.text()
      if (r.ok) return JSON.parse(text)
      err = new Error(`${r.status} ${text.slice(0, 120)}`)
    } catch (e) { err = e }
    if (i >= tries) throw new Error(`${err.message} ${url}`)
    await new Promise((res) => setTimeout(res, 4000 * (i + 1)))
  }
}
// The archive in 10-year pieces, joined back together.
function chunks(from, to) {
  const out = []
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y += 10) {
    const a = y === +from.slice(0, 4) ? from : `${y}-01-01`, b = `${y + 9}-12-31` < to ? `${y + 9}-12-31` : to
    out.push([a, b])
  }
  return out
}
async function openMeteo(d, query) {
  const parts = []
  for (const [a, b] of chunks(START, end)) parts.push(await json(`https://archive-api.open-meteo.com/v1/archive?latitude=${d.lat}&longitude=${d.lon}&start_date=${a}&end_date=${b}&timezone=Pacific%2FFiji&${query}`))
  const key = Object.keys(parts[0].daily).find((k) => k !== 'time')
  return { latitude: parts[0].latitude, longitude: parts[0].longitude, daily: { time: parts.flatMap((p) => p.daily.time), [key]: parts.flatMap((p) => p.daily[key]) } }
}

async function era5(d) {
  const p = await openMeteo(d, 'daily=precipitation_sum&models=era5')
  const s = await openMeteo(d, 'daily=soil_moisture_0_to_100cm_mean&models=era5_land')
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
