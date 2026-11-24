import { callState, followUp } from './calls.ts'
import type { CallOptions, CallState } from './calls.ts'
import type { Hours } from './hours.ts'
import type { KeptCall, Subject } from './types.ts'

/** How many calls of each kind. `returned` counts the missed and voicemail calls whose caller you reached. */
export interface CallCounts extends Record<CallState, number> {
  calls: number
  returned: number
  /** Of those, how many a system of yours reported, and no call shows. */
  told: number
  /** Missed and voicemail calls whose caller rang again and got through. */
  triedAgain: number
  /** Missed and voicemail calls from a hidden number, which cannot be returned. */
  hidden: number
}

export interface CallSummary {
  total: CallCounts
  /** Of them, those that began while you were closed. Null when your hours are not known. */
  closed: CallCounts | null
  /** Counts by the hour a call began and the day of the week, Monday 1 to Sunday 7, in the time zone asked for. Hours with no calls are left out. */
  cells: (CallCounts & { weekday: number; hour: number })[]
  /** How calls to you were placed: each call is in exactly one of the first three. */
  coverage: {
    /** Tied to the one visitor who tapped the number. */
    visitor: number
    /** Filed under the channel its number is published on, and nothing more. */
    channel: number
    /** Neither. */
    neither: number
    /** With no result, whatever the rest: waiting or unknown. */
    noResult: number
  }
  /** Half of the returned calls were returned within this many milliseconds. Null when none was. */
  returnedWithin: number | null
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const none = (): CallCounts => ({ calls: 0, answered: 0, missed: 0, voicemail: 0, waiting: 0, unknown: 0, returned: 0, told: 0, triedAgain: 0, hidden: 0 })

/**
 * Counts calls to you. `calls` are those of the period, `later` every call
 * of the same subjects, which says what became of the missed ones, and
 * `filed` the calls that were filed under a channel, by id. Pure.
 */
export function summarizeCalls(
  calls: readonly KeptCall[],
  later: readonly KeptCall[],
  filed: ReadonlySet<string>,
  at: number,
  timeZone = 'UTC',
  options: Pick<CallOptions, 'results' | 'resultWait'> & { hours?: Hours } = {},
): CallSummary {
  const bySubject = new Map<Subject, KeptCall[]>()
  for (const call of later) bySubject.set(call.subject, [...(bySubject.get(call.subject) ?? []), call])
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: 'numeric' })
  const total = none()
  const closed = options.hours ? none() : null
  const cells = new Map<string, CallCounts & { weekday: number; hour: number }>()
  const coverage = { visitor: 0, channel: 0, neither: 0, noResult: 0 }
  const delays: number[] = []
  for (const call of calls) {
    if (call.direction !== 'inbound') continue
    const parts = clock.formatToParts(call.at)
    const part = (type: string) => parts.find((each) => each.type === type)!.value
    const [weekday, hour] = [DAYS.indexOf(part('weekday')) + 1, Number(part('hour'))]
    const key = `${weekday} ${hour}`
    const cell = cells.get(key) ?? { weekday, hour, ...none() }
    cells.set(key, cell)
    const state = callState(call, at, options)
    const became = state === 'missed' || state === 'voicemail' ? followUp(call, bySubject.get(call.subject) ?? []) : undefined
    if (became?.state === 'returned') delays.push(became.delay!)
    for (const counts of [total, cell, ...(closed && !options.hours!.isOpen(call.at) ? [closed] : [])]) {
      counts.calls += 1
      counts[state] += 1
      if (became?.state === 'returned') counts.returned += 1
      if (became?.told) counts.told += 1
      if (became?.state === 'tried again') counts.triedAgain += 1
      if (became?.state === 'hidden') counts.hidden += 1
    }
    if (call.visitor) coverage.visitor += 1
    else if (filed.has(call.id)) coverage.channel += 1
    else coverage.neither += 1
    if (state === 'waiting' || state === 'unknown') coverage.noResult += 1
  }
  delays.sort((x, y) => x - y)
  return {
    total,
    closed,
    cells: [...cells.values()].sort((x, y) => x.weekday - y.weekday || x.hour - y.hour),
    coverage,
    returnedWithin: delays.length > 0 ? delays[Math.ceil(delays.length / 2) - 1]! : null,
  }
}
