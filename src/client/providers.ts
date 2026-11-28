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

/** Whether an address is one a test receiver may have: on this machine, with no path, query or credentials. */
export function testReceiverAddress(address: string): boolean {
  let receiver: URL
  try {
    receiver = new URL(address)
  } catch {
    return false
  }
  return ['http:', 'https:'].includes(receiver.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(receiver.hostname)
    && receiver.pathname === '/' && !receiver.search && !receiver.hash && !receiver.username && !receiver.password
}

/** A fetch that sends each request to `receiver`, keeping its path and query, and follows no redirect. */
function toReceiver(receiver: string, fetcher: typeof fetch = fetch): typeof fetch {
  if (!testReceiverAddress(receiver)) throw new Error('A test receiver must be an address on this machine, such as http://127.0.0.1:9000')
  return async (input, init) => {
    const asked = new URL(input instanceof Request ? input.url : String(input))
    const to = new URL(receiver)
    to.pathname = asked.pathname
    to.search = asked.search
    const given = input instanceof Request ? { method: input.method, headers: input.headers, ...(input.body && { body: await input.arrayBuffer() }) } : {}
    return fetcher(to, { ...given, ...init, redirect: 'error' })
  }
}

export function targetsOf({ ads, fetch: given }: LocalOptions): Target[] {
  const out: Target[] = []
  const fetcher = ads?.testReceiver ? toReceiver(ads.testReceiver, given) : given
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
