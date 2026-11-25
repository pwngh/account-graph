/**
 * Confirms a Fingerprint identification with Fingerprint's Server API.
 * The browser reports only an event id; the visitor id comes from the
 * vendor, so a page cannot claim someone else's fingerprint.
 * https://docs.fingerprint.com/reference/getevent
 */
import type { FingerprintVerifier, VerifiedFingerprint } from '../core/ports.ts'

export interface FingerprintOptions {
  /** The workspace's secret API key. Never ship it to a browser. */
  secretKey: string
  /** The workspace's region. Defaults to `us`. */
  region?: 'us' | 'eu' | 'ap'
  fetch?: typeof fetch
}

const HOSTS = { us: 'api.fpjs.io', eu: 'eu.api.fpjs.io', ap: 'ap.api.fpjs.io' }

/**
 * Returns a function that looks an event up. It resolves to undefined when
 * Fingerprint has no such event, and throws when the key is refused or the
 * service fails, so a visit is never recorded with an unchecked id.
 */
export function createFingerprintVerifier(options: FingerprintOptions): FingerprintVerifier {
  const fetcher = options.fetch ?? fetch
  const base = `https://${HOSTS[options.region ?? 'us']}/v4/events/`
  return async (eventId) => {
    if (!/^[\w.-]{1,128}$/.test(eventId)) return undefined
    const response = await fetcher(base + encodeURIComponent(eventId), {
      headers: { authorization: `Bearer ${options.secretKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404 || response.status === 400) return undefined
    if (!response.ok) throw new Error(`Fingerprint rejected the lookup with ${response.status}: ${await response.text()}`)
    const event = (await response.json()) as any
    const visitorId = event?.identification?.visitor_id
    if (event?.event_id !== eventId || typeof visitorId !== 'string' || !visitorId) return undefined
    return {
      visitorId,
      eventId,
      confidence: Number(event.identification.confidence?.score ?? 0),
      at: Number(event.timestamp ?? 0),
      ip: event.ip_address ?? undefined,
      incognito: typeof event.incognito === 'boolean' ? event.incognito : undefined,
      bot: ['good', 'bad', 'not_detected'].includes(event.bot) ? event.bot : undefined,
      vpn: typeof event.vpn === 'boolean' ? event.vpn : undefined,
      proxy: typeof event.proxy === 'boolean' ? event.proxy : undefined,
      tampering: typeof event.tampering === 'boolean' ? event.tampering : undefined,
    }
  }
}

export interface TrustOptions {
  /** The current time, in epoch milliseconds. */
  now: number
  /** The address your server saw the request from. When given, it must match the event's. */
  ip?: string
  /** The lowest vendor confidence to accept. Defaults to 0.9. */
  confidence?: number
  /** The oldest event to accept, in milliseconds. Defaults to five minutes, which stops replays. */
  maxAge?: number
}

/**
 * Whether a verified fingerprint should count as evidence. A tampered
 * browser, a bad bot, a stale event, or an event made from another address
 * does not.
 */
export function trusted(fingerprint: VerifiedFingerprint, options: TrustOptions): boolean {
  if (fingerprint.bot === 'bad' || fingerprint.tampering) return false
  if (!Number.isFinite(fingerprint.confidence) || fingerprint.confidence > 1 || fingerprint.confidence < (options.confidence ?? 0.9)) return false
  if (!Number.isFinite(fingerprint.at) || Math.abs(options.now - fingerprint.at) > (options.maxAge ?? 5 * 60_000)) return false
  if (options.ip !== undefined && fingerprint.ip !== undefined && options.ip !== fingerprint.ip) return false
  return true
}

export type { FingerprintVerifier, VerifiedFingerprint }
