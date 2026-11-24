import type { Graph } from './graph.ts'
import { hashPhone, normalizePhone, phoneOfType } from './identifiers.ts'
import type { CallResult, Identifier, KeptCall, Outcome, Subject } from './types.ts'

/** One phone call to a number of yours, as your telephone provider reports it. */
export interface Call {
  /** The provider's id for the call. Recording it twice records it once. */
  id: string
  /** The caller's number. Leave it out, or pass whatever the provider sent, when the caller hid it. */
  from?: string
  /** The number that was rung. */
  to: string
  /** When the call began, in epoch milliseconds. */
  at: number
  /** How long it lasted, in seconds. A call nobody answered lasted 0. */
  duration?: number
  /** Who rang whom. Only calls to you are recorded; a call from you is refused. */
  direction?: 'inbound'
  /**
   * Whether a person spoke to the caller. Leave it out when that is not
   * known. A phone system that picks up has not answered, so it is never
   * worked out from how long the call lasted.
   */
  answered?: boolean
  /** The caller reached voicemail. */
  voicemail?: boolean
  /** How long the caller waited before someone answered or they gave up, in seconds. */
  waited?: number
}

/** Where a tracking number is published, so a call to it can be filed under that campaign. */
export interface Channel {
  source: string
  medium?: string
  campaign?: string
  campaignId?: string
}

/**
 * What was noticed about a call:
 * `blocked` the caller hid their number; `toll_free` the caller's number is
 * a toll-free line, which is a business or a machine, not a person;
 * `short` it ended before `minimumSeconds`; `repeat` this number has called
 * before; `ambiguous` more than one visitor tapped the number just before.
 */
export type CallFlag = 'blocked' | 'toll_free' | 'short' | 'repeat' | 'ambiguous'

export interface CallOptions {
  /** Your tracking numbers, each with the channel it is published on. Written any way a phone number is. */
  numbers?: Readonly<Record<string, Channel>>
  /** A call shorter than this is recorded but not counted as an outcome. Defaults to 30 seconds. */
  minimumSeconds?: number
  /** How long before a call a tap on its number may be, in milliseconds. Defaults to three minutes. */
  clickWindow?: number
  /** The step a counted call is recorded as. Defaults to `call`. */
  stage?: string
  /** The country code for numbers written without one. Defaults to 1. */
  country?: string
  /** Says what kind of line the caller's number is, so a throwaway number counts for less and a switchboard for nothing. */
  lineType?: (number: string) => Promise<{ type: string } | undefined>
    /**
   * `expected` when something reports how each call went to
   * `recordCallResult`. A call is then counted and sent only once a result
   * says a person answered. Without it, a call is counted as it is
   * recorded, and a result that says otherwise takes it back.
   */
  results?: 'expected'
  /** How long to wait for a result before a call reads as unknown, in milliseconds. Defaults to 30 minutes. A later result still settles it. */
  resultWait?: number
  /** Records the outcome of a counted call. Defaults to `graph.outcome`; pass the outbox's `record` to send it too. */
  convert?: (outcome: Outcome) => Promise<unknown>
  /** Keeps the outcome of a call whose result is awaited. Defaults to nothing; pass the outbox's `hold`. */
  hold?: (outcome: Outcome) => Promise<unknown>
  /** Counts the outcome of a call that was held or taken back. Defaults to `graph.outcome`; pass the outbox's `release`. */
  release?: (outcome: Outcome) => Promise<unknown>
  /** Takes back the outcome of a call that was not answered after all. Defaults to `graph.withdraw`; pass the outbox's `withdraw`. */
  withdraw?: (transactionId: string) => Promise<unknown>
  /** The clock, for tests. */
  now?: () => number
}

/**
 * How a call stands. `waiting` a result is expected and has not come;
 * `unknown` nothing says whether a person answered. `unknown` is never counted
 * where results are expected, and is counted by its length where they are not.
 */
export type CallState = 'answered' | 'missed' | 'voicemail' | 'waiting' | 'unknown'

/** How a kept call stands at a time. */
export function callState(call: KeptCall, at: number, options: Pick<CallOptions, 'results' | 'resultWait'> = {}): CallState {
  if (call.result?.answered !== undefined) return call.result.answered ? 'answered' : call.result.voicemail ? 'voicemail' : 'missed'
  const ends = call.at + (call.duration ?? 0) * 1000
  return options.results === 'expected' && at < ends + (options.resultWait ?? 30 * 60_000) ? 'waiting' : 'unknown'
}

export interface RecordedCall {
  /** Who called: one subject per caller's number, or one per call when the number was hidden. */
  subject: Subject
  flags: CallFlag[]
  /** Whether it was counted as an outcome. */
  counted: boolean
  /** How it stands: answered, missed, gone to voicemail, waiting for its result, or not known. */
  state: CallState
  /** The visitor who tapped the number just before, when there was exactly one. The two are now linked. */
  visitor?: Subject
  /** The call had been recorded before, and nothing was written. */
  duplicate: boolean
}

const BUCKET = 5 * 60_000
/** Allowance for the provider's clock and ours disagreeing. */
const SLACK = 30_000
const TOLL_FREE = /^\+18(00|33|44|55|66|77|88)\d{7}$/
/** What a hidden caller's number is reported as: the words anonymous, restricted, unavailable, blocked and unknown, spelled on a keypad. */
const HIDDEN = new Set(['+266696687', '+7378742833', '+86282452253', '+2562533', '+8656696'])

/**
 * The note left on a visitor who tapped a phone number. It is filed by the
 * five minutes it happened in, so a call can find recent taps without
 * reading every tap there ever was. A note links nothing.
 */
export function dialed(number: string, at: number, country?: string): Identifier {
  if (!Number.isSafeInteger(at)) throw new TypeError('A tap needs a time in whole epoch milliseconds')
  return `dialed:${normalizePhone(number, country)}@${Math.floor(at / BUCKET)}`
}

/**
 * Records a phone call. The caller becomes a subject carrying their phone
 * number, so an account that later gives the same number is tied to the
 * call. If exactly one visitor tapped the number on your site just before,
 * the call is tied to that visitor, and so to the ad click that brought them.
 * Otherwise the call is filed under the channel its tracking number is published on.
 */
export async function recordCall(graph: Graph, call: Call, options: CallOptions = {}): Promise<RecordedCall> {
  if (typeof call?.id !== 'string' || !/^[\w.-]{1,128}$/.test(call.id)) throw new TypeError('A call needs an id of letters, digits, dots, dashes or underscores')
  if (!Number.isSafeInteger(call.at)) throw new TypeError(`Call "${call.id}" needs a time in whole epoch milliseconds`)
  if (call.duration !== undefined && !(typeof call.duration === 'number' && Number.isFinite(call.duration) && call.duration >= 0)) throw new TypeError(`Call "${call.id}" needs its duration in seconds`)
  if (call.direction !== undefined && call.direction !== 'inbound') throw new TypeError(`Call "${call.id}" is not a call to you`)
  const result = resultIn(call, `Call "${call.id}"`)
  if (typeof call.to !== 'string') throw new TypeError(`Call "${call.id}" needs the number that was rung`)
  const to = normalizePhone(call.to, options.country)
  const { id, at } = call

  let from: string | undefined
  try {
    from = typeof call.from === 'string' ? normalizePhone(call.from, options.country) : undefined
  } catch {}
  if (from !== undefined && HIDDEN.has(from)) from = undefined
  const tollFree = from !== undefined && TOLL_FREE.test(from)
  const subject = from ? `caller:${hashPhone(from)}` : `call:${id}`

  // The note is written last, so a call that was cut off half-recorded is recorded again in full.
  const note = `dialed:call-${id}`
  const [before] = await graph.holders([note])
  if (before) {
    // Reported again with a result it did not have before, the call is settled by it.
    const settled = result && (await tell(graph, id, result, options))
    const kept = await graph.keptCall(id)
    return { subject: before.subject, flags: [], counted: settled?.counted ?? false, state: kept ? callState(kept, (options.now ?? Date.now)(), options) : 'unknown', duplicate: true }
  }
  if (result) await keepResult(graph, id, result)

  const flags: CallFlag[] = []
  if (!from) flags.push('blocked')
  if (tollFree) flags.push('toll_free')
  const short = tooShort(call, options)
  if (short) flags.push('short')
  if (from && (await graph.cluster(subject))) flags.push('repeat')

  // A toll-free number belongs to a switchboard, not a person, so it ties the call to nobody.
  const known = from && !tollFree ? from : undefined
  // With a line check, a number from an internet calling app is written as the weaker kind. A check that fails changes nothing.
  const line = known && options.lineType ? await options.lineType(known).catch(() => undefined) : undefined
  const phone = known && phoneOfType(known, line?.type)
  if (phone) await graph.observe({ subject, identifiers: [phone], at, event: 'call' })

  const window = options.clickWindow ?? 3 * 60_000
  const buckets: Identifier[] = []
  for (let bucket = Math.floor((at - window) / BUCKET); bucket <= Math.floor((at + SLACK) / BUCKET); bucket++) buckets.push(`dialed:${to}@${bucket}`)
  const taps = (await graph.holders(buckets)).filter((edge) => edge.last >= at - window && edge.first <= at + SLACK)
  const tapped = [...new Set(taps.map((edge) => edge.subject))]
  // One visitor, one caller. A visitor already tied to a different caller by an earlier call is passed over,
  // so a browser cannot collect call after call by tapping again. The same caller ringing back still counts.
  // A visitor a reviewer has kept apart from this caller is passed over too.
  const apart = new Set(await graph.separations(subject))
  const visitors: Subject[] = []
  for (const candidate of tapped) {
    if (apart.has(candidate)) continue
    const earlier = (await graph.links(candidate)).filter((link) => link.reasons.some((reason) => reason.identifier.startsWith('dial:')))
    if (earlier.every((link) => link.subject === subject)) visitors.push(candidate)
  }
  const visitor = visitors.length === 1 ? visitors[0] : undefined
  if (visitors.length > 1) flags.push('ambiguous')
  if (visitor) {
    const tie = `dial:${id}`
    await graph.observe([
      { subject, identifiers: [tie], at, event: 'call' },
      { subject: visitor, identifiers: [tie], at, event: 'call' },
    ])
  }

  // The outcome comes before the touch: if recording it fails, the call is reported again and nothing has been written twice.
  // What would be sent is held before the call is kept, while the number is at hand: a result that finds the call then finds that too.
  if (!short) await options.hold?.(outcomeOf({ id, subject, at }, options, known))
  // The call is kept before its result is looked for, and a result is kept before its call is, so whichever comes second settles it.
  await graph.keepCall({ id, subject, at, to, flags, ...(call.duration !== undefined && { duration: call.duration }), ...(visitor && { visitor }) })
  const counted = await settle(graph, id, options, known ?? '')

  // A visitor's own arrival says more than the number does, so the number's channel is only the fallback.
  const channel = Object.entries(options.numbers ?? {}).find(([number]) => numberOrSelf(number, options.country) === to)?.[1]
  if (channel && !visitor) {
    const { source, medium = 'call', campaign, campaignId } = channel
    await graph.touch({ subject, at, source, medium, ...(campaign && { campaign }), ...(campaignId && { campaignId }), landing: `tel:${to}` })
  }
  await graph.observe({ subject, identifiers: [note], at, event: 'call' })
  const kept = await graph.keptCall(id)
  return { subject, flags, counted, state: callState(kept!, (options.now ?? Date.now)(), options), ...(visitor && { visitor }), duplicate: false }
}

/** The result a call or a report of one carries, checked. Undefined when it says nothing of how the call went. */
function resultIn(given: { answered?: unknown; voicemail?: unknown; waited?: unknown }, what: string): Omit<CallResult, 'recorded'> | undefined {
  const { answered, voicemail, waited } = given
  for (const [name, value] of [['answered', answered], ['voicemail', voicemail]] as const) if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${what} needs ${name} as true or false`)
  if (waited !== undefined && !(typeof waited === 'number' && Number.isFinite(waited) && waited >= 0)) throw new TypeError(`${what} needs its wait in seconds`)
  if (answered === true && voicemail === true) throw new TypeError(`${what} cannot be answered by a person and go to voicemail`)
  // Voicemail is not a person, so it says nobody answered.
  const heard = voicemail === true ? false : (answered as boolean | undefined)
  if (heard === undefined && voicemail === undefined && waited === undefined) return undefined
  return { ...(heard !== undefined && { answered: heard }), ...(voicemail !== undefined && { voicemail: voicemail as boolean }), ...(waited !== undefined && { waited: waited as number }) }
}

/** Keeps a result. What it does not say stays as it was said before. */
async function keepResult(graph: Graph, id: string, result: Omit<CallResult, 'recorded'>): Promise<void> {
  const { recorded: _, ...before } = (await graph.callResult(id)) ?? { recorded: 0 }
  // A person who answered after all did not go to voicemail.
  if (result.answered) delete before.voicemail
  await graph.keepCallResult(id, { ...before, ...result })
}

/** Whether a call ended too soon to count. */
function tooShort(call: { duration?: number }, options: CallOptions): boolean {
  return (call.duration ?? Infinity) < (options.minimumSeconds ?? 30)
}

const outcomeOf = (call: { id: string; subject: Subject; at: number }, options: CallOptions, phone?: string): Outcome => ({
  transactionId: `call:${call.id}`,
  subject: call.subject,
  at: call.at,
  stage: options.stage ?? 'call',
  source: 'PHONE',
  ...(phone && { phone }),
})

/**
 * Brings the outcome of a kept call in line with what is known about it: a
 * call counts when it was long enough and either a person answered, or no
 * result is expected and none says otherwise. Safe to run again, and from
 * two places at once. `phone` is given only while the call is being
 * recorded. Resolves to whether the call is counted.
 */
async function settle(graph: Graph, id: string, options: CallOptions, phone?: string): Promise<boolean> {
  for (;;) {
    const call = await graph.keptCall(id)
    if (!call) return false
    const answered = call.result?.answered
    const counts = !tooShort(call, options) && (answered ?? options.results !== 'expected')
    const outcome = outcomeOf(call, options, phone)
    // Each of these does nothing where it is already done, so one that was cut off half way is finished by the next.
    if (counts && options.release) await options.release(outcome)
    // Without one, a result has no number to give, so it counts a call only where nothing has.
    else if (counts && (phone !== undefined || !(await graph.outcomeOf(outcome.transactionId)))) await (options.convert ?? graph.outcome)(outcome)
    else if (answered === false) await (options.withdraw ?? graph.withdraw)(outcome.transactionId)
    // A result that came meanwhile is settled too.
    if ((await graph.callResult(id))?.answered === answered) return counts
  }
}

/** Keeps a result and settles its call by it. Resolves to undefined while the call itself has not been recorded. */
async function tell(graph: Graph, id: string, result: Omit<CallResult, 'recorded'>, options: CallOptions): Promise<{ state: CallState; counted: boolean } | undefined> {
  await keepResult(graph, id, result)
  const counted = await settle(graph, id, options)
  const kept = await graph.keptCall(id)
  return kept && { state: callState(kept, (options.now ?? Date.now)(), options), counted }
}

/**
 * Records how a call went, from whoever runs the phones. It may arrive
 * before the call or after it, and as often as it likes: the last report
 * stands. Resolves to how the call stands now, or undefined while the call
 * itself has not been recorded.
 */
export async function recordCallResult(graph: Graph, report: { id: string; answered: boolean; voicemail?: boolean; waited?: number }, options: CallOptions = {}): Promise<{ state: CallState; counted: boolean } | undefined> {
  if (typeof report?.id !== 'string' || !/^[\w.-]{1,128}$/.test(report.id)) throw new TypeError('A call result needs the id of its call')
  const result = resultIn(report, `The result of call "${report.id}"`)
  if (result?.answered === undefined) throw new TypeError(`The result of call "${report.id}" needs answered, true or false`)
  return tell(graph, report.id, result, options)
}

/** A phone number in the form calls arrive in, or as written when it is not a phone number. */
export function numberOrSelf(number: string, country?: string): string {
  try {
    return normalizePhone(number, country)
  } catch {
    return number
  }
}
