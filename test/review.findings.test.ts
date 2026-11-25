/** What a review found wrong, each kept so that it does not come back. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect, createServer as createTcp } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { after, test } from 'node:test'
import pg from 'pg'
import { internalsOf } from '../src/client/internals.ts'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph, isFault } from '../src/index.ts'
import type { AccountGraph, LocalOptions, RecordEntry, RecordResult } from '../src/index.ts'
import { twilioSignature } from '../src/providers/twilio.ts'
import { runWorkers } from '../src/testing/index.ts'

const AT = 1_790_000_000_000
const NOW = AT + 3_600_000
const DAY = new Date(AT).toISOString().slice(0, 10)
const window = { from: DAY, to: DAY, timeZone: 'UTC' }
const SECRET = 'r'.repeat(40)
const url = process.env.DATABASE_URL
const pool = url ? new pg.Pool({ connectionString: url }) : undefined
after(() => pool?.end())
let count = 0

const KINDS: Record<string, (more?: object) => Promise<{ graph: AccountGraph; close(): Promise<void> }>> = {
  memory: async (more = {}) => {
    const graph = accountGraph({ memory: true, now: () => NOW, ...more })
    return { graph, close: () => graph.close() }
  },
  ...(url && {
    postgres: async (more = {}) => {
      const schema = `ag_found_${process.pid}_${count++}`
      const graph = accountGraph({ databaseUrl: url, schema, workers: false, receiptSecrets: [SECRET], now: () => NOW, ...more } as LocalOptions)
      return { graph, close: async () => { await graph.close(); await pool!.query(`drop schema if exists ${schema} cascade`) } }
    },
  }),
}
const both = (name: string, work: (graph: AccountGraph) => Promise<void>, more: object = {}) => {
  for (const [kind, open] of Object.entries(KINDS)) test(`${name}, ${kind}`, async () => {
    const { graph, close } = await open(more)
    try {
      await work(graph)
    } finally {
      await close()
    }
  })
}
const one = async (graph: AccountGraph, entry: RecordEntry): Promise<RecordResult> => (await graph.record({ entries: [entry] })).results[0]!
const call = (more: object = {}): RecordEntry => ({ type: 'call', key: 'C1', at: AT, direction: 'inbound', from: '+15558675309', to: '+15551230001', duration: 60, ...more }) as RecordEntry
const conversion = (more: object = {}): RecordEntry => ({ type: 'conversion', key: 'c', at: AT, subject: 'a', stage: 'sale', value: 100, currency: 'USD', ...more }) as RecordEntry
const stateOf = async (graph: AccountGraph, key: string) => {
  const kept = await graph.lookup({ kind: 'record', type: 'call', key, at: NOW })
  return kept?.type === 'call' ? kept.state : null
}
const codeOf = (work: Promise<unknown>) => work.then(() => 'ok', (error) => (isFault(error) ? error.code : `raw ${error}`))

both('what a platform answers cannot stop the rest', async (graph) => {
  await graph.record({ entries: [conversion({ key: 'bad', actions: { meta: 'Lead' }, email: 'a@example.com' }), conversion({ key: 'good', subject: 'b', actions: { meta: 'Other' }, email: 'b@example.com' })] })
  await runWorkers(graph)
  const deliveries = async (state: 'sent' | 'failed') => (await graph.report({ kind: 'deliveries', state })).value.deliveries
  assert.deepEqual([(await deliveries('failed')).map((each) => each.conversion), (await deliveries('sent')).map((each) => each.conversion)], [['bad'], ['good']])
  assert.ok((await graph.events({ after: null, limit: 10 })).ok)
}, {
  ads: { meta: { pixelId: '1', accessToken: 't', siteUrl: 'https://s.example/' } },
  fetch: async (_: unknown, init: any) => (JSON.parse(init.body).data[0].event_name === 'Lead' ? new Response(`x\0${'😀'.repeat(400)}`, { status: 400 }) : Response.json({ events_received: 1 })),
})

both('checks that hang do not keep a list from being recorded', async (graph) => {
  const entries = Array.from({ length: 40 }, (_, n): RecordEntry => ({ type: 'profile', key: `p${n}`, at: AT, subject: `s${n}`, facts: { phone: `+1555${1000000 + n}` } }))
  const { results } = await graph.record({ entries })
  assert.ok(results.every((each) => each.ok), JSON.stringify(results.find((each) => !each.ok)))
}, { timeoutMs: 3000, now: Date.now, checks: { lineType: { accountSid: 'AC', authToken: 't' } }, fetch: () => new Promise(() => {}) })

both('a call sent again undoes no newer report of it, whichever way it went', async (graph) => {
  const out = call({ key: 'O1', direction: 'outbound', from: '+15551230001', to: '+15558675309', result: { answered: false } })
  const update: RecordEntry = { type: 'call_update', key: 'u', at: AT + 10, call: 'O1', change: { kind: 'result', result: { answered: true } } }
  await graph.record({ entries: [out, update, out] })
  assert.equal(await stateOf(graph, 'O1'), 'answered')
  await graph.record({ entries: [{ ...update, key: 'v', call: 'O2' } as RecordEntry, { ...out, key: 'O2' } as RecordEntry] })
  assert.equal(await stateOf(graph, 'O2'), 'answered')
  // Said of a call you placed, a return means nothing, whichever comes first.
  const { results } = await graph.record({ entries: [{ type: 'call_update', key: 'x', at: AT, call: 'O1', change: { kind: 'returned', reachedAt: AT } }, conversion()] })
  assert.deepEqual(results.map((each) => each.ok && each.value.stands), [false, true])
})

both('two reports of one call at one time come to the same, whichever is first', async (graph) => {
  const [yes, not] = [true, false].map((answered) => ({ result: { answered } }))
  const states: unknown[] = []
  for (const [key, order] of [['A', [yes, not]], ['B', [not, yes]]] as const) {
    for (const each of order) await one(graph, call({ key, ...each }))
    states.push(await stateOf(graph, key))
  }
  assert.equal(states[0], states[1])
})

both('a result from before there were reports by time is not undone by its call', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { recordCall, recordCallResult } = await import('../src/core/calls.ts')
  await recordCall(engine.graph, { id: 'C1', from: '+15558675309', to: '+15551230001', at: AT, duration: 60, answered: false })
  await recordCallResult(engine.graph, { id: 'C1', answered: true })
  await one(graph, call({ result: { answered: false } }))
  assert.equal(await stateOf(graph, 'C1'), 'answered')
})

both('the first currency that is named is the conversion’s', async (graph) => {
  const said = (key: string, change: object): RecordEntry => ({ type: 'restatement', key, at: AT + 1, of: { type: 'conversion', key: 'c' }, change }) as RecordEntry
  await one(graph, conversion({ value: undefined, currency: undefined }))
  assert.ok((await one(graph, said('r', { kind: 'refund', amount: 9, currency: 'EUR' }))).ok)
  const other = await one(graph, said('s', { kind: 'correct', value: 100, currency: 'USD' }))
  assert.deepEqual(!other.ok && [other.reason, 'expected' in other && other.expected], ['CURRENCY_MISMATCH', 'EUR'])
  assert.ok((await one(graph, said('t', { kind: 'correct', value: 100, currency: 'EUR' }))).ok)
})

both('what is first said of a conversion does not depend on when it was paid', async (graph) => {
  const payment = (of: string): RecordEntry => ({ type: 'payment', key: `p ${of}`, at: AT, conversion: of, direction: 'received', amount: 5, currency: 'USD' })
  await graph.record({ entries: [conversion({ key: 'x', value: 50 }), payment('x'), payment('y'), conversion({ key: 'y', value: 50 })] })
  const { first, now } = (await graph.report({ kind: 'campaigns', window })).value.total.valueChange
  assert.deepEqual([first, now], [100, 10])
})

both('whoever is forgotten is in nothing that is said of others', async (graph) => {
  const person = (subject: string): RecordEntry => ({ type: 'profile', key: subject, at: AT, subject, facts: { device: 'd', identifiers: ['payment:p'] } })
  await graph.record({ entries: [person('b:2'), person('c:3'), person('a:1')] })
  const { engine } = await internalsOf(graph)!()
  await engine.store.ops.keepAlert({ key: 'alert:conversions:x', text: '• KEYconv to meta: no', at: NOW })
  await one(graph, conversion({ key: 'KEYconv', subject: 'a:1' }))
  await graph.forget({ key: 'f', at: AT, by: 'dana', subjects: ['a:1'], platforms: 'report' })
  assert.equal(JSON.stringify(await graph.events({ after: null, limit: 100 })).includes('a:1'), false)
  assert.deepEqual(await engine.store.ops.undelivered(), [])
  assert.deepEqual(await engine.graph.verify(), [])
})

both('somebody forgotten while alerts go out is not named after', async (graph) => {
  const { engine, ops } = await internalsOf(graph)!()
  const ring = (n: number): RecordEntry[] => [
    call({ key: `C${n}`, from: `+1555867000${n}`, result: { answered: false } }),
    { type: 'arrival', key: `a${n}`, at: AT - 1000, subject: `caller:${hash(`+1555867000${n}`)}`, source: 'google', medium: 'cpc', clicks: { gclid: `g${n}` } },
  ]
  await graph.record({ entries: [...ring(1), ...ring(2)] })
  const forgotten = `caller:${hash('+15558670002')}`
  let posts = 0
  posting = async () => {
    if (posts++ === 0) await graph.forget({ key: 'f', at: AT, by: 'dana', subjects: [forgotten], platforms: 'report' })
  }
  await ops.check()
  posting = async () => {}
  assert.ok(posts >= 1)
  assert.equal(JSON.stringify(await graph.events({ after: null, limit: 100 })).includes(forgotten), false)
  assert.equal((await engine.store.ops.undelivered()).length, 0)
}, { now: () => AT + 48 * 3_600_000, alerts: { url: 'https://hook.example' }, phones: { returnHours: 1 }, fetch: async () => (await posting(), new Response('')) })
let posting: () => Promise<void> = async () => {}
const { hashPhone: hash } = await import('../src/core/identifiers.ts')

both('a hidden caller is the same however it is said', async (graph) => {
  await one(graph, call({ from: '+266696687' }))
  const again = await one(graph, call({ from: 'Anonymous', result: { answered: false } }))
  assert.ok(again.ok && again.value.duplicate)
  assert.equal(await stateOf(graph, 'C1'), 'missed')
})

both('a list is not ended by what could have been seen at its beginning', async (graph) => {
  const bad: RecordEntry[] = [
    { type: 'cost', key: 'k', at: AT, rows: [{ day: DAY, source: ' ', amount: 1, currency: 'USD' }] },
    { type: 'profile', key: 'p', at: AT, subject: 's', facts: { identifiers: ['payment: '] } },
    { type: 'profile', key: 'p', at: AT, subject: '字'.repeat(200), facts: { device: 'd' } },
    { type: 'arrival', key: 'a', at: AT, subject: 's', clicks: { gclid: '字'.repeat(800) } },
  ]
  for (const entry of bad) assert.equal(await codeOf(graph.record({ entries: [conversion(), entry] })), 'INPUT.MALFORMED')
  assert.equal(await graph.lookup({ kind: 'record', type: 'conversion', key: 'c', at: NOW }), null)
  // At the limit, both stores take it.
  const { results } = await graph.record({ entries: [
    { type: 'arrival', key: 'a', at: AT, subject: 'é'.repeat(256), clicks: { gclid: '字'.repeat(682) } },
    { type: 'profile', key: 'p', at: AT, subject: 'é'.repeat(256), facts: { identifiers: [`payment:${'é'.repeat(508)}`] } },
  ] })
  assert.ok(results.every((each) => each.ok))
  assert.ok((await graph.decide({ key: 'd', at: AT, by: 'x', action: 'split', pairs: [{ a: 'é'.repeat(256), b: 'è'.repeat(256) }] })).ok)
})

test('the edge is closed with its instance, and what it took is finished', async () => {
  const graph = accountGraph({ memory: true, now: () => NOW })
  const server = createServer(createEdge(graph, { token: 't' })).listen(0, '127.0.0.1')
  const late = createServer(createEdge(graph, { token: 't' })).listen(0, '127.0.0.1')
  await new Promise((resolve) => late.once('listening', resolve))
  const post = (of: typeof server) => fetch(`http://127.0.0.1:${(of.address() as AddressInfo).port}/v1/record`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ entries: [conversion()] }) }).then(async (response) => [response.status, ((await response.json()) as any).fault?.code])
  try {
    assert.equal((await post(server))[0], 200)
    const under = Promise.all([post(server), post(server), post(server)])
    await new Promise((resolve) => setTimeout(resolve, 20))
    await graph.close()
    for (const [status, code] of await under) assert.ok(status === 200 || code === 'GRAPH.CLOSED', `${status} ${code}`)
    assert.deepEqual([await post(server), await post(late)], [[503, 'GRAPH.CLOSED'], [503, 'GRAPH.CLOSED']])
  } finally {
    for (const each of [server, late]) { each.closeAllConnections(); each.close() }
  }
})

test('events are posted from when the instance opened', async () => {
  const bodies: any[] = []
  const graph = accountGraph({ memory: true, now: () => NOW, webhook: { url: 'https://hook.example', secret: 's' }, fetch: (async (_: unknown, init: any) => (bodies.push(JSON.parse(init.body)), new Response(''))) as typeof fetch })
  await graph.record({ entries: ['a', 'b'].map((subject) => ({ type: 'profile' as const, key: subject, at: AT, subject, facts: { identifiers: ['payment:p'] } })) })
  await runWorkers(graph)
  assert.deepEqual(bodies.flatMap((body) => body.events.map((event: any) => event.type)), ['cluster.changed'])
  await graph.close()
})

test('one event a receiver will not have holds up only itself', async () => {
  let now = NOW
  const taken: number[] = []
  const graph = accountGraph({ memory: true, now: () => now, webhook: { url: 'https://hook.example', secret: 's' }, fetch: (async (_: unknown, init: any) => {
    const { events } = JSON.parse(init.body)
    if (events.some((event: any) => event.data.oldestDue === 2)) return new Response('', { status: 400 })
    taken.push(...events.map((event: any) => event.data.oldestDue))
    return new Response('')
  }) as typeof fetch })
  const { engine } = await internalsOf(graph)!()
  await engine.store.write((tx) => tx.emit([1, 2, 3].map((n) => ({ type: 'delivery.late' as const, at: NOW, data: { oldestDue: n } }))))
  for (let i = 0; i < 40 && !taken.includes(3); i++) {
    await runWorkers(graph)
    now += 3_600_000
  }
  assert.deepEqual(taken, [1, 3])
  await graph.close()
})

test('what cannot be waited for or sent is refused where the instance is made', async () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 3e9]) for (const options of [{ memory: true, timeoutMs }, { url: 'https://g.example', token: 't', timeoutMs }]) assert.throws(() => accountGraph(options as never), (error) => isFault(error) && error.code === 'CONFIG.INVALID')
  assert.throws(() => accountGraph({ url: 'https://g.example', token: 'a\nb' }), (error) => isFault(error) && error.code === 'CONFIG.INVALID')
  const seen: unknown[] = []
  const graph = accountGraph({ url: 'https://g.example', token: 't', fetch: (async (_: unknown, init: any) => (seen.push(new Headers(init.headers).get('x-request-id')), Response.json({ by: 'subject', subjects: [] }))) as typeof fetch })
  for (const correlationId of ['ok', 'a\nb', '日本']) await graph.lookup({ kind: 'find', text: 'x' }, { correlationId })
  assert.deepEqual(seen, ['ok', null, null])
})

test('what Twilio sends is taken, with what cannot be kept left out', async () => {
  const graph = accountGraph({ memory: true, now: () => NOW })
  const server = createServer(createEdge(graph, { token: 't', twilio: { authToken: 's', calls: 'https://g.example/c', texts: 'https://g.example/t' } })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const post = (path: string, to: string, fields: Record<string, string>) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'x-twilio-signature': twilioSignature('s', to, fields) } })
  try {
    assert.equal((await post('/texts/twilio', 'https://g.example/t', { MessageSid: 'SM1', SmsStatus: 'received', From: '+15558675309', To: '+15551230001', Body: 'STOP\0' })).status, 200)
    assert.equal((await post('/calls/twilio', 'https://g.example/c', { CallSid: 'CA1', CallStatus: 'completed', Direction: 'inbound', From: `sip:${'x'.repeat(80)}@example.org`, To: '+15551230001', CallDuration: '9' })).status, 204)
    const text = await graph.lookup({ kind: 'record', type: 'text', key: 'SM1', at: NOW })
    assert.deepEqual(text?.type === 'text' && text.flags, ['opt_out'])
    assert.notEqual(await graph.lookup({ kind: 'record', type: 'call', key: 'CA1', at: NOW }), null)
  } finally {
    server.closeAllConnections()
    server.close()
    await graph.close()
  }
})

test('the checks of every process run once each five minutes between them, and alerts of one kind are one event', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW })
  const { createWorkers } = await import('../src/client/workers.ts')
  const { createEngine } = await import('../src/core/engine.ts')
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createOps } = await import('../src/core/ops.ts')
  const store = createMemoryStore()
  let took = 0
  const engine = createEngine(store, { now: () => Date.now() + took })
  const ops = createOps(engine.graph, store.ops, { onError: () => {}, emit: (event) => store.write((tx) => tx.emit([event])) })
  const ran: number[] = []
  const check = ops.check
  // A look takes a little while, and the next is still on time.
  ops.check = async () => { ran.push((Date.now() - NOW) / 1000); await check(); took += 40 }
  const made = [1, 2].map(() => createWorkers(engine, ops, { memory: true }, () => {}))
  for (const each of made) each.start()
  const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve)) }
  await settle()
  for (let i = 0; i < 4; i++) { t.mock.timers.tick(300_000); await settle() }
  assert.deepEqual(ran, [0, 300, 600, 900, 1200])
  for (const each of made) await each.stop()
  // Said again within ten minutes, it is neither posted again nor another event.
  const quiet = createOps(engine.graph, store.ops, { url: 'https://hook.example', fetch: async () => new Response(''), emit: (event) => store.write((tx) => tx.emit([event])) })
  for (let i = 0; i < 3; i++) await quiet.alert('outbox', 'x', { type: 'delivery.paused', at: NOW, data: { reason: 'x' } })
  assert.equal((await store.read((tx) => tx.eventsAfter(0, 10))).length, 1)
})

if (url) {
  test('a connection that falls silent costs one call, and the instance still closes', { timeout: 60_000 }, async () => {
    const schema = `ag_found_${process.pid}_silent`
    const to = new URL(url)
    const open = new Set<{ a: Socket; b: Socket; dead: boolean }>()
    const proxy = createTcp((a) => {
      const pair = { a, b: connect(Number(to.port || 5432), to.hostname), dead: false }
      open.add(pair)
      a.on('data', (data) => void (pair.dead || pair.b.write(data)))
      pair.b.on('data', (data) => void (pair.dead || a.write(data)))
      for (const each of [a, pair.b]) each.on('error', () => {})
      a.on('close', () => pair.b.destroy())
    }).listen(0, '127.0.0.1')
    await new Promise((resolve) => proxy.once('listening', resolve))
    const through = new URL(url)
    through.port = String((proxy.address() as AddressInfo).port)
    through.hostname = '127.0.0.1'
    const graph = accountGraph({ databaseUrl: through.href, schema, workers: false, receiptSecrets: [SECRET], timeoutMs: 800 })
    try {
      assert.ok((await one(graph, conversion())).ok)
      for (const pair of open) pair.dead = true
      const codes: string[] = []
      for (let i = 0; i < 6; i++) codes.push(await codeOf(one(graph, conversion({ key: `n${i}` }))))
      assert.ok(codes.slice(0, 1).every((code) => code !== 'ok') && codes.at(-1) === 'ok', codes.join(' '))
    } finally {
      await graph.close()
      for (const pair of open) { pair.a.destroy(); pair.b.destroy() }
      proxy.close()
      await pool!.query(`drop schema if exists ${schema} cascade`)
    }
  })
}
