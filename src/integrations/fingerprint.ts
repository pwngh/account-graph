/**
 * Confirms a Fingerprint identification with Fingerprint's Server API.
 * The browser reports only an event id; the visitor id comes from the
 * vendor, so a page cannot claim someone else's fingerprint.
 * https://docs.fingerprint.com/reference/getevent
 */

export interface FingerprintOptions {
  /** The workspace's secret API key. Never ship it to a browser. */
  secretKey: string
  /** The workspace's region. Defaults to `us`. */
  region?: 'us' | 'eu' | 'ap'
  fetch?: typeof fetch
}

export interface VerifiedFingerprint {
  visitorId: string
  eventId: string
  /** Fingerprint's own confidence in the visitor id, 0 to 1. */
  confidence: number
  /** When the identification happened, in epoch milliseconds. */
  at: number
  /** The address Fingerprint saw the browser at. */
  ip: string | undefined
  incognito: boolean
  bot: 'not_detected' | 'good' | 'bad'
  vpn: boolean
  proxy: boolean
  /** The browser was altered to change its fingerprint. */
  tampering: boolean
}

export type FingerprintVerifier = (eventId: string) => Promise<VerifiedFingerprint | undefined>

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
    })
    if (response.status === 404 || response.status === 400) return undefined
    if (!response.ok) throw new Error(`Fingerprint refused the lookup with ${response.status}: ${await response.text()}`)
    const event = (await response.json()) as any
    const visitorId = event?.identification?.visitor_id
    if (typeof visitorId !== 'string' || !visitorId) return undefined
    return {
      visitorId,
      eventId: event.event_id ?? eventId,
      confidence: Number(event.identification.confidence?.score ?? 0),
      at: Number(event.timestamp ?? 0),
      ip: event.ip_address ?? undefined,
      incognito: event.incognito === true,
      bot: event.bot === 'bad' || event.bot === 'good' ? event.bot : 'not_detected',
      vpn: event.vpn === true,
      proxy: event.proxy === true,
      tampering: event.tampering === true,
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
  if (fingerprint.confidence < (options.confidence ?? 0.9)) return false
  if (Math.abs(options.now - fingerprint.at) > (options.maxAge ?? 5 * 60_000)) return false
  if (options.ip !== undefined && fingerprint.ip !== undefined && options.ip !== fingerprint.ip) return false
  return true
}
