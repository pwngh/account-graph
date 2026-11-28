import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pageServer } from './page-server.suite.ts'
import { gtmCollector } from './gtm-collector.suite.ts'
import { leadForgotten, leadGuesses, leadOversize, leadPayments, leadSpellings, leadTimes, leadUpdates, leadRoutes, leadSources, leadSubjects } from './leads.suite.ts'
import { leadSettings } from './lead-settings.suite.ts'
import { after, test } from 'node:test'
import pg from 'pg'
import { internalsOf } from '../src/client/internals.ts'
import { hashPhone } from '../src/core/identifiers.ts'
import type { createMemoryStore } from '../src/core/memory.ts'
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
  test(`a Tag Manager script controls storage, forms and page events on its own graph, ${kind}`, async () => {
    const opened = await open()
    try {
      await gtmCollector(opened.local)
      } finally {
        await opened.close()
      }
    })

  test(`lead webhooks authenticate, map and record through receipts, ${kind}`, async t => {
    const clock = { at: NOW }
    const opened = await open({ leads: leadSources, now: () => clock.at, policy: { apart: ['given'] } })
    const dump = async () => {
      if (!opened.schema) {
        const { engine } = await internalsOf(opened.local)!()
        const store = engine.store as ReturnType<typeof createMemoryStore>
        return JSON.stringify(store.snapshot(), (_, value) => value instanceof Map || value instanceof Set ? [...value] : value)
      }
      const tables = await pool!.query("select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE'", [opened.schema])
      const rows = await Promise.all(tables.rows.map(({ table_name }) => pool!.query(`select to_jsonb(r) as row from ${opened.schema}.${table_name} r`)))
      return JSON.stringify(rows.map(result => result.rows))
    }
    try {
      await leadSettings(opened.local)
      await leadRoutes(t, opened.local, clock, dump)
    } finally {
      await opened.close()
    }
  })

  test(`lead sources keep to their own records, ${kind}`, async () => {
    const clock = { at: NOW }
    const opened = await open({ now: () => clock.at })
    try {
      await leadSubjects(opened.local, AT)
      await leadOversize(opened.local)
      await leadGuesses(opened.local, clock)
      await leadTimes(opened.local, clock)
      await leadSpellings(opened.local)
      await leadUpdates(opened.local, clock)
      await leadPayments(opened.local, AT)
      await leadForgotten(opened.local, clock)
    } finally {
      await opened.close()
    }
  })

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

everywhere('a profile with an IP that is not an address is refused and leaves nothing behind', async ({ graph }) => {
  const profile = (ip: string, key: string): RecordEntry => ({ type: 'profile', key, at: AT, subject: 'contact:ip', facts: { ip, email: 'ip@example.org' }, event: 'form' } as RecordEntry)
  const bad = await codeOf(graph.record({ entries: [profile('not-an-ip', 'ip-bad')] }))
  const good = await one(graph, profile('203.0.113.9', 'ip-bad'))
  assert.deepEqual([bad, good.ok], [{ code: 'INPUT.MALFORMED', retryable: false }, true])
  return [bad, good.ok]
})

everywhere('a record keeps its name, a number and an email are kept beside their hashes, and a forgotten person keeps nothing', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const caller = `caller:${hashPhone('+15558675301')}`
  const profile = (key: string, at: number, subject: string, facts: object) => ({ type: 'profile', key, at, subject, facts })
  const sent = await graph.record({ entries: [
    profile('one', AT, 'contact:one', { name: { first: ' Casey ', last: 'Known' }, phone: '(555) 867-5301', email: ' Casey@Example.org ', dob: '1990-02-03', address: { street: ' 12  Main St\u202e ', city: 'Springfield', state: 'IL', zipcode: '62701' } }),
    profile('two', AT, 'contact:two', { email: 'two@example.org' }),
    { type: 'call', key: 'C1', at: AT, direction: 'inbound', from: '5558675301', to: '5551230001', result: { answered: false } },
    // A withheld number is reported as the word anonymous on a keypad. It is nobody's number.
    { type: 'call', key: 'C2', at: AT, direction: 'inbound', from: '+266696687', to: '5551230001', result: { answered: false } },
    { type: 'text', key: 'T1', at: AT, direction: 'inbound', from: '+15558675309', to: '5551230001', text: 'hello' },
  ] as any })
  assert.deepEqual(sent.results.map((each) => each.ok), [true, true, true, true, true])
  const texter = `caller:${hashPhone('+15558675309')}`
  const asked = ['contact:one', 'contact:two', caller, texter, 'call:C2', 'contact:nobody']
  const first = await engine.graph.called(asked)
  assert.deepEqual(first['contact:one'], { name: 'Casey Known', phone: '+15558675301', email: 'casey@example.org' })
  assert.deepEqual(first['contact:two'], { email: 'two@example.org' })
  assert.deepEqual(first[texter], { phone: '+15558675309' })
  assert.equal(first[caller]!.phone, '+15558675301')
  assert.deepEqual([first['call:C2'], first['contact:nobody']], [undefined, undefined])
  // A person is found by any part of their name, whatever the case. An ID that begins like the text comes first.
  const found = [await graph.lookup({ kind: 'find', text: 'casey kn' }), await graph.lookup({ kind: 'find', text: 'NOWN' }), await graph.lookup({ kind: 'find', text: 'contact:o' }), await graph.lookup({ kind: 'find', text: 'nobody of that name' })]
  assert.deepEqual(found, [{ by: 'name', subjects: ['contact:one'] }, { by: 'name', subjects: ['contact:one'] }, { by: 'subject', subjects: ['contact:one'] }, { by: 'subject', subjects: [] }])
  // Joined to a record of yours, the caller is called by that record's name, and says which record it is.
  await graph.decide({ key: 'join', at: AT + 1, by: 'dana', action: 'merge', pairs: [{ a: caller, b: 'contact:one' }] })
  const joined = await engine.graph.called([caller])
  assert.deepEqual(joined[caller], { name: 'Casey Known', phone: '+15558675301', email: 'casey@example.org', record: 'contact:one' })
  // Of each value the newest statement stands, whichever arrives first. A later profile with only a phone leaves the name.
  await graph.record({ entries: [profile('older', AT - 1000, 'contact:one', { name: { first: 'Old', last: 'Name' }, email: 'old@example.org' }), profile('newer', AT + 1000, 'contact:one', { phone: '555-867-5302' })] as any })
  const later = await engine.graph.called(['contact:one'])
  assert.deepEqual(later['contact:one'], { name: 'Casey Known', phone: '+15558675302', email: 'casey@example.org' })
  // An account page asks for every number and email of the person, the newest first, each once, the joined caller's among them.
  const every = await engine.graph.called(['contact:one'], true)
  assert.deepEqual([every['contact:one']!.phones, every['contact:one']!.emails], [['+15558675302', '+15558675301'], ['casey@example.org', 'old@example.org']])
  // A date of birth and an address are kept as written, for the account page alone. No list names anybody by them.
  assert.deepEqual([every['contact:one']!.dob, every['contact:one']!.address, 'dob' in later['contact:one']!, 'address' in later['contact:one']!], ['1990-02-03', '12 Main St, Springfield, IL 62701', false, false])
  // Forgotten, a record keeps nothing, and the caller that was joined to it is called by its own number again.
  await graph.forget({ key: 'forget-one', at: AT + 2000, by: 'dana', subjects: ['contact:one'], platforms: 'report' })
  const after = await engine.graph.called(asked)
  assert.equal(after['contact:one'], undefined)
  assert.deepEqual(await graph.lookup({ kind: 'find', text: 'casey' }), { by: 'subject', subjects: [] })
  assert.deepEqual(after[caller], { phone: '+15558675301' })
  assert.deepEqual(await engine.graph.called(['contact:one'], true), {})
  await graph.forget({ key: 'forget-caller', at: AT + 3000, by: 'dana', subjects: [caller], platforms: 'report' })
  assert.equal((await engine.graph.called([caller]))[caller], undefined)
  // The number went with its last holder. A record that later holds the same hash, sent already hashed, is not shown it.
  const hashed = await graph.record({ entries: [profile('three', AT + 4000, 'contact:three', { identifiers: [`phone:${hashPhone('+15558675301')}`] })] as any })
  assert.deepEqual(hashed.results.map((each) => each.ok), [true])
  // Nor does a call you place to that number make it readable on a record that never gave it.
  const placed = await graph.record({ entries: [{ type: 'call', key: 'C3', at: AT + 5000, direction: 'outbound', from: '5551230001', to: '5558675301', result: { answered: true } }] as any })
  assert.deepEqual(placed.results.map((each) => each.ok), [true])
  const again = await engine.graph.called(['contact:three', '__proto__'])
  assert.deepEqual(again, {})
  return [first, found, joined, later, every, after, again]
})

everywhere('a name is always hashed, as a note that links nobody, whatever the policy does with names', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const profile = (key: string, subject: string, facts: object) => ({ type: 'profile', key, at: AT, subject, facts })
  const sent = await graph.record({ entries: [
    profile('one', 'contact:one', { email: 'one@example.org', name: { first: 'María', last: 'García' } }),
    profile('two', 'contact:two', { email: 'two@example.org', name: { first: 'MARIA', last: 'garcia' } }),
    profile('three', 'contact:three', { email: 'three@example.org', name: { first: 'Unknown', last: 'Unknown' } }),
    // A name alone is taken, and kept, and is nobody's.
    profile('four', 'contact:four', { name: { first: 'Maria', last: 'Garcia' } }),
    profile('five', 'contact:five', { email: 'five@example.org' }),
  ] as any })
  assert.deepEqual(sent.results.map((each) => each.ok), [true, true, true, true, true])
  // No setting may make the note count for anything.
  for (const called of [{ cap: 2 }, { relates: true }, { corroborates: true }, { group: 'name' }, { weight: 0.5 }]) assert.throws(() => accountGraph({ memory: true, policy: { kinds: { called } } } as any), (error) => hasCode(error, FAULT_CODES.CONFIG.INVALID), JSON.stringify(called))
  const noted = async (subject: string) => (await engine.graph.history(subject)).map((seen: { identifier: string }) => seen.identifier).filter((id: string) => id.startsWith('called:'))
  const notes = await Promise.all(['contact:one', 'contact:two', 'contact:three', 'contact:four', 'contact:five'].map(noted))
  // One key for one name, however it was written, and none for something written in place of a name or for no name.
  assert.deepEqual(notes.map((each) => each.length), [1, 1, 0, 1, 0])
  assert.deepEqual(new Set([...notes[0]!, ...notes[1]!, ...notes[3]!]).size, 1)
  assert.match(notes[0]![0]!, /^called:[0-9a-f]{64}$/)
  // Three records of one name are three people until something else says otherwise.
  const groups = await Promise.all(['contact:one', 'contact:two', 'contact:four'].map(async (subject) => (await engine.graph.cluster(subject))?.members ?? [subject]))
  assert.deepEqual(groups, [['contact:one'], ['contact:two'], ['contact:four']])
  assert.deepEqual((await engine.graph.links('contact:one')).length, 0)
  // Nobody may write the kind themselves.
  const own = (await graph.record({ entries: [profile('six', 'contact:six', { identifiers: ['called:' + 'a'.repeat(64)] })] as any })).results[0]!
  assert.deepEqual([own.ok, !own.ok && own.reason], [false, 'KIND_RESERVED'])
  assert.deepEqual((await engine.graph.called(['contact:four']))['contact:four'], { name: 'Maria Garcia' })
  return [notes.map((each) => each.length), groups]
})

everywhere('what somebody wrote is kept as a copy to read back, cut where it is long, and goes with the person or with time', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const caller = `caller:${hashPhone('+15558675301')}`
  const lead = { type: 'profile', key: 'lead-1', at: AT, subject: 'contact:one', facts: { phone: '5558675301' }, message: '  I need a quote for a fence.  ' }
  const sent = await graph.record({ entries: [
    lead,
    { type: 'profile', key: 'lead-2', at: AT + 1, subject: 'contact:two', facts: { email: 'two@example.org' }, message: 'x'.repeat(4100) },
    { type: 'profile', key: 'lead-3', at: AT + 1, subject: 'contact:three', facts: { email: 'three@example.org' } },
    { type: 'text', key: 'T1', at: AT + 2, direction: 'inbound', from: '+15558675301', to: '5551230001', text: 'Are you open Saturday?' },
    // What you wrote to them is yours already, and is not kept.
    { type: 'text', key: 'T2', at: AT + 3, direction: 'outbound', from: '5551230001', to: '+15558675301', text: 'Yes, 9 to 1.' },
  ] as any })
  assert.deepEqual(sent.results.map((each) => each.ok), [true, true, true, true, true])
  const wrote = async (subject: string) => (await graph.lookup({ kind: 'messages', subject })).messages
  await graph.decide({ key: 'join', at: AT + 4, by: 'dana', action: 'merge', pairs: [{ a: caller, b: 'contact:one' }] })
  // A person's form message and the texts of the caller joined to them, the newest first.
  const first = await wrote('contact:one')
  assert.deepEqual(first, [
    { from: 'text', id: 'T1', subject: caller, at: AT + 2, text: 'Are you open Saturday?', cut: false },
    { from: 'lead', id: 'lead-1', subject: 'contact:one', at: AT, text: 'I need a quote for a fence.', cut: false },
  ])
  const long = await wrote('contact:two')
  assert.deepEqual([long.length, long[0]!.text.length, long[0]!.cut], [1, 4000, true])
  assert.deepEqual(await wrote('contact:three'), [])
  // The words are no part of what makes an entry the same one, so no mark of them is kept with its receipt. Sent again with other words,
  // the entry is a duplicate and the first words stand. So do a text's.
  const again = (await graph.record({ entries: [{ ...lead, message: 'Something else.' }, { type: 'text', key: 'T1', at: AT + 2, direction: 'inbound', from: '+15558675301', to: '5551230001', text: 'Other words.' }] as any })).results
  assert.deepEqual(again.map((each) => each.ok && each.value.duplicate), [true, true])
  assert.deepEqual(await wrote('contact:one'), first)
  // Where one person spoke for another, the words are theirs too, and go when the record of either is forgotten.
  const spoke = await graph.record({ entries: [
    { type: 'profile', key: 'lead-4', at: AT + 1, subject: 'contact:child', facts: { email: 'child@example.org' }, speaker: { phone: '5558675311' }, message: 'My son needs an appointment.' },
  ] as any })
  assert.deepEqual(spoke.results.map((each) => each.ok), [true])
  assert.deepEqual((await wrote('contact:child')).map((kept) => kept.text), ['My son needs an appointment.'])
  await graph.forget({ key: 'forget-parent', at: AT + 5, by: 'dana', subjects: [`caller:${hashPhone('+15558675311')}`], platforms: 'report' })
  assert.deepEqual(await wrote('contact:child'), [])
  // Nothing of it reaches what matching reads, or the events.
  assert.ok(!JSON.stringify([await engine.graph.history('contact:one'), await graph.events({ after: null, limit: 500 })]).includes('fence'))
  // Forgotten, a person's words go with them. The caller's stay with the caller.
  await graph.forget({ key: 'forget-one', at: AT + 5, by: 'dana', subjects: ['contact:one'], platforms: 'report' })
  const after = [await wrote('contact:one'), await wrote(caller)]
  assert.deepEqual(after.map((each) => each.map((kept) => kept.id)), [[], ['T1']])
  // And with time, whatever was recorded before the day that is asked goes.
  const pruned = [await engine.graph.pruneWords(NOW - 1), await engine.graph.pruneWords(NOW + 1), (await wrote(caller)).length, (await wrote('contact:two')).length]
  assert.deepEqual(pruned, [0, 2, 0, 0])
  return [first, long, after, pruned]
})

test('a named service that may read events may ask whether anything changed, and nothing else of the screen', async () => {
  const tokens = [{ name: 'review-app', token: 'events-token-of-thirty-two-chars!!', calls: { events: true } }, { name: 'intake', token: 'record-token-of-thirty-two-chars!!', calls: { record: true } }] as const
  const graph = accountGraph({ memory: true, ...shared })
  const server = createServer(createEdge(graph, { token: 'service', origins: [], serviceTokens: tokens })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => { server.closeAllConnections(); server.close(); await graph.close() }
  const get = async (path: string, token: string) => (await fetch(`${base}/review/api${path}`, { headers: { authorization: `Bearer ${token}` } })).status
  try {
    await graph.record({ entries: [{ type: 'profile', key: 'one', at: AT, subject: 'contact:one', facts: { email: 'one@example.org' } }] as any })
    assert.equal(await get('/pulse', tokens[0]!.token), 200)
    for (const path of ['/clusters', '/recent', '/subject?subject=contact:one', '/board?days=90', '/ops']) assert.equal(await get(path, tokens[0]!.token), 403, path)
    // A service with no events is told no, of the pulse too.
    assert.equal(await get('/pulse', tokens[1]!.token), 403)
    // And it follows the events themselves with the same token.
    const follower = accountGraph({ url: base, token: tokens[0]!.token })
    const page = await follower.events({ after: null, limit: 10 })
    assert.equal(page.ok, true)
    await assert.rejects(follower.lookup({ kind: 'find', text: 'contact:one' }), (error) => hasCode(error, FAULT_CODES.AUTH.FORBIDDEN))
    await follower.close()
  } finally {
    await close()
  }
})

test('a reviewer screen asks what to call the people it lists, in a body and only with a reviewer or the service token', async () => {
  const { graph, base, close } = await http({ serviceTokens: [{ name: 'intake', token: 'limited-token-of-thirty-two-chars!', calls: { record: true } }] })
  const ask = async (body: unknown, token = 'reviewer') => {
    const response = await fetch(`${base}/review/api/called`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as any }
  }
  try {
    await graph.record({ entries: [{ type: 'profile', key: 'one', at: AT, subject: 'contact:one', facts: { name: { first: 'Casey', last: 'Known' }, phone: '5558675301' } }] as any })
    assert.deepEqual(await ask({ subjects: ['contact:one', 'contact:nobody'] }), { status: 200, body: { 'contact:one': { name: 'Casey Known', phone: '+15558675301' } } })
    assert.equal((await ask({ subjects: ['contact:one'] }, 'service')).status, 200)
    assert.deepEqual((await ask({ subjects: ['contact:one'], every: true })).body, { 'contact:one': { name: 'Casey Known', phone: '+15558675301', phones: ['+15558675301'] } })
    for (const bad of [{ subjects: ['contact:one'], every: 'yes' }, { subjects: Array.from({ length: 11 }, (_, i) => 'contact:' + i), every: true }]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad).slice(0, 60))
    assert.equal((await ask({ subjects: ['contact:one'] }, 'wrong')).status, 401)
    for (const bad of [{}, { subjects: 'contact:one' }, { subjects: [1] }, { subjects: [''] }, { subjects: Array.from({ length: 2001 }, (_, i) => 'contact:' + i) }]) assert.equal((await ask(bad)).status, 400, JSON.stringify(bad).slice(0, 60))
  } finally {
    await close()
  }
})

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

test('a reviewer records that a caller was reached and that a call is not a lead, under their own name and nobody else\'s', async () => {
  const { graph, local, base, close } = await http()
  const record = async (entries: unknown[], token = 'reviewer') => {
    const response = await fetch(`${base}/v1/record`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ entries }) })
    return { status: response.status, body: (await response.json()) as any }
  }
  try {
    // Two callers nobody answered, and a sale.
    const missed = (key: string, from: string) => ({ type: 'call', key, at: AT, direction: 'inbound', from, to: '5551230001', result: { answered: false } })
    assert.ok((await graph.record({ entries: [missed('M1', '5558675301'), missed('M2', '5558675302'), { type: 'conversion', key: 'sale-1', at: AT, subject: 'contact:one', stage: 'sale' }] as any })).results.every((each) => each.ok))
    const reached = { type: 'call_update', key: 'reached-M1', at: AT + 60_000, call: 'M1', change: { kind: 'returned', reachedAt: AT + 60_000, by: 'dana' } }
    const spam = { type: 'restatement', key: 'spam-M2', at: AT + 60_000, of: { type: 'call', key: 'M2' }, change: { kind: 'not_lead', why: 'spam', by: 'dana' } }
    // Signed with their own name, both are taken, and the caller no longer waits.
    const said = await record([reached, spam])
    assert.equal(said.status, 200)
    assert.deepEqual(said.body.results.map((each: any) => each.ok), [true, true])
    assert.deepEqual([said.body.results[0].value.followUp.state, said.body.results[0].value.followUp.reported], ['returned', true])
    const { engine } = await internalsOf(local)!()
    const spurned = async () => (await engine.graph.notLeads(['call:M2'])).get('call:M2')?.kind
    assert.equal(await spurned(), 'spam')
    // Who said it is kept with the statement.
    const kept = async (topic: string, about: string) => ((await engine.store.read((tx: any) => tx.saidOf(topic, about))) as any[]).map((each) => each.data)
    assert.deepEqual(await kept('return', 'M1'), [{ reachedAt: AT + 60_000, by: 'dana' }])
    assert.deepEqual(await kept('lead', 'call:M2'), [{ kind: 'spam', by: 'dana' }])
    // They may take each back, under their own name.
    const back = await record([{ type: 'call_update', key: 'unreached-M1', at: AT + 120_000, call: 'M1', change: { kind: 'not_returned', by: 'dana' } }, { type: 'restatement', key: 'lead-M2', at: AT + 120_000, of: { type: 'call', key: 'M2' }, change: { kind: 'lead', by: 'dana' } }])
    assert.deepEqual([back.status, back.body.results[0].value.followUp.state, await spurned()], [200, 'open', undefined])
    // Another name, no name, a statement about a sale, and a batch with anything else in it are all refused whole.
    const refused = [
      [{ ...reached, key: 'a', change: { ...reached.change, by: 'lee' } }],
      [{ ...reached, key: 'b', change: { kind: 'returned', reachedAt: AT + 60_000 } }],
      [{ ...spam, key: 'c', change: { kind: 'not_lead', why: 'spam' } }],
      [{ ...spam, key: 'd', of: { type: 'conversion', key: 'sale-1' } }],
      [{ ...reached, key: 'e' }, missed('M3', '5558675303')],
      [{ type: 'call_update', key: 'f', at: AT, call: 'M1', change: { kind: 'result', result: { answered: true }, by: 'dana' } }],
    ]
    for (const entries of refused) {
      const answer = await record(entries)
      assert.deepEqual([answer.status, answer.body.fault.code], [403, 'AUTH.FORBIDDEN'], JSON.stringify(entries))
    }
    // Refused whole: neither the call of the mixed batch nor the return beside it was written, and no statement was added.
    assert.equal(await graph.lookup({ kind: 'record', type: 'call', key: 'M3', at: NOW }), null)
    assert.deepEqual((await kept('return', 'M1')).length, 2)
    assert.deepEqual((await kept('lead', 'call:M2')).length, 2)
    // Sent again, a statement answers whether it still stands. The first of each was taken back by the second.
    const replay = await record([reached, spam])
    assert.deepEqual(replay.body.results.map((each: any) => [each.ok, each.value.duplicate, each.value.stands]), [[true, true, false], [true, true, false]])
    // The main service token signs with any name or none, as before.
    const service = await record([{ ...reached, key: 'g', at: AT + 180_000, change: { kind: 'returned', reachedAt: AT + 180_000 } }, { ...spam, key: 'h', at: AT + 180_000, change: { kind: 'not_lead', why: 'other', by: 'intake desk' } }], 'service')
    assert.deepEqual([service.status, service.body.results.map((each: any) => each.ok)], [200, [true, true]])
    // A blank name is no name.
    const blank = await record([{ ...reached, key: 'i', change: { ...reached.change, by: ' ' } }], 'service')
    assert.deepEqual([blank.status, blank.body.fault.code], [400, 'INPUT.MALFORMED'])
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
  const wrong = problems({ databaseUrl: 'postgres://x', receiptSecrets: ['short'], schema: 'A', identifierSecret: 'x', timeZone: 'Mars/One', policy: { same: 9, kinds: { phnoe: { weight: 1 } } }, openHours: { mon: ['nine'] }, targets: { answered: 90 }, stages: { a: { value: 'x' } }, phones: { exclude: ['x'], tapSeconds: 9999 }, webhook: { url: 'https://x' } })
  assert.equal(wrong.length >= 12, true, wrong.join('\n'))
  // The secret that keys names is required with a database, and must be text.
  const database = { databaseUrl: 'postgres://x', workers: false, receiptSecrets: [SECRET] }
  for (const identifierSecret of [undefined, null, 12345, 'short']) assert.equal(problems({ ...database, identifierSecret }).some((line) => line.includes('identifierSecret')), true, String(identifierSecret))
  assert.deepEqual(problems({ memory: true, identifierSecret: 7 }).length, 1)
  assert.throws(() => remoteOnly({ memory: true }), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  const remote = accountGraph({ url: 'https://g.example', token: 't' })
  assert.throws(() => createEdge(remote, { token: 't' }), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  await assert.rejects(runWorkers(remote), (error) => hasCode(error, FAULT_CODES.CONFIG.UNSUPPORTED))
  const unavailable = createServer().on('connection', socket => socket.destroy()).listen(0, '127.0.0.1')
  await new Promise(resolve => unavailable.once('listening', resolve))
  const down = accountGraph({ databaseUrl: `postgres://nobody@127.0.0.1:${(unavailable.address() as AddressInfo).port}/x`, workers: false, receiptSecrets: [SECRET], identifierSecret: 'i'.repeat(32), timeoutMs: 2000 })
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

test('a reviewer who says a caller was reached is shown a Board without them', async () => {
  let now = NOW
  const { graph, local, base, close } = await http({ now: () => now })
  try {
    const { engine } = await internalsOf(local)!()
    const read = engine.graph.board
    let made = 0
    // Working it out takes a second, so the answer is good for four more, whatever a service writes meanwhile.
    engine.graph.board = (...given) => ((made += 1), (now += 1000), read(...given))
    assert.ok((await graph.record({ entries: [{ type: 'call', key: 'm1', at: NOW - 3_600_000, direction: 'inbound', from: '+15558675310', to: '+15551230001', duration: 20, result: { answered: false } }] })).results[0]!.ok)
    const waiting = async () => ((await (await fetch(`${base}/review/api/board`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any).columns[0].rows.map((row: any) => row.missed)
    assert.deepEqual([await waiting(), await waiting(), made], [['m1'], ['m1'], 1])
    const said = await fetch(`${base}/v1/record`, { method: 'POST', headers: { authorization: 'Bearer reviewer' }, body: JSON.stringify({ entries: [{ type: 'call_update', key: 'r1', at: now, call: 'm1', change: { kind: 'returned', reachedAt: now, by: 'dana' } }] }) })
    assert.equal(((await said.json()) as any).results[0].ok, true)
    assert.deepEqual([await waiting(), made], [[], 2])
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

  /** `opening` ms is how long the database takes to open, held up by the upgrade lock. */
  const waitsForTheLock = async (opening: number) => {
    const { graph, local, schema, close } = await postgres({ timeoutMs: 2000 })
    const holder = await pool!.connect()
    try {
      await holder.query('select pg_advisory_lock(hashtext($1))', [`account-graph:${schema}:upgrade`])
      // The first call would open the database within its limit, and a busy machine takes longer than that over a new schema. It is opened before any call is timed.
      const opened = internalsOf(local)!()
      await new Promise((resolve) => setTimeout(resolve, opening))
      await holder.query('select pg_advisory_unlock(hashtext($1))', [`account-graph:${schema}:upgrade`])
      await opened
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
  }
  test('a call that waits too long for the lock ends', () => waitsForTheLock(0))
  test('a call that waits too long for the lock ends after the database took longer than the limit to open', () => waitsForTheLock(2500))
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

everywhere('restoring one record across the fanout cap settles every other holder in either arrival order', async ({ graph, local }) => {
  const subjects = Array.from({ length: 11 }, (_, i) => 'contact:fanout-' + i)
  const entries = subjects.map((subject, i) => ({ type: 'profile' as const, key: 'first-' + i, facts: { email: 'robin@example.org' }, subject, at: AT }))
  const people = () => graph.lookup({ kind: 'person', subjects, at: AT + 4 })
  const sizes = async () => (await people()).people.map(person => person.members.length)
  const withdrawn = { key: 'first-cut', action: 'withdraw' as const, fact: entries[0]!.facts, at: AT + 1, subject: subjects[0]!, by: 'desk' }
  assert.ok((await graph.record({ entries })).results.every(row => row.ok))
  assert.deepEqual(await sizes(), Array(11).fill(1))
  assert.ok((await graph.decide(withdrawn)).ok)
  assert.deepEqual(await sizes(), [1, ...Array(10).fill(10)])
  // The astral key sorts after the BMP key in UTF-8, and before it in UTF-16.
  for (const order of [false, true]) {
    const at = AT + (order ? 3 : 2)
    const down = () => graph.decide({ ...withdrawn, at, key: '\uE000' + at })
    const up = () => graph.record({ entries: [{ ...entries[0]!, at, key: '\u{10000}' + at }] })
    await Promise.all(order ? [down(), up()] : [up(), down()])
    assert.deepEqual(await sizes(), Array(11).fill(1))
    assert.deepEqual(await (await internalsOf(local)!()).engine.graph.verify(), [])
  }
  const answers = await graph.events({ after: null, limit: 1000 })
  assert.ok(answers.ok && answers.value.events.some(e => e.type === 'cluster.changed' && e.data.subject === subjects[10]))
  assert.ok((await graph.forget({ at: AT + 4, key: 'erase-cut', by: 'desk', subjects: [subjects[0]!], platforms: 'report' })).ok)
  assert.deepEqual(await graph.decide(withdrawn), { ok: false, reason: 'FORGOTTEN' })
  assert.deepEqual((await graph.lookup({ kind: 'person', subjects: subjects.slice(1), at: AT + 4 })).people.map(person => person.members.length), Array(10).fill(10))
})

everywhere('a withdrawal requires one identifying fact of a named record and a signer', async ({ graph }) => {
  const entry = { key: 'statement', at: AT, by: 'desk', action: 'withdraw', subject: 'contact:one', fact: { device: 'one' } } as const
  for (const change of [{ by: '   ' }, { subject: 'caller:example' }, { subject: 'visitor:example' }, { subject: 'call:example' }, { fact: {} },
    { fact: { email: 'pat@example.org', device: 'one' } }, { fact: { identifier: 'behalf:staff' } }, { fact: { identifier: 'review:join-1' } }]) {
    assert.deepEqual(await codeOf(graph.decide({ ...entry, ...change } as DecideRequest)), { code: 'INPUT.MALFORMED', retryable: false })
  }
  assert.deepEqual(await graph.decide({ ...entry, fact: { identifier: 'unknown:example' } }), { ok: false, reason: 'KIND_NOT_IN_POLICY', kind: 'unknown' })
  assert.ok((await graph.decide(entry)).ok)
})

everywhere('a withdrawal changes live ownership of earlier activity while an identity snapshot respects its effective time', async ({ graph, local }) => {
  const { engine } = await internalsOf(local)!()
  const subject = 'contact:historical'
  const phone = '+12025550116'
  const line = 'caller:' + hashPhone(phone)
  const first = NOW - 3 * 86_400_000
  const at = first + 4
  const day = new Date(first).toISOString().slice(0, 10)
  const entries: RecordEntry[] = [
    { type: 'profile', key: 'held', subject, at: first, facts: { phone } },
    { type: 'arrival', key: 'visit', subject, source: 'search', campaign: 'spring', at: first },
    { type: 'call', key: 'rang', at: first + 1, direction: 'inbound', from: phone, to: '+12025550132', duration: 60 },
    { type: 'conversion', key: 'sale', subject: line, stage: 'sale', at: first + 2, value: 100 },
  ]
  const saved = await graph.record({ entries })
  assert.ok(saved.results.every(row => row.ok))
  const view = async () => {
    const credit = await engine.graph.attribute(line, { at })
    const person = await graph.lookup({ kind: 'person', subjects: [subject], at })
    const journey = await graph.lookup({ kind: 'journey', subject, before: at })
    const report = await graph.report({ kind: 'campaigns', window: { from: day, to: day, timeZone: 'UTC' } })
    return [credit.credited?.campaign, person.people[0]!.members.length, journey.entries.some(row => row.kind === 'call'),
      report.value.rows.find(row => row.campaign === 'spring')?.stages.sale?.value ?? 0]
  }
  assert.deepEqual(await view(), ['spring', 2, true, 100])
  const cut = NOW + 5
  const result = await graph.decide({ action: 'withdraw', key: 'returned', at: cut, by: 'desk', subject, fact: { phone } })
  assert.ok(result.ok)
  assert.deepEqual(await view(), [undefined, 1, false, 0])
  const snapshot = async (when: number) => (await (await engine.graph.asOf(when)).cluster(subject))?.members
  assert.deepEqual(await snapshot(cut - 1), [line, subject].sort())
  assert.deepEqual(await snapshot(cut), [subject])
  assert.ok((await graph.record({ entries: [{ ...entries[0]!, key: 'held-again', at: cut + 2 }] })).results[0]?.ok)
  assert.deepEqual(await snapshot(cut + 1), [subject])
  assert.deepEqual(await snapshot(cut + 2), [line, subject].sort())
})
