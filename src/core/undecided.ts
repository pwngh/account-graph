import { malformed } from '../contract/fault.ts'
import type { Pair, Subject } from '../contract/types.ts'
import { UNSTORABLE } from './identifiers.ts'
import { byKey } from './said.ts'
import type { Tx } from './store.ts'

export const RECENT_SIGHTINGS = 10_000

export interface UndecidedOptions {
  limit?: number
  sightings?: number
  full?: boolean
  cursor?: string
}

export interface Undecided {
  pairs: Pair[]
  /** Counts for the window examined on this request. */
  total: number
  seen: number
  window: { kind: 'recent'; sightings: number; oldest: number | null; older: boolean } | { kind: 'full'; first: Subject | null; last: Subject | null }
  more: boolean
  next: string | null
}

type Rank = Pick<Pair, 'score' | 'a' | 'b'>
type Position = ({ mode: 'recent'; sightings: number | null } & Rank) | { mode: 'full'; a: Subject; b: Subject | null }

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const rank = (x: Rank, y: Rank) => y.score - x.score || compare(x.a, y.a) || compare(x.b, y.b)
const encode = (position: Position) => Buffer.from(JSON.stringify(position)).toString('base64url')
const subject = (value: unknown): value is Subject => typeof value === 'string' && value.length > 0 && !UNSTORABLE.test(value)
const positive = (value: number) => value === Infinity || (Number.isSafeInteger(value) && value >= 1)

function decode(cursor: string): Position {
  const invalid = malformed('Undecided requires a cursor returned by a previous page')
  if (typeof cursor !== 'string' || !/^[\w-]+$/.test(cursor)) throw invalid
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    throw invalid
  }
  if (!value || typeof value !== 'object') throw invalid
  const { mode, a, b, sightings, score } = value as Partial<Record<'mode' | 'a' | 'b' | 'sightings' | 'score', unknown>>
  if (mode === 'full' && subject(a) && (b === null || subject(b))) return { mode, a, b }
  if (mode === 'recent' && subject(a) && subject(b) && (sightings === null || (typeof sightings === 'number' && Number.isSafeInteger(sightings) && sightings > 0)) && typeof score === 'number' && Number.isFinite(score)) return { mode, a, b, sightings, score }
  throw invalid
}

export async function undecided(tx: Tx, { limit = 50, sightings: requested, full, cursor }: UndecidedOptions, offered: (subjects: Subject[]) => Promise<Pair[]>): Promise<Undecided> {
  const position = cursor === undefined ? undefined : decode(cursor)
  const previous = position?.mode === 'recent' ? position.sightings ?? Infinity : undefined
  const sightings = requested === undefined ? previous ?? RECENT_SIGHTINGS : requested
  if (!positive(limit) || !positive(sightings)) throw malformed('Undecided requires positive limits for pairs and sightings')
  if (full !== undefined && (typeof full !== 'boolean' || (position && full !== (position.mode === 'full')))) throw malformed('Full must agree with the review cursor')
  if (full || position?.mode === 'full') {
    const { a = null, b = null } = position?.mode === 'full' ? position : {}
    const pageSize = 100
    const found = await tx.subjectPage(a, b !== null, pageSize + 1)
    const subjects = found.slice(0, pageSize)
    const owners = new Set(subjects)
    // Only the page containing a pair's first subject offers it, even if the other subject is many pages away.
    const open = (await offered(subjects)).filter(pair => owners.has(pair.a))
    open.sort((x, y) => byKey(x.a, y.a) || byKey(x.b, y.b))
    const rest = b !== null ? open.filter(pair => pair.a !== a || byKey(pair.b, b) > 0) : open
    const pairs = rest.slice(0, limit)
    const end = pairs.at(-1)
    const last = subjects.at(-1) ?? null
    let next = null
    if (end && rest.length > pairs.length) next = encode({ mode: 'full', a: end.a, b: end.b })
    else if (last && found.length > subjects.length) next = encode({ mode: 'full', a: last, b: null })
    return { pairs, total: open.length, seen: subjects.length, window: { kind: 'full', first: subjects[0] ?? null, last }, more: next !== null, next }
  }
  if (previous !== undefined && previous !== sightings) throw malformed('Use the same sighting limit as the previous review page')
  const { subjects, count, oldest, older } = await tx.latelySeen(sightings)
  const open = (await offered(subjects)).sort(rank)
  const rest = position ? open.filter(pair => rank(pair, position) > 0) : open
  const pairs = rest.slice(0, limit)
  const last = pairs.at(-1)
  const next = last && rest.length > pairs.length ? encode({ mode: 'recent', sightings: Number.isFinite(sightings) ? sightings : null, score: last.score, a: last.a, b: last.b }) : null
  return { pairs, total: open.length, seen: subjects.length, window: { kind: 'recent', sightings: count, oldest, older }, more: next !== null, next }
}
