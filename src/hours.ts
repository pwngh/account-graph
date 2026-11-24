import { ahead, dayIn, dayStart, nextDay } from './report.ts'

/**
 * When you are open: for each day of the week the spans somebody answers,
 * written `09:00-17:00`, and the days you are closed whatever the week says.
 * A day left out is closed. A span that ends before it begins runs past
 * midnight, and belongs to the day it begins on.
 */
export interface OpenHours {
  mon?: readonly string[]
  tue?: readonly string[]
  wed?: readonly string[]
  thu?: readonly string[]
  fri?: readonly string[]
  sat?: readonly string[]
  sun?: readonly string[]
  /** Days written `YYYY-MM-DD`. */
  holidays?: readonly string[]
  /** The zone they are kept in. Defaults to the server's. */
  timeZone?: string
}

/** Time as it passes while you are open. */
export interface Hours {
  isOpen(at: number): boolean
  /** The latest moment since when you have been open for that long, in milliseconds. `-Infinity` when that is more than three years back. */
  before(at: number, open: number): number
}

const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
const SPAN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/
const MINUTE = 60_000
const DAY = 1440

/** A span in minutes of its day, or undefined when it is not one. One past midnight ends after 1440. */
function span(text: unknown): [number, number] | undefined {
  const [, ...parts] = (typeof text === 'string' && SPAN.exec(text)) || []
  if (parts.length === 0) return undefined
  const [fromHour, from, toHour, to] = parts.map(Number) as [number, number, number, number]
  const start = fromHour * 60 + from
  const end = toHour * 60 + to
  if (end > DAY || end === start) return undefined
  return [start, end > start ? end : end + DAY]
}

/** What is wrong with opening hours read from a setting, one line each. */
export function hoursProblems(given: unknown): string[] {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return ['must be an object, such as {"mon":["09:00-17:00"]}']
  const wrong: string[] = []
  let spans = 0
  for (const [name, value] of Object.entries(given)) {
    if (name === 'timeZone') {
      try {
        dayIn(0, value)
        if (typeof value !== 'string') throw new TypeError()
      } catch {
        wrong.push('"timeZone" must be a time zone, such as America/New_York')
      }
    } else if (name === 'holidays') {
      for (const day of Array.isArray(value) ? value : [value]) {
        try {
          dayStart(day)
        } catch {
          wrong.push(`"holidays" has "${day}", which is not a day written YYYY-MM-DD`)
        }
      }
    } else if (!(WEEK as readonly string[]).includes(name)) wrong.push(`"${name}" is not a day of the week, "holidays" or "timeZone"`)
    else if (!Array.isArray(value)) wrong.push(`"${name}" must be a list, such as ["09:00-17:00"]`)
    else {
      const read = value.map(span)
      for (const [i, each] of read.entries()) if (!each) wrong.push(`"${name}" has "${value[i]}", which is not written 09:00-17:00`)
      const sorted = read.filter((each) => each !== undefined).sort((x, y) => x[0] - y[0])
      spans += sorted.length
      for (const [i, each] of sorted.entries()) if (i > 0 && each[0] < sorted[i - 1]![1]) wrong.push(`"${name}" has spans that overlap`)
    }
  }
  if (wrong.length === 0 && spans === 0) wrong.push('names no time you are open')
  return wrong
}

/** Reads opening hours. Check them with `hoursProblems` first. */
export function createHours(given: OpenHours, timeZone = 'UTC'): Hours {
  const zone = given.timeZone ?? timeZone
  const closed = new Set(given.holidays)
  const days = new Map<string, readonly (readonly [number, number])[]>()

  /** The spans that begin on a day, as instants, the last first. */
  function spansOf(day: string): readonly (readonly [number, number])[] {
    const known = days.get(day)
    if (known) return known
    const midnight = dayStart(day, zone)
    const offset = ahead(midnight, zone)
    // Where clocks change on the day, a time of day is not midnight and so many minutes.
    const instant = (minutes: number) => {
      const guess = midnight + minutes * MINUTE
      return guess - (ahead(guess, zone) - offset)
    }
    const spans = closed.has(day) ? [] : (given[WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]!] ?? []).map((text) => span(text)!)
    const read = spans.map(([start, end]) => [instant(start), instant(end)] as const).sort((x, y) => y[0] - x[0])
    if (days.size >= 5_000) days.clear()
    days.set(day, read)
    return read
  }
  const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

  return {
    isOpen(at) {
      const day = dayIn(at, zone)
      return [...spansOf(day), ...spansOf(dayBefore(day))].some(([start, end]) => at >= start && at < end)
    },
    before(at, open) {
      if (open <= 0) return at
      let left = open
      // A span that runs past midnight may meet the next day's, and no moment counts twice.
      let until = at
      let day = dayIn(at, zone)
      for (let read = 0; read < 1_100; read++, day = dayBefore(day)) {
        for (const [start, end] of spansOf(day)) {
          const counted = Math.min(end, until) - start
          if (counted <= 0) continue
          if (counted >= left) return Math.min(end, until) - left
          left -= counted
          until = start
        }
      }
      return -Infinity
    },
  }
}

/** The latest moment that is so long ago: on the clock, or counting only the time you were open. */
export const longAgo = (hours: Hours | undefined, at: number, ms: number): number => (hours ? hours.before(at, ms) : at - ms)
