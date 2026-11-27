import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { IncomingMessage, RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'
import type { RecordResponse } from '../src/index.ts'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = join(root, 'test/fixtures/php/client.php')
const at = Date.UTC(2026, 10, 1, 12)
const token = 'synthetic-test'
const databaseUrl = process.env.DATABASE_URL
const noPhp = (spawnSync('php', ['-v']).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
const hasSqlite = !noPhp && spawnSync('php', ['-r', "exit(extension_loaded('pdo_sqlite') ? 0 : 1);"]).status === 0

interface Options {
  token?: string
  timeout?: number
  attempts?: number
  streams?: boolean
  database?: string
}

async function php(url: string, method: string, input: unknown, options: Options = {}) {
  const args = options.streams ? ['-d', 'disable_functions=curl_init'] : []
  args.push(fixture, JSON.stringify({ url, token, method, request: input, ...options }))
  const { stdout, stderr } = await run('php', args, { timeout: 90_000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } })
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

async function listen(t: TestContext, handle: RequestListener) {
  const server = createServer(handle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
  })
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

// The edge has committed before we decide whether the client gets its reply.
async function relayRecords(t: TestContext, base: string, lose: (key: string, reply: RecordResponse) => boolean) {
  const bodies: string[] = []
  const url = await listen(t, async (req, res) => {
    const body = await text(req)
    bodies.push(body)
    const upstream = request(base + '/v1/record', { method: 'POST', agent: false, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' } })
    const response = once(upstream, 'response') as Promise<[IncomingMessage]>
    upstream.end(body)
    const [received] = await response
    const answer = await text(received)
    if (!lose(JSON.parse(body).entries[0].key, JSON.parse(answer))) res.writeHead(received.statusCode!, { 'content-type': 'application/json' }).end(answer)
  })
  return { url, bodies }
}

for (const store of ['memory', 'postgres']) {
  test('PHP over HTTP on ' + store, { skip: noPhp ? 'php is not on the PATH' : store === 'postgres' && !databaseUrl ? 'DATABASE_URL is not set' : false }, async t => {
    const schema = 'ag_php_' + randomUUID().replaceAll('-', '')
    let cleanup = async () => {}
    if (store === 'postgres') {
      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: databaseUrl! })
      try {
        await pool.query('create schema ' + schema)
      } catch (error) {
        await pool.end()
        throw error
      }
      cleanup = async () => {
        try { await pool.query('drop schema ' + schema + ' cascade') }
        finally { await pool.end() }
      }
    }
    let clock = at + 60000
    let tick = 0
    const now = () => clock += tick
    const graph = accountGraph(store === 'postgres' ? { databaseUrl: databaseUrl!, schema, workers: false, receiptSecrets: ['r'.repeat(40)], identifierSecret: 'i'.repeat(32), now } : { memory: true, now })
    const edge = createEdge(graph, { token, limit: false })
    t.after(async () => {
      try {
        await edge.drain()
        await graph.close()
      } finally {
        await cleanup()
      }
    })
    let requests = 0
    const base = await listen(t, (req, res) => {
      requests++
      return edge(req, res)
    })

    await t.test('writes, reads, item refusals and faults with their detail', async () => {
      const key = await php(base, 'key', ['contacts', '17', '2'])
      assert.equal(key, await php(base, 'key', ['contacts', '17', '2']))
      assert.notEqual(key, await php(base, 'key', ['contacts', '17', '3']))
      const first = { type: 'profile', key, at, subject: 'contact:17', facts: { email: 'row17@example.org' } }
      const second = { ...first, key: 'p18', subject: 'contact:18', facts: { email: 'row18@example.org' } }
      assert.equal((await php(base, 'record', { entries: [first] })).results[0].value.duplicate, false)
      const before = requests
      const { results } = await php(base, 'record', { entries: [first, { ...first, createdAt: at - 1 }, second] })
      assert.equal(requests, before + 1)
      assert.equal(results[0].value.duplicate, true)
      assert.deepEqual(results[1], { type: 'profile', key, ok: false, reason: 'KEY_REUSED', fields: ['createdAt'] })
      assert.equal(results[2].value.duplicate, false)
      const who = { kind: 'person', subjects: [first.subject], at }
      assert.equal((await php(base, 'lookup', who, { streams: true })).people[0].known, true)
      assert.equal(await php(base, 'lookup', { kind: 'party', call: 'missing' }), null)
      const pairs = [{ a: first.subject, b: second.subject }]
      const merge = await php(base, 'decide', { by: 'operator', action: 'merge', at, key: 'merge17', pairs })
      assert.equal(merge.ok, true)
      assert.equal(merge.value.recorded, 1)
      assert.equal((await php(base, 'decide', { by: 'operator', action: 'unmerge', at: at + 1, key: 'undo17', pairs })).ok, true)
      const events = await graph.events({ after: null, limit: 1000 })
      assert.ok(events.ok && events.value.events.length >= 2)
      const pages = await php(base, 'event_pages', { after: null, limit: 1 })
      assert.deepEqual(pages.flatMap((page: any) => page.value.events), events.value.events)
      assert.equal(pages.at(-1).value.more, false)
      assert.deepEqual(await php(base, 'events', { after: 'another.1', limit: 1 }), { ok: false, reason: 'CURSOR_LOST' })
      assert.equal((await php(base, 'forget', { by: 'operator', at, key: 'erase17', subjects: who.subjects, platforms: 'report' })).ok, true)
      assert.equal((await php(base, 'lookup', who)).people[0].known, false)

      const start = requests
      const malformed = await php(base, 'record', { entries: [{ type: 'profile', key, subject: first.subject, facts: first.facts }] })
      assert.deepEqual(malformed, { fault: 'INPUT.MALFORMED', retryable: false, detail: { path: 'request.entries[0].at' } })
      const denied = await php(base, 'lookup', who, { token: 'incorrect' })
      assert.equal(denied.fault, 'AUTH.REJECTED')
      assert.equal(denied.retryable, false)
      assert.equal(requests, start + 2)
      assert.equal((await php('http://example.org', 'configure', {})).fault, 'CONFIG.INVALID')
    })

    await t.test('reports and journeys follow the last page', async () => {
      const calls = Array.from({ length: 51 }, (_, i) => ({ type: 'call', key: 'miss-' + i, at: at + i, direction: 'inbound', from: '+120255501' + String(i).padStart(2, '0'), to: '+12025550199', result: { answered: false } }))
      assert.ok((await php(base, 'record', { entries: calls })).results.every((r: any) => r.ok))
      const pages = await php(base, 'report_pages', { kind: 'callbacks', at: at + 60000, window: { from: '2026-11-01', to: '2026-11-01', timeZone: 'UTC' } })
      assert.deepEqual(pages.map((p: any) => p.value.rows.length), [50, 1])
      assert.equal(pages[1].value.next, null)
      assert.deepEqual(pages.flatMap((p: any) => p.value.rows.map((r: any) => r.call)), calls.map(c => c.key))
      const visits = Array.from({ length: 201 }, (_, i) => ({ type: 'arrival', key: 'visit-' + i, at: at + i, subject: 'contact:visits', source: 'direct' }))
      for (let i = 0; i < visits.length; i += 100) assert.ok((await php(base, 'record', { entries: visits.slice(i, i + 100) })).results.every((r: any) => r.ok))
      const journey = await php(base, 'journey_pages', { kind: 'journey', subject: 'contact:visits' })
      assert.deepEqual(journey.map((p: any) => p.entries.length), [200, 1])
      assert.equal(journey[1].next, null)
      assert.deepEqual(journey.flatMap((p: any) => p.entries.map((e: any) => e.at)).sort((a: number, b: number) => a - b), visits.map(v => v.at))
    })

    await t.test('a partial batch retries only the entries the graph did not attempt', async t => {
      const replies: RecordResponse[] = []
      const relay = await relayRecords(t, base, (_key, reply) => {
        replies.push(reply)
        tick = 0
        return false
      })
      const entries = Array.from({ length: 100 }, (_, i) => ({ type: 'consent', key: 'partial-' + i, at, subject: 'contact:consent' + i, consent: { adUserData: false, adPersonalization: false } }))
      entries[1] = { ...entries[0]!, at: at + 1 }
      // Advance the graph's clock on the first batch so its deadline falls between entries.
      tick = 200
      try {
        const { results } = await php(relay.url, 'record', { entries })
        assert.equal(relay.bodies.length, 2)
        const initial = replies[0]!.results
        assert.equal(initial[0]!.ok, true)
        assert.deepEqual(initial[1], { key: entries[1].key, type: 'consent', ok: false, reason: 'KEY_REUSED', fields: ['at'] })
        const pending = entries.filter((_, i) => {
          const item = initial[i]!
          return !item.ok && item.reason === 'NOT_ATTEMPTED'
        })
        assert.ok(pending.length && pending.length < entries.length)
        assert.deepEqual(JSON.parse(relay.bodies[1]!), { entries: pending })
        assert.deepEqual(results.map((r: any) => r.key), entries.map(e => e.key))
        assert.deepEqual(results[1], initial[1])
        assert.ok(results.every((r: any, i: number) => i === 1 || (r.ok && !r.value.duplicate)))
      } finally {
        tick = 0
        clock = at + 60000
      }
    })

    await t.test('a timeout after commit retries the same payment and takes it once', async t => {
      const conversion = { type: 'conversion', key: 'sale', at, stage: 'sale', subject: 'contact:pay', value: 0 }
      assert.equal((await php(base, 'record', { entries: [conversion] })).results[0].ok, true)
      let first = true
      const relay = await relayRecords(t, base, () => {
        if (!first) return false
        first = false
        return true
      })
      const payment = { type: 'payment', key: 'paid-1', at: at + 1, conversion: conversion.key, direction: 'received', amount: 37 }
      const { results } = await php(relay.url, 'record', { entries: [payment] }, { timeout: 1000, attempts: 2 })
      assert.equal(results[0].value.duplicate, true)
      assert.equal(results[0].value.value, 37)
      assert.equal(relay.bodies.length, 2)
      assert.equal(relay.bodies[1], relay.bodies[0])
      const view = await graph.lookup({ kind: 'record', type: 'conversion', key: conversion.key, at: at + 2 })
      assert.ok(view?.type === 'conversion')
      assert.deepEqual(view.values.map(row => row.value), [0, 37])
    })

    await t.test('a new worker replays a lost answer, clears sent bodies and parks a refusal', { skip: !hasSqlite && 'pdo_sqlite is not loaded' }, async t => {
      const dir = await mkdtemp(join(root, '.php-test-'))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const database = join(dir, 'outbox.sqlite')
      const first = { type: 'profile', key: 'first', subject: 'contact:out', at, facts: { device: 'outbox' } }
      const entries = [first, { ...first, key: 'second', at: at + 1 }, { ...first, key: 'independent', subject: 'contact:other' }, { ...first, key: 'second', at: at + 2 }, { ...first, key: 'last', at: at + 3 }]
      const rows = await php(base, 'seed', entries, { database })
      assert.deepEqual(rows.map((r: any) => r.state), entries.map(() => 'pending'))
      let down = true
      const relay = await relayRecords(t, base, key => down && key === first.key)
      const run = () => php(relay.url, 'work', {}, { database, attempts: 1, timeout: 1000, streams: true })
      const keys = () => relay.bodies.map(body => JSON.parse(body).entries[0].key)
      const interrupted = await run()
      assert.deepEqual(keys(), ['first'])
      assert.ok(interrupted.every((r: any) => r.state === 'pending' && r.request && r.created_at))
      down = false
      const finished = await run()
      assert.deepEqual(keys(), ['first', 'first', 'second', 'independent', 'second', 'last'])
      assert.equal(relay.bodies[0], relay.bodies[1])
      assert.deepEqual(finished.map((r: any) => r.state), ['sent', 'sent', 'sent', 'refused', 'sent'])
      assert.ok(finished.every((r: any, i: number) => r.item_kind === 'profile' && r.item_key === entries[i]!.key && (r.state === 'sent' ? r.request === null : !!r.request)))
      assert.equal(finished[0].answer.results[0].value.duplicate, true)
      assert.equal(finished[3].answer.results[0].reason, 'KEY_REUSED')
      await run()
      assert.equal(relay.bodies.length, 6)
    })

    await t.test('a malformed write holds only its named dependents, which resume when repaired', { skip: !hasSqlite && 'pdo_sqlite is not loaded' }, async t => {
      const dir = await mkdtemp(join(root, '.php-test-'))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const database = join(dir, 'outbox.sqlite')
      const subject = 'contact:depends'
      const sale = { type: 'conversion', subject, at, key: 'needs-stage' }
      const payment = { type: 'payment', key: 'paid-after-sale', at, conversion: sale.key, direction: 'received', amount: 7, _group: subject, _depends: 0 }
      const visit = { type: 'arrival', key: 'visit-after-payment', at, subject, _depends: 1 }
      const profile = { type: 'profile', subject, key: 'independent-save', at, facts: { phone: '+12025550104', email: 'not-an-email' } }
      const seed = await php(base, 'seed', [sale, payment, visit, profile], { database })
      assert.deepEqual(JSON.parse(seed[3].request).entries[0].facts, { phone: profile.facts.phone })
      const first = await php(base, 'work', {}, { database })
      assert.deepEqual(first.map((r: any) => r.state), ['failed', 'blocked', 'blocked', 'sent'])
      assert.equal(first[0].answer.fault.code, 'INPUT.MALFORMED')
      assert.equal(first[0].answer.fault.detail.path, 'request.entries[0].stage')
      const before = requests
      await php(base, 'work', {}, { database })
      assert.equal(requests, before)
      await php(base, 'repair', { ...sale, stage: 'paid' }, { database })
      await php(base, 'work', { limit: 1 }, { database })
      await php(base, 'purge', { key: sale.key }, { database })
      assert.equal(await php(base, 'missingDependency', { id: seed[0].id, entry: profile }, { database }), true)
      const last = await php(base, 'work', {}, { database })
      assert.ok(last.every((r: any) => r.state === 'sent' && r.request === null))
      assert.equal(last[0].item_key, payment.key)
      assert.equal(last[0].answer.results[0].value.value, 7)
      assert.equal(requests, before + 3)
    })

    await t.test('a repair committed between selection and claim sends the newly eligible older change first', { skip: !hasSqlite && 'pdo_sqlite is not loaded' }, async t => {
      const dir = await mkdtemp(join(root, '.php-test-'))
      t.after(() => rm(dir, { recursive: true, force: true }))
      const database = join(dir, 'outbox.sqlite')
      const parent = { type: 'conversion', at, key: 'race-parent', subject: 'contact:parent' }
      const older = { type: 'arrival', at, key: 'race-older', subject: 'contact:race', _depends: 0 }
      const newer = { type: 'arrival', at: at + 1, key: 'race-newer', subject: older.subject }
      await php(base, 'seed', [parent, older, newer], { database })
      const initial = await php(base, 'work', { limit: 2 }, { database })
      assert.deepEqual(initial.map((r: any) => r.state), ['failed', 'blocked', 'pending'])
      const relay = await relayRecords(t, base, () => false)
      const after = await php(relay.url, 'overlap', { ...parent, stage: 'repaired' }, { database })
      assert.deepEqual(after.map((r: any) => r.state), ['sent', 'sent', 'pending'])
      await php(relay.url, 'work', {}, { database })
      assert.deepEqual(relay.bodies.map(body => JSON.parse(body).entries[0].key), [parent.key, older.key, newer.key])
    })
  })
}

test('PHP screens profile facts before enqueueing and preserves speaker-only profiles', { skip: noPhp && 'php is not on the PATH' }, async () => {
  const entry = { type: 'profile', key: 'facts', at, subject: 'contact:screen' }
  const screen = (facts: object, speaker?: object) => php('http://127.0.0.1', 'screen', { ...entry, facts, ...(speaker && { speaker }) })
  assert.equal(await screen({}), null)
  assert.equal(await screen({ name: { first: 'Test', last: 'Record' } }), null)
  assert.equal(await screen({ email: 'not-an-email', phone: '123', device: 'invalid device', ip: 'unknown' }), null)
  assert.equal(await screen({ dob: '2001-02-29' }), null)
  const speaker = { email: 'speaker@example.org' }
  const row = await screen({ unlisted: 'drop this' }, { ...speaker, unlisted: 'drop this too' })
  assert.deepEqual(JSON.parse(row.request).entries[0], { ...entry, facts: {}, speaker })
  const phone = '+1 (202) 555-0100 ext 12'
  assert.deepEqual(JSON.parse((await screen({ email: 'a@b@', phone })).request).entries[0].facts, { phone })
})

test('one call fault stops its pass and the delayed retry leaves other groups free', { skip: noPhp ? 'php is not on the PATH' : !hasSqlite && 'pdo_sqlite is not loaded' }, async t => {
  const dir = await mkdtemp(join(root, '.php-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const database = join(dir, 'outbox.sqlite')
  let reply = '401'
  const keys: string[] = []
  const base = await listen(t, async (req, res) => {
    const { entries: [entry] } = JSON.parse(await text(req))
    keys.push(entry.key)
    if (reply === '401') return res.writeHead(401).end()
    if (reply === 'closed') return res.writeHead(503).end(JSON.stringify({ fault: { code: 'GRAPH.CLOSED', retryable: false, detail: {} } }))
    if (reply === 'bad hint') return res.writeHead(503).end(JSON.stringify({ fault: { code: 'GRAPH.UNAVAILABLE', retryable: true, detail: { retryAfter: [] } } }))
    if (reply === 'html') return res.writeHead(500).end('<html>error</html>')
    if (reply === '503') return res.writeHead(503, { 'retry-after': '86400' }).end()
    res.end(JSON.stringify({ results: [{ type: entry.type, key: entry.key, ok: true, value: { duplicate: false, stands: true, subject: entry.subject } }] }))
  })
  const entries = Array.from({ length: 30 }, (_, i) => ({ type: 'arrival', key: 'outage-' + i, at, subject: 'contact:' + i % 3 }))
  await php(base, 'seed', entries, { database })
  const work = (limit = 100) => php(base, 'work', { limit }, { database, attempts: 1 })
  const beforeFault = Date.now()
  for (const [mode, expected] of [['401', 'AUTH.REJECTED'], ['closed', 'GRAPH.CLOSED'], ['html', 'GRAPH.INTERNAL'], ['503', 'GRAPH.UNAVAILABLE']] as const) {
    reply = mode
    const rows = await work()
    assert.ok(rows.every((r: any) => r.state === 'pending' && r.request))
    assert.equal(rows[0].answer.fault.code, expected)
    if (mode === '503') {
      assert.ok(rows[0].answer.retry_at >= beforeFault / 1000 + 900 && rows[0].answer.retry_at <= Date.now() / 1000 + 900)
      assert.equal(rows[0].answer.fault.detail.retryAfter, '86400')
    }
  }
  assert.deepEqual(keys, Array(4).fill(entries[0]!.key))
  reply = 'ok'
  const partial = await work(1)
  assert.deepEqual(keys.slice(4), [entries[1]!.key])
  assert.equal(partial[0].state, 'pending')
  // Rows saved by an older worker can carry a deadline centuries in the future.
  const setDeadline = (retryAt: number) => php(base, 'savedAnswer', { id: partial[0].id, answer: { ...partial[0].answer, retry_at: retryAt } }, { database })
  await setDeadline(253402300799)
  const beforeRepair = Date.now()
  const readyGroups = await work()
  const capped = readyGroups[0].answer.retry_at
  assert.ok(capped >= beforeRepair / 1000 + 900 && capped <= Date.now() / 1000 + 900)
  assert.deepEqual(readyGroups.map((r: any) => r.state), entries.map((_, i) => i % 3 === 0 ? 'pending' : 'sent'))
  assert.deepEqual(keys.slice(4), entries.filter((_, i) => i % 3 !== 0).map(e => e.key))
  assert.equal((await work(1))[0].answer.retry_at, capped)
  const beforeRelease = keys.length
  await setDeadline(Date.now() / 1000 - 1)
  const sent = await work()
  assert.ok(sent.every((r: any) => r.state === 'sent' && r.request === null))
  assert.deepEqual(keys.slice(beforeRelease), entries.filter((_, i) => i % 3 === 0).map(e => e.key))

  const linked = { database: join(dir, 'dependent.sqlite'), attempts: 1 }
  await php(base, 'seed', [entries[0], { ...entries[1], _depends: 0 }, entries[2]], linked)
  reply = 'bad hint'
  const malformedHint = await php(base, 'work', {}, linked)
  assert.deepEqual(malformedHint[0].answer, { fault: { code: 'GRAPH.UNAVAILABLE', retryable: true, detail: { retryAfter: [] } } })
  reply = '503'
  await php(base, 'work', {}, linked)
  reply = 'ok'
  const beforeDependency = keys.length
  const one = await php(base, 'work', { limit: 1 }, linked)
  assert.deepEqual(keys.slice(beforeDependency), [entries[2]!.key])
  assert.deepEqual(one.map((r: any) => r.state), ['pending', 'pending', 'sent'])
})

test('PHP refuses redirects and distinguishes a proxy outage from a graph configuration fault', { skip: noPhp && 'php is not on the PATH' }, async t => {
  let followed = 0
  const target = await listen(t, (_req, res) => {
    followed++
    res.end('null')
  })
  let reply = 'redirect'
  let attempts = 0
  const url = await listen(t, (_req, res) => {
    attempts++
    if (reply === 'redirect') return res.writeHead(307, { Location: target + '/v1/lookup' }).end()
    if (reply === 'mismatch') return res.writeHead(503).end(JSON.stringify({ fault: { code: 'CONFIG.MISMATCH', retryable: false, detail: { setting: 'policy' } } }))
    res.writeHead(503, { 'retry-after': '0' }).end('unavailable')
  })
  for (const streams of [false, true]) {
    const probe = () => php(url, 'lookup', { kind: 'party', call: 'missing' }, { attempts: 2, streams })
    attempts = 0
    reply = 'redirect'
    assert.equal((await probe()).fault, 'CONFIG.INVALID')
    assert.equal(attempts, 1)
    assert.equal(followed, 0)
    reply = 'mismatch'
    assert.deepEqual(await probe(), { fault: 'CONFIG.MISMATCH', retryable: false, detail: { setting: 'policy' } })
    assert.equal(attempts, 2)
    reply = 'proxy'
    assert.deepEqual(await probe(), { fault: 'GRAPH.UNAVAILABLE', retryable: true, detail: { status: 503, retryAfter: '0' } })
    assert.equal(attempts, 4)
  }
})

test('PHP streams return a complete Content-Length response while the socket remains open', { skip: noPhp && 'php is not on the PATH' }, async t => {
  const url = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 4 })
    // The length delimits this reply. Delay the socket close until the client leaves.
    res.write('null')
  })
  assert.equal(await php(url, 'lookup', { kind: 'party', call: 'missing' }, { streams: true, timeout: 500, attempts: 1 }), null)
})
