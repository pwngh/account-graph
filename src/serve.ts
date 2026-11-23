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
import { createAlerter } from './alerts.ts'
import { createBatcher } from './batch.ts'
import { ingest } from './conversions.ts'
import { createGraph } from './graph.ts'
import { normalizePhone } from './identifiers.ts'
import type { Graph } from './graph.ts'
import { googleCosts, metaCosts } from './integrations/costs.ts'
import type { CostSource } from './integrations/costs.ts'
import { createFingerprintVerifier } from './integrations/fingerprint.ts'
import { createGoogleTokens } from './integrations/google-auth.ts'
import { createMaxMindLookup } from './integrations/maxmind.ts'
import { ladderProblems } from './ladder.ts'
import type { Ladder } from './ladder.ts'
import { createMicrosoftTokens } from './integrations/microsoft-auth.ts'
import { createOutbox } from './outbox.ts'
import type { Target } from './outbox.ts'
import { createPostgresStore } from './postgres.ts'
import type { Pool } from './postgres.ts'
import { createHandler } from './server.ts'
import type { HandlerOptions } from './server.ts'
import { googleAds, meta, microsoftAds, tiktok } from './targets.ts'
import type { Change } from './types.ts'

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
  const parsed = (name: string): Record<string, any> | undefined => {
    if (!env[name]) return undefined
    try {
      const value = JSON.parse(env[name]!)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
    wrong.push(`${name} must be a JSON object`)
    return undefined
  }
  // A group of variables that only make sense together: all or none.
  const group = (names: string[]) => {
    const set = names.filter((name) => env[name])
    if (set.length > 0 && set.length < names.length) wrong.push(`${names.filter((name) => !env[name]).join(', ')} must be set along with ${set.join(', ')}`)
    return set.length === names.length
  }

  const config = {
    databaseUrl: need('DATABASE_URL'),
    schema: env.GRAPH_SCHEMA || 'account_graph',
    token: need('GRAPH_TOKEN'),
    reviewToken: env.REVIEW_TOKEN,
    origins: (env.ORIGINS ?? '').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
    port: number('PORT', 8080),
    host: env.HOST || '0.0.0.0',
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : env.TRUST_PROXY === 'false' ? 0 : number('TRUST_PROXY', 0),
    cookie: env.COOKIE === 'true' ? true : env.COOKIE && env.COOKIE !== 'false' ? { domain: env.COOKIE } : false,
    limit: env.RATE_LIMIT === 'off' ? (false as const) : { perMinute: number('RATE_PER_MINUTE', 120), burst: number('RATE_BURST', 60) },
    outboxInterval: number('OUTBOX_INTERVAL_MS', 30_000),
    outboxDelay: number('OUTBOX_DELAY_MS', 0),
    changeWebhook: env.CHANGE_WEBHOOK,
    linkSecret: env.LINK_SECRET || undefined,
    alertWebhook: env.ALERT_WEBHOOK || undefined,
    stages: parsed('STAGES') as Ladder | undefined,
    timeZone: env.REPORT_TIME_ZONE || 'UTC',
    events: (env.EVENTS ?? '').split(',').map((name) => name.trim()).filter(Boolean),
    callNumbers: parsed('CALL_NUMBERS'),
    callMinimum: number('CALL_MIN_SECONDS', 30),
    twilio: group(['TWILIO_AUTH_TOKEN', 'TWILIO_WEBHOOK_URL']) ? { authToken: env.TWILIO_AUTH_TOKEN!, url: env.TWILIO_WEBHOOK_URL! } : undefined,
    costInterval: number('COST_INTERVAL_MS', 6 * 3_600_000),
    costDays: number('COST_DAYS', 7),
    googleCosts: env.GOOGLE_ADS_DEVELOPER_TOKEN
      ? group(['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE'])
        ? { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId: env.GOOGLE_ADS_CUSTOMER_ID!, loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_FILE! }
        : undefined
      : undefined,
    metaCosts: group(['META_AD_ACCOUNT_ID', 'META_ADS_TOKEN']) ? { adAccountId: env.META_AD_ACCOUNT_ID!, accessToken: env.META_ADS_TOKEN! } : undefined,
    fingerprint: env.FINGERPRINT_SECRET ? { secretKey: env.FINGERPRINT_SECRET, region: (env.FINGERPRINT_REGION || 'us') as 'us' | 'eu' | 'ap' } : undefined,
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
  for (const [number, channel] of Object.entries(config.callNumbers ?? {})) {
    try {
      normalizePhone(number)
    } catch {
      wrong.push(`CALL_NUMBERS: "${number}" is not a phone number`)
    }
    if (typeof channel?.source !== 'string' || !channel.source) wrong.push(`CALL_NUMBERS: "${number}" needs a source, such as {"source":"google"}`)
  }
  if (config.stages) {
    const targets = [config.google && 'google', config.meta && 'meta', config.tiktok && 'tiktok', config.microsoft && 'microsoft'].filter((name): name is string => Boolean(name))
    for (const problem of ladderProblems(config.stages, targets)) wrong.push(`STAGES: ${problem}`)
  }
    if (config.linkSecret !== undefined && config.linkSecret.length < 16) wrong.push('LINK_SECRET must be at least 16 characters')
  if (config.reviewToken && config.reviewToken === config.token) wrong.push('REVIEW_TOKEN must differ from GRAPH_TOKEN')
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
    const response = await fetch(webhook!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes }) })
    if (!response.ok) throw new Error(`The change webhook answered ${response.status}`)
  }
  const graph = createGraph(store, undefined, webhook ? { onChange: notify } : {})

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
  // Tell someone when a conversion fails for good, when the outbox cannot run, or when costs cannot be read.
  const alert = config.alertWebhook ? createAlerter({ url: config.alertWebhook, onError: (error) => log(`alert: ${String((error as Error)?.message ?? error)}`) }) : undefined
  const outbox =
    targets.length > 0
      ? createOutbox(graph, store.outbox, {
          targets,
          delay: config.outboxDelay,
          onFailed: (jobs) => {
            const lines = jobs.slice(0, 10).map((job) => `• ${job.transactionId} to ${job.target}: ${job.note ?? 'no reason given'}`)
            const more = jobs.length > 10 ? `\n…and ${jobs.length - 10} more` : ''
            void alert?.('conversions', `account-graph: ${jobs.length} ${jobs.length === 1 ? 'conversion' : 'conversions'} failed for good.\n${lines.join('\n')}${more}\nList them with GET /conversions?state=failed, and send again with POST /retry.`)
          },
        })
      : undefined
  const stopOutbox = outbox?.start(config.outboxInterval, (error) => {
    const reason = String((error as Error)?.message ?? error)
    log(`outbox: ${reason}`)
    void alert?.('outbox', `account-graph: the outbox could not run, so no conversion is being sent. ${reason}`)
  })

  // What campaigns cost, read again every few hours. The last days are read each time, because platforms revise them.
  const sources: [string, CostSource][] = []
  if (config.googleCosts) {
    const { keyFile, loginCustomerId, ...account } = config.googleCosts
    const accessToken = createGoogleTokens(JSON.parse(readFileSync(keyFile, 'utf8')), { scope: 'https://www.googleapis.com/auth/adwords' })
    sources.push(['google', googleCosts({ ...account, accessToken, ...(loginCustomerId && { loginCustomerId }) })])
  }
  if (config.metaCosts) sources.push(['meta', metaCosts(config.metaCosts)])
  const importCosts = async () => {
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - config.costDays * 86_400_000).toISOString().slice(0, 10)
    for (const [name, source] of sources) {
      try {
        const costs = await source(from, to)
        await graph.spend(costs)
        log(`costs: ${costs.length} rows from ${name}, ${from} to ${to}`)
      } catch (error) {
        log(`costs: ${name} failed: ${String((error as Error)?.message ?? error)}`)
        void alert?.(`costs:${name}`, `account-graph: campaign costs could not be read from ${name}, so the report's costs are going stale. ${String((error as Error)?.message ?? error)}`)
      }
    }
  }
  // One read at a time: a slow platform must not stack a second read on the first.
  let reading: Promise<void> | undefined
  const readCosts = () => void (reading ??= importCosts().finally(() => (reading = undefined)))
  const costTimer = sources.length > 0 ? setInterval(readCosts, Math.max(60_000, config.costInterval)) : undefined
  costTimer?.unref()

  // Visits that arrive together are written together.
  const batcher = createBatcher(graph)
  const queued: Graph = { ...graph, observe: (input) => (Array.isArray(input) ? graph.observe(input) : batcher.observe(input as Parameters<typeof batcher.observe>[0])) }

  const options: HandlerOptions = {
    token: config.token,
    origins: config.origins,
    limit: config.limit,
    trustProxy: config.trustProxy,
    timeZone: config.timeZone,
    ...(config.linkSecret && { linkSecret: config.linkSecret }),
    ...(config.stages && { stages: config.stages }),
    // A tap on a phone link is what ties a call to a visitor, so taking calls means taking that event.
    events: [...new Set([...config.events, ...(config.callNumbers || config.twilio ? ['phone_click'] : [])])],
    calls: { minimumSeconds: config.callMinimum, ...(config.callNumbers && { numbers: config.callNumbers }), ...(config.twilio && { twilio: config.twilio }) },
    ...(config.reviewToken && { reviewToken: config.reviewToken }),
    ...(config.cookie && { cookie: config.cookie }),
    ...(config.fingerprint && { fingerprint: createFingerprintVerifier(config.fingerprint) }),
    ...(config.maxmind && { ipInfo: createMaxMindLookup(config.maxmind) }),
    ...(outbox && { outbox }),
  }
  const server = createServer(createHandler(queued, options))
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve))
  const { port } = server.address() as AddressInfo

  const on = (name: string, enabled: unknown) => `${name} ${enabled ? 'on' : 'off'}`
  log(`listening on ${config.host}:${port}`)
  log(`collect accepts ${config.origins.length > 0 ? config.origins.join(', ') : 'no origins yet (set ORIGINS)'}`)
  log([on('reviewer token', config.reviewToken), on('server cookie', config.cookie), on('fingerprint', config.fingerprint), on('maxmind', config.maxmind), on('signed links', config.linkSecret), on('alerts', config.alertWebhook)].join(', '))
  log(`outbox sends to ${targets.length > 0 ? targets.map((target) => target.name).join(', ') : 'nobody (no ad platform configured)'}`)
  if (config.stages) log(`steps: ${Object.entries(config.stages).map(([name, stage]) => `${name}${stage.value === undefined ? '' : ` ${stage.value}`}`).join(', ')}`)
    log(`page events taken: ${options.events!.length > 0 ? options.events!.join(', ') : 'none (set EVENTS)'}; calls from twilio ${config.twilio ? 'on' : 'off'}`)
  log(`costs are read from ${sources.length > 0 ? sources.map(([name]) => name).join(', ') : 'nobody (post them to /costs)'}`)
  if (sources.length > 0) readCosts()

  return {
    port,
    graph,
    async close() {
      stopOutbox?.()
      clearInterval(costTimer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await batcher.drain()
      await reading
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
