/**
 * Replays an export of your own past traffic through the graph and compares its
 * attribution with the conversions that were actually sent to Google.
 *   node tools/replay.ts <dir>
 *
 * <dir> holds three tab-separated files with no header:
 *   visits.tsv   time ms, visitor subject, fingerprint, canvas hash, address, gclid, gbraid, wbraid, visit id
 *   pages.tsv    time ms, contact subject, fingerprint, canvas hash, address
 *   posted.tsv   contact id, conversion time ms, click id that was sent
 * The files hold personal data, so keep them outside the repository. Only counts are printed.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGraph, createMemoryStore, defaultPolicy, ip } from '../src/index.ts'
import type { Observation, Touch } from '../src/index.ts'

const DAY = 86_400_000
const policy = defaultPolicy

const dir = process.argv[2]
if (!dir) throw new Error('Pass the directory that holds the exported TSV files')
const graph = createGraph(createMemoryStore(), policy)

async function* rows(file: string) {
  for await (const line of createInterface({ input: createReadStream(`${dir}/${file}`) })) yield line.split('\t')
}
const identifiers = (fp2: string, fp1: string, address: string) => {
  const out = [`fingerprint:${fp2}`]
  if (fp1) out.push(`canvas:${fp1}`)
  try {
    if (address) out.push(ip(address))
  } catch {}
  return out
}

let started = performance.now()
let observed = 0
let batch: Observation[] = []
const flush = async () => {
  if (batch.length > 0) await graph.observe(batch)
  observed += batch.length
  batch = []
}
const visitClick = new Map<string, string>()
for await (const [at, subject, fp2, fp1, address, gclid, gbraid, wbraid, visit] of rows('visits.tsv')) {
  batch.push({ subject: subject!, identifiers: identifiers(fp2!, fp1!, address!), at: Number(at), event: 'visit' })
  if (batch.length >= 500) await flush()
  if (gclid || gbraid || wbraid) {
    const touch: Touch = { subject: subject!, at: Number(at), source: 'google', medium: 'cpc' }
    if (gclid) touch.gclid = gclid
    else if (gbraid) touch.gbraid = gbraid
    else touch.wbraid = wbraid!
    await graph.touch(touch)
    visitClick.set(visit!, (gclid || gbraid || wbraid)!)
  }
}
for await (const [at, subject, fp2, fp1, address] of rows('pages.tsv')) {
  batch.push({ subject: subject!, identifiers: identifiers(fp2!, fp1!, address!), at: Number(at), event: 'page' })
  if (batch.length >= 500) await flush()
}
await flush()
const seconds = (performance.now() - started) / 1000
console.log(`observed ${observed} events in ${seconds.toFixed(0)} s (${Math.round(observed / seconds)}/s)`)

started = performance.now()
const unsound = await graph.verify()
console.log(`stored clusters match a full recompute: ${unsound.length === 0} (checked in ${((performance.now() - started) / 1000).toFixed(0)} s)`)

const tally = { conversions: 0, credited: 0, sameClick: 0, otherClick: 0, low: 0, lowHasClick: 0, none: 0 }
const byConfidence = new Map<string, number>()
for await (const [contact, at, click] of rows('posted.tsv')) {
  tally.conversions += 1
  const attribution = await graph.attribute(`contact:${contact}`, { at: Number(at) + DAY, window: 365 * DAY })
  const id = (t: Touch) => t.gclid ?? t.gbraid ?? t.wbraid
  const found = attribution.touches.find((touch) => id(touch) === click)
  if (attribution.reason === 'no_touch') tally.none += 1
  else if (attribution.reason === 'low_confidence') {
    tally.low += 1
    if (found) tally.lowHasClick += 1
  } else {
    tally.credited += 1
    if (found && found.confidence >= policy.same) tally.sameClick += 1
    else tally.otherClick += 1
  }
  const bucket = !found ? 'not found' : found.confidence >= 0.9 ? '0.9+' : found.confidence >= 0.7 ? '0.7-0.9' : '0.5-0.7'
  byConfidence.set(bucket, (byConfidence.get(bucket) ?? 0) + 1)
}
console.log('conversions that were sent (contact, time, click):', tally.conversions)
console.log('  graph credits a click with confidence >= 0.9:', tally.credited)
console.log('    and the click that was sent is among those it trusts:', tally.sameClick)
console.log('    but only other clicks, not the one that was sent:', tally.otherClick)
console.log('  graph finds clicks but none it trusts:', tally.low, `(the click that was sent is among them: ${tally.lowHasClick})`)
console.log('  graph finds no click at all:', tally.none)
console.log('confidence the graph gives the click that was sent:', Object.fromEntries([...byConfidence].sort()))
