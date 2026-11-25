import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import pg from 'pg'
import { internalsOf } from '../src/client/internals.ts'
import { createEdge } from '../src/edge/index.ts'
import { FAULT_CODES, accountGraph, hasCode, isFault } from '../src/index.ts'
import type { AccountGraph, DecideRequest, LocalOptions, RecordEntry, RecordResult } from '../src/index.ts'
import { accountGraph as remoteOnly } from '../src/remote.ts'
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

const one = async (graph: AccountGraph, entry: RecordEntry): Promise<RecordResult> => (await graph.record({ entries: [entry] })).results[0]!
const codeOf = (work: Promise<unknown>) => work.then((value) => ({ value }), (error) => (isFault(error) ? { code: error.code, retryable: error.retryable } : { raw: String(error) }))

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

everywhere('two that come at once are one', async ({ graph }) => {
  for (const entry of EVERY) {
    const results = await Promise.all([one(graph, entry), one(graph, entry), one(graph, entry)])
    assert.deepEqual(results.map((result) => result.ok && result.value.duplicate).sort(), [false, true, true], entry.type)
  }
  return (await graph.report({ kind: 'campaigns', window })).value.total.visits
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
  const down = accountGraph({ databaseUrl: 'postgres://nobody@127.0.0.1:1/x', workers: false, receiptSecrets: [SECRET], timeoutMs: 2000 })
  assert.deepEqual(await codeOf(down.lookup({ kind: 'find', text: 'x' })), { code: FAULT_CODES.GRAPH.UNAVAILABLE, retryable: true })
  await down.close()
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
    const entry = (key: string): RecordEntry => ({ type: 'profile', key, at: AT, subject: 'contact:1', facts: { email: 'a@example.com' } })
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
