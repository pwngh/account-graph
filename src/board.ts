import { followUp } from './calls.ts'
import type { Counted, KeptCall, Subject } from './types.ts'

/** A step as the board needs it: its name, and how long a person may stand at it before they have waited too long. */
export interface BoardStep {
  name: string
  /** In milliseconds. Left out: nobody at this step has waited too long. */
  wait?: number
}

/** One person, with everything that places them. */
export interface BoardPerson {
  outcomes: readonly Counted[]
  /** Their calls to and from you. */
  calls: readonly KeptCall[]
}

export interface BoardPlace {
  /** The subject the place rests on: whose step it is, or who called. */
  subject: Subject
  /** Since when they have been here: when they first reached the step, or their oldest missed call began. */
  at: number
  late: boolean
  /** The furthest step they reached, or null when they reached none you named. */
  step: string | null
  /** The newest outcome of that step, whose value is what it is worth now. */
  outcome?: Counted
  /** Their newest call. */
  call?: KeptCall
}

export interface BoardColumn<Row = BoardPlace> {
  /** The step, or null for missed and not returned. */
  step: string | null
  /** How long is too long, in milliseconds. Null when no limit is set. */
  wait: number | null
  people: number
  /** Of them, who came here today, and who has waited longer than `wait`. Null when no limit is set. */
  fresh: number
  late: number | null
  /** Who left today: their call was returned or they rang again and got through, or they reached a further step. Null for the last step, which leads nowhere. */
  done: number | null
  /** Who has been here longest, first. */
  rows: Row[]
}

/**
 * Puts each person in one column. Whoever has a missed call nobody returned is
 * in the first, unless it hid its number and so cannot be returned; everybody else is at the furthest step they ever reached, in
 * the order the steps are given. Pure, and does not depend on the order of
 * `people`. `unplaced` counts those with no open miss and no step you named.
 */
export function board(
  people: readonly BoardPerson[],
  options: { steps: readonly BoardStep[]; at: number; today: number; returnWait?: number },
): { columns: BoardColumn[]; unplaced: number } {
  const { steps, at, today, returnWait } = options
  const rank = new Map(steps.map((step, i) => [step.name, i]))
  const column = (step: string | null, wait: number | undefined, last: boolean): BoardColumn => ({ step, wait: wait ?? null, people: 0, fresh: 0, late: wait === undefined ? null : 0, done: last ? null : 0, rows: [] })
  const missed = column(null, returnWait, false)
  const columns = steps.map(({ name, wait }, i) => column(name, wait, i === steps.length - 1))
  let unplaced = 0

  for (const person of people) {
    const outcomes = person.outcomes.filter((outcome) => outcome.at <= at)
    const calls = person.calls.filter((call) => call.at <= at).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
    const call = calls.at(-1)
    // The steps in the order they were reached. Going back to an earlier one leaves nothing.
    const reached = outcomes.filter((outcome) => rank.has(outcome.stage)).sort((x, y) => x.at - y.at || rank.get(x.stage)! - rank.get(y.stage)! || (x.transactionId < y.transactionId ? -1 : 1))
    let furthest = -1
    let since = 0
    for (const outcome of reached) {
      const to = rank.get(outcome.stage)!
      if (to <= furthest) continue
      if (furthest >= 0 && outcome.at >= today) columns[furthest]!.done! += 1
      furthest = to
      since = outcome.at
    }
    const step = furthest < 0 ? null : steps[furthest]!.name
    const outcome = reached.filter((each) => each.stage === step).at(-1)

    // Whichever of their numbers a person is reached on, they are reached. A hidden number stays nobody's.
    const own = calls.map((each) => (each.subject === `call:${each.id}` ? each : { ...each, subject: 'person' }))
    const misses = own.flatMap((each, i) => (each.direction === 'inbound' && each.result?.answered === false ? [{ miss: calls[i]!, after: followUp(each, own) }] : []))
    const open = misses.filter(({ after }) => after.state === 'open').map(({ miss }) => miss)
    if (misses.some(({ miss, after }) => after.delay !== undefined && miss.at + after.delay >= today)) missed.done! += 1

    const here = open.length > 0 ? missed : furthest >= 0 ? columns[furthest]! : undefined
    if (!here) {
      if (outcomes.length > 0) unplaced += 1
      continue
    }
    const began = open[0]?.at ?? since
    const late = here.wait !== null && at - began > here.wait
    here.people += 1
    here.fresh += Number(began >= today)
    if (late) here.late! += 1
    here.rows.push({ subject: open[0]?.subject ?? outcome!.subject, at: began, late, step, ...(outcome && { outcome }), ...(call && { call }) })
  }
  for (const { rows } of [missed, ...columns]) rows.sort((x, y) => x.at - y.at || (x.subject < y.subject ? -1 : 1))
  return { columns: [missed, ...columns], unplaced }
}
