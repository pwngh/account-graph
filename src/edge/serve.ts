#!/usr/bin/env node
/**
 * The server, started with one command and configured by environment
 * variables. It brings the database up to date, serves the routes, and sends
 * what the outbox holds.
 *
 *   DATABASE_URL=postgres://… GRAPH_TOKEN=… ORIGINS=https://example.org npm start
 *
 * docs/operations.md lists every variable.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createBatcher } from '../core/batch.ts'
import { ingest } from '../providers/conversions.ts'
import { createGraph } from '../core/graph.ts'
import { normalizePhone } from '../core/identifiers.ts'
import type { Graph } from '../core/graph.ts'
import { googleCosts, metaCosts } from '../providers/costs.ts'
import type { CostSource } from '../providers/costs.ts'
import { createFingerprintVerifier } from '../providers/fingerprint.ts'
import { createGoogleTokens } from '../providers/google-auth.ts'
import { createMaxMindLookup } from '../providers/maxmind.ts'
import type { IpLookup } from '../providers/maxmind.ts'
import { createRangeLookup } from '../core/lookups.ts'
import { createHours, hoursProblems } from '../core/hours.ts'
import type { OpenHours } from '../core/hours.ts'
import { ladderProblems } from '../core/ladder.ts'
import type { Ladder } from '../core/ladder.ts'
import { defaultPolicy, policyFrom, policyProblems } from '../core/policy.ts'
import { createMicrosoftTokens } from '../providers/microsoft-auth.ts'
import { createAddressVerifier } from '../providers/smarty.ts'
import { createLineTypeLookup } from '../providers/twilio.ts'
import { createOps } from '../core/ops.ts'
import { createOutbox } from '../core/outbox.ts'
import type { Target } from '../core/outbox.ts'
import { createPostgresStore } from '../store/postgres.ts'
import { bodySignature } from '../core/sign.ts'
import type { Pool } from '../store/postgres.ts'
import { createHandler, networks, reviewerProblems } from './server.ts'
import type { HandlerOptions, Reviewers } from './server.ts'
import { checkTags } from '../core/tags.ts'
import { googleAds, meta, microsoftAds, tiktok } from '../providers/targets.ts'
import type { Change } from '../contract/types.ts'

type Env = Record<string, string | undefined>

/** What the environment asks for, checked. Throws one error that names everything wrong. */
export function configFrom(env: Env) {
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
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
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
  const serverRanges = (): IpLookup | undefined => {
    if (!env.SERVER_RANGES_FILE) return undefined
    try {
      return createRangeLookup(readFileSync(env.SERVER_RANGES_FILE, 'utf8'))
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

  const config = {
    databaseUrl: need('DATABASE_URL'),
    schema: env.GRAPH_SCHEMA || 'account_graph',
    token: need('GRAPH_TOKEN'),
    reviewers: parsed('REVIEW_TOKENS') as Reviewers | undefined,
    origins: (env.ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
    port: number('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : env.TRUST_PROXY === 'false' ? 0 : number('TRUST_PROXY', 0),
    cookie: env.COOKIE === 'true' ? true : env.COOKIE && env.COOKIE !== 'false' ? { domain: env.COOKIE } : false,
    limit: env.RATE_LIMIT === 'off' ? (false as const) : { perMinute: number('RATE_PER_MINUTE', 120), burst: number('RATE_BURST', 60) },
    outboxInterval: number('OUTBOX_INTERVAL_MS', 30_000),
    outboxDelay: number('OUTBOX_DELAY_MS', 0),
    forgetAds: env.FORGET_ADS === 'true',
    changeWebhook: env.CHANGE_WEBHOOK || undefined,
    changeSecret: env.CHANGE_SECRET || undefined,
    linkSecret: env.LINK_SECRET || undefined,
    identifierSecret: env.IDENTIFIER_SECRET || undefined,
    alertWebhook: env.ALERT_WEBHOOK || undefined,
    auditHours: number('AUDIT_HEAD_HOURS', 0),
    quiet: { touches: number('QUIET_TOUCHES_HOURS', 0), calls: number('QUIET_CALLS_HOURS', 0), results: number('QUIET_RESULTS_HOURS', 0), costs: number('QUIET_COSTS_HOURS', 0) },
    returnHours: number('RETURN_HOURS', 24),
    openHours: parsed('OPEN_HOURS') as OpenHours | undefined,
    lateHours: number('LATE_HOURS', 6),
    stages: parsed('STAGES') as Ladder | undefined,
    policy: policy === undefined ? undefined : policyFrom(policy),
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
    // One Twilio token serves two things, each switched on by its second variable: call reports and line lookups.
    twilio: env.TWILIO_AUTH_TOKEN && env.TWILIO_WEBHOOK_URL ? { authToken: env.TWILIO_AUTH_TOKEN, url: env.TWILIO_WEBHOOK_URL } : undefined,
    lineType: env.TWILIO_AUTH_TOKEN && env.TWILIO_ACCOUNT_SID ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN } : undefined,
    smarty: group(['SMARTY_AUTH_ID', 'SMARTY_AUTH_TOKEN']) ? { authId: env.SMARTY_AUTH_ID!, authToken: env.SMARTY_AUTH_TOKEN! } : undefined,
    costInterval: number('COST_INTERVAL_MS', 6 * 3_600_000),
    costDays: number('COST_DAYS', 7),
    googleCosts: env.GOOGLE_ADS_DEVELOPER_TOKEN
      ? group(['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'])
        ? { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId: env.GOOGLE_ADS_CUSTOMER_ID!, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_FILE!, conversions: env.GOOGLE_ADS_CONVERSIONS === 'true' }
        : undefined
      : undefined,
    metaCosts: group(['META_AD_ACCOUNT_ID', 'META_ADS_TOKEN']) ? { adAccountId: env.META_AD_ACCOUNT_ID!, accessToken: env.META_ADS_TOKEN!, ...(env.META_ADS_CONVERSIONS && { conversions: env.META_ADS_CONVERSIONS }) } : undefined,
    fingerprint: env.FINGERPRINT_SECRET ? { secretKey: env.FINGERPRINT_SECRET, region: (env.FINGERPRINT_REGION || 'us') as 'us' | 'eu' | 'ap' } : undefined,
    serverRanges: serverRanges(),
    maxmind: group(['MAXMIND_ACCOUNT_ID', 'MAXMIND_LICENSE_KEY'])
      ? {
          accountId: env.MAXMIND_ACCOUNT_ID!,
          licenseKey: env.MAXMIND_LICENSE_KEY!,
          service: (env.MAXMIND_SERVICE || 'insights') as 'insights' | 'city' | 'country',
          host: (env.MAXMIND_HOST || 'geoip.maxmind.com') as 'geoip.maxmind.com' | 'geolite.info',
        }
      : undefined,
    google:
      env.GOOGLE_ADS_CUSTOMER_ID || env.GOOGLE_SERVICE_ACCOUNT_FILE
        ? group(['GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'])
          ? { customerId: env.GOOGLE_ADS_CUSTOMER_ID!, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_FILE! }
          : undefined
        : undefined,
    meta: group(['META_PIXEL_ID', 'META_ACCESS_TOKEN', 'META_SITE_URL'])
      ? { pixelId: env.META_PIXEL_ID!, accessToken: env.META_ACCESS_TOKEN!, url: env.META_SITE_URL!, testEventCode: env.META_TEST_EVENT_CODE }
      : undefined,
    tiktok: group(['TIKTOK_PIXEL_CODE', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_SITE_URL'])
      ? { pixelCode: env.TIKTOK_PIXEL_CODE!, accessToken: env.TIKTOK_ACCESS_TOKEN!, url: env.TIKTOK_SITE_URL! }
      : undefined,
    microsoft: group(['MICROSOFT_CLIENT_ID', 'MICROSOFT_REFRESH_TOKEN', 'MICROSOFT_DEVELOPER_TOKEN', 'MICROSOFT_CUSTOMER_ID', 'MICROSOFT_ACCOUNT_ID'])
      ? {
          clientId: env.MICROSOFT_CLIENT_ID!,
          refreshToken: env.MICROSOFT_REFRESH_TOKEN!,
          clientSecret: env.MICROSOFT_CLIENT_SECRET,
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
  if (config.changeSecret && !config.changeWebhook) wrong.push('CHANGE_SECRET requires CHANGE_WEBHOOK')
  if (config.callTapSeconds > 3600) wrong.push('CALL_TAP_SECONDS must be at most 3600')
  if (config.openHours !== undefined) for (const problem of hoursProblems(config.openHours)) wrong.push(`OPEN_HOURS: ${problem}`)
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
  for (const problem of reviewerProblems(config.reviewers, config.token)) wrong.push(`REVIEW_TOKENS: ${problem}`)
  // The secrets in compose.yaml are in the repository for anyone to read, so they are only for trying it out.
  const far = config.origins.find((origin) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/.test(origin))
  const secrets = { GRAPH_TOKEN: [config.token], REVIEW_TOKENS: Object.values(config.reviewers ?? {}).flat(), LINK_SECRET: [config.linkSecret] }
  if (far) for (const [name, held] of Object.entries(secrets)) if (held.some((each) => String(each).startsWith('change-me'))) wrong.push(`${name} must be changed before taking visits from ${far}`)
  if (config.auditHours > 0 && !config.alertWebhook) wrong.push('ALERT_WEBHOOK is required with AUDIT_HEAD_HOURS')
  if (wrong.length > 0) throw new Error(`Cannot start:\n  ${wrong.join('\n  ')}`)
  return config
}

export interface Running {
  /** The port it is listening on. */
  port: number
  graph: Graph
  /** Stops taking requests, stops the outbox, and closes the database connections. */
  close(): Promise<void>
}

/** Starts the server. `log` receives one line per thing worth telling an operator. */
export async function serve(env: Env = process.env, log: (line: string) => void = console.log): Promise<Running> {
  const config = configFrom(env)
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: config.databaseUrl })
  const store = createPostgresStore(pool as unknown as Pool, config.schema)
  const applied = await store.migrate()
  log(applied.length > 0 ? `database upgraded: ${applied.join(', ')}` : 'database is up to date')

  // Tell another system whenever a cluster changes, if asked to.
  const webhook = config.changeWebhook
  const notify = async (changes: Change[]) => {
    const body = JSON.stringify({ changes })
    const signed = config.changeSecret && { 'x-account-graph-signature': bodySignature(config.changeSecret, Date.now(), body) }
    const response = await fetch(webhook!, { method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body, signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`The change webhook returned ${response.status}`)
  }
  const policy = config.policy ?? defaultPolicy
  // A kind that is stored but not named would stop every link that reaches it, so say so before anything is served.
  const unnamed = (await store.read((tx) => tx.kinds())).filter((kind) => !Object.hasOwn(policy.kinds, kind))
  if (unnamed.length > 0) {
    await pool.end()
    throw new Error(`Cannot start:\n  identifiers of kind ${unnamed.map((kind) => `"${kind}"`).join(', ')} are stored, and the policy names no such kind`)
  }
  const graph = createGraph(store, policy, webhook ? { onChange: notify } : {})

  const targets: Target[] = []
  if (config.google) {
    const token = createGoogleTokens(JSON.parse(readFileSync(config.google.keyFile, 'utf8')))
    targets.push(googleAds({ customerId: config.google.customerId, ...(config.google.loginCustomerId && { loginCustomerId: config.google.loginCustomerId }), send: async (request) => ingest(request, await token()) }))
  }
  if (config.meta) targets.push(meta({ pixelId: config.meta.pixelId, accessToken: config.meta.accessToken, url: config.meta.url, ...(config.meta.testEventCode && { testEventCode: config.meta.testEventCode }) }))
  if (config.tiktok) targets.push(tiktok(config.tiktok))
  if (config.microsoft) {
    const { clientId, refreshToken, clientSecret, ...account } = config.microsoft
    targets.push(microsoftAds({ ...account, accessToken: createMicrosoftTokens({ clientId, refreshToken, ...(clientSecret && { clientSecret }) }) }))
  }
  const hours = config.openHours && createHours(config.openHours, config.timeZone)
  // Tell someone when a conversion fails for good, when the outbox cannot run, or when costs cannot be read.
  const ops = createOps(graph, store.ops, {
    ...(config.alertWebhook && { url: config.alertWebhook }),
    quiet: config.quiet,
    returnHours: config.returnHours,
    ...(hours && { hours }),
    outbox: store.outbox,
    lateHours: config.lateHours,
    timeZone: config.timeZone,
    onError: (error) => log(`alert: ${String((error as Error)?.message ?? error)}`),
  })
  // With no webhook, what would have been said is kept, and the Health view shows it.
  const { alert } = ops
  const outbox =
    targets.length > 0
      ? createOutbox(graph, store.outbox, {
          targets,
          delay: config.outboxDelay,
          retractOnForget: config.forgetAds,
          onFailed: (jobs) => {
            const lines = jobs.slice(0, 10).map((job) => `• ${job.transactionId} to ${job.target}: ${job.note ?? 'no reason given'}`)
            const more = jobs.length > 10 ? `\n…and ${jobs.length - 10} more` : ''
            void alert('conversions', `account-graph: ${jobs.length} ${jobs.length === 1 ? 'conversion' : 'conversions'} rejected.\n${lines.join('\n')}${more}\nList: GET /conversions?state=failed. Retry: POST /retry.`)
          },
        })
      : undefined
  /** Runs a job now and then, never over itself, and says how it went where `GET /ops` reads it. */
  const stops: (() => void)[] = []
  const every = (interval: number, name: string, work: () => Promise<unknown>, failed: (reason: string) => void) => {
    let running: Promise<void> | undefined
    const pass = () => void (running ??= ops.run(name, work).then(() => undefined, (error) => failed(String((error as Error)?.message ?? error))).finally(() => (running = undefined)))
    const timer = setInterval(pass, Math.min(2 ** 31 - 1, interval))
    timer.unref()
    stops.push(() => clearInterval(timer))
    return { pass, idle: () => running }
  }
  const sends = outbox && every(config.outboxInterval, 'outbox', () => outbox.run(), (reason) => {
    log(`outbox: ${reason}`)
    void alert('outbox', `account-graph: the outbox failed and conversions are not being sent. ${reason}`)
  })

  // What campaigns cost, read again every few hours. The last days are read each time, because platforms revise them.
  const sources: [string, CostSource][] = []
  if (config.googleCosts) {
    const { keyFile, loginCustomerId, ...account } = config.googleCosts
    const accessToken = createGoogleTokens(JSON.parse(readFileSync(keyFile, 'utf8')), { scope: 'https://www.googleapis.com/auth/adwords' })
    sources.push(['google', googleCosts({ ...account, accessToken, ...(loginCustomerId && { loginCustomerId }) })])
  }
  if (config.metaCosts) sources.push(['meta', metaCosts(config.metaCosts)])
  const readCosts = sources.map(([name, source]) =>
    every(Math.max(60_000, config.costInterval), `costs:${name}`, async () => {
      const to = new Date().toISOString().slice(0, 10)
      const from = new Date(Date.now() - config.costDays * 86_400_000).toISOString().slice(0, 10)
      const costs = await source(from, to)
      await graph.spend(costs)
      log(`costs: ${costs.length} rows from ${name}, ${from} to ${to}`)
    }, (reason) => {
      log(`costs: ${name} failed: ${reason}`)
      void alert(`costs:${name}`, `account-graph: reading campaign costs from ${name} failed. ${reason}`)
    }),
  )

  // The newest hash of the record of decisions, sent where the database's owners cannot write.
  const sendHead =
    config.auditHours > 0
      ? every(Math.max(3_600_000, config.auditHours * 3_600_000), 'audit head', async () => {
          const { sound, brokenAt, head } = await graph.audit()
          const state = sound ? 'Verified.' : `Altered at entry ${brokenAt}.`
          if (head) await alert('audit', `account-graph: audit log entry ${head.seq}, hash ${head.hash}. ${state} Store this outside the database.`)
        }, (reason) => log(`audit: ${reason}`))
      : undefined
  // Feeds that have gone quiet, callers nobody has rung back, and alerts that were not delivered.
  const checks = every(5 * 60_000, 'checks', () => ops.check(), (reason) => log(`checks: ${reason}`))

  // Visits that arrive together are written together.
  const batcher = createBatcher(graph)
  const queued: Graph = { ...graph, observe: (input) => (Array.isArray(input) ? graph.observe(input) : batcher.observe(input as Parameters<typeof batcher.observe>[0])) }

  const maxmind = config.maxmind && createMaxMindLookup(config.maxmind)
  const ranges = config.serverRanges
  const ipInfo: IpLookup | undefined = ranges && maxmind ? async (address) => {
    const [known, info] = [await ranges(address), await maxmind(address)]
    return known && info ? { ...info, hosting: true } : (known ?? info)
  } : (ranges ?? maxmind)
  const options: HandlerOptions = {
    token: config.token,
    origins: config.origins,
    limit: config.limit,
    trustProxy: config.trustProxy,
    timeZone: config.timeZone,
    staffNetworks: config.staffNetworks,
    ...(config.linkSecret && { linkSecret: config.linkSecret }),
    ...(config.identifierSecret && { identifierSecret: config.identifierSecret }),
    ...(config.stages && { stages: config.stages }),
    returnHours: config.returnHours,
    ...(hours && { hours }),
    // A tap on a phone link is what ties a call to a visitor, so taking calls means taking that event.
    events: [...new Set([...config.events, ...(config.callNumbers || config.twilio || config.poolNumbers.length > 0 ? ['phone_click'] : []), ...(config.textCodes || config.twilioTexts ? ['text_click'] : [])])],
    texts: { codes: config.textCodes, ...(config.twilioTexts && { twilio: config.twilioTexts }) },
    calls: { exclude: config.callExclude, minimumSeconds: config.callMinimum, clickWindow: config.callTapSeconds * 1000, resultWait: config.callResultWait * 60_000, ...(config.callResults === 'expected' && { results: 'expected' as const }), ...(config.callNumbers && { numbers: config.callNumbers }), ...(config.twilio && { twilio: config.twilio }) },
    ...(config.poolNumbers.length > 0 && { pool: { numbers: config.poolNumbers, minutes: config.poolMinutes, grace: config.poolGrace } }),
    ...(config.reviewers && { reviewers: config.reviewers }),
    ...(config.cookie && { cookie: config.cookie }),
    ...(config.fingerprint && { fingerprint: createFingerprintVerifier(config.fingerprint) }),
    ...(ipInfo && { ipInfo }),
    ...(config.smarty && { address: createAddressVerifier(config.smarty) }),
    ...(config.lineType && { lineType: createLineTypeLookup(config.lineType) }),
    ...(outbox && { outbox }),
    ops,
  }
  const server = createServer(createHandler(queued, options))
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve))
  const { port } = server.address() as AddressInfo

  const on = (name: string, enabled: unknown) => `${name} ${enabled ? 'on' : 'off'}`
  log(`listening on ${config.host}:${port}`)
  log(`collect accepts ${config.origins.length > 0 ? config.origins.join(', ') : 'no origins yet (set ORIGINS)'}`)
  log([Object.keys(config.reviewers ?? {}).length > 0 ? `reviewers ${Object.keys(config.reviewers!).join(', ')}` : 'reviewers none', on('server cookie', config.cookie), on('fingerprint', config.fingerprint), on('maxmind', config.maxmind), on('server ranges', config.serverRanges), on('signed links', config.linkSecret), on('staff networks', config.staffNetworks.length > 0), on('opening hours', hours), on('alerts', config.alertWebhook), on('address checks', config.smarty), on('phone line checks', config.lineType)].join(', '))
  log(`outbox sends to ${targets.length > 0 ? targets.map((target) => target.name).join(', ') : 'none (no ad platform configured)'}`)
  if (config.stages) log(`steps: ${Object.entries(config.stages).map(([name, stage]) => `${name}${stage.value === undefined ? '' : ` ${stage.value}`}`).join(', ')}`)
    log(`page events: ${options.events!.length > 0 ? options.events!.join(', ') : 'none (set EVENTS)'}; calls from twilio ${config.twilio ? 'on' : 'off'}; texts from twilio ${config.twilioTexts ? 'on' : 'off'}; text codes ${config.textCodes ? 'on' : 'off'}; call results ${config.callResults === 'expected' ? `expected within ${config.callResultWait} minutes` : 'not expected'}; number pool ${config.poolNumbers.length > 0 ? `of ${config.poolNumbers.length}` : 'off'}`)
  log(`cost sources: ${sources.length > 0 ? sources.map(([name]) => name).join(', ') : 'none (POST /costs)'}`)
  const { hash, due } = await graph.policy()
  log(`policy ${hash.slice(0, 12)} ${config.policy ? '(configured)' : '(default)'}${due ? '; rebuild required (POST /rebuild)' : ''}`)
  for (const { pass } of [...readCosts, ...(sendHead ? [sendHead] : []), checks]) pass()

  return {
    port,
    graph,
    async close() {
      for (const stop of stops) stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await batcher.drain()
      for (const job of [sends, ...readCosts, sendHead, checks]) await job?.idle()
      await pool.end()
    },
  }
}

// Run when this file is the program, not when it is imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const running = await serve()
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void running.close().then(() => process.exit(0)))
  } catch (error) {
    console.error(String((error as Error)?.message ?? error))
    process.exit(1)
  }
}
