import type { Followed, FollowedGroup, FollowedRow } from '../contract/types.ts'
import { stands } from './calls.ts'
import type { KeptCall } from '../contract/types.ts'

/** One person who called, with everything that counts about them. */
export interface Caller {
  /** Their calls to you in the period, oldest first. */
  called: readonly KeptCall[]
  /** Every call to and from them, whenever. */
  calls: readonly KeptCall[]
  /** When they reached the step, in epoch milliseconds. */
  reached: readonly number[]
}

export interface FollowedOptions {
  step: string
  /** Within how many days of the start. */
  days: number
  at: number
  /** The fewest people a row may have. Defaults to 20. */
  least?: number
}

const DAY = 86_400_000
/** How long after a miss the clock starts, whether or not anyone rang back. */
const LANDMARK = DAY
const MINUTE = 60
/** Talk time in bands, in seconds, so one long call does not stand for the rest. */
const BANDS: readonly [number, string][] = [[MINUTE, 'under 1 minute'], [5 * MINUTE, '1 to 5 minutes'], [15 * MINUTE, '5 to 15 minutes'], [Infinity, '15 minutes or more']]
const ORDER = [...BANDS.map(([, name]) => name), 'answered', 'missed', 'voicemail', 'returned within a day', 'not returned within a day']
const NOT_SET = '(not set)'

/** How long someone talked: the call without the wait. Undefined when either was not reported, because neither says it alone. */
const talk = (call: KeptCall) => (call.duration === undefined || call.result?.waited === undefined ? undefined : Math.max(0, call.duration - call.result.waited))
/** When a person was reached on a call: after the wait, where that is known. */
const connected = (call: KeptCall) => call.at + (call.result?.waited ?? 0) * 1000

/**
 * Counts, among people who called, how many reached a step within some days.
 *
 * For what a call was like (how long, answered or not, in what language) the
 * clock starts when the person's first call in the period ended, and whoever
 * had already reached the step is left out.
 *
 * For whether a missed call was returned it starts a day after the miss, the
 * landmark, whether or not anyone rang back. Whoever had reached the step or
 * got through by themselves before then is left out. Without that, people
 * who are already signing up get called, and the call looks like the cause.
 * Pure, and the answer does not depend on the order of its input.
 */
export function followed(callers: readonly Caller[], { step, days, at, least = 20 }: FollowedOptions): Followed {
  const counts = new Map<FollowedGroup['by'], Map<string, { people: number; reached: number }>>()
  const excluded = { first: { already: 0, running: 0 }, returned: { already: 0, running: 0, through: 0 } }
  const add = (by: FollowedGroup['by'], name: string, reached: boolean) => {
    const rows = counts.get(by) ?? new Map()
    counts.set(by, rows)
    const row = rows.get(name) ?? { people: 0, reached: 0 }
    rows.set(name, { people: row.people + 1, reached: row.reached + Number(reached) })
  }
  /** Whether the step was reached once the clock had started, or why the person says nothing. */
  const outcome = (caller: Caller, start: number): boolean | 'already' | 'running' => {
    if (caller.reached.some((time) => time <= start)) return 'already'
    if (start + days * DAY > at) return 'running'
    return caller.reached.some((time) => time <= start + days * DAY)
  }

  for (const caller of callers) {
    const calls = caller.called.filter((call) => call.direction === 'inbound').sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
    const [first] = calls
    if (!first) continue
    const result = outcome(caller, first.at + (first.duration ?? 0) * 1000)
    if (typeof result === 'string') excluded.first[result] += 1
    else {
      const answer = first.result?.answered === undefined ? NOT_SET : first.result.answered ? 'answered' : first.result.voicemail ? 'voicemail' : 'missed'
      add('answer', answer, result)
      add('language', first.tags?.language ?? NOT_SET, result)
      // Nobody talked on a call nobody answered, and how long a call with no result was talked on is not known.
      if (answer === 'answered') {
        const seconds = talk(first)
        add('talk', seconds === undefined ? NOT_SET : BANDS.find(([under]) => seconds < under)![1], result)
      }
    }

    const miss = calls.find((call) => call.result?.answered === false && call.subject !== `call:${call.id}`)
    if (!miss) continue
    const start = miss.at + LANDMARK
    const since = caller.calls.filter((call) => call.at > miss.at && call.result?.answered && connected(call) <= start)
    const told = caller.calls.some((call) => stands(call) && call.result!.returned! > miss.at && call.result!.returned! <= start)
    if (since.some((call) => call.direction === 'inbound')) {
      excluded.returned.through += 1
      continue
    }
    const after = outcome(caller, start)
    if (typeof after === 'string') excluded.returned[after] += 1
    else add('returned', since.length > 0 || told ? 'returned within a day' : 'not returned within a day', after)
  }

  const rank = (name: string) => (name === NOT_SET ? '~' : ORDER.includes(name) ? String(ORDER.indexOf(name)).padStart(2, '0') : name)
  const groups = (['answer', 'talk', 'language', 'returned'] as const).map((by): FollowedGroup => {
    const rows = [...(counts.get(by) ?? [])].sort(([x], [y]) => (rank(x) < rank(y) ? -1 : 1))
    const shown = rows.filter(([, { people }]) => people >= least)
    return {
      by,
      rows: shown.map(([name, { people, reached }]) => ({ name, people, reached, share: Math.round((reached / people) * 1e4) / 1e4 })),
      suppressed: rows.reduce((sum, [, { people }]) => sum + people, 0) - shown.reduce((sum, [, { people }]) => sum + people, 0),
    }
  })
  return { step, days, least, groups, excluded }
}

export type { Followed, FollowedGroup, FollowedRow }
