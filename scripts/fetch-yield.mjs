// Fiji sugarcane yield and production per year, from FAOSTAT (Production: Crops and livestock products).
// FAOSTAT's API is often down, so this reads the bulk CSV instead. Download and unzip it first:
//   https://bulks-faostat.fao.org/production/Production_Crops_Livestock_E_Oceania.zip
//   node scripts/fetch-yield.mjs path/to/Production_Crops_Livestock_E_Oceania_NOFLAG.csv
// Writes data/yield.json.
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('pass the path to Production_Crops_Livestock_E_Oceania_NOFLAG.csv')
const split = (line) => line.match(/("([^"]*)"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''))
const [head, ...rows] = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
const cols = split(head), years = cols.map((c, i) => [c, i]).filter(([c]) => /^Y\d{4}$/.test(c))
const pick = (element) => {
  const r = rows.map(split).find((r) => r[cols.indexOf('Area')] === 'Fiji' && r[cols.indexOf('Item')] === 'Sugar cane' && r[cols.indexOf('Element')] === element)
  return Object.fromEntries(years.map(([c, i]) => [c.slice(1), r[i] === '' ? null : +r[i]]))
}
const y = pick('Yield'), p = pick('Production'), a = pick('Area harvested')
const out = Object.keys(y).filter((k) => y[k] != null).map((k) => ({ year: +k, yield_t_ha: +(y[k] / 1000).toFixed(2), production_t: p[k], area_ha: a[k] }))
writeFileSync('data/yield.json', JSON.stringify({ source: 'FAOSTAT, Production: Crops and livestock products, Fiji, Sugar cane (item 156)',
  url: 'https://www.fao.org/faostat/en/#data/QCL', license: 'FAO statistical database terms of use (attribution)', fetched: new Date().toISOString(), years: out }, null, 1))
console.log(`${out.length} years, ${out[0].year}–${out.at(-1).year}`)
