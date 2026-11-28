import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { LeadSource, RecordEntry, RecordResponse } from '../contract/api.ts'
import { FAULT_CODES, fault, isFault, malformed } from '../contract/fault.ts'
import { canonical } from '../contract/json.ts'
import { leadPath, leadPrefix } from '../contract/lead-settings.ts'
import { asFault } from '../client/faults.ts'
import { normalizePhone, UNSTORABLE } from '../core/identifiers.ts'

/** `paidUpTo` caps what one payment source pays one conversion, over all its payments. */
export type RecordLead = (entries: readonly RecordEntry[], paidUpTo?: { prefix: string, amount: number }) => Promise<RecordResponse>

/** An ID posted again with other details, or for another subject or payment. Answered 409. */
export class LeadConflict extends Error {}

export async function leadBody(request: IncomingMessage): Promise<Buffer> {
  const limit = 65_536
  // The rest is never read. The 413 is written, then the connection is closed.
  const tooLarge = () => fault(FAULT_CODES.INPUT.TOO_LARGE, 'Body exceeds 64 KiB')
  if (Number(request.headers['content-length']) > limit) throw tooLarge()
  let size = 0
  const chunks: Buffer[] = []
  // The socket stays open until the 413 is written and the sender has had time to read it.
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > limit) throw tooLarge()
      chunks.push(chunk)
    }
  } catch (error) {
    if (isFault(error)) throw error
    throw malformed('Cannot read the lead body')
  }
  return Buffer.concat(chunks)
}

export function signedLead(request: IncomingMessage, raw: Buffer, { auth, secret }: LeadSource): boolean {
  const header = auth === 'bearer' ? 'authorization' : auth.header.toLowerCase()
  const values = request.headersDistinct[header]
  if (values?.length !== 1) return false
  const value = values[0]!
  if (auth === 'bearer') {
    // The scheme is case-insensitive, so `bearer` and `BEARER` are the same.
    const token = /^bearer +(.+)$/i.exec(value)?.[1] ?? ''
    const digest = (text: string) => createHash('sha256').update(text).digest()
    return timingSafeEqual(digest(token), digest(secret))
  }
  const mac = createHmac('sha256', secret).update(raw).digest()
  // Senders write the same digest as `sha256=<hex>`, in either case, in base64url, or without base64 padding.
  // The whole text is compared, because Buffer's hex and base64 decoders can silently discard trailing bytes.
  const given = value.replace(/^sha256=/i, '')
  const [supplied, expected] = (auth.encoding === 'hex' ? [given.toLowerCase(), mac.toString('hex')] : [given.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''), mac.toString('base64').replace(/=+$/, '')]).map(text => Buffer.from(text)) as [Buffer, Buffer]
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function fields(raw: Buffer, media: string | undefined): (path: string) => unknown {
  try {
    const body = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    const type = media?.split(';')[0]?.trim().toLowerCase()
    if (type === 'application/json') {
      const json: unknown = JSON.parse(body)
      if (json && typeof json === 'object' && !Array.isArray(json)) return path => {
        let value: unknown = json
        for (const part of leadPath(path)) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, part) || (Array.isArray(value) && !/^\d+$/.test(part))) return undefined
          value = (value as Record<string, unknown>)[part]
        }
        return value
      }
    }
    if (type === 'application/x-www-form-urlencoded') {
      const form = new Map<string, string[]>()
      const decode = (part: string) => decodeURIComponent(part.replace(/\+/g, ' '))
      for (const pair of body.split('&')) {
        const equals = pair.indexOf('=')
        const key = decode(equals < 0 ? pair : pair.slice(0, equals))
        const value = decode(equals < 0 ? '' : pair.slice(equals + 1))
        const field = key.replace(/\[\]$/, '').replace(/\[([\w-]+)\]/g, '.$1')
        const values = form.get(field)
        if (values) values.push(value)
        else form.set(field, [value])
      }
      return path => {
        const parts = leadPath(path)
        const values = form.get(parts.join('.'))
        if (values) return values.length === 1 ? values[0] : undefined
        const index = parts.pop()!
        if (/^(0|[1-9]\d*)$/.test(index)) return form.get(parts.join('.'))?.[Number(index)]
      }
    }
  } catch {
    // Parser errors may quote the sender's transcript.
  }
  throw malformed('The lead body must be a UTF-8 JSON object or a URL-encoded form')
}

const empty = (value: unknown) => value === undefined || value === null || value === ''

/** Below this a number is seconds: 1e11 seconds is the year 5138, while 1e11 milliseconds is March 1973. */
const SECONDS_BELOW = 1e11

/** One day ahead, as `record` allows a consent answer, covers a vendor's clock that runs fast. */
function timeOf(value: unknown, received: number): number {
  let at = NaN
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d{1,3})?$/.test(value))) {
    const given = Number(value)
    at = given < SECONDS_BELOW ? Math.round(given * 1000) : given
  } else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    // Date.parse rolls a nonexistent day into the next month.
    const day = value.slice(0, 10)
    const midnight = Date.parse(day + 'T00:00:00Z')
    if (Number.isFinite(midnight) && new Date(midnight).toISOString().startsWith(day)) at = Date.parse(value)
  }
  if (!Number.isSafeInteger(at) || at <= 0 || at > received + 86_400_000) throw malformed('The lead time must be milliseconds since 1970 and at most one day ahead')
  return at
}

function mapLead(name: string, source: LeadSource, get: (path: string) => unknown, received: number, country?: string) {
  const read = (field: keyof LeadSource['mapping']) => source.mapping[field] === undefined ? undefined : get(source.mapping[field])
  const vendorId = read('id')
  const id = Number.isSafeInteger(vendorId) ? String(vendorId) : vendorId
  if (typeof id !== 'string' || !/^[\w.-]{1,128}$/.test(id)) throw malformed('A vendor ID of 1 to 128 letters, digits, dots, dashes or underscores is required')
  const key = `lead:${name}:${id}`
  const time = read('at')
  const at = empty(time) ? received : timeOf(time, received)
  const entries: RecordEntry[] = []
  if (source.kind === 'payment') {
    const paid = read('amount')
    const amount = typeof paid === 'number' || (typeof paid === 'string' && /^\d+(?:\.\d+)?$/.test(paid)) ? Number(paid) : NaN
    const conversion = read('conversion')
    const currency = read('currency')
    // A payment source sets values, so it pays only the conversions it was given and only up to its own cap.
    if (!(amount >= 1e-5 && amount <= source.maxAmount!) || typeof conversion !== 'string' || !source.conversions!.some(prefix => conversion.startsWith(prefix + ':') && conversion.length > prefix.length + 1) || (source.mapping.currency !== undefined && (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)))) throw malformed('A payment needs an amount up to maxAmount, a conversion this source may pay, and a three-letter currency when the source maps one')
    entries.push({ type: 'payment', key, at, direction: 'received', amount, conversion, ...(typeof currency === 'string' && { currency }) })
  } else {
    const given = read('subject')
    const prefix = leadPrefix(name, source)
    // A form field can be edited by whoever fills it in, so by default a mapped subject stays among this source's own.
    const subject = empty(given) ? `${prefix}:${id}` : given
    if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw malformed('The lead subject must be text of 1 to 200 characters')
    if (!source.trustSubjects && !(subject.startsWith(prefix + ':') && /^[\w.:-]+$/.test(subject.slice(prefix.length + 1)))) throw malformed('The lead subject is outside this source')
    const text = (field: keyof LeadSource['mapping'], max: number) => {
      const value = read(field)
      return typeof value === 'string' && value.length <= max && !UNSTORABLE.test(value) ? value.trim() : ''
    }
    const device = text('device', 128)
    const email = text('email', 512)
    const first = text('first', 200)
    const last = text('last', 200)
    // A vendor that stores digits only sends a phone as a JSON number.
    const digits = read('phone')
    const number = typeof digits === 'number' && Number.isSafeInteger(digits) && digits > 0 ? String(digits) : text('phone', 64)
    let phone: string | undefined
    try {
      if (number) phone = normalizePhone(number, country)
    } catch {
      // A malformed optional contact field can accompany a usable one.
    }
    const facts = { ...(/^[\w.-]+$/.test(device) && { device }), ...(/^[^\s@]+@[^\s@]+$/.test(email) && { email }), ...(phone && { phone }), ...(first && last && { name: { first, last } }) }
    // With updates, each set of details is a profile of its own, so an update adds facts and a retry is a duplicate.
    // Without them, the ID names one profile, and other details under it are refused, because whoever can choose an ID could otherwise add to another person's lead.
    const details = source.updates ? createHmac('sha256', source.secret).update(`${id}\u0000${canonical(facts)}`).digest('base64url').slice(0, 22) : id
    // What they wrote in the form, where the mapping names it. It is kept as a copy to read back, and matches nothing.
    // A visitor who could name the record could write on somebody else's, so it is kept only on the record the vendor's ID makes, or where the source's subjects are trusted.
    const wrote = empty(given) || source.trustSubjects ? read('message') : undefined
    const message = typeof wrote === 'string' && wrote.trim() ? wrote.trim().slice(0, 20_000) : undefined
    if (Object.keys(facts).length) entries.push({ type: 'profile', key: `lead:${name}:${details}`, at, subject, facts, ...(message && { message }) }, { type: 'conversion', key, at, subject, stage: source.stage ?? 'inquiry' })
  }
  return entries
}

export async function acceptLead(name: string, source: LeadSource, raw: Buffer, media: string | undefined, received: number, country: string | undefined, record: RecordLead) {
  const entries = mapLead(name, source, fields(raw, media), received, country)
  // Nothing would be written, so the answer does not wait for the graph. A 503 would only bring the same post back.
  if (!entries.length) return { recorded: [], note: 'NO_FACT_USED' }
  const unavailable = () => fault(FAULT_CODES.GRAPH.UNAVAILABLE, 'The graph is not ready', { retryable: true })
  let response: RecordResponse
  try {
    response = await record(entries, source.kind === 'payment' ? { prefix: `lead:${name}:`, amount: source.maxAmount! } : undefined)
  } catch (error) {
    const known = asFault(error)
    if (known.code === FAULT_CODES.INPUT.MALFORMED) throw malformed('The mapped lead fields do not form a valid record')
    // A driver error can quote the row. A retry with the same ID is safe even after a lost commit.
    throw unavailable()
  }
  const recorded: string[] = []
  for (const result of response.results) {
    if (!result.ok) {
      if (result.reason === 'NOT_ATTEMPTED') throw unavailable()
      if (result.reason === 'FORGOTTEN' || result.reason === 'NO_FACT_USED') return { recorded: [], note: result.reason }
      if (result.reason === 'KEY_REUSED') throw new LeadConflict('This ID was already posted with other details')
      if ((result.reason as string) === 'OVER_CAP') throw malformed('Payments to this conversion would exceed maxAmount')
      throw malformed(result.reason)
    }
    if (!result.value.duplicate) recorded.push(result.type)
  }
  return { recorded, duplicate: !recorded.length }
}
