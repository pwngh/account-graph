import { malformed } from '../contract/fault.ts'
import { hashEmail, hashPhone } from '../core/identifiers.ts'
import type { Attribution, AttributedTouch } from '../contract/types.ts'

/**
 * Builds requests for Google's Data Manager API, which replaced the Google
 * Ads API for offline conversion imports in 2026.
 * https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest
 */

export interface Conversion {
  /** Your id for this outcome. Google keeps the first event per id and reads later ones as adjustments. */
  transactionId: string
  /** When it happened, in epoch milliseconds. */
  at: number
  /** The ad click to credit. Exactly one id is sent: gclid, else gbraid, else wbraid. */
  click?: { gclid?: string; gbraid?: string; wbraid?: string }
  /** Sent hashed, as a second match key for when the click id is missing or lost. */
  email?: string
  phone?: string
  /** The same keys already hashed with `hashEmail` and `hashPhone`, for when the raw value was not kept. */
  emailHash?: string
  phoneHash?: string
  value?: number
  /** ISO 4217. Defaults to USD. */
  currency?: string
  /** Where the outcome happened. Defaults to WEB. */
  source?: 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER'
  /** Whether the person agreed to ad measurement and to personalized ads. */
  consent?: { adUserData: boolean; adPersonalization: boolean }
}

export interface Destination {
  /** The Google Ads customer id that owns the conversion action: ten digits, no hyphens. */
  customerId: string
  /** The account the credentials log in to, when it differs, such as a manager account. */
  loginCustomerId?: string
  /** The id of a conversion action of type "Import from clicks". */
  conversionActionId: string
}

export interface IngestRequest {
  destinations: unknown[]
  encoding: 'HEX'
  events: Record<string, unknown>[]
  validateOnly: boolean
}

/** Google answered with an error status. */
export class GoogleError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`Google refused the request with ${status}: ${body}`)
    this.status = status
  }
}

const status = (granted: boolean) => (granted ? 'CONSENT_GRANTED' : 'CONSENT_DENIED')

/** One Data Manager event. Throws when there is neither a click id nor a match key to send. */
export function conversionEvent(conversion: Conversion): Record<string, unknown> {
  const { transactionId, at, click = {}, value, consent } = conversion
  const adIdentifiers = click.gclid
    ? { gclid: click.gclid }
    : click.gbraid
      ? { gbraid: click.gbraid }
      : click.wbraid
        ? { wbraid: click.wbraid }
        : undefined
  const emailHash = conversion.emailHash ?? (conversion.email ? hashEmail(conversion.email) : undefined)
  const phoneHash = conversion.phoneHash ?? (conversion.phone ? hashPhone(conversion.phone) : undefined)
  const userIdentifiers = [
    ...(emailHash ? [{ emailAddress: emailHash }] : []),
    ...(phoneHash ? [{ phoneNumber: phoneHash }] : []),
  ]
  if (!adIdentifiers && userIdentifiers.length === 0) {
    throw malformed(`Conversion "${transactionId}" has no click id, email, or phone for Google to match`)
  }
  return {
    transactionId,
    eventTimestamp: new Date(at).toISOString(),
    eventSource: conversion.source ?? 'WEB',
    ...(adIdentifiers && { adIdentifiers }),
    ...(userIdentifiers.length > 0 && { userData: { userIdentifiers } }),
    ...(value !== undefined && { conversionValue: value, currency: conversion.currency ?? 'USD' }),
    ...(consent && {
      consent: { adUserData: status(consent.adUserData), adPersonalization: status(consent.adPersonalization) },
    }),
  }
}

/** The body for `events:ingest`. `validateOnly` defaults to true: Google checks it and records nothing. */
export function ingestRequest(
  destination: Destination,
  conversions: readonly Conversion[],
  validateOnly = true,
): IngestRequest {
  if (conversions.length === 0 || conversions.length > 2000) {
    throw new RangeError('One request carries 1 to 2000 conversions')
  }
  const account = (accountId: string) => ({ accountType: 'GOOGLE_ADS', accountId: accountId.replaceAll('-', '') })
  return {
    destinations: [
      {
        operatingAccount: account(destination.customerId),
        ...(destination.loginCustomerId && { loginAccount: account(destination.loginCustomerId) }),
        productDestinationId: destination.conversionActionId,
      },
    ],
    encoding: 'HEX',
    events: conversions.map(conversionEvent),
    validateOnly,
  }
}

/** Sends a request with an OAuth token for the `datamanager` scope. Returns Google's request id and warnings. */
export async function ingest(
  request: IngestRequest,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ requestId?: string; fieldWarnings?: unknown[] }> {
  const response = await fetcher('https://datamanager.googleapis.com/v1/events:ingest', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = await response.text()
  if (!response.ok) throw new GoogleError(response.status, body)
  return JSON.parse(body)
}

/**
 * The Google ad click to send for an attribution: the newest touch that
 * carries a Google click id and is at or above `confidence`.
 */
export function googleClick(attribution: Attribution, confidence: number): AttributedTouch | undefined {
  return attribution.touches.find(
    (touch) => touch.confidence >= confidence && Boolean(touch.gclid || touch.gbraid || touch.wbraid),
  )
}
