import type { CallState } from '../contract/types.ts'
import { malformed, refused } from '../contract/fault.ts'
import type { Graph } from './graph.ts'
import { hashPhone, normalizePhone, phoneOfType } from './identifiers.ts'
import { texasArea } from './lookups.ts'
import { checkTags } from './tags.ts'
import { asks, namedBy, replyTo } from './texts.ts'
import type { AttributedTouch, CallResult, CallTime, Candidate, FollowUp, Identifier, KeptCall, NotLead, Outcome, Subject, Touch } from '../contract/types.ts'

/** One phone call to a number of yours, or from one, as your telephone provider reports it. */
export interface Call {
  /** The provider's id for the call. Recording it twice records it once. */
  id: string
  /** Who rang: the caller's number, or on an outbound call yours. Leave it out, or pass whatever the provider sent, when a caller hid it. */
  from?: string
  /** The number that was rung: yours, or on an outbound call theirs. */
  to: string
  /** When the call began, in epoch milliseconds. */
  at: number
  /** How long it lasted, in seconds. A call nobody answered lasted 0. */
  duration?: number
  /**
   * `inbound`, which is the default, or `outbound` for a call you placed.
   * An outbound call is never an outcome, and ties nobody to anything: it
   * says whether a missed caller was rung back.
   */
  direction?: 'inbound' | 'outbound'
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
  /**
   * The code the caller read out or entered, from the page they saw. One that names exactly one visitor says whose call it is,
   * in place of the number they were shown or a tap. Codes are given to pages only where text codes are on. Never kept.
   */
  code?: string
  /** Facts about the call, such as the language chosen at the prompt, carried on to its outcome. */
  tags?: Record<string, string>
}

/** Where a tracking number is published, so a call to it can be filed under that campaign. */
export interface Channel {
  source: string
  medium?: string
  campaign?: string
  campaignId?: string
  /** What the number stands for: the office or the language it is published in. Kept on the arrival a call to it is filed under. */
  tags?: Record<string, string>
}

/**
 * What was noticed about a call:
 * `blocked` the caller hid their number; `toll_free` the caller's number is
 * a toll-free line, which is a business or a machine, not a person;
 * `short` it ended before `minimumSeconds`; `repeat` this number has called
 * before; `ambiguous` more than one visitor tapped the number just before;
 * `pool` it was tied to the visitor the number was shown to;
 * `code` it was tied to the visitor its code names; `taken` its code names a
 * visitor already someone else's, or kept apart from this caller, so it is
 * tied to nobody.
 */
export type CallFlag = 'blocked' | 'toll_free' | 'short' | 'repeat' | 'ambiguous' | 'pool' | 'code' | 'taken' | 'left_out'

export interface CallOptions {
  /** Your tracking numbers, each with the channel it is published on. Written any way a phone number is. */
  numbers?: Readonly<Record<string, Channel>>
  /** Numbers of your own people and test phones. A call from one, or one you placed to it, is not recorded at all. Written any way a phone number is. */
  exclude?: readonly string[]
  /** A call shorter than this is recorded but not counted as an outcome. Defaults to 30 seconds. */
  minimumSeconds?: number
  /** How long before a call a tap on its number may be, in milliseconds. Defaults to three minutes. */
  clickWindow?: number
  /** How long a code names the visitor it was given to, in milliseconds. Defaults to 30 days. */
  codeLife?: number
  /** Numbers shown to one visitor at a time, and how long after a visitor's turn a call still counts as theirs when nobody has had the number since, in milliseconds. */
  pool?: { numbers: readonly string[]; grace: number; requireTapAfterReassignment?: boolean }
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
  /** Counts a staff-owned call locally, with the configured stage value. */
  count?: (outcome: Outcome) => Promise<unknown>
  convert?: (outcome: Outcome) => Promise<unknown>
  /** Keeps the outcome of a call whose result is awaited. Defaults to nothing; pass the outbox's `hold`. */
  hold?: (outcome: Outcome) => Promise<unknown>
  /** Counts the outcome of a call that was held or taken back. Defaults to `graph.outcome`, which sends nothing; pass the outbox's `release` to send it too. */
  release?: (outcome: Outcome) => Promise<unknown>
  /** Takes back the outcome of a call that was not answered after all. Defaults to `graph.withdraw`; pass the outbox's `withdraw`. */
  withdraw?: (transactionId: string) => Promise<unknown>
  /** Takes an outcome's conversions back while it is no lead, and gives them back. Default to nothing; pass the outbox's `takeBack` and `giveBack`. */
  takeBack?: (transactionId: string) => Promise<unknown>
  giveBack?: (transactionId: string) => Promise<unknown>
  /** The clock, for tests. */
  now?: () => number
  /** The result a call carries is kept as one thing said of it, by when it was said, and not as the last word. */
  said?: { key: string; at: number }
}

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
  /** The visitor the code names, the number was shown to, or who tapped it just before when there was exactly one. The two are now linked. */
  visitor?: Subject
  /** The call had been recorded before, and nothing was written. */
  duplicate: boolean
}

const BUCKET = 5 * 60_000
/** How long nobody else has used a number when it is quiet. */
const QUIET = 20 * 60_000
/** How long before a call a tap may be on a number that is not quiet, when that is shorter. */
const NEAR = 30_000
/** Allowance for the provider's clock and ours disagreeing. */
const SLACK = 30_000
/** The same where others use the number, and any more than a little would count strangers. */
const SKEW = 5_000
/** How long a call is being recorded at most. One that is has no tie yet, and may be about to have one. */
const STAGED = 60_000
const TOLL_FREE = /^\+18(00|33|44|55|66|77|88)\d{7}$/
/** What a hidden caller's number is reported as: the words anonymous, restricted, unavailable, blocked and unknown, spelled on a keypad. */
const HIDDEN = new Set(['+266696687', '+7378742833', '+86282452253', '+2562533', '+8656696'])

/**
 * The note left on a visitor who tapped a phone number. It is filed by the
 * five minutes it happened in, so a call can find recent taps without
 * reading every tap there ever was. A note links nothing.
 */
export function dialed(number: string, at: number, country?: string): Identifier {
  if (!Number.isSafeInteger(at)) throw malformed('A tap requires `at`, an integer in epoch milliseconds')
  return `dialed:${normalizePhone(number, country)}@${Math.floor(at / BUCKET)}`
}

/**
 * Records a phone call. The caller becomes a subject carrying their phone
 * number, so an account that later gives the same number is tied to the
 * call. If its code names one visitor, the number was shown to one, or exactly one tapped it on
 * your site just before, the call is tied to that visitor, and so to the ad click that brought them.
 * Otherwise the call is filed under the channel its tracking number is published on.
 */
export async function recordCall(graph: Graph, call: Call, options: CallOptions = {}): Promise<RecordedCall> {
  if (typeof call?.id !== 'string' || !/^[\w.-]{1,128}$/.test(call.id)) throw malformed('A call requires an id of letters, digits, dots, dashes or underscores')
  if (!Number.isSafeInteger(call.at)) throw malformed(`Call "${call.id}" requires "at", an integer in epoch milliseconds`)
  if (call.duration !== undefined && !(typeof call.duration === 'number' && Number.isFinite(call.duration) && call.duration >= 0)) throw malformed(`Call "${call.id}" requires its duration in seconds`)
  if (call.direction !== undefined && call.direction !== 'inbound' && call.direction !== 'outbound') throw malformed(`Call "${call.id}" requires its direction, inbound or outbound`)
  const result = resultIn(call, `Call "${call.id}"`)
  if (typeof call.to !== 'string') throw malformed(`Call "${call.id}" requires "to", the dialed number`)
  const to = normalizePhone(call.to, options.country)
  const tags = checkTags(call.tags, `Call "${call.id}"`)
  if (call.code !== undefined && typeof call.code !== 'string') throw malformed(`Call "${call.id}" requires its code as a string`)
  const { id, at } = call
  if (call.direction === 'outbound') return placed(graph, call, to, result, tags, options)

  const channel = Object.entries(options.numbers ?? {}).find(([number]) => numberOrSelf(number, options.country) === to)?.[1]
  const custom = checkTags(channel?.tags, `Number "${to}"`)

  let from: string | undefined
  try {
    from = typeof call.from === 'string' ? normalizePhone(call.from, options.country) : undefined
  } catch {}
  if (from !== undefined && HIDDEN.has(from)) from = undefined
  const tollFree = from !== undefined && TOLL_FREE.test(from)
  const subject = from ? `caller:${hashPhone(from)}` : `call:${id}`

  const saved = await graph.keptCall(id)
  if (saved?.direction === 'outbound') throw refused(`Call "${id}" is already recorded as outbound`, { reason: 'KEY_REUSED', fields: ['direction'] })
  if (!saved && from !== undefined && leftOut(from, options)) return { subject, flags: ['left_out'], counted: false, state: 'unknown', duplicate: false }
  // An assertion may have arrived before the phone report. That call supplies no evidence about the line or a visitor.
  if (saved?.party || (!saved && (await graph.partyHistory(id)).length > 0)) {
    if (result) await keepResult(graph, id, result, options)
    if (!saved) {
      const flags: CallFlag[] = [...(!from ? ['blocked' as const] : []), ...(tollFree ? ['toll_free' as const] : []), ...(tooShort(call, options) ? ['short' as const] : [])]
      await graph.keepCall({ id, direction: 'inbound', subject, at, to, flags, ...(call.duration !== undefined && { duration: call.duration }), ...(tags && { tags }) })
    }
    const kept = (await graph.keptCall(id))!
    const counted = await settle(graph, id, options)
    return { subject: kept.subject, flags: kept.flags as CallFlag[], counted, state: callState(kept, (options.now ?? Date.now)(), options), duplicate: saved !== undefined }
  }

  // The note is written last, so a call that was cut off half-recorded is recorded again in full.
  const note = `dialed:call-${id}`
  const [before] = await graph.holders([note])
  if (before) {
    // Reported again with a result it did not have before, the call is settled by it.
    const settled = result && (await tell(graph, id, result, options))
    // Or with the code it did not have, and then it stands as it would had the code come first.
    const first = call.code === undefined ? undefined : await graph.keptCall(id)
    if (first) await tellCode(graph, first, call.code, options, channel && lineOf(channel, custom, to))
    const kept = await graph.keptCall(id)
    return { subject: before.subject, flags: [], ...(first && kept && { flags: kept.flags as CallFlag[], ...(kept.visitor && { visitor: kept.visitor }) }), counted: settled?.counted ?? false, state: kept ? callState(kept, (options.now ?? Date.now)(), options) : 'unknown', duplicate: true }
  }
  if (result) await keepResult(graph, id, result, options)

  const flags: CallFlag[] = []
  if (!from) flags.push('blocked')
  if (tollFree) flags.push('toll_free')
  const short = tooShort(call, options)
  if (short) flags.push('short')
  if (from && (await graph.cluster(subject))) flags.push('repeat')

  // A toll-free number belongs to a switchboard, not a person, so it ties the call to nobody.
  const known = from && !tollFree ? from : undefined
  // With a line check, a number from an internet calling app is written as the weaker kind. A check that fails changes nothing.
  const kind = known && options.lineType ? await options.lineType(known).catch(() => undefined) : undefined
  const phone = known && phoneOfType(known, kind?.type)
  if (phone) await graph.observe({ subject, identifiers: [phone], at, event: 'call' })

  // A visitor's own arrival says more than the number does, so the number's channel is only the fallback.
  const line = channel && lineOf(channel, custom, to)
  // What a code says stands over who was shown the number and who tapped it, and those are then not looked for.
  // A call that was cut off half-recorded keeps what its code said then, and takes another at the end, as one reported again does.
  const code = saved ? undefined : await namedBy(graph, call.code, at, options.codeLife)
  const coded = code && (await graph.tieCall(subject, code.visitor, codeTie(id), at, { notes: [code.note] })) ? code.visitor : undefined
  if (code) flags.push(coded ? 'code' : 'taken')
  if (saved && byCode(saved)) flags.push(saved.flags.includes('code') ? 'code' : 'taken')
  // The outcome comes before the touch: if recording it fails, the call is reported again and nothing has been written twice.
  // What would be sent is held before the call is kept, while the number is at hand: a result that finds the call then finds that too.
  if (!short) await options.hold?.(outcomeOf({ id, subject, at, ...(tags && { tags }) }, options, known))
  // The call is kept before its result is looked for, and a result is kept before its call is, so whichever comes second settles it.
  // It is kept before its visitor is looked for too: of two calls reported at once, the later then finds the other.
  const kept = { id, direction: 'inbound' as const, subject, at, to, flags, ...(call.duration !== undefined && { duration: call.duration }), ...(tags && { tags }) }
  // Reported again, what it was tied to stands until that is decided anew.
  if (!saved) await graph.keepCall(kept, phone ? (phone.startsWith('voip:') ? 'voip' : 'phone') : 'none')

  const { holder, grace, visitor: found, notes, doubtful, undone } = await visitorFor(graph, kept, options)
  for (const other of undone) await graph.doubtCall(other.id, other.ambiguous, line)
  if (saved?.visitor !== undefined && !saved.flags.includes('pool') && saved.visitor !== found) await graph.doubtCall(id, doubtful, line)
  // A visitor already tied to a different caller is passed over, so a browser cannot collect call after call by tapping again.
  // The same caller ringing back still counts. A visitor a reviewer has kept apart from this caller is passed over too.
  const tied = found !== undefined && (await graph.tieCall(subject, found, `${holder ? 'lease' : 'dial'}:${id}`, at, holder ? { pool: to, grace } : { notes })) ? found : undefined
  const visitor = byCode(kept) ? (coded ?? saved?.visitor) : tied
  if (doubtful) flags.push('ambiguous')
  if (visitor !== undefined && holder) flags.push('pool')
  await graph.keepCall({ ...kept, ...(visitor && { visitor }) })
  const counted = await settle(graph, id, options, known ?? '')

  if (!(await graph.keptCall(id))!.visitor && line) await graph.touch({ ...line, subject, at })
  if (saved && call.code !== undefined) await tellCode(graph, (await graph.keptCall(id))!, call.code, options, line)
  const now = (await graph.keptCall(id))!
  await graph.observe({ subject, identifiers: [note], at, event: 'call' })
  return { subject, flags: now.flags as CallFlag[], counted, state: callState(now, (options.now ?? Date.now)(), options), ...(now.visitor && { visitor: now.visitor }), duplicate: false }
}

/** Whether a code said whose call it is, or that it is nobody's. */
export const byCode = (call: Pick<KeptCall, 'flags'>): boolean => call.flags.includes('code') || call.flags.includes('taken')

/** What ties a caller to the visitor their code names. A text's is named after its id, which has no colon. */
export const codeTie = (id: string): Identifier => `text:call:${id}`

/** The channel of a number, as an arrival on it. */
const lineOf = (channel: Channel, custom: Record<string, string> | undefined, to: string): Omit<Touch, 'subject' | 'at'> => ({ source: channel.source, medium: channel.medium ?? 'call', ...(channel.campaign && { campaign: channel.campaign }), ...(channel.campaignId && { campaignId: channel.campaignId }), ...(custom && { custom }), landing: `tel:${to}` })

/** Takes the code of a call that was recorded without one, by when the call was. The first code that named somebody stands. */
async function tellCode(graph: Graph, call: KeptCall, given: string | undefined, options: CallOptions, line: Omit<Touch, 'subject' | 'at'> | undefined): Promise<void> {
  if (call.party || byCode(call)) return
  const named = await namedBy(graph, given, call.at, options.codeLife)
  if (named) await graph.nameCall(call.id, named.visitor, named.note, line)
}

/** Who is calling, while the phone rings: what a call from this number to this one would be tied to. Nothing is written. */
export interface Ringing {
  /** The caller, as the call will be recorded. Undefined when they hid their number. */
  subject?: Subject
  /** Where in Texas the number was first given out. People keep a number when they move. */
  area?: string
  /** Whether the number has called or texted before. */
  known: boolean
  /** Who they may be, strongest first: records of yours with this number, and whoever those are. */
  people: Candidate[]
  /** The one visitor who was shown the number or tapped it just before. */
  visitor?: Subject
  /** What brought them, where it can be credited already. */
  touch?: AttributedTouch
  /** Their missed calls nobody has returned, and their texts nobody has answered. */
  waiting: { calls: number; texts: number }
}

export async function ringing(graph: Graph, call: { from?: string; to: string; at: number }, options: CallOptions = {}): Promise<Ringing> {
  if (!Number.isSafeInteger(call?.at)) throw malformed('A ringing call requires "at", an integer in epoch milliseconds')
  if (typeof call.to !== 'string') throw malformed('A ringing call requires "to", the dialed number')
  const to = normalizePhone(call.to, options.country)
  let from: string | undefined
  try {
    from = typeof call.from === 'string' ? normalizePhone(call.from, options.country) : undefined
  } catch {}
  if (from !== undefined && HIDDEN.has(from)) from = undefined
  const subject: Subject | undefined = from && `caller:${hashPhone(from)}`
  const { visitor } = await visitorFor(graph, { id: '', direction: 'inbound', subject: subject ?? 'call:', at: call.at, to, flags: [] }, options)
  const calls = subject ? await graph.callsOf([subject]) : []
  const texts = subject ? await graph.textsOf([subject]) : []
  // A caller who is on record is tied already. Of one who is not, the number says who they may be.
  const ties = subject ? await graph.links(subject) : []
  const people: Candidate[] = []
  const own = new Set(subject ? (await graph.cluster(subject))?.members : [])
  // However strong what they share with the caller is, one who was kept out of the caller's group is somebody else.
  for (const { subject: other, score, level, reasons } of ties) people.push({ subject: other, score, level: own.has(other) ? level : 'related', reasons, members: (await graph.cluster(other))?.members ?? [other] })
  const reviewed = people.filter(person => person.reasons.some(reason => reason.identifier.startsWith('review:join-')))
  const others = reviewed.filter(person => !own.has(person.subject))
  if (others.length && reviewed.some(person => own.has(person.subject))) {
    // The cluster cut chooses where the line sits. Two staff claims on it still leave the next caller in doubt.
    const kept = new Set((await Promise.all([...own].filter(member => member !== subject).map(member => graph.separations(member)))).flat())
    if (others.some(person => person.members.some(member => kept.has(member)))) for (const person of people) person.level = 'related'
  }
  const apart = new Set(subject ? await graph.separations(subject) : [])
  if (ties.length === 0 && from && !TOLL_FREE.test(from)) people.push(...(await graph.match([`phone:${hashPhone(from)}`, `voip:${hashPhone(from)}`], { at: call.at })).filter((each) => each.subject !== subject && !apart.has(each.subject)))
  const touch = (subject && (await graph.attribute(subject, { at: call.at })).credited) ?? (visitor && (await graph.attribute(visitor, { at: call.at })).credited)
  const not = await graph.notLeads([...calls.map((each) => `call:${each.id}`), ...texts.map((each) => `text:${each.id}`)])
  const spoken = calls.filter((each) => !not.has(`call:${each.id}`))
  const missed = spoken.filter((each) => each.direction === 'inbound' && each.result?.answered === false && followUp(each, spoken).state === 'open').length
  // A sender who was no lead waits for nobody.
  const unanswered = texts.some((each) => not.has(`text:${each.id}`)) ? 0 : texts.filter((each) => asks(each) && replyTo(each, texts, spoken).state === 'open').length
  const area = from && texasArea(from)
  return { ...(subject && { subject }), ...(area && { area }), known: calls.length > 0 || texts.length > 0, people, ...(visitor && { visitor }), ...(touch && { touch }), waiting: { calls: missed, texts: unanswered } }
}

/** Whether an identifier two hold says whose a visitor is: a call, a text, or a decision about a caller and a visitor. */
export const isTie = (identifier: Identifier, one: Subject, other: Subject): boolean => /^(dial|lease|text):/.test(identifier) || (identifier.startsWith('review:') && [one, other].some((each) => /^(caller|call):/.test(each)) && [one, other].some((each) => each.startsWith('visitor:')))

/** The callers a subject is tied to by calls and texts, or joined to by a decision, and by which. */
const tiesOf = async (graph: Graph, subject: Subject) =>
  (await graph.links(subject)).flatMap((link) => link.reasons.filter(({ identifier }) => isTie(identifier, subject, link.subject)).map(({ identifier }) => ({ subject: link.subject, identifier })))

type Heard = Pick<KeptCall, 'id' | 'direction' | 'subject' | 'at' | 'to' | 'flags' | 'visitor'>
interface Tap { visitor: Subject; note: Identifier; when: number; span?: { first: number; last: number } }

/**
 * Who a call to a number is from: whoever it was shown to, or whoever tapped
 * it just before. Which call a tap led to is worked out for all the calls
 * around this one together, so it does not depend on which was reported
 * first. `undone` are the calls of others that are tied and no longer should
 * be, or could be about to be tied.
 */
async function visitorFor(graph: Graph, call: Heard, options: CallOptions): Promise<{ holder: boolean; grace: number; visitor?: Subject; notes: Identifier[]; doubtful: boolean; undone: { id: string; ambiguous: boolean }[] }> {
  const { to, at } = call
  const window = options.clickWindow ?? 3 * 60_000
  const near = Math.min(window, NEAR)
  // A call may claim a tap for twice as long as it can be tied by it, so one just outside still casts doubt on another's.
  const claim = 2 * near
  const pooled = options.pool?.numbers.some((number) => numberOrSelf(number, options.country) === to) === true

  // The calls this one bears on, as a rival for a tap or as what makes the number busy, and what bears on those.
  const [first, last] = [at - claim - SLACK - window, at + QUIET]
  const notes: Identifier[] = []
  for (let bucket = Math.floor((first - Math.max(QUIET, window)) / BUCKET); bucket <= Math.floor((last + SLACK) / BUCKET); bucket++) notes.push(`dialed:${to}@${bucket}`)
  // Of what a note says only its first tap and its last are known to have happened.
  const taps: Tap[] = (await graph.holders(notes)).flatMap((edge) => [...new Set([edge.first, edge.last])].map((when) => ({ visitor: edge.subject, note: edge.identifier, when, ...(edge.count > 2 && { span: { first: edge.first, last: edge.last } }) })))
  const kept = (await graph.callsTo(to, first - QUIET, last + SLACK + claim + 1)).filter((each) => each.direction === 'inbound' && !each.party && each.id !== call.id)
  const heard: Heard[] = [...kept, call].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
  const redone = new Set(heard.filter((each) => each.at >= first && each.at <= last).map((each) => each.id))

  /** A tie to be worked out again is no evidence of itself. */
  const deciding = (identifier: Identifier) => identifier.startsWith('dial:') && redone.has(identifier.slice('dial:'.length))

  /** Who a call was shown the number, if anybody, and whether it can be of a tap of somebody its caller is not tied to. */
  const shown = async (each: Heard): Promise<{ holder?: Subject | undefined; grace: number; own?: Set<Subject> }> => {
    if (!pooled) return { grace: 0 }
    const { grace } = options.pool!
    const ties = await tiesOf(graph, each.subject)
    const all = new Set(ties.map((tie) => tie.subject))
    const sure = new Set(ties.filter(({ identifier }) => !deciding(identifier)).map((tie) => tie.subject))
    const own = sure.size > 0 && { own: sure }
    const given = await graph.leaseholder(to, each.at, grace)
    // An untied caller may have saved this number from any earlier holder. Renewals by the same visitor say nothing against them.
    const lookBack = options.pool!.requireTapAfterReassignment === true && all.size === 0 ? Infinity : grace
    let before = given === undefined ? undefined : await graph.shownTo(to, each.at)
    while (before && before.subject === given && each.at - before.until < lookBack) before = await graph.shownTo(to, before.start - 1)
    const holder = before && each.at - before.until < lookBack ? undefined : given
    if (holder === undefined || all.has(holder)) return { holder, grace, ...own }
    // A caller who dialed this number when it was somebody else's, or nobody's, has it from then.
    for (const before of await graph.callsOf([each.subject])) if (before.to === to && before.direction === 'inbound' && before.at < each.at && (await graph.leaseholder(to, before.at, grace)) !== holder) return { grace, ...own }
    // A caller who is somebody's already may be dialing what they were shown another day. It is another visitor's call only while they are shown it.
    return all.size === 0 ? { holder, grace, ...own } : { holder: await graph.leaseholder(to, each.at, 0), grace: 0, ...own }
  }
  const here = await shown(call)

  const owners = new Map<Subject, Set<Subject>>()
  const apart = new Map<Subject, Set<Subject>>()
  for (const visitor of new Set(taps.map((tap) => tap.visitor))) {
    owners.set(visitor, new Set((await tiesOf(graph, visitor)).filter(({ identifier }) => !deciding(identifier)).map((tie) => tie.subject)))
    apart.set(visitor, new Set(await graph.separations(visitor)))
  }
  const views = new Map<string, Awaited<ReturnType<typeof shown>>>([[call.id, here]])
  if (pooled) for (const each of kept) views.set(each.id, await shown(each))
  // One a code says is somebody's, or nobody's, came of no tap. It still makes the number busy.
  const tapped = heard.filter((each) => !byCode(each) && views.get(each.id)?.holder === undefined)
  const may = (each: Heard, visitor: Subject) => !apart.get(visitor)!.has(each.subject) && (views.get(each.id)?.own?.has(visitor) ?? true)

  const result = ties(tapped, heard, taps, owners, may, redone, { window, near, claim })
  const undone = kept.filter((each) => redone.has(each.id) && !each.flags.includes('pool') && !byCode(each) && views.get(each.id)?.holder === undefined && (each.visitor === undefined ? result.get(each.id)!.visitor === undefined && (each.recorded > (options.now ?? Date.now)() - STAGED || (result.get(each.id)!.doubtful && !each.flags.includes('ambiguous'))) : result.get(each.id)!.visitor !== each.visitor)).map((each) => ({ id: each.id, ambiguous: result.get(each.id)!.doubtful }))
  if (byCode(call)) return { holder: false, grace: 0, notes: [], doubtful: false, undone }
  if (here.holder !== undefined) {
    const free = !(await graph.separations(call.subject)).includes(here.holder) && (await tiesOf(graph, here.holder)).every((tie) => tie.subject === call.subject)
    return { holder: true, grace: here.grace, ...(free && { visitor: here.holder }), notes: [], doubtful: false, undone }
  }
  const mine = result.get(call.id)!
  return { holder: false, grace: 0, ...(mine.visitor !== undefined && { visitor: mine.visitor }), notes: taps.filter((tap) => tap.visitor === mine.visitor && tap.when <= at + SLACK && tap.when >= at - window).map((tap) => tap.note), doubtful: mine.doubtful, undone }
}

/**
 * Which visitor's tap each call is of. A tap that the calls of two callers
 * could have come of is neither's, unless its visitor is one caller's by
 * something else: a tie outside these calls, or a tap of theirs that nobody
 * else could have made. On a number others are using, a tap has to be closer
 * to the call. Pure, and the result does not depend on the order of its inputs.
 */
function ties(calls: readonly Heard[], heard: readonly Heard[], taps: readonly Tap[], tied: ReadonlyMap<Subject, ReadonlySet<Subject>>, may: (call: Heard, visitor: Subject) => boolean, full: ReadonlySet<string>, { window, near, claim }: { window: number; near: number; claim: number }): Map<string, { visitor?: Subject; doubtful: boolean }> {
  const within = (when: number, tap: number, time: number, early: number) => when >= tap - early && when <= tap + time
  const busy = new Map(calls.map((call) => [call.id, heard.some((each) => each.subject !== call.subject && each.at <= call.at && each.at >= call.at - QUIET) || new Set(taps.filter((tap) => tap.when >= call.at - QUIET && tap.when <= call.at + SLACK).map((tap) => tap.visitor)).size > 1]))
  // Between the first and the last of more taps there was one at a time nobody knows.
  const between = (when: number, { span }: Tap, time: number, early: number) => span !== undefined && when >= span.first - early && when <= span.last + time
  const rivals = new Map(taps.map((tap) => [tap, calls.filter((call) => (within(call.at, tap.when, claim, busy.get(call.id) ? SKEW : SLACK) || between(call.at, tap, claim, SKEW)) && may(call, tap.visitor))]))
  const decide = (call: Heard, owners: ReadonlyMap<Subject, ReadonlySet<Subject>>): { visitor?: Subject; doubtful: boolean } => {
    const of = (tap: Tap) => owners.get(tap.visitor)!
    const contested = (tap: Tap) => of(tap).size === 0 && rivals.get(tap)!.some((each) => each.subject !== call.subject)
    const free = taps.filter((tap) => may(call, tap.visitor) && (of(tap).size === 0 || of(tap).has(call.subject)))
    // A tap by somebody this caller is tied to already is theirs, however busy the number is.
    const eligible = free.filter((tap) => (busy.get(call.id) && !of(tap).has(call.subject) ? within(call.at, tap.when, near, SKEW) : within(call.at, tap.when, window, SLACK)))
    const visitors = new Set(eligible.filter((tap) => !contested(tap)).map((tap) => tap.visitor))
    const unseen = free.some((tap) => !visitors.has(tap.visitor) && between(call.at, tap, busy.get(call.id) && !of(tap).has(call.subject) ? near : window, SKEW))
    const doubtful = unseen || visitors.size > 1 || free.some((tap) => within(call.at, tap.when, claim, busy.get(call.id) ? SKEW : SLACK) && contested(tap))
    const sure = visitors.size === 1 && !unseen
    return { ...(sure && { visitor: [...visitors][0]! }), doubtful: doubtful && !sure }
  }
  // First by the ties there are. What that makes sure of then says whose the other taps of the same visitor are, the earliest call first.
  const owners = new Map([...tied].map(([visitor, callers]) => [visitor, new Set(callers)]))
  // Of a call at the edge not everything that bears on it was read, so it makes nobody sure: what it is tied to is among the ties there are.
  for (const call of calls) {
    if (!full.has(call.id)) continue
    const { visitor } = decide(call, tied)
    if (visitor !== undefined && owners.get(visitor)!.size === 0) owners.get(visitor)!.add(call.subject)
  }
  return new Map(calls.map((call) => [call.id, decide(call, owners)]))
}

/** Records a call you placed. Nothing is observed: that you rang someone says nothing about who they are. */
async function placed(graph: Graph, call: Call, theirs: string, result: Omit<CallResult, 'recorded'> | undefined, tags: Record<string, string> | undefined, options: CallOptions): Promise<RecordedCall> {
  if (typeof call.from !== 'string') throw malformed(`Call "${call.id}" requires "from", the number it was placed from`)
  const ours = normalizePhone(call.from, options.country)
  const subject = `caller:${hashPhone(theirs)}`
  const before = await graph.keptCall(call.id)
  if (before && before.direction !== 'outbound') throw refused(`Call "${call.id}" is already recorded as inbound`, { reason: 'KEY_REUSED', fields: ['direction'] })
  if (!before && leftOut(theirs, options)) return { subject, flags: ['left_out'], counted: false, state: 'unknown', duplicate: false }
  if (result) await keepResult(graph, call.id, result, options)
  if (!before) {
    await graph.keepCall({ id: call.id, direction: 'outbound', subject, at: call.at, to: ours, flags: [], ...(call.duration !== undefined && { duration: call.duration }), ...(tags && { tags }) })
  }
  const kept = (await graph.keptCall(call.id))!
  return { subject: kept.subject, flags: [], counted: false, state: callState(kept, (options.now ?? Date.now)(), options), duplicate: before !== undefined }
}

/** Whether a return reported for a call counts: the call was to you, nobody answered it, and it began before it is said to have been returned. */
export const stands = (call: CallTime): boolean => call.direction === 'inbound' && call.result?.answered === false && call.result.returned !== undefined && call.result.returned > call.at

/**
 * What became of a call no one answered, from every call to and from its
 * subject. Worked out from the calls themselves each time, so it does not
 * depend on the order they were reported in. A call before the miss says
 * nothing about it, and one later answer closes every miss before it. So does
 * a return reported for any missed call of theirs, for the misses that began
 * before they are said to have been reached.
 */
export function followUp(miss: CallTime, calls: readonly CallTime[]): FollowUp {
  const since = calls.filter((call) => call.subject === miss.subject && call.id !== miss.id && call.at > miss.at).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
  const told = calls.filter((call) => call.subject === miss.subject && stands(call) && call.result!.returned! > miss.at).sort((x, y) => x.result!.returned! - y.result!.returned! || (x.id < y.id ? -1 : 1))[0]
  // A hidden number cannot be rung back, and whoever it was can still have been reached.
  if (miss.subject === `call:${miss.id}` && !told) return { state: 'hidden', attempts: 0 }
  let attempts = 0
  for (const call of since) {
    // An answered call reaches the caller after its wait, where that is known.
    const reached = call.at + (call.result?.answered ? (call.result.waited ?? 0) * 1000 : 0)
    if (told && told.result!.returned! < reached) continue
    if (call.result?.answered) return { state: call.direction === 'outbound' ? 'returned' : 'called again', by: call.id, delay: call.at - miss.at, attempts }
    if (call.direction === 'outbound') attempts += 1
  }
  if (told) return { state: 'returned', by: told.id, delay: told.result!.returned! - miss.at, reported: true, attempts }
  return { state: 'open', attempts }
}

/** The result a call or a report of one carries, checked. Undefined when it says nothing of how the call went. */
function resultIn(given: { answered?: unknown; voicemail?: unknown; waited?: unknown }, what: string): Omit<CallResult, 'recorded'> | undefined {
  const { answered, voicemail, waited } = given
  for (const [name, value] of [['answered', answered], ['voicemail', voicemail]] as const) if (value !== undefined && typeof value !== 'boolean') throw malformed(`${what} requires ${name} as true or false`)
  if (waited !== undefined && !(typeof waited === 'number' && Number.isFinite(waited) && waited >= 0)) throw malformed(`${what} requires its wait in seconds`)
  if (answered === true && voicemail === true) throw malformed(`${what} cannot be answered by a person and go to voicemail`)
  // Voicemail is not a person, so it says nobody answered.
  const heard = voicemail === true ? false : (answered as boolean | undefined)
  if (heard === undefined && voicemail === undefined && waited === undefined) return undefined
  return { ...(heard !== undefined && { answered: heard }), ...(voicemail !== undefined && { voicemail: voicemail as boolean }), ...(waited !== undefined && { waited: waited as number }) }
}

/** Whether a call counts by what is known of it: it was long enough, and a person answered, or no result is expected and none says otherwise. */
const countsBy = (call: KeptCall, options: CallOptions): boolean => !tooShort(call, options) && (call.result?.answered ?? options.results !== 'expected')

/** Whether a call ended too soon to count. */
function tooShort(call: { duration?: number }, options: CallOptions): boolean {
  return (call.duration ?? Infinity) < (options.minimumSeconds ?? 30)
}

const outcomeOf = (call: { id: string; subject: Subject; at: number; tags?: Record<string, string> }, options: CallOptions, phone?: string): Outcome => ({
  transactionId: `call:${call.id}`,
  subject: call.subject,
  at: call.at,
  stage: options.stage ?? 'call',
  source: 'PHONE',
  ...(phone && { phone }),
  ...(call.tags && { tags: call.tags }),
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
    // A call you placed is never an outcome.
    if (!call || call.direction === 'outbound') return false
    const answered = call.result?.answered
    const counts = countsBy(call, options)
    const outcome = outcomeOf(call, options, phone)
    // Said to be no lead, it is not sent or counted anew. What was counted stays on record, and counts nowhere.
    if (counts && (await graph.notLeads([outcome.transactionId])).size > 0) return false
    // Each of these does nothing where it is already done, so one that was cut off half way is finished by the next.
    if (call.party && counts) await (options.count ?? graph.outcome)(outcome)
    else if (call.party && answered === false) await graph.withdraw(outcome.transactionId)
    else if (counts && options.release) await options.release(outcome)
    // Without one, a result has no number to give, so it only counts the call.
    else if (counts) await (phone !== undefined && options.convert ? options.convert : graph.outcome)(outcome)
    else if (answered === false) await (options.withdraw ?? graph.withdraw)(outcome.transactionId)
    // A result that came meanwhile is settled too.
    if ((await graph.callResult(id))?.answered === answered) return counts
  }
}

async function keepResult(graph: Graph, id: string, result: Omit<CallResult, 'recorded'>, { said }: CallOptions): Promise<void> {
  if (!said || result.answered === undefined) return graph.keepCallResult(id, result)
  const { answered, voicemail, waited } = result
  await graph.sayResult({ call: id, ...said, result: { answered, ...(voicemail !== undefined && { voicemail }), ...(waited !== undefined && { waited }) } })
}

/** Keeps a result and settles its call by it. Resolves to undefined while the call itself has not been recorded. */
async function tell(graph: Graph, id: string, result: Omit<CallResult, 'recorded'>, options: CallOptions): Promise<{ state: CallState; counted: boolean } | undefined> {
  await keepResult(graph, id, result, options)
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
  if (typeof report?.id !== 'string' || !/^[\w.-]{1,128}$/.test(report.id)) throw malformed('A call result requires the id of its call')
  const result = resultIn(report, `The result of call "${report.id}"`)
  if (result?.answered === undefined) throw malformed(`The result of call "${report.id}" requires answered, true or false`)
  return tell(graph, report.id, result, options)
}

/**
 * Records that somebody reached a caller some way your phone system does not
 * report: from another line, by a text they answered, in person. `at` is when,
 * now unless you say, and `returned: false` takes it back. It may come before
 * the call it is about, and as often as it likes: the last report stands.
 * Resolves to what became of the call, or undefined while it has not been
 * recorded or was not missed.
 */
export async function recordReturn(graph: Graph, report: { id: string; at?: number; returned?: boolean }, options: Pick<CallOptions, 'now'> = {}): Promise<FollowUp | undefined> {
  if (typeof report?.id !== 'string' || !/^[\w.-]{1,128}$/.test(report.id)) throw malformed('A return requires the id of the call it is about')
  if (report.returned !== undefined && typeof report.returned !== 'boolean') throw malformed(`The return of call "${report.id}" requires returned as true or false`)
  const undone = report.returned === false
  let at = 0
  if (!undone) {
    const now = (options.now ?? Date.now)()
    at = report.at ?? now
    if (!Number.isSafeInteger(at)) throw malformed(`The return of call "${report.id}" requires "at", an integer in epoch milliseconds`)
    if (at > now) throw malformed(`The return of call "${report.id}" is in the future`)
  }
  const call = await graph.keptCall(report.id)
  if (call?.direction === 'outbound') throw malformed(`Call "${report.id}" is outbound and cannot be returned`)
  if (!undone && call && at <= call.at) throw malformed(`Call "${report.id}" starts after its reported return`)
  await graph.keepReturn(report.id, undone ? undefined : at)
  const kept = call && (await graph.keptCall(report.id))
  return kept?.result?.answered === false ? followUp(kept, await graph.callsOf([kept.subject])) : undefined
}

/**
 * Records that an outcome was no lead: spam, or somebody who was not asking
 * for what you do. `call` names a call, and `transactionId` any other outcome;
 * either may not be recorded yet. It stays on record and counts nowhere, its
 * conversions are taken back where the ad platform allows it, and a missed
 * call is not waiting for anyone. `lead: true` takes that back.
 */
export async function recordNotLead(graph: Graph, report: { call?: string; transactionId?: string; kind?: NotLead['kind']; lead?: boolean }, options: CallOptions = {}): Promise<{ id: string; lead: boolean }> {
  const { call, transactionId, kind = 'other', lead = false } = report ?? {}
  if ((call === undefined) === (transactionId === undefined)) throw malformed('Set either `call` or `transactionId`')
  if (call !== undefined && (typeof call !== 'string' || !/^[\w.-]{1,128}$/.test(call))) throw malformed('`call` must be the id of a call')
  if (typeof lead !== 'boolean') throw malformed('`lead` must be true or false')
  const id = call !== undefined ? `call:${call}` : transactionId!
  await graph.markNotLead(id, lead ? undefined : kind)
  await settleLead(graph, id, lead, options)
  return { id, lead }
}

/** Takes an outcome's conversions back where it is no lead, and gives them back where it is one after all. Safe to run again. */
export async function settleLead(graph: Graph, id: string, lead: boolean, options: CallOptions = {}): Promise<void> {
  if (!lead) await options.takeBack?.(id)
  // A call is counted by what is known of it now, which may not be what was known when it was marked.
  // What was recorded keeps its value.
  else if (await graph.outcomeOf(id)) {
    const kept = id.startsWith('call:') ? await graph.keptCall(id.slice(5)) : undefined
    if (!kept || countsBy(kept, options)) await options.giveBack?.(id)
  } else if (id.startsWith('call:')) await settle(graph, id.slice(5), options)
}

/** Brings a kept call's outcome in line with what is known of it. */
export const settleCall = (graph: Graph, id: string, options: CallOptions = {}): Promise<boolean> => settle(graph, id, options)

/** Whether a number is one of those left out. */
const leftOut = (number: string, options: CallOptions) => (options.exclude ?? []).some((each) => numberOrSelf(each, options.country) === number)

/** The number a call came from, or undefined where it was hidden, however a provider says so. */
export function callerNumber(from: string | undefined, country?: string): string | undefined {
  if (from === undefined) return undefined
  const number = numberOrSelf(from, country)
  return /^\+\d+$/.test(number) && !HIDDEN.has(number) ? number : undefined
}

/** A phone number in the form calls arrive in, or as written when it is not a phone number. */
export function numberOrSelf(number: string, country?: string): string {
  try {
    return normalizePhone(number, country)
  } catch {
    return number
  }
}

export type { CallState }
