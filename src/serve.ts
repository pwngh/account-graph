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
import { createBatcher } from './batch.ts'
import { ingest } from './conversions.ts'
import { createGraph } from './graph.ts'
import type { Graph } from './graph.ts'
import { createFingerprintVerifier } from './integrations/fingerprint.ts'
import { createGoogleTokens } from './integrations/google-auth.ts'
import { createMaxMindLookup } from './integrations/maxmind.ts'
import { createMicrosoftTokens } from './integrations/microsoft-auth.ts'
import { createOutbox } from './outbox.ts'
import type { Target } from './outbox.ts'
import { createPostgresStore } from './postgres.ts'
import type { Pool } from './postgres.ts'
import { createHandler } from './server.ts'
import type { HandlerOptions } from './server.ts'
import { googleAds, meta, microsoftAds } from './targets.ts'
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
    trustProxy: env.TRUST_PROXY === 'true',
    cookie: env.COOKIE === 'true' ? true : env.COOKIE && env.COOKIE !== 'false' ? { domain: env.COOKIE } : false,
    limit: env.RATE_LIMIT === 'off' ? (false as const) : { perMinute: number('RATE_PER_MINUTE', 120), burst: number('RATE_BURST', 60) },
    outboxInterval: number('OUTBOX_INTERVAL_MS', 30_000),
    outboxDelay: number('OUTBOX_DELAY_MS', 0),
    changeWebhook: env.CHANGE_WEBHOOK,
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
  if (config.microsoft) {
    const { clientId, refreshToken, clientSecret, ...account } = config.microsoft
    targets.push(microsoftAds({ ...account, accessToken: createMicrosoftTokens({ clientId, refreshToken, ...(clientSecret && { clientSecret }) }) }))
  }
  const outbox = targets.length > 0 ? createOutbox(graph, store.outbox, { targets, delay: config.outboxDelay }) : undefined
  const stopOutbox = outbox?.start(config.outboxInterval, (error) => log(`outbox: ${String((error as Error)?.message ?? error)}`))

  // Visits that arrive together are written together.
  const batcher = createBatcher(graph)
  const queued: Graph = { ...graph, observe: (input) => (Array.isArray(input) ? graph.observe(input) : batcher.observe(input as Parameters<typeof batcher.observe>[0])) }

  const options: HandlerOptions = {
    token: config.token,
    origins: config.origins,
    limit: config.limit,
    trustProxy: config.trustProxy,
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
  log([on('reviewer token', config.reviewToken), on('server cookie', config.cookie), on('fingerprint', config.fingerprint), on('maxmind', config.maxmind)].join(', '))
  log(`outbox sends to ${targets.length > 0 ? targets.map((target) => target.name).join(', ') : 'nobody (no ad platform configured)'}`)

  return {
    port,
    graph,
    async close() {
      stopOutbox?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
      await batcher.drain()
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
