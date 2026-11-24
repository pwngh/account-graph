/**
 * Measures who is joined, rightly and wrongly, over made-up people.
 *   node tools/accuracy/run.ts                     every setting, twenty worlds each
 *   node tools/accuracy/run.ts base --worlds 3 --people 500
 *   node tools/accuracy/run.ts base --dry          counts what is reported, joins nothing and scores nothing
 *
 * The worlds come from `world.ts`, which knows nothing of the graph, and are
 * reported to a server over HTTP as a site, a telephone system and a front
 * desk would. The default policy and settings decide. `docs/accuracy.md` says
 * where the rates are from, what is counted, and what would be bad.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { createGraph, createMemoryStore } from '../../src/index.ts'
import { createHandler } from '../../src/server.ts'
import { interval, score } from './score.ts'
import type { Score, Truth } from './score.ts'
import { SETTINGS } from './rates.ts'
import { makeWorld } from './world.ts'
import type { Size, World } from './world.ts'

const SITE = 'https://www.example.org'
const LINE = '+15550100000'
const START = Date.parse('2026-03-02T15:00:00Z')

/** What the graph came to, and what each link it made by itself rests on. */
export interface Outcome {
  truths: Truth[]
  clusterOf: Map<string, string>
  /** By the kinds a direct link of `same` strength rests on: how many, and how many are between two people. */
  links: Map<string, { links: number; wrong: number }>
}

/** Reports a world to a server of its own, in the order it happened, and reads who was joined. */
export async function report(world: World): Promise<Outcome> {
  let now = START
  const graph = createGraph(createMemoryStore(), undefined, { now: () => now })
  const handler = createHandler(graph, { token: 'service', origins: [SITE], events: ['phone_click'], calls: { numbers: { [LINE]: { source: 'line' } } }, trustProxy: true, limit: false, now: () => now })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: object, headers: Record<string, string>) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const page = (address: string, agent: string) => ({ origin: SITE, 'x-forwarded-for': address, 'user-agent': agent })
  const service = { authorization: 'Bearer service' }
  const callers = new Map<string, { people: Set<string>; facts: Set<string> }>()
  try {
    for (const event of world.events) {
      now = event.at
      if (event.kind === 'visit') await post('/collect', { device: event.device, url: `${SITE}/`, ...(event.ad && { touch: { gclid: event.ad, landing: `${SITE}/` } }) }, page(event.address, event.agent))
      else if (event.kind === 'tap') await post('/event', { device: event.device, event: 'phone_click', number: LINE }, page(event.address, event.agent))
      else if (event.kind === 'record') await post('/identify', { subject: event.subject, event: 'form', ...(event.device && { device: event.device }), ...(event.email && { email: event.email }), ...(event.phone && { phone: event.phone }) }, service)
      else {
        const { subject } = await post('/call', { id: event.id, to: LINE, at: event.at, duration: event.seconds, answered: event.answered, ...(event.from && { from: event.from }) }, service)
        const known = callers.get(subject) ?? { people: new Set<string>(), facts: new Set<string>() }
        callers.set(subject, known)
        const { people, facts } = world.calls.get(event.id)!
        for (const person of people) known.people.add(person)
        for (const fact of facts) known.facts.add(fact)
      }
    }
  } finally {
    server.closeAllConnections()
    server.close()
  }
  const truths = [...world.truths, ...[...callers].map(([subject, known]): Truth => ({ subject, people: [...known.people], facts: [...known.facts] }))]
  const peopleOf = new Map(truths.map((each) => [each.subject, each.people]))
  const clusterOf = new Map<string, string>()
  const links: Outcome['links'] = new Map()
  for (const { subject, people } of truths) {
    const cluster = await graph.cluster(subject)
    if (cluster) clusterOf.set(subject, cluster.id)
    for (const link of await graph.links(subject)) {
      const other = peopleOf.get(link.subject)
      // Each link is seen from both ends, and counted from one.
      if (link.level !== 'same' || !other || subject > link.subject) continue
      const key = [...new Set(link.reasons.map(({ identifier }) => identifier.slice(0, identifier.indexOf(':'))))].sort().join(' + ')
      const row = links.get(key) ?? { links: 0, wrong: 0 }
      links.set(key, row)
      row.links += 1
      if (!people.some((each) => other.includes(each))) row.wrong += 1
    }
  }
  return { truths, clusterOf, links }
}

/** The plainest rule there is, to compare with: whoever shares any one fact is one person, and whoever they share one with. */
export function anyFact(truths: readonly Truth[]): Map<string, string> {
  const parent = new Map<string, string>()
  const root = (key: string): string => {
    let at = key
    while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
    return at
  }
  // That a tap and a call are one is known to whoever made them up, and to no rule.
  for (const { subject, facts } of truths) for (const fact of facts) if (!fact.startsWith('tap ')) parent.set(root(subject), root(`fact ${fact}`))
  return new Map(truths.map(({ subject }) => [subject, root(subject)]))
}

export const figures = ({ all, people, mixed, recorded, mixedRecords }: Score) => ({
  found: all.found / all.same,
  foundOfJoinable: all.joinable === 0 ? 1 : all.foundJoinable / all.joinable,
  right: all.found + all.wrong === 0 ? 1 : all.found / (all.found + all.wrong),
  mixed: mixed / people,
  mixedRecords: mixedRecords / recorded,
})

const percent = ({ mean, low, high }: ReturnType<typeof interval>) => `${(mean * 100).toFixed(2)}% (${(Math.max(0, low) * 100).toFixed(2)} to ${(Math.min(1, high) * 100).toFixed(2)})`

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { worlds: { type: 'string', default: '20' }, people: { type: 'string' }, seed: { type: 'string', default: '20261124' }, dry: { type: 'boolean', default: false } } })
  const [worlds, seed] = [Number(values.worlds), Number(values.seed)]
  const names = positionals.length > 0 ? positionals : Object.keys(SETTINGS)
  for (const name of names) {
    const setting = SETTINGS[name]
    if (!setting) throw new Error(`Say one of: ${Object.keys(SETTINGS).join(', ')}`)
    const people = values.people === undefined ? setting.people : Number(values.people)
    const size = (world: number): Size => ({ people, days: setting.days, start: START, seed: seed + world })
    if (values.dry) {
      const { events, truths } = makeWorld(setting.rates, size(0))
      const by = (kind: string) => events.filter((event) => event.kind === kind).length
      console.log(`${name}: ${people} people, ${by('visit')} visits, ${by('tap')} taps, ${by('call')} calls, ${by('record')} records, ${truths.length} subjects before callers`)
      continue
    }
    const ours: ReturnType<typeof figures>[] = []
    const plain: ReturnType<typeof figures>[] = []
    const kinds = new Map<string, { same: number; found: number; wrong: number }>()
    const links = new Map<string, { links: number; wrong: number }>()
    const total = { wrong: 0, found: 0, mixed: 0, people: 0, mixedRecords: 0, recorded: 0, wrongClusters: 0 }
    for (let world = 0; world < worlds; world++) {
      const outcome = await report(makeWorld(setting.rates, size(world)))
      const result = score(outcome.truths, outcome.clusterOf)
      ours.push(figures(result))
      plain.push(figures(score(outcome.truths, anyFact(outcome.truths))))
      total.wrong += result.all.wrong
      total.found += result.all.found
      total.mixed += result.mixed
      total.people += result.people
      total.mixedRecords += result.mixedRecords
      total.recorded += result.recorded
      total.wrongClusters += result.wrongClusters
      for (const [kind, count] of result.kinds) {
        const row = kinds.get(kind) ?? { same: 0, found: 0, wrong: 0 }
        kinds.set(kind, { same: row.same + count.same, found: row.found + count.found, wrong: row.wrong + count.wrong })
      }
      for (const [kind, count] of outcome.links) {
        const row = links.get(kind) ?? { links: 0, wrong: 0 }
        links.set(kind, { links: row.links + count.links, wrong: row.wrong + count.wrong })
      }
    }
    console.log(`\n## ${name}: ${worlds} worlds of ${people} people over ${setting.days} days, seeds from ${seed}`)
    for (const [label, list] of [['account-graph', ours], ['any shared fact', plain]] as const) {
      const of = (key: keyof ReturnType<typeof figures>) => percent(interval(list.map((each) => each[key])))
      console.log(`${label}: people whose record is with another's ${of('mixedRecords')}; people mixed with another by anything ${of('mixed')}; joined pairs that are right ${of('right')}; true pairs found ${of('found')}; of those with a chain of facts ${of('foundOfJoinable')}`)
    }
    console.log(`in all: ${total.wrong} wrong pairs, ${total.found} right; ${total.mixedRecords} of ${total.recorded} people with a record share a cluster with another's; ${total.mixed} of ${total.people} people mixed by anything, in ${total.wrongClusters} clusters`)
    for (const [kind, row] of [...kinds].sort()) console.log(`  pairs ${kind}: ${row.same} true, ${row.found} found, ${row.wrong} wrong`)
    for (const [kind, row] of [...links].sort((x, y) => y[1].links - x[1].links)) console.log(`  links by ${kind}: ${row.links}, ${row.wrong} between two people`)
  }
}

if (import.meta.main ?? process.argv[1]?.endsWith('accuracy/run.ts')) await main()
