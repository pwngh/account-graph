/**
 * The fifth run: what is left wrong, and what is left undone, where a firm asks for a date of birth and looks at what it is shown.
 *   node tools/accuracy/fifth.ts --names <list> --seed 20270701 [setting …]
 * With no setting it runs all that `docs/accuracy.md` promises. It refuses a checkout with changes not committed, but with --dev.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createHandler } from '../../test/harness.ts'
import { createGraph, createMemoryStore, policyFrom } from '../internals.ts'
import { SETTINGS } from './rates.ts'
import { play } from './run.ts'
import type { Switches } from './run.ts'
import { score } from './score.ts'
import { makeWorld } from './world.ts'
import type { Names, Rates } from './world.ts'

const HERE = { createGraph, createMemoryStore, policyFrom, createHandler }
const INTAKE = JSON.parse(readFileSync(new URL('../../examples/intake.json', import.meta.url), 'utf8'))
const APART = ['birth', 'given']
/** Staff look at nine in ten pairs of records that are shown, and decide 98 of 100 of those rightly. Assumed, and set before any look. */
const desk = (seed: number) => ({ seen: 0.9, right: 0.98, seed })
const ARMS: Record<string, (seed: number) => Switches> = {
  default: () => ({}),
  new: () => ({ policy: { apart: APART }, speaker: true }),
  records: () => ({ policy: { apart: APART, records: 'confirmed' }, speaker: true }),
  'records decided': (seed) => ({ policy: { apart: APART, records: 'confirmed' }, speaker: true, decide: desk(seed) }),
  'staffed records': () => ({ policy: INTAKE, speaker: true, staff: true }),
  'staffed decided': (seed) => ({ policy: INTAKE, speaker: true, staff: true, decide: desk(seed) }),
}
/** Where each arm is judged, and what would be bad: shares at most, and at least. Written before the held seeds. */
const JUDGED: Record<string, string[]> = { self5: ['records decided'], staff5: ['staffed decided'], base3: ['records decided', 'staffed decided'], high3: ['records decided', 'staffed decided'] }
const MARKS: Record<string, { mixed: number; wrong: number; joined: number; astray: number; credited: number; decided: number }> = {
  self5: { mixed: 0.001, wrong: 0.01, joined: 0.9, astray: 0.02, credited: 0.97, decided: 0.05 },
  staff5: { mixed: 0.001, wrong: 0.01, joined: 0.85, astray: 0.02, credited: 0.93, decided: 0.05 },
  base3: { mixed: 0.0025, wrong: 0.01, joined: 0.8, astray: 0.02, credited: 0.93, decided: 0.07 },
  high3: { mixed: 0.005, wrong: 0.02, joined: 0.62, astray: 0.03, credited: 0.89, decided: 0.11 },
}
const START = Date.parse('2026-03-02T15:00:00Z')
const NAMES = 'f5a69fbe139b8541f96a42dae40bf4d564d29d660f2aeb1add0eec776ec8ff2f'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { names: { type: 'string' }, seed: { type: 'string' }, worlds: { type: 'string', default: '20' }, people: { type: 'string' }, dev: { type: 'boolean', default: false } } })
if (!values.names || !values.seed) throw new Error('--names and --seed are required')
const list = readFileSync(values.names, 'utf8')
const sha = createHash('sha256').update(list).digest('hex')
if (sha !== NAMES) throw new Error('--names is another list than the page has')
const names: Names = JSON.parse(list)
const [worlds, seed] = [Number(values.worlds), Number(values.seed)]
const git = (...args: string[]) => execFileSync('git', ['-C', join(import.meta.dirname, '../..'), ...args], { encoding: 'utf8' }).trim()
if (!values.dev && git('status', '--porcelain', '--', 'src', 'tools', 'examples', 'test', 'package.json', 'package-lock.json') !== '') throw new Error('There are changes that are not committed')
console.log(`code ${git('rev-parse', 'HEAD')}${values.dev ? ', with changes or not' : ''}, Node ${process.version}, names ${sha}, seeds ${seed} to ${seed + worlds - 1}`)

const none = () => ({ mixed: 0, recorded: 0, pairs: 0, found: 0, wrong: 0, shown: 0, waiting: 0, waitingRight: 0, allFound: 0, allWrong: 0, right: 0, astray: 0, reach: 0, reached: 0, cold: 0, coldWrong: 0, decided: 0, wrongJoins: 0, joins: 0, wrongSplits: 0, splits: 0, spread: [] as number[] })
type Sum = ReturnType<typeof none>

async function run(rates: Rates, people: number, days: number, pool: number, arms: string[]): Promise<Map<string, Sum>> {
  const sums = new Map(arms.map((arm) => [arm, none()]))
  for (let i = 0; i < worlds; i++) {
    const world = makeWorld(rates, { people, days, start: START, seed: seed + i }, rates.third && names)
    for (const arm of arms) {
      const t = sums.get(arm)!
      const { truths, clusterOf, credit, waiting, decided } = await play(world, ARMS[arm]!(seed + i), pool, HERE)
      const { all, kinds, recorded, mixedRecords, pairs } = score(truths, clusterOf, world.spoke)
      const own = kinds.get('contact contact') ?? { same: 0, found: 0, wrong: 0 }
      t.mixed += mixedRecords
      t.recorded += recorded
      t.pairs += own.same
      t.found += own.found
      t.wrong += own.wrong
      // Shown to be looked at, and not joined already by another way.
      t.shown += [...waiting.found].filter((each) => !pairs.has(each)).length
      t.waiting += waiting.pairs
      t.waitingRight += waiting.right
      t.allFound += all.found
      t.allWrong += all.wrong
      t.right += credit.right
      t.astray += credit.wrong
      t.reach += credit.reachable
      t.reached += credit.reachableRight
      t.cold += credit.cold
      t.coldWrong += credit.coldWrong
      t.decided += decided.seen
      t.joins += decided.joins
      t.wrongJoins += decided.wrongJoins
      t.splits += decided.splits
      t.wrongSplits += decided.wrongSplits
      t.spread.push(recorded === 0 ? 0 : mixedRecords / recorded)
    }
  }
  return sums
}

const mark = (what: string, some: number, all: number, held: (share: number) => boolean) => console.log(`  ${all === 0 ? 'BAD (nothing)' : held(some / all) ? 'held' : 'BAD'}: ${what}: ${of(some, all)}`)
const of = (some: number, all: number) => `${some} of ${all} (${all === 0 ? 'none' : `${((some / all) * 100).toFixed(2)}%`})`
const lines = (t: Sum) => [
  `identity: people whose record is with another's ${of(t.mixed, t.recorded)}, worst world ${(Math.max(...t.spread) * 100).toFixed(2)}%; pairs of records joined that are two people ${of(t.wrong, t.found + t.wrong)}`,
  `  pairs of records that are one person: joined ${of(t.found, t.pairs)}, joined or shown ${of(t.found + t.shown, t.pairs)}; shown ${t.waiting}, ${of(t.waitingRight, t.waiting)} of them one person; all joined pairs right ${of(t.allFound, t.allFound + t.allWrong)}`,
  `credit: to the wrong ad ${of(t.astray + t.coldWrong, t.right + t.astray + t.coldWrong)}; of those with a chain of facts, to it ${of(t.reached, t.reach)}`,
]

for (const name of positionals.length > 0 ? positionals : ['self5', 'staff5', 'base3', 'high3']) {
  const { rates, people, days, pool } = SETTINGS[name]!
  const size = Number(values.people ?? people)
  const sums = await run(rates, size, days, pool, Object.keys(ARMS))
  for (const [arm, t] of sums) {
    console.log(`\n## ${name}, ${arm}: ${worlds} worlds of ${size} people over ${days} days`)
    for (const line of lines(t)) console.log(line)
    if (t.decided > 0) console.log(`staff decided ${t.decided} pairs: joined ${t.joins}, ${t.wrongJoins} of them wrongly; kept apart ${t.splits}, ${t.wrongSplits} of them wrongly`)
    if (!JUDGED[name]?.includes(arm)) continue
    const bad = MARKS[name]!
    mark("people whose record is with another's", t.mixed, t.recorded, (share) => share <= bad.mixed)
    mark('pairs of records joined that are two people', t.wrong, t.found + t.wrong, (share) => share <= bad.wrong)
    mark('pairs of records that are one person, joined', t.found, t.pairs, (share) => share >= bad.joined)
    mark('credit to the wrong ad', t.astray + t.coldWrong, t.right + t.astray + t.coldWrong, (share) => share <= bad.astray)
    mark('of those with a chain of facts to their ad, credited to it', t.reached, t.reach, (share) => share >= bad.credited)
    mark('pairs staff had to decide, of people with a record', t.decided, t.recorded, (share) => share <= bad.decided)
  }
}
