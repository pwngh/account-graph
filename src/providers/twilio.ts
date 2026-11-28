/**
 * Reads the calls Twilio reports to a status callback, and checks that a
 * request came from Twilio.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 * https://www.twilio.com/docs/voice/twiml#request-parameters
 */
import type { LineType, LineTypeLookup } from '../core/ports.ts'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Call } from '../core/calls.ts'
import type { Text } from '../core/texts.ts'

/**
 * The signature Twilio puts in `X-Twilio-Signature`: the address it called,
 * followed by every posted field's name and value in name order, signed
 * with the account's auth token.
 */
export function twilioSignature(authToken: string, url: string, fields: Readonly<Record<string, string>>): string {
  const signed = Object.keys(fields).sort().reduce((text, name) => text + name + fields[name], url)
  return createHmac('sha1', authToken).update(signed, 'utf8').digest('base64')
}

/** Whether a request carries the signature Twilio would have given it. `url` is the address exactly as set in Twilio. */
export function fromTwilio(authToken: string, url: string, fields: Readonly<Record<string, string>>, signature: string | undefined): boolean {
  const expected = Buffer.from(twilioSignature(authToken, url, fields))
  const given = Buffer.from(signature ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The statuses a call ends in. Twilio reports the others while it is still ringing or in progress. */
const ENDED = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])

/**
 * The call a status callback reports, or undefined while the call is still
 * going or when it was one your account placed. `now` stands in when Twilio
 * sent no timestamp.
 */
export function twilioCall(fields: Readonly<Record<string, string>>, now: number): Call | undefined {
  if (!fields.CallSid || !fields.To || !ENDED.has(fields.CallStatus ?? '')) return undefined
  if (fields.Direction && fields.Direction !== 'inbound') return undefined
  const duration = fields.CallStatus === 'completed' ? Number(fields.CallDuration ?? 0) || 0 : 0
  // The callback comes when the call ends, and the timestamp is that moment.
  const ended = Date.parse(fields.Timestamp ?? '')
  return {
    id: fields.CallSid,
    to: fields.To,
    ...(fields.From && { from: fields.From }),
    at: (Number.isNaN(ended) ? now : ended) - duration * 1000,
    duration,
    // Anything but "completed" never connected. "completed" only says the phone system picked up, so it answers nothing.
    ...(fields.CallStatus !== 'completed' && { answered: false }),
    // Twilio sends these where the account has caller name lookup on, and for numbers it can place.
    ...((fields.CallerName || fields.FromCity || fields.FromState) && { caller: { ...(fields.CallerName && { name: fields.CallerName.slice(0, 120) }), ...((fields.FromCity || fields.FromState) && { place: [fields.FromCity, fields.FromState].filter(Boolean).join(', ').slice(0, 120) }) } }),
  }
}

/**
 * What a recording status callback says: which call, the recording's ID at Twilio, and how it stands.
 * Undefined for a callback that is not of a recording. The address of the audio is left where it is.
 */
export function twilioRecording(fields: Readonly<Record<string, string>>, now: number): { call: string; id: string; state: 'in_progress' | 'completed' | 'absent'; at: number } | undefined {
  const state = ({ 'in-progress': 'in_progress', completed: 'completed', absent: 'absent' } as const)[fields.RecordingStatus ?? '']
  if (!fields.RecordingSid || !fields.CallSid || !state) return undefined
  const said = Date.parse(fields.Timestamp ?? '')
  return { call: fields.CallSid, id: fields.RecordingSid, state, at: Number.isNaN(said) ? now : said }
}

/** The text an incoming message webhook reports, or undefined for a status report of one you sent. `now` is its time, which Twilio does not send. */
export function twilioText(fields: Readonly<Record<string, string>>, now: number): Text | undefined {
  if (!fields.MessageSid || !fields.From || !fields.To || (fields.SmsStatus ?? 'received') !== 'received' || !['received', 'receiving'].includes(fields.MessageStatus ?? 'received')) return undefined
  return { id: fields.MessageSid, from: fields.From, to: fields.To, at: now, text: fields.Body ?? '' }
}

export interface LookupOptions {
  /** The account's SID, or an API key's SID. */
  accountSid: string
  /** The account's auth token, or the API key's secret. */
  authToken: string
  /** How many answers to keep. Defaults to 10,000. A number's line rarely changes, so each is kept for thirty days. */
  cache?: number
  fetch?: typeof fetch
  now?: () => number
}

/**
 * Returns a function that asks Twilio what kind of line a number in E.164
 * form is. It resolves to undefined for a number Twilio does not know, and
 * throws when the account is refused or the service fails. Each new number
 * is a paid lookup.
 * https://www.twilio.com/docs/lookup/v2-api/line-type-intelligence
 */
export function createLineTypeLookup(options: LookupOptions): LineTypeLookup {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const limit = options.cache ?? 10_000
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`
  const cache = new Map<string, { line: LineType | undefined; until: number }>()
  return async (number) => {
    const hit = cache.get(number)
    if (hit && hit.until > now()) return hit.line
    const response = await fetcher(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(number)}?Fields=line_type_intelligence`, {
      headers: { authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    let line: LineType | undefined
    let settled = true
    if (response.ok) {
      const body = await response.json()
      const found = body?.line_type_intelligence
      // An error inside the answer, such as a country that needs approval, may clear up, so it is not remembered.
      // A line Twilio knows no type of is an answer, and one that is asked again each time is paid for each time.
      settled = body?.valid !== false && found !== null && typeof found === 'object' && !found.error_code && 'type' in found
      line = { type: settled && typeof found.type === 'string' && found.type.trim() ? found.type : 'unknown', carrier: found?.carrier_name ?? undefined }
    } else if (response.status !== 404) throw new Error(`Twilio rejected the lookup with ${response.status}: ${(await response.text()).slice(0, 200)}`)
    if (settled) {
      if (cache.size >= limit) cache.delete(cache.keys().next().value!)
      cache.set(number, { line, until: now() + 30 * 86_400_000 })
    }
    return line
  }
}

export type { LineType, LineTypeLookup }
