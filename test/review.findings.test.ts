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

both('an independent possible arrival appears after a corrected call loses its credited arrival', async graph => {
  const { engine } = await internalsOf(graph)!()
  const { dialed, hashPhone } = await import('../tools/internals.ts')
  const from = '+12025550101', to = '+12025550102'
  const line = 'caller:' + hashPhone(from)
  await engine.graph.observe([
    { subject: 'visitor:tap', at: AT - 100, identifiers: [dialed(to, AT - 100)] },
    { subject: 'visitor:other', at: AT - 200, identifiers: ['hardware:shared'] },
    { subject: line, at: AT - 200, identifiers: ['hardware:shared'] },
  ])
  await engine.graph.touch({ subject: 'visitor:tap', at: AT - 100, campaignId: 'credited' })
  await engine.graph.touch({ subject: 'visitor:other', at: AT - 200, campaignId: 'possible' })
  const person = async () => (await graph.lookup({ kind: 'person', subjects: [line], at: NOW })).people[0]!
  assert.ok((await one(graph, { type: 'call', key: 'stated', at: AT, direction: 'inbound', from, to, duration: 60 })).ok)
  const before = await person()
  assert.deepEqual([before.arrival?.campaignId, before.possible], ['credited', null])
  assert.ok((await one(graph, { type: 'call_update', key: 'party', at: AT + 1, call: 'stated', change: { kind: 'party', role: 'self', subject: 'contact:named', by: 'desk' } })).ok)
  const after = await person()
  assert.deepEqual([after.arrival, after.possible?.campaignId, after.possible?.confidence], [null, 'possible', 0.59])
}, { policy: { kinds: { hardware: { weight: 0.59, dilution: 0 } } } })

for (const [kind, open] of Object.entries(KINDS)) test(`a record's creation date stays out of matches, events, reports and ad deliveries, ${kind}`, async t => {
  const payloads: string[] = []
  const { graph, close } = await open({
    stages: { sale: {} }, ads: { meta: { pixelId: '1', accessToken: 'test', siteUrl: 'https://example.org/' } },
    fetch: async (_url: unknown, init: RequestInit) => {
      payloads.push(String(init.body))
      return Response.json({ events_received: 1 })
    },
  })
  t.after(close)
  const subjects = ['contact:one', 'contact:two']
  const profiles = subjects.map((subject, n) => ({ type: 'profile' as const, subject, at: AT, key: 'profile-' + n, facts: { email: `contact${n}@example.org` } }))
  assert.ok((await graph.record({ entries: profiles })).results.every(row => row.ok))
  const events = () => graph.events({ after: null, limit: 100 })
  const before = await events()
  assert.ok(before.ok)
  const { engine } = await internalsOf(graph)!()
  const identifiers = () => engine.store.read(async tx => (await tx.edgesOf(subjects)).map(edge => edge.identifier).sort())
  const known = await identifiers()
  const match = () => graph.lookup({ kind: 'match', facts: profiles[0]!.facts, at: AT })
  const baseline = await match()
  const createdAt = 1_456_789_012_345
  // Reporting the same date on two existing records must leave the graph as the reviewer found it.
  assert.ok((await graph.record({ entries: profiles.map(row => ({ ...row, key: row.key + '-dated', createdAt })) })).results.every(row => row.ok))
  assert.deepEqual(await events(), before)
  assert.deepEqual(await identifiers(), known)
  assert.deepEqual(await match(), baseline)
  const people = await graph.lookup({ kind: 'person', subjects, at: NOW })
  assert.deepEqual(people.people.map(person => person.members), subjects.map(subject => [subject]))
  const tie = await one(graph, { type: 'transfer', key: 'between', at: AT, from: subjects[0]!, to: subjects[1]!, amount: 1 })
  assert.ok(tie.type === 'transfer' && tie.ok)
  assert.deepEqual([tie.value.score, tie.value.relation], [0, 'none'])
  assert.ok((await one(graph, conversion({ subject: subjects[0], email: profiles[0]!.facts.email, actions: { meta: 'Lead' } }))).ok)
  await runWorkers(graph)
  assert.deepEqual(payloads.map(body => JSON.parse(body).data.map((event: { event_id: string }) => event.event_id)), [['c']])
  const journey = await graph.lookup({ kind: 'journey', subject: subjects[0]! })
  const board = await graph.report({ kind: 'pipeline', at: NOW, days: 1 })
  assert.ok(board.value.columns.some(column => column.rows.some(row => row.subject === subjects[0])))
  const disclosed = JSON.stringify([people, journey, board, await events(), ...payloads])
  for (const text of ['createdAt', 'firstSeen', String(Math.floor(createdAt / 1000)), new Date(createdAt).toISOString().slice(0, 10)]) assert.ok(!disclosed.includes(text), text)
})

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
}, { timeoutMs: 9000, now: Date.now, checks: { lineType: { accountSid: 'AC', authToken: 't' } }, fetch: () => new Promise(() => {}) })

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

both('the reviewer reads the dates of the account and all its linked and separated IDs together', async graph => {
  const { engine } = await internalsOf(graph)!()
  const who = 'contact:self'
  const linked = 'contact:linked'
  const apart = '__proto__'
  // The graph draws only 24 neighbors. Every row in the links table still needs its dates.
  const empty = Array.from({ length: 25 }, (_, i) => 'contact:empty' + i)
  const visitor = 'visitor:desk'
  const reads: string[][] = []
  const dates = engine.graph.subjectDates
  engine.graph.subjectDates = subjects => {
    reads.push([...subjects].sort())
    return dates(subjects)
  }
  const server = createServer(createEdge(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: ['https://example.org'] })).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const path = base + '/review/api/subject?subject='
  const record = (entries: object[]) => fetch(base + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service', 'content-type': 'application/json' }, body: JSON.stringify({ entries }) })
  try {
    const self = { type: 'profile', key: 'p1', at: AT, subject: who, createdAt: AT - 500, facts: { email: 'self@example.org', device: 'desk' } }
    const invalid = await record([self, { ...self, key: 'bad', createdAt: 'yesterday' }])
    assert.equal(invalid.status, 400)
    const accepted = await record([self,
      { type: 'profile', key: 'p2', at: AT + 1, subject: linked, createdAt: AT - 300, facts: { email: 'self@example.org' } },
      { type: 'profile', key: 'p3', at: AT + 2, subject: apart, createdAt: AT - 800, facts: { email: 'apart@example.org' } },
      { type: 'profile', key: 'p4', at: AT + 3, subject: visitor, facts: { device: 'desk' } },
    ])
    assert.equal(accepted.status, 200)
    assert.deepEqual(((await accepted.json()) as any).results.map((result: RecordResult) => result.ok && result.value.duplicate), [false, false, false, false])
    await engine.graph.separateAll([apart, ...empty].map(b => ({ a: who, b })))
    await engine.graph.touch({ subject: 'contact:arrival', at: AT - 100, source: 'search' })
    const browser = await fetch(path + who, { headers: { origin: 'https://example.org' } })
    assert.equal(browser.status, 401)
    assert.deepEqual(reads, [])
    const read = async (subject: string) => (await (await fetch(path + subject, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    const profile = await read(who)
    assert.deepEqual(profile.links.map((link: { subject: string }) => link.subject).sort(), [linked, visitor])
    assert.deepEqual(profile.separated, [apart, ...empty].sort())
    assert.deepEqual(profile.dates, { [who]: { firstSeen: AT, createdAt: AT - 500 }, [linked]: { firstSeen: AT + 1, createdAt: AT - 300 }, [apart]: { firstSeen: AT + 2, createdAt: AT - 800 }, ...Object.fromEntries(empty.map(id => [id, {}])), [visitor]: {} })
    assert.deepEqual(reads, [[who, linked, apart, ...empty].sort()])
    assert.deepEqual(await read('contact:arrival'), { subject: 'contact:arrival', known: false, dates: { 'contact:arrival': { firstSeen: AT - 100 } } })
    assert.deepEqual(await read('contact:none'), { subject: 'contact:none', known: false })
    // A call nobody owns is in no journey, and its time is not told by its id.
    await record([{ type: 'call', key: 'C9', direction: 'inbound', from: '+12025550177', to: '+12025550100', at: AT + 5, duration: 20 }, { type: 'call_update', key: 'C9u', at: AT + 6, call: 'C9', change: { kind: 'party', role: 'unknown', by: 'desk' } }])
    assert.deepEqual(await read('call:C9'), { subject: 'call:C9', known: false })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

both('health shows the rebuild command until the stored groups have been rebuilt', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  await engine.graph.observe({ subject: 'contact:a', identifiers: ['email:sample'], at: AT })
  await engine.store.write(tx => tx.setBuiltWith('earlier rules'))
  const server = createServer(createEdge(graph, { token: 't' })).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const read = (path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { authorization: 'Bearer t' } }).then(response => response.json())
  try {
    const warning = 'Groups are due a rebuild. Run account-graph rebuild.'
    assert.deepEqual(await read('/health'), { ok: true, warning })
    assert.equal((await read('/review/api/policy')).warning, warning)
    await engine.graph.rebuild()
    assert.deepEqual(await read('/health'), { ok: true })
    assert.equal((await read('/review/api/policy')).warning, undefined)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
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

const namePolicy = { apart: ['given', 'birth'], records: 'confirmed', kinds: { phone: { weight: 0.85 } } }

for (const [label, first, other, last, otherLast, together] of [
  ['placeholder', 'Unknown', 'Unknown', 'Not Provided', 'Not Provided', false],
  ['mixed first names', 'Maria文', 'Maria李', 'Lima', 'Lima', false],
  ['mixed surnames', 'Maria', 'Maria', 'Lima文', 'Lima李', false],
  ['same mixed name', 'María文', 'Maria文', 'Lima李', 'Lima李', true],
  ['ordinary name', 'José', 'Jose', 'Muñoz', 'Munoz', true],
  ['wholly non-Latin names on a phone', '李', '李', '王', '王', false],
] as const) both(`a shared phone and a name, ${label}`, async (graph) => {
  for (const speaker of [false, true]) {
    const subjects = [0, 1].map((n) => `contact:${speaker}-${n}`)
    for (const [n, subject] of subjects.entries()) {
      const name = { first: n ? other : first, last: n ? otherLast : last }
      const phone = speaker ? '202-555-0101' : '202-555-0100'
      assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts: { name, phone }, ...(speaker && { speaker: { phone } }) })).ok)
    }
    const { people } = await graph.lookup({ kind: 'person', subjects, at: NOW })
    assert.equal(people[0]!.members.includes(subjects[1]!), together, `speaker ${speaker}`)
  }
}, { identifierSecret: SECRET, policy: namePolicy })

for (const [first, last] of [['Unknown', 'Lima'], ['N/A', 'N/A'], ['Desconocida', 'Lima'], ['Sin', 'Nombre'], ['Lima', 'No proporcionado'], ['Inconnue', 'Lima'], ['Неизвестно', 'Lima'], ['Ana', 'غير معروف'], ['अज्ञात', 'Lima'], ['姓名不详', '李'], ['氏名不詳', '山田'], ['Baby', 'Lima'], ['Baby Boy', 'Lima']] as const) both(`a placeholder and one birthday cannot confirm two records, ${first} ${last}`, async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const facts = { email: 'house@example.org', name: { first, last }, dob: '1980-06-07' }
  for (const subject of ['contact:a', 'contact:b']) {
    assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts })).ok)
    assert.deepEqual(await engine.graph.verify(), [])
  }
  assert.deepEqual((await engine.graph.cluster('contact:a'))!.members, ['contact:a'])
  assert.equal((await graph.lookup({ kind: 'match', facts, at: AT })).candidates.some((candidate) => candidate.level === 'same'), false)
  await engine.graph.rebuild()
  assert.deepEqual((await (await engine.graph.asOf(NOW)).cluster('contact:b'))!.members, ['contact:b'])
}, { identifierSecret: SECRET, policy: namePolicy })

both('recognizing an additional placeholder cannot confirm it as the other name on a shared birthday', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const facts = { email: 'family@example.org', dob: '1980-04-02' }
  const first = { ...facts, name: { first: 'يوسف', last: 'Muñoz' } }
  const second = { ...facts, name: { first: 'Inconnu', last: 'Κάππα' } }
  assert.ok((await one(graph, { type: 'profile', key: 'one', at: AT, subject: 'contact:a', facts: first })).ok)
  assert.equal((await graph.lookup({ kind: 'match', facts: second, at: AT })).candidates[0]?.level, 'related')
  assert.ok((await one(graph, { type: 'profile', key: 'two', at: AT, subject: 'contact:b', facts: second })).ok)
  await engine.graph.rebuild()
  assert.deepEqual((await engine.graph.cluster('contact:a'))!.members, ['contact:a'])
}, { identifierSecret: SECRET, policy: { ...namePolicy, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } } })

both('a rebuild retires shared birthdays and checked names whose source could have been a placeholder', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { birthKeys } = await import('../src/core/identifiers.ts')
  const date = birthKeys(SECRET, '1980-06-07')
  const base = 'named:' + 'a'.repeat(64)
  const subjects = ['contact:a', 'contact:b']
  await engine.store.write(async (tx) => {
    await tx.addSightings(subjects.flatMap((subject) => ['email:shared', base, base + '~1', ...date].map((identifier) => ({ subject, identifier, at: AT }))))
    await tx.setLabels(new Map(subjects.map((subject) => [subject, { cluster: subjects[0]!, component: subjects[0]! }])))
    await tx.setBuiltWith('old rules')
  })
  assert.ok((await engine.graph.policy()).due)
  await engine.graph.rebuild()
  assert.deepEqual((await engine.graph.cluster('contact:a'))!.members, ['contact:a'])
  assert.deepEqual((await (await engine.graph.asOf(NOW)).cluster('contact:b'))!.members, ['contact:b'])
}, { identifierSecret: SECRET, policy: namePolicy })

both('a rebuild retires the checked name and birthday of a newborn label', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { birthKey } = await import('../src/core/identifiers.ts')
  const date = birthKey(SECRET, '1980-06-07')!
  const named = 'named:' + 'b'.repeat(64)
  const subjects = ['contact:a', 'contact:b']
  await engine.store.write(async tx => {
    const old = ['email:household', named, named + '~2', date, date + '~1']
    await tx.addSightings(subjects.flatMap(subject => old.map(identifier => ({ subject, identifier, at: AT }))))
    await tx.setBuiltWith('earlier rules')
  })
  await engine.graph.rebuild()
  assert.deepEqual((await engine.graph.cluster(subjects[0]!))?.members, subjects.slice(0, 1))
  assert.deepEqual(await engine.graph.verify(), [])
}, { identifierSecret: SECRET, policy: namePolicy })

both('a rebuild retires name evidence written before all distinguishing letters were kept', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const subjects = ['contact:one', 'contact:two']
  const phone = 'phone:56bcf01f15ebc008e3e50bad3555d6cfafa76c6472eb64c8d4b24f06f3c995d8'
  // Produced at 7c178f1 for Maria文 Lima and Maria李 Lima, on the same number and secret.
  const old = ['given:97f2c03d8be6dc182b376cc600928b772c7b846bd268407c25e34a7798f942b7', 'initial:901660c02479d03128393ca21ed0e7be7159ddc9e1d22e8153b3720d25b52070', 'named:aaf79ec1dcc55abd840e3eaf99a759cd5a2d43b5859cd980bffdb436b8c7339a', 'ward:b87419f29a31f48fb2f99fd1b6c81ccee68bca033c7c4bc077eb1813bfb4e8ab']
  await engine.store.write(async (tx) => {
    await tx.addSightings(subjects.flatMap((subject) => [phone, ...old].map((identifier) => ({ subject, identifier, at: AT }))))
    await tx.setLabels(new Map(subjects.map((subject) => [subject, { cluster: subjects[0]!, component: subjects[0]! }])))
    await tx.setBuiltWith('old rules')
  })
  const members = async () => (await graph.lookup({ kind: 'person', subjects, at: NOW })).people[0]!.members
  assert.deepEqual(await members(), subjects)
  await engine.graph.rebuild()
  assert.deepEqual(await members(), subjects.slice(0, 1))
  assert.deepEqual(await engine.graph.verify(), [])
  for (const subject of subjects) assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts: { phone: '202-555-0100', name: { first: 'Maria文', last: 'Lima' } } })).ok)
  assert.deepEqual(await members(), subjects)
  assert.deepEqual(await engine.graph.rebuild(), [])
  assert.deepEqual(await members(), subjects)
}, { identifierSecret: SECRET, policy: namePolicy })

for (const [label, keys, confirmed] of [
  ['different given names', [['given:97f2c03d8be6dc182b376cc600928b772c7b846bd268407c25e34a7798f942b7', 'initial:901660c02479d03128393ca21ed0e7be7159ddc9e1d22e8153b3720d25b52070'], ['given:4f718e3fc81fca184edeafe1fb1e98200cd613c4c57ecc839a6bb5de51979a4c', 'initial:e5f0aa26614ab3951eff85e3e3a5ed1b46cbc9194ad16e447b916d462fa29016']], false],
  ['different given names and an equal birth', [['given:97f2c03d8be6dc182b376cc600928b772c7b846bd268407c25e34a7798f942b7'], ['given:4f718e3fc81fca184edeafe1fb1e98200cd613c4c57ecc839a6bb5de51979a4c']], true],
  ['two named records and an equal birth', [['named:3de17624df4a665fb7ef0ea252b18d580d7a8dfddcd7b6a3c59e05bc4bda2803'], ['named:77174593c325e8c3ff8d6f1cbfe4d5ce487d83b768b363ebdbdcb490a21f67e1']], true],
] as const) both(`a rebuild keeps an earlier disagreement, ${label}`, async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const subjects = ['contact:one', 'contact:two']
  // Written with the old name rules for Maria and Carlos, and for two names outside the table.
  await engine.store.write(async (tx) => {
    await tx.addSightings(subjects.flatMap((subject, n) => ['email:shared', ...keys[n]!, ...(confirmed ? ['birth:same'] : [])].map((identifier) => ({ subject, identifier, at: AT }))))
    await tx.setLabels(new Map(subjects.map((subject) => [subject, { cluster: subject, component: subjects[0]! }])))
    await tx.setBuiltWith('old rules')
  })
  const memberships = async () => (await graph.lookup({ kind: 'person', subjects, at: NOW })).people.map((person) => person.members)
  assert.deepEqual(await memberships(), subjects.map((subject) => [subject]))
  await engine.graph.rebuild()
  assert.deepEqual(await memberships(), subjects.map((subject) => [subject]))
  // A new report on just one side must still respect the facts on the other.
  await engine.graph.observe({ subject: subjects[0]!, at: AT + 1, identifiers: keys[0].map((identifier) => identifier + '~1') })
  assert.deepEqual(await memberships(), subjects.map((subject) => [subject]))
  assert.deepEqual(await engine.graph.verify(), [])
}, { policy: { apart: ['given'], ...(confirmed && { records: 'confirmed' }) } })

both('removing an old name match cannot give the person to a third record', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { birthKeys, email } = await import('../src/core/identifiers.ts')
  const { givenKeys, namedKeys } = await import('../src/core/names.ts')
  const subjects = ['contact:a', 'contact:b', 'contact:c']
  const detail = 'common@example.org'
  const dob = '1980-04-05'
  const old = [...givenKeys(SECRET, 'John'), ...namedKeys(SECRET, [email(detail)], 'John', 'Doe')].filter((key) => !key.includes('~'))
  await engine.graph.observe({ subject: subjects[0]!, identifiers: [email(detail), ...old, ...birthKeys(SECRET, dob)], at: AT })
  for (const [n, first] of ['Maria', 'Maria文'].entries()) {
    const subject = subjects[n + 1]!
    assert.ok((await one(graph, { type: 'profile', subject, key: subject, at: AT + n + 1, facts: { email: detail, name: { first, last: 'Doe' }, ...(n === 0 && { dob }) } })).ok)
  }
  // Under the old rules only b and c were together. Checking the last letter separates them.
  const groups = async () => (await graph.lookup({ kind: 'person', subjects, at: NOW })).people.map((person) => person.members)
  assert.deepEqual(await groups(), subjects.map((subject) => [subject]))
  assert.deepEqual(await engine.graph.verify(), [])
  await engine.graph.rebuild()
  assert.deepEqual(await groups(), subjects.map((subject) => [subject]))
}, { identifierSecret: SECRET, policy: { apart: ['given'] } })

both('a name taken from a placeholder cannot confirm a record or lift an earlier disagreement', async (graph) => {
  for (const [n, first, last] of [[1, 'John', 'Doe'], [2, 'John', 'Doe'], [3, 'Maria', 'Lima']] as const) {
    const subject = `contact:${n}`
    assert.ok((await one(graph, { type: 'profile', subject, key: subject, at: AT, facts: { email: 'party@example.org', name: { first, last }, ...(n !== 2 && { dob: '1980-04-05' }) } })).ok)
  }
  const { people } = await graph.lookup({ kind: 'person', subjects: ['contact:1', 'contact:2', 'contact:3'], at: NOW })
  assert.deepEqual(people.map((person) => person.members), [['contact:1'], ['contact:2'], ['contact:3']])
}, { identifierSecret: SECRET, policy: namePolicy })

both('the exact name and birth in another script still confirm the shared email', async (graph) => {
  for (const [n, last] of [[1, '王'], [2, '王'], [3, '文']] as const) {
    const subject = `contact:${n}`
    assert.ok((await one(graph, { type: 'profile', subject, key: subject, at: AT, facts: { email: 'family@example.org', name: { first: '李', last }, dob: '1980-04-05' } })).ok)
  }
  const { people } = await graph.lookup({ kind: 'person', subjects: ['contact:1', 'contact:3'], at: NOW })
  assert.deepEqual(people.map((person) => person.members), [['contact:1', 'contact:2'], ['contact:3']])
}, { identifierSecret: SECRET, policy: { ...namePolicy, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } } })

both('keeping all letters of a name still honours the cap and mute on its earlier spelling', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const firsts = ['Maria文', 'Maria文', 'Maria李', 'Maria王', 'Maria林', 'Maria林']
  for (const [n, first] of firsts.entries()) {
    const subject = `contact:${n}`
    assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, speaker: { phone: '202-555-0100' }, facts: { name: { first, last: 'Lima' } } })).ok)
    assert.deepEqual(await engine.graph.verify(), [])
  }
  const together = async () => (await graph.lookup({ kind: 'person', subjects: ['contact:0'], at: NOW })).people[0]!.members.includes('contact:1')
  assert.equal(await together(), false)
  await graph.forget({ key: 'gone', by: 'desk', at: NOW, subjects: ['contact:5'], platforms: 'report' })
  assert.equal(await together(), true)
  const marks = (await engine.graph.links('contact:0')).find(({ subject }) => subject === 'contact:1')!.reasons.filter(({ identifier }) => identifier.startsWith('ward:'))
  for (const { identifier } of marks) await engine.graph.ignore(identifier)
  assert.equal(await together(), false)
  assert.deepEqual(await engine.graph.verify(), [])
  for (const { identifier } of marks) await engine.graph.ignore(identifier, false)
  assert.equal(await together(), true)
  assert.deepEqual(await engine.graph.rebuild(), [])
}, { identifierSecret: SECRET, policy: namePolicy })

for (const [preset, records] of [['household', false], ['intake', true]] as const) both(`an exact name on a shared phone keeps its vowel signs under ${preset}`, async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { nameKeys, phone } = await import('../src/core/identifiers.ts')
  for (const [line, second] of [['202-555-0100', 'करण'], ['202-555-0101', 'किरण']] as const) {
    const dob = second === 'करण' ? '1980-04-05' : '1980-06-07'
    const subjects = ['contact:' + line + '-1', 'contact:' + line + '-2']
    for (const [n, first] of ['किरण', second].entries()) {
      const subject = subjects[n]!
      assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts: { phone: line, name: { first, last: 'राय' }, dob } })).ok)
    }
    const { people } = await graph.lookup({ kind: 'person', subjects, at: NOW })
    assert.equal(people[0]!.members.includes(subjects[1]!), second === 'किरण')
    const exact = nameKeys(SECRET, 'किरण', 'राय', { dob })
    const matches = await engine.graph.match([phone(line), ...exact], { at: AT })
    const candidate = matches.find((entry) => entry.subject === subjects[1])!
    assert.equal(candidate.reasons.some(({ identifier }) => identifier.startsWith('name:')), second === 'किरण')
    assert.deepEqual(await engine.graph.verify(), [])
  }
}, {
  identifierSecret: SECRET,
  policy: { ...(records && { apart: ['birth', 'given'], records: 'confirmed' }), kinds: { phone: { weight: 0.85 } }, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } },
})

both('an exact name and a shared mailbox keep distinguishing marks in their script', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const pairs = [
    ['राम', 'रमा', 'शर्मा', false], ['क़मर', 'कमर', 'शर्मा', false], ['ก้อง', 'กอง', 'แก้ว', false],
    ['ᾍδης', 'Ἅδης', 'Πέτρου', false], ['Αϊδα', 'Αιδα', 'Πέτρου', false], ['ᾍδης', 'Ἅ\u0345δης', 'Πέτρου', true],
    ['ばら', 'はら', '中村', false], ['ばら', 'は\u3099ら', '中村', true], ['क़मर', 'क़मर', 'शर्मा', true],
    ['يُوسُف', 'يوسف', 'حسن', true], ['מֹשֶׁה', 'משה', 'כהן', true], ['Αλέξης', 'Αλεξης', 'Πέτρου', true],
  ] as const
  for (const [n, [first, other, last, together]] of pairs.entries()) {
    const subjects = [`contact:${n}-a`, `contact:${n}-b`]
    for (const [j, subject] of subjects.entries()) {
      const facts = { email: `home${n}@example.org`, dob: '1980-04-05', name: { first: j ? other : first, last } }
      assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts })).ok)
    }
    assert.equal((await engine.graph.cluster(subjects[0]!))!.members.includes(subjects[1]!), together, first + ' / ' + other)
  }
  assert.deepEqual(await engine.graph.verify(), [])
}, { identifierSecret: SECRET, policy: { ...namePolicy, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } } })

both('a rebuild retires an exact name whose old hash lost a vowel', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { phone } = await import('../src/core/identifiers.ts')
  const subjects = ['contact:one', 'contact:two']
  const line = phone('202-555-0100')
  // The exact name and birth of किरण राय and करण राय both made this key.
  const legacy = 'name:5d8af5b42c269af7a1544035e9174ec8b8a772411f795bd582294fd6feb84950'
  await engine.store.write(async (tx) => {
    await tx.addSightings(subjects.flatMap((subject) => [line, legacy].map((identifier) => ({ subject, identifier, at: AT }))))
    await tx.setLabels(new Map(subjects.map((subject) => [subject, { cluster: subjects[0]!, component: subjects[0]! }])))
    await tx.setBuiltWith('old rules')
  })
  const members = async () => (await graph.lookup({ kind: 'person', subjects, at: NOW })).people[0]!.members
  await engine.graph.rebuild()
  assert.deepEqual(await members(), subjects.slice(0, 1))
  assert.deepEqual((await (await engine.graph.asOf(NOW)).cluster(subjects[0]!))!.members, subjects.slice(0, 1))
  for (const [n, subject] of subjects.entries()) {
    if (n === 1) await engine.graph.ignore(legacy)
    assert.ok((await one(graph, { type: 'profile', key: subject, subject, at: AT, facts: { phone: '202-555-0100', name: { first: 'किरण', last: 'राय' }, dob: '1980-04-05' } })).ok)
    assert.deepEqual(await members(), subjects.slice(0, 1))
  }
  await engine.graph.ignore(legacy, false)
  assert.deepEqual(await members(), subjects)
  assert.deepEqual(await engine.graph.verify(), [])
}, { identifierSecret: SECRET, policy: { kinds: { phone: { weight: 0.85 } }, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } } })

both('a checked vowel sign leaves the earlier exact name cap in force', async (graph) => {
  const { engine } = await internalsOf(graph)!()
  const { nameKeys, phone } = await import('../src/core/identifiers.ts')
  const line = phone('202-555-0102')
  const names = ['किरण', 'किरण', 'करण', 'कीरण', 'कुरण', 'कूरण']
  for (const [n, first] of names.entries()) {
    const keys = nameKeys(SECRET, first, 'राय', { zip5: '62701' })
    await engine.graph.observe({ subject: 'contact:' + n, identifiers: n < 2 ? [line, ...keys] : keys, at: AT })
  }
  assert.deepEqual((await engine.graph.cluster('contact:0'))!.members, ['contact:0'])
  for (const n of [5, 4, 3, 2]) await engine.graph.forget('contact:' + n)
  assert.deepEqual((await engine.graph.cluster('contact:0'))!.members, ['contact:0', 'contact:1'])
  assert.deepEqual(await engine.graph.verify(), [])
}, { identifierSecret: SECRET, policy: { kinds: { phone: { weight: 0.85 } }, customKinds: { name: { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', group: 'name', corroborates: true } } } })

both('a proposed record counts towards the cap on facts that could confirm it', async (graph) => {
  const { nameKeys } = await import('../src/core/identifiers.ts')
  const identifiers = nameKeys(SECRET, 'কিরণ', 'রায়', { zip5: '62701' })
  const facts = { identifiers, email: 'one@example.org' }
  const lookup = async () => (await graph.lookup({ kind: 'match', facts, at: AT })).candidates.find(({ subject }) => subject === 'contact:one')
  assert.ok((await one(graph, { type: 'profile', key: 'one', subject: 'contact:one', at: AT, facts })).ok)
  assert.equal((await lookup())!.level, 'same')
  assert.ok((await one(graph, { type: 'profile', key: 'two', subject: 'contact:two', at: AT, facts: { identifiers, email: 'two@example.org' } })).ok)
  assert.equal((await lookup())!.unconfirmed, true)
  assert.ok((await one(graph, { type: 'profile', key: 'next', subject: 'contact:next', at: AT, facts })).ok)
  assert.deepEqual((await graph.lookup({ kind: 'person', subjects: ['contact:next'], at: NOW })).people[0]!.members, ['contact:next'])
}, { identifierSecret: SECRET, policy: { apart: ['birth', 'given'], records: 'confirmed', customKinds: { name: { weight: 0.6, dilution: 1, cap: 2, halfLife: 'none', group: 'name', corroborates: true } } } })
