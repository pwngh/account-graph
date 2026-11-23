/**
 * Calls each provider's real endpoint and says how it answered.
 *
 *   npm run live-check
 *
 * It reads the same variables as the server. For a provider whose keys are
 * set, it makes a real call that records nothing. For one whose keys are not
 * set, it sends an invalid key, which confirms the address, the way the key
 * is sent, and how a refusal is read.
 */
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { ingest, ingestRequest, meta, microsoftAds, tiktok } from '../src/index.ts'
import type { Job, Target } from '../src/index.ts'
import { createFingerprintVerifier } from '../src/integrations/fingerprint.ts'
import { createGoogleTokens } from '../src/integrations/google-auth.ts'
import { createMaxMindLookup } from '../src/integrations/maxmind.ts'
import { createMicrosoftTokens } from '../src/integrations/microsoft-auth.ts'

const env = process.env
const short = (text: unknown) => String(text).replace(/\s+/g, ' ').slice(0, 240)
async function check(name: string, real: boolean, work: () => Promise<unknown>): Promise<void> {
  const label = `${name} (${real ? 'your keys' : 'invalid key'})`
  try {
    console.log(`${label}: ${short(JSON.stringify(await work()))}`)
  } catch (error) {
    console.log(`${label}: ${short((error as Error).message)}`)
  }
}
/** A made-up job, for asking a target to build and send one request. */
const job = (target: string): Job => ({ transactionId: 'live-check', target, subject: 'live-check', at: Date.now(), action: 'Lead', keys: { email: 'a'.repeat(64), em: 'a'.repeat(64) }, state: 'pending', attempts: 1, due: 0 })
const refusal = (target: Target) => async () => {
  try {
    return await target.deliver('Lead', [{ job: job(target.name), touch: undefined, consent: undefined }])
  } catch (error) {
    throw new Error(`${(error as Error).message} | worth another try: ${target.retryable(error)}`)
  }
}

// Fingerprint: asking about an event that does not exist proves the key, and reads nothing real.
if (env.FINGERPRINT_SECRET) {
  const verify = createFingerprintVerifier({ secretKey: env.FINGERPRINT_SECRET, region: (env.FINGERPRINT_REGION as 'us' | 'eu' | 'ap') || 'us' })
  await check('fingerprint', true, async () => ((await verify('0000000000000.livecheck')) === undefined ? 'key accepted; asked about an event that does not exist' : 'unexpected event'))
} else await check('fingerprint', false, () => createFingerprintVerifier({ secretKey: 'invalid' })('1708102555327.NLOjmg'))

// MaxMind: one lookup of a public address. It costs one query.
if (env.MAXMIND_ACCOUNT_ID && env.MAXMIND_LICENSE_KEY) {
  const lookup = createMaxMindLookup({ accountId: env.MAXMIND_ACCOUNT_ID, licenseKey: env.MAXMIND_LICENSE_KEY, service: (env.MAXMIND_SERVICE as 'insights') || 'insights', host: (env.MAXMIND_HOST as 'geoip.maxmind.com') || 'geoip.maxmind.com' })
  await check('maxmind', true, () => lookup('8.8.8.8'))
} else await check('maxmind', false, () => createMaxMindLookup({ accountId: 1, licenseKey: 'invalid' })('8.8.8.8'))

// Google: a token, then a request Google checks and does not record.
if (env.GOOGLE_SERVICE_ACCOUNT_FILE) {
  const token = createGoogleTokens(JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')))
  await check('google token', true, async () => `token issued, ${(await token()).length} characters`)
  if (env.GOOGLE_ADS_CUSTOMER_ID && env.GOOGLE_ADS_CONVERSION_ACTION_ID) {
    const request = ingestRequest({ customerId: env.GOOGLE_ADS_CUSTOMER_ID, conversionActionId: env.GOOGLE_ADS_CONVERSION_ACTION_ID, ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID && { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }) }, [{ transactionId: 'live-check', at: Date.now(), email: 'live-check@example.com' }], true)
    await check('google data manager, validate only', true, async () => ingest(request, await token()))
  } else console.log('google data manager: set GOOGLE_ADS_CUSTOMER_ID and GOOGLE_ADS_CONVERSION_ACTION_ID to have Google check a request without recording it')
} else {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await check('google token', false, () => createGoogleTokens({ client_email: 'nobody@example-not-real.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string })())
  await check('google data manager', false, () => ingest(ingestRequest({ customerId: '1234567890', conversionActionId: '1' }, [{ transactionId: 't', at: Date.now(), click: { gclid: 'x' } }]), 'invalid'))
}

// Meta: only with a test code, so the event goes to Meta's test tool and not to your reports.
if (env.META_PIXEL_ID && env.META_ACCESS_TOKEN && env.META_TEST_EVENT_CODE) {
  const target = meta({ pixelId: env.META_PIXEL_ID, accessToken: env.META_ACCESS_TOKEN, url: env.META_SITE_URL || 'https://example.org/', testEventCode: env.META_TEST_EVENT_CODE })
  await check('meta, test event', true, refusal(target))
} else if (env.META_PIXEL_ID && env.META_ACCESS_TOKEN) console.log('meta: set META_TEST_EVENT_CODE to send one event to the test tool; a real event is not sent from here')
else await check('meta', false, refusal(meta({ pixelId: '1', accessToken: 'invalid', url: 'https://example.org/' })))

// Microsoft: a token only. Sending a conversion would record it.
if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_REFRESH_TOKEN) {
  const token = createMicrosoftTokens({ clientId: env.MICROSOFT_CLIENT_ID, refreshToken: env.MICROSOFT_REFRESH_TOKEN, ...(env.MICROSOFT_CLIENT_SECRET && { clientSecret: env.MICROSOFT_CLIENT_SECRET }) })
  await check('microsoft token', true, async () => `token issued, ${(await token()).length} characters`)
} else {
  await check('microsoft token', false, () => createMicrosoftTokens({ clientId: '00000000-0000-0000-0000-000000000000', refreshToken: 'invalid' })())
  await check('microsoft', false, refusal(microsoftAds({ accessToken: 'invalid', developerToken: 'invalid', customerId: '1', customerAccountId: '1' })))
}

// TikTok: there is no call here that records nothing, so real keys are not exercised.
if (env.TIKTOK_PIXEL_CODE && env.TIKTOK_ACCESS_TOKEN) console.log('tiktok: not checked with your keys; any call would record an event')
else await check('tiktok', false, refusal(tiktok({ pixelCode: 'X', accessToken: 'invalid', url: 'https://example.org/' })))
