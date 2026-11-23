/**
 * Reads the calls Twilio reports to a status callback, and checks that a
 * request really came from Twilio.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 * https://www.twilio.com/docs/voice/twiml#request-parameters
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Call } from '../calls.ts'

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
  }
}
