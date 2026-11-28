import { createHash } from 'node:crypto'
import { GoogleError, googleClick, ingestRequest } from './conversions.ts'
import type { Conversion, IngestRequest } from './conversions.ts'
import { hashEmail, hashPhone, normalizePhone } from '../core/identifiers.ts'
import type { Item, Target } from '../core/outbox.ts'

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
 * a new value restates it. This API has no way to retract one, so somebody
 * who is forgotten has theirs restated to no value, and it stays counted.
 */
export function googleAds(options: GoogleAdsOptions): Target {
  const destinationOf = (action: string) => ({
    customerId: options.customerId,
    conversionActionId: action,
    ...(options.loginCustomerId && { loginCustomerId: options.loginCustomerId }),
  })
  return {
    name: 'google',
    batch: 2000,
    restates: true,
    keys: (outcome) => ({
      ...(outcome.email && { email: hashEmail(outcome.email) }),
      ...(outcome.phone && { phone: hashPhone(outcome.phone) }),
    }),
    click: googleClick,
    async forget(jobs) {
      const refusals: (string | undefined)[] = jobs.map((job) => (job.click || job.keys.email || job.keys.phone ? undefined : 'nothing it was matched by is kept'))
      const actions = new Set(jobs.filter((_, i) => refusals[i] === undefined).map((job) => job.action))
      for (const action of actions) {
        const theirs = jobs.flatMap((job, i) => (job.action === action && refusals[i] === undefined ? [i] : []))
        const conversions = theirs.map((i): Conversion => {
          const job = jobs[i]!
          return {
            transactionId: job.transactionId,
            at: job.at,
            ...(job.click && { click: job.click }),
            ...(job.keys.email && { emailHash: job.keys.email }),
            ...(job.keys.phone && { phoneHash: job.keys.phone }),
            value: 0,
            ...(job.currency && { currency: job.currency }),
            ...(job.source && { source: job.source === 'SYSTEM_GENERATED' ? 'OTHER' : job.source }),
          }
        })
        try {
          await options.send(ingestRequest(destinationOf(action), conversions, false))
        } catch (error) {
          for (const i of theirs) refusals[i] = String((error as Error)?.message ?? error)
        }
      }
      return refusals
    },
    async deliver(action, items) {
      const destination = destinationOf(action)
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
          ...(job.source && { source: job.source === 'SYSTEM_GENERATED' ? 'OTHER' : job.source }),
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
  /** Keep and send the converting browser's user agent only with explicit advertising consent. */
  clientUserAgent?: boolean
  /** The Graph API version. Defaults to v27.0. */
  version?: string
  fetch?: typeof fetch
}

/** Meta answered with an error status. */
export class MetaError extends Error {
  status: number
  /** Meta's own error code, when the body carried one. 190 is a bad access token. */
  code: number | undefined
  constructor(status: number, body: string, privateResponse = false) {
    super(`Meta refused the request with ${status}${privateResponse ? '' : ': ' + body}`)
    this.status = status
    try {
      this.code = JSON.parse(body)?.error?.code
    } catch {}
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const SOURCES = { WEB: 'website', APP: 'app', IN_STORE: 'physical_store', PHONE: 'phone_call', MESSAGE: 'chat', OTHER: 'other', SYSTEM_GENERATED: 'system_generated' } as const

/** How Meta writes its browser id: version, subdomain level, when it was made, and a random number. */
const FBP = /^fb\.\d\.\d{10,14}\.\d{1,20}$/

/** One Conversions API event. `fbc` is built from the ad click the graph credited, and `fbp` is the id of the browser it was made in. */
export function metaEvent(action: string, { job, touch, consent }: Item, url: string, clientUserAgent = false): Record<string, unknown> {
  const source = SOURCES[job.source ?? 'WEB']
  if (touch?.fbclid) job.click = { fbclid: touch.fbclid }
  return {
    event_name: action,
    event_time: Math.floor(job.at / 1000),
    event_id: job.transactionId,
    action_source: source,
    ...(source === 'website' && { event_source_url: touch?.landing ?? url }),
    user_data: {
      ...(source === 'website' && clientUserAgent && consent?.adUserData && job.metaUserAgent && { client_user_agent: job.metaUserAgent }),
      ...(job.keys.em && { em: [job.keys.em] }),
      ...(job.keys.ph && { ph: [job.keys.ph] }),
      ...(touch?.fbclid && { fbc: `fb.1.${touch.at}.${touch.fbclid}` }),
      ...(touch?.fbclid && touch.fbp && FBP.test(touch.fbp) && { fbp: touch.fbp }),
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
    clientUserAgent: options.clientUserAgent === true,
    batch: 1000,
    maxAge: 7 * 86_400_000,
    // Meta matches a lowercased email as written, and a phone as digits with the country code.
    keys: (outcome) => ({
      ...(outcome.email && { em: sha256(outcome.email.trim().toLowerCase()) }),
      ...(outcome.phone && { ph: sha256(normalizePhone(outcome.phone).slice(1)) }),
    }),
    click: (attribution, confidence) => {
      const click = attribution.touches.find((touch) => touch.confidence >= confidence && Boolean(touch.fbclid))
      // The pixel may not have made its cookie yet when the click landed. A later arrival in the same browser then has it.
      const fbp = click && [click, ...attribution.touches.filter((touch) => touch.subject === click.subject)].find((touch) => touch.fbp && FBP.test(touch.fbp))?.fbp
      return click && { ...click, ...(fbp && { fbp }) }
    },
    async deliver(action, items) {
      const token = typeof options.accessToken === 'function' ? await options.accessToken() : options.accessToken
      const endpoint = `https://graph.facebook.com/${options.version ?? 'v27.0'}/${encodeURIComponent(options.pixelId)}/events`
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          data: items.map((item) => metaEvent(action, item, options.url, options.clientUserAgent)),
          ...(options.testEventCode && { test_event_code: options.testEventCode }),
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.text()
      // The provider may quote the raw browser header in its error detail.
      if (!response.ok) throw new MetaError(response.status, body, items.some(item => Boolean(item.job.metaUserAgent)))
      let receipt
      try {
        receipt = JSON.parse(body)
      } catch {
        // It may have been taken, so it is sent again, and Meta keeps the first event of an id.
        throw new Error('Meta answered with a receipt that cannot be read')
      }
      if (typeof receipt?.events_received === 'number' && receipt.events_received !== items.length) throw new MetaError(response.status, 'events_received does not match the submitted batch')
      const trace = receipt.fbtrace_id
      return typeof trace === 'string' ? { requestId: trace } : {}
    },
    retryable(error) {
      if (!(error instanceof MetaError)) return true
      return error.status === 429 || error.status >= 500 || error.code === 190
    },
  }
}

export interface MicrosoftAdsOptions {
  /** An OAuth access token for Microsoft Advertising, or a function that returns one. */
  accessToken: string | (() => string | Promise<string>)
  developerToken: string
  /** The manager customer id, for the `CustomerId` header. */
  customerId: string
  /** The ad account id, for the `CustomerAccountId` header. */
  customerAccountId: string
  /** Send to Microsoft's sandbox instead of production. */
  sandbox?: boolean
  fetch?: typeof fetch
}

/** Microsoft answered with an error status, or accepted the request and refused some of its conversions. */
export class MicrosoftError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`Microsoft refused the request with ${status}: ${body}`)
    this.status = status
  }
}

/**
 * Microsoft Advertising, through `ApplyOfflineConversions`. An outcome's
 * action is the name of an offline conversion goal. Microsoft refuses
 * conversions more than 90 days old, and keeps the first of two with the same
 * click id and time.
 */
export function microsoftAds(options: MicrosoftAdsOptions): Target {
  const fetcher = options.fetch ?? fetch
  const host = options.sandbox ? 'campaign.api.sandbox.bingads.microsoft.com' : 'campaign.api.bingads.microsoft.com'
  const post = async (path: string, body: object) =>
    fetcher(`https://${host}/CampaignManagement/v13/${path}/Apply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${typeof options.accessToken === 'function' ? await options.accessToken() : options.accessToken}`,
        DeveloperToken: options.developerToken,
        CustomerId: options.customerId,
        CustomerAccountId: options.customerAccountId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  return {
    name: 'microsoft',
    batch: 1000,
    maxAge: 90 * 86_400_000,
    // Microsoft documents SHA-256 of the email and of the phone in E.164. The email is lowercased and trimmed first.
    keys: (outcome) => ({
      ...(outcome.email && { email: sha256(outcome.email.trim().toLowerCase()) }),
      ...(outcome.phone && { phone: sha256(normalizePhone(outcome.phone)) }),
    }),
    click: (attribution, confidence) => attribution.touches.find((touch) => touch.confidence >= confidence && Boolean(touch.msclkid)),
    // Microsoft calls it a retraction, and takes one for ninety days after the conversion.
    async forget(jobs) {
      const now = new Date().toISOString()
      const response = await post('OfflineConversionAdjustments', {
        OfflineConversionAdjustments: jobs.map((job) => ({
          AdjustmentType: 'Retract',
          AdjustmentTime: now,
          ConversionName: job.action,
          ConversionTime: new Date(job.at).toISOString(),
          ...(job.click?.msclkid && { MicrosoftClickId: job.click.msclkid }),
          ...(job.keys.email && { HashedEmailAddress: job.keys.email }),
          ...(job.keys.phone && { HashedPhoneNumber: job.keys.phone }),
        })),
      })
      const body = await response.text()
      if (!response.ok) throw new MicrosoftError(response.status, body)
      const refused = new Map<number, string>()
      const errors = body ? JSON.parse(body)?.PartialErrors : undefined
      for (const each of Array.isArray(errors) ? errors : []) refused.set(each?.Index, String(each?.ErrorCode ?? 'refused'))
      return jobs.map((_, i) => refused.get(i))
    },
    async deliver(action, items) {
      const conversions = items.map(({ job, touch }) => {
        if (touch?.msclkid) job.click = { msclkid: touch.msclkid }
        return {
          ConversionName: action,
          ConversionTime: new Date(job.at).toISOString(),
          ...(job.value !== undefined && { ConversionValue: job.value, ConversionCurrencyCode: job.currency ?? 'USD' }),
          ...(touch?.msclkid && { MicrosoftClickId: touch.msclkid }),
          ...(job.keys.email && { HashedEmailAddress: job.keys.email }),
          ...(job.keys.phone && { HashedPhoneNumber: job.keys.phone }),
        }
      })
      const response = await post('OfflineConversions', { OfflineConversions: conversions })
      const body = await response.text()
      if (!response.ok) throw new MicrosoftError(response.status, body)
      // A 200 can still refuse some conversions. Treat it as a refusal, so the outbox sends each alone and finds which.
      const refused = body ? JSON.parse(body)?.PartialErrors : undefined
      if (Array.isArray(refused) && refused.length > 0) throw new MicrosoftError(200, JSON.stringify(refused.slice(0, 5)))
      const tracking = response.headers.get('TrackingId')
      return tracking ? { requestId: tracking } : {}
    },
    retryable(error) {
      if (!(error instanceof MicrosoftError)) return true
      return error.status === 401 || error.status === 429 || error.status >= 500
    },
  }
}

export interface TikTokOptions {
  /** TikTok's Test Events code. Leave it out in production. */
  testEventCode?: string
  /** The pixel code that measures your site's events. */
  pixelCode: string
  /** An Events API access token, or a function that returns one. */
  accessToken: string | (() => string | Promise<string>)
  /** Your site's address, sent as the page of an event when the click's landing page is unknown. */
  url: string
  fetch?: typeof fetch
}

/** TikTok answered with an error status, or with a result code other than 0. */
export class TikTokError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`TikTok refused the request with ${status}: ${body}`)
    this.status = status
  }
}

/**
 * TikTok, through Events API 2.0 as web events. An outcome's action is an
 * event name, such as `CompleteRegistration` or `Purchase`. TikTok keeps one
 * event per pixel, event id, and name, so a job sent twice counts once.
 */
export function tiktok(options: TikTokOptions): Target {
  const fetcher = options.fetch ?? fetch
  return {
    name: 'tiktok',
    batch: 1000,
    // TikTok matches a lowercased, trimmed email and a phone in E.164 with its plus sign, each as SHA-256.
    keys: (outcome) => ({
      ...(outcome.email && { email: sha256(outcome.email.trim().toLowerCase()) }),
      ...(outcome.phone && { phone: sha256(normalizePhone(outcome.phone)) }),
    }),
    click: (attribution, confidence) => attribution.touches.find((touch) => touch.confidence >= confidence && Boolean(touch.ttclid)),
    async deliver(action, items) {
      const token = typeof options.accessToken === 'function' ? await options.accessToken() : options.accessToken
      const data = items.map(({ job, touch }) => {
        if (touch?.ttclid) job.click = { ttclid: touch.ttclid }
        return {
          event: action,
          event_time: Math.floor(job.at / 1000),
          event_id: job.transactionId,
          user: {
            ...(touch?.ttclid && { ttclid: touch.ttclid }),
            ...(job.keys.email && { email: job.keys.email }),
            ...(job.keys.phone && { phone: job.keys.phone }),
          },
          page: { url: touch?.landing ?? options.url },
          ...(job.value !== undefined && { properties: { value: job.value, currency: job.currency ?? 'USD' } }),
        }
      })
      const response = await fetcher('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
        method: 'POST',
        headers: { 'Access-Token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ event_source: 'web', event_source_id: options.pixelCode, data, ...(options.testEventCode && { test_event_code: options.testEventCode }) }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await response.text()
      if (!response.ok) throw new TikTokError(response.status, body)
      // TikTok can answer 200 and still refuse, with a code other than 0.
      const answer = JSON.parse(body) as { code?: number; request_id?: string }
      if (answer.code !== 0) throw new TikTokError(200, body)
      return answer.request_id ? { requestId: answer.request_id } : {}
    },
    retryable(error) {
      if (!(error instanceof TikTokError)) return true
      return error.status === 401 || error.status === 429 || error.status >= 500
    },
  }
}
