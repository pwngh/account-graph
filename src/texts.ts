import { malformed } from './contract/fault.ts'
import { randomInt } from 'node:crypto'
import type { CallOptions } from './calls.ts'
import { numberOrSelf } from './calls.ts'
import type { Graph } from './graph.ts'
import { hashPhone, normalizePhone, phoneOfType } from './identifiers.ts'
import { checkTags } from './tags.ts'
import type { Identifier, KeptCall, KeptText, Outcome, Subject, TextReply } from './types.ts'
import { spanishStop } from './lookups.ts'

/** One text message to a number of yours, or from one, as your provider reports it. */
export interface Text {
  /** The provider's id for the message. Recording it twice records it once. */
  id: string
  /** Who sent it: their number, or on an outbound text yours. */
  from: string
  /** The number it was sent to: yours, or on an outbound text theirs. */
  to: string
  /** When it was sent, in epoch milliseconds. */
  at: number
  /** `inbound`, which is the default, or `outbound` for one you sent. An outbound text is never an outcome, and ties nobody to anything. */
  direction?: 'inbound' | 'outbound'
  /** What an inbound text said. Read for the code your site put in it and for a word like STOP, and never kept. */
  text?: string
  /** The code itself, when you have read it out of the text yourself. */
  code?: string
  /** Facts about the text, such as its language, carried on to its outcome. */
  tags?: Record<string, string>
}

/**
 * What was noticed about a text: `first` it begins a conversation, so it is counted; `code` the code in it named the
 * visitor; `taken` it did, and that visitor is already someone else's; `tap` the visitor tapped your text link just before; `ambiguous` more than one visitor did; `opt_out` and
 * `opt_in` it was STOP or START, or a word that means the same; `toll_free` it came from a business or a machine;
 * `left_out` it was from or to your own people, or from a number that is no phone's, and is not kept.
 */
export type TextFlag = 'first' | 'code' | 'taken' | 'tap' | 'ambiguous' | 'opt_out' | 'opt_in' | 'toll_free' | 'left_out'

/** The text an outcome is of is not kept, because its sender was forgotten. */
export class Gone extends TypeError {
  constructor() {
    super('The text of this outcome is not kept')
  }
}

export interface TextOptions extends Pick<CallOptions, 'numbers' | 'exclude' | 'clickWindow' | 'country' | 'lineType' | 'convert' | 'withdraw'> {
  /** How long a code names the visitor it was given to, in milliseconds. Defaults to 30 days. */
  codeLife?: number
  /** The step a counted text is recorded as. Defaults to `text`. */
  stage?: string
}

export interface RecordedText {
  subject: Subject
  flags: TextFlag[]
  /** Whether it was counted as an outcome. */
  counted: boolean
  /** The visitor it was tied to. The two are now linked. */
  visitor?: Subject
  /** The text had been recorded before, and nothing was written. */
  duplicate: boolean
}

const DAY = 86_400_000
/** How long a conversation may be silent before the next text begins another. */
const QUIET = 30 * DAY
const BUCKET = 5 * 60_000
const SLACK = 30_000
const TOLL_FREE = /^\+18(00|33|44|55|66|77|88)\d{7}$/
/** Letters and digits that are not taken for one another when someone types them. */
const LETTERS = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE = new RegExp(`^[${LETTERS}]{6}$`)
/** The code as the site writes it. The word before it is what tells it from any other six letters. */
const WRITTEN = new RegExp(`(?:^|[^\\p{L}\\p{N}])ref[\\s:.#]*([${LETTERS}]{6})(?![\\p{L}\\p{N}])`, 'giu')
const OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'])
const IN = new Set(['START', 'UNSTOP'])

/** A new code for a visitor: six characters, easy to read out and to type. */
export const textCode = (): string => Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('')

/** The note a code leaves on the visitor it was given to. It links nothing. */
export function codeNote(code: string): Identifier {
  if (!CODE.test(code)) throw malformed('A code is six letters and digits')
  return `dialed:code-${code}`
}

/** The note left on a visitor who tapped a text link. A call does not find it, and a tap on a phone link leaves another. */
export function texted(number: string, at: number, country?: string): Identifier {
  if (!Number.isSafeInteger(at)) throw malformed('A tap requires `at`, an integer in epoch milliseconds')
  return `dialed:text-${normalizePhone(number, country)}@${Math.floor(at / BUCKET)}`
}

/** The code in a text, or undefined. */
export function codeIn(text: string): string | undefined {
  // The site writes it last, so a reference someone put in the message before it is not taken for it.
  return [...text.slice(0, 5_000).matchAll(WRITTEN)].at(-1)?.[1]?.toUpperCase()
}

/** What a text that is one word says about being texted, by the words carriers act on. */
function wish(text: string): 'opt_out' | 'opt_in' | undefined {
  const word = text.trim().replace(/[.!]+$/, '').toUpperCase()
  return OUT.has(word) ? 'opt_out' : IN.has(word) ? 'opt_in' : spanishStop(text) ? 'opt_out' : undefined
}

/**
 * Records a text message. The sender becomes the subject a call from their
 * number would be, so an account with that number is tied to both. A code
 * your site put in the text ties it to the one visitor who was given it;
 * without one, a tap on your text link just before does. The first text of a
 * conversation is an outcome. What a text says is never kept.
 */
export async function recordText(graph: Graph, text: Text, options: TextOptions = {}): Promise<RecordedText> {
  if (typeof text?.id !== 'string' || !/^[\w.-]{1,128}$/.test(text.id)) throw malformed('A text requires an id of letters, digits, dots, dashes or underscores')
  if (!Number.isSafeInteger(text.at)) throw malformed(`Text "${text.id}" requires "at", an integer in epoch milliseconds`)
  if (text.direction !== undefined && text.direction !== 'inbound' && text.direction !== 'outbound') throw malformed(`Text "${text.id}" requires its direction, inbound or outbound`)
  for (const name of ['from', 'to'] as const) if (typeof text[name] !== 'string') throw malformed(`Text "${text.id}" requires "${name}", a phone number`)
  for (const name of ['text', 'code'] as const) if (text[name] !== undefined && typeof text[name] !== 'string') throw malformed(`Text "${text.id}" requires its ${name} as a string`)
  const { id, at } = text
  const outbound = text.direction === 'outbound'
  const tags = checkTags(text.tags, `Text "${id}"`)
  const ours = normalizePhone(outbound ? text.from : text.to, options.country)
  let theirs: string | undefined
  try {
    theirs = normalizePhone(outbound ? text.to : text.from, options.country)
  } catch {}
  // A short code or a name is a program's, and there is nobody to tie it to.
  if (theirs === undefined || (options.exclude ?? []).some((each) => numberOrSelf(each, options.country) === theirs)) return { subject: `text:${id}`, flags: ['left_out'], counted: false, duplicate: false }
  const subject = `caller:${hashPhone(theirs)}`
  const before = await graph.keptText(id)
  if (before && before.direction !== (outbound ? 'outbound' : 'inbound')) throw malformed(`Text "${id}" is already recorded as ${before.direction}`)
  if (before || outbound) {
    if (!before) await graph.keepText({ id, direction: 'outbound', subject, at, to: ours, flags: [], ...(tags && { tags }) })
    // Settled again, in case the report before was cut off after it was kept.
    const { first, counted } = await settle(graph, before?.subject ?? subject, options, before?.subject === subject && !outbound ? { id, ...(!TOLL_FREE.test(theirs) && { phone: theirs }) } : undefined)
    return { subject: before?.subject ?? subject, flags: [...(first.has(id) ? (['first'] as const) : []), ...((before?.flags ?? []) as TextFlag[])], counted: counted.has(id), ...(before?.visitor && { visitor: before.visitor }), duplicate: Boolean(before) }
  }

  const flags: TextFlag[] = []
  const said = text.text === undefined ? undefined : wish(text.text)
  if (said) flags.push(said)
  const tollFree = TOLL_FREE.test(theirs)
  if (tollFree) flags.push('toll_free')
  if (!tollFree) {
    const line = options.lineType ? await options.lineType(theirs).catch(() => undefined) : undefined
    const phone = phoneOfType(theirs, line?.type)
    if (phone) await graph.observe({ subject, identifiers: [phone], at, event: 'text' })
  }
  const visitor = said ? undefined : await tie(graph, { id, at, subject, ours, text, flags }, options)

  const channel = Object.entries(options.numbers ?? {}).find(([number]) => numberOrSelf(number, options.country) === ours)?.[1]
  // As with a call, a visitor's own arrival says more than the number does.
  const custom = channel && checkTags(channel.tags, `Number "${ours}"`)
  const touch = !said && channel && !visitor && { subject, at, source: channel.source, medium: 'text', ...(channel.campaign && { campaign: channel.campaign }), ...(channel.campaignId && { campaignId: channel.campaignId }), ...(custom && { custom }), landing: `sms:${ours}` }
  // Reported twice at once, the first to be kept stands.
  const kept = await graph.keepText({ id, direction: 'inbound', subject, at, to: ours, flags, ...(visitor && { visitor }), ...(tags && { tags }) }, touch || undefined)
  const { first, counted } = await settle(graph, subject, options, { id, ...(!tollFree && { phone: theirs }) })
  return { subject, flags: [...(first.has(id) ? (['first'] as const) : []), ...flags], counted: counted.has(id), ...(visitor && { visitor }), duplicate: !kept }
}

/** Whether a text asks for a reply: it came to you, and is no word about being texted. */
export const asks = (text: Pick<KeptText, 'direction' | 'flags'>): boolean => text.direction === 'inbound' && !text.flags.includes('opt_out') && !text.flags.includes('opt_in')

/** The texts of one sender that begin a conversation: those to you with no text either way in the thirty days before. The same whatever order they were reported in. */
export function beginnings(texts: readonly KeptText[]): Set<string> {
  const all = [...texts].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
  return new Set(all.filter((each, i) => asks(each) && !(i > 0 && all[i - 1]!.at > each.at - QUIET)).map((each) => each.id))
}

/**
 * Brings a sender's outcomes in line with the texts that are kept of them: one for each conversation, and none for a text
 * that turned out to be in the middle of one. Safe to run again, and from two places at once. `now` has the phone number
 * of the text being recorded, which is not kept. Resolves to the texts that begin a conversation, and those counted.
 */
async function settle(graph: Graph, subject: Subject, options: TextOptions, now?: { id: string; phone?: string }): Promise<{ first: Set<string>; counted: Set<string> }> {
  const withdraw = options.withdraw ?? graph.withdraw
  const made = new Set<string>()
  for (;;) {
    const texts = await graph.textsOf([subject])
    const first = beginnings(texts)
    const counted = new Set<string>()
    const not = await graph.notLeads(texts.map((each) => `text:${each.id}`))
    for (const each of texts) {
      const transactionId = `text:${each.id}`
      if (each.direction === 'outbound') continue
      const there = Boolean(await graph.outcomeOf(transactionId))
      // Said to be no lead, it is not counted anew. What was counted stays on record, and counts nowhere.
      if (not.has(transactionId)) continue
      if (!first.has(each.id)) {
        if (there) await withdraw(transactionId)
        continue
      }
      if (!there) {
        const phone = each.id === now?.id ? now.phone : undefined
        const outcome: Outcome = { transactionId, subject, at: each.at, stage: options.stage ?? 'text', source: 'MESSAGE', ofText: each.id, ...(phone && { phone }), ...(each.tags && { tags: each.tags }) }
        try {
          await (options.convert ?? ((given: Outcome) => graph.outcome(given)))(outcome)
        } catch (error) {
          // Forgotten meanwhile. The texts are read again below.
          if (!(error instanceof Gone)) throw error
          continue
        }
        made.add(each.id)
      }
      counted.add(each.id)
    }
    // A text that came meanwhile is settled too, and one that was forgotten meanwhile leaves nothing behind.
    const since = new Set((await graph.textsOf([subject])).map((each) => each.id))
    // Unless the id has since been kept for somebody else, whose outcome it then is.
    for (const id of made) if (!since.has(id) && !(await graph.keptText(id))) await withdraw(`text:${id}`)
    if (since.size === texts.length && texts.every((each) => since.has(each.id))) return { first, counted }
  }
}

/** Ties a text to the visitor its code was given to, or else to the one who tapped the number just before. */
async function tie(graph: Graph, { id, at, subject, ours, text, flags }: { id: string; at: number; subject: Subject; ours: string; text: Text; flags: TextFlag[] }, options: TextOptions): Promise<Subject | undefined> {
  const given = text.code?.trim().toUpperCase() ?? (text.text === undefined ? undefined : codeIn(text.text))
  const code = given !== undefined && CODE.test(given) ? given : undefined
  if (code) {
    const note = codeNote(code)
    const life = options.codeLife ?? 30 * DAY
    const holders = (await graph.holders([note])).filter((edge) => edge.first <= at + SLACK && edge.last >= at - life)
    const [edge] = holders
    if (edge && holders.length === 1) {
      // The code has said whose it is, so a tap of somebody else's is not looked for. A visitor already tied to another
      // sender or caller is not tied to this one too: the two would become one person.
      const tied = await graph.tieCall(subject, edge.subject, `text:${id}`, at, { notes: [note] })
      flags.push(tied ? 'code' : 'taken')
      return tied ? edge.subject : undefined
    }
  }
  const window = options.clickWindow ?? 3 * 60_000
  const notes: Identifier[] = []
  for (let bucket = Math.floor((at - window) / BUCKET); bucket <= Math.floor((at + SLACK) / BUCKET); bucket++) notes.push(`dialed:text-${ours}@${bucket}`)
  const taps = (await graph.holders(notes)).filter((edge) => edge.last >= at - window && edge.first <= at + SLACK)
  const visitors = [...new Set(taps.map((edge) => edge.subject))]
  if (visitors.length > 1) flags.push('ambiguous')
  if (visitors.length !== 1 || !(await graph.tieCall(subject, visitors[0]!, `dial:text-${id}`, at, { notes }))) return undefined
  flags.push('tap')
  return visitors[0]
}

/**
 * What became of a text to you, from every text and call with its sender: a
 * text from you or a call someone answered replies to it, and a later STOP
 * means nobody may. Worked out each time, so it does not depend on the order
 * things were reported in.
 */
export function replyTo(text: KeptText, texts: readonly KeptText[], calls: readonly KeptCall[]): TextReply {
  const replies = [
    ...texts.filter((each) => each.direction === 'outbound' && each.at > text.at).map((each) => ({ at: each.at, by: each.id, how: 'text' as const })),
    ...calls.filter((each) => each.result?.answered && each.at > text.at).map((each) => ({ at: each.at, by: each.id, how: 'call' as const })),
  ].sort((x, y) => x.at - y.at || (x.by < y.by ? -1 : 1))
  const stopped = texts.filter((each) => each.flags.includes('opt_out') && each.at > text.at).sort((x, y) => x.at - y.at)[0]
  const [first] = replies
  if (first && !(stopped && stopped.at < first.at)) return { state: 'replied', by: first.by, how: first.how, delay: first.at - text.at }
  return { state: stopped ? 'stopped' : 'open' }
}
