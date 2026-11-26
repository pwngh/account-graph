import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pageServer } from './page-server.suite.ts'
import { after, test } from 'node:test'
import pg from 'pg'
import { internalsOf } from '../src/client/internals.ts'
import { hashPhone } from '../src/core/identifiers.ts'
import { codeNote } from '../tools/internals.ts'
import { createEdge } from '../src/edge/index.ts'
import { FAULT_CODES, accountGraph, hasCode, isFault } from '../src/index.ts'
import type { AccountGraph, DecideRequest, LocalOptions, RecordEntry, RecordResult } from '../src/index.ts'
import { accountGraph as remoteOnly } from '../src/remote.ts'
import { tokenRoutes } from './tokens.suite.ts'
import { runWorkers } from '../src/testing/index.ts'

const AT = 1_790_000_000_000
const NOW = AT + 3_600_000
const DAY = new Date(AT).toISOString().slice(0, 10)
const window = { from: DAY, to: DAY, timeZone: 'UTC' }
const SECRET = 'r'.repeat(40)
const shared = {
  now: () => NOW, identifierSecret: 'i'.repeat(32), linkSecret: 'l'.repeat(32), timeZone: 'UTC',
  stages: { inquiry: { value: 5, currency: 'USD' }, sale: { wait: 24 } },
  phones: { numbers: { '+15551230001': { source: 'google', campaignId: '20111' } }, exclude: ['+15550009999'] },
} satisfies Partial<LocalOptions>

const url = process.env.DATABASE_URL
const pool = url ? new pg.Pool({ connectionString: url }) : undefined
after(() => pool?.end())
let count = 0

interface Opened {
  graph: AccountGraph
  local: AccountGraph
  base?: string
  schema?: string
  close(): Promise<void>
}
const memory = async (more: object = {}): Promise<Opened> => {
  const graph = accountGraph({ memory: true, ...shared, ...more })
  return { graph, local: graph, close: () => graph.close() }
}
const postgres = async (more: object = {}): Promise<Opened> => {
  const schema = `ag_contract_${process.pid}_${count++}`
  const graph = accountGraph({ databaseUrl: url!, schema, workers: false, receiptSecrets: [SECRET], ...shared, ...more })
  return { graph, local: graph, schema, close: async () => { await graph.close(); await pool!.query(`drop schema if exists ${schema} cascade`) } }
}
const http = async (more: object = {}): Promise<Opened> => {
  const under = await memory(more)
  const server = createServer(createEdge(under.graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: ['https://s.example'], events: ['signup'], twilio: { authToken: 't', calls: 'https://g.example/calls/twilio' } })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const graph = accountGraph({ url: base, token: 'service' })
  return { graph, local: under.graph, base, close: async () => { await graph.close(); server.closeAllConnections(); server.close(); await under.close() } }
}
const KINDS: Record<string, (more?: object) => Promise<Opened>> = { memory, http, ...(url && { postgres }) }

/** Runs on each kind of instance, and compares what each answered with the first. */
function everywhere(name: string, work: (opened: Opened) => Promise<unknown>) {
  const answers: [string, unknown][] = []
  for (const [kind, open] of Object.entries(KINDS)) {
    test(`${name}, ${kind}`, async () => {
      const opened = await open()
      try {
        answers.push([kind, await work(opened)])
        if (answers.length > 1) assert.deepEqual(answers.at(-1)![1], answers[0]![1], `${kind} and ${answers[0]![0]} answer the same`)
      } finally {
        await opened.close()
      }
    })
  }
}

for (const [kind, open] of Object.entries({ memory, ...(url && { postgres }) })) {
  test(`service tokens open only the listed calls and kinds, ${kind}`, async () => {
    const opened = await open({ phones: { pool: { numbers: ['+12025550124'], minutes: 10, graceMinutes: 5 } } })
    try {
      await tokenRoutes(opened.local)
    } finally {
      await opened.close()
    }
  })
}

everywhere('a guarded page cannot leave an address, trace or receipt through the edge', ({ local }) => pageServer(local))

const one = async (graph: AccountGraph, entry: RecordEntry): Promise<RecordResult> => (await graph.record({ entries: [entry] })).results[0]!
const codeOf = (work: Promise<unknown>) => work.then((value) => ({ value }), (error) => (isFault(error) ? { code: error.code, retryable: error.retryable } : { raw: String(error) }))

everywhere('a creation date belongs to the exact record and the newest dated profile stands in either arrival order', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const records = ['contact:one', 'contact:two']
  const visitor = 'visitor:alias'
  const read = () => engine.graph.subjectDates([...records, visitor])
  const rows = []
  for (const [i, subject] of records.entries()) {
    const profile = { type: 'profile', at: AT, subject, facts: { device: 'alias' } } as const
    const early = { ...profile, at: AT - 1, key: i + '🟣', createdAt: 1 }
    // UTF-16 and UTF-8 order these two keys differently.
    const lower = { ...profile, key: i + '\uE000', createdAt: 2 }
    const winner = { ...profile, key: i + '\u{10000}', createdAt: 3 + i }
    const order = [early, lower, winner]
    const plain = { ...profile, key: i + 'plain', at: AT + 1 }
    const { results } = await graph.record({ entries: [...(i ? order.reverse() : order), plain, early, lower, winner, plain, { ...winner, createdAt: 9 }, { ...plain, createdAt: 9 }] })
    assert.deepEqual(results.slice(0, 8).map(r => r.ok && [r.value.duplicate, r.value.stands]), [
      [false, true], [false, !i], [false, !i], [false, true], [true, false], [true, false], [true, true], [true, true],
    ])
    assert.deepEqual(results.slice(8).map(r => !r.ok && [r.reason, 'fields' in r && r.fields]), [['KEY_REUSED', ['createdAt']], ['KEY_REUSED', ['createdAt']]])
    rows.push(results)
  }
  await one(graph, { type: 'profile', subject: visitor, facts: { device: 'alias' }, key: 'browser', at: AT - 100 })
  assert.ok((await graph.decide({ key: 'merge', at: NOW, by: 'desk', action: 'merge', pairs: [{ a: records[0]!, b: records[1]! }] })).ok)
  assert.deepEqual((await engine.graph.cluster(records[0]!))?.members, [...records, visitor])
  const expected = [
    [records[0], { firstSeen: AT - 1, createdAt: 3 }], [records[1], { firstSeen: AT - 1, createdAt: 4 }], [visitor, { firstSeen: AT - 100 }],
  ]
  assert.deepEqual([...(await read())].sort(), expected)
  await engine.graph.rebuild()
  assert.deepEqual([...(await read())].sort(), expected)
  assert.ok((await graph.forget({ key: 'erase-one', at: NOW, by: 'desk', subjects: [records[0]!], platforms: 'report' })).ok)
  assert.deepEqual([...(await read())].sort(), expected.slice(1))
  return rows
})

everywhere('creation time is a positive whole millisecond relative to the profile time and only applies to records', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const entry = { type: 'profile', key: 'p', at: AT - 7 * 86_400_000, subject: 'contact:mine', facts: { email: 'pat@example.org' } } as const
  const limit = entry.at + 86_400_000
  const valid = { ...entry, createdAt: limit }
  for (const bad of [
    ...[0, -1, 1.5, '1', null, limit + 1, 8_640_000_000_000_001].map(createdAt => ({ ...entry, createdAt })),
    ...['visitor:', 'caller:', 'call:'].map(prefix => ({ ...valid, subject: prefix + 'mine' })),
  ]) {
    assert.deepEqual(await codeOf(graph.record({ entries: [valid, { ...bad, key: 'bad' } as RecordEntry] })), { code: 'INPUT.MALFORMED', retryable: false })
  }
  assert.deepEqual(await engine.graph.subjectDates([entry.subject]), new Map())
  const result = await one(graph, valid)
  assert.ok(result.ok && !result.value.duplicate)
  assert.deepEqual((await engine.graph.subjectDates([entry.subject])).get(entry.subject), { firstSeen: entry.at, createdAt: limit })
  const refused = await one(graph, { ...valid, key: 'too-little', at: AT, createdAt: 1, facts: { address: { street: '1 Example St' } } })
  assert.ok(!refused.ok && refused.reason === 'NO_FACT_USED')
  assert.deepEqual((await engine.graph.subjectDates([entry.subject])).get(entry.subject), { firstSeen: entry.at, createdAt: limit })
  const unlinked = { ...valid, key: 'by-email', subject: 'contact:unlinked', facts: {}, speaker: { email: 'desk@example.org' } }
  assert.ok((await one(graph, unlinked)).ok)
  assert.equal(await engine.graph.cluster(unlinked.subject), undefined)
  assert.deepEqual((await engine.graph.subjectDates([unlinked.subject])).get(unlinked.subject), { createdAt: limit })
  assert.ok((await graph.forget({ key: 'erase-unlinked', by: 'desk', subjects: [unlinked.subject], at: NOW, platforms: 'report' })).ok)
  assert.deepEqual(await one(graph, unlinked), { type: 'profile', key: unlinked.key, ok: false, reason: 'FORGOTTEN' })
  assert.deepEqual(await engine.graph.subjectDates([unlinked.subject]), new Map())
  return result
})

const EVERY: RecordEntry[] = [
  { type: 'profile', key: 'p1', at: AT, subject: 'contact:1', event: 'signup', facts: { email: 'Pat.Lee+x@gmail.com', phone: '(555) 867-5309', device: 'd1', ip: '203.0.113.9', identifiers: ['payment:b', 'payment:a'] } },
  { type: 'arrival', key: 'a1', at: AT, subject: 'visitor:d1', source: 'google', medium: 'cpc', campaignId: '20111', clicks: { gclid: 'G1' }, custom: { office: 'north' } },
  { type: 'cost', key: 'k1', at: AT, rows: [{ day: DAY, source: 'google', campaignId: '20111', amount: 50, currency: 'usd' }, { day: DAY, source: 'meta', amount: 5, currency: 'USD', clicks: 3 }] },
  { type: 'conversion', key: 'c1', at: AT + 10, subject: 'contact:1', stage: 'sale', value: 100, currency: 'usd', email: 'pat@example.com', tags: { office: 'north' } },
  { type: 'restatement', key: 'r1', at: AT + 20, of: { type: 'conversion', key: 'c1' }, change: { kind: 'refund', amount: 30, currency: 'USD' } },
  { type: 'call', key: 'CA1', at: AT + 30, direction: 'inbound', from: '+1 555 867 5309', to: '+15551230001', duration: 60, result: { answered: false }, tags: { language: 'es' } },
  { type: 'call_update', key: 'u1', at: AT + 40, call: 'CA1', change: { kind: 'returned', reachedAt: AT + 35 } },
  { type: 'text', key: 'SM1', at: AT + 50, direction: 'inbound', from: '+15558675309', to: '+15551230001', text: 'hello' },
  { type: 'consent', key: 's1', at: AT + 60, subject: 'contact:1', consent: { adUserData: true, adPersonalization: false }, source: 'form' },
  { type: 'link', key: 'l1', at: AT + 70, subject: 'contact:1', url: 'https://example.org/form', expires: AT + 86_400_000, purpose: 'form' },
  { type: 'transfer', key: 't1', at: AT + 80, from: 'contact:1', to: 'contact:2', amount: 500, asset: 'usd' },
  { type: 'conversion', key: 'c2', at: AT + 90, subject: 'contact:1', stage: 'sale' },
  { type: 'payment', key: 'y1', at: AT + 95, conversion: 'c2', direction: 'received', amount: 80, currency: 'USD' },
]

everywhere('every kind of entry, and again', async ({ graph }) => {
  const first = await graph.record({ entries: EVERY })
  for (const result of first.results) assert.deepEqual([result.key, result.ok, result.ok && result.value.duplicate], [result.key, true, false], JSON.stringify(result))
  const again = await graph.record({ entries: EVERY })
  for (const result of again.results) assert.deepEqual([result.ok, result.ok && result.value.duplicate], [true, true], JSON.stringify(result))
  const at = NOW
  return {
    first, again,
    people: await graph.lookup({ kind: 'person', subjects: ['contact:1', 'nobody'], at }),
    journey: await graph.lookup({ kind: 'journey', subject: 'contact:1' }),
    find: await graph.lookup({ kind: 'find', text: 'patlee@gmail.com' }),
    match: await graph.lookup({ kind: 'match', facts: { phone: '5558675309' }, at }),
    caller: await graph.lookup({ kind: 'caller', from: '+15558675309', to: '+15551230001', at }),
    conflicts: await graph.lookup({ kind: 'conflicts', subjects: ['contact:1'] }),
    records: await Promise.all((['conversion:c1', 'conversion:c2', 'call:CA1', 'text:SM1', 'call:none'] as const).map((each) => graph.lookup({ kind: 'record', type: each.split(':')[0] as 'call', key: each.split(':')[1]!, at }))).then((views) => views.map((view) => (view && 'values' in view ? { ...view, values: view.values.map(({ value, kind }) => [value, kind ?? null]) } : view))),
    transfers: await graph.lookup({ kind: 'transfers', subject: 'contact:1' }),
    campaigns: (await graph.report({ kind: 'campaigns', window })).value.rows.map(({ source, campaignId, cost, visits, outcomes, value }) => ({ source, campaignId, cost, visits, outcomes, value })),
    pipeline: (await graph.report({ kind: 'pipeline', at, days: 90 })).value,
    calls: (await graph.report({ kind: 'calls', window, at })).value.total,
    callbacks: (await graph.report({ kind: 'callbacks', window, at })).value,
    texts: (await graph.report({ kind: 'texts', window, at })).value,
    after: (await graph.report({ kind: 'after_calls', window, at, step: 'sale', days: 30 })).value.days,
    deliveries: (await graph.report({ kind: 'deliveries', state: 'failed' })).value,
  }
})

test('nothing that is answered holds a hash of an email or a phone, or a key that was sent', async () => {
  const { graph, close } = await memory()
  try {
    const answers = JSON.stringify([
      await graph.record({ entries: EVERY }), await graph.lookup({ kind: 'journey', subject: 'contact:1' }), await graph.lookup({ kind: 'match', facts: { email: 'patlee@gmail.com', device: 'd1' }, at: NOW }),
      await graph.lookup({ kind: 'transfers', subject: 'contact:1' }), await graph.lookup({ kind: 'caller', from: '+15558675309', to: '+15551230001', at: NOW }), await graph.events({ after: null, limit: 1000 }),
    ])
    assert.doesNotMatch(answers, /"(email|phone|voip|device|ip|payment):/)
    assert.doesNotMatch(answers.replaceAll(/caller:[0-9a-f]{64}/g, ''), /[0-9a-f]{64}/)
  } finally {
    await close()
  }
})

/** The same entry, written another way. */
const otherwise = (value: any): any => {
  if (Array.isArray(value)) return [...value].reverse().map(otherwise)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, each]) => [key, key === 'email' ? ` ${String(each).toUpperCase()} ` : key === 'phone' || (key === 'from' && /^\+/.test(String(each))) ? String(each).replace(/(\d{3})(\d{4})$/, '$1-$2') : key === 'currency' ? String(each).toUpperCase() : otherwise(each)]))
  return value
}
everywhere('an entry written another way is the same, and one changed anywhere that counts is not', async ({ graph }) => {
  await graph.record({ entries: EVERY })
  for (const entry of EVERY) {
    const same = await one(graph, otherwise(entry))
    assert.ok(same.ok && same.value.duplicate, `${entry.type} ${JSON.stringify(same)}`)
  }
  const changes: [string, object, string[]][] = [
    ['p1', { subject: 'contact:9' }, ['subject']], ['p1', { facts: { email: 'other@example.com' } }, ['facts']], ['p1', { at: AT + 1 }, ['at']], ['a1', { campaignId: '9' }, ['campaignId']], ['k1', { rows: [{ day: DAY, source: 'meta', amount: 6, currency: 'USD' }] }, ['rows']],
    ['c1', { value: 101 }, ['value']], ['c1', { email: 'other@example.com', stage: 'x' }, ['email', 'stage']], ['r1', { change: { kind: 'refund', amount: 31 } }, ['change']], ['u1', { call: 'CA2' }, ['call']], ['s1', { consent: { adUserData: false, adPersonalization: false } }, ['consent']],
    ['l1', { url: 'https://example.org/other' }, ['url']], ['t1', { amount: 501 }, ['amount']], ['y1', { amount: 81 }, ['amount']], ['CA1', { to: '+15551230002' }, ['to']], ['CA1', { from: '+15551112222' }, ['from']], ['SM1', { direction: 'outbound' }, ['direction']],
  ]
  for (const [key, change, fields] of changes) assert.deepEqual(await one(graph, { ...EVERY.find((each) => each.key === key)!, ...change } as RecordEntry), { type: EVERY.find((each) => each.key === key)!.type, key, ok: false, reason: 'KEY_REUSED', fields })
  // What a provider makes up on each try, or a second reporter knows better, is not part of it.
  for (const entry of [{ ...EVERY[5]!, at: AT + 9999, duration: 61, result: { answered: true } }, { ...EVERY[7]!, at: AT + 9999, text: 'hello again' }, (({ from: _, ...rest }: any) => rest)(EVERY[5])] as RecordEntry[]) {
    const result = await one(graph, entry)
    assert.ok(result.ok && result.value.duplicate, JSON.stringify(result))
  }
  return (await graph.lookup({ kind: 'record', type: 'call', key: 'CA1', at: NOW }))
})

test('the pool option applies when a call rings and when it is recorded', async () => {
  const to = '+15550100175'
  const from = '+15550100176'
  for (const options of [{}, { requireTapAfterReassignment: true }]) {
    const { graph, local, close } = await memory({ phones: { pool: { numbers: [to], minutes: 15, graceMinutes: 120, ...options } } })
    try {
      const { engine } = await internalsOf(local)!()
      for (const [subject, at] of [['visitor:past', AT - 86_400_000], ['visitor:present', AT]] as const) {
        await one(graph, { type: 'profile', key: subject, subject, at, facts: { device: subject.slice('visitor:'.length) } })
        await engine.graph.lease(subject, { numbers: [to], minutes: 15, at })
      }
      const at = AT + 60_000
      const ring = await graph.lookup({ kind: 'caller', from, to, at })
      const call = await one(graph, { type: 'call', key: 'saved', direction: 'inbound', from, to, at })
      const expected = 'requireTapAfterReassignment' in options ? null : 'visitor:present'
      assert.equal(ring.visitor, expected)
      assert.ok(call.ok && call.type === 'call')
      assert.equal(call.value.visitor ?? null, expected)
    } finally {
      await close()
    }
  }
})

everywhere('two that come at once are one', async ({ graph, local }) => {
  for (const entry of EVERY) {
    const results = await Promise.all([one(graph, entry), one(graph, entry), one(graph, entry)])
    assert.deepEqual(results.map((result) => result.ok && result.value.duplicate).sort(), [false, true, true], entry.type)
  }
  const subject = 'contact:tied'
  const profile = { type: 'profile' as const, subject, key: 'same-key', at: AT, facts: { email: 'tied@example.org' } }
  const entries = [1, 2].map(createdAt => ({ ...profile, createdAt }))
  const results = await Promise.all(entries.map(entry => one(graph, entry)))
  assert.equal(results.filter(row => row.ok && !row.value.duplicate && row.value.stands).length, 1)
  assert.deepEqual(results.find(row => !row.ok), { type: 'profile', key: profile.key, ok: false, reason: 'KEY_REUSED', fields: ['createdAt'] })
  const { engine } = await internalsOf(local)!()
  assert.equal((await engine.graph.subjectDates([subject])).get(subject)?.createdAt, entries[results.findIndex(row => row.ok)]!.createdAt)
  return (await graph.report({ kind: 'campaigns', window })).value.total.visits
})

everywhere('a call is the visitor\'s whose code it carries, once, whichever of its reports has the code', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  for (const [n, code] of [[1, 'K7Q2MX'], [2, 'K7Q2MY']] as const) {
    await engine.graph.observe({ subject: `visitor:c${n}`, identifiers: [`device:c${n}`, codeNote(code)], at: AT, event: 'text_code' })
    await one(graph, { type: 'arrival', key: `c${n}`, at: AT, subject: `visitor:c${n}`, source: `site${n}` })
  }
  const call = (key: string, from: string, more: object = {}): RecordEntry => ({ type: 'call', key, at: AT + 60_000, direction: 'inbound', from, to: '+15551230001', duration: 60, ...more })
  const told = [
    await one(graph, call('K1', '+15550100261', { code: ' k7q2mx' })), await one(graph, call('K1', '+15550100261')),
    await one(graph, call('K2', '+15550100262')), await one(graph, call('K2', '+15550100262', { at: AT + 61_000, code: 'K7Q2MY' })),
    // Another code later is not compared, and changes nothing. One that is somebody's already ties nobody.
    await one(graph, call('K2', '+15550100262', { code: 'K7Q2MX' })), await one(graph, call('K3', '+15550100263', { code: 'K7Q2MX' })), await one(graph, call('K4', '+15550100264', { code: 'none' })),
  ]
  assert.deepEqual(told.map((each) => each.ok && each.type === 'call' && [each.value.duplicate, each.value.flags, each.value.visitor]), [
    [false, ['code'], 'visitor:c1'], [true, [], undefined], [false, [], undefined], [true, ['code'], 'visitor:c2'], [true, ['code'], 'visitor:c2'], [false, ['taken'], undefined], [false, [], undefined],
  ])
  const arrivals = []
  for (const each of told) if (each.ok && each.type === 'call') arrivals.push((await graph.lookup({ kind: 'person', subjects: [each.value.subject], at: NOW })).people[0]!.arrival)
  assert.deepEqual(arrivals.map((each) => each?.source), ['site1', 'site1', 'site2', 'site2', 'site2', 'google', 'google'])
  for (const code of ['', 7, 'x'.repeat(65)]) assert.deepEqual(await codeOf(graph.record({ entries: [call('K5', '+15550100265', { code })] })), { code: 'INPUT.MALFORMED', retryable: false })
  // At once, one of two callers has the visitor, and two reports of one call are one call with its code.
  await engine.graph.observe({ subject: 'visitor:c3', identifiers: ['device:c3', codeNote('K7Q2MZ')], at: AT })
  const both = await Promise.all(['+15550100266', '+15550100267'].map((from, i) => one(graph, call(`B${i}`, from, { code: 'K7Q2MZ' }))))
  assert.deepEqual(both.map((each) => each.ok && each.type === 'call' && each.value.flags[0]).sort(), ['code', 'taken'])
  await engine.graph.observe({ subject: 'visitor:c4', identifiers: ['device:c4', codeNote('K7Q2N2')], at: AT })
  await Promise.all([{}, { code: 'K7Q2N2' }, {}].map((more) => one(graph, call('B2', '+15550100268', more))))
  assert.equal((await engine.graph.keptCall('B2'))!.visitor, 'visitor:c4')
  // It is not kept, and no answer has it.
  assert.doesNotMatch(JSON.stringify([told, await graph.lookup({ kind: 'journey', subject: 'visitor:c1' }), await graph.lookup({ kind: 'record', type: 'call', key: 'K1', at: NOW })]), /K7Q2M/i)
  return [told, arrivals]
})

everywhere('what is refused can be put right and sent again with its key', async ({ graph }) => {
  const restatement: RecordEntry = { type: 'restatement', key: 'r', at: AT + 1, of: { type: 'conversion', key: 'c' }, change: { kind: 'refund', amount: 10 } }
  const reverse: RecordEntry = { ...restatement, key: 'v', change: { kind: 'reverse', restatement: 'r' } }
  const refusals = [await one(graph, restatement), await one(graph, reverse)]
  await one(graph, { type: 'conversion', key: 'c', at: AT, subject: 'a', stage: 'sale', value: 50, currency: 'USD' })
  const early = await one(graph, reverse)
  const results = [await one(graph, restatement), await one(graph, reverse), await one(graph, { ...restatement, key: 'w', change: { kind: 'correct', value: 5, currency: 'EUR' } })]
  await one(graph, { type: 'payment', key: 'p', at: AT, conversion: 'c', direction: 'received', amount: 12 })
  const paid = [await one(graph, { ...restatement, key: 'x' }), await one(graph, { type: 'payment', key: 'q', at: AT, conversion: 'c', direction: 'received', amount: 1, currency: 'EUR' })]
  assert.deepEqual([...refusals, early, results[2], ...paid].map((each) => !each!.ok && each!.reason), ['UNKNOWN_REFERENCE', 'UNKNOWN_REFERENCE', 'UNKNOWN_REFERENCE', 'CURRENCY_MISMATCH', 'PAID', 'CURRENCY_MISMATCH'])
  return { refusals, early, results, paid }
})

everywhere('one refusal in a list undoes nothing, and a later entry sees an earlier one', async ({ graph }) => {
  const { results } = await graph.record({ entries: [
    { type: 'arrival', key: 'a', at: AT, subject: 'visitor:z', source: 'google', clicks: { gclid: 'Z' } },
    { type: 'profile', key: 'v', at: AT, subject: 'visitor:z', facts: { device: 'z' } },
    { type: 'profile', key: 'bad', at: AT, subject: 'x', facts: { identifiers: ['nosuch:1'] } },
    { type: 'profile', key: 'reserved', at: AT, subject: 'x', facts: { identifiers: ['review:mine'] } },
    { type: 'profile', key: 'p', at: AT, subject: 'contact:z', facts: { device: 'z' } },
    { type: 'conversion', key: 'c', at: AT + 1, subject: 'contact:z', stage: 'sale', value: 1, currency: 'USD' },
    { type: 'restatement', key: 'n', at: AT + 2, of: { type: 'conversion', key: 'c' }, change: { kind: 'not_lead', why: 'spam' } },
    { type: 'restatement', key: 'm', at: AT + 1, of: { type: 'conversion', key: 'c' }, change: { kind: 'lead' } },
  ] })
  assert.deepEqual(results.map((result) => (result.ok ? result.value.stands : result.reason)), [true, true, 'KIND_NOT_IN_POLICY', 'KIND_RESERVED', true, true, true, false])
  return [results, (await graph.lookup({ kind: 'person', subjects: ['contact:z', 'x'], at: NOW })).people]
})

everywhere('facts that say nothing of who somebody is are refused, and can be sent again', async ({ graph }) => {
  const result = await one(graph, { type: 'profile', key: 'p', at: AT, subject: 'contact:1', facts: { address: { street: '1 Main St' } } })
  assert.ok((await one(graph, { type: 'profile', key: 'p', at: AT, subject: 'contact:1', facts: { device: 'd' } })).ok)
  return result
})

everywhere('decisions: stale, reused, not joined, and not as asked', async ({ graph }) => {
  await graph.record({ entries: ['a', 'b', 'c'].map((name, n) => ({ type: 'profile' as const, key: name, at: AT, subject: `contact:${name}`, facts: { identifiers: [`payment:${n}`] } })) })
  const decide = (key: string, action: DecideRequest['action'], pairs: [string, string][], more: object = {}) => graph.decide({ key, at: AT, by: 'dana', action, pairs: pairs.map(([a, b]) => ({ a: `contact:${a}`, b: `contact:${b}` })), ...more } as DecideRequest)
  const seen = (await graph.lookup({ kind: 'person', subjects: ['contact:a'], at: NOW })).decisions
  const out = [
    await decide('1', 'merge', [['a', 'b']], { seen }),
    await decide('1', 'merge', [['b', 'a']], { seen }),
    await decide('1', 'merge', [['a', 'c']]),
    await decide('2', 'split', [['a', 'b']], { seen }),
    await decide('3', 'unmerge', [['a', 'c']]),
    await decide('4', 'split', [['a', 'c']]),
    await decide('5', 'merge', [['a', 'c']]),
    await decide('6', 'unsplit', [['a', 'c']]),
    await decide('7', 'unmerge', [['a', 'b'], ['a', 'c']]),
    await graph.decide({ key: '8', at: AT, by: 'dana', action: 'mute', fact: { email: 'Front@Example.com' } }),
    await graph.decide({ key: '8', at: AT, by: 'dana', action: 'mute', fact: { email: 'front@example.com ' } }),
    await graph.decide({ key: '9', at: AT, by: 'dana', action: 'unmute', fact: { email: 'front@example.com' } }),
  ]
  assert.deepEqual(out.map((each) => (each.ok ? [each.value.duplicate, each.value.recorded, each.value.notAsAsked.length] : each.reason)), [[false, 1, 0], [true, 0, 0], 'KEY_REUSED', 'STALE', 'NOT_JOINED', [false, 1, 0], [false, 1, 1], [false, 1, 0], [false, 2, 0], [false, 1, 0], [true, 0, 0], [false, 1, 0]])
  return out.map((each) => ('at' in each ? { ...each, at: 0 } : each))
})

everywhere('a replayed pair decision says whether it still stands for every pair', async ({ graph }) => {
  const results = []
  for (const [action, undo] of [['split', 'unsplit'], ['merge', 'unmerge']] as const) {
    const pair = { a: action + '-a', b: action + '-b' }
    const first = { key: action, action, at: AT, by: 'dana', pairs: [pair, { a: action + '-c', b: action + '-d' }] }
    const inverse = { ...first, key: undo, action: undo, pairs: [{ a: pair.b, b: pair.a }] }
    const again = { ...first, key: action + '-again', pairs: [pair] }
    const answers = []
    for (const entry of [first, first, inverse, first, inverse, again, inverse, first]) {
      const answer = await graph.decide(entry)
      assert.ok(answer.ok)
      if (answer.value.duplicate) {
        assert.deepEqual(answer.value.changes, [])
        assert.equal(answer.value.recorded, 0)
        answers.push([answer.value.stands, answer.value.notAsAsked.map(({ a, b }) => [a, b])])
      } else assert.equal('stands' in answer.value, false)
    }
    const moved = action === 'merge'
    assert.deepEqual(answers, [[true, []], [false, moved ? [[pair.a, pair.b]] : []], [true, []], [false, moved ? [[pair.b, pair.a]] : []], [true, []]], action)
    results.push(answers)
  }
  return results
})

everywhere('a replayed merge or unmerge can stand while the two are in different clusters than asked', async ({ graph }) => {
  const a = 'contact:a'
  const b = 'contact:b'
  await graph.record({ entries: [a, b].map(subject => ({ type: 'profile', key: subject, at: AT, subject, facts: { identifiers: ['passkey:shared'] } })) })
  const answers = []
  for (const action of ['split', 'merge', 'merge', 'unsplit', 'unmerge', 'unmerge', 'merge'] as const) {
    const answer = await graph.decide({ key: action, action, at: AT, by: 'dana', pairs: [{ a, b }] })
    assert.ok(answer.ok)
    if (answer.value.duplicate) answers.push([answer.value.stands, answer.value.notAsAsked.map(pair => pair.because)])
  }
  assert.deepEqual(answers, [[true, ['split']], [true, ['evidence']], [false, []]])
  return answers
})

everywhere('a replayed phone mute or unmute checks both kinds of line', async ({ graph }) => {
  const phone = '+12025550110'
  const mute = { key: 'mute', at: AT, by: 'dana', action: 'mute', fact: { phone } } as const
  const unmute = { ...mute, key: 'unmute', action: 'unmute' } as const
  const voip = { identifier: `voip:${hashPhone(phone)}` }
  const answers = []
  for (const entry of [mute, mute, { ...unmute, key: 'restore-voip', fact: voip }, mute, unmute, unmute, { ...mute, key: 'mute-voip', fact: voip }, unmute]) {
    const answer = await graph.decide(entry)
    assert.ok(answer.ok)
    if (answer.value.duplicate) {
      assert.deepEqual(answer.value.changes, [])
      assert.equal(answer.value.recorded, 0)
      answers.push(answer.value.stands)
    } else assert.equal('stands' in answer.value, false)
  }
  assert.deepEqual(answers, [true, false, true, false])
  return answers
})

everywhere('whoever is forgotten stays forgotten, and what was forgotten can be asked again', async ({ graph, local, schema }) => {
  await graph.record({ entries: EVERY })
  // Written by the edge, or before there were receipts.
  const { engine } = await internalsOf(local)!()
  await engine.graph.outcome({ transactionId: 'old-1', subject: 'contact:1', at: AT, value: 3 })
  const caller = (await graph.lookup({ kind: 'caller', from: '+15558675309', to: '+15551230001', at: NOW })).subject!
  const request = { key: 'f', at: AT, by: 'dana', subjects: ['contact:1', caller], platforms: 'report' } as const
  const stale = await graph.forget({ ...request, seen: 0 }).then((answer) => answer.ok)
  const gone = await graph.forget(request)
  const again = await graph.forget({ ...request, subjects: [caller, 'contact:1'] })
  assert.deepEqual([stale, gone.ok && gone.value.duplicate, again.ok && again.value.duplicate], [true, true, true])
  const after = await graph.record({ entries: [...EVERY, { type: 'conversion', key: 'old-1', at: AT, subject: 'contact:1', stage: 'outcome', value: 3 }, { type: 'restatement', key: 'new', at: AT, of: { type: 'conversion', key: 'c1' }, change: { kind: 'refund', amount: 1 } }, { type: 'payment', key: 'late', at: AT, conversion: 'c1', direction: 'received', amount: 1 }, { type: 'call_update', key: 'late', at: AT, call: 'CA1', change: { kind: 'not_returned' } }] })
  const theirs = after.results.map((result) => [result.type, result.ok ? 'kept' : result.reason])
  assert.deepEqual(theirs.filter(([, how]) => how !== 'FORGOTTEN'), [['arrival', 'kept'], ['cost', 'kept']])
  assert.equal((await graph.lookup({ kind: 'person', subjects: ['contact:1'], at: NOW })).people[0]!.known, false)
  // The same person may come again, with keys of their own.
  assert.ok((await one(graph, { type: 'profile', key: 'p2', at: AT, subject: 'contact:1', facts: { device: 'd2' } })).ok)
  if (schema) {
    const kept = JSON.stringify([(await pool!.query(`select * from ${schema}.receipt where forgotten_at is not null`)).rows, (await pool!.query(`select * from ${schema}.receipt_subject`)).rows])
    for (const word of ['p1', 'c1', 'CA1', 'SM1', 'old-1', caller]) assert.equal(kept.includes(`"${word}"`), false, word)
    assert.deepEqual((await pool!.query(`select distinct digest, sent, ref_type, ref_mac from ${schema}.receipt where forgotten_at is not null`)).rows, [{ digest: null, sent: null, ref_type: null, ref_mac: null }])
  }
  return theirs
})

everywhere('a follower of events', async ({ graph }) => {
  await graph.record({ entries: EVERY.slice(0, 2) })
  await graph.record({ entries: [{ type: 'profile', key: 'x', at: AT, subject: 'contact:2', facts: { device: 'd1' } }, { type: 'profile', key: 'y', at: AT, subject: 'contact:3', facts: { device: 'd1' } }] })
  const all = await graph.events({ after: null, limit: 1000 })
  assert.ok(all.ok && all.value.events.length >= 2 && !all.value.more)
  const seen: unknown[] = []
  for (let after: string | null = null; ; ) {
    const page = await graph.events({ after, limit: 1 })
    assert.ok(page.ok)
    seen.push(...page.value.events)
    after = page.value.cursor
    if (!page.value.more) break
  }
  assert.deepEqual(seen, all.value.events)
  assert.deepEqual(await graph.events({ after: all.value.cursor, limit: 10 }), { ok: true, value: { schemaVersion: 1, events: [], cursor: all.value.cursor, more: false } })
  return [await graph.events({ after: 'another.1', limit: 1 }), all.value.events]
})

everywhere('the same faults', async ({ graph }) => {
  const entry = EVERY[3]!
  const bad: unknown[] = [
    null, {}, { entries: [] }, { entries: [{}] }, { entries: [{ type: 'nope' }] }, { entries: [{ ...entry, value: NaN }] }, { entries: [{ ...entry, value: Infinity }] }, { entries: [{ ...entry, value: 5n }] }, { entries: [{ ...entry, at: new Date(AT) }] }, { entries: [{ ...entry, at: undefined }] },
    { entries: [{ ...entry, key: 'call:x' }] }, { entries: [{ ...entry, key: '' }] }, { entries: [{ ...entry, extra: 1 }] }, { entries: [{ ...entry, subject: 'a\0' }] }, { entries: [{ ...entry, subject: '\ud800' }] }, { entries: [{ ...entry, email: 'nope' }] }, { entries: [{ ...entry, phone: '12' }] }, { entries: [{ ...entry, actions: { nowhere: 'x' } }] },
    { entries: [{ ...EVERY[5]!, to: 'nobody' }] }, { entries: [{ ...EVERY[0]!, facts: {} }] }, { entries: [{ ...EVERY[0]!, facts: { ip: 'x' } }] }, { entries: [{ ...EVERY[2]!, rows: [{ day: '2026-02-31', source: 'a', amount: 1, currency: 'USD' }] }] }, { entries: Array(101).fill(entry) }, { entries: [{ ...EVERY[8]!, at: 8e15 }] }, { entries: [new Map()] }, { entries: [{ ...entry, tags: JSON.parse('{"__proto__":"x"}') }] },
    { entries: [entry, { ...entry, key: 'z', email: 'nope' }] }, { entries: [entry, { ...entry, key: 'z', tags: { Office: 'x' } }] }, { entries: [entry, (({ from: _, ...rest }: any) => ({ ...rest, key: 'o', direction: 'outbound' }))(EVERY[5])] }, { entries: [entry, { ...EVERY[8]!, at: NOW + 2 * 86_400_000 }] },
    { entries: [entry, { ...EVERY[2]!, rows: [{ day: DAY, source: 'a', amount: 1, currency: 'USD', conversionValue: 2 }] }] }, { entries: [entry, { ...EVERY[9]!, key: 'a\nb' }] }, { entries: [entry, { ...EVERY[9]!, key: 'é'.repeat(200), subject: 'é'.repeat(250) }] },
  ]
  const out = []
  for (const request of bad) out.push(await codeOf(graph.record(request as never)))
  // Found before anything was written.
  out.push(await graph.lookup({ kind: 'record', type: 'conversion', key: entry.key, at: NOW }))
  for (const request of [{ kind: 'campaigns', window: { from: '2026-02-01', to: '2026-01-01', timeZone: 'UTC' } }, { kind: 'campaigns', window: { ...window, timeZone: 'Mars/One' } }, { kind: 'nope' }, { kind: 'callbacks', window, at: AT, after: 'x' }, { kind: 'pipeline', at: AT, days: 0 }]) out.push(await codeOf(graph.report(request as never)))
  for (const request of [{ kind: 'caller', to: 'x', at: AT }, { kind: 'person', subjects: [], at: AT }, { kind: 'match', facts: { email: 'x' }, at: AT }, { kind: 'find', text: '' }]) out.push(await codeOf(graph.lookup(request as never)))
  for (const request of [{ key: 'k', at: AT, by: '', subjects: ['a'], platforms: 'report' }, { key: 'k', at: AT, by: 'x', subjects: [], platforms: 'report' }, { key: 'k', at: AT, by: 'x', subjects: ['a'], platforms: 'retract' }]) out.push(await codeOf(graph.forget(request as never)))
  for (const request of [{ key: 'k', at: AT, by: 'x', action: 'merge', pairs: [{ a: 'a', b: 'a' }] }, { key: 'k', at: AT, by: 'x', action: 'mute', fact: {} }, { key: 'k', at: AT, by: 'x', action: 'mute', fact: { email: 'nope' } }]) out.push(await codeOf(graph.decide(request as never)))
  out.push(await codeOf(graph.record({ entries: [entry] }, { signal: AbortSignal.abort() })))
  assert.deepEqual(out.filter((each) => each && 'raw' in (each as object)), [])
  await graph.close()
  out.push(await codeOf(graph.events({ after: null, limit: 1 })))
  assert.deepEqual(out.at(-1), { code: FAULT_CODES.GRAPH.CLOSED, retryable: false })
  return out
})

const MOTHER = { device: 'mother-1', phone: '+15550100187', email: 'mother@example.org' }

everywhere('whoever speaks for a subject is not joined to them', async ({ graph }) => {
  const told: RecordEntry = { type: 'profile', key: 'told', at: AT, subject: 'contact:son', facts: { email: 'son@example.org', phone: MOTHER.phone }, speaker: MOTHER }
  const first = await one(graph, told)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal((await one(graph, { type: 'profile', key: 'hers', at: AT, subject: 'contact:mother', facts: { phone: MOTHER.phone, email: MOTHER.email } })).ok, true)
  const { people } = await graph.lookup({ kind: 'person', subjects: ['contact:son', 'contact:mother'], at: NOW })
  assert.equal(people[0]!.members.includes('contact:mother'), false)
  assert.equal(people[1]!.members.includes('contact:son'), false)
  // Nothing of the subject's own is needed, and the same told in another way of writing it is the same.
  assert.equal((await one(graph, { type: 'profile', key: 'bare', at: AT, subject: 'contact:nephew', facts: {}, speaker: { phone: '(555) 010-0187' } })).ok, true)
  const again = await one(graph, { ...told, speaker: { ...MOTHER, phone: '(555) 010-0187' } } as RecordEntry)
  assert.equal(again.ok && again.value.duplicate, true, JSON.stringify(again))
  const other = await one(graph, { ...told, speaker: { device: 'another' } } as RecordEntry)
  assert.deepEqual([other.ok, !other.ok && other.reason === 'KEY_REUSED' && other.fields], [false, ['speaker']])
  return { first, people }
})

everywhere('who spoke and was deleted is not brought back by a late retry', async ({ graph }) => {
  const told: RecordEntry = { type: 'profile', key: 'told', at: AT, subject: 'contact:son', facts: { email: 'son@example.org' }, speaker: { device: 'mother-1' } }
  await one(graph, told)
  assert.equal((await graph.forget({ key: 'gone', at: AT + 1, by: 'dana', subjects: ['visitor:mother-1'], platforms: 'report' })).ok, true)
  const late = await one(graph, told)
  assert.deepEqual([late.ok, !late.ok && late.reason], [false, 'FORGOTTEN'])
  assert.equal((await graph.lookup({ kind: 'person', subjects: ['visitor:mother-1'], at: NOW })).people[0]!.known, false)
  return late
})

everywhere('what a speaker cannot be is refused, and kinds the graph writes are its own', async ({ graph }) => {
  const of = (more: object) => codeOf(graph.record({ entries: [{ type: 'profile', key: 'x', at: AT, subject: 'contact:1', facts: {}, ...more } as RecordEntry] }))
  for (const more of [{}, { speaker: {} }, { speaker: { name: 'x' } }, { speaker: { phone: 'x' } }, { subject: 'visitor:1', speaker: { device: 'd' } }]) assert.deepEqual(await of(more), { code: 'INPUT.MALFORMED', retryable: false }, JSON.stringify(more))
  const kinds: unknown[] = []
  for (const kind of ['behalf', 'named', 'ward', 'given', 'dated', 'initial']) {
    const answer = await one(graph, { type: 'profile', key: `k-${kind}`, at: AT, subject: 'contact:1', facts: { identifiers: [`${kind}:x`] } })
    kinds.push(answer.ok || answer.reason)
  }
  assert.deepEqual([...new Set(kinds)], ['KIND_RESERVED'])
  const nobody = await one(graph, { type: 'profile', key: 'nobody', at: AT, subject: 'contact:1', facts: { phone: '555-555-5555' } })
  assert.deepEqual([nobody.ok, !nobody.ok && nobody.reason], [false, 'NO_FACT_USED'])
  return nobody
})

test('the line of whoever speaks is their own', async () => {
  const fetcher = async (to: string | URL | Request) => Response.json({ line_type_intelligence: { type: decodeURIComponent(String(to)).includes('0187') ? 'tollFree' : 'mobile' } })
  const graph = accountGraph({ memory: true, ...shared, checks: { lineType: { accountSid: 'AC', authToken: 'x' } }, fetch: fetcher as typeof fetch })
  const answer = await one(graph, { type: 'profile', key: 'lines', at: AT, subject: 'contact:son', facts: { phone: '+15550100141' }, speaker: { phone: MOTHER.phone } })
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.deepEqual(answer.ok && answer.type === 'profile' && answer.value.notes.phone, 'mobile')
  assert.deepEqual(answer.ok && answer.type === 'profile' && answer.value.notes.speaker, 'tollFree: not used')
  await graph.close()
})

test('a call from two reporters, one of them the provider, is one call', async () => {
  const { graph, local, base, close } = await http()
  const { twilioSignature } = await import('../src/providers/twilio.ts')
  try {
    const fields = { CallSid: 'CA77', CallStatus: 'completed', Direction: 'inbound', From: '+15558675309', To: '+15551230001', CallDuration: '61', Timestamp: new Date(AT + 61_000).toUTCString() }
    const post = () => fetch(`${base}/calls/twilio`, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'x-twilio-signature': twilioSignature('t', 'https://g.example/calls/twilio', fields) } })
    assert.deepEqual([(await post()).status, (await post()).status], [204, 204])
    const result = await one(graph, { type: 'call', key: 'CA77', at: AT, direction: 'inbound', from: '5558675309', to: '5551230001', result: { answered: true, waited: 4 } })
    assert.deepEqual([result.ok && result.value.duplicate, result.ok && 'state' in result.value && result.value.state], [true, 'answered'])
    const { engine } = await internalsOf(local)!()
    assert.equal((await engine.graph.callsOf([(result as any).value.subject])).length, 1)
    // Forgotten, the provider's next try brings nobody back.
    await graph.forget({ key: 'f', at: AT, by: 'dana', subjects: [(result as any).value.subject], platforms: 'report' })
    assert.equal((await post()).status, 204)
    assert.equal(await graph.lookup({ kind: 'record', type: 'call', key: 'CA77', at: NOW }), null)
  } finally {
    await close()
  }
})

test('what each token opens of the six calls', async () => {
  const { base, close } = await http()
  const ask = async (name: string, body: unknown, token = 'reviewer', method = 'POST') => {
    const response = await fetch(`${base}/v1/${name}`, { method, headers: { authorization: `Bearer ${token}`, 'x-request-id': 'abc' }, ...(method === 'POST' && { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
    return { status: response.status, id: response.headers.get('x-request-id'), body: (await response.json()) as any }
  }
  try {
    const decide = { key: 'k', at: AT, by: 'dana', action: 'merge', pairs: [{ a: 'a', b: 'b' }] }
    const answers = [
      await ask('record', { entries: EVERY }), await ask('events', { after: null, limit: 1 }), await ask('lookup', { kind: 'person', subjects: ['a'], at: AT }), await ask('lookup', { kind: 'find', text: 'a' }), await ask('report', { kind: 'campaigns', window }),
      await ask('decide', { ...decide, by: 'lee' }), await ask('decide', decide), await ask('forget', { key: 'k', at: AT, by: 'lee', subjects: ['a'], platforms: 'report' }), await ask('record', { entries: EVERY }, 'wrong'), await ask('record', '{', 'service'), await ask('record', 'null', 'service'), await ask('nope', {}, 'service'), await ask('close', {}, 'service'), await ask('record', undefined, 'service', 'GET'),
    ]
    assert.deepEqual(answers.map(({ status }) => status), [403, 403, 403, 200, 200, 403, 200, 403, 401, 400, 400, 404, 404, 405])
    assert.deepEqual([answers[0]!.body, answers[8]!.body.fault.code, answers[9]!.body.fault.code], [{ fault: { code: 'AUTH.FORBIDDEN', message: 'The token does not open this call', retryable: false, detail: {} } }, 'AUTH.REJECTED', 'INPUT.MALFORMED'])
    assert.equal(answers[3]!.id, 'abc')
    const graph = accountGraph({ url: base!, token: 'wrong' })
    assert.deepEqual(await codeOf(graph.record({ entries: EVERY })), { code: 'AUTH.REJECTED', retryable: false })
    for (const old of ['/observe', '/identify', '/convert', '/restate', '/cluster', '/report', '/rebuild', '/stats', '/subject']) assert.equal((await fetch(base + old, { method: 'POST', body: '{}', headers: { authorization: 'Bearer service' } })).status, 404, old)
  } finally {
    await close()
  }
})

test('a remote instance says what came of an answer that did not', async () => {
  let answer: () => Response | Promise<Response> = () => new Response('')
  const graph = accountGraph({ url: 'https://g.example/base', token: 't', timeoutMs: 50, fetch: (async (_: unknown, init: any) => {
    init.signal.throwIfAborted()
    return answer()
  }) as typeof fetch })
  const ask = { kind: 'find', text: 'x' } as const
  const of = async (made: typeof answer, call: () => Promise<unknown> = () => graph.record({ entries: EVERY })) => {
    answer = made
    const got = (await codeOf(call())) as any
    return got.code ?? got
  }
  assert.deepEqual([
    await of(() => Promise.reject(new TypeError('fetch failed'))), await of(() => new Response('<html>', { status: 502 })), await of(() => new Response('', { status: 504 })), await of(() => new Response('<html>')), await of(() => new Response('<html>'), () => graph.lookup(ask)),
    await of(() => new Response('', { status: 503 })), await of(() => new Response('', { status: 429, headers: { 'retry-after': '3' } })), await of(() => new Response('', { status: 404 })), await of(() => new Response(null, { status: 302, headers: { location: '/x' } })), await of(() => new Response('', { status: 500 })), await of(() => new Response('', { status: 401 })),
    await of(() => new Response('{"fault":{"code":"GRAPH.UNAVAILABLE","message":"m","retryable":true,"detail":{}}}', { status: 503 })), await of(() => new Response('{"fault":{"code":"__proto__","message":"m"}}', { status: 500 })),
  ], ['TRANSPORT.INDETERMINATE', 'TRANSPORT.INDETERMINATE', 'TRANSPORT.INDETERMINATE', 'TRANSPORT.INDETERMINATE', 'GRAPH.INTERNAL', 'GRAPH.UNAVAILABLE', 'GRAPH.UNAVAILABLE', 'CONFIG.INVALID', 'CONFIG.INVALID', 'GRAPH.INTERNAL', 'AUTH.REJECTED', 'GRAPH.UNAVAILABLE', 'GRAPH.INTERNAL'])
  // Events of a newer server are handed on as what they are.
  answer = () => new Response(JSON.stringify({ ok: true, value: { schemaVersion: 1, events: [{ schemaVersion: 1, seq: 9, type: 'person.born', at: 1, data: {} }], cursor: 'x.9', more: false } }))
  const page = await graph.events({ after: null, limit: 1 })
  assert.deepEqual(page.ok && page.value.events.map((event) => [event.type, event.seq]), [['Unrecognized', 9]])
})

test('options that cannot be are refused at once, and each said', async () => {
  const problems = (options: object): string[] => {
    try {
      accountGraph(options as LocalOptions)
      return []
    } catch (error) {
      assert.ok(hasCode(error, FAULT_CODES.CONFIG.INVALID), String(error))
      return String((error as Error).message).split('\n')
    }
  }
  assert.deepEqual([{}, { url: 'nope', token: 't' }, { url: 'ftp://x', token: 't' }, { url: 'https://x', token: '' }, { memory: true, url: 'https://x' }, { databaseUrl: 'x', memory: true }].map((each) => problems(each).length), [1, 1, 1, 1, 1, 1])
  const wrong = problems({ databaseUrl: 'postgres://x', receiptSecrets: ['short'], schema: 'A', identifierSecret: 'x', timeZone: 'Mars/One', policy: { same: 9, kinds: { phnoe: { weight: 1 } } }, openHours: { mon: ['nine'] }, stages: { a: { value: 'x' } }, phones: { exclude: ['x'], tapSeconds: 9999 }, webhook: { url: 'https://x' } })
  assert.equal(wrong.length >= 11, true, wrong.join('\n'))
  assert.throws(() => remoteOnly({ memory: true }), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  const remote = accountGraph({ url: 'https://g.example', token: 't' })
  assert.throws(() => createEdge(remote, { token: 't' }), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  await assert.rejects(runWorkers(remote), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  const unavailable = createServer().on('connection', socket => socket.destroy()).listen(0, '127.0.0.1')
  await new Promise(resolve => unavailable.once('listening', resolve))
  const down = accountGraph({ databaseUrl: `postgres://nobody@127.0.0.1:${(unavailable.address() as AddressInfo).port}/x`, workers: false, receiptSecrets: [SECRET], timeoutMs: 2000 })
  try {
    assert.deepEqual(await codeOf(down.lookup({ kind: 'find', text: 'x' })), { code: FAULT_CODES.GRAPH.UNAVAILABLE, retryable: true })
  } finally {
    await down.close()
    unavailable.close()
  }
})

test('a list that takes too long is done as far as it got, and the rest says it was not tried', async () => {
  let now = NOW
  const { graph, close } = await memory({ now: () => (now += 200) })
  try {
    const entries = Array.from({ length: 100 }, (_, n): RecordEntry => ({ type: 'consent', key: `s${n}`, at: AT, subject: `contact:${n}`, consent: { adUserData: true, adPersonalization: true } }))
    const { results } = await graph.record({ entries })
    const done = results.findIndex((each) => !each.ok)
    assert.ok(done > 0 && done < 100, String(done))
    assert.ok(results.every((each, n) => (n < done ? each.ok : !each.ok && each.reason === 'NOT_ATTEMPTED')))
    now = NOW
    const again = (await graph.record({ entries: entries.slice(0, done + 1) })).results
    assert.deepEqual(again.map((each) => each.ok && each.value.duplicate), [...Array(done).fill(true), false])
  } finally {
    await close()
  }
})

test('a deletion asks platforms after it, and its answer is kept', async () => {
  const { createEngine } = await import('../src/core/engine.ts')
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createReceipts } = await import('../src/core/receipts.ts')
  const { createSix } = await import('../src/core/six.ts')
  let cut = true
  const target = { name: 'ads', restates: false, batch: 10, keys: () => ({ email: 'h' }), click: () => undefined, retryable: () => true, deliver: async () => ({ requestId: 'r' }), forget: async (jobs: readonly unknown[]) => { if (cut) throw new Error('cut off'); return jobs.map(() => undefined) } }
  const store = createMemoryStore()
  const engine = createEngine(store, { delivery: { targets: [target] }, now: () => NOW })
  const six = createSix(engine, { receipts: createReceipts([SECRET]) })
  const asked = async (subject: string) => {
    await six.record({ entries: [{ type: 'conversion', key: subject, at: AT, subject, stage: 'sale', actions: { ads: 'Sale' }, email: 'a@example.com' }] })
    await engine.outbox!.run()
    const request = { key: `f ${subject}`, at: AT, by: 'dana', subjects: [subject], platforms: 'retract' as const }
    const answer = await six.forget(request)
    return [answer, await six.forget(request)].map((each) => each.ok && [each.value.duplicate, each.value.sent.map(({ conversion, state }) => [conversion, state])])
  }
  assert.deepEqual(await asked('a'), [[false, [['a', 'rejected']]], [true, [['a', 'rejected']]]])
  cut = false
  assert.deepEqual(await asked('b'), [[false, [['b', 'accepted']]], [true, [['b', 'accepted']]]])
})

test('a provider is told to ask again while the database is away, and a decision anywhere is seen everywhere', async () => {
  const { local, base, close } = await http()
  const { twilioSignature } = await import('../src/providers/twilio.ts')
  try {
    const { engine } = await internalsOf(local)!()
    const fields = { CallSid: 'CA1', CallStatus: 'completed', Direction: 'inbound', From: '+15558675309', To: '+15551230001', CallDuration: '61' }
    const post = () => fetch(`${base}/calls/twilio`, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'x-twilio-signature': twilioSignature('t', 'https://g.example/calls/twilio', fields) } })
    const write = engine.store.write
    engine.store.write = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    const away = await post()
    const review = await fetch(`${base}/review/api/join`, { method: 'POST', headers: { authorization: 'Bearer reviewer' }, body: '{"a":"contact:1","b":"contact:2"}' })
    assert.deepEqual([away.status, away.headers.get('retry-after'), review.status], [503, '5', 503])
    engine.store.write = write
    assert.equal((await post()).status, 204)

    const ask = async () => (await (await fetch(`${base}/review/api/report?from=${DAY}&to=${DAY}`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    let made = 0
    const read = engine.graph.report
    engine.graph.report = (...given) => ((made += 1), read(...given))
    const six = async () => (await fetch(`${base}/v1/report`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ kind: 'campaigns', window }) })).json()
    await six()
    await six()
    assert.equal(made, 1)
    assert.equal((await fetch(`${base}/review/api/join`, { method: 'POST', headers: { authorization: 'Bearer reviewer' }, body: '{"a":"contact:1","b":"contact:2"}' })).status, 200)
    await six()
    assert.equal(made, 2)
    await ask()
  } finally {
    await close()
  }
})

test('answers of a report are shared until something is written', async () => {
  let now = NOW
  const { graph, local, close } = await memory({ now: () => now })
  try {
    await graph.record({ entries: EVERY })
    const { engine } = await internalsOf(local)!()
    const read = engine.graph.board
    let made = 0
    engine.graph.board = (...given) => ((made += 1), read(...given))
    const ask = () => graph.report({ kind: 'pipeline', at: now, days: 30 })
    const first = await ask()
    now += 1000
    const second = await ask()
    assert.deepEqual([made, second.asOf], [1, first.asOf])
    await graph.decide({ key: 'd', at: AT, by: 'dana', action: 'merge', pairs: [{ a: 'contact:1', b: 'contact:2' }] })
    assert.deepEqual([(await ask()).asOf, made], [now, 2])
    // Of another time, it is of that time.
    assert.equal((await graph.report({ kind: 'pipeline', at: AT, days: 30 })).asOf, AT)
  } finally {
    await close()
  }
})

if (url) {
  test('processes that share a database share its settings, and one that does not is told', async () => {
    const schema = `ag_contract_${process.pid}_settings`
    const open = (more: object) => accountGraph({ databaseUrl: url, schema, workers: false, receiptSecrets: [SECRET], ...shared, ...more } as LocalOptions)
    const entry = (key: string): RecordEntry => ({ type: 'profile', key, at: AT, subject: 'contact:1', facts: { email: 'a@example.org' } })
    const using = async (more: object, key: string) => {
      const graph = open(more)
      try {
        return await codeOf(one(graph, entry(key)).then((result) => result.ok))
      } finally {
        await graph.close()
      }
    }
    try {
      assert.deepEqual([
        await using({ policy: { kinds: { phone: { weight: 0.85 } } } }, '1'),
        // With none of its own it takes the database's.
        await using({}, '2'),
        await using({ policy: { kinds: { phone: { weight: 0.8 } } } }, '3'),
        await using({ identifierSecret: 'j'.repeat(32) }, '4'),
        await using({ receiptSecrets: ['q'.repeat(40)] }, '5'),
        // A new secret signs, and the old one is still tried.
        await using({ receiptSecrets: ['q'.repeat(40), SECRET] }, '6'),
        await using({ receiptSecrets: [SECRET] }, '7'),
      ], [{ value: true }, { value: true }, { code: 'CONFIG.MISMATCH', retryable: false }, { code: 'CONFIG.MISMATCH', retryable: false }, { code: 'CONFIG.MISMATCH', retryable: false }, { value: true }, { code: 'CONFIG.MISMATCH', retryable: false }])
      const rotated = open({ receiptSecrets: ['q'.repeat(40), SECRET] })
      try {
        const results = (await rotated.record({ entries: [entry('1'), { ...entry('2'), subject: 'contact:2' } as RecordEntry] })).results
        assert.deepEqual(results.map((each) => (each.ok ? each.value.duplicate : each.reason)), [true, 'KEY_REUSED'])
        await rotated.forget({ key: 'f', at: AT, by: 'dana', subjects: ['contact:1'], platforms: 'report' })
        assert.deepEqual((await rotated.record({ entries: [entry('1'), entry('6')] })).results.map((each) => !each.ok && each.reason), ['FORGOTTEN', 'FORGOTTEN'])
      } finally {
        await rotated.close()
      }
    } finally {
      await pool!.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a call that waits too long for the lock ends', async () => {
    const { graph, schema, close } = await postgres({ timeoutMs: 600 })
    const holder = await pool!.connect()
    try {
      await one(graph, EVERY[1]!)
      await holder.query('begin')
      await holder.query('select pg_advisory_xact_lock(hashtext($1))', [`account-graph:${schema}`])
      assert.deepEqual(await codeOf(graph.record({ entries: EVERY.slice(0, 1) })), { code: 'TRANSPORT.INDETERMINATE', retryable: true })
      await holder.query('commit')
      assert.ok((await one(graph, EVERY[0]!)).ok)
    } finally {
      holder.release()
      await close()
    }
  })
}

for (const report of ['callbacks', 'pipeline', 'campaigns'] as const) everywhere(`a private call tie supplies only campaign credit to the ${report} report`, async ({ graph, local, base }) => {
  const owner = 'record:owner'
  const visitor = 'visitor:private'
  const credit = { source: 'google', campaign: 'Example', campaignId: 'campaign-one' }
  const arrived = AT - 2 * 86_400_000 + 4567
  const landing = 'https://example.org/private-visit'
  const { engine } = await internalsOf(local)!()
  await engine.graph.observe({ subject: visitor, identifiers: [codeNote('K7Q2MX')], at: AT - 100 })
  const entries: RecordEntry[] = [
    { type: 'arrival', key: 'private-arrival', at: arrived, subject: visitor, ...credit, landing, clicks: { gclid: 'private-click' }, custom: { private_field: 'private-content', language: 'private-language' } },
    { type: 'call', key: 'one', direction: 'inbound', from: '+12025550102', to: '+12025550109', duration: 70, at: AT, code: 'K7Q2MX', result: { answered: report === 'campaigns' } },
    { type: 'call_update', key: 'party', at: AT + 1, call: 'one', change: { kind: 'party', role: 'representative', subject: owner, by: 'desk' } },
  ]
  assert.ok((await graph.record({ entries })).results.every(row => row.ok))
  if (report === 'campaigns') {
    const answer = (await graph.report({ kind: report, window, by: 'touch.private_field' })).value
    const row = answer.rows.find(row => row.campaignId === credit.campaignId)!
    assert.equal(row.outcomes, 1)
    assert.equal(row.stages.call?.delay, undefined)
    assert.deepEqual(row.breakdown?.map(part => [part.name, part.outcomes]), [['(not set)', 1]])
    assert.doesNotMatch(JSON.stringify(answer), /private-content|private-language|private-visit|private-click/)
    assert.ok(!answer.dimensions.includes('touch.private_field'))
    return row.breakdown
  }
  const read = async () => report === 'callbacks' ? (await graph.report({ kind: report, window, at: NOW })).value.rows[0]! : (await graph.report({ kind: report, at: NOW, days: 3 })).value.columns[0]!.rows[0]!
  const privateRow = await read()
  assert.equal(privateRow.arrival, null)
  assert.deepEqual('campaignCredit' in privateRow ? privateRow.campaignCredit : null, credit)
  assert.doesNotMatch(JSON.stringify(privateRow), new RegExp([visitor, String(arrived), 'private-visit', 'private_field', 'private-content', 'private-language', 'private-click'].join('|')))
  if (base && report === 'pipeline') {
    const board = await fetch(base + '/review/api/board', { headers: { authorization: 'Bearer reviewer' } })
    assert.equal(board.status, 200)
    assert.doesNotMatch(await board.text(), /private-language|private-visit|private_field|private-content/)
  }
  await engine.graph.join(visitor, owner)
  assert.equal((await read()).arrival?.landing, landing)
  await engine.graph.separate(visitor, owner)
  const direct = await one(graph, { type: 'arrival', key: 'own', at: AT - 1, subject: owner, source: 'own', landing: 'https://example.org/own' })
  assert.ok(direct.ok)
  assert.equal((await read()).arrival?.landing, 'https://example.org/own')
  return credit
})

everywhere('private call campaign credit keeps the paid status of an earlier click', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const visitor = 'visitor:earlier'
  await engine.graph.observe({ subject: visitor, identifiers: [codeNote('K7Q2MX')], at: AT - 50 })
  const results = await graph.record({ entries: [
    { type: 'arrival', key: 'earlier', at: AT - 2 * 86_400_000, subject: visitor, campaign: 'Example', clicks: { gclid: 'private-click' } },
    { type: 'call', key: 'missed', direction: 'inbound', at: AT, from: '+12025550102', to: '+12025550109', code: 'K7Q2MX', result: { answered: false } },
    { type: 'call_update', key: 'party', at: AT + 1, call: 'missed', change: { kind: 'party', role: 'self', subject: 'record:owner', by: 'desk' } },
  ] })
  assert.ok(results.results.every(row => row.ok))
  const row = (await graph.report({ kind: 'campaigns', window })).value.rows.find(row => row.missed)!
  assert.deepEqual([row.source, row.campaign, row.insufficientData], ['google', 'Example', true])
  return row
})

everywhere('a keyed call party belongs to one record and survives out-of-order reports', async ({ graph }) => {
  const a = 'record:first'
  const b = 'record:second'
  const call = { type: 'call', key: 'desk-01', direction: 'inbound', from: '+12025550101', to: '+12025550102', duration: 70, at: AT, result: { answered: true } } as const
  const named = { type: 'call_update', key: 'winner', at: AT + 20, call: call.key, change: { kind: 'party', role: 'representative', subject: b, by: 'desk' } } as const
  const older = { ...named, key: 'before', change: { ...named.change, role: 'self', subject: a } } as const
  const write = async (entry: RecordEntry) => (await graph.record({ entries: [entry] })).results[0]!
  for (const change of [{ ...named.change, seen: 0 }, { ...named.change, seen: '' }, { ...named.change, seen: 'x'.repeat(201) }, { kind: 'not_returned', seen: null }]) {
    const result = await codeOf(write({ ...named, change } as RecordEntry))
    assert.deepEqual(result, { code: 'INPUT.MALFORMED', retryable: false })
  }
  const saved = await write(named)
  assert.ok(saved.ok && saved.value.stands)
  const late = await write(older)
  assert.ok(late.ok && !late.value.stands)
  const retry = await write(older)
  assert.ok(retry.ok && retry.value.duplicate && !retry.value.stands)
  assert.deepEqual(await write({ ...named, change: { ...named.change, by: 'desk2' } }), { type: 'call_update', key: 'winner', ok: false, reason: 'KEY_REUSED', fields: ['change'] })
  await write({ type: 'profile', key: 'p', at: AT - 100, subject: a, facts: { phone: call.from } })
  await write(call)
  const checked = () => graph.lookup({ kind: 'record', type: 'call', key: call.key, at: NOW })
  const kept = await checked()
  assert.ok(kept?.type === 'call')
  assert.equal(kept.subject, b)
  assert.deepEqual(kept.party, { role: 'representative', subject: b, by: 'desk', at: named.at })
  assert.deepEqual(kept.partyHistory?.map(({ key, by }) => [key, by]), [['before', 'desk'], ['winner', 'desk']])
  const journeys = async () => Promise.all([a, b].map(async (subject) => (await graph.lookup({ kind: 'journey', subject })).entries.filter((e) => e.kind === 'call' || e.kind === 'conversion').map((e) => e.kind)))
  assert.deepEqual(await journeys(), [[], ['call', 'conversion']])
  await graph.decide({ key: 'merge-records', at: AT, by: 'desk', action: 'merge', pairs: [{ a, b }] })
  assert.deepEqual(await journeys(), [[], ['call', 'conversion']])
  await graph.decide({ key: 'split-records', at: AT + 1, by: 'desk', action: 'split', pairs: [{ a, b }] })
  assert.deepEqual(await journeys(), [[], ['call', 'conversion']])
  for (const change of [{ kind: 'party', role: 'excluded', by: 'desk', subject: b }, { kind: 'party', role: 'unknown', by: 'desk' }] as const) {
    await write({ ...named, key: change.role, at: AT + (change.role === 'excluded' ? 30 : 40), change })
    assert.deepEqual(await journeys(), [[], []])
    assert.equal((await checked())?.subject, 'call:desk-01')
  }
  await write({ ...named, key: 'direct', at: AT + 50, change: { ...named.change, role: 'self', subject: a } })
  assert.deepEqual(await journeys(), [['call', 'conversion'], []])
  assert.equal((await write(call)).ok, true)
  return (await checked())?.subject
})

everywhere('forgetting a party or the original line erases call statements, including pending ones', async ({ graph, schema }) => {
  for (const side of ['pending', 'party', 'line', 'former'] as const) {
    const subject = 'record:' + side
    const call = { type: 'call', key: 'erase-' + side, at: AT, direction: 'inbound', to: '+12025550104', from: '+12025550105', duration: 60 } as const
    const assertion = { type: 'call_update', key: 'said-' + side, at: AT + 1, call: call.key, change: { kind: 'party', role: 'self', by: 'desk', subject } } as const
    let whom = subject
    if (side !== 'pending') {
      const heard = (await graph.record({ entries: [call] })).results[0]!
      assert.ok(heard.type === 'call' && heard.ok)
      if (side === 'line') whom = heard.value.subject
    }
    await graph.record({ entries: [assertion] })
    if (side === 'former') await graph.record({ entries: [{ ...assertion, key: 'now-someone-else', at: AT + 2, change: { ...assertion.change, subject: 'record:another' } }] })
    await graph.forget({ key: 'delete-' + side, by: 'desk', at: NOW, subjects: [whom], platforms: 'report' })
    const rows = (await graph.record({ entries: [call, assertion, { ...assertion, key: 'correction-' + side }] })).results
    if (side === 'former') {
      assert.ok(rows[0]?.ok && rows[0].type === 'call' && rows[0].value.duplicate && rows[0].value.subject === 'record:another')
      assert.deepEqual(rows.slice(1).map(row => !row.ok && row.reason), ['FORGOTTEN', 'FORGOTTEN'])
      const kept = await graph.lookup({ kind: 'record', type: 'call', key: call.key, at: NOW })
      assert.ok(kept?.type === 'call')
      assert.deepEqual(kept.partyHistory?.map(each => each.key), ['now-someone-else'])
      if (schema) {
        assert.deepEqual((await pool!.query(`select type from ${schema}.receipt_subject where subject = $1`, [whom])).rows, [])
        assert.deepEqual((await pool!.query(`select data from ${schema}.said where topic = 'party' and data->>'subject' = $1`, [whom])).rows, [])
        assert.deepEqual((await pool!.query(`select action from ${schema}.decision where about ? $1`, [whom])).rows, [{ action: 'forget' }])
      }
      assert.equal((await graph.lookup({ kind: 'record', type: 'conversion', key: 'call:' + call.key, at: NOW }))?.subject, 'record:another')
      continue
    }
    assert.deepEqual(rows.map((row) => !row.ok && row.reason), ['FORGOTTEN', 'FORGOTTEN', 'FORGOTTEN'])
    assert.equal(await graph.lookup({ kind: 'party', call: call.key }), null)
    assert.equal(await graph.lookup({ kind: 'record', type: 'call', key: call.key, at: NOW }), null)
    assert.equal(await graph.lookup({ kind: 'record', type: 'conversion', key: 'call:' + call.key, at: NOW }), null)
  }
})

test('a reviewer can sign who a call concerned under their own name', async () => {
  const { base, close } = await http()
  const write = async (changes: object[], token: string) => (await fetch(base + '/v1/record', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ entries: changes.map((change, n) => ({ type: 'call_update', key: 'party-' + n, at: AT, call: 'c1', change })) }),
  })).status
  const party = { kind: 'party', role: 'self', by: 'dana', subject: 'record:1' }
  try {
    assert.equal(await write([party], 'reviewer'), 200)
    assert.equal(await write([{ ...party, by: 'other' }], 'reviewer'), 403)
    assert.equal(await write([party, { kind: 'not_returned' }], 'reviewer'), 403)
    for (const change of [{ ...party, role: 'unknown' }, { ...party, by: '  ' }, { ...party, role: 'maybe' }, { ...party, subject: 'caller:line' }, { ...party, subject: undefined }]) assert.equal(await write([change], 'service'), 400)
  } finally {
    await close()
  }
})

test('a reviewer can read a pending party and see whose edit overtook theirs over HTTP', async () => {
  const { base, close } = await http()
  const post = async (name: string, body: object) => {
    const response = await fetch(base + '/v1/' + name, {
      method: 'POST', headers: { authorization: 'Bearer reviewer', 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const call = 'C17'
  const lookup = () => post('lookup', { kind: 'party', call })
  const entry = { type: 'call_update', key: 'first', call, at: AT, change: { kind: 'party', role: 'self', subject: 'record:17', by: 'dana', seen: null } }
  try {
    assert.equal(await lookup(), null)
    await post('record', { entries: [entry] })
    const current = await lookup()
    assert.deepEqual(current, { key: 'first', at: AT, role: 'self', subject: 'record:17', by: 'dana' })
    const correction = { ...entry, key: 'correction', at: AT + 1, change: { kind: 'party', role: 'unknown', by: 'dana', seen: null } }
    assert.deepEqual(await post('record', { entries: [correction] }), {
      results: [{ type: 'call_update', key: 'correction', ok: false, reason: 'STALE', decision: current.key, by: 'dana', at: AT }],
    })
    await post('record', { entries: [{ ...correction, change: { ...correction.change, seen: current.key } }] })
    assert.deepEqual(await lookup(), { key: 'correction', at: AT + 1, role: 'unknown', by: 'dana' })
    // Whom a call was not with is in no journey, and is not told a reviewer here.
    await post('record', { entries: [{ ...correction, key: 'not', at: AT + 2, change: { kind: 'party', role: 'excluded', subject: 'record:18', by: 'dana', seen: 'correction' } }] })
    assert.deepEqual(await lookup(), { key: 'not', at: AT + 2, role: 'excluded', by: 'dana' })
    const service = await fetch(base + '/v1/lookup', { method: 'POST', headers: { authorization: 'Bearer service', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'party', call }) })
    assert.equal((await service.json()).subject, 'record:18')
  } finally {
    await close()
  }
})

test('a confirmed call cannot send the line’s ad keys on a retry or a change of value', async () => {
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createEngine } = await import('../src/core/engine.ts')
  const { createSix } = await import('../src/core/six.ts')
  const { createReceipts } = await import('../src/core/receipts.ts')
  let sends = 0
  const target = { name: 'ads', restates: true, batch: 5, keys: () => ({ phone: 'phone-hash' }), click: () => undefined, retryable: () => false, deliver: async () => ({ requestId: String(++sends) }) }
  const engine = createEngine(createMemoryStore(), { stages: { call: { value: 12, action: { ads: 'Call' } } }, delivery: { targets: [target] }, now: () => NOW })
  const six = createSix(engine, { receipts: createReceipts([SECRET]) })
  const call = { type: 'call', direction: 'inbound', key: 'sale-call', at: AT, to: '+12025550104', from: '+12025550105', duration: 60 } as const
  const who = { type: 'call_update', key: 'identify-call', at: NOW, call: call.key, change: { kind: 'party', role: 'self', subject: 'record:j', by: 'desk' } } as const
  const id = 'call:' + call.key
  await six.record({ entries: [call] })
  assert.equal((await engine.outbox!.get(id))[0]?.state, 'pending')
  await six.record({ entries: [who, { type: 'restatement', key: 'new-worth', at: NOW, of: { type: 'call', key: call.key }, change: { kind: 'correct', value: 25 } }] })
  await engine.outbox!.retry(id, 'ads')
  await engine.outbox!.run()
  assert.equal(sends, 0)
  const [job] = await engine.outbox!.get(id)
  assert.deepEqual([job?.subject, job?.state, job?.keys], [who.change.subject, 'skipped', {}])
  assert.equal((await engine.graph.outcomeOf(id))?.value, 25)
  const next = { ...call, key: 'after-confirmation' }
  await six.record({ entries: [{ ...who, call: next.key, key: 'identify-next' }, next] })
  assert.equal((await engine.graph.outcomeOf('call:' + next.key))?.value, 12)
  assert.deepEqual(await engine.outbox!.get('call:' + next.key), [])
})

test('delivery failure batches keep the ten-minute alert interval and reopen it after a failed post', async () => {
  let now = NOW
  let status = 200
  const posts: string[] = []
  const local = accountGraph({ memory: true, now: () => now, ads: { meta: { pixelId: 'test', accessToken: 'test', siteUrl: 'https://example.org' } },
    alerts: { url: 'https://example.org/alerts' },
    fetch: async (_url, init) => {
      posts.push(String(init?.body))
      return new Response(null, { status })
    },
  })
  try {
    const { engine } = await internalsOf(local)!()
    for (const [i, minutes] of [0, 5, 10, 20, 20].entries()) {
      now = NOW + minutes * 60_000
      status = i === 3 ? 503 : 200
      await engine.store.outbox.add({ transactionId: `sale-${i}`, at: AT, due: AT, subject: 'record:a', target: 'missing', action: 'test', state: 'pending', attempts: 0, keys: {} })
      await engine.outbox!.run()
      await engine.store.write(async () => {})
    }
    assert.deepEqual(posts.map(text => text.match(/sale-\d+/)?.[0]), ['sale-0', 'sale-2', 'sale-3', 'sale-4'])
    assert.equal((await engine.store.read(tx => tx.eventsAfter(0, 20))).filter(event => event.type === 'conversion.failed').length, 5)
  } finally {
    await local.close()
  }
})

test('a failed conversion corrected before the worker reports it creates no alert or event', async () => {
  const posted: string[] = []
  const local = accountGraph({ memory: true, now: () => NOW, ads: { meta: { pixelId: 'test', accessToken: 'test', siteUrl: 'https://example.org' } },
    alerts: { url: 'https://example.org/alerts' },
    fetch: async (_url, init) => {
      posted.push(String(init?.body))
      return new Response(null, { status: 200 })
    },
  })
  try {
    const { engine } = await internalsOf(local)!()
    await engine.graph.keepCall({ id: 'late', subject: 'caller:line', direction: 'inbound', at: AT, to: '+12025550101', flags: [] })
    const queue = engine.store.outbox
    for (const id of ['late', 'other']) await queue.add({ transactionId: `call:${id}`, subject: 'caller:line', at: AT, due: AT, target: 'missing', action: 'test', state: 'pending', attempts: 0, keys: {} })
    // Ownership changes after the failure was stored and before the batch announces it.
    const swap = queue.swap.bind(queue)
    queue.swap = async (before, after) => {
      const wrote = await swap(before, after)
      if (wrote && after.state === 'failed' && after.transactionId === 'call:late') await engine.graph.sayParty({ call: 'late', key: 'confirmed', at: NOW, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      return wrote
    }
    assert.equal((await engine.outbox!.run()).failed, 2)
    await engine.store.write(async () => {})
    assert.equal(posted.length, 1)
    assert.ok(posted[0]!.includes('call:other'))
    assert.ok(!posted[0]!.includes('call:late'))
    const failed = (await engine.store.read(tx => tx.eventsAfter(0, 20))).filter(event => event.type === 'conversion.failed')
    assert.deepEqual(failed.map(event => event.data.conversion), ['call:other'])
  } finally {
    await local.close()
  }
})

test('the reviewer journey reads its delivery details at the same time as the call', async () => {
  const { local, base, close } = await http({ ads: { meta: { pixelId: 'test', accessToken: 'test', siteUrl: 'https://example.org' } } })
  try {
    const { engine } = await internalsOf(local)!()
    const { graph, store } = engine
    await graph.keepCall({ id: 'one', direction: 'inbound', subject: 'caller:line', to: '+12025550101', at: AT, flags: [] })
    await graph.outcome({ transactionId: 'call:one', subject: 'caller:line', at: AT })
    await store.outbox.add({ transactionId: 'call:one', target: 'test', action: 'sale', subject: 'caller:line', state: 'pending', attempts: 0, at: AT, due: NOW, keys: {} })
    const read = store.read.bind(store)
    let corrected = false
    store.read = async work => {
      const value = await read(work)
      if (!corrected && value && typeof value === 'object' && 'entries' in value && 'subjects' in value) {
        corrected = true
        await graph.sayParty({ call: 'one', key: 'signed', at: NOW, party: { role: 'self', subject: 'record:b', by: 'desk' } })
      }
      return value
    }
    const journey = async (subject: string) => {
      const response = await fetch(`${base}/review/api/journey?subject=${subject}`, { headers: { authorization: 'Bearer reviewer' } })
      assert.equal(response.status, 200)
      return await response.json() as { entries: { kind: string; sent?: { note?: string; state: string }[] }[] }
    }
    const before = await journey('caller:line')
    assert.ok(corrected)
    assert.deepEqual(before.entries.find(entry => entry.kind === 'outcome')?.sent?.map(job => job.state), ['pending'])
    assert.ok(!(await journey('caller:line')).entries.some(entry => entry.kind === 'call' || entry.kind === 'outcome'))
    assert.deepEqual((await journey('record:b')).entries.find(entry => entry.kind === 'outcome')?.sent?.map(job => job.note), ['call_party'])
  } finally {
    await close()
  }
})

test('call and journey lookups read a correction and its delivery details at one point in time', async () => {
  const local = accountGraph({ memory: true, now: () => NOW, ads: { meta: { pixelId: 'test', accessToken: 'test', siteUrl: 'https://example.org' } } })
  try {
    const { engine } = await internalsOf(local)!()
    const { graph, store } = engine
    await graph.keepCall({ id: 'one', direction: 'inbound', subject: 'caller:line', to: '+12025550101', at: AT, flags: [] })
    await graph.outcome({ transactionId: 'call:one', subject: 'caller:line', at: AT })
    await store.outbox.add({ transactionId: 'call:one', target: 'test', action: 'sale', subject: 'caller:line', state: 'pending', attempts: 0, keys: {}, at: AT, due: NOW })
    const read = store.read.bind(store)
    let correction: string | undefined = 'record:a'
    store.read = async work => {
      const value = await read(work)
      if (correction && !(value instanceof Map)) {
        const subject = correction
        correction = undefined
        await graph.sayParty({ call: 'one', key: subject, at: subject === 'record:a' ? AT : NOW, party: { role: 'self', subject, by: 'desk' } })
      }
      return value
    }
    const journey = await local.lookup({ kind: 'journey', subject: 'caller:line' })
    const conversion = journey.entries.find(row => row.kind === 'conversion')
    correction = 'record:b'
    const call = await local.lookup({ kind: 'record', type: 'call', key: 'one', at: NOW })
    assert.ok(call?.type === 'call')
    const latest = call.partyHistory?.at(-1)
    assert.equal(correction, undefined)
    assert.deepEqual([!conversion || conversion.deliveries.every(job => job.note !== 'call_party'), latest && latest.role !== 'unknown' && call.subject === latest.subject], [true, true])
  } finally {
    await local.close()
  }
})

test('caller and person lookups agree on what was still known of a confirmed call', async () => {
  const from = '+12025550102'
  const to = '+12025550101'
  const coherent: boolean[] = []
  for (const kind of ['caller', 'person'] as const) {
    const local = accountGraph({ memory: true, now: () => NOW, phones: { numbers: { [to]: { source: 'directory' } } } })
    try {
      const { engine } = await internalsOf(local)!()
      const { graph, store } = engine
      const [call] = (await local.record({ entries: [{ type: 'call', key: 'one', at: AT, direction: 'inbound', from, to, result: { answered: false } }] })).results
      assert.ok(call?.ok && call.type === 'call')
      const subject = call.value.subject
      const ask = async () => kind === 'caller' ? local.lookup({ kind, from, to, at: NOW }) : (await local.lookup({ kind, subjects: [subject], at: NOW })).people[0]!
      const before = await ask()
      assert.deepEqual([before.known, before.arrival?.source], [true, 'directory'])
      const read = store.read.bind(store)
      let corrected = false
      store.read = async work => {
        const value = await read(work)
        const hasCall = Array.isArray(value) && value.some(row => row?.id === 'one' || row?.touch?.source === 'directory')
        if (!corrected && (hasCall || (value && typeof value === 'object' && ('waiting' in value || 'people' in value)))) {
          corrected = true
          await graph.sayParty({ call: 'one', key: 'who', at: NOW, party: { role: 'self', subject: 'record:a', by: 'desk' } })
        }
        return value
      }
      const person = await ask()
      assert.equal(corrected, true)
      coherent.push(person.known === (person.arrival?.source === 'directory'))
      const after = await ask()
      assert.deepEqual([after.known, after.arrival], [false, null])
    } finally {
      await local.close()
    }
  }
  assert.deepEqual(coherent, [true, true])
})

test('a cached report loses a forgotten conversion during its last check and across instances', async () => {
  const { createEngine } = await import('../src/core/engine.ts')
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createSix } = await import('../src/core/six.ts')
  const { createReceipts } = await import('../src/core/receipts.ts')
  const coherent: boolean[] = []
  for (const other of [false, true]) {
    let at = NOW
    const store = createMemoryStore()
    const engine = createEngine(store, { now: () => at })
    const options = { receipts: createReceipts([SECRET]) }
    const reader = createSix(engine, options)
    const writer = other ? createSix(createEngine(store, { now: () => at }), options) : reader
    const run = engine.graph.report
    engine.graph.report = async request => {
      at += 500
      return run(request)
    }
    const ask = async () => (await reader.report({ kind: 'campaigns', window })).value
    const erase = async () => assert.ok((await writer.forget({ key: 'gone', at, by: 'desk', subjects: ['record:a'], platforms: 'report' })).ok)
    await writer.record({ entries: [{ type: 'conversion', key: 'one', at: AT, subject: 'record:a', stage: 'intake', value: 17, currency: 'USD' }] })
    const before = await ask()
    if (other) await erase()
    else {
      const read = engine.graph.partyRevision
      let reads = 0
      engine.graph.partyRevision = async () => {
        const revision = await read()
        if (++reads === 2) await erase()
        return revision
      }
    }
    const during = await ask()
    at += 60_001
    const after = await ask()
    assert.notDeepEqual(before, after)
    coherent.push(JSON.stringify(during) === JSON.stringify(after))
  }
  assert.deepEqual(coherent, [true, true])
})

test('a call party written by another instance ends a cached report during its grace', async () => {
  const { createEngine } = await import('../src/core/engine.ts')
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createSix } = await import('../src/core/six.ts')
  const { createReceipts } = await import('../src/core/receipts.ts')
  let time = NOW
  const store = createMemoryStore()
  const engine = createEngine(store, { now: () => time })
  const options = { receipts: createReceipts([SECRET]) }
  const reader = createSix(engine, options)
  const writer = createSix(createEngine(store, { now: () => time }), options)
  let runs = 0
  const report = engine.graph.report
  engine.graph.report = async (...args) => {
    runs++
    time += 500
    return report(...args)
  }
  const ask = () => reader.report({ kind: 'campaigns', window })
  await writer.record({ entries: [{ type: 'call', key: 'line', at: AT, direction: 'inbound', to: '+12025550101', from: '+12025550102', duration: 70 }] })
  await ask()
  await ask()
  assert.equal(runs, 1)
  await writer.record({ entries: [{ type: 'call_update', key: 'signed', at: NOW, call: 'line', change: { kind: 'party', role: 'self', by: 'desk', subject: 'record:1' } }] })
  await ask()
  assert.equal(runs, 2)
})

test('a forgotten profile never sends its phone or address to a check on retry', async () => {
  const { createEngine } = await import('../src/core/engine.ts')
  const { createMemoryStore } = await import('../src/core/memory.ts')
  const { createSix } = await import('../src/core/six.ts')
  const { createReceipts } = await import('../src/core/receipts.ts')
  const checks = { phone: 0, postal: 0 }
  const engine = createEngine(createMemoryStore(), {
    lineType: async () => {
      checks.phone++
      return { type: 'mobile', carrier: undefined }
    },
    address: async () => {
      checks.postal++
      return undefined
    },
  })
  const six = createSix(engine, { receipts: createReceipts([SECRET]) })
  const fact = { type: 'profile', key: 'checked', subject: 'record:gone', at: AT, facts: { email: 'desk@example.org', phone: '202-555-0100', address: { street: '1 Example St' } } } as const
  assert.ok((await six.record({ entries: [fact] })).results[0]!.ok)
  assert.ok((await six.forget({ key: 'erase', at: NOW, by: 'desk', subjects: [fact.subject], platforms: 'report' })).ok)
  assert.deepEqual(checks, { phone: 1, postal: 1 })
  const retry = (await six.record({ entries: [fact] })).results[0]!
  assert.ok(!retry.ok && retry.reason === 'FORGOTTEN')
  assert.deepEqual(checks, { phone: 1, postal: 1 })
})

everywhere('a duplicate result or callback says whether that statement still stands', async ({ graph }) => {
  for (const kind of ['result', 'not_returned'] as const) {
    const change = kind === 'result' ? { kind, result: { answered: false } } as const : { kind } as const
    const old = { type: 'call_update', call: 'late-call', at: AT, key: kind + '-a', change } as const
    const newest: RecordEntry = { ...old, key: kind + '-b', change: kind === 'result' ? { kind, result: { answered: true } } : { kind: 'returned', reachedAt: AT } } as const
    const got = (await graph.record({ entries: [newest, old, old, newest] })).results
    assert.deepEqual(got.map((row) => row.ok && [row.value.duplicate, row.value.stands]), [[false, true], [false, false], [true, false], [true, true]])
  }
  await one(graph, { type: 'call', direction: 'outbound', at: AT, key: 'placed', from: '+12025550103', to: '+12025550104' })
  const entry = { type: 'call_update', key: 'did-return', at: NOW, call: 'placed', change: { kind: 'returned', reachedAt: NOW } } as const
  const got = (await graph.record({ entries: [entry, entry] })).results
  assert.deepEqual(got.map((row) => row.ok && row.value.stands), [false, false])
})

everywhere('a text retry can add an opt-out once and keeps the original message time', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const entry = { type: 'text', key: 'message', at: AT, direction: 'inbound', from: '+12025550121', to: '+12025550122' } as const
  const stop = { ...entry, at: NOW, text: 'STOP.' }
  const begin = { ...entry, at: AT + 1, text: 'START' }
  const original = await one(graph, entry)
  assert.ok(original.ok && original.type === 'text' && original.value.counted)
  const subject = original.value.subject
  const seen = await engine.graph.history(subject)
  for (const change of [{ from: '+12025550123' }, { to: '+12025550124' }, { direction: 'outbound' as const }]) {
    const wrong = await one(graph, { ...stop, ...change })
    assert.ok(!wrong.ok && wrong.reason === 'KEY_REUSED', JSON.stringify(wrong))
  }
  assert.equal(await engine.graph.texting(subject), undefined)
  const results = await Promise.all([one(graph, stop), one(graph, stop)])
  assert.deepEqual(results.map(row => row.ok && row.type === 'text' && [row.value.duplicate, row.value.flags, row.value.counted]), [[true, ['opt_out'], false], [true, ['opt_out'], false]])
  assert.equal(results.filter(row => row.ok && row.type === 'text' && row.value.optOutAdded).length, 1)
  assert.deepEqual(await engine.graph.texting(subject), { optedOut: true, at: AT })
  assert.equal(await engine.graph.outcomeOf('text:' + entry.key), undefined)
  assert.deepEqual(await engine.graph.history(subject), seen)
  assert.ok((await one(graph, begin)).ok)
  assert.deepEqual(await engine.graph.texting(subject), { optedOut: true, at: AT })

  // A STOP learned after a newer START keeps the time of the original text.
  const batch = [{ ...entry, key: 'earlier', at: AT + 2 }, { ...begin, key: 'later', at: AT + 3 }, { ...stop, key: 'earlier' }, { ...stop, key: 'earlier' }]
  const { results: rows } = await graph.record({ entries: batch })
  assert.deepEqual(rows.map(row => row.ok && row.type === 'text' && [row.value.flags, row.value.optOutAdded ?? false]), [[[], false], [['opt_in'], false], [['opt_out'], true], [['opt_out'], false]])
  assert.deepEqual(await engine.graph.texting(subject), { optedOut: false, at: AT + 3 })
  assert.ok((await graph.forget({ key: 'erase', at: NOW, by: 'desk', subjects: [subject], platforms: 'report' })).ok)
  const gone = await one(graph, stop)
  assert.ok(!gone.ok && gone.reason === 'FORGOTTEN')
  assert.deepEqual(await engine.graph.textsOf([subject]), [])
})

for (const [name, open] of Object.entries({ memory, ...(url && { postgres }) })) test(`one text arriving through record and Twilio together writes its tie and sightings once, ${name}`, async () => {
  const { twilioSignature } = await import('../src/providers/twilio.ts')
  const { graph, close } = await open()
  const { engine } = await internalsOf(graph)!()
  const address = 'https://example.org/texts/twilio'
  const server = createServer(createEdge(graph, { token: 'service', origins: [], twilio: { authToken: 'secret', texts: address } })).listen(0, '127.0.0.1')
  try {
    await new Promise((resolve) => server.once('listening', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const code = 'K7Q2MX'
    const visitor = 'visitor:site'
    await engine.graph.observe({ subject: visitor, identifiers: ['device:site', codeNote(code)], at: AT, event: 'text_code' })
    const fields = { MessageSid: 'same-message', From: '+12025550105', To: '+12025550106', Body: 'Ref ' + code }
    const entry = { type: 'text', key: fields.MessageSid, at: NOW, direction: 'inbound', from: fields.From, to: fields.To, text: fields.Body } as const
    const [received, reported] = await Promise.all([
      fetch(base + '/texts/twilio', { method: 'POST', headers: { 'x-twilio-signature': twilioSignature('secret', address, fields) }, body: new URLSearchParams(fields) }),
      fetch(base + '/v1/record', { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ entries: [entry] }) }),
    ])
    assert.deepEqual([received.status, reported.status], [200, 200])
    assert.equal((await reported.json() as { results: RecordResult[] }).results[0]!.ok, true)
    const saved = await engine.graph.keptText(entry.key)
    assert.equal(saved?.visitor, visitor)
    assert.equal((await engine.graph.textsOf([saved!.subject])).length, 1)
    assert.equal((await engine.graph.outcomeOf('text:' + entry.key))?.subject, saved!.subject)
    assert.deepEqual((await engine.graph.holders(['text:' + entry.key])).map((edge) => edge.count), [1, 1])
    const seen = [...await engine.graph.history(visitor), ...await engine.graph.history(saved!.subject)]
    assert.equal(seen.length, 5)
    assert.equal(seen.filter((row) => row.identifier.startsWith('phone:')).length, 1)

    const bodyless = { MessageSid: 'body-later', From: '+12025550127', To: '+12025550126' }
    const callback = (form: Record<string, string>) => fetch(base + '/texts/twilio', { method: 'POST', headers: { 'x-twilio-signature': twilioSignature('secret', address, form) }, body: new URLSearchParams(form) })
    assert.equal((await callback(bodyless)).status, 200)
    assert.ok(await engine.graph.outcomeOf('text:' + bodyless.MessageSid))
    const stop = { ...bodyless, Body: 'ALTO' }
    for (const response of await Promise.all([callback(stop), callback(stop)])) {
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '<Response/>')
    }
    const stopped = await engine.graph.keptText(stop.MessageSid)
    assert.deepEqual(stopped?.flags, ['opt_out'])
    assert.equal(await engine.graph.outcomeOf('text:' + stop.MessageSid), undefined)
    assert.ok((await graph.forget({ key: 'erase-stop', at: NOW, by: 'desk', subjects: [stopped!.subject], platforms: 'report' })).ok)
    assert.equal((await callback(stop)).status, 200)
    assert.equal(await engine.graph.keptText(stop.MessageSid), undefined)
  } finally {
    server.closeAllConnections()
    server.close()
    await close()
  }
})
