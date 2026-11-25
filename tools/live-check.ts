/** Run one check with npm run live-check -- NAME. Use --list to see what leaves the machine. */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { hashEmail, ingest, ingestRequest, meta, tiktok } from './internals.ts'
import type { Job, Target } from './internals.ts'
import { googleCosts, metaCosts } from '../src/providers/costs.ts'
import { createFingerprintVerifier, trusted } from '../src/providers/fingerprint.ts'
import { createGoogleTokens } from '../src/providers/google-auth.ts'
import { createMaxMindLookup, isMaxMindHost, isMaxMindService } from '../src/providers/maxmind.ts'
import { createMicrosoftTokens } from '../src/providers/microsoft-auth.ts'
import { createAddressVerifier } from '../src/providers/smarty.ts'
import { createLineTypeLookup } from '../src/providers/twilio.ts'

const checks = {
  fingerprint: { keys: ['FINGERPRINT_SECRET', 'FINGERPRINT_EVENT_ID'], sends: 'One regional Server API lookup with the secret and the supplied QA event ID.' },
  maxmind: { keys: ['MAXMIND_ACCOUNT_ID', 'MAXMIND_LICENSE_KEY'], sends: 'One authenticated IP lookup: 192.0.2.1, or the published 65.116.3.80 fixture on the MaxMind sandbox. May consume a query.' },
  'google-token': { keys: ['GOOGLE_SERVICE_ACCOUNT_FILE'], sends: 'One signed service-account assertion to Google OAuth for the Data Manager scope.' },
  google: { keys: ['GOOGLE_SERVICE_ACCOUNT_FILE', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_CONVERSION_ACTION_ID'], sends: 'Google OAuth assertion, then one validate-only Data Manager event: customer, optional manager, action ID, time, random transaction ID and hashed proof@example.org.' },
  meta: { keys: ['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'META_TEST_EVENT_CODE'], sends: 'One real Lead to the QA dataset with token, test code, other source, time, random ID and hashed proof@example.org. Can affect measurement and targeting.' },
  microsoft: { keys: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_REFRESH_TOKEN'], sends: 'One Microsoft OAuth refresh with client ID, refresh token and optional client secret. No conversions. A replacement refresh token may be issued.' },
  tiktok: { keys: ['TIKTOK_PIXEL_CODE', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_TEST_EVENT_CODE'], sends: 'One CompleteRegistration to the QA pixel with token, test code, time, random ID, hashed proof@example.org and https://example.org/.' },
  'google-costs': { keys: ['GOOGLE_SERVICE_ACCOUNT_FILE', 'GOOGLE_ADS_CUSTOMER_ID'], sends: 'Google OAuth assertion, then one Ads report for yesterday UTC: customer, optional manager and optional legacy developer token. Reads campaign spend, currency, clicks and impressions.' },
  'meta-costs': { keys: ['META_AD_ACCOUNT_ID', 'META_ADS_TOKEN'], sends: 'One Insights GET with the ad account and reporting token for yesterday UTC. Reads a single report page of campaign spend, currency, clicks and impressions.' },
  smarty: { keys: ['SMARTY_AUTH_ID', 'SMARTY_AUTH_TOKEN'], sends: 'One US Street lookup with the secret pair, optional license and a fictional US address. May consume a lookup.' },
  twilio: { keys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_LOOKUP_NUMBER'], sends: 'One Lookup v2 Line Type Intelligence GET with credentials and the supplied owner-approved E.164 number. May be billed. No calls or texts.' },
}

type Name = keyof typeof checks
type Env = Record<string, string | undefined>
const list = (log: (line: string) => void) => {
  for (const [name, check] of Object.entries(checks)) log(name + ': ' + check.sends)
  log('--invalid-key uses dummy credentials, IDs and inputs for only the named service. Google reports and validation skip the OAuth exchange in this mode.')
}

// Invalid-key mode never reads the operator's environment or service-account file.
const dummy = {
  FINGERPRINT_SECRET: 'invalid', FINGERPRINT_EVENT_ID: '0000000000000.livecheck',
  MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'invalid',
  GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CONVERSION_ACTION_ID: '1',
  META_PIXEL_ID: '1', META_ACCESS_TOKEN: 'invalid', META_TEST_EVENT_CODE: 'invalid',
  META_AD_ACCOUNT_ID: '1', META_ADS_TOKEN: 'invalid',
  MICROSOFT_CLIENT_ID: '00000000-0000-0000-0000-000000000000', MICROSOFT_REFRESH_TOKEN: 'invalid',
  TIKTOK_PIXEL_CODE: 'invalid', TIKTOK_ACCESS_TOKEN: 'invalid', TIKTOK_TEST_EVENT_CODE: 'invalid',
  SMARTY_AUTH_ID: 'invalid', SMARTY_AUTH_TOKEN: 'invalid',
  TWILIO_ACCOUNT_SID: 'ACinvalid', TWILIO_AUTH_TOKEN: 'invalid', TWILIO_LOOKUP_NUMBER: '+12025550104',
}

const proofEmail = 'proof@example.org'
type Fixture = { transactionId: string; at: number; email: string }
const yesterday = (at: number) => new Date(at - 86_400_000).toISOString().slice(0, 10)

function validAssets(name: Name, env: Env): boolean {
  const customer = (id: string) => /^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(id) && /[1-9]/.test(id)
  if (name === 'google' || name === 'google-costs') {
    return customer(env.GOOGLE_ADS_CUSTOMER_ID ?? '') && (!env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || customer(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)) &&
      (name !== 'google' || /^[1-9]\d*$/.test(env.GOOGLE_ADS_CONVERSION_ACTION_ID ?? ''))
  }
  if (name === 'meta') return /^[1-9]\d*$/.test(env.META_PIXEL_ID ?? '')
  if (name === 'meta-costs') return /^(?:act_)?[1-9]\d*$/.test(env.META_AD_ACCOUNT_ID ?? '')
  return true
}

/** The URLs and methods that this one check is allowed to reach, in order. */
function routes(name: Name, env: Env, invalid: boolean, at: number): string[] {
  const oauth = 'POST https://oauth2.googleapis.com/token'
  switch (name) {
    case 'google-token': return [oauth]
    case 'google':
    case 'google-costs': {
      const dest = name === 'google' ? 'https://datamanager.googleapis.com/v1/events:ingest' :
        `https://googleads.googleapis.com/v26/customers/${env.GOOGLE_ADS_CUSTOMER_ID!.replaceAll('-', '')}/googleAds:searchStream`
      return [...(invalid ? [] : [oauth]), 'POST ' + dest]
    }
    case 'meta': return ['POST https://graph.facebook.com/v27.0/' + env.META_PIXEL_ID + '/events']
    case 'meta-costs': {
      const date = yesterday(at)
      const query = new URLSearchParams({ level: 'campaign', fields: 'campaign_id,campaign_name,spend,clicks,impressions,account_currency', time_range: JSON.stringify({ since: date, until: date }), time_increment: '1', limit: '500' })
      return [`GET https://graph.facebook.com/v27.0/act_${env.META_AD_ACCOUNT_ID!.replace(/^act_/, '')}/insights?${query}`]
    }
    case 'microsoft': return ['POST https://login.microsoftonline.com/common/oauth2/v2.0/token']
    case 'tiktok': return ['POST https://business-api.tiktok.com/open_api/v1.3/event/track/']
    case 'fingerprint': {
      const region = env.FINGERPRINT_REGION || 'us'
      if (!['us', 'eu', 'ap'].includes(region) || !/^[\w.-]{1,128}$/.test(env.FINGERPRINT_EVENT_ID!) || /^\.{1,2}$/.test(env.FINGERPRINT_EVENT_ID!)) throw Error()
      return [`GET https://${region === 'us' ? '' : region + '.'}api.fpjs.io/v4/events/${encodeURIComponent(env.FINGERPRINT_EVENT_ID!)}`]
    }
    case 'maxmind': {
      const host = env.MAXMIND_HOST || 'geoip.maxmind.com'
      const service = env.MAXMIND_SERVICE || 'insights'
      if (!isMaxMindHost(host) || !isMaxMindService(service)) throw Error()
      return [`GET https://${host}/geoip/v2.1/${service}/${host === 'sandbox.maxmind.com' ? '65.116.3.80' : '192.0.2.1'}`]
    }
    case 'twilio': return [`GET https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(env.TWILIO_LOOKUP_NUMBER!)}?Fields=line_type_intelligence`]
    case 'smarty': {
      const query = new URLSearchParams({ street: '0 QA Nonexistent Way', city: 'Example', state: 'VA', zipcode: '00000', candidates: '1' })
      if (env.SMARTY_LICENSE) query.set('license', env.SMARTY_LICENSE)
      return ['GET https://us-street.api.smarty.com/street-address?' + query]
    }
  }
}

/** Verify the serialized test request independently of the adapter before handing it to fetch. */
export function probeTransport(name: Name, env: Env, invalid: boolean, fixture: Fixture, fetcher: typeof fetch) {
  const allowed = routes(name, env, invalid, fixture.at)
  let sent = 0
  const send: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if ((init?.method ?? 'GET') + ' ' + url.href !== allowed[sent]) throw Error()
    if (name === 'google' && url.hostname === 'datamanager.googleapis.com') {
      const account = (id: string) => ({ accountType: 'GOOGLE_ADS', accountId: id.replaceAll('-', '') })
      const destination = { operatingAccount: account(env.GOOGLE_ADS_CUSTOMER_ID!), productDestinationId: env.GOOGLE_ADS_CONVERSION_ACTION_ID!,
        ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID && { loginAccount: account(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) }) }
      const event = { transactionId: fixture.transactionId, eventTimestamp: new Date(fixture.at).toISOString(), eventSource: 'WEB',
        userData: { userIdentifiers: [{ emailAddress: hashEmail(proofEmail) }] } }
      const expected = { destinations: [destination], events: [event], validateOnly: true, encoding: 'HEX' }
      if (!isDeepStrictEqual(JSON.parse(String(init?.body)), expected)) throw Error()
    }
    if (name === 'meta' || name === 'tiktok') {
      const event = { event_time: Math.floor(fixture.at / 1000), event_id: fixture.transactionId }
      const expected = name === 'meta'
        ? { test_event_code: env.META_TEST_EVENT_CODE, data: [{ ...event, event_name: 'Lead', action_source: 'other', user_data: { em: [hashEmail(proofEmail)] } }] }
        : { test_event_code: env.TIKTOK_TEST_EVENT_CODE, event_source: 'web', event_source_id: env.TIKTOK_PIXEL_CODE,
            data: [{ ...event, event: 'CompleteRegistration', user: { email: hashEmail(proofEmail) }, page: { url: 'https://example.org/' } }] }
      if (!isDeepStrictEqual(JSON.parse(String(init?.body)), expected)) throw Error()
    }
    sent++
    return fetcher(url.href, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(30_000) })
  }
  return { send, complete: () => sent === allowed.length }
}

function googleToken(env: Env, fetcher: typeof fetch, scope: string, invalid: boolean) {
  const account = invalid
    ? { client_email: 'proof@example.org', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
    : JSON.parse(readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE!, 'utf8'))
  return createGoogleTokens(account, { scope, fetch: fetcher })
}

async function event(target: Target, action: string, fixture: Fixture) {
  const outcome = { ...fixture, subject: 'live-check' }
  const job: Job = {
    transactionId: outcome.transactionId, subject: outcome.subject, at: outcome.at, target: target.name, action, source: 'OTHER',
    keys: target.keys(outcome), state: 'pending', attempts: 1, due: 0,
  }
  await target.deliver(action, [{ job, touch: undefined, consent: undefined }])
}

async function run(name: Name, env: Env, fetcher: typeof fetch, invalid: boolean, fixture: Fixture): Promise<string> {
  switch (name) {
    case 'fingerprint': {
      const region = env.FINGERPRINT_REGION || 'us'
      if (region !== 'us' && region !== 'eu' && region !== 'ap') throw Error()
      const verify = createFingerprintVerifier({ secretKey: env.FINGERPRINT_SECRET!, region, fetch: fetcher })
      const found = await verify(env.FINGERPRINT_EVENT_ID!)
      if (!found || found.eventId !== env.FINGERPRINT_EVENT_ID || !trusted(found, { now: Date.now() })) throw Error()
      return 'Server API returned the requested identification within the graph’s age and confidence limits.'
    }
    case 'maxmind': {
      const host = env.MAXMIND_HOST || 'geoip.maxmind.com'
      const service = env.MAXMIND_SERVICE || 'insights'
      if (!isMaxMindHost(host) || !isMaxMindService(service)) throw Error()
      const lookup = createMaxMindLookup({ host, service, accountId: env.MAXMIND_ACCOUNT_ID!, licenseKey: env.MAXMIND_LICENSE_KEY!, fetch: fetcher })
      if (host === 'sandbox.maxmind.com') {
        if ((await lookup('65.116.3.80'))?.country !== 'US') throw Error()
        return 'The sandbox returned the published country for its test IP.'
      }
      if (await lookup('192.0.2.1')) throw Error()
      return 'The service reported a reserved or missing IP. No geographic result was tested.'
    }
    case 'google-token': {
      await googleToken(env, fetcher, 'https://www.googleapis.com/auth/datamanager', invalid)()
      return 'Google issued a Data Manager token. No Ads destination was checked.'
    }
    case 'google': {
      const request = ingestRequest({
        customerId: env.GOOGLE_ADS_CUSTOMER_ID!, conversionActionId: env.GOOGLE_ADS_CONVERSION_ACTION_ID!,
        ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID && { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }),
      }, [fixture], true)
      const token = invalid ? 'invalid' : await googleToken(env, fetcher, 'https://www.googleapis.com/auth/datamanager', false)()
      const answer = await ingest(request, token, fetcher)
      if (!answer.requestId || answer.fieldWarnings?.length) throw Error()
      return 'Data Manager returned a validation receipt without field warnings. No conversion was recorded.'
    }
    case 'microsoft': {
      await createMicrosoftTokens({ clientId: env.MICROSOFT_CLIENT_ID!, refreshToken: env.MICROSOFT_REFRESH_TOKEN!, ...(env.MICROSOFT_CLIENT_SECRET && { clientSecret: env.MICROSOFT_CLIENT_SECRET }), fetch: fetcher })()
      return 'Microsoft issued an access token. No goal, sandbox upload or adjustment was checked.'
    }
    case 'meta': {
      await event(meta({ pixelId: env.META_PIXEL_ID!, accessToken: env.META_ACCESS_TOKEN!, testEventCode: env.META_TEST_EVENT_CODE!, url: 'https://example.org/', fetch: fetcher }), 'Lead', fixture)
      return 'Meta acknowledged the synthetic event. Check Test Events on the selected dataset.'
    }
    case 'tiktok': {
      const options = { pixelCode: env.TIKTOK_PIXEL_CODE!, accessToken: env.TIKTOK_ACCESS_TOKEN!, testEventCode: env.TIKTOK_TEST_EVENT_CODE!, url: 'https://example.org/', fetch: fetcher }
      await event(tiktok(options), 'CompleteRegistration', fixture)
      return 'TikTok returned code zero. Check Test Events on the selected pixel.'
    }
    case 'google-costs': {
      const date = yesterday(fixture.at)
      const read = googleCosts({
        customerId: env.GOOGLE_ADS_CUSTOMER_ID!, ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID && { loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID }),
        ...(env.GOOGLE_ADS_DEVELOPER_TOKEN && { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN }),
        accessToken: invalid ? async () => 'invalid' : googleToken(env, fetcher, 'https://www.googleapis.com/auth/adwords', false), fetch: fetcher,
      })
      await read(date, date)
      return 'The Ads report was read. Spend and attribution were not reconciled.'
    }
    case 'meta-costs': {
      const date = yesterday(fixture.at)
      await metaCosts({ adAccountId: env.META_AD_ACCOUNT_ID!, accessToken: env.META_ADS_TOKEN!, fetch: fetcher })(date, date)
      return 'The Insights report was read. Spend and attribution were not reconciled.'
    }
    case 'smarty': {
      await createAddressVerifier({ authId: env.SMARTY_AUTH_ID!, authToken: env.SMARTY_AUTH_TOKEN!, ...(env.SMARTY_LICENSE && { license: env.SMARTY_LICENSE }), fetch: fetcher })({ street: '0 QA Nonexistent Way', city: 'Example', state: 'VA', zipcode: '00000' })
      return 'The US Street API returned an empty candidate list. No deliverable address was verified.'
    }
    case 'twilio': {
      if (!/^\+[1-9]\d{1,14}$/.test(env.TWILIO_LOOKUP_NUMBER!)) throw Error()
      const lookup = createLineTypeLookup({ accountSid: env.TWILIO_ACCOUNT_SID!, authToken: env.TWILIO_AUTH_TOKEN!, fetch: fetcher })
      const line = await lookup(env.TWILIO_LOOKUP_NUMBER!)
      if (!line?.type || line.type === 'unknown') throw Error()
      return 'Lookup returned a line type. No call or SMS was placed.'
    }
  }
}

/** Checks keep raw provider replies, lookup inputs, tokens and errors off stdout and stderr. */
export async function liveCheck(args: string[], environment: Env, fetcher: typeof fetch = fetch, log: (line: string) => void = console.log): Promise<number> {
  if (args.length === 1 && args[0] === '--list') {
    list(log)
    return 0
  }
  const [choice, flag] = args
  if (!choice || !Object.hasOwn(checks, choice) || args.length > 2 || (flag !== undefined && flag !== '--invalid-key')) {
    log('Usage: npm run live-check -- NAME [--invalid-key] or --list')
    list(log)
    return 2
  }
  const name = choice as Name
  const check = checks[name]
  const invalid = flag === '--invalid-key'
  log(name + ': ' + check.sends)
  const env: Env = invalid ? dummy : environment
  if (invalid) {
    log('Invalid-key mode uses dummy inputs only; no operator credentials are read.')
    if (name === 'google' || name === 'google-costs') log('Only the data endpoint receives the dummy bearer. No OAuth request is made.')
  }
  else {
    const missing = check.keys.filter(key => !env[key]?.trim())
    if (missing.length) {
      log('No request. Set ' + missing.join(', ') + '.')
      return 2
    }
  }
  if (!validAssets(name, env)) {
    log('No request. Check the asset IDs for this provider.')
    return 2
  }
  let status: number | undefined
  const rejected = Error()
  const receive: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init)
    status = response.status
    if (invalid) {
      if (status === 401 || status === 403) throw rejected
      if (status === 400) {
        const body = await response.clone().json().catch(() => undefined)
        if (body?.error === 'invalid_grant' || body?.error === 'invalid_client' || (name === 'meta' && body?.error?.code === 190)) throw rejected
      }
      throw Error()
    }
    // The production parsers also handle incomplete records. These checks need a specific reply.
    if (response.ok && (name === 'smarty' || name === 'fingerprint' || name === 'twilio' || name === 'meta')) {
      const body = await response.clone().json()
      if (name === 'meta' && (body?.events_received !== 1 || (body.messages !== undefined && (!Array.isArray(body.messages) || body.messages.length > 0)))) throw Error()
      if (name === 'smarty' && (!Array.isArray(body) || body.length !== 0)) throw Error()
      if (name === 'fingerprint' && body?.event_id !== env.FINGERPRINT_EVENT_ID) throw Error()
      if (name === 'twilio' && body?.valid !== true) throw Error()
    }
    if (name === 'maxmind' && !response.ok && status !== 400 && status !== 404) throw Error()
    return response
  }
  try {
    const fixture = { transactionId: randomUUID(), at: Date.now(), email: proofEmail }
    const transport = probeTransport(name, env, invalid, fixture, receive)
    const result = await run(name, env, transport.send, invalid, fixture)
    if (!transport.complete()) throw Error()
    log(result)
    return 0
  } catch (error) {
    if (error === rejected) {
      log('The service refused the dummy request (HTTP ' + status + '). This checks the refusal only.')
      return 0
    }
    log('Check failed or was inconclusive.' + (status === undefined ? '' : ' Last HTTP status: ' + status + '.'))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await liveCheck(process.argv.slice(2), process.env)
