import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHandler } from './harness.ts'
import { accountGraph } from '../src/index.ts'
import { runWorkers } from '../src/testing/index.ts'
import { checked } from '../src/contract/validate.ts'
import { compared } from '../src/core/receipts.ts'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adsReceiver } from '../tools/ads-receiver.ts'
import { configFrom, readEnvironment } from '../src/bin.ts'
import { internalsOf } from '../src/client/internals.ts'
import { targetsOf } from '../src/client/providers.ts'
import { createGraph } from '../src/core/graph.ts'
import { createMemoryStore } from '../src/core/memory.ts'
import { createOutbox } from '../src/core/outbox.ts'
import type { Item } from '../src/core/outbox.ts'
import { googleCosts, metaCosts } from '../src/providers/costs.ts'
import { ingest, ingestRequest } from '../src/providers/conversions.ts'
import { googleAds, meta } from '../src/providers/targets.ts'

const base = { DATABASE_URL: 'postgres://127.0.0.1/unused', GRAPH_TOKEN: 'private', RECEIPT_SECRETS: 's'.repeat(32), IDENTIFIER_SECRET: 'i'.repeat(32) }
const date = '2026-09-10'
const at = Date.parse(date)
const consent = { adUserData: true, adPersonalization: false }
const ua = 'ExampleBrowser/1.0'
const item: Item = { job: { transactionId: 'unit', subject: 'visitor:unit', at, action: 'Lead', target: 'meta', keys: {}, state: 'pending', attempts: 0, due: at }, touch: undefined, consent }

test('a configured Microsoft sandbox handles the conversion and its retraction', async () => {
  const env = { ...base, MICROSOFT_CLIENT_ID: 'id', MICROSOFT_REFRESH_TOKEN: 'refresh', MICROSOFT_DEVELOPER_TOKEN: 'developer', MICROSOFT_CUSTOMER_ID: '123', MICROSOFT_ACCOUNT_ID: '345' }
  assert.throws(() => configFrom({ ...env, MICROSOFT_SANDBOX: 'treu' }), /MICROSOFT_SANDBOX/)
  for (const sandbox of [false, true]) {
    const urls: string[] = []
    const options = configFrom({ ...env, ...(sandbox && { MICROSOFT_SANDBOX: 'true' }) }).graph
    const [target] = targetsOf({ ...options, fetch: async input => {
      const url = new URL(String(input))
      if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'fake', expires_in: 3600 })
      urls.push(url.hostname)
      return Response.json({ PartialErrors: [] })
    } })
    await target!.deliver('Goal', [item])
    await target!.forget!([item.job])
    const host = sandbox ? 'campaign.api.sandbox.bingads.microsoft.com' : 'campaign.api.bingads.microsoft.com'
    assert.deepEqual(urls, [host, host])
  }
})

test('a test receiver on this machine takes every ad platform request, and no other address is taken for one', async () => {
  for (const address of ['https://ads.example.com', 'http://10.0.0.2:9000', 'http://127.0.0.1:9000/ads', 'nonsense']) assert.throws(() => configFrom({ ...base, ADS_TEST_RECEIVER: address }), /ADS_TEST_RECEIVER/)
  const heard: { path: string; body: string }[] = []
  const receiver = adsReceiver((request) => heard.push(request)).listen(0, '127.0.0.1')
  await new Promise((resolve) => receiver.once('listening', resolve))
  const keyFile = join(mkdtempSync(join(tmpdir(), 'receiver-')), 'google.json')
  writeFileSync(keyFile, JSON.stringify({ client_email: 'test@example.iam.gserviceaccount.com', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }))
  try {
    const options = configFrom({
      ...base, ADS_TEST_RECEIVER: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`,
      GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_SERVICE_ACCOUNT_FILE: keyFile,
      META_PIXEL_ID: '555', META_ACCESS_TOKEN: 'made-up', META_SITE_URL: 'https://example.org',
      MICROSOFT_CLIENT_ID: 'id', MICROSOFT_REFRESH_TOKEN: 'made-up', MICROSOFT_DEVELOPER_TOKEN: 'made-up', MICROSOFT_CUSTOMER_ID: '1', MICROSOFT_ACCOUNT_ID: '2',
      TIKTOK_PIXEL_CODE: 'pixel', TIKTOK_ACCESS_TOKEN: 'made-up', TIKTOK_SITE_URL: 'https://example.org',
    }).graph
    // Any fetch given still sends it, to the receiver.
    const targets = targetsOf({ ...options, fetch: (input, init) => fetch(input, init) })
    for (const target of targets) {
      const job = { ...item.job, target: target.name, keys: target.keys({ email: 'pat@example.org' } as never) }
      assert.deepEqual(await target.deliver('Lead', [{ ...item, job }]), { requestId: 'test-receiver' }, target.name)
    }
    assert.deepEqual(heard.map((each) => each.path), ['/token', '/v1/events:ingest', '/v27.0/555/events', '/open_api/v1.3/event/track/', '/common/oauth2/v2.0/token', '/CampaignManagement/v13/OfflineConversions/Apply'])
  } finally {
    receiver.close()
  }
})

test('TikTok sends the configured code once at request level and omits it by default', async () => {
  const env = { ...base, TIKTOK_PIXEL_CODE: 'pixel', TIKTOK_ACCESS_TOKEN: 'token', TIKTOK_SITE_URL: 'https://example.org' }
  for (const code of ['qa-code', undefined]) {
    const options = configFrom({ ...env, ...(code && { TIKTOK_TEST_EVENT_CODE: code }) }).graph
    const [target] = targetsOf({ ...options, fetch: async (_, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.test_event_code, code)
      assert.equal(Object.hasOwn(body, 'test_event_code'), Boolean(code))
      assert.equal(Object.hasOwn(body.data[0], 'test_event_code'), false)
      return Response.json({ code: 0 })
    } })
    await target!.deliver('Lead', [item])
  }
})

test('Google reports have an explicit switch and accept OAuth without a developer token', async () => {
  const account = { ...base, GOOGLE_ADS_CUSTOMER_ID: '123', GOOGLE_SERVICE_ACCOUNT_FILE: 'unused' }
  assert.equal(readEnvironment(account).googleCosts, undefined)
  assert.equal(readEnvironment({ ...account, GOOGLE_ADS_COSTS: 'true' }).googleCosts?.customerId, '123')
  assert.equal(readEnvironment({ ...account, GOOGLE_ADS_DEVELOPER_TOKEN: 'legacy' }).googleCosts?.developerToken, 'legacy')
  assert.throws(() => readEnvironment({ ...base, GOOGLE_ADS_COSTS: 'true' }), /GOOGLE_ADS_CUSTOMER_ID/)
  for (const reply of [[], [{}], {}, null, [{ results: {} }]]) {
    const read = googleCosts({ customerId: '123', accessToken: async () => 'token', fetch: async (_, init) => {
      assert.equal(new Headers(init?.headers).has('developer-token'), false)
      return Response.json(reply)
    } })
    if (Array.isArray(reply) && (reply.length === 0 || !('results' in reply[0]!))) assert.deepEqual(await read(date, date), [])
    else await assert.rejects(read(date, date), /report|stream|batch/i)
  }
})

test('Google ingest sends with a deadline', async () => {
  const request = ingestRequest({ customerId: '123', conversionActionId: '456' }, [{ transactionId: 'unit', at, click: { gclid: 'synthetic' } }])
  await ingest(request, 'token', async (_, init) => {
    assert.ok(init?.signal instanceof AbortSignal)
    return Response.json({ requestId: 'unit' })
  })
})

test('Meta keeps its token out of the URL and fails a batch whose receipt counts fewer', async () => {
  for (const received of [0, undefined, 1]) {
    const target = meta({ pixelId: '123', accessToken: 'fake', url: 'https://example.org', fetch: async (input, init) => {
      assert.equal(new URL(String(input)).search, '')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fake')
      return Response.json({ events_received: received, fbtrace_id: 'trace' })
    } })
    // A receipt that counts nothing is taken as Meta gave it.
    if (received !== 0) assert.deepEqual(await target.deliver('Lead', [item]), { requestId: 'trace' })
    else await assert.rejects(target.deliver('Lead', [item]), (error) => /received/.test(String(error)) && !target.retryable(error))
  }
  const unread = meta({ pixelId: '123', accessToken: 'fake', url: 'https://example.org', fetch: async () => new Response('<html>') })
  await assert.rejects(unread.deliver('Lead', [item]), (error) => unread.retryable(error))
})

test('Meta rejects a malformed, foreign or incomplete Insights report', async () => {
  for (const scenario of ['empty', 'foreign', 'limit']) {
    let pages = 0
    const read = metaCosts({ adAccountId: '123', accessToken: 'fake', fetch: async (input, init) => {
      assert.equal(new URL(String(input)).origin, 'https://graph.facebook.com')
      assert.equal(init?.redirect, 'error')
      pages++
      return Response.json(scenario === 'empty' ? {} : { data: [], paging: { next: scenario === 'foreign' ? 'https://example.org/next' : 'https://graph.facebook.com/next' } })
    } })
    await assert.rejects(read(date, date), /report|page/i)
    assert.equal(pages, scenario === 'limit' ? 200 : 1)
  }
})

test('only opted-in Meta website jobs with advertising consent keep a real user agent as a separate field', async () => {
  for (const enabled of [true, false]) {
    const store = createMemoryStore()
    const graph = createGraph(store)
    const sent = new Map<string, any>()
    const opts = configFrom({ ...base, META_ACCESS_TOKEN: 'fake', META_PIXEL_ID: '123', META_SITE_URL: 'https://example.org', ...(enabled && { META_CLIENT_USER_AGENT: 'true' }), TIKTOK_PIXEL_CODE: '456', TIKTOK_ACCESS_TOKEN: 'fake', TIKTOK_SITE_URL: 'https://example.org' }).graph
    const targets = targetsOf({ ...opts, fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(input).includes('tiktok')) {
        assert.ok(!JSON.stringify(body).includes(ua))
        return Response.json({ code: 0 })
      }
      for (const event of body.data) sent.set(event.event_id, event)
      return Response.json({ events_received: body.data.length })
    } })
    const outbox = createOutbox(graph, store.outbox, { targets, now: () => at + 10, patience: 0 })
    for (const id of ['yes', 'denied', 'unknown', 'revoked', 'other', 'missing', 'unmatched']) {
      const subject = 'visitor:' + id
      const jobs = await outbox.record({ transactionId: id, subject, at, stage: 'lead', action: { meta: 'Lead', tiktok: 'Lead' }, ...(id !== 'unmatched' && { email: 'proof@example.org' }), ...(id !== 'missing' && { userAgent: ua }), ...(id === 'other' && { source: 'OTHER' }), ...(id !== 'unknown' && { consent: { ...consent, adUserData: id !== 'denied' } }) })
      assert.equal(jobs.find(job => job.target === 'meta')?.metaUserAgent, enabled && ['yes', 'revoked', 'unmatched'].includes(id) ? ua : undefined)
      assert.equal(jobs.find(job => job.target === 'tiktok')?.metaUserAgent, undefined)
      if (id === 'revoked') await graph.consent(subject, { ...consent, adUserData: false }, { at: at + 1 })
    }
    await outbox.run()
    assert.equal(sent.get('yes').user_data.client_user_agent, enabled ? ua : undefined)
    assert.equal(sent.get('unknown').user_data.client_user_agent, undefined)
    assert.equal(sent.get('missing').action_source, 'website')
    assert.equal(sent.get('missing').user_data.client_user_agent, undefined)
    assert.equal(sent.get('other').action_source, 'other')
    assert.equal((await outbox.get('revoked'))[0]?.metaUserAgent, undefined)
    for (const id of ['denied', 'revoked', 'unmatched']) assert.equal(sent.has(id), false)
  }
})

test('the collector uses the converting request header, and keeps it off the review screen and receipts', async t => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const bodies: any[] = []
  const target = meta({ pixelId: '123', url: 'https://example.org', accessToken: 'token', clientUserAgent: true, fetch: async (_, init) => {
    const { data } = JSON.parse(String(init?.body))
    bodies.push(...data)
    return Response.json({ events_received: data.length })
  } })
  const outbox = createOutbox(graph, store.outbox, { targets: [target], now: () => at + 10 })
  const server = createServer(createHandler(graph, { origins: ['https://example.org'], token: 'service', outbox, now: () => at + 10, events: ['lead'], stages: { lead: { action: { meta: 'Lead' } } } })).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  for (const device of ['yes', 'gpc-browser', 'gpc-header', 'banner-denied']) {
    const post = async (body: object, headers: Record<string, string>) => {
      const result = await fetch(baseUrl + '/collect', { method: 'POST', headers: { origin: 'https://example.org', ...headers }, body: JSON.stringify({ device, ...body }) })
      assert.equal(result.status, 204)
    }
    await post({ consent, touch: { fbclid: 'synthetic-' + device } }, { 'user-agent': 'EarlierVisit/1.0' })
    await post({ kind: 'event', event: 'lead', userAgent: 'ForgedBody/1.0', ...(device === 'gpc-browser' && { gpc: true }), ...(device === 'banner-denied' && { consent: { ...consent, adUserData: false } }) }, { 'user-agent': ua, ...(device === 'gpc-header' && { 'sec-gpc': '1' }) })
  }
  const shown = await fetch(baseUrl + '/review/api/conversions?state=pending', { headers: { authorization: 'Bearer service' } })
  assert.equal(shown.status, 200)
  const rows = await shown.json() as any[]
  assert.equal(rows.length, 4)
  assert.ok(!JSON.stringify(rows).includes(ua))
  assert.ok(!Object.hasOwn(compared({ type: 'conversion', key: 'entry', stage: 'lead', subject: 'visitor:yes', at, userAgent: ua }), 'userAgent'))
  await outbox.run()
  assert.deepEqual(bodies.filter(event => event.user_data.client_user_agent).map(event => [event.event_id, event.user_data.client_user_agent]), [['page:lead:yes:' + date, ua]])
  assert.equal((await outbox.get('page:lead:yes:' + date))[0]!.metaUserAgent, undefined)
})

test('a private Meta browser error cannot echo its user agent in a failure note', async () => {
  const target = meta({ pixelId: '123', url: 'https://example.org', accessToken: 'token', clientUserAgent: true, fetch: async () =>
    Response.json({ error: { code: 100, message: 'Bad ExampleBrowser%2F1.0' } }, { status: 400 }) })
  await assert.rejects(target.deliver('Lead', [{ ...item, job: { ...item.job, metaUserAgent: ua } }]), error =>
    error instanceof Error && /400/.test(error.message) && !error.message.includes('ExampleBrowser'))
})

test('an expressly system-generated outcome has the corresponding Meta source and a valid Google source', async () => {
  checked('record', { entries: [{ type: 'conversion', key: 'automated', subject: 'visitor:unit', at, stage: 'renewal', channel: 'SYSTEM_GENERATED' }] })
  const auto: Item = { ...item, job: { ...item.job, source: 'SYSTEM_GENERATED', keys: { email: 'a'.repeat(64) }, metaUserAgent: ua } }
  await meta({ pixelId: '123', url: 'https://example.org', accessToken: 'token', clientUserAgent: true, fetch: async (_, init) => {
    const [event] = JSON.parse(String(init?.body)).data
    assert.equal(event.action_source, 'system_generated')
    assert.equal(Object.hasOwn(event, 'event_source_url'), false)
    assert.equal(Object.hasOwn(event.user_data, 'client_user_agent'), false)
    return Response.json({ events_received: 1 })
  } }).deliver('Renewal', [auto])
  await googleAds({ customerId: '123', send: async request => {
    assert.equal(request.events[0]?.eventSource, 'OTHER')
    return {}
  } }).deliver('456', [auto])
})

test('a backend conversion never exposes the opted-in browser header through results, events, reports or a failed job', async t => {
  const graph = accountGraph({ memory: true, workers: false, now: () => at, ads: { meta: { pixelId: '123', accessToken: 'token', siteUrl: 'https://example.org', clientUserAgent: true } },
    fetch: async (_, init) => {
      const data = JSON.parse(String(init?.body)).data
      assert.equal(data[0].user_data.client_user_agent, ua)
      return Response.json({ error: { message: encodeURIComponent(ua), code: 100 } }, { status: 400 })
    } })
  t.after(() => graph.close())
  const entry = { type: 'conversion' as const, key: 'backend', at, stage: 'lead', subject: 'visitor:backend', consent, userAgent: ua, email: 'proof@example.org', actions: { meta: 'Lead' } }
  const stored = await graph.record({ entries: [entry, { ...entry, userAgent: 'ChangedBetweenAttempts' }] })
  assert.ok(stored.results.every(result => result.ok))
  await runWorkers(graph)
  const report = await graph.report({ kind: 'deliveries', state: 'failed' })
  assert.equal(report.value.deliveries.length, 1)
  const inside = await internalsOf(graph)!()
  assert.equal((await inside.engine.outbox!.get('backend'))[0]!.metaUserAgent, undefined)
  const journey = await graph.lookup({ kind: 'journey', subject: entry.subject })
  const events = await graph.events({ after: null, limit: 25 })
  for (const result of [stored, report, journey, events]) assert.ok(!JSON.stringify(result).includes('ExampleBrowser'))
})
