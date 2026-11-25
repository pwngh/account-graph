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
    const graph = accountGraph(store === 'postgres' ? { databaseUrl: databaseUrl!, schema, workers: false, receiptSecrets: ['r'.repeat(40)], now } : { memory: true, now })
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
      const pages = await php(base, 'eventPages', { after: null, limit: 1 })
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
      const pages = await php(base, 'reportPages', { kind: 'callbacks', at: at + 60000, window: { from: '2026-11-01', to: '2026-11-01', timeZone: 'UTC' } })
      assert.deepEqual(pages.map((p: any) => p.value.rows.length), [50, 1])
      assert.equal(pages[1].value.next, null)
      assert.deepEqual(pages.flatMap((p: any) => p.value.rows.map((r: any) => r.call)), calls.map(c => c.key))
      const visits = Array.from({ length: 201 }, (_, i) => ({ type: 'arrival', key: 'visit-' + i, at: at + i, subject: 'contact:visits', source: 'direct' }))
      for (let i = 0; i < visits.length; i += 100) assert.ok((await php(base, 'record', { entries: visits.slice(i, i + 100) })).results.every((r: any) => r.ok))
      const journey = await php(base, 'journeyPages', { kind: 'journey', subject: 'contact:visits' })
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

    await t.test('a new worker replays the oldest pending row and saves the refusal that blocks a later row', { skip: !hasSqlite && 'pdo_sqlite is not loaded' }, async t => {
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
      assert.deepEqual(keys(), ['first', 'independent'])
      assert.deepEqual(interrupted.map((r: any) => r.state), ['pending', 'pending', 'sent', 'pending', 'pending'])
      down = false
      const finished = await run()
      assert.deepEqual(keys(), ['first', 'independent', 'first', 'second', 'second'])
      assert.equal(relay.bodies[0], relay.bodies[2])
      assert.deepEqual(finished.map((r: any) => r.state), ['sent', 'sent', 'sent', 'refused', 'pending'])
      assert.equal(finished[0].answer.results[0].value.duplicate, true)
      assert.equal(finished[3].answer.results[0].reason, 'KEY_REUSED')
      await run()
      assert.equal(relay.bodies.length, 5)
    })
  })
}

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
