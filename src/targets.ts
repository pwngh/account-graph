import { createHash } from 'node:crypto'
import { GoogleError, googleClick, ingestRequest } from './conversions.ts'
import type { Conversion, IngestRequest } from './conversions.ts'
import { hashEmail, hashPhone, normalizePhone } from './identifiers.ts'
import type { Item, Target } from './outbox.ts'

export interface GoogleAdsOptions {
  /** The Google Ads customer id that owns the conversion actions. */
  customerId: string
  loginCustomerId?: string
  /** Delivers one request. Use `ingest` with a token from `createGoogleTokens`. */
  send: (request: IngestRequest) => Promise<{ requestId?: string }>
}

/**
 * Google Ads, through the Data Manager API. An outcome's action is the id of
 * a conversion action of type "Import from clicks". Sending an id again with
 * a new value restates it; Google has no way to retract one.
 */
export function googleAds(options: GoogleAdsOptions): Target {
  return {
    name: 'google',
    batch: 2000,
    restates: true,
    keys: (outcome) => ({
      ...(outcome.email && { email: hashEmail(outcome.email) }),
      ...(outcome.phone && { phone: hashPhone(outcome.phone) }),
    }),
    click: googleClick,
    async deliver(action, items) {
      const destination = {
        customerId: options.customerId,
        conversionActionId: action,
        ...(options.loginCustomerId && { loginCustomerId: options.loginCustomerId }),
      }
      const conversions = items.map(({ job, touch, consent }): Conversion => {
        const click = touch && (touch.gclid ? { gclid: touch.gclid } : touch.gbraid ? { gbraid: touch.gbraid } : { wbraid: touch.wbraid! })
        if (click) job.click = click
        return {
          transactionId: job.transactionId,
          at: job.at,
          ...(click && { click }),
          ...(job.keys.email && { emailHash: job.keys.email }),
          ...(job.keys.phone && { phoneHash: job.keys.phone }),
          ...(job.value !== undefined && { value: job.value }),
          ...(job.currency && { currency: job.currency }),
          ...(job.source && { source: job.source }),
          ...(consent && { consent }),
        }
      })
      return options.send(ingestRequest(destination, conversions, false))
    },
    retryable(error) {
      if (!(error instanceof GoogleError)) return true
      return error.status === 429 || error.status >= 500 || error.status === 401 || error.status === 403
    },
  }
}

export interface MetaOptions {
  /** The pixel or dataset id that receives the events. */
  pixelId: string
  /** A Conversions API access token, or a function that returns one. */
  accessToken: string | (() => string | Promise<string>)
  /** Your site's address, sent as the page of a website event when the click's landing page is unknown. */
  url: string
  /** Meta's code for its Test Events tool. Leave it out in production. */
  testEventCode?: string
  /** The Graph API version. Defaults to v27.0. */
  version?: string
  fetch?: typeof fetch
}

/** Meta answered with an error status. */
export class MetaError extends Error {
  status: number
  /** Meta's own error code, when the body carried one. 190 is a bad access token. */
  code: number | undefined
  constructor(status: number, body: string) {
    super(`Meta refused the request with ${status}: ${body}`)
    this.status = status
    try {
      this.code = JSON.parse(body)?.error?.code
    } catch {}
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const SOURCES = { WEB: 'website', APP: 'app', IN_STORE: 'physical_store', PHONE: 'phone_call', MESSAGE: 'chat', OTHER: 'other' } as const

/** One Conversions API event. `fbc` is built from the ad click the graph credited. */
export function metaEvent(action: string, { job, touch }: Item, url: string): Record<string, unknown> {
  const source = SOURCES[job.source ?? 'WEB']
  if (touch?.fbclid) job.click = { fbclid: touch.fbclid }
  return {
    event_name: action,
    event_time: Math.floor(job.at / 1000),
    event_id: job.transactionId,
    action_source: source,
    ...(source === 'website' && { event_source_url: touch?.landing ?? url }),
    user_data: {
      ...(job.keys.em && { em: [job.keys.em] }),
      ...(job.keys.ph && { ph: [job.keys.ph] }),
      ...(touch?.fbclid && { fbc: `fb.1.${touch.at}.${touch.fbclid}` }),
    },
    ...(job.value !== undefined && { custom_data: { value: job.value, currency: job.currency ?? 'USD' } }),
  }
}

/**
 * Meta, through the Conversions API. An outcome's action is an event name,
 * such as `Lead` or `Purchase`. Meta refuses events more than seven days old
 * and keeps the first event per id and name.
 */
export function meta(options: MetaOptions): Target {
  const fetcher = options.fetch ?? fetch
  return {
    name: 'meta',
    batch: 1000,
    maxAge: 7 * 86_400_000,
    // Meta matches a lowercased email as written, and a phone as digits with the country code.
    keys: (outcome) => ({
      ...(outcome.email && { em: sha256(outcome.email.trim().toLowerCase()) }),
      ...(outcome.phone && { ph: sha256(normalizePhone(outcome.phone).slice(1)) }),
    }),
    click: (attribution, confidence) => attribution.touches.find((touch) => touch.confidence >= confidence && Boolean(touch.fbclid)),
    async deliver(action, items) {
      const token = typeof options.accessToken === 'function' ? await options.accessToken() : options.accessToken
      const endpoint = `https://graph.facebook.com/${options.version ?? 'v27.0'}/${encodeURIComponent(options.pixelId)}/events`
      const response = await fetcher(`${endpoint}?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: items.map((item) => metaEvent(action, item, options.url)),
          ...(options.testEventCode && { test_event_code: options.testEventCode }),
        }),
      })
      const body = await response.text()
      if (!response.ok) throw new MetaError(response.status, body)
      const trace = JSON.parse(body)?.fbtrace_id
      return typeof trace === 'string' ? { requestId: trace } : {}
    },
    retryable(error) {
      if (!(error instanceof MetaError)) return true
      return error.status === 429 || error.status >= 500 || error.code === 190
    },
  }
}
