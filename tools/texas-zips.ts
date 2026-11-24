/**
 * Makes `src/texas-zips.ts` from the Census Bureau's 2020 file of which counties each ZIP code area lies in.
 *   curl -O https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
 *   node tools/texas-zips.ts tab20_zcta520_county20_natl.txt > src/texas-zips.ts
 */
import { readFileSync } from 'node:fs'

const [head, ...lines] = readFileSync(process.argv[2]!, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map((line) => line.split('|'))
const at = (name: string) => head!.indexOf(name)
const [zip, county, name, land] = ['GEOID_ZCTA5_20', 'GEOID_COUNTY_20', 'NAMELSAD_COUNTY_20', 'AREALAND_PART'].map(at) as [number, number, number, number]
const areas = new Map<string, Map<string, string>>()
for (const line of lines) {
  if (!line[zip] || !(Number(line[land]) > 0)) continue
  const of = areas.get(line[zip]!) ?? new Map<string, string>()
  areas.set(line[zip]!, of.set(line[county]!, line[name]!.replace(/ County$/, '')))
}
// Only where all of its land is in one county, of any state: elsewhere a ZIP does not say which.
const zips = new Map<string, string[]>()
for (const [code, of] of [...areas].sort()) {
  const [[id, named]] = [...of] as [[string, string]]
  if (of.size === 1 && id.startsWith('48')) zips.set(named, [...(zips.get(named) ?? []), code])
}
console.log(`/** Texas ZIP code areas that lie in one county, by county. Made by \`tools/texas-zips.ts\` from the Census Bureau's 2020 file. */
export const ZIPS: Record<string, string> = {
${[...zips].sort().map(([name, codes]) => `  ${/^[A-Za-z]+$/.test(name) ? name : `'${name}'`}: '${codes.join(' ')}',`).join('\n')}
}`)
