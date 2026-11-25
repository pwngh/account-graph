/**
 * The third run. Reports the same worlds to two codes, the one it started from and this one, and judges the marks that
 * `docs/accuracy.md` wrote beforehand.
 *   node tools/accuracy/third.ts --pinned <a checkout of b9bba69> --names <list> --seed 20270301 [base3 low3 high3 busy3 dirty3]
 *   … --dry prints what the worlds hold, and scores nothing
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createGraph, createMemoryStore, namesOf, policyFrom } from '../../src/index.ts'
import { createHandler } from '../../src/server.ts'
import { play } from './run.ts'
import type { Code, Outcome, Switches } from './run.ts'
import { SETTINGS } from './rates.ts'
import { score } from './score.ts'
import { dirtied, makeWorld } from './world.ts'
import type { Names, World } from './world.ts'

const HERE: Code = { createGraph, createMemoryStore, policyFrom, createHandler }
const CONFIG = { policy: { apart: ['birth', 'given'] }, speaker: true }
/** `today` is the code at the start under the default policy. `new` is this code as it would be set. */
const ARMS: Record<string, Switches & { pinned?: true }> = {
  today: { pinned: true },
  new: CONFIG,
  'today pool': { pinned: true, pool: true },
  'new pool': { ...CONFIG, pool: true },
}
const START = Date.parse('2026-03-02T15:00:00Z')

/** What was made, as a browser, a record or a call, whose it is, and what was told of it: the same for every code. */
interface Item {
  id: string
  people: readonly string[]
  facts: readonly string[]
  cluster: string
}

function itemsOf(world: World, { truths, clusterOf, callerOf }: Outcome): Item[] {
  const own = truths.filter(({ subject }) => /^(visitor|contact):/.test(subject)).map(({ subject, people, facts }): Item => ({ id: subject, people, facts, cluster: clusterOf.get(subject) ?? subject }))
  const calls = [...world.calls].map(([id, { people, facts }]): Item => ({ id: `call ${id}`, people, facts, cluster: clusterOf.get(callerOf.get(id) ?? '') ?? `call ${id}` }))
  return [...own, ...calls]
}

/** Pairs of one person's things that are together, and those with a chain of facts between them. */
function pairsOf(items: readonly Item[]): { found: Set<string>; chained: Set<string> } {
  const byPerson = new Map<string, Item[]>()
  for (const item of items) for (const person of item.people) byPerson.set(person, [...(byPerson.get(person) ?? []), item])
  const [found, chained] = [new Set<string>(), new Set<string>()]
  for (const own of byPerson.values()) {
    const parent = new Map<string, string>()
    const root = (key: string): string => {
      let at = key
      while ((parent.get(at) ?? at) !== at) at = parent.get(at)!
      return at
    }
    for (const { id, facts } of own) for (const fact of facts) parent.set(root(id), root(`fact ${fact}`))
    for (const [i, a] of own.entries()) {
      for (const b of own.slice(i + 1)) {
        const key = [a.id, b.id].sort().join('\n')
        if (a.cluster === b.cluster) found.add(key)
        if (root(a.id) === root(b.id)) chained.add(key)
      }
    }
  }
  return { found, chained }
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pinned: { type: 'string' }, names: { type: 'string' }, worlds: { type: 'string', default: '20' }, seed: { type: 'string' }, dry: { type: 'boolean', default: false }, arms: { type: 'string' } } })
// For a look at fewer arms. Marks of arms left out have nothing to count.
if (values.arms) for (const arm of Object.keys(ARMS)) if (!values.arms.split(',').includes(arm)) delete ARMS[arm]
const settings = positionals.length > 0 ? positionals : ['base3', 'low3', 'high3', 'busy3', 'dirty3']
for (const name of settings) if (!SETTINGS[name]) throw new Error(`"${name}" is not a setting`)
if (!values.names || !values.seed || (!values.pinned && !values.dry)) throw new Error('--names, --seed and --pinned are required')
const list = readFileSync(values.names, 'utf8')
const names: Names = JSON.parse(list)
const [worlds, seed] = [Number(values.worlds), Number(values.seed)]
console.log(`Node ${process.version}, names ${createHash('sha256').update(list).digest('hex')}, seeds ${seed} to ${seed + worlds - 1}`)

const pinned: Code | undefined = values.pinned ? { ...(await import(join(values.pinned, 'src/index.ts'))), ...(await import(join(values.pinned, 'src/server.ts'))) } : undefined
const part = (some: number, all: number) => `${some} of ${all} (${all === 0 ? 'none' : `${((some / all) * 100).toFixed(2)}%`})`
/** What is judged where there is nothing to judge is bad, not held. */
const mark = (what: string, some: number, all: number, held: (share: number) => boolean) => console.log(`  ${all === 0 ? 'BAD (nothing)' : held(some / all) ? 'held' : 'BAD'}: ${what}: ${part(some, all)}`)

for (const name of settings) {
  const setting = SETTINGS[name]!
  const made = (world: number) => {
    const clean = makeWorld(setting.rates, { people: setting.people, days: setting.days, start: START, seed: seed + world }, setting.rates.third && names)
    return setting.dirt ? dirtied(clean, setting.dirt, seed + world) : clean
  }
  const covered = { same: 0, covered: 0, not: 0 }
  const coverOf = ({ name, written }: { name: string; written: string }) => (written === name ? 'same' : namesOf(written).some((each) => namesOf(name).includes(each)) ? 'covered' : 'not')
  if (values.dry) {
    const t = { visits: 0, taps: 0, calls: 0, late: 0, records: 0, told: 0, own: 0, toldLate: 0, spoke: 0 }
    for (let world = 0; world < worlds; world++) {
      const { events, spoke, written } = made(world)
      for (const event of events) {
        if (event.kind === 'visit') t.visits++
        else if (event.kind === 'tap') t.taps++
        else if (event.kind === 'call') (t.calls++, event.told !== undefined && t.late++)
        else if (event.kind === 'record') (t.records++, event.speaker && t.told++, event.own && t.own++)
        else if (event.kind === 'speaks') t.toldLate++
      }
      t.spoke += spoke.size
      for (const each of written.values()) covered[coverOf(each)]++
    }
    console.log(name, JSON.stringify(t), 'names written as they are, in a form the table knows, and in one it does not', JSON.stringify(covered))
    continue
  }
  const total = new Map(Object.keys(ARMS).map((arm) => [arm, { mixed: 0, mixedApart: 0, recorded: 0, right: 0, wrongPairs: 0, tap: 0, tapWrong: 0, creditRight: 0, creditWrong: 0, links: new Map<string, { links: number; wrong: number }>(), kinds: new Map<string, number>(), wrongBy: new Map<string, number>() }]))
  const kept = new Map(Object.keys(ARMS).map((arm) => [arm, { chained: [0, 0], recordPairs: [0, 0], credit: [0, 0], ties: [0, 0], same: [0, 0], covered: [0, 0], not: [0, 0] } as Record<string, [number, number]>]))
  for (let w = 0; w < worlds; w++) {
    const world = made(w)
    const saidOf = new Set(world.events.flatMap((event) => (event.kind === 'record' && event.speaker) || event.kind === 'speaks' ? [event.subject] : []))
    const before = new Map<string, { found: Set<string>; chained: Set<string>; credit: Set<string>; ties: Set<string> }>()
    for (const [arm, { pinned: old, ...set }] of Object.entries(ARMS)) {
      const outcome = await play(world, set, setting.pool, old ? pinned! : HERE)
      const result = score(outcome.truths, outcome.clusterOf, world.spoke)
      const row = total.get(arm)!
      row.mixed += result.mixedRecords
      row.mixedApart += result.mixedApart
      row.recorded += result.recorded
      row.right += result.all.found
      row.wrongPairs += result.all.wrong
      row.tap += outcome.tapLinks.links
      row.tapWrong += outcome.tapLinks.wrong
      row.creditRight += outcome.credit.right
      row.creditWrong += outcome.credit.wrong + outcome.credit.coldWrong
      for (const [kind, { links, wrong }] of outcome.links) {
        const now = row.links.get(kind) ?? { links: 0, wrong: 0 }
        row.links.set(kind, { links: now.links + links, wrong: now.wrong + wrong })
      }
      for (const [kind, { wrong }] of result.kinds) row.kinds.set(kind, (row.kinds.get(kind) ?? 0) + wrong)
      const byCluster = new Map<string, typeof outcome.truths>()
      for (const each of outcome.truths) {
        const key = outcome.clusterOf.get(each.subject) ?? each.subject
        byCluster.set(key, [...(byCluster.get(key) ?? []), each])
      }
      // Of wrong pairs, those where one spoke for the other, and whether the record of either says so.
      for (const members of byCluster.values()) {
        for (const [i, a] of members.entries()) {
          for (const b of members.slice(i + 1)) {
            if (a.people.some((each) => b.people.includes(each))) continue
            const spoke = a.people.some((x) => b.people.some((y) => world.spoke.has(`${x} ${y}`) || world.spoke.has(`${y} ${x}`)))
            const told = [a.subject, b.subject].some((each) => saidOf.has(each))
            const key = spoke ? (told ? 'one spoke for the other, and a record says so' : 'one spoke for the other, and none says so') : 'nobody spoke for the other'
            row.wrongBy.set(key, (row.wrongBy.get(key) ?? 0) + 1)
          }
        }
      }
      const items = itemsOf(world, outcome)
      const { found, chained } = pairsOf(items)
      const peopleOf = new Map(items.map(({ id, people }) => [id, people]))
      const ties = new Set([...outcome.ties].filter(([call, browsers]) => browsers.some((browser) => peopleOf.get(browser)?.some((each) => world.calls.get(call)?.people.includes(each)))).map(([call]) => call))
      before.set(arm, { found, chained, credit: outcome.creditedRight, ties })
      // Each arm is held to the code it would replace, with no pool: a pool is judged against today without one.
      const then = before.get('today')!
      const keep = kept.get(arm)!
      const count = (key: string, all: Iterable<string>, now: ReadonlySet<string>) => {
        for (const each of all) {
          keep[key]![1] += 1
          if (now.has(each)) keep[key]![0] += 1
        }
      }
      count('chained', [...then.found].filter((pair) => then.chained.has(pair)), found)
      const records = [...then.found].filter((pair) => pair.split('\n').every((id) => id.startsWith('contact:')))
      count('recordPairs', records, found)
      count('credit', then.credit, outcome.creditedRight)
      count('ties', then.ties, ties)
      for (const pair of records) {
        const [a, b] = pair.split('\n').map((id) => world.written.get(id)!) as [{ name: string; written: string }, { name: string; written: string }]
        const kind = a.written === b.written ? 'same' : coverOf(a) !== 'not' && coverOf(b) !== 'not' ? 'covered' : 'not'
        count(kind, [pair], found)
      }
    }
    for (const each of world.written.values()) covered[coverOf(each)]++
  }
  console.log(`\n## ${name}: ${worlds} worlds of ${setting.people} people over ${setting.days} days`)
  for (const [arm, row] of total) {
    const keep = kept.get(arm)!
    console.log(`${arm}: people whose record is with another's ${part(row.mixed, row.recorded)}, and without those one spoke for ${part(row.mixedApart, row.recorded)}; joined pairs right ${part(row.right, row.right + row.wrongPairs)}; links by a tap or a number shown wrong ${part(row.tapWrong, row.tap)}; credited records to the wrong ad ${part(row.creditWrong, row.creditRight + row.creditWrong)}`)
    console.log(`  of what today found, kept: pairs with a chain ${part(...keep.chained!)}; pairs of records ${part(...keep.recordPairs!)}, of them written the same ${part(...keep.same!)}, in forms the table knows ${part(...keep.covered!)}, and in forms it does not ${part(...keep.not!)}; records credited to their ad ${part(...keep.credit!)}; calls tied to a browser of their caller's ${part(...keep.ties!)}`)
    console.log(`  wrong pairs: ${[...row.wrongBy].map(([kind, n]) => `${kind} ${n}`).join('; ')}; by kind ${[...row.kinds].filter(([, n]) => n > 0).map(([kind, n]) => `${kind} ${n}`).join(', ')}`)
    for (const [kind, { links, wrong }] of [...row.links].sort((x, y) => y[1].links - x[1].links)) console.log(`    links by ${kind}: ${links}, ${wrong} between two people`)
  }
  console.log(`names written as they are, in a form the table knows, and in one it does not: ${JSON.stringify(covered)}`)
  const judged = (arm: string) => ({ row: total.get(arm) ?? { mixed: 0, recorded: 0, right: 0, wrongPairs: 0, tap: 0, tapWrong: 0, creditRight: 0, creditWrong: 0, links: new Map<string, { links: number; wrong: number }>() }, keep: kept.get(arm) ?? ({ chained: [0, 0], recordPairs: [0, 0], credit: [0, 0], ties: [0, 0] } as Record<string, [number, number]>) })
  console.log('marks:')
  const now = judged('new')
  // The old settings have the marks of the new ones that came of them.
  const as = { base: 'base3', high: 'high3', busy: 'busy3' }[name] ?? name
  if (as === 'base3') {
    mark('people whose record is with another\'s, at most 1%', now.row.mixed, now.row.recorded, (share) => share <= 0.01)
    mark('joined pairs right, at least 98%', now.row.right, now.row.right + now.row.wrongPairs, (share) => share >= 0.98)
    for (const [kind, { links, wrong }] of now.row.links) if ((total.get('today')!.links.get(kind)?.links ?? 0) >= 200 || links >= 200) mark(`links by ${kind} wrong, at most 5%`, wrong, links, (share) => share <= 0.05)
    mark('credited records to the wrong ad, at most 2%', now.row.creditWrong, now.row.creditRight + now.row.creditWrong, (share) => share <= 0.02)
    mark('with a pool, links by a tap or a number shown wrong, at most 5%', judged('new pool').row.tapWrong, judged('new pool').row.tap, (share) => share <= 0.05)
    mark('kept of pairs with a chain, at least 90%', ...now.keep.chained!, (share) => share >= 0.9)
    mark('kept of calls tied, at least 90%', ...now.keep.ties!, (share) => share >= 0.9)
    mark('kept with a pool of calls tied, at least 90%', ...judged('new pool').keep.ties!, (share) => share >= 0.9)
    console.log(`  no mark: with a pool, people whose record is with another's ${part(judged('new pool').row.mixed, judged('new pool').row.recorded)}; joined pairs right ${part(judged('new pool').row.right, judged('new pool').row.right + judged('new pool').row.wrongPairs)}`)
  }
  if (as === 'base3' || as === 'high3') {
    if (as === 'high3') mark('people whose record is with another\'s, at most 2.5%', now.row.mixed, now.row.recorded, (share) => share <= 0.025)
    mark(`kept of pairs of records, at least ${as === 'base3' ? 98 : 95}%`, ...now.keep.recordPairs!, (share) => share >= (as === 'base3' ? 0.98 : 0.95))
    mark('kept of records credited to their ad, at least 90%', ...now.keep.credit!, (share) => share >= 0.9)
  }
  if (as === 'busy3') {
    const pool = judged('new pool')
    mark('with a pool, links by a tap or a number shown wrong, at most 5%', pool.row.tapWrong, pool.row.tap, (share) => share <= 0.05)
    mark('kept with a pool of calls tied, at least 90%', ...pool.keep.ties!, (share) => share >= 0.9)
    console.log(`  no mark: without a pool, links by a tap wrong ${part(now.row.tapWrong, now.row.tap)}; kept of calls tied ${part(...now.keep.ties!)}`)
  }
  if (name === 'dirty3') {
    mark('people whose record is with another\'s, at most 1.5%', now.row.mixed, now.row.recorded, (share) => share <= 0.015)
    mark('credited records to the wrong ad, at most 2%', now.row.creditWrong, now.row.creditRight + now.row.creditWrong, (share) => share <= 0.02)
    mark('kept of pairs of records, at least 98%', ...now.keep.recordPairs!, (share) => share >= 0.98)
    mark('kept of records credited to their ad, at least 90%', ...now.keep.credit!, (share) => share >= 0.9)
  }
}
