#!/usr/bin/env node
/**
 * The program. It reads the environment, and nothing else here does.
 *
 *   account-graph                    the server: the six calls, browsers, Twilio, the reviewer screen, and the workers
 *   account-graph rebuild            take the policy that is set, and work every group out again
 *   account-graph verify             compare the stored groups with that
 *   account-graph prune --before DAY delete old sightings, events and receipts
 *   account-graph retry ID [PLATFORM] put a conversion that failed back in line
 *   account-graph stats | alerts test | staff-link URL | events new-epoch
 *
 *   DATABASE_URL=postgres://… RECEIPT_SECRETS=… GRAPH_TOKEN=… ORIGINS=https://example.org npm start
 *
 * docs/operations.md lists every variable.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { internalsOf } from './client/internals.ts'
import { localGraph } from './client/local.ts'
import type { AccountGraph, LeadSources, LocalOptions } from './contract/api.ts'
import { hoursProblems } from './core/hours.ts'
import type { OpenHours } from './core/hours.ts'
import { normalizePhone } from './core/identifiers.ts'
import { ladderProblems } from './core/ladder.ts'
import type { Ladder } from './core/ladder.ts'
import { createRangeLookup } from './core/lookups.ts'
import { defaultPolicy, policyProblems, REBUILD_NOTICE } from './core/policy.ts'
import { RECEIPT_RETENTION } from './core/receipts.ts'
import { staffLink } from './core/sign.ts'
import { checkTags } from './core/tags.ts'
import { validPageRules } from './edge/collect.ts'
import { targetProblems } from './core/targets.ts'
import { createEdge } from './edge/index.ts'
import type { EdgeOptions } from './edge/index.ts'
import { networks, reviewerProblems } from './edge/server.ts'
import type { Reviewers } from './edge/server.ts'
import { edgeLeadProblems, serviceTokenProblems } from './edge/tokens.ts'
import { repeatsName } from './contract/lead-settings.ts'
import type { ServiceToken } from './edge/tokens.ts'
import { isMaxMindHost, isMaxMindService } from './providers/maxmind.ts'

type Env = Record<string, string | undefined>

/** What the environment asks for, checked. Throws one error that names everything wrong. */
export function readEnvironment(env: Env) {
  const wrong: string[] = []
  const need = (name: string) => env[name] || (wrong.push(`${name} is required`), '')
  const number = (name: string, fallback: number) => {
    if (!env[name]) return fallback
    const value = Number(env[name])
    if (!Number.isFinite(value) || value < 0) wrong.push(`${name} must be a number`)
    return value
  }
  // A variable that holds JSON: an object, or nothing.
  const parsed = (name: string, text = env[name] || undefined): Record<string, any> | undefined => {
    if (text === undefined) return undefined
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Reviewer values are strings or lists of strings. JSON.parse alone drops a repeated name.
        if (name === 'REVIEW_TOKENS') {
          const names = Array.from(text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?/g), match => match[0]).filter(token => token.endsWith(':')).map(token => JSON.parse(token.slice(0, -1)))
          if (new Set(names).size !== names.length) wrong.push('REVIEW_TOKENS requires unique names')
        }
        return value
      }
    } catch {}
    wrong.push(`${name} must be a JSON object`)
    return undefined
  }
  // A long list of numbers is kept in a file.
  const numbersFrom = env.CALL_NUMBERS_FILE ? 'CALL_NUMBERS_FILE' : 'CALL_NUMBERS'
  const callNumbers = (): Record<string, any> | undefined => {
    if (!env.CALL_NUMBERS_FILE) return parsed('CALL_NUMBERS')
    if (env.CALL_NUMBERS) return void wrong.push('CALL_NUMBERS and CALL_NUMBERS_FILE must not both be set')
    try {
      return parsed('CALL_NUMBERS_FILE', readFileSync(env.CALL_NUMBERS_FILE, 'utf8'))
    } catch {
      return void wrong.push(`CALL_NUMBERS_FILE: "${env.CALL_NUMBERS_FILE}" cannot be read`)
    }
  }
  const serviceTokens = (): readonly ServiceToken[] | undefined => {
    if (env.SERVICE_TOKENS === undefined && env.SERVICE_TOKENS_FILE === undefined) return undefined
    if (env.SERVICE_TOKENS !== undefined && env.SERVICE_TOKENS_FILE !== undefined) return void wrong.push('SERVICE_TOKENS and SERVICE_TOKENS_FILE must not both be set')
    try {
      const value: unknown = JSON.parse(env.SERVICE_TOKENS ?? readFileSync(env.SERVICE_TOKENS_FILE!, 'utf8'))
      if (Array.isArray(value)) return value
    } catch {}
    return void wrong.push('SERVICE_TOKENS must be a JSON list, given directly or in a readable SERVICE_TOKENS_FILE')
  }
  const leadSources = (): LeadSources | undefined => {
    // Empty is unset, as for STAGES, because Compose passes an empty LEADS when the host has none.
    const given = env.LEADS || undefined
    const file = env.LEADS_FILE || undefined
    if (given === undefined && file === undefined) return undefined
    if (given !== undefined && file !== undefined) return void wrong.push('LEADS and LEADS_FILE must not both be set')
    try {
      const text = given ?? readFileSync(file!, 'utf8')
      const value = parsed('LEADS', text) as LeadSources | undefined
      if (value && repeatsName(text)) wrong.push('LEADS requires unique source names')
      return value
    } catch {
      return void wrong.push('LEADS_FILE cannot be read')
    }
  }
  const serverRanges = (): string | undefined => {
    if (!env.SERVER_RANGES_FILE) return undefined
    try {
      const ranges = readFileSync(env.SERVER_RANGES_FILE, 'utf8')
      createRangeLookup(ranges)
      return ranges
    } catch (error) {
      return void wrong.push(`SERVER_RANGES_FILE: ${error instanceof TypeError ? error.message : `"${env.SERVER_RANGES_FILE}" cannot be read`}`)
    }
  }
  // A group of variables that only make sense together: all or none.
  const group = (names: string[]) => {
    const set = names.filter((name) => env[name])
    if (set.length > 0 && set.length < names.length) wrong.push(`${names.filter((name) => !env[name]).join(', ')} must be set along with ${set.join(', ')}`)
    return set.length === names.length
  }

  // The policy, from a variable or a file. Only what differs from the default is named.
  const policyGiven = (): unknown => {
    if (env.POLICY && env.POLICY_FILE) return void wrong.push('POLICY and POLICY_FILE must not both be set')
    const name = env.POLICY ? 'POLICY' : 'POLICY_FILE'
    if (!env[name]) return undefined
    let text = env.POLICY ?? ''
    try {
      if (env.POLICY_FILE) text = readFileSync(env.POLICY_FILE, 'utf8')
    } catch {
      return void wrong.push(`POLICY_FILE: "${env.POLICY_FILE}" cannot be read`)
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return void wrong.push(`${name} must be JSON`)
    }
    const problems = policyProblems(value)
    for (const problem of problems) wrong.push(`${name}: ${problem}`)
    return problems.length > 0 ? undefined : value
  }
  const policy = policyGiven()
  for (const name of ['MICROSOFT_SANDBOX', 'META_CLIENT_USER_AGENT', 'GOOGLE_ADS_COSTS']) {
    if (env[name] && !['true', 'false'].includes(env[name]!)) wrong.push(`${name} must be true or false`)
  }
  const readGoogleCosts = env.GOOGLE_ADS_COSTS ? env.GOOGLE_ADS_COSTS === 'true' : Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN)
  if (readGoogleCosts && !env.GOOGLE_ADS_CUSTOMER_ID && !env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    wrong.push('Google cost reporting requires GOOGLE_ADS_CUSTOMER_ID and GOOGLE_SERVICE_ACCOUNT_FILE')
  }

  const maxMindHost = env.MAXMIND_HOST || 'geoip.maxmind.com'
  const maxMindService = env.MAXMIND_SERVICE || 'insights'
  const host = isMaxMindHost(maxMindHost) ? maxMindHost : undefined
  const service = isMaxMindService(maxMindService) ? maxMindService : undefined
  if (env.MAXMIND_ACCOUNT_ID && !host) wrong.push('MAXMIND_HOST must be geoip.maxmind.com, geolite.info or sandbox.maxmind.com')
  if (env.MAXMIND_ACCOUNT_ID && !service) wrong.push('MAXMIND_SERVICE must be insights, city or country')
  const config = {
    databaseUrl: need('DATABASE_URL'),
    receiptSecrets: need('RECEIPT_SECRETS').split(',').map((each) => each.trim()).filter(Boolean),
    webhookUrl: env.WEBHOOK_URL || undefined,
    webhookSecret: env.WEBHOOK_SECRET || undefined,
    schema: env.GRAPH_SCHEMA || 'account_graph',
    token: need('GRAPH_TOKEN'),
    serviceTokens: serviceTokens(),
    leads: leadSources(),
    reviewers: parsed('REVIEW_TOKENS') as Reviewers | undefined,
    origins: (env.ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
    port: number('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : env.TRUST_PROXY === 'false' ? 0 : number('TRUST_PROXY', 0),
    cookie: env.COOKIE === 'true' ? true : env.COOKIE && env.COOKIE !== 'false' ? { domain: env.COOKIE } : false,
    limit: env.RATE_LIMIT === 'off' ? (false as const) : { perMinute: number('RATE_PER_MINUTE', 120), burst: number('RATE_BURST', 60) },
    outboxDelay: number('OUTBOX_DELAY_MS', 0),
    forgetAds: env.FORGET_ADS === 'true',
    linkSecret: env.LINK_SECRET || undefined,
    identifierSecret: env.IDENTIFIER_SECRET || undefined,
    alertWebhook: env.ALERT_WEBHOOK || undefined,
    auditHours: number('AUDIT_HEAD_HOURS', 0),
    quiet: { touches: number('QUIET_TOUCHES_HOURS', 0), calls: number('QUIET_CALLS_HOURS', 0), results: number('QUIET_RESULTS_HOURS', 0), costs: number('QUIET_COSTS_HOURS', 0) },
    returnHours: number('RETURN_HOURS', 24),
    openHours: parsed('OPEN_HOURS') as OpenHours | undefined,
    lateHours: number('LATE_HOURS', 6),
    targets: parsed('TARGETS') as LocalOptions['targets'],
    stages: parsed('STAGES') as Ladder | undefined,
    policy,
    ...(env.ALLOW_PAGES !== undefined && { allowPages: env.ALLOW_PAGES.split(',').map(each => each.trim()).filter(Boolean) }),
    ...(env.REFUSE_PAGES !== undefined && { refusePages: env.REFUSE_PAGES.split(',').map(each => each.trim()).filter(Boolean) }),
    staffNetworks: (env.STAFF_NETWORKS ?? '').split(',').map((each) => each.trim()).filter(Boolean),
    timeZone: env.REPORT_TIME_ZONE || 'UTC',
    events: (env.EVENTS ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    callNumbers: callNumbers(),
    callExclude: (env.CALL_EXCLUDE ?? '').split(',').map((each) => each.trim()).filter(Boolean),
    callMinimum: number('CALL_MIN_SECONDS', 30),
    callTapSeconds: number('CALL_TAP_SECONDS', 180),
    textCodes: env.TEXT_CODES === 'true',
    twilioTexts: env.TWILIO_AUTH_TOKEN && env.TWILIO_TEXT_WEBHOOK_URL ? { authToken: env.TWILIO_AUTH_TOKEN, url: env.TWILIO_TEXT_WEBHOOK_URL } : undefined,
    callResults: env.CALL_RESULTS || undefined,
    callResultWait: number('CALL_RESULT_WAIT', 30),
    poolNumbers: (env.POOL_NUMBERS ?? '').split(',').map((each) => each.trim()).filter(Boolean),
    poolMinutes: number('POOL_MINUTES', 15),
    poolGrace: number('POOL_GRACE_MINUTES', 120),
    poolRequireTapAfterReassignment: env.POOL_REQUIRE_TAP_AFTER_REASSIGNMENT === 'true',
    // One Twilio token covers two things, each switched on by its second variable: call reports and line lookups.
    twilio: env.TWILIO_AUTH_TOKEN && env.TWILIO_WEBHOOK_URL ? { authToken: env.TWILIO_AUTH_TOKEN, url: env.TWILIO_WEBHOOK_URL } : undefined,
    lineType: env.TWILIO_AUTH_TOKEN && env.TWILIO_ACCOUNT_SID ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN } : undefined,
    smarty: group(['SMARTY_AUTH_ID', 'SMARTY_AUTH_TOKEN']) ? { authId: env.SMARTY_AUTH_ID!, authToken: env.SMARTY_AUTH_TOKEN!, ...(env.SMARTY_LICENSE && { license: env.SMARTY_LICENSE }) } : undefined,
    googleCosts: readGoogleCosts
      ? group(['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'])
        ? { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId: env.GOOGLE_ADS_CUSTOMER_ID!, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_FILE!, conversions: env.GOOGLE_ADS_CONVERSIONS === 'true' }
        : undefined
      : undefined,
    metaCosts: group(['META_AD_ACCOUNT_ID', 'META_ADS_TOKEN']) ? { adAccountId: env.META_AD_ACCOUNT_ID!, accessToken: env.META_ADS_TOKEN!, ...(env.META_ADS_CONVERSIONS && { conversions: env.META_ADS_CONVERSIONS }) } : undefined,
    fingerprint: env.FINGERPRINT_SECRET ? { secretKey: env.FINGERPRINT_SECRET, region: (env.FINGERPRINT_REGION || 'us') as 'us' | 'eu' | 'ap' } : undefined,
    serverRanges: serverRanges(),
    maxmind: group(['MAXMIND_ACCOUNT_ID', 'MAXMIND_LICENSE_KEY']) && host && service
      ? {
          accountId: env.MAXMIND_ACCOUNT_ID!,
          licenseKey: env.MAXMIND_LICENSE_KEY!,
          service,
          host,
        }
      : undefined,
    google:
      env.GOOGLE_ADS_CUSTOMER_ID || env.GOOGLE_SERVICE_ACCOUNT_FILE
        ? group(['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'])
          ? { customerId: env.GOOGLE_ADS_CUSTOMER_ID!, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_FILE! }
          : undefined
        : undefined,
    meta: group(['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'META_SITE_URL'])
      ? { pixelId: env.META_PIXEL_ID!, accessToken: env.META_ACCESS_TOKEN!, url: env.META_SITE_URL!, testEventCode: env.META_TEST_EVENT_CODE, clientUserAgent: env.META_CLIENT_USER_AGENT === 'true' }
      : undefined,
    tiktok: group(['TIKTOK_PIXEL_CODE', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_SITE_URL'])
      ? { pixelCode: env.TIKTOK_PIXEL_CODE!, accessToken: env.TIKTOK_ACCESS_TOKEN!, url: env.TIKTOK_SITE_URL!, testEventCode: env.TIKTOK_TEST_EVENT_CODE }
      : undefined,
    microsoft: group(['MICROSOFT_CLIENT_ID', 'MICROSOFT_REFRESH_TOKEN', 'MICROSOFT_DEVELOPER_TOKEN', 'MICROSOFT_CUSTOMER_ID', 'MICROSOFT_ACCOUNT_ID'])
      ? {
          clientId: env.MICROSOFT_CLIENT_ID!,
          refreshToken: env.MICROSOFT_REFRESH_TOKEN!,
          clientSecret: env.MICROSOFT_CLIENT_SECRET,
          sandbox: env.MICROSOFT_SANDBOX === 'true',
          developerToken: env.MICROSOFT_DEVELOPER_TOKEN!,
          customerId: env.MICROSOFT_CUSTOMER_ID!,
          customerAccountId: env.MICROSOFT_ACCOUNT_ID!,
        }
      : undefined,
  }
  if (config.fingerprint && !['us', 'eu', 'ap'].includes(config.fingerprint.region)) wrong.push('FINGERPRINT_REGION must be us, eu, or ap')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timeZone })
  } catch {
    wrong.push('REPORT_TIME_ZONE must be a time zone, such as America/New_York')
  }
  if (env.CHANGE_WEBHOOK || env.CHANGE_SECRET) wrong.push('CHANGE_WEBHOOK and CHANGE_SECRET are now WEBHOOK_URL and WEBHOOK_SECRET')
  if (Boolean(config.webhookUrl) !== Boolean(config.webhookSecret)) wrong.push('WEBHOOK_URL and WEBHOOK_SECRET must be set together')
  if (config.receiptSecrets.some((each) => each.length < 32)) wrong.push('RECEIPT_SECRETS must each be at least 32 characters')
  if (config.callTapSeconds > 3600) wrong.push('CALL_TAP_SECONDS must be at most 3600')
  if (config.targets !== undefined) for (const problem of targetProblems(config.targets)) wrong.push(`TARGETS: ${problem}`)
  if (config.openHours !== undefined) for (const problem of hoursProblems(config.openHours)) wrong.push(`OPEN_HOURS: ${problem}`)
  if (!validPageRules(config)) wrong.push('ALLOW_PAGES and REFUSE_PAGES require literal paths or subtrees ending in /*')
  for (const each of config.staffNetworks) {
    try {
      networks([each])
    } catch (error) {
      wrong.push(`STAFF_NETWORKS: ${(error as Error).message}`)
    }
  }
  for (const [number, channel] of Object.entries(config.callNumbers ?? {})) {
    try {
      normalizePhone(number)
    } catch {
      wrong.push(`${numbersFrom}: "${number}" is not a phone number`)
    }
    if (typeof channel?.source !== 'string' || !channel.source) wrong.push(`${numbersFrom}: "${number}" requires a source, such as {"source":"google"}`)
    try {
      checkTags(channel?.tags, `"${number}"`)
    } catch (error) {
      wrong.push(`${numbersFrom}: ${(error as Error).message}`)
    }
  }
  for (const each of config.callExclude) {
    try {
      normalizePhone(each)
    } catch {
      wrong.push(`CALL_EXCLUDE: "${each}" is not a phone number`)
    }
  }
  for (const each of config.poolNumbers) {
    try {
      normalizePhone(each)
    } catch {
      wrong.push(`POOL_NUMBERS: "${each}" is not a phone number`)
    }
  }
  if (config.poolNumbers.length > 0 && config.poolMinutes < 1) wrong.push('POOL_MINUTES must be at least 1')
  if (config.callResults !== undefined && config.callResults !== 'expected') wrong.push('CALL_RESULTS must be expected, or not set')
  const twilioNames = ['TWILIO_AUTH_TOKEN', 'TWILIO_WEBHOOK_URL', 'TWILIO_TEXT_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID'].filter((name) => env[name])
  if (twilioNames.length > 0 && !config.twilio && !config.twilioTexts && !config.lineType) {
    wrong.push(env.TWILIO_AUTH_TOKEN ? 'TWILIO_WEBHOOK_URL, TWILIO_TEXT_WEBHOOK_URL or TWILIO_ACCOUNT_SID must be set along with TWILIO_AUTH_TOKEN' : `TWILIO_AUTH_TOKEN must be set along with ${twilioNames.join(', ')}`)
  }
    if (config.stages) {
    const targets = [config.google && 'google', config.meta && 'meta', config.tiktok && 'tiktok', config.microsoft && 'microsoft'].filter((name): name is string => Boolean(name))
    for (const problem of ladderProblems(config.stages, targets)) wrong.push(`STAGES: ${problem}`)
  }
    if (config.linkSecret !== undefined && config.linkSecret.length < 32) wrong.push('LINK_SECRET must be at least 32 characters')
  if (config.identifierSecret !== undefined && config.identifierSecret.length < 32) wrong.push('IDENTIFIER_SECRET must be at least 32 characters')
  if (config.token && !config.token.trim()) wrong.push('GRAPH_TOKEN requires a nonempty token')
  for (const problem of reviewerProblems(config.reviewers, config.token)) wrong.push(`REVIEW_TOKENS: ${problem}`)
  for (const problem of serviceTokenProblems(config.serviceTokens, config.reviewers, config.token)) wrong.push(`SERVICE_TOKENS: ${problem}`)
  for (const problem of edgeLeadProblems(config, secretSettings(env))) wrong.push(`LEADS: ${problem}`)
  // The secrets in compose.yaml are in the repository for anyone to read, so they are only for trying it out.
  const far = config.origins.find((origin) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/.test(origin))
  const secrets = { SERVICE_TOKENS: (config.serviceTokens ?? []).map(entry => entry?.token), GRAPH_TOKEN: [config.token], REVIEW_TOKENS: Object.values(config.reviewers ?? {}).flat(), LINK_SECRET: [config.linkSecret], RECEIPT_SECRETS: config.receiptSecrets }
  if (far) for (const [name, held] of Object.entries(secrets)) if (held.some((each) => String(each).startsWith('change-me'))) wrong.push(`${name} must be changed before taking visits from ${far}`)
  if (config.auditHours > 0 && !config.alertWebhook) wrong.push('ALERT_WEBHOOK is required with AUDIT_HEAD_HOURS')
  if (wrong.length > 0) throw new Error(`Cannot start:\n  ${wrong.join('\n  ')}`)
  return config
}

/** Settings that hold a secret, which a lead source's secret must not repeat. REVIEW_TOKENS and SERVICE_TOKENS are checked as read. */
const SECRET_SETTINGS = [
  'GRAPH_TOKEN', 'LINK_SECRET', 'IDENTIFIER_SECRET', 'WEBHOOK_SECRET', 'FINGERPRINT_SECRET', 'TWILIO_AUTH_TOKEN', 'SMARTY_AUTH_TOKEN', 'MAXMIND_LICENSE_KEY', 'GOOGLE_ADS_DEVELOPER_TOKEN',
  'META_ADS_TOKEN', 'META_ACCESS_TOKEN', 'TIKTOK_ACCESS_TOKEN', 'MICROSOFT_REFRESH_TOKEN', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_DEVELOPER_TOKEN',
] as const

function secretSettings(env: Env): string[] {
  let password = ''
  try {
    password = decodeURIComponent(new URL(env.DATABASE_URL ?? '').password)
  } catch {}
  const receipts = (env.RECEIPT_SECRETS ?? '').split(',').map((each) => each.trim())
  return [...SECRET_SETTINGS.map((name) => env[name]), ...receipts, password].filter((each): each is string => Boolean(each))
}

/** What the program is asked to be, from the environment. Throws one error that names everything wrong. */
export function configFrom(env: Env): { graph: LocalOptions; edge: EdgeOptions; port: number; host: string } {
  const config = readEnvironment(env)
  const account = (keyFile: string) => JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email: string; private_key: string }
  const named = Object.entries((config.policy as { kinds?: Record<string, unknown> } | undefined)?.kinds ?? {})
  const own = (built: boolean) => Object.fromEntries(named.filter(([kind]) => Object.hasOwn(defaultPolicy.kinds, kind) === built))
  const stages = config.stages && Object.fromEntries(Object.entries(config.stages).map(([name, { action, ...stage }]) => [name, { ...stage, ...(action !== undefined && { action: action as Record<string, string> }) }]))
  const google = config.google && { customerId: config.google.customerId, ...(config.google.loginCustomerId && { loginCustomerId: config.google.loginCustomerId }), serviceAccount: account(config.google.keyFile) }
  const graph = {
    databaseUrl: config.databaseUrl,
    schema: config.schema,
    workers: true,
    receiptSecrets: config.receiptSecrets as [string, ...string[]],
    ...(config.leads && { leads: config.leads }),
    timeZone: config.timeZone,
    ...(config.policy !== undefined && { policy: { ...(config.policy as object), kinds: own(true), customKinds: own(false) } as NonNullable<LocalOptions['policy']> }),
    ...(config.identifierSecret && { identifierSecret: config.identifierSecret }),
    ...(config.linkSecret && { linkSecret: config.linkSecret }),
    ...(config.openHours && { openHours: config.openHours as NonNullable<LocalOptions['openHours']> }),
    ...(stages && { stages }),
    ...(config.targets && { targets: config.targets }),
    phones: {
      ...(config.callNumbers && { numbers: config.callNumbers }), exclude: config.callExclude, minimumSeconds: config.callMinimum, tapSeconds: config.callTapSeconds, returnHours: config.returnHours,
      ...(config.callResults === 'expected' && { resultsExpectedWithinMinutes: config.callResultWait }),
      ...(config.poolNumbers.length > 0 && { pool: { numbers: config.poolNumbers, minutes: config.poolMinutes, graceMinutes: config.poolGrace, requireTapAfterReassignment: config.poolRequireTapAfterReassignment } }),
    },
    ads: {
      retractOnForget: config.forgetAds, delayMs: config.outboxDelay,
      ...(google && { google }),
      ...(config.meta && { meta: { pixelId: config.meta.pixelId, accessToken: config.meta.accessToken, siteUrl: config.meta.url, clientUserAgent: config.meta.clientUserAgent, ...(config.meta.testEventCode && { testEventCode: config.meta.testEventCode }) } }),
      ...(config.tiktok && { tiktok: { pixelCode: config.tiktok.pixelCode, accessToken: config.tiktok.accessToken, siteUrl: config.tiktok.url, ...(config.tiktok.testEventCode && { testEventCode: config.tiktok.testEventCode }) } }),
      ...(config.microsoft && { microsoft: { clientId: config.microsoft.clientId, refreshToken: config.microsoft.refreshToken, developerToken: config.microsoft.developerToken, customerId: config.microsoft.customerId, accountId: config.microsoft.customerAccountId, sandbox: config.microsoft.sandbox, ...(config.microsoft.clientSecret && { clientSecret: config.microsoft.clientSecret }) } }),
    },
    costs: {
      ...(config.googleCosts && { google: { customerId: config.googleCosts.customerId, ...(config.googleCosts.developerToken && { developerToken: config.googleCosts.developerToken }), serviceAccount: account(config.googleCosts.keyFile), conversions: config.googleCosts.conversions, ...(config.googleCosts.loginCustomerId && { loginCustomerId: config.googleCosts.loginCustomerId }) } }),
      ...(config.metaCosts && { meta: config.metaCosts }),
    },
    checks: { ...(config.smarty && { address: config.smarty }), ...(config.lineType && { lineType: config.lineType }) },
    monitor: { quietHours: config.quiet, lateHours: config.lateHours, auditHours: config.auditHours },
    ...(config.webhookUrl && { webhook: { url: config.webhookUrl, secret: config.webhookSecret! } }),
    ...(config.alertWebhook && { alerts: { url: config.alertWebhook } }),
  } satisfies LocalOptions
  const twilio = config.twilio ?? config.twilioTexts
  const edge: EdgeOptions = {
    ...(config.allowPages && { allowPages: config.allowPages }),
    ...(config.refusePages && { refusePages: config.refusePages }),
    token: config.token, origins: config.origins, limit: config.limit, trustProxy: config.trustProxy, staffNetworks: config.staffNetworks, events: config.events, textCodes: config.textCodes,
    ...(config.reviewers && { reviewers: config.reviewers }),
    ...(config.serviceTokens && { serviceTokens: config.serviceTokens }),
    ...(config.cookie && { cookie: config.cookie }),
    ...(twilio && { twilio: { authToken: twilio.authToken, ...(config.twilio && { calls: config.twilio.url }), ...(config.twilioTexts && { texts: config.twilioTexts.url }) } }),
    ...(config.fingerprint && { fingerprint: config.fingerprint }),
    ...(config.maxmind && { maxmind: config.maxmind }),
    ...(config.serverRanges !== undefined && { serverRanges: config.serverRanges }),
  }
  return { graph, edge, port: config.port, host: config.host }
}

export interface Running {
  /** The port it is listening on. */
  port: number
  graph: AccountGraph
  /** Stops taking requests, writes what waits, stops the workers, and closes the database connections. */
  close(): Promise<void>
}

/** Starts the server. `log` receives one line per thing worth telling an operator. */
export async function serve(env: Env, log: (line: string) => void = console.log): Promise<Running> {
  const { graph: options, edge: edging, port: asked, host } = configFrom(env)
  const graph = localGraph(options, { log })
  let due: boolean
  let hash: string
  try {
    ;({ due, hash } = await (await internalsOf(graph)!()).engine.graph.policy())
  } catch (error) {
    await graph.close()
    throw new Error(`Cannot start:\n  ${(error as Error).message}`)
  }
  const edge = createEdge(graph, edging)
  const server = createServer(edge)
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(asked, host, resolve))
  const { port } = server.address() as AddressInfo

  const on = (name: string, enabled: unknown) => `${name} ${enabled ? 'on' : 'off'}`
  const { ads, costs, checks, phones, stages } = options
  const platforms = ['google', 'meta', 'tiktok', 'microsoft'].filter((name) => Object.hasOwn(ads ?? {}, name) && typeof (ads as Record<string, unknown>)[name] === 'object')
  log(`listening on ${host}:${port}`)
  log(`collect accepts ${edging.origins && edging.origins.length > 0 ? edging.origins.join(', ') : 'no origins yet (set ORIGINS)'}`)
  log([Object.keys(edging.reviewers ?? {}).length > 0 ? `reviewers ${Object.keys(edging.reviewers!).join(', ')}` : 'reviewers none', on('server cookie', edging.cookie), on('fingerprint', edging.fingerprint), on('maxmind', edging.maxmind), on('server ranges', edging.serverRanges), on('signed links', options.linkSecret), on('staff networks', (edging.staffNetworks ?? []).length > 0), on('opening hours', options.openHours), on('webhook', options.webhook), on('alerts', options.alerts), on('address checks', checks?.address), on('phone line checks', checks?.lineType)].join(', '))
  log(`outbox sends to ${platforms.length > 0 ? platforms.join(', ') : 'none (no ad platform configured)'}`)
  if (stages) log(`steps: ${Object.entries(stages).map(([name, stage]) => `${name}${stage.value === undefined ? '' : ` ${stage.value}`}`).join(', ')}`)
  log(`page events: ${(edging.events ?? []).join(', ') || 'none (set EVENTS)'}; calls from twilio ${edging.twilio?.calls ? 'on' : 'off'}; texts from twilio ${edging.twilio?.texts ? 'on' : 'off'}; text codes ${edging.textCodes ? 'on' : 'off'}; number pool ${phones?.pool ? `of ${phones.pool.numbers.length}` : 'off'}`)
  log(`cost sources: ${Object.keys(costs ?? {}).join(', ') || 'none (record cost)'}`)
  log(`policy ${hash.slice(0, 12)} ${options.policy ? '(configured)' : '(default)'}`)
  if (due) log(REBUILD_NOTICE)

  return {
    port,
    graph,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections()
        setTimeout(() => server.closeAllConnections(), 5_000).unref()
      })
      await edge.drain()
      await graph.close()
    },
  }
}

/** Runs one command and says what came of it. */
export async function command(env: Env, args: readonly string[], log: (line: string) => void = console.log): Promise<void> {
  const [name, ...rest] = args
  const { graph: options } = configFrom(env)
  const graph = localGraph({ ...options, workers: false, timeoutMs: 24 * 3_600_000 }, { adopt: name === 'rebuild' })
  const show = (value: unknown) => log(JSON.stringify(value, null, 2))
  const usage = (text: string): never => {
    throw new Error(`Usage: account-graph ${text}`)
  }
  try {
    const { engine, ops } = await internalsOf(graph)!()
    switch (name) {
      case 'rebuild':
        return log(`${(await engine.graph.rebuild({ by: 'command line' })).length} subjects moved`)
      case 'verify': {
        const { changes, policy } = await engine.graph.check()
        return show({ changes, policy: { hash: policy.hash, builtWith: policy.builtWith ?? null, due: policy.due } })
      }
      case 'prune': {
        const day = rest[0] === '--before' ? rest[1] : undefined
        const before = Date.parse(`${day}T00:00:00Z`)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || Number.isNaN(before)) usage('prune --before YYYY-MM-DD')
        const pruned = await engine.graph.prune(before, { by: 'command line' })
        // A key may be sent again for as long as its receipt is kept, so those stay a year whatever is asked.
        const year = Math.min(before, engine.now() - RECEIPT_RETENTION)
        const { events, receipts } = await engine.store.write(async (tx) => ({ events: await tx.pruneEvents(before), receipts: await tx.pruneReceipts(year) }))
        return show({ pruned, events, receipts })
      }
      case 'retry': {
        const [id, platform] = rest
        if (!id) usage('retry CONVERSION [PLATFORM]')
        if (!engine.outbox) throw new Error('No ad platform is configured')
        return show((await engine.outbox.retry(id!, platform)).map(({ keys: _, metaUserAgent: __, ...job }) => job))
      }
      case 'stats':
        return show({ graph: await engine.graph.counts(), ...(engine.outbox && { outbox: await engine.outbox.counts() }) })
      case 'alerts':
        return rest[0] === 'test' ? show(await ops.test()) : usage('alerts test')
      case 'staff-link':
        if (!rest[0] || !options.linkSecret) usage('staff-link URL, with LINK_SECRET set')
        return log(staffLink(rest[0]!, { secret: options.linkSecret! }))
      case 'events':
        return rest[0] === 'new-epoch' ? log(`history ${await engine.store.write((tx) => tx.newEpoch())} begins: every cursor is lost`) : usage('events new-epoch')
      default:
        usage('[rebuild | verify | prune | retry | stats | alerts test | staff-link | events new-epoch]')
    }
  } finally {
    await graph.close()
  }
}

// Run when this file is the program, not when it is imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 0) await command(process.env, args)
    else {
      const running = await serve(process.env)
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void running.close().then(() => process.exit(0)))
    }
  } catch (error) {
    console.error(String((error as Error)?.message ?? error))
    process.exit(1)
  }
}
