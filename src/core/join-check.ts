/**
 * A sample of the joins the graph made on its own, for staff to check by hand,
 * and the score of their answers. The share of joins that were right is the
 * one number that says how often matching is wrong, so it is measured on a
 * sample nobody chose.
 */
import type { Subject } from '../contract/types.ts'
import type { Graph } from './graph.ts'
import type { Store } from './store.ts'

/** Two records the graph put in one cluster, and the identifiers that did it. */
export interface JoinPair {
  a: Subject
  b: Subject
  score: number
  reasons: string[]
}

const pairKey = (a: Subject, b: Subject) => (a < b ? `${a}\n${b}` : `${b}\n${a}`)

/** A random number from 0 to 1 that only the seed decides: mulberry32, seeded by an FNV-1a hash of the text. */
function seeded(seed: string): () => number {
  let state = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Up to `size` pairs, chosen at random from every two records in one cluster
 * that a `same` link joins directly. A pair a reviewer joined is left out. The
 * same seed on the same graph gives the same pairs.
 */
export async function sampleJoins(graph: Graph, store: Store, { size, seed }: { size: number; seed: string }): Promise<JoinPair[]> {
  const clusterOf = new Map<Subject, Subject>()
  const members = new Map<Subject, Subject[]>()
  await store.read(async (tx) => {
    for await (const batch of tx.everyone()) {
      for (const { subject, labels } of batch) {
        if (!labels) continue
        clusterOf.set(subject, labels.cluster)
        members.set(labels.cluster, [...(members.get(labels.cluster) ?? []), subject])
      }
    }
  })
  // Joins by hand, as they stand after every later unjoin.
  const byHand = new Set<string>()
  for (const { action, about } of await graph.decisions()) {
    if (about.length !== 2) continue
    if (action === 'join') byHand.add(pairKey(about[0]!, about[1]!))
    else if (action === 'unjoin') byHand.delete(pairKey(about[0]!, about[1]!))
  }
  const pairs: JoinPair[] = []
  const subjects = [...members.values()].filter((group) => group.length > 1).flat().sort()
  for (const a of subjects) {
    for (const link of await graph.links(a)) {
      const b = link.subject
      if (link.level !== 'same' || !(a < b) || clusterOf.get(b) !== clusterOf.get(a) || byHand.has(pairKey(a, b))) continue
      pairs.push({ a, b, score: link.score, reasons: link.reasons.filter((reason) => reason.counted !== false).map((reason) => reason.identifier) })
    }
  }
  // Fisher-Yates on pairs in a fixed order, so only the seed decides which come first.
  pairs.sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1))
  const random = seeded(seed)
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!]
  }
  return pairs.slice(0, size)
}

// A spreadsheet runs a cell that starts like a formula, and subjects and identifiers are written by others. Numbers stay as they are.
function cell(value: unknown): string {
  const plain = String(value)
  const text = /^\s*[=+\-@＝＋－＠]|^[\t\r\n]/.test(plain) && !/^-?\d+(\.\d+)?$/.test(plain) ? `'${plain}` : plain
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** The pairs as CSV, with an empty `same` column for the person checking to fill with yes or no. */
export function checkSheet(pairs: readonly JoinPair[]): string {
  const lines = pairs.map(({ a, b, score, reasons }) => [a, b, score.toFixed(3), reasons.join(' '), ''].map(cell).join(','))
  return ['a,b,score,reasons,same', ...lines].join('\n') + '\n'
}

/** The cells of one CSV text, a row at a time. Quotes may hold commas, quotes and line breaks. */
function rowsOf(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') (field += '"'), i++
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') row.push(field), (field = '')
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field), rows.push(row), (row = []), (field = '')
    } else field += char
  }
  if (field || row.length) row.push(field), rows.push(row)
  return rows.filter((cells) => cells.some((each) => each.trim()))
}

/** Each row's answer from a checked sheet: true for yes, false for no, undefined when the row was left empty. */
export function readChecks(text: string): (boolean | undefined)[] {
  const [header, ...rows] = rowsOf(text)
  const column = header?.map((name) => name.trim().toLowerCase()).indexOf('same') ?? -1
  if (column < 0) throw new Error('The sheet has no "same" column')
  return rows.map((cells, i) => {
    const said = (cells[column] ?? '').trim().toLowerCase()
    if (said === '') return undefined
    if (said === 'yes' || said === 'y') return true
    if (said === 'no' || said === 'n') return false
    throw new Error(`Line ${i + 2} says "${cells[column]!.trim()}" where yes, no or nothing was expected`)
  })
}

/** How many answers were yes, and the share with its 95% Wilson interval. The share and interval are null when nothing was checked. */
export function scoreChecks(answers: readonly (boolean | undefined)[]) {
  const same = answers.filter((answer) => answer === true).length
  const different = answers.filter((answer) => answer === false).length
  const checked = same + different
  const unanswered = answers.length - checked
  if (checked === 0) return { checked, same, different, unanswered, share: null, low: null, high: null }
  const z = 1.959964
  const share = same / checked
  const middle = (share + (z * z) / (2 * checked)) / (1 + (z * z) / checked)
  const half = (z * Math.sqrt((share * (1 - share)) / checked + (z * z) / (4 * checked * checked))) / (1 + (z * z) / checked)
  return { checked, same, different, unanswered, share, low: Math.max(0, middle - half), high: Math.min(1, middle + half) }
}
