import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import pg from 'pg'
import { FAULT_CODES, hasCode } from '../src/contract/fault.ts'
import { createGraph, defaultPolicy, policyHash } from '../tools/internals.ts'
import { createPostgresStore, upgrades } from '../src/store/postgres.ts'
import { command, serve } from '../src/bin.ts'
import { malformedSuite } from './malformed.suite.ts'
import { opsSuite } from './ops.suite.ts'
import { outboxSuite } from './outbox.suite.ts'
import { eventsSuite } from './events.suite.ts'
import { unjoinSuite } from './unjoin.suite.ts'
import { factSuite } from './fact.suite.ts'
import { saidSuite } from './said.suite.ts'
import { counts, suite } from './suite.ts'
import { unitSuite } from './unit.suite.ts'
import { readHistorySuite } from './read-history.suite.ts'

// Keep the ordinary write budget observable on machines without PostgreSQL. The shared suite checks the resulting groups on a real store.
test('ordinary observations and link reads keep their SQL statement counts', async () => {
  for (const paired of [false, true]) for (const elsewhere of [false, true]) {
    const subjects = paired ? ['account:b', 'account:a'] : ['account:a']
    const identifier = 'email:desk@example.org'
    const edges = subjects.map(subject => ({ subject, identifier, first_at: 1, last_at: 1, sightings: 1 }))
    const queries: string[] = []
    const query = async (sql: string) => {
      queries.push(sql)
      if (sql.includes('from stub.built')) return { rows: [{ policy: policyHash(defaultPolicy), reserved: elsewhere }] }
      if (sql.startsWith('with upserted')) return { rows: [{ identifier, added: 1 }] }
      if (sql.includes('select id, fanout, ignored')) return { rows: [{ id: identifier, fanout: subjects.length, ignored: false }] }
      if (sql.startsWith('select id, component, cluster')) return { rows: subjects.map(id => ({ id, component: id, cluster: id })) }
      if (sql.startsWith('select * from stub.edge') || sql.startsWith('with active as')) return { rows: edges.map(row => ({ ...row, reserved: false })) }
      if (sql.startsWith('select from stub.call_evidence limit 1')) return { rows: elsewhere ? [{}] : [] }
      return { rows: [] }
    }
    const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
    const changes = await createGraph(store).observe({ subject: 'account:a', identifiers: [identifier], at: 1 })
    assert.equal(changes.length, Number(paired))
    assert.equal(queries.length, paired ? 15 : 10, `${queries.length} trips for ${subjects.length} subjects: ${queries.map(sql => sql.split('\n')[0]).join(', ')}`)
    const statements = () => queries.reduce((count, sql) => count + sql.split(';').filter(part => part.trim()).length, 0)
    assert.equal(statements(), paired ? 16 : 11)
    assert.equal(queries.filter(sql => sql.includes('from stub.fact_withdrawal')).length, 1)
    assert.ok(!queries.some(sql => sql.includes('from stub.withdrawn_edge')))
    queries.length = 0
    await createGraph(store).links('account:a')
    assert.equal(queries.length, paired ? 7 : 6)
    assert.equal(statements(), paired ? 7 : 6)
    assert.ok(!queries.some(sql => sql.includes('fact_withdrawal') || sql.includes('withdrawn_edge')))
  }
})

const url = process.env.DATABASE_URL

test('a read of a database that was never set up says so, and any other SQL error is kept as it is', async () => {
  const schema = 'stub'
  const ledger = 'select id, name from stub.upgrade'
  for (const [made, code] of [[false, '42P01'], [true, '42703'], [true, '42501']] as const) {
    const statements: string[] = []
    const cause = Object.assign(new Error(code === '42703' ? 'column "profile_at" does not exist' : 'unavailable relation'), { code })
    const query = async (sql: string) => {
      statements.push(sql)
      if (sql.startsWith('with edges as')) throw cause
      if (sql === ledger) {
        if (!made) throw Object.assign(new Error('missing upgrade ledger'), { code: '42P01' })
        return { rows: upgrades(schema).map(({ id, name }) => ({ id, name })) }
      }
      return { rows: [] }
    }
    const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, schema)
    await assert.rejects(store.read(tx => tx.textNumbers(['contact:one'])), error => made
      ? error === cause
      : hasCode(error, FAULT_CODES.CONFIG.MISMATCH) && error.message.includes('upgrade 1') && error.message.includes('migrate()'))
    assert.deepEqual(statements.slice(2), code === '42501' ? ['rollback'] : ['rollback', ledger])
  }
})

test('checking an ordinary text opt-out reads the cluster, holdings and messages in the same six statements', async () => {
  const subject = 'contact:one'
  const line = 'caller:one'
  {
    const queries: string[] = []
    const query = async (sql: string) => {
      queries.push(sql)
      if (sql.includes('from stub.subject')) return { rows: [{ id: subject, component: subject, cluster: subject }] }
      if (sql.startsWith('select * from stub.edge')) return { rows: [{ subject, identifier: 'phone:one', first_at: 1, last_at: 1, sightings: 1 }] }
      if (sql.startsWith('with edges as')) return { rows: [{ subject, line, active: true, first_at: 1, last_at: 1, held: null, at: null }] }
      if (sql.startsWith('select * from stub.message')) return { rows: [{ id: 'sms', direction: 'inbound', subject: line, at: 2, ours: '+12025550115', flags: ['opt_out'] }] }
      return { rows: [] }
    }
    const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
    await store.write(async () => {})
    queries.length = 0
    assert.deepEqual(await createGraph(store).texting(subject), { at: 2, optedOut: true })
    assert.equal(queries.length, 6)
    assert.equal(queries.reduce((n, sql) => n + sql.split(';').filter(s => s.trim()).length, 0), 6)
    assert.ok(queries.some(sql => sql.includes('stub.text_stop')))
  }
})

test('the reviewer reads dates for the whole table in one SQL query', async () => {
  const subjects = ['record:a', 'visitor:b', 'record:c']
  const requests: unknown[][] = []
  const query = async (sql: string, values?: unknown[]) => {
    if (!values) return { rows: [] }
    requests.push(values)
    return { rows: [
      { subject: subjects[0], first_seen: '0', created_at: '42' }, { subject: subjects[1], first_seen: '7', created_at: null }, { subject: subjects[2], first_seen: null, created_at: null },
    ] }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
  const dates = await store.read(tx => tx.subjectDates(subjects))
  assert.deepEqual(requests, [[subjects]])
  assert.deepEqual([...dates], [[subjects[0], { firstSeen: 0, createdAt: 42 }], [subjects[1], { firstSeen: 7 }]])
})

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
  test('a statement that fails inside a nested write, and is caught there, fails that write, and the rest still commits', async () => {
    const schema = `ag_test_${process.pid}_caught`
    let client: { query(text: string): Promise<unknown> } | undefined
    const store = createPostgresStore({ query: pool.query.bind(pool), connect: async () => (client = await pool.connect()) } as never, schema)
    try {
      await store.migrate()
      await store.write(async (tx) => {
        await assert.rejects(tx.nested(async () => {
          await tx.setSetting('inner', 'written')
          await client!.query('select 1 / 0').catch(() => undefined)
        }), { code: '25P02' })
        await tx.setSetting('outer', 'written')
      })
      assert.deepEqual([await store.read((tx) => tx.settingOf('inner')), await store.read((tx) => tx.settingOf('outer'))], [undefined, 'written'])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })
  test('dispatch guards the first party decision before an ownership revision exists', async () => {
    const schema = `ag_test_${process.pid}_dispatch`
    const ready = createPostgresStore(pool, schema)
    try {
      await ready.migrate()
      let started = false
      let checked = false
      const watching = createPostgresStore({
        query: (sql, values) => pool.query(sql, values),
        connect: async () => {
          const client = await pool.connect()
          return {
            release: (destroy?: boolean) => client.release(destroy),
            query: async (sql, values) => {
              if (sql === 'commit' && started) {
                // A second session uses the exact lock a graph write takes, before the dispatch transaction releases it.
                const { rows } = await pool.query('select pg_try_advisory_xact_lock(hashtext($1)) as free', [`account-graph:${schema}`])
                assert.equal(rows[0].free, false)
                checked = true
              }
              return client.query(sql, values)
            },
          }
        },
      }, schema)
      await watching.outbox.start([], (_jobs, party) => {
        assert.equal(party, undefined)
        started = true
      })
      assert.ok(checked)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('another worker cannot reclaim a job while its request starts', async () => {
    const { store, close } = await open()
    try {
      await store.outbox.add({ transactionId: 'call:one', target: 'ads', subject: 'caller:line', at: 1, action: 'Call', keys: {}, state: 'pending', attempts: 0, due: 1 })
      const claimed = await store.outbox.claim(1, 1, 1)
      assert.equal(claimed.length, 1)
      await store.write(async (tx) => {
        await tx.outbox.start(claimed, (jobs) => assert.deepEqual(jobs, claimed))
        // A claim skips locked rows and ignores the graph's advisory lock. The lease has expired.
        assert.deepEqual(await store.outbox.claim(3, 1, 1), [])
      })
      assert.equal((await store.outbox.claim(3, 1, 1)).length, 1)
    } finally {
      await close()
    }
  })

  test('a new database is made in one step, once, however many processes start at once', async () => {
    const schema = `ag_test_${process.pid}_new`
    try {
      const store = createPostgresStore(pool, schema)
      const name = upgrades(schema)[0]!.name
      assert.match(name, /^the schema [0-9a-f]{8}$/)
      assert.deepEqual((await Promise.all([store.migrate(), createPostgresStore(pool, schema).migrate(), store.migrate()])).flat(), [name])
      assert.deepEqual(await store.migrate(), [])
      assert.deepEqual((await pool.query(`select id, name from ${schema}.upgrade`)).rows, [{ id: 1, name }])
      const graph = createGraph(store)
      await graph.observe({ subject: 'account:3', identifiers: ['email:x'], at: 333 })
      assert.equal((await graph.history('account:3'))[0]!.at, 333)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a database made by the steps of a version before 0.1.0 is refused, and nothing in it is changed', async () => {
    const schema = `ag_test_${process.pid}_old`
    try {
      // Steps this version never had, and one step made from another text of the schema.
      for (const steps of [`(1, 'tables', 0), (2, 'when a sighting was recorded', 0)`, `(1, 'the schema', 0)`, `(1, 'the schema 00000000', 0)`]) {
        await pool.query(`drop schema if exists ${schema} cascade; create schema ${schema}; create table ${schema}.upgrade (id int primary key, name text not null, applied_at bigint not null);
          insert into ${schema}.upgrade values ${steps}`)
        const store = createPostgresStore(pool, schema)
        await assert.rejects(store.migrate(), error => hasCode(error, FAULT_CODES.CONFIG.MISMATCH) && /made by a version before 0\.1\.0/.test(error.message) && error.message.includes('Use a new database or schema'), steps)
        assert.equal((await pool.query('select to_regclass($1) as name', [schema + '.sighting'])).rows[0].name, null)
        assert.equal((await pool.query(`select count(*)::int as steps from ${schema}.upgrade`)).rows[0].steps, steps.split('), (').length)
      }
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

  test('a database whose policy was never recorded is due a rebuild, and a kind with no rule stops the server', async () => {
    const schema = `ag_test_${process.pid}_policy`
    const env = { DATABASE_URL: url, IDENTIFIER_SECRET: 'i'.repeat(32), RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKENS: '{"dana":"review"}', PORT: '0', HOST: '127.0.0.1' }
    try {
      // Rows written without a server, so no policy was recorded with them.
      await createPostgresStore(pool, schema).migrate()
      await pool.query(`insert into ${schema}.subject (id, component, cluster) values ('account:1', 'account:1', 'account:1');
        insert into ${schema}.edge (subject, identifier, first_at, last_at, sightings) values ('account:1', 'badge:7', 1, 1, 1);
        insert into ${schema}.identifier (id, fanout, ignored) values ('badge:7', 1, false)`)
      await assert.rejects(serve(env, () => {}), /Identifiers of kind "badge" are stored, and the policy names no such kind/)
      const lines: string[] = []
      const own = { ...env, POLICY: '{"kinds":{"badge":{"weight":0.5,"dilution":0,"cap":3,"halfLife":"none"},"phone":{"weight":0.85}}}' }
      const running = await serve(own, (line) => lines.push(line))
      const ask = (path: string, token: string) => fetch(`http://127.0.0.1:${running.port}${path}`, { headers: { authorization: `Bearer ${token}` } })
      let hash: string
      try {
        assert.ok(lines.some((line) => /^policy [0-9a-f]{12} \(configured\)$/.test(line)), lines.join('\n'))
        assert.ok(lines.includes('Groups are due a rebuild. Run account-graph rebuild.'), lines.join('\n'))
        const policy = (await (await ask('/review/api/policy', 'review')).json()) as any
        hash = policy.hash
        assert.deepEqual([policy.builtWith, policy.due, policy.changed, policy.rules.kinds.badge], [null, true, ['badge', 'phone'], { weight: 0.5, dilution: 0, cap: 3, halfLife: 'none' }])
        assert.match((await ask('/review/api/pulse', 'review')).headers.get('etag')!, /^"\d+-[0-9a-f]{12}-50"$/)
        for (const gone of ['/rebuild', '/verify', '/stats', '/prune']) assert.equal((await ask(gone, 'service')).status, 404)
      } finally {
        await running.close()
      }
      const said: string[] = []
      await command(own, ['rebuild'], (line) => said.push(line))
      await command(own, ['verify'], (line) => said.push(line))
      assert.equal(said[0], '0 subjects moved')
      assert.deepEqual(JSON.parse(said[1]!), { changes: [], policy: { hash, builtWith: hash, due: false } })
      // Another process with another policy writes nothing.
      await assert.rejects(serve({ ...own, POLICY: '{"kinds":{"badge":{"weight":0.6,"dilution":0,"cap":3,"halfLife":"none"}}}' }, () => {}), /The policy differs from the one this database was built with/)
      // With none of its own, a process takes the database's.
      const plain = await serve(env, () => {})
      try {
        assert.equal(((await (await fetch(`http://127.0.0.1:${plain.port}/review/api/policy`, { headers: { authorization: 'Bearer review' } })).json()) as any).hash, hash)
      } finally {
        await plain.close()
      }
      await assert.rejects(serve({ ...env, RECEIPT_SECRETS: 'q'.repeat(32) }, () => {}).then(async (other) => {
        await other.close()
        throw new Error('nothing was recorded, so nothing is missing')
      }), /nothing is missing/)
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
    const schema = `ag_test_${process.pid}_ended`
    // Named, so that it ends its own connections and not those of the test files that run beside it.
    const own = new pg.Pool({ connectionString: url, max: 2, application_name: schema })
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
        const { rows } = await pool.query(`select pid from pg_stat_activity where state = 'idle in transaction' and query like '%pg_advisory_xact_lock%' and application_name = $1`, [schema])
        assert.equal(rows.length, 1)
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
    const running = await serve({ DATABASE_URL: url, IDENTIFIER_SECRET: 'i'.repeat(32), RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKENS: '{"dana":"review"}', ORIGINS: 'https://site.example', PORT: '0', HOST: '127.0.0.1' }, (line) => lines.push(line))
    const base = `http://127.0.0.1:${running.port}`
    try {
      assert.equal(lines[0], `database upgraded: ${upgrades().map((upgrade) => upgrade.name).join(', ')}`)
      assert.ok(lines.includes('collect accepts https://site.example'))
      assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
      assert.equal((await fetch(`${base}/collect.js`)).status, 200)
      assert.equal((await fetch(`${base}/review`)).status, 200)

      const visit = await fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example' }, body: JSON.stringify({ device: 'd-1', touch: { gclid: 'G1' } }) })
      assert.equal(visit.status, 204)
      const at = Date.now()
      const call = async (name: string, body: object, token = 'service') => {
        const response = await fetch(`${base}/v1/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
        return { status: response.status, body: (await response.json()) as any }
      }
      const { body: recorded } = await call('record', { entries: [
        { type: 'profile', key: 'p1', at, subject: 'account:1', event: 'signup', facts: { device: 'd-1' } },
        { type: 'conversion', key: 'enr-1', at, subject: 'account:1', stage: 'enrolled', value: 200, currency: 'USD' },
      ] })
      assert.deepEqual(recorded.results.map((each: any) => [each.key, each.ok]), [['p1', true], ['enr-1', true]])
      const { body: found } = await call('lookup', { kind: 'person', subjects: ['account:1'], at })
      assert.deepEqual([found.people[0].members, found.people[0].arrival.source], [['account:1', 'visitor:d-1'], 'google'])
      assert.equal((await fetch(`${base}/review/api/clusters`, { headers: { authorization: 'Bearer review' } })).status, 200)
      assert.deepEqual([(await call('record', {})).status, (await call('record', { entries: [] }, 'review')).status, (await call('record', { entries: [] }, 'nobody')).status, (await fetch(`${base}/observe`, { method: 'POST', headers: { authorization: 'Bearer service' } })).status], [400, 403, 401, 404])
      const today = new Date().toISOString().slice(0, 10)
      const { body: report } = await call('report', { kind: 'campaigns', window: { from: today, to: today, timeZone: 'UTC' } }, 'review')
      assert.deepEqual([report.value.rows[0].source, counts(report.value.rows[0].stages)], ['google', { enrolled: { count: 1, value: 200 } }])
    } finally {
      await running.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
    // A second start finds nothing to upgrade.
    await assert.rejects(serve({ GRAPH_TOKEN: 'x' }), /DATABASE_URL is required/)
  })

  suite('postgres store', open, 400)
  readHistorySuite('postgres store', open, true)
  outboxSuite('postgres store', open)
  opsSuite('postgres store', open)
  malformedSuite('postgres store', open)
  factSuite('postgres store', open)
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
