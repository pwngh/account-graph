import type { DecideRequest, EventsRequest, ForgetRequest, LookupRequest, RecordRequest, ReportRequest } from './api.ts'
import { FAULT_CODES, fault, malformed } from './fault.ts'
import { sized } from './json.ts'

type Check = (value: unknown, path: string) => void
const bad = (path: string, what: string) => malformed(`${path} ${what}`, { path })

const string = (least = 1, most = 512, what?: RegExp): Check => (value, path) => {
  if (typeof value !== 'string' || value.length < least || value.length > most || (what && !what.test(value))) throw bad(path, what ? 'is malformed' : `must be a string of ${least} to ${most} characters`)
}
/** An index takes so many bytes and no more, whatever the characters. */
const bytes = (most: number): Check => (value, path) => {
  if (new TextEncoder().encode(value as string).length > most) throw bad(path, `must be at most ${most} bytes`)
}
const number = (least: number, most: number, what = `a number from ${least} to ${most}`): Check => (value, path) => {
  if (typeof value !== 'number' || !(value >= least && value <= most)) throw bad(path, `must be ${what}`)
}
const integer = (least: number, most: number): Check => (value, path) => {
  if (!Number.isSafeInteger(value) || (value as number) < least || (value as number) > most) throw bad(path, `must be an integer from ${least} to ${most}`)
}
const boolean: Check = (value, path) => {
  if (typeof value !== 'boolean') throw bad(path, 'must be true or false')
}
const oneOf = (...allowed: readonly unknown[]): Check => (value, path) => {
  if (!allowed.includes(value)) throw bad(path, `must be ${allowed.map((each) => JSON.stringify(each)).join(' or ')}`)
}
const list = (each: Check, least: number, most: number): Check => (value, path) => {
  if (!Array.isArray(value) || value.length < least || value.length > most) throw bad(path, `must be a list of ${least} to ${most}`)
  value.forEach((item, i) => each(item, `${path}[${i}]`))
}
const object: (value: unknown, path: string) => asserts value is Record<string, unknown> = (value, path) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad(path, 'must be an object')
}
/** An object with these fields and no others. A name that ends in `?` may be left out. */
const shape = (fields: Record<string, Check>): Check => {
  const known = new Map(Object.entries(fields).map(([name, check]) => [name.replace(/\?$/, ''), { check, optional: name.endsWith('?') }]))
  return (value, path) => {
    object(value, path)
    for (const name of Object.keys(value)) if (!known.has(name)) throw bad(`${path}.${name}`, 'is not a known field')
    for (const [name, { check, optional }] of known) {
      if (Object.hasOwn(value, name)) check(value[name], `${path}.${name}`)
      else if (!optional) throw bad(`${path}.${name}`, 'is required')
    }
  }
}
/** One of several shapes, told apart by the value of one field. */
const byField = (field: string, shapes: Record<string, Check>): Check => (value, path) => {
  object(value, path)
  const which = value[field]
  if (typeof which !== 'string' || !Object.hasOwn(shapes, which)) throw bad(`${path}.${field}`, `must be ${Object.keys(shapes).map((each) => JSON.stringify(each)).join(' or ')}`)
  shapes[which]!(value, path)
}
const map = (each: Check, most: number, name: RegExp = /^[\w.-]{1,64}$/): Check => (value, path) => {
  object(value, path)
  const entries = Object.entries(value)
  if (entries.length > most) throw bad(path, `must have at most ${most} entries`)
  for (const [key, item] of entries) {
    if (!name.test(key)) throw bad(`${path}.${key}`, 'has a name that is malformed')
    each(item, `${path}.${key}`)
  }
}
const any: Check = () => {}
const both = (...checks: Check[]): Check => (value, path) => checks.forEach((check) => check(value, path))

const at = integer(0, 8_640_000_000_000_000)
const key = string(1, 200)
/** The ids of calls and texts name things in the graph, so they are plainer than other keys. */
const providerId = string(1, 128, /^[\w.-]+$/)
/** What the graph files its own outcomes under. */
const conversionKey: Check = (value, path) => {
  key(value, path)
  if (/^(call|text|page):/.test(value as string)) throw bad(path, 'cannot begin with call:, text: or page:')
}
const subject: Check = (value, path) => {
  string(1, 512)(value, path)
  bytes(512)(value, path)
  if (value !== (value as string).trim()) throw bad(path, 'must have no space around it')
}
const text = string(1, 2048)
/** Some of what is looked up whole. */
const click: Check = (value, path) => {
  text(value, path)
  bytes(2048)(value, path)
}
const own: Check = (value, path) => {
  string(3, 1024, /^[^:]+:\s*\S/s)(value, path)
  bytes(1024)(value, path)
}
const short = string(1, 200)
const name = string(1, 64, /^[\w.-]+$/)
const currency = string(3, 3, /^[A-Za-z]{3}$/)
const money = number(0, 1e10)
const phone = string(1, 64)
const device = string(1, 128, /^[\w.-]+$/)
const tags = map(string(1, 64), 8)
const consent = shape({ adUserData: boolean, adPersonalization: boolean })
const day = string(10, 10, /^\d{4}-\d{2}-\d{2}$/)
const timeZone: Check = (value, path) => {
  string(1, 64)(value, path)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value as string })
  } catch {
    throw bad(path, 'must be a time zone, such as America/New_York')
  }
}
const window = shape({ from: day, to: day, timeZone })
const known = shape({
    'email?': string(3, 512), 'phone?': phone, 'device?': device, 'ip?': string(2, 64),
    'address?': shape({ street: text, 'street2?': text, 'secondary?': short, 'city?': short, 'state?': short, 'zipcode?': short }),
    'name?': shape({ first: short, last: short }), 'dob?': day,
    'identifiers?': list(own, 1, 100),
})
const some = (what: string): Check => (value, path) => {
  if (Object.keys(value as object).length === 0) throw bad(path, `requires at least one ${what}`)
}
const facts: Check = both(known, some('fact'))
const speaker: Check = both(shape({ 'device?': device, 'phone?': phone, 'email?': string(3, 512) }), some('fact'))
const callResult: Check = both(shape({ answered: boolean, 'voicemail?': boolean, 'waited?': number(0, 1e7) }), (value, path) => {
  const { answered, voicemail } = value as { answered: boolean; voicemail?: boolean }
  if (answered && voicemail) throw bad(path, 'cannot be answered by a person and go to voicemail')
})

const recordedParty: Check = both(subject, (value, path) => {
  if (/^(visitor|caller|call):/.test(value as string)) throw bad(path, 'must name a record')
})
const signedParty = { kind: any, role: any, by: both(string(1, 100), (value, path) => {
  if (!(value as string).trim()) throw bad(path, 'must name who said it')
}) }
const namedParty = shape({ ...signedParty, subject: recordedParty })
const party = byField('role', { self: namedParty, representative: namedParty, excluded: namedParty, unknown: shape(signedParty) })

const entry = (fields: Record<string, Check>, keyed: Check = key) => shape({ type: any, key: keyed, at, ...fields })
const ENTRIES: Record<string, Check> = {
  profile: both(entry({ subject, facts: known, 'event?': short, 'speaker?': speaker }), (value, path) => {
    const { facts: given, speaker: by } = value as { facts: object; speaker?: object }
    if (!by) some('fact')(given, `${path}.facts`)
  }),
  arrival: entry({
    subject, 'source?': text, 'medium?': text, 'campaign?': text, 'campaignId?': text, 'adGroupId?': text, 'adId?': text, 'term?': text, 'content?': text, 'landing?': text, 'referrer?': text,
    'clicks?': shape({ 'gclid?': click, 'gbraid?': click, 'wbraid?': click, 'fbclid?': click, 'fbp?': click, 'msclkid?': click, 'ttclid?': click }), 'custom?': map(string(1, 256), 10),
  }),
  cost: entry({ rows: list(shape({ day, source: short, amount: money, currency, 'campaignId?': short, 'campaign?': text, 'clicks?': integer(0, 1e12), 'impressions?': integer(0, 1e12), 'conversions?': number(0, 1e12), 'conversionValue?': number(-1e15, 1e15) }), 1, 5000) }),
  conversion: entry({ subject, stage: short, 'value?': money, 'currency?': currency, 'actions?': map(short, 20), 'channel?': oneOf('WEB', 'APP', 'IN_STORE', 'PHONE', 'MESSAGE', 'OTHER'), 'email?': string(3, 512), 'phone?': phone, 'consent?': consent, 'tags?': tags }, conversionKey),
  restatement: entry({
    of: shape({ type: oneOf('conversion', 'call', 'text'), key }),
    change: byField('kind', {
      correct: shape({ kind: any, value: money, 'currency?': currency }),
      refund: shape({ kind: any, amount: money, 'currency?': currency }),
      write_off: shape({ kind: any, amount: money, 'currency?': currency }),
      reverse: shape({ kind: any, restatement: key }),
      not_lead: shape({ kind: any, why: oneOf('spam', 'other') }),
      lead: shape({ kind: any }),
    }),
  }),
  payment: entry({ conversion: key, direction: oneOf('received', 'refunded'), amount: number(1e-5, 1e10), 'currency?': currency }),
  call: entry({ direction: oneOf('inbound', 'outbound'), 'from?': phone, to: phone, 'duration?': number(0, 1e7), 'result?': callResult, 'code?': string(1, 64), 'tags?': tags }, providerId),
  call_update: entry({ call: providerId, change: byField('kind', { result: shape({ kind: any, result: callResult }), returned: shape({ kind: any, reachedAt: at }), not_returned: shape({ kind: any }), party }) }),
  text: entry({ direction: oneOf('inbound', 'outbound'), from: phone, to: phone, 'text?': string(0, 20_000), 'code?': string(1, 64), 'tags?': tags }, providerId),
  consent: entry({ subject, consent, 'source?': short }),
  link: entry({ subject, url: text, expires: at, 'purpose?': name }, string(1, 200, /^[^\r\n]+$/)),
  transfer: entry({ from: subject, to: subject, amount: integer(1, Number.MAX_SAFE_INTEGER), 'asset?': short }),
}

const REQUEST = {
  record: (value: unknown, path: string) => {
    const { entries } = value as { entries?: unknown }
    if (Array.isArray(entries) && entries.length > 100) throw fault(FAULT_CODES.INPUT.TOO_LARGE, 'A request records at most 100 entries')
    shape({ entries: list(byField('type', ENTRIES), 1, 100) })(value, path)
  },
  decide: byField('action', (() => {
    const deciding = { key, at, by: string(1, 100), 'reason?': string(1, 1000), 'seen?': integer(0, Number.MAX_SAFE_INTEGER), action: any }
    const pairs = shape({ ...deciding, pairs: list(shape({ a: subject, b: subject, 'reason?': string(1, 1000) }), 1, 1000) })
    const fact: Check = (value, path) => {
      object(value, path)
      if (Object.keys(value).length !== 1) throw bad(path, 'requires one fact')
      shape({ 'email?': string(3, 512), 'phone?': phone, 'ip?': string(2, 64), 'identifier?': own })(value, path)
    }
    const muting = shape({ ...deciding, fact })
    return { merge: pairs, unmerge: pairs, split: pairs, unsplit: pairs, mute: muting, unmute: muting }
  })()),
  forget: shape({ key, at, by: string(1, 100), 'reason?': string(1, 1000), 'seen?': integer(0, Number.MAX_SAFE_INTEGER), subjects: list(subject, 1, 50), platforms: oneOf('report', 'retract') }),
  lookup: byField('kind', {
    person: shape({ kind: any, subjects: list(subject, 1, 100), at }),
    journey: shape({ kind: any, subject, 'before?': integer(0, Number.MAX_SAFE_INTEGER) }),
    find: shape({ kind: any, text: string(1, 512) }),
    match: shape({ kind: any, facts, at }),
    caller: shape({ kind: any, 'from?': phone, to: phone, at }),
    conflicts: shape({ kind: any, subjects: list(subject, 1, 50) }),
    record: shape({ kind: any, type: oneOf('conversion', 'call', 'text'), key, at }),
    transfers: shape({ kind: any, subject, 'tiedOnly?': boolean }),
  }),
  report: byField('kind', {
    campaigns: shape({ kind: any, window, 'by?': short, 'per?': short }),
    pipeline: shape({ kind: any, at, days: integer(1, 365) }),
    calls: shape({ kind: any, window, at }),
    callbacks: shape({ kind: any, window, at, 'after?': short }),
    texts: shape({ kind: any, window, at, 'after?': short }),
    after_calls: shape({ kind: any, window, at, step: short, days: integer(1, 365) }),
    deliveries: shape({ kind: any, state: oneOf('held', 'pending', 'sent', 'skipped', 'failed') }),
  }),
  events: shape({ after: (value, path) => value === null || string(1, 200)(value, path), limit: integer(1, 1000) }),
} satisfies Record<string, Check>

export interface Requests {
  record: RecordRequest
  decide: DecideRequest
  forget: ForgetRequest
  lookup: LookupRequest
  report: ReportRequest
  events: EventsRequest
}
export type CallName = keyof Requests
export const CALLS = Object.keys(REQUEST) as CallName[]

/** The request as JSON would carry it, if it is one. Throws a fault otherwise. */
export function checked<N extends CallName>(call: N, request: unknown): Requests[N] {
  const copy = sized(request)
  object(copy, 'request')
  REQUEST[call](copy, 'request')
  return copy as unknown as Requests[N]
}
