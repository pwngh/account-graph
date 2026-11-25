/**
 * The fourth run: who is joined, and who is credited, each judged by itself, in the flows a firm has.
 *   node tools/accuracy/fourth.ts --names <list> --seed 20270501 [setting …]
 *   node tools/accuracy/fourth.ts --names <list> --seed 20270501 --each base3     every rate by itself at its hard end
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
/** `new` is the third run's. `records` joins records only when confirmed. The staffed ones are what a firm whose staff enter people sets. */
const ARMS: Record<string, Switches> = {
  default: {},
  new: { policy: { apart: APART }, speaker: true },
  records: { policy: { apart: APART, records: 'confirmed' }, speaker: true },
  staffed: { policy: { ...INTAKE, records: undefined }, speaker: true, staff: true },
  'staffed records': { policy: INTAKE, speaker: true, staff: true },
}
const JUDGED = ['records', 'staffed records']
const START = Date.parse('2026-03-02T15:00:00Z')
const NAMES = 'f5a69fbe139b8541f96a42dae40bf4d564d29d660f2aeb1add0eec776ec8ff2f'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { names: { type: 'string' }, seed: { type: 'string' }, worlds: { type: 'string', default: '20' }, people: { type: 'string' }, each: { type: 'string' }, dev: { type: 'boolean', default: false } } })
if (!values.names || !values.seed) throw new Error('--names and --seed are required')
const list = readFileSync(values.names, 'utf8')
const sha = createHash('sha256').update(list).digest('hex')
if (sha !== NAMES) throw new Error('--names is another list than the page has')
const names: Names = JSON.parse(list)
const [worlds, seed] = [Number(values.worlds), Number(values.seed)]
const git = (...args: string[]) => execFileSync('git', ['-C', join(import.meta.dirname, '../..'), ...args], { encoding: 'utf8' }).trim()
if (!values.dev && git('status', '--porcelain', '--', 'src', 'tools', 'examples', 'test', 'package.json', 'package-lock.json') !== '') throw new Error('There are changes that are not committed')
console.log(`code ${git('rev-parse', 'HEAD')}${values.dev ? ', with changes or not' : ''}, Node ${process.version}, names ${sha}, seeds ${seed} to ${seed + worlds - 1}`)

const none = () => ({ mixed: 0, recorded: 0, pairs: 0, found: 0, wrong: 0, shown: 0, waiting: 0, waitingRight: 0, allFound: 0, allWrong: 0, right: 0, astray: 0, reach: 0, reached: 0, cold: 0, coldWrong: 0, spread: [] as number[] })
type Sum = ReturnType<typeof none>

async function run(rates: Rates, people: number, days: number, pool: number, arms: string[]): Promise<Map<string, Sum>> {
  const sums = new Map(arms.map((arm) => [arm, none()]))
  for (let i = 0; i < worlds; i++) {
    const world = makeWorld(rates, { people, days, start: START, seed: seed + i }, rates.third && names)
    for (const arm of arms) {
      const t = sums.get(arm)!
      const { truths, clusterOf, credit, waiting } = await play(world, ARMS[arm]!, pool, HERE)
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
      t.spread.push(recorded === 0 ? 0 : mixedRecords / recorded)
    }
  }
  return sums
}

const of = (some: number, all: number) => `${some} of ${all} (${all === 0 ? 'none' : `${((some / all) * 100).toFixed(2)}%`})`
const lines = (t: Sum) => [
  `identity: people whose record is with another's ${of(t.mixed, t.recorded)}, worst world ${(Math.max(...t.spread) * 100).toFixed(2)}%; pairs of records joined that are two people ${of(t.wrong, t.found + t.wrong)}`,
  `  pairs of records that are one person: joined ${of(t.found, t.pairs)}, joined or shown ${of(t.found + t.shown, t.pairs)}; shown ${t.waiting}, ${of(t.waitingRight, t.waiting)} of them one person; all joined pairs right ${of(t.allFound, t.allFound + t.allWrong)}`,
  `credit: to the wrong ad ${of(t.astray + t.coldWrong, t.right + t.astray + t.coldWrong)}; of those with a chain of facts, to it ${of(t.reached, t.reach)}`,
]
const mark = (what: string, some: number, all: number, held: (share: number) => boolean) => console.log(`  ${all === 0 ? 'BAD (nothing)' : held(some / all) ? 'held' : 'BAD'}: ${what}: ${of(some, all)}`)

if (values.each) {
  const { rates, people, days, pool } = SETTINGS[values.each]!
  const hard = SETTINGS.high3!.rates
  console.log(`\n## ${values.each}, one rate at a time at its hard end, printed and judged by no mark`)
  const one: [string, Rates][] = [['nothing', rates], ...Object.keys(rates).filter((key) => key !== 'third' && JSON.stringify(rates[key as keyof Rates]) !== JSON.stringify(hard[key as keyof Rates])).map((key): [string, Rates] => [key, { ...rates, [key]: hard[key as keyof Rates] }]),
    ...Object.keys(rates.third ?? {}).filter((key) => JSON.stringify((rates.third as never)[key]) !== JSON.stringify((hard.third as never)[key])).map((key): [string, Rates] => [`third ${key}`, { ...rates, third: { ...rates.third!, [key]: (hard.third as never)[key] } }])]
  for (const [what, some] of one) {
    const sums = await run(some, Number(values.people ?? people), days, pool, ['new', 'records'])
    console.log(`${what.padEnd(22)} ${[...sums].map(([arm, t]) => `${arm}: mixed ${of(t.mixed, t.recorded)}, joined ${of(t.found, t.pairs)}, credit to it ${of(t.reached, t.reach)}`).join(' | ')}`)
  }
} else {
  for (const name of positionals.length > 0 ? positionals : ['self4', 'staff4', 'base3', 'high3', 'base']) {
    const { rates, people, days, pool } = SETTINGS[name]!
    const sums = await run(rates, Number(values.people ?? people), days, pool, Object.keys(ARMS))
    for (const [arm, t] of sums) {
      console.log(`\n## ${name}, ${arm}: ${worlds} worlds of ${values.people ?? people} people over ${days} days`)
      for (const line of lines(t)) console.log(line)
      if (!JUDGED.includes(arm) || (name === 'self4' && arm !== 'records') || (name === 'staff4' && arm !== 'staffed records')) continue
      const hard = name === 'high3'
      const beside = sums.get(arm === 'records' ? 'new' : 'staffed')!
      mark("people whose record is with another's", t.mixed, t.recorded, (share) => share <= (hard ? 0.005 : 0.0025))
      mark('pairs of records joined that are two people', t.wrong, t.found + t.wrong, (share) => share <= 0.02)
      mark('pairs of records that are one person, joined or shown', t.found + t.shown, t.pairs, (share) => share >= (hard ? 0.65 : 0.75))
      mark('pairs shown that are one person', t.waitingRight, t.waiting, (share) => share >= 0.25)
      mark('credit to the wrong ad', t.astray + t.coldWrong, t.right + t.astray + t.coldWrong, (share) => share <= (hard ? 0.04 : 0.025))
      mark('of those with a chain of facts to their ad, credited to it', t.reached, t.reach, (share) => share >= Math.max(hard ? 0.85 : 0.9, beside.reached / beside.reach - 0.01))
    }
  }
}
