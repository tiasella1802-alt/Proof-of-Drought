// Daily CHIRPS rainfall (Climate Hazards Center, UC Santa Barbara: satellite infrared estimates blended with rain-gauge
// records, 0.05°) for every cane district, 1981 to the latest month released, via NASA/USAID SERVIR's ClimateSERV API.
// CHIRPS is the standard rainfall record in index-insurance design, and it is an independent third witness: neither
// ERA5 nor NASA POWER/MERRA-2 is built from it.
//   node scripts/fetch-chirps.mjs   → data/chirps/<district>.json
import { mkdirSync, writeFileSync } from 'node:fs'
import { DISTRICTS } from './districts.mjs'

const API = 'https://climateserv.servirglobal.net/api'
const START = '1981-01-01'
const end = new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10)
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(url, tries = 5) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url); if (r.ok) return JSON.parse(await r.text()); throw new Error(`${r.status}`) }
    catch (e) { if (i >= tries) throw new Error(`${e.message} ${url}`); await wait(4000 * (i + 1)) }
  }
}

// The district's CHIRPS cell: a box one grid cell (0.05°) wide around its centre point, averaged.
async function series(d, from, to) {
  const h = 0.025, box = { type: 'Polygon', coordinates: [[[d.lon - h, d.lat - h], [d.lon + h, d.lat - h], [d.lon + h, d.lat + h], [d.lon - h, d.lat + h], [d.lon - h, d.lat - h]]] }
  const q = new URLSearchParams({ datatype: 0, begintime: us(from), endtime: us(to), intervaltype: 0, operationtype: 5, dateType_Category: 'default', isZip_CurrentDataType: false, geometry: JSON.stringify(box) })
  const [id] = await get(`${API}/submitDataRequest/?${q}`)
  for (let i = 0; i < 200; i++) { const [p] = await get(`${API}/getDataRequestProgress/?id=${id}`); if (p >= 100) break; if (p < 0) throw new Error('ClimateSERV job failed'); await wait(3000) }
  const { data } = await get(`${API}/getDataFromRequest/?id=${id}`)
  return data.map((r) => [`${r.year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`, r.value.avg < 0 ? null : +r.value.avg.toFixed(2)])
}

mkdirSync('data/chirps', { recursive: true })
// All districts at once (each job takes the service about half a minute).
await Promise.all(DISTRICTS.map(async (d) => {
  const rows = []
  // In 10-year pieces, which the service handles comfortably.
  for (let y = 1981; y <= +end.slice(0, 4); y += 10) {
    const a = y === 1981 ? START : `${y}-01-01`, b = `${y + 9}-12-31` < end ? `${y + 9}-12-31` : end
    rows.push(...(await series(d, a, b)))
    console.log(`  ${d.name} ${a.slice(0, 4)}–${b.slice(0, 4)} done`)
  }
  // The latest days the archive hasn't filled yet come back empty: stop at the last real value.
  let n = rows.length; while (n && rows[n - 1][1] == null) n--
  const kept = rows.slice(0, n)
  writeFileSync(`data/chirps/${d.key}.json`, JSON.stringify({ district: d, fetched: new Date().toISOString(), name: 'CHIRPS v2.0 daily rainfall (UCSB Climate Hazards Center), via ClimateSERV',
    time: kept.map((r) => r[0]), rain: kept.map((r) => r[1]) }))
  console.log(`${d.name}: CHIRPS ${kept.length} days, to ${kept.at(-1)[0]}`)
}))
