import type { Graph } from './graph.ts'
import { hashPhone, normalizePhone } from './identifiers.ts'
import type { Identifier, Outcome, Subject } from './types.ts'

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
  /** Records the outcome of a counted call. Defaults to `graph.outcome`; pass the outbox's `record` to send it too. */
  convert?: (outcome: Outcome) => Promise<unknown>
}

export interface RecordedCall {
  /** Who called: one subject per caller's number, or one per call when the number was hidden. */
  subject: Subject
  flags: CallFlag[]
  /** Whether it was counted as an outcome. */
  counted: boolean
  /** The visitor who tapped the number just before, when there was exactly one. The two are now linked. */
  visitor?: Subject
  /** The call had been recorded before, and nothing was written. */
  duplicate: boolean
}

const BUCKET = 5 * 60_000
/** Allowance for the provider's clock and ours disagreeing. */
const SLACK = 30_000
const TOLL_FREE = /^\+18(00|33|44|55|66|77|88)\d{7}$/
/** The digits a hidden caller is reported as by some carriers: "anonymous" on a keypad. */
const ANONYMOUS = '+266696687'

/**
 * The note left on a visitor who tapped a phone number. It is filed by the
 * five minutes it happened in, so a call can find recent taps without
 * reading every tap there ever was. A note links nothing.
 */
export function dialed(number: string, at: number, country?: string): Identifier {
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
  if (!Number.isFinite(call.at)) throw new TypeError(`Call "${call.id}" needs a time in epoch milliseconds`)
  if (typeof call.to !== 'string') throw new TypeError(`Call "${call.id}" needs the number that was rung`)
  const to = normalizePhone(call.to, options.country)
  const { id, at } = call

  let from: string | undefined
  try {
    from = typeof call.from === 'string' ? normalizePhone(call.from, options.country) : undefined
  } catch {}
  if (from === ANONYMOUS) from = undefined
  const tollFree = from !== undefined && TOLL_FREE.test(from)
  const subject = from ? `caller:${hashPhone(from)}` : `call:${id}`

  // The note is written last, so a call that was cut off half-recorded is recorded again in full.
  const note = `dialed:call-${id}`
  const [before] = await graph.holders([note])
  if (before) return { subject: before.subject, flags: [], counted: false, duplicate: true }

  const flags: CallFlag[] = []
  if (!from) flags.push('blocked')
  if (tollFree) flags.push('toll_free')
  const short = (call.duration ?? Infinity) < (options.minimumSeconds ?? 30)
  if (short) flags.push('short')
  if (from && (await graph.cluster(subject))) flags.push('repeat')

  // A toll-free number belongs to a switchboard, not a person, so it ties the call to nobody.
  const known = from && !tollFree ? from : undefined
  if (known) await graph.observe({ subject, identifiers: [`phone:${hashPhone(known)}`], at, event: 'call' })

  const window = options.clickWindow ?? 3 * 60_000
  const buckets: Identifier[] = []
  for (let bucket = Math.floor((at - window) / BUCKET); bucket <= Math.floor((at + SLACK) / BUCKET); bucket++) buckets.push(`dialed:${to}@${bucket}`)
  const taps = (await graph.holders(buckets)).filter((edge) => edge.last >= at - window && edge.first <= at + SLACK)
  const visitors = [...new Set(taps.map((edge) => edge.subject))]
  const visitor = visitors.length === 1 ? visitors[0] : undefined
  if (visitors.length > 1) flags.push('ambiguous')
  if (visitor) {
    const tie = `dial:${id}`
    await graph.observe([
      { subject, identifiers: [tie], at, event: 'call' },
      { subject: visitor, identifiers: [tie], at, event: 'call' },
    ])
  }

  // A visitor's own arrival says more than the number does, so the number's channel is only the fallback.
  const channel = Object.entries(options.numbers ?? {}).find(([number]) => normalizePhone(number, options.country) === to)?.[1]
  if (channel && !visitor) await graph.touch({ subject, at, medium: 'call', ...channel, landing: `tel:${to}` })

  if (!short) {
    const outcome: Outcome = { transactionId: `call:${id}`, subject, at, stage: options.stage ?? 'call', source: 'PHONE', ...(known && { phone: known }) }
    await (options.convert ?? graph.outcome)(outcome)
  }
  await graph.observe({ subject, identifiers: [note], at, event: 'call' })
  return { subject, flags, counted: !short, ...(visitor && { visitor }), duplicate: false }
}
