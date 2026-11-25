/**
 * Measures who is joined, rightly and wrongly, over made-up people.
 *   node tools/accuracy/run.ts                     every setting and arm, twenty worlds each
 *   node tools/accuracy/run.ts base --worlds 3 --people 500
 *   node tools/accuracy/run.ts base --dry          counts what is reported, joins nothing and scores nothing
 *
 * The worlds come from `world.ts`, which knows nothing of the graph, and are
 * reported to a server over HTTP as a site, a telephone system and a front
 * desk would. `docs/accuracy.md` says
 * where the rates are from, what is counted, and what would be bad.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { createGraph, createMemoryStore, policyFrom } from '../internals.ts'
import { createHandler } from '../../test/harness.ts'
import { interval, score } from './score.ts'
import type { Score, Truth } from './score.ts'
import { SETTINGS } from './rates.ts'
import { makeWorld } from './world.ts'
import type { Size, World } from './world.ts'

const SITE = 'https://www.example.org'
const LINE = '+15550100000'
const START = Date.parse('2026-03-02T15:00:00Z')

const HOUSEHOLD = JSON.parse(readFileSync(new URL('../../examples/household.json', import.meta.url), 'utf8'))
const SECRET = 'a made-up secret for made-up people'

/**
 * What the server is set to. Every arm is told the same: names and birth dates are sent to all of them. `staff` joins the
 * caller to the record a call is about, and `pool` shows each visitor a number of their own.
 */
export const ARMS = {
  default: {},
  household: { policy: HOUSEHOLD },
  'household staff': { policy: HOUSEHOLD, staff: true },
  'default staff': { staff: true },
  'default pool': { pool: true },
  'default birth': { policy: { apart: ['birth'] } },
  'household staff birth': { policy: { ...HOUSEHOLD, apart: ['birth'] }, staff: true },
} satisfies Record<string, { policy?: object; staff?: boolean; pool?: boolean }>
export type Arm = keyof typeof ARMS
/** What each arm is compared with over the same worlds. */
const BESIDE: Partial<Record<Arm, Arm>> = {
  'household staff': 'household', 'default staff': 'default', 'default pool': 'default', 'default birth': 'default',
  'household staff birth': 'household staff',
}

/** Whether each record's ad is credited: the ad its person came by, another's, or none. Cold records have none to credit. */
export interface Credit {
  right: number
  wrong: number
  none: number
  /** Of those who came by an ad, the records with a chain of facts to a browser of theirs that the ad was seen on. */
  reachable: number
  reachableRight: number
  cold: number
  coldWrong: number
}

/** What the graph came to, and what each link it made by itself rests on. */
export interface Outcome {
  truths: Truth[]
  clusterOf: Map<string, string>
  /** By the kinds a direct link of `same` strength rests on: how many, and how many are between two people. */
  links: Map<string, { links: number; wrong: number }>
  credit: Credit
  /** The records credited to the ad their person came by. */
  creditedRight: Set<string>
  /** Requests for a number of one's own when all were taken. */
  exhausted: number
}

/** Reports a world to a server of its own, in the order it happened, and reads who was joined. */
export async function report(world: World, arm: Arm = 'default', pool = 10): Promise<Outcome> {
  const set: { policy?: object; staff?: boolean; pool?: boolean } = ARMS[arm]
  const numbers = set.pool ? Array.from({ length: pool }, (_, i) => `+1555010${String(100 + i).padStart(4, '0')}`) : []
  let now = START
  const graph = createGraph(createMemoryStore(), set.policy && policyFrom(set.policy), { now: () => now })
  const handler = createHandler(graph, {
    token: 'service', origins: [SITE], events: ['phone_click'], calls: { numbers: { [LINE]: { source: 'line' } } }, trustProxy: true, limit: false, identifierSecret: SECRET,
    ...(numbers.length > 0 && { pool: { numbers, minutes: 15, grace: 120 } }), now: () => now,
  })
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
  const callerOf = new Map<string, string>()
  const dialed = new Map<string, string>()
  let exhausted = 0
  /** The number a page shows somebody: their own where there is one for them, and the firm's. The page asks again while it is in view. */
  const shown = async ({ device, address, agent }: { device: string; address: string; agent: string }) => {
    if (numbers.length === 0) return LINE
    const answer = await post('/number', { device }, page(address, agent))
    if (answer?.number === undefined) exhausted += 1
    return (answer?.number as string | undefined) ?? LINE
  }
  try {
    for (const event of world.events) {
      now = event.at
      if (event.kind === 'visit') {
        await post('/collect', { device: event.device, url: `${SITE}/`, ...(event.ad && { touch: { gclid: event.ad, landing: `${SITE}/` } }) }, page(event.address, event.agent))
        await shown(event)
      }
      else if (event.kind === 'tap') await post('/event', { device: event.device, event: 'phone_click', number: await shown(event) }, page(event.address, event.agent))
      else if (event.kind === 'join') {
        const caller = callerOf.get(event.call)
        if (set.staff && caller !== undefined) await post('/join', { source: 'desk', pairs: [{ a: caller, b: event.subject, reason: 'answered by staff' }] }, service)
      }
      else if (event.kind === 'record') await post('/identify', { subject: event.subject, event: 'form', ...(event.device && { device: event.device }), ...(event.email && { email: event.email }), ...(event.phone && { phone: event.phone }), name: event.name, ...(event.dob && { dob: event.dob }) }, service)
      else {
        const to = event.page ? await shown(event.page) : (event.redial !== undefined && dialed.get(event.redial)) || LINE
        dialed.set(event.id, to)
        const { subject } = await post('/call', { id: event.id, to, at: event.at, duration: event.seconds, answered: event.answered, ...(event.from && { from: event.from }) }, service)
        callerOf.set(event.id, subject)
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

  // Asked an hour after the record was made, as things are known at the end, the way a report asks.
  const credit: Credit = { right: 0, wrong: 0, none: 0, reachable: 0, reachableRight: 0, cold: 0, coldWrong: 0 }
  const creditedRight = new Set<string>()
  const chains = joinedBy(truths, () => true)
  const adSeen = new Set<string>()
  for (const event of world.events) if (event.kind === 'visit' && event.ad) adSeen.add(`${event.ad} ${chains.get(`visitor:${event.device}`)}`)
  for (const [subject, { ad, at }] of world.ads) {
    const { credited } = await graph.attribute(subject, { at: at + 3_600_000 })
    const given = credited?.gclid
    if (ad === undefined) {
      credit.cold += 1
      if (given !== undefined) credit.coldWrong += 1
      continue
    }
    if (given === undefined) credit.none += 1
    else if (given === ad) {
      credit.right += 1
      creditedRight.add(subject)
    }
    else credit.wrong += 1
    if (!adSeen.has(`${ad} ${chains.get(subject)}`)) continue
    credit.reachable += 1
    if (given === ad) credit.reachableRight += 1
  }
  return { truths, clusterOf, links, credit, creditedRight, exhausted }
}

/** Whoever shares a fact the rule looks at is one person, and so is whoever they share one with. */
function joinedBy(truths: readonly Truth[], looks: (fact: string, subject: string) => boolean): Map<string, string> {
  const parent = new Map<string, string>()
  const root = (key: string): string => {
    let at = key
    while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
    return at
  }
  for (const { subject, facts } of truths) for (const fact of facts) if (looks(fact, subject)) parent.set(root(subject), root(`fact ${fact}`))
  return new Map(truths.map(({ subject }) => [subject, root(subject)]))
}

/** Two plain rules to compare with. That a tap and a call are one is known to whoever made them up, and to no rule. */
export const PLAIN = {
  'any shared fact': (truths: readonly Truth[]) => joinedBy(truths, (fact) => !fact.startsWith('tap ')),
  'same phone or email': (truths: readonly Truth[]) => joinedBy(truths, (fact, subject) => /^(phone|email) /.test(fact) && !subject.startsWith('visitor:')),
}

export const figures = ({ all, people, mixed, recorded, mixedRecords, mixedApart }: Score) => ({
  found: all.found / all.same,
  foundOfJoinable: all.joinable === 0 ? 1 : all.foundJoinable / all.joinable,
  right: all.found + all.wrong === 0 ? 1 : all.found / (all.found + all.wrong),
  mixed: mixed / people,
  mixedRecords: mixedRecords / recorded,
  mixedApart: mixedApart / recorded,
})
const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole)
const creditFigures = (credit: Credit) => ({
  right: share(credit.right, credit.right + credit.wrong + credit.none),
  wrong: share(credit.wrong, credit.right + credit.wrong),
  reachableRight: share(credit.reachableRight, credit.reachable),
  coldWrong: share(credit.coldWrong, credit.cold),
})

const LINES = ['account-graph', 'any shared fact', 'account-graph, of records and callers', 'same phone or email, of records and callers']
const percent = ({ mean, low, high }: ReturnType<typeof interval>) => `${(mean * 100).toFixed(2)}% (${(Math.max(0, low) * 100).toFixed(2)} to ${(Math.min(1, high) * 100).toFixed(2)})`
const added = <T extends object>(into: T, more: T): T => Object.fromEntries(Object.entries(into).map(([key, value]) => [key, value + (more as Record<string, number>)[key]!])) as T

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { worlds: { type: 'string', default: '20' }, people: { type: 'string' }, seed: { type: 'string', default: '20261124' }, arm: { type: 'string' }, dry: { type: 'boolean', default: false } } })
  const [worlds, seed] = [Number(values.worlds), Number(values.seed)]
  const names = positionals.length > 0 ? positionals : Object.keys(SETTINGS)
  if (!values.dry) console.log(`Node ${process.version}`)
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
    const arms = values.arm?.split(',') as Arm[] | undefined ?? (Object.keys(ARMS) as Arm[])
    for (const arm of arms) if (!ARMS[arm]) throw new Error(`Say arms of: ${Object.keys(ARMS).join(', ')}`)
    const kept = new Map(arms.map((arm) => [arm, { lines: new Map<string, ReturnType<typeof figures>[]>(LINES.map((label) => [label, []])), credits: [] as ReturnType<typeof creditFigures>[], kinds: new Map<string, { same: number; found: number; wrong: number }>(), links: new Map<string, { links: number; wrong: number }>(), credited: { right: 0, wrong: 0, none: 0, reachable: 0, reachableRight: 0, cold: 0, coldWrong: 0 } as Credit, total: { wrong: 0, found: 0, mixed: 0, people: 0, mixedRecords: 0, mixedApart: 0, recorded: 0, wrongClusters: 0, exhausted: 0 } }]))
    const differ = new Map<Arm, Record<string, number[]>>()
    /** Pooled over the worlds: of what the arm beside found, what is lost. */
    const lostIn = new Map<Arm, Record<'pairs' | 'recordPairs' | 'credit', [lost: number, of: number]>>()
    for (let world = 0; world < worlds; world++) {
      const made = makeWorld(setting.rates, size(world))
      const of = new Map<Arm, { result: Score; outcome: Outcome }>()
      for (const arm of arms) {
        const outcome = await report(made, arm, setting.pool)
        const result = score(outcome.truths, outcome.clusterOf, made.spoke)
        of.set(arm, { result, outcome })
        const row = kept.get(arm)!
        // A rule that looks at records and callers alone is held to those, and so is account-graph beside it. Its clusters are still of everything it saw.
        const few = outcome.truths.filter(({ subject }) => !subject.startsWith('visitor:'))
        const add = (label: string, each: Score) => row.lines.get(label)!.push(figures(each))
        add('account-graph', result)
        add('any shared fact', score(outcome.truths, PLAIN['any shared fact'](outcome.truths), made.spoke))
        add('account-graph, of records and callers', score(few, outcome.clusterOf, made.spoke))
        add('same phone or email, of records and callers', score(few, PLAIN['same phone or email'](few), made.spoke))
        row.credits.push(creditFigures(outcome.credit))
        row.credited = added(row.credited, outcome.credit)
        row.total = added(row.total, { wrong: result.all.wrong, found: result.all.found, mixed: result.mixed, people: result.people, mixedRecords: result.mixedRecords, mixedApart: result.mixedApart, recorded: result.recorded, wrongClusters: result.wrongClusters, exhausted: outcome.exhausted })
        for (const [kind, { same, found, wrong }] of result.kinds) row.kinds.set(kind, added(row.kinds.get(kind) ?? { same: 0, found: 0, wrong: 0 }, { same, found, wrong }))
        for (const [kind, count] of outcome.links) row.links.set(kind, added(row.links.get(kind) ?? { links: 0, wrong: 0 }, count))
      }
      for (const [arm, { result, outcome }] of of) {
        const before = BESIDE[arm] && of.get(BESIDE[arm])
        if (!before) continue
        const row = differ.get(arm) ?? { mixedRecords: [], mixed: [], right: [], pairsLost: [], recordPairsLost: [], creditLost: [], wrongSide: [] }
        differ.set(arm, row)
        const [now, then] = [figures(result), figures(before.result)]
        for (const key of ['mixedRecords', 'mixed', 'right'] as const) row[key]!.push(now[key] - then[key])
        const lost = [...before.result.pairs].filter((pair) => !result.pairs.has(pair))
        const records = (pair: string) => pair.split('\n').every((subject) => subject.startsWith('contact:'))
        const pooled = lostIn.get(arm) ?? { pairs: [0, 0], recordPairs: [0, 0], credit: [0, 0] }
        lostIn.set(arm, pooled)
        const lose = (what: keyof typeof pooled, key: string, part: number, whole: number) => {
          row[key]!.push(share(part, whole))
          pooled[what] = [pooled[what][0] + part, pooled[what][1] + whole]
        }
        lose('pairs', 'pairsLost', lost.length, before.result.pairs.size)
        lose('recordPairs', 'recordPairsLost', lost.filter(records).length, [...before.result.pairs].filter(records).length)
        lose('credit', 'creditLost', [...before.outcome.creditedRight].filter((subject) => !outcome.creditedRight.has(subject)).length, before.outcome.creditedRight.size)
        // Callers and browsers in a cluster with a record of somebody who is not theirs.
        const side = ({ kinds }: Score) => ['caller contact', 'contact visitor', 'call contact'].reduce((sum, kind) => sum + (kinds.get(kind)?.wrong ?? 0), 0)
        row.wrongSide!.push(side(result) - side(before.result))
      }
    }
    for (const arm of arms) {
      const { lines, credits, kinds, links, credited, total } = kept.get(arm)!
      console.log(`\n## ${name}, ${arm}: ${worlds} worlds of ${people} people over ${setting.days} days, seeds from ${seed}`)
      for (const [label, list] of lines) {
        const of = (key: keyof ReturnType<typeof figures>) => percent(interval(list.map((each) => each[key])))
        console.log(`${label}: people whose record is with another's ${of('mixedRecords')}, and without those one spoke for ${of('mixedApart')}; people mixed by anything ${of('mixed')}; joined pairs that are right ${of('right')}; true pairs found ${of('found')}; of those with a chain of facts ${of('foundOfJoinable')}`)
      }
      const of = (key: keyof ReturnType<typeof creditFigures>) => percent(interval(credits.map((each) => each[key])))
      console.log(`credit: records credited to their ad ${of('right')}; of records credited, to another's ad ${of('wrong')}; of those with a chain of facts to the ad, to it ${of('reachableRight')}; of records of people who never came by an ad, credited to one ${of('coldWrong')}`)
      const beside = differ.get(arm)
      if (beside) {
        const line = (key: string, scale: number) => { const { mean, low, high } = interval(beside[key]!); return `${(mean * scale).toFixed(2)} (${(low * scale).toFixed(2)} to ${(high * scale).toFixed(2)})` }
        console.log(`beside ${BESIDE[arm]}, over the same worlds, in points: people whose record is with another's ${line('mixedRecords', 100)}; people mixed by anything ${line('mixed', 100)}; joined pairs right ${line('right', 100)}. Of what that found, lost: true pairs ${line('pairsLost', 100)}; of records alone ${line('recordPairsLost', 100)}; records credited to their ad ${line('creditLost', 100)}. Callers and browsers with a record that is not theirs, pairs a world: ${line('wrongSide', 1)}`)
        const part = ([lost, of]: [number, number]) => `${lost} of ${of} (${(share(lost, of) * 100).toFixed(2)}%)`
        const pooled = lostIn.get(arm)!
        console.log(`lost, pooled: true pairs ${part(pooled.pairs)}; of records alone ${part(pooled.recordPairs)}; records credited to their ad ${part(pooled.credit)}. Records mixed, pooled: ${total.mixedRecords} of ${total.recorded} (${(share(total.mixedRecords, total.recorded) * 100).toFixed(2)}%)`)
      }
      console.log(`in all: ${JSON.stringify(total)} ${JSON.stringify(credited)}`)
      for (const [kind, row] of [...kinds].sort()) console.log(`  pairs ${kind}: ${row.same} true, ${row.found} found, ${row.wrong} wrong`)
      for (const [kind, row] of [...links].sort((x, y) => y[1].links - x[1].links)) console.log(`  links by ${kind}: ${row.links}, ${row.wrong} between two people`)
    }
  }
}

if (process.argv[1]?.endsWith('accuracy/run.ts')) await main()
