import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import pg from 'pg'
import { createGraph, recordCall, recordReturn } from '../tools/internals.ts'
import { createPostgresStore, upgrades } from '../src/store/postgres.ts'
import { serve } from '../src/bin.ts'
import { malformedSuite } from './malformed.suite.ts'
import { opsSuite } from './ops.suite.ts'
import { outboxSuite } from './outbox.suite.ts'
import { eventsSuite } from './events.suite.ts'
import { unjoinSuite } from './unjoin.suite.ts'
import { saidSuite } from './said.suite.ts'
import { counts, suite } from './suite.ts'
import { unitSuite } from './unit.suite.ts'

const url = process.env.DATABASE_URL

if (!url) {
  test('postgres store', { skip: 'set DATABASE_URL to run the suite against PostgreSQL' }, () => {})
} else {
  const pool = new pg.Pool({ connectionString: url, max: 8 })
  let count = 0
  after(() => pool.end())

  const open = async () => {
    const schema = `ag_test_${process.pid}_${count++}`
    // Pages far smaller than any answer, so every long read crosses many.
    const store = createPostgresStore(pool, schema, { page: 3 })
    await store.migrate()
    return { store, close: async () => void (await pool.query(`drop schema ${schema} cascade`)) }
  }
  test('a database from before an upgrade is brought up to date, once', async () => {
    const schema = `ag_test_${process.pid}_old`
    try {
      // The sighting table as it was before sightings were stamped with when they were written down.
      await pool.query(`create schema ${schema};
        create table ${schema}.sighting (id bigint generated always as identity primary key, subject text not null, identifier text not null, at bigint not null, event text);
        insert into ${schema}.sighting (subject, identifier, at) values ('account:1', 'email:e', 111), ('account:2', 'email:e', 222)`)
      const store = createPostgresStore(pool, schema)
      assert.deepEqual(await store.migrate(), upgrades(schema).map((upgrade) => upgrade.name))
      const { rows } = await pool.query(`select at, recorded_at from ${schema}.sighting order by id`)
      assert.deepEqual(rows.map((row) => [Number(row.at), Number(row.recorded_at)]), [[111, 111], [222, 222]])

      // Nothing left to apply, however many processes start at once.
      assert.deepEqual((await Promise.all([store.migrate(), store.migrate(), store.migrate()])).flat(), [])
      // And the upgraded database works.
      const graph = createGraph(store)
      await graph.observe({ subject: 'account:3', identifiers: ['email:x'], at: 333 })
      assert.equal((await graph.history('account:3'))[0]!.at, 333)
      assert.equal((await graph.asOf(Date.now())).cluster('account:3') !== undefined, true)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  /** Makes a database as it stood after the upgrade with this id, and hands over a store on it. */
  const madeBefore = async (schema: string, id: number) => {
    await pool.query(`create schema ${schema}; create table ${schema}.upgrade (id int primary key, name text not null, applied_at bigint not null)`)
    for (const upgrade of upgrades(schema).filter((each) => each.id < id)) {
      await pool.query(upgrade.sql)
      await pool.query(`insert into ${schema}.upgrade values ($1, $2, 0)`, [upgrade.id, upgrade.name])
    }
    return createPostgresStore(pool, schema)
  }

  test('a database made before writes were counted starts counting', async () => {
    const schema = `ag_test_${process.pid}_pulse`
    try {
      const store = await madeBefore(schema, 5)
      await pool.query(`insert into ${schema}.subject values ('account:1', 'account:1', 'account:1')`)
      assert.ok((await store.migrate()).includes('write count'))
      const graph = createGraph(store)
      assert.equal(await graph.version(), 0)
      await graph.observe({ subject: 'account:1', identifiers: ['email:e'], at: 1 })
      assert.equal(await graph.version(), 1)
      // A write that fails counts for nothing.
      await assert.rejects(store.write(() => Promise.reject(new Error('no'))), /no/)
      assert.equal(await graph.version(), 1)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('answers kept before there was a history are carried over, and any dated answer stands over them', async () => {
    const schema = `ag_test_${process.pid}_consent`
    try {
      const store = await madeBefore(schema, 8)
      await pool.query(`insert into ${schema}.consent values ('visitor:1', false, false), ('visitor:2', true, true)`)
      await store.migrate()
      const graph = createGraph(store)
      const [kept, ...none] = await graph.consentHistory('visitor:1')
      assert.deepEqual([kept!.at, kept!.adUserData, kept!.source, none.length], [0, false, 'before history', 0])
      assert.ok(Math.abs(kept!.recorded - Date.now()) < 60_000)
      assert.deepEqual((await graph.consentOf(['visitor:2'])).get('visitor:2'), { adUserData: true, adPersonalization: true })
      await graph.consent('visitor:2', { adUserData: false, adPersonalization: false }, { at: 5 })
      assert.equal((await graph.consentOf(['visitor:2'])).get('visitor:2')!.adUserData, false)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('forgetting a subject leaves no identifier nobody holds, and keeps what is muted', async () => {
    const schema = `ag_test_${process.pid}_forgotten`
    try {
      const store = createPostgresStore(pool, schema)
      await store.migrate()
      const graph = createGraph(store)
      await graph.observe([{ subject: 'a', identifiers: ['email:a', 'email:shared', 'phone:muted'], at: 1 }, { subject: 'b', identifiers: ['email:shared'], at: 1 }])
      await graph.ignore('phone:muted')
      await graph.forget('a')
      const { rows } = await pool.query(`select id, fanout from ${schema}.identifier order by id`)
      assert.deepEqual(rows, [{ id: 'email:shared', fanout: 1 }, { id: 'phone:muted', fanout: 0 }])
      // Seen again, it is counted from one.
      await graph.observe({ subject: 'c', identifiers: ['email:a', 'phone:muted'], at: 2 })
      assert.deepEqual((await pool.query(`select fanout, ignored from ${schema}.identifier where id in ('email:a', 'phone:muted') order by id`)).rows, [{ fanout: 1, ignored: false }, { fanout: 1, ignored: true }])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before anything was said to be no lead takes it', async () => {
    const schema = `ag_test_${process.pid}_spurned`
    try {
      const store = await madeBefore(schema, 18)
      await pool.query(`insert into ${schema}.outcome values ('old', 'lead:1', 5, 'inquiry', 10, 'USD')`)
      assert.deepEqual((await store.migrate()).slice(0, 1), ['what was no lead'])
      const graph = createGraph(store)
      await graph.markNotLead('old', 'spam')
      const { total } = await graph.report({ from: '1970-01-01', to: '1970-01-01' })
      assert.deepEqual([total.outcomes, total.notLeads], [0, 1])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before platforms were asked what they brought keeps its costs, and takes it', async () => {
    const schema = `ag_test_${process.pid}_claimed`
    try {
      const store = await madeBefore(schema, 20)
      await pool.query(`insert into ${schema}.cost (day, source, campaign_id, campaign, amount, currency, clicks, impressions) values ('1970-01-01', 'google', '111', 'Spring', 5, 'USD', 1, 2)`)
      assert.deepEqual((await store.migrate()).slice(0, 1), ['what platforms say they brought'])
      const graph = createGraph(store)
      const [row] = (await graph.report({ from: '1970-01-01', to: '1970-01-02' })).rows
      assert.deepEqual([row!.cost, row!.reported], [5, undefined])
      await graph.spend({ day: '1970-01-02', source: 'google', campaignId: '111', amount: 5, conversions: 3, conversionValue: 30 })
      assert.deepEqual((await graph.report({ from: '1970-01-01', to: '1970-01-02' })).rows[0]!.reported, { days: 1, conversions: 3, value: 30, credited: 0, creditedValue: 0 })
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before a change of value had a reason keeps its values, and takes reasons', async () => {
    const schema = `ag_test_${process.pid}_loss`
    try {
      const store = await madeBefore(schema, 19)
      await pool.query(`insert into ${schema}.subject values ('lead:1', 'lead:1', 'lead:1')`)
      await pool.query(`insert into ${schema}.outcome (transaction_id, subject, at, stage, value, currency) values ('t1', 'lead:1', 1000, 'sale', 90, 'USD')`)
      await pool.query(`insert into ${schema}.outcome_value (transaction_id, subject, value, currency, at) values ('t1', 'lead:1', 100, 'USD', 1000), ('t1', 'lead:1', 90, 'USD', 2000)`)
      assert.deepEqual((await store.migrate()).slice(0, 1), ['why values changed'])
      const graph = createGraph(store, undefined, { now: () => 3000 })
      await graph.restate('t1', 60, undefined, 'refund')
      assert.deepEqual(await graph.values('t1'), [{ value: 100, currency: 'USD', at: 1000 }, { value: 90, currency: 'USD', at: 2000 }, { value: 60, currency: 'USD', at: 3000, kind: 'refund' }])
      const { total } = await graph.report({ from: '1970-01-01', to: '1970-01-01' })
      assert.deepEqual([total.valueChange.first, total.valueChange.now, total.valueChange.refunded, total.valueChange.writtenOff], [100, 60, 30, 0])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before returns were reported keeps its results, and takes them', async () => {
    const schema = `ag_test_${process.pid}_told`
    try {
      const store = await madeBefore(schema, 17)
      await pool.query(`insert into ${schema}.call (id, direction, subject, at, dialed, flags, recorded_at) values ('OLD', 'inbound', 'caller:x', 1000, '+15550100001', '{}', 1000)`)
      await pool.query(`insert into ${schema}.call_result (id, answered, recorded_at) values ('OLD', false, 1000)`)
      assert.deepEqual((await store.migrate()).slice(0, 1), ['returns reported by your own systems'])
      const graph = createGraph(store)
      assert.deepEqual((await graph.keptCall('OLD'))!.result, { answered: false, recorded: 1000 })
      assert.deepEqual(await recordReturn(graph, { id: 'OLD', at: 5000 }), { state: 'returned', by: 'OLD', delay: 4000, reported: true, attempts: 0 })
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before numbers were shown to one visitor lends them', async () => {
    const schema = `ag_test_${process.pid}_lease`
    try {
      const store = await madeBefore(schema, 15)
      await pool.query(`insert into ${schema}.subject values ('visitor:1', 'visitor:1', 'visitor:1')`)
      assert.deepEqual((await store.migrate()).slice(0, 1), ['numbers shown to one visitor'])
      const graph = createGraph(store)
      assert.equal((await graph.lease('visitor:1', { numbers: ['+15550100001'], minutes: 15, at: 1000 }))!.until, 901_000)
      assert.equal(await graph.leaseholder('+15550100001', 1000), 'visitor:1')
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before calls were kept takes calls, and what it counted stays counted', async () => {
    const schema = `ag_test_${process.pid}_calls`
    try {
      const store = await madeBefore(schema, 9)
      await pool.query(`insert into ${schema}.outcome values ('call:OLD', 'caller:x', 5, 'call', 10, 'USD')`)
      await store.migrate()
      const graph = createGraph(store)
      assert.equal((await graph.outcomeOf('call:OLD'))!.value, 10)
      const { state } = await recordCall(graph, { id: 'NEW', from: '+15550100001', to: '+15550100002', at: 5, duration: 60, answered: true })
      assert.equal(state, 'answered')
      assert.equal((await graph.keptCall('NEW'))!.direction, 'inbound')
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('calls kept before you could report the ones you place are all calls to you', async () => {
    const schema = `ag_test_${process.pid}_placed`
    try {
      const store = await madeBefore(schema, 10)
      await pool.query(`insert into ${schema}.call (id, subject, at, dialed, flags, recorded_at) values ('OLD', 'caller:x', 5, '+15550100001', '{}', 5)`)
      await store.migrate()
      assert.equal((await createGraph(store).keptCall('OLD'))!.direction, 'inbound')
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before feeds were noted starts from what is stored', async () => {
    const schema = `ag_test_${process.pid}_feeds`
    try {
      const store = await madeBefore(schema, 11)
      await pool.query(`insert into ${schema}.touch (subject, at, detail) values ('visitor:1', 700, '{}'), ('visitor:1', 600, '{}');
        insert into ${schema}.call (id, subject, at, dialed, flags, recorded_at) values ('OLD', 'caller:x', 5, '+15550100001', '{}', 900)`)
      await store.migrate()
      assert.deepEqual([...(await store.ops.feeds())].sort(), [['calls', { last: 900 }], ['touches', { last: 700 }]])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('outcomes and calls from before they had tags have none', async () => {
    const schema = `ag_test_${process.pid}_tags`
    try {
      const store = await madeBefore(schema, 12)
      await pool.query(`insert into ${schema}.outcome values ('t1', 'account:1', 5, 'sale', 10, 'USD');
        insert into ${schema}.call (id, subject, at, dialed, flags, recorded_at) values ('OLD', 'caller:x', 5, '+15550100001', '{}', 5)`)
      await store.migrate()
      const graph = createGraph(store)
      assert.deepEqual(await graph.outcomeOf('t1'), { transactionId: 't1', subject: 'account:1', at: 5, stage: 'sale', value: 10, currency: 'USD' })
      assert.equal('tags' in (await graph.keptCall('OLD'))!, false)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('values from before there was a history start one, and are not said to be the first', async () => {
    const schema = `ag_test_${process.pid}_values`
    try {
      const store = await madeBefore(schema, 14)
      await pool.query(`insert into ${schema}.outcome values ('t1', 'account:1', 1767225600000, 'sale', 0, 'USD'), ('t2', 'account:1', 1767225600000, 'sale', 90, 'USD')`)
      await store.migrate()
      const graph = createGraph(store, undefined, { now: () => 1767312000000 })
      assert.equal((await graph.report({ from: '2026-01-01', to: '2026-01-02' })).total.valueChange.now, 90)
      await graph.restate('t2', 0)
      assert.deepEqual(await graph.values('t2'), [{ value: 90, currency: 'USD', at: 0 }, { value: 0, currency: 'USD', at: 1767312000000 }])
      const report = await graph.report({ from: '2026-01-01', to: '2026-01-02' })
      assert.deepEqual(report.total.valueChange, { outcomes: 2, first: 0, now: 0, refunded: 0, writtenOff: 0, zeroed: 1, firstUnknown: 2 })
      assert.deepEqual(report.months.map((each) => each.month), ['(not set)'])
      await graph.forget('account:1')
      assert.deepEqual(await graph.values('t1'), [])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database from before the policy was recorded is due a rebuild, and a kind with no rule stops the server', async () => {
    const schema = `ag_test_${process.pid}_policy`
    const env = { DATABASE_URL: url, RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKENS: '{"dana":"review"}', PORT: '0', HOST: '127.0.0.1' }
    try {
      const old = await madeBefore(schema, 6)
      await pool.query(`insert into ${schema}.subject values ('account:1', 'account:1', 'account:1');
        insert into ${schema}.edge values ('account:1', 'badge:7', 1, 1, 1); insert into ${schema}.identifier values ('badge:7', 1)`)
      await old.migrate()
      await assert.rejects(serve(env, () => {}), /identifiers of kind "badge" are stored, and the policy names no such kind/)
      const lines: string[] = []
      const running = await serve({ ...env, POLICY: '{"kinds":{"badge":{"weight":0.5,"dilution":0,"cap":3,"halfLife":"none"},"phone":{"weight":0.85}}}' }, (line) => lines.push(line))
      try {
        assert.ok(lines.some((line) => /^policy [0-9a-f]{12} \(configured\); rebuild required/.test(line)), lines.join('\n'))
        const ask = (path: string, token: string, body?: object) => fetch(`http://127.0.0.1:${running.port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, ...(body && { body: JSON.stringify(body) }) })
        const policy = (await (await ask('/policy', 'review')).json()) as any
        assert.deepEqual([policy.builtWith, policy.due, policy.changed, policy.rules.kinds.badge], [null, true, ['badge', 'phone'], { weight: 0.5, dilution: 0, cap: 3, halfLife: 'none' }])
        assert.equal((await ask('/rebuild', 'review', {})).status, 403)
        assert.equal((await ask('/rebuild', 'service', { by: 'ops', reason: 'new weights' })).status, 200)
        // Nothing in the body is needed.
        assert.equal((await fetch(`http://127.0.0.1:${running.port}/rebuild`, { method: 'POST', headers: { authorization: 'Bearer service' } })).status, 200)
        assert.match((await ask('/pulse', 'review')).headers.get('etag')!, /^"\d+-[0-9a-f]{12}-50"$/)
        assert.deepEqual((await (await ask('/verify', 'service')).json()) as any, { changes: [], policy: { hash: policy.hash, builtWith: policy.hash, due: false } })
        assert.equal(((await (await ask('/stats', 'service')).json()) as any).policy.due, false)
      } finally {
        await running.close()
      }
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('reads are answered while a long write lasts, however many writes wait for it', async () => {
    const schema = `ag_test_${process.pid}_turns`
    const few = new pg.Pool({ connectionString: url, max: 3 })
    try {
      const store = createPostgresStore(few, schema)
      await store.migrate()
      const graph = createGraph(store)
      let done!: () => void
      const held = new Promise<void>((resolve) => (done = resolve))
      let entered!: () => void
      const inside = new Promise<void>((resolve) => (entered = resolve))
      const writes = [store.write(async () => (entered(), held))]
      try {
        await Promise.race([inside, writes[0]])
        for (let i = 0; i < 10; i++) writes.push(store.write(async () => undefined))
        assert.equal(await Promise.race([graph.counts().then(() => 'answered'), new Promise((resolve) => setTimeout(resolve, 2_000, 'waited'))]), 'answered')
      } finally {
        done()
        await Promise.allSettled(writes)
      }
      // One that fails holds up nobody.
      await assert.rejects(store.write(async () => Promise.reject(new Error('refused'))), /refused/)
      await store.write(async () => undefined)
    } finally {
      await few.query(`drop schema if exists ${schema} cascade`)
      await few.end()
    }
  })

  test('a connection the database ends, at rest or in use, is an error and not the end of the process', async () => {
    const own = new pg.Pool({ connectionString: url, max: 2 })
    const schema = `ag_test_${process.pid}_ended`
    const store = createPostgresStore(own, schema)
    const pid = async () => (await own.query('select pg_backend_pid() as pid')).rows[0].pid
    const end = async (which: number) => {
      await pool.query('select pg_terminate_backend($1)', [which])
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try {
      await store.migrate()
      const graph = createGraph(store)
      await end(await pid())
      await graph.observe({ subject: 'a', identifiers: ['email:x'], at: 1 })
      // In use, and between two statements, so nothing is waiting for its answer.
      await assert.rejects(store.write(async (tx) => {
        const { rows } = await pool.query(`select pid from pg_stat_activity where state = 'idle in transaction' and query like '%pg_advisory_xact_lock%' and application_name = ''`)
        for (const row of rows) await end(row.pid)
        await tx.edgesOf(['a'])
      }))
      assert.equal((await graph.cluster('a'))!.id, 'a')
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
      await own.end()
    }
  })

  test('the server starts from the environment alone and serves a visit end to end', async () => {
    const schema = `ag_test_${process.pid}_serve`
    const lines: string[] = []
    const running = await serve({ DATABASE_URL: url, RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKENS: '{"dana":"review"}', ORIGINS: 'https://site.example', PORT: '0', HOST: '127.0.0.1' }, (line) => lines.push(line))
    const base = `http://127.0.0.1:${running.port}`
    try {
      assert.equal(lines[0], `database upgraded: ${upgrades().map((upgrade) => upgrade.name).join(', ')}`)
      assert.ok(lines.includes('collect accepts https://site.example'))
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
      assert.equal((await fetch(`${base}/collect.js`)).status, 200)
      assert.equal((await fetch(`${base}/review`)).status, 200)

      const visit = await fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example' }, body: JSON.stringify({ device: 'd-1', touch: { gclid: 'G1' } }) })
      assert.equal(visit.status, 204)
      const signup = await fetch(`${base}/observe`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ subject: 'account:1', identifiers: ['device:d-1'], at: Date.now(), event: 'signup' }) })
      assert.equal(signup.status, 200)
      const attribution = (await (await fetch(`${base}/attribute?subject=account:1`, { headers: { authorization: 'Bearer service' } })).json()) as any
      assert.equal(attribution.credited.gclid, 'G1')
      assert.equal((await fetch(`${base}/clusters`, { headers: { authorization: 'Bearer review' } })).status, 200)
      // No ad platform is configured, so an outcome is counted for the report and sent nowhere.
      const convert = (body: object) => fetch(`${base}/convert`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })
      assert.equal((await convert({})).status, 400)
      assert.deepEqual(await (await convert({ transactionId: 'enr-1', subject: 'account:1', at: Date.now(), stage: 'enrolled', value: 200 })).json(), [])
      const today = new Date().toISOString().slice(0, 10)
      const report = (await (await fetch(`${base}/report?from=${today}&to=${today}`, { headers: { authorization: 'Bearer review' } })).json()) as any
      assert.deepEqual([report.rows[0].source, counts(report.rows[0].stages)], ['google', { enrolled: { count: 1, value: 200 } }])
    } finally {
      await running.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
    // A second start finds nothing to upgrade.
    await assert.rejects(serve({ GRAPH_TOKEN: 'x' }), /DATABASE_URL is required/)
  })

  suite('postgres store', open, 400)
  outboxSuite('postgres store', open)
  opsSuite('postgres store', open)
  malformedSuite('postgres store', open)
  saidSuite('postgres store', open)
  unjoinSuite('postgres store', open)
  eventsSuite('postgres store', open)
  unitSuite('postgres store', async () => {
    const opened = await open()
    const schema = `ag_test_${process.pid}_${count - 1}`
    const tables = (await pool.query('select table_name as name from information_schema.tables where table_schema = $1 order by 1', [schema])).rows.map((row) => row.name)
    // A number a rolled back write took is not given back, so generated ids are left out.
    const dump = async () => Object.fromEntries(await Promise.all(tables.map(async (name) => [name, (await pool.query(`select to_jsonb(r) - 'id' as row from ${schema}.${name} r`)).rows.map((row) => JSON.stringify(row.row)).sort()])))
    return { ...opened, dump }
  })
}
