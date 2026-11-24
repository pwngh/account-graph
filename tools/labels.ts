/**
 * Measures the graph against pairs somebody has checked, and prints how often each kind was right.
 *
 *   GRAPH_URL=http://localhost:8080 GRAPH_TOKEN=… npm run labels -- pairs.csv
 *
 * The first line names the columns: a, b and label. A label is `same` or
 * `different`. A reviewer's token is enough: nothing is written. The file
 * names your people, so keep it outside the repository. Only counts are printed.
 */
import { readFileSync } from 'node:fs'
import { fit, measure } from '../src/index.ts'
import type { Labeled, Policy } from '../src/index.ts'
import { parseCsv } from '../src/integrations/costs.ts'

const [file] = process.argv.slice(2)
const { GRAPH_URL, GRAPH_TOKEN } = process.env
if (!file || !GRAPH_URL || !GRAPH_TOKEN) {
  console.error('Usage: GRAPH_URL=… GRAPH_TOKEN=… npm run labels -- pairs.csv')
  process.exit(2)
}
const read = async (path: string): Promise<any> => {
  const response = await fetch(new URL(path, GRAPH_URL), { headers: { authorization: `Bearer ${GRAPH_TOKEN}` } })
  if (!response.ok) throw new Error(`The server answered ${response.status}: ${await response.text()}`)
  return response.json()
}

const lines = parseCsv(readFileSync(file, 'utf8'))
const head = (lines[0] ?? []).map((name) => name.trim().toLowerCase())
for (const needed of ['a', 'b', 'label']) if (!head.includes(needed)) throw new Error(`The CSV needs a "${needed}" column`)
const pairs = new Map<string, { a: string; b: string; said: Set<boolean> }>()
let rows = 0
for (const [i, cells] of lines.entries()) {
  if (i === 0 || cells.every((cell) => !cell.trim())) continue
  // A subject is used as it is written: a space may be part of it.
  const [a = '', b = '', said = ''] = ['a', 'b', 'label'].map((name) => cells[head.indexOf(name)])
  const label = said.trim()
  if (!a || !b || a === b) throw new Error(`Line ${i + 1} needs two different subjects`)
  if (label !== 'same' && label !== 'different') throw new Error(`Line ${i + 1} needs its label as "same" or "different"`)
  rows += 1
  const key = JSON.stringify([a, b].sort())
  const pair = pairs.get(key) ?? { a, b, said: new Set() }
  pairs.set(key, pair)
  pair.said.add(label === 'same')
}
// A pair labelled both ways says nothing.
const clear = [...pairs.values()].filter((pair) => pair.said.size === 1).map(({ a, b, said }) => ({ a, b, same: said.has(true) }))

const used: (Labeled & { joined: boolean; score: number; idle: string[] })[] = []
const missing = { same: 0, different: 0 }
for (let i = 0; i < clear.length; i += 8) {
  await Promise.all(clear.slice(i, i + 8).map(async ({ a, b, same }) => {
    const { known, joined, score, reasons, idle } = await read(`/between?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
    if (known) used.push({ same, joined, score, reasons, idle })
    else missing[same ? 'same' : 'different'] += 1
  }))
}
const { rules } = await read('/policy')
const policy: Policy = { ...rules, kinds: Object.fromEntries(Object.entries<any>(rules.kinds).map(([kind, rule]) => [kind, { ...rule, halfLife: rule.halfLife === 'none' ? Infinity : rule.halfLife }])) }

const count = (list: readonly { same: boolean }[]) => ({ same: list.filter((each) => each.same).length, different: list.filter((each) => !each.same).length })
const total = count(used)
const of = (part: number, whole: number) => (whole === 0 ? '-' : `${((100 * part) / whole).toFixed(1)}%`)
const table = (cells: (string | number)[][]) => {
  const wide = cells[0]!.map((_, column) => Math.max(...cells.map((row) => String(row[column]).length)))
  for (const row of cells) console.log(row.map((cell, column) => (column === 0 ? String(cell).padEnd(wide[0]!) : String(cell).padStart(wide[column]!))).join('  '))
}
const line = (name: string, list: readonly { same: boolean }[]) => {
  const { same, different } = count(list)
  return [name, same + different, same, different, of(same, same + different), of(same, total.same)]
}

console.log(`${rows} rows, ${pairs.size} pairs. ${pairs.size - clear.length} labelled both ways were left out.`)
console.log(`${missing.same + missing.different} could not be used, because nothing recorded about one of the two is left: ${missing.same} same, ${missing.different} different.`)
console.log(`${used.length} used: ${total.same} same, ${total.different} different.\n`)
table([
  ['What the pair shares', 'pairs', 'same', 'different', 'precision', 'recall'],
  ...Object.entries(measure(used)).sort(([x], [y]) => (x < y ? -1 : 1)).flatMap(([kind, { alone }]) => {
    const sharing = used.filter((pair) => pair.reasons.some((reason) => reason.identifier.startsWith(`${kind}:`)))
    return [line(kind, sharing), [`  and nothing else`, alone.pairs, alone.same, alone.pairs - alone.same, of(alone.same, alone.pairs), of(alone.same, total.same)]]
  }),
  ...[...new Set(used.flatMap((pair) => pair.idle.map((identifier) => identifier.slice(0, identifier.indexOf(':')))))].sort().map((kind) => line(`${kind}, muted or over its cap`, used.filter((pair) => pair.idle.some((identifier) => identifier.startsWith(`${kind}:`))))),
  line('nothing', used.filter((pair) => pair.reasons.length + pair.idle.length === 0)),
  line(`a score of ${policy.same} or more`, used.filter((pair) => pair.score >= policy.same)),
  line('in one cluster now', used.filter((pair) => pair.joined)),
])
console.log('\nPrecision: of the pairs in the line, how many are the same person. Recall: of the pairs labelled same, how many are in the line.')

const taught = used.filter((pair) => pair.reasons.length > 0)
if (taught.length > 0) {
  const { kinds, loss } = fit(taught, policy)
  console.log(`\nThe weights \`fit\` would give, over ${taught.length} pairs that share something. Log loss ${loss.before.toFixed(3)} before, ${loss.after.toFixed(3)} after.`)
  table([['Kind', 'pairs', 'weight now', 'fitted'], ...Object.entries(kinds).map(([kind, each]) => [kind, each.pairs, each.before, each.after])])
}
console.log(`
Before you use these numbers:
- Labels from staff are biased. Staff find the pairs that already look alike, by a phone or a name, so a kind they search by looks better here than it is, and strangers who share it are hardly here at all.
- A record that was merged away, with its evidence deleted, cannot be used. Those are the surest "same" pairs you had, and the counts above say how many are missing.
- "In one cluster now" also counts what reviewers joined by hand. The other lines leave a reviewer's mark out.
- Few pairs say little. One pair more or less moves a share of 20 by 5 points.`)
