import type { LocalOptions } from '../contract/api.ts'
import type { Target } from '../core/outbox.ts'
import type { Cost } from '../contract/types.ts'
import { ingest } from '../providers/conversions.ts'
import { googleCosts, metaCosts } from '../providers/costs.ts'
import { createGoogleTokens } from '../providers/google-auth.ts'
import { createMicrosoftTokens } from '../providers/microsoft-auth.ts'
import { createAddressVerifier } from '../providers/smarty.ts'
import { googleAds, meta, microsoftAds, tiktok } from '../providers/targets.ts'
import { createLineTypeLookup } from '../providers/twilio.ts'

export function targetsOf({ ads, fetch: fetcher }: LocalOptions): Target[] {
  const out: Target[] = []
  const how = fetcher && { fetch: fetcher }
  if (ads?.google) {
    const { serviceAccount, customerId, loginCustomerId } = ads.google
    const token = createGoogleTokens(serviceAccount, { ...how })
    out.push(googleAds({ customerId, ...(loginCustomerId && { loginCustomerId }), send: async (request) => ingest(request, await token(), ...(fetcher ? [fetcher] : [])) }))
  }
  if (ads?.meta) out.push(meta({ pixelId: ads.meta.pixelId, accessToken: ads.meta.accessToken, url: ads.meta.siteUrl, clientUserAgent: ads.meta.clientUserAgent === true, ...how, ...(ads.meta.testEventCode && { testEventCode: ads.meta.testEventCode }) }))
  if (ads?.tiktok) out.push(tiktok({ pixelCode: ads.tiktok.pixelCode, accessToken: ads.tiktok.accessToken, url: ads.tiktok.siteUrl, ...(ads.tiktok.testEventCode && { testEventCode: ads.tiktok.testEventCode }), ...how }))
  if (ads?.microsoft) {
    const { clientId, refreshToken, clientSecret, developerToken, customerId, accountId } = ads.microsoft
    out.push(microsoftAds({ developerToken, customerId, customerAccountId: accountId, sandbox: ads.microsoft.sandbox === true, ...how, accessToken: createMicrosoftTokens({ clientId, refreshToken, ...how, ...(clientSecret && { clientSecret }) }) }))
  }
  return out
}

export function costSourcesOf({ costs, fetch: fetcher }: LocalOptions): [string, (from: string, to: string) => Promise<Cost[]>][] {
  const how = fetcher && { fetch: fetcher }
  const out: [string, (from: string, to: string) => Promise<Cost[]>][] = []
  if (costs?.google) {
    const { serviceAccount, customerId, loginCustomerId, developerToken, conversions } = costs.google
    out.push(['google', googleCosts({ customerId, ...(developerToken && { developerToken }), accessToken: createGoogleTokens(serviceAccount, { scope: 'https://www.googleapis.com/auth/adwords', ...how }), ...(loginCustomerId && { loginCustomerId }), ...(conversions !== undefined && { conversions }), ...how })])
  }
  if (costs?.meta) out.push(['meta', metaCosts({ adAccountId: costs.meta.adAccountId, accessToken: costs.meta.accessToken, ...how, ...(costs.meta.conversions && { conversions: costs.meta.conversions }) })])
  return out
}

export const checksOf = ({ checks, fetch: fetcher }: LocalOptions) => ({
  ...(checks?.address && { address: createAddressVerifier({ ...checks.address, ...(fetcher && { fetch: fetcher }) }) }),
  ...(checks?.lineType && { lineType: createLineTypeLookup({ ...checks.lineType, ...(fetcher && { fetch: fetcher }) }) }),
})
