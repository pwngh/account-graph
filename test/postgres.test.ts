import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import pg from 'pg'
import { accountGraph } from '../src/index.ts'
import { seal } from '../src/core/audit.ts'
import { createGraph, defaultPolicy, policyHash, recordCall, recordReturn } from '../tools/internals.ts'
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
test('ordinary observations and link reads keep their SQL statement counts across the fact upgrade', async () => {
  for (const upgraded of [false, true]) for (const paired of [false, true]) for (const elsewhere of [false, true]) {
    const subjects = paired ? ['account:b', 'account:a'] : ['account:a']
    const identifier = 'email:desk@example.org'
    const edges = subjects.map(subject => ({ subject, identifier, first_at: 1, last_at: 1, sightings: 1 }))
    const queries: string[] = []
    const query = async (sql: string) => {
      queries.push(sql)
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ fact_schema: upgraded }] }
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
    assert.equal(queries.filter(sql => sql.includes('from stub.fact_withdrawal')).length, Number(upgraded))
    assert.ok(!queries.some(sql => sql.includes('from stub.withdrawn_edge')))
    queries.length = 0
    await createGraph(store).links('account:a')
    assert.equal(queries.length, paired ? 7 : 6)
    assert.equal(statements(), paired ? 7 : 6)
    assert.ok(!queries.some(sql => sql.includes('fact_withdrawal') || sql.includes('withdrawn_edge')))
  }
})

const url = process.env.DATABASE_URL

test('checking an ordinary text opt-out reads the cluster, holdings and messages in the same six statements', async () => {
  const subject = 'contact:one'
  const line = 'caller:one'
  for (const upgraded of [false, true]) {
    const queries: string[] = []
    const query = async (sql: string) => {
      queries.push(sql)
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ fact_schema: true, text_schema: upgraded }] }
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
    assert.equal(queries.some(sql => sql.includes('stub.text_stop')), upgraded)
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

test('an interrupted callback backfill resumes after its committed schema changes', async () => {
  const schema = 'resume_callbacks'
  const done = new Set(upgrades(schema).filter(u => u.id < 29).map(u => u.id))
  const transactions: string[][] = []
  let pending: number[] = []
  let statements: string[] = []
  let stop = true
  const query = async (sql: string, values?: unknown[]) => {
    if (sql === 'begin') {
      pending = []
      statements = []
    } else if (sql === 'commit') {
      for (const id of pending) done.add(id)
      transactions.push(statements)
    } else if (sql.startsWith('select id from')) return { rows: [...done].map(id => ({ id })) }
    else if (sql.startsWith('insert into ' + schema + '.upgrade')) {
      const id = Number(values![0])
      if (stop && id === 31) throw new Error('stopped before the backfill committed')
      pending.push(id)
    } else statements.push(sql)
    return { rows: [] }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, schema)
  await assert.rejects(store.migrate(), /stopped before the backfill committed/)
  assert.equal(Math.max(...done), 30)
  assert.ok(transactions.some(group => group.some(sql => sql.includes('alter table ' + schema + '.event add column if not exists notice_key'))))
  stop = false
  assert.deepEqual(await store.migrate(), upgrades(schema).filter(u => u.id >= 31).map(u => u.name))
  assert.deepEqual(await store.migrate(), [])
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
      assert.deepEqual((await store.read(tx => tx.subjectDates(['account:1']))).get('account:1'), { firstSeen: 111 })

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

  // The previous server logged a decision and changed the report revision on every full forget.
  const oldForgetDecision = (store: ReturnType<typeof createPostgresStore>, subject: string, at: number) => store.write(async tx => {
    const before = await tx.lastDecision()
    const decision = { seq: (before?.seq ?? 0) + 1, at, action: 'forget' as const, about: [subject] }
    await tx.setSetting('callParty', 'deletion-' + decision.seq)
    await tx.addDecision({ ...decision, hash: seal(before?.hash ?? '', decision) })
  })

  for (const [stopped, start, committed, relation] of [[30, 29, 28, 'said_party_subject'], [31, 29, 30, 'callback_event_calls'], [36, 36, 35, 'profile_created'], [37, 37, 36, 'withdrawn_edge'], [38, 38, 37, 'text_stop']] as const) test(`upgrade ${stopped} whose session ends before commit rolls back and can run again`, async () => {
    const schema = `ag_test_${process.pid}_interrupted_${stopped}`
    try {
      const store = await madeBefore(schema, start)
      const interrupted = createPostgresStore({
        query: pool.query.bind(pool),
        async connect() {
          const client = await pool.connect()
          let closed = false
          return {
            async query(sql, values) {
              const result = await client.query(sql, values)
              if (sql.startsWith('insert into') && values?.[0] === stopped) {
                closed = true
                client.release(true)
                throw new Error('upgrade session ended')
              }
              return result
            },
            release() { if (!closed) client.release() },
          }
        },
      }, schema)
      await assert.rejects(interrupted.migrate(), /upgrade session ended/)
      assert.equal((await pool.query(`select max(id) as id from ${schema}.upgrade`)).rows[0].id, committed)
      assert.equal((await pool.query('select to_regclass($1) as name', [schema + '.' + relation])).rows[0].name, null)
      if (stopped === 31) await pool.query(`select callback_calls from ${schema}.event limit 0`)
      assert.ok((await store.migrate()).includes(upgrades(schema).find(upgrade => upgrade.id === stopped)!.name))
      assert.deepEqual(await store.migrate(), [])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('two servers upgrade creation dates once, and an older server can still observe, prune and forget several subjects', async () => {
    const schema = `ag_test_${process.pid}_created`
    let app: ReturnType<typeof accountGraph> | undefined
    try {
      const store = await madeBefore(schema, 36)
      await store.write(tx => tx.addSightings([{ subject: 'record:a', identifier: 'email:first@example.org', at: 10, recorded: 90 }]))
      const other = createPostgresStore(pool, schema)
      assert.deepEqual((await Promise.all([store.migrate(), other.migrate()])).flat(), upgrades(schema).filter(u => u.id >= 36).map(u => u.name))
      const entry = { key: 'signup', type: 'profile' as const, subject: 'record:a', at: 20, createdAt: 8, facts: { email: 'first@example.org' } }
      const second = { ...entry, key: 'signup-b', subject: 'record:b', createdAt: 9 }
      const kept = { ...entry, key: 'signup-c', subject: 'record:c', createdAt: 12 }
      const plain = { key: 'signup-d', type: 'profile' as const, subject: 'record:d', at: 20, facts: { email: 'later@example.org' } }
      app = accountGraph({ databaseUrl: url!, schema, workers: false, receiptSecrets: ['a'.repeat(32)] })
      assert.ok((await app.record({ entries: [entry, second, kept, plain] })).results.every(row => row.ok))
      assert.deepEqual(await store.migrate(), [])
      assert.deepEqual(await other.migrate(), [])
      // The preceding version continued to write these same sightings, prune SQL and forget decisions.
      await store.write(tx => tx.addSightings([{ subject: 'record:a', identifier: 'email:first@example.org', at: 4, recorded: 100 }]))
      await pool.query(`delete from ${schema}.sighting; delete from ${schema}.receipt where forgotten_at is null and recorded_at < 8640000000000000`)
      assert.deepEqual((await store.read(tx => tx.subjectDates(['record:a']))).get('record:a'), { firstSeen: 4, createdAt: 8 })
      const retried = (await app.record({ entries: [entry, plain] })).results
      assert.deepEqual(retried.map(row => row.ok && row.value.duplicate), [false, false])
      // Insert the decisions together so only the row trigger can erase the two dates.
      const batch = [
        { action: 'forget' as const, about: [entry.subject] },
        { action: 'separate' as const, about: [kept.subject, plain.subject] },
        { action: 'forget' as const, about: [second.subject] },
      ]
      let previous = ''
      const decisions = batch.map((row, i) => {
        const decision = { ...row, seq: i + 1, at: 102 }
        previous = seal(previous, decision)
        return { ...decision, hash: previous }
      })
      await pool.query(`insert into ${schema}.decision (seq, at, action, about, hash)
        select * from jsonb_to_recordset($1::jsonb) as batch(seq bigint, at bigint, action text, about jsonb, hash text)`, [JSON.stringify(decisions)])
      assert.deepEqual(await store.read(tx => tx.subjectDates([entry.subject, second.subject, kept.subject])), new Map([
        [entry.subject, { firstSeen: 4 }], [second.subject, { firstSeen: 20 }], [kept.subject, { firstSeen: 20, createdAt: 12 }],
      ]))
    } finally {
      await app?.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('upgrade 37 waits for an older observation before it locks either table', async () => {
    const schema = `ag_test_${process.pid}_fact_lock`
    await madeBefore(schema, 37)
    const writer = await pool.connect()
    const migrator = await pool.connect()
    let applying: Promise<unknown> | undefined
    try {
      await writer.query('begin')
      await writer.query('select pg_advisory_xact_lock(hashtext($1))', ['account-graph:' + schema])
      await writer.query(`insert into ${schema}.sighting (subject, identifier, at, recorded_at) values ('record:old', 'email:a@example.org', 10, 10)`)
      const { rows: [{ pid }] } = await migrator.query('select pg_backend_pid() as pid')
      applying = migrator.query(upgrades(schema).find(u => u.id === 37)!.sql)
      // The old writer holds a sighting table lock and still needs an edge table lock to finish.
      let blocked: string | undefined
      const until = Date.now() + 5_000
      while (!blocked && Date.now() < until) {
        blocked = (await pool.query('select locktype from pg_locks where pid = $1 and not granted', [pid])).rows[0]?.locktype
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(blocked, 'advisory')
      await writer.query(`lock table ${schema}.edge in row exclusive mode nowait`)
      await writer.query(`insert into ${schema}.edge (subject, identifier, first_at, last_at, sightings) values ('record:old', 'email:a@example.org', 10, 10, 1)`)
      await writer.query('commit')
      await applying
    } finally {
      await writer.query('rollback')
      await applying?.catch(() => undefined)
      writer.release()
      migrator.release()
      await pool.query(`drop schema ${schema} cascade`)
    }
  })

  test('upgrade 38 reads existing holdings, keeps them on an older prune and erases them on an older forget', async () => {
    const schema = `ag_test_${process.pid}_text_holdings`
    const subject = 'contact:withdrawn'
    const other = 'contact:other'
    const line = 'caller:line'
    const phone = 'phone:line'
    const alias = 'voip:line'
    try {
      const store = await madeBefore(schema, 38)
      await store.write(async tx => {
        await tx.addSightings([{ subject, identifier: phone, at: 1, profileKey: 'first' }, { subject: other, identifier: phone, at: 2, profileKey: 'other' }])
        await tx.withdrawFact(subject, [phone, alias], 4, 'first-cut', 4)
        await tx.addSightings([{ subject, identifier: alias, at: 6, profileKey: 'back' }, { subject, identifier: alias, at: 8, profileKey: 'still' }])
        await tx.withdrawFact(subject, [phone, alias], 10, 'last-cut', 10)
      })
      assert.deepEqual(await store.migrate(), ['text stops on records that lose a number'])
      const stop = { subject, line, at: 7, key: 'word' }
      await store.write(tx => tx.keepTextStops([stop, { ...stop, at: 3, through: { at: 11, key: 'old-start' } }]))
      const numbers = () => store.read(tx => tx.textNumbers([subject, other]))
      assert.deepEqual((await numbers()).find(row => row.subject === subject)?.through, { at: 11, key: 'old-start' })
      await store.write(tx => tx.keepTextStops([{ ...stop, at: 3, through: { at: 11, key: 'second-start' } }, { ...stop, at: 3, through: { at: 10, key: 'third-start' } }]))
      await store.write(tx => tx.keepTextStops([{ ...stop, at: 4 }]))
      const before = await numbers()
      assert.deepEqual(before.find(row => row.subject === other), { subject: other, line, active: true })
      const found = before.find(row => row.subject === subject)
      assert.equal(found?.stopKey, 'word')
      assert.equal(found?.stop, 7)
      assert.deepEqual(found?.through, { at: 11, key: 'second-start' })
      assert.ok(found?.held?.some(row => row.held && row.at === 6 && row.key === 'back'))
      await pool.query(`delete from ${schema}.sighting where recorded_at < 100`)
      assert.deepEqual((await numbers()).sort((a, b) => a.subject.localeCompare(b.subject)), before.sort((a, b) => a.subject.localeCompare(b.subject)))
      assert.deepEqual((await pool.query(`select subject, key from ${schema}.text_phone_profile order by at`)).rows, ['first', 'back', 'still'].map(key => ({ subject, key })))
      await oldForgetDecision(store, subject, 100)
      for (const table of ['text_phone_profile', 'text_stop']) assert.deepEqual((await pool.query(`select * from ${schema}.${table}`)).rows, [])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('upgrade 37 preserves older observations and protects withdrawn facts and receipts alongside an older writer', async () => {
    const schema = `ag_test_${process.pid}_fact`
    const subject = 'record:shared'
    // The old writer takes the same lock, omits the new columns and counts only edges its upsert returned.
    const old = createPostgresStore({
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect()
        return {
          release: () => client.release(),
          async query(sql, values) {
            if (!sql.includes('account_graph.fact_writer')) return client.query(sql, values)
            await client.query('select pg_advisory_xact_lock(hashtext($1))', values!.slice(0, 1))
            return { rows: [{ fact_schema: false }] }
          },
        }
      },
    }, schema)
    const email = 'email:desk@example.org'
    try {
      const store = await madeBefore(schema, 37)
      await store.write(tx => tx.addSightings([{ subject, identifier: email, at: 5 }]))
      assert.deepEqual(await store.read(tx => tx.subjectDates([subject])), new Map([[subject, { firstSeen: 5 }]]))
      assert.deepEqual(await createGraph(store).verify(), [])
      assert.deepEqual((await Promise.all([store.migrate(), createPostgresStore(pool, schema).migrate()])).flat(), upgrades(schema).filter(upgrade => upgrade.id >= 37).map(upgrade => upgrade.name))
      const oldGraph = createGraph(old, defaultPolicy, { now: () => 10 })
      const graph = createGraph(store, defaultPolicy, { now: () => 12 })
      await oldGraph.observe({ subject, identifiers: [email], at: 10 })
      await graph.withdrawFact(subject, [email], 9, 'before', { by: 'desk' })
      assert.deepEqual(await (await graph.asOf(12)).holders([email]), [])
      assert.deepEqual(await graph.holders([email]), [])
      await graph.withdrawFact(subject, [email], 10, 'same-time', { by: 'desk' })
      assert.deepEqual(await (await graph.asOf(12)).holders([email]), [])
      await store.write(async tx => {
        await tx.pruneSightings(11)
        await tx.addReceipt({ type: 'decide', mac: 'sample', digest: {}, secretId: 'sample', version: 1, at: 10, recorded: 12, ref: { type: 'withdraw', mac: 'sample' } }, [subject])
      })
      await old.write(async tx => {
        await tx.addSightings([{ subject, identifier: email, at: 14 }])
        // The old graph reads this row even when there is no remaining positive holder.
        assert.deepEqual((await tx.states([email])).get(email), { ignored: true, fanout: 0 })
      })
      assert.deepEqual(await (await graph.asOf(14)).holders([email]), [])
      assert.deepEqual(await store.read(tx => tx.states([email])), new Map())
      assert.deepEqual((await pool.query(`select id from ${schema}.identifier where id = $1`, [email])).rows, [])
      assert.deepEqual(await store.read(tx => tx.edgesOf([subject])), [])
      assert.deepEqual(await store.read(tx => tx.subjectDates([subject])), new Map([[subject, { firstSeen: 5 }]]))
      const other = 'record:other'
      await oldGraph.observe([{ subject, identifiers: [email, 'device:still-here'], at: 15 }, { subject: other, identifiers: [email], at: 15 }])
      assert.deepEqual((await store.read(tx => tx.edgesOn([email]))).map(e => e.subject), [other])
      assert.deepEqual((await store.read(tx => tx.states([email]))).get(email), { ignored: false, fanout: 1 })
      assert.deepEqual((await store.read(tx => tx.edgesOf([subject]))).map(e => e.identifier), ['device:still-here'])
      assert.deepEqual(await oldGraph.rebuild(), [])
      await graph.observe({ subject, identifiers: [email], at: 16 }, { key: 'restored', sources: new Map() })
      assert.deepEqual((await graph.holders([email])).map(row => row.subject).sort(), [other, subject])
      await graph.withdrawFact(subject, [email], 17, 'again', { by: 'desk' })
      assert.deepEqual((await graph.holders([email])).map(row => row.subject), [other])
      assert.deepEqual(await createGraph(store).verify(), [])
      const lone = 'email:lone@example.org'
      const muted = 'email:muted@example.org'
      await oldGraph.observe({ subject, identifiers: [lone, muted], at: 15 })
      await store.write(async tx => {
        await tx.setIgnored(muted, true)
        await tx.withdrawFact(subject, [lone, muted], 16, 'two', 16)
      })
      await oldGraph.observe({ subject, identifiers: [lone, muted], at: 15 })
      // The preceding server prunes every live receipt. It can still erase and tombstone this decision.
      await pool.query(`delete from ${schema}.receipt where forgotten_at is null and recorded_at < 100`)
      assert.ok(await store.read(tx => tx.receiptOf('decide', ['sample'])))
      await old.write(tx => tx.forgetReceipts([subject], [], 16))
      await oldGraph.forget(subject)
      assert.equal((await store.read(tx => tx.receiptOf('decide', ['sample'])))?.forgotten, 16)
      assert.deepEqual(await store.read(tx => tx.factHistory(100)), [])
      assert.deepEqual((await pool.query(`select * from ${schema}.withdrawn_edge`)).rows, [])
      assert.deepEqual((await pool.query(`select id, fanout, ignored from ${schema}.identifier where id = any($1::text[])`, [[lone, muted]])).rows, [{ id: muted, fanout: 0, ignored: true }])
      await oldGraph.observe({ subject, identifiers: [email], at: 17 })
      assert.deepEqual((await store.read(tx => tx.edgesOn([email]))).map(e => e.subject).sort(), [other, subject])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('an old writer cannot replace a stated call or leave its guesses behind after upgrading', async () => {
    const schema = `ag_test_${process.pid}_old_report`
    const call = { id: 'id', subject: 'caller:original', direction: 'inbound' as const, at: 100, recorded: 102, to: '+12025550105', flags: [] }
    const oldReport = `insert into ${schema}.call (id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags)
      values ('id', 'caller:other', 101, '+12025550106', 30, '{pool}', 'visitor:other', 103, 'inbound', '{"office":"other"}')
      on conflict (id) do update set subject = excluded.subject, at = excluded.at, dialed = excluded.dialed, duration = excluded.duration,
      flags = excluded.flags, visitor = excluded.visitor, recorded_at = excluded.recorded_at, direction = excluded.direction, tags = excluded.tags`
    let app: ReturnType<typeof accountGraph> | undefined
    try {
      const store = await madeBefore(schema, 34)
      const graph = createGraph(store)
      await store.write(tx => tx.setCall(call, 'phone'))
      await graph.sayParty({ call: call.id, key: 'said', at: 110, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      await pool.query(oldReport)
      await store.write(tx => tx.addSightings([{ subject: 'caller:other', identifier: 'phone:other', at: 101, recorded: 103, event: 'call' }]))
      assert.equal((await graph.keptCall('id'))?.subject, 'caller:other')
      app = accountGraph({ databaseUrl: url!, schema, workers: false, receiptSecrets: ['a'.repeat(32)] })
      await app.lookup({ kind: 'journey', subject: 'record:a' })
      assert.equal((await graph.keptCall('id'))?.subject, 'record:a')
      assert.deepEqual(await store.read(tx => tx.edgesOn(['phone:other'])), [])
      assert.equal(await store.read(tx => tx.callLine('id')), 'caller:original')
      await graph.sayParty({ call: 'early', key: 'early-party', at: 110, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      await assert.rejects(pool.query(oldReport.replace("values ('id'", "values ('early'")), { code: '23514' })
      assert.equal(await graph.keptCall('early'), undefined)
      await graph.keepCall({ ...call, id: 'early' }, 'phone')
      assert.equal((await graph.keptCall('early'))?.subject, 'record:a')
      for (const hidden of [false, true]) {
        if (hidden) await graph.sayParty({ call: 'id', key: 'corrected', at: 120, party: { role: 'unknown', by: 'desk' } })
        const before = await graph.keptCall('id')
        const client = await pool.connect()
        try {
          await client.query('begin')
          await client.query(`insert into ${schema}.sighting (subject, identifier, at, recorded_at) values ('caller:drift', 'phone:drift', 102, 103)`)
          await assert.rejects(client.query(oldReport), { code: '23514' })
          await client.query('commit')
        } finally {
          await client.query('rollback')
          client.release()
        }
        assert.deepEqual(await graph.keptCall('id'), before)
        assert.deepEqual(await graph.history('caller:drift'), [])
      }
    } finally {
      await app?.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('an older report of a blocked call marks the database for repair even when the subject still agrees', async () => {
    const schema = `ag_test_${process.pid}_blocked_report`
    try {
      const store = await madeBefore(schema, 34)
      await pool.query(`insert into ${schema}.call (id,subject,line_subject,at,dialed,recorded_at,direction,flags,party) values
        ('blocked','call:blocked','call:blocked',100,'+12025550101',102,'inbound','{blocked}','{"role":"unknown","by":"desk","at":110}');
        update ${schema}.call set subject='call:blocked', visitor='visitor:other', flags='{blocked,pool}', recorded_at=120 where id='blocked'`)
      await store.write(tx => tx.addSightings([{ subject: 'call:blocked', identifier: 'dialed:call-blocked', at: 100, recorded: 120, event: 'call' }]))
      await store.migrate()
      assert.equal(await store.read(tx => tx.settingOf('repairCallReports')), 'due')
      await createGraph(store).repairCallReports()
      assert.deepEqual(await store.read(tx => tx.edgesOn(['dialed:call-blocked'])), [])
      const { rows } = await pool.query(`select subject, visitor, flags from ${schema}.call where id='blocked'`)
      assert.deepEqual(rows, [{ subject: 'call:blocked', visitor: null, flags: ['blocked'] }])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('upgrade 35 reopens a completed repair when an older statement predates the returning record', async () => {
    const schema = `ag_test_${process.pid}_return`
    let app: ReturnType<typeof accountGraph> | undefined
    try {
      const store = await madeBefore(schema, 35)
      const subject = 'record:returning'
      const graph = createGraph(store, undefined, { now: () => 10 })
      await oldForgetDecision(store, subject, 10)
      await store.write(async tx => {
        await tx.setCall({ id: 'returned', subject: 'caller:line', direction: 'inbound', at: 20, to: '+12025550102', recorded: 21, flags: [] })
        await tx.addSaid({ topic: 'party', about: 'returned', key: 'pre-return', at: 100, data: { role: 'self', subject, by: 'desk' } })
        await tx.applyCallParty('returned')
        await tx.setSetting('repairForgottenParties', 'done')
      })
      await createGraph(store, undefined, { now: () => 40 }).observe({ subject, identifiers: ['email:back@example.org'], at: 1 })
      app = accountGraph({ databaseUrl: url!, schema, workers: false, receiptSecrets: ['a'.repeat(32)] })
      assert.equal(await app.lookup({ kind: 'record', type: 'call', key: 'returned', at: 101 }), null)
      assert.deepEqual(await graph.partyHistory('returned'), [])
      assert.equal(await store.read(tx => tx.settingOf('repairForgottenParties')), 'done')
      assert.deepEqual((await pool.query(`select type, digest from ${schema}.receipt where forgotten_at is not null order by type`)).rows, ['call', 'call_update', 'conversion'].map(type => ({ type, digest: null })))
    } finally {
      await app?.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('opening an older database clears a party written after deletion and tombstones its pruned key', async () => {
    const schema = `ag_test_${process.pid}_late_party`
    let app: ReturnType<typeof accountGraph> | undefined
    try {
      const store = await madeBefore(schema, 33)
      const erased = 'record:erased'
      await oldForgetDecision(store, erased, Date.now())
      await store.write(async tx => {
        await tx.setCall({ id: 'old-call', subject: 'caller:line', direction: 'inbound', at: 1, to: '+12025550102', recorded: 1, flags: [] })
        await tx.addSaid({ topic: 'party', about: 'old-call', key: 'old-key', at: 2, data: { role: 'self', subject: erased, by: 'desk' } })
        await tx.applyCallParty('old-call')
      })
      app = accountGraph({ databaseUrl: url!, schema, workers: false, receiptSecrets: ['a'.repeat(32)] })
      assert.equal(await app.lookup({ kind: 'record', type: 'call', key: 'old-call', at: 3 }), null)
      assert.deepEqual(await store.read(tx => tx.saidOf('party', 'old-call')), [])
      assert.equal(await store.read(tx => tx.settingOf('repairForgottenParties')), 'done')
      const { rows } = await pool.query(`select type, digest, forgotten_at is not null as erased from ${schema}.receipt where type in ('call', 'call_update') order by type`)
      assert.deepEqual(rows, ['call', 'call_update'].map(type => ({ type, digest: null, erased: true })))
    } finally {
      await app?.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('calls recorded before staff could name a party keep their line and result after upgrading', async () => {
    const schema = `ag_test_${process.pid}_party`
    try {
      const store = await madeBefore(schema, 29)
      await pool.query(`insert into ${schema}.call (id, subject, at, dialed, flags, recorded_at) values ('old', 'caller:line', 1, '+12025550101', '{}', 1);
        insert into ${schema}.call_result (id, answered, recorded_at) values ('old', false, 1)`)
      assert.ok((await store.migrate()).includes('staff confirmation of a call'))
      assert.equal((await pool.query(`select line_kind from ${schema}.call where id = 'old'`)).rows[0]?.line_kind, null)
      await store.write(async tx => {
        assert.deepEqual([(await tx.callOf('old'))?.party, await tx.callLine('old'), (await tx.callResultOf('old'))?.answered], [undefined, 'caller:line', false])
        await tx.addSaid({ topic: 'party', about: 'old', key: 'confirmed', at: 2, data: { role: 'self', subject: 'record:a', by: 'desk' } })
        await tx.applyCallParty('old')
        assert.deepEqual([(await tx.callOf('old'))?.subject, await tx.callLine('old'), (await tx.callResultOf('old'))?.answered], ['record:a', 'caller:line', false])
      })
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('upgrading removes ambiguous old channel visits for calls already confirmed', async () => {
    const schema = `ag_test_${process.pid}_call_visits`
    try {
      const store = await madeBefore(schema, 30)
      await pool.query(`insert into ${schema}.call (id, subject, line_subject, at, dialed, flags, recorded_at, party)
        values ('old', 'record:a', 'caller:line', 1, '+12025550101', '{}', 1, '{"role":"self","subject":"record:a","by":"desk","at":2}');
        insert into ${schema}.touch (subject, at, detail) values
          ('caller:line', 1, '{"landing":"tel:+12025550101","source":"one"}'), ('caller:line', 1, '{"landing":"tel:+12025550101","source":"two"}'),
          ('caller:line', 2, '{"landing":"tel:+12025550101","source":"later"}')`)
      assert.ok((await store.migrate()).includes('source call of a channel visit'))
      await store.read(async tx => assert.deepEqual((await tx.touchesOf(['caller:line'], 1, 2)).map(touch => touch.source), ['later']))
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a rebuild after upgrading a corrected call counts its old line without linking it', async () => {
    const schema = `ag_test_${process.pid}_withdrawn_call`
    try {
      const store = await madeBefore(schema, 32)
      await pool.query(`insert into ${schema}.call (id, subject, line_subject, at, dialed, flags, recorded_at, party)
        values ('old', 'call:old', 'caller:line', 1, '+12025550101', '{}', 1, '{"role":"unknown","by":"desk","at":2}');
        insert into ${schema}.subject values ('contact:a','contact:a','contact:a'), ('contact:b','contact:a','contact:a');
        insert into ${schema}.edge values ('contact:a','phone:line',1,1,1), ('contact:b','phone:line',1,1,1);
        insert into ${schema}.identifier (id,fanout) values ('phone:line',2);
        insert into ${schema}.built (policy) values ('old')`)
      assert.ok((await store.migrate()).includes('withdrawn call evidence in shared identifier counts'))
      assert.deepEqual(await store.migrate(), [])
      const graph = createGraph(store)
      assert.equal((await graph.policy()).due, true)
      await graph.rebuild()
      assert.deepEqual((await graph.cluster('contact:a'))?.members, ['contact:a'])
      await store.read(async tx => {
        assert.equal((await tx.states(['phone:line'])).get('phone:line')?.fanout, 3)
        assert.deepEqual((await tx.edgesOn(['phone:line'])).map(edge => edge.subject).sort(), ['contact:a', 'contact:b'])
        assert.deepEqual(await tx.callVisitors(['old']), new Map())
      })
      await graph.forget('caller:line')
      assert.deepEqual((await graph.cluster('contact:a'))?.members, ['contact:a', 'contact:b'])
      assert.deepEqual(await graph.verify(), [])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('the callback backfill finds the calls of each notice without scanning all calls for every event', async () => {
    const schema = `ag_test_${process.pid}_callback_plan`
    const client = await pool.connect()
    try {
      await madeBefore(schema, 31)
      await client.query(`insert into ${schema}.call (id, subject, at, dialed, flags, recorded_at)
        select 'call-' || n, 'record:' || n, n, '+12025550101', '{}', n from generate_series(1, 4000) n;
        insert into ${schema}.event (seq, type, at, subject, data) select n, 'callback.overdue', 5000, 'record:' || n,
          jsonb_build_object('call', 'call-' || n, 'attempts', 0, 'missedAt', n) from generate_series(1, 150) n;
        analyze ${schema}.call; analyze ${schema}.event`)
      await client.query('begin')
      const statements = upgrades(schema).find(u => u.id === 31)!.sql.split(';').map(s => s.trim()).filter(Boolean)
      const work = statements.findIndex(sql => sql.startsWith('update ' + schema + '.event e set callback_calls'))
      assert.notEqual(work, -1)
      for (const sql of statements.slice(0, work)) await client.query(sql)
      const { rows } = await client.query('explain (analyze, format json, timing off) ' + statements[work])
      type Plan = { 'Node Type': string; 'Relation Name'?: string; 'Actual Loops': number; 'Rows Removed by Filter'?: number; Plans?: Plan[] }
      const check = (plan: Plan): void => {
        if (plan['Relation Name'] === 'call' && plan['Node Type'] === 'Seq Scan') {
          assert.ok(plan['Actual Loops'] <= 3 || (plan['Rows Removed by Filter'] ?? 0) < 100, JSON.stringify(plan))
        }
        for (const child of plan.Plans ?? []) check(child)
      }
      check(rows[0]['QUERY PLAN'][0].Plan)
    } finally {
      await client.query('rollback')
      client.release()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('a callback from before the upgrade keeps only calls that could have been known when it was queued', async () => {
    const schema = `ag_test_${process.pid}_known_calls`
    try {
      const store = await madeBefore(schema, 31)
      await pool.query(`insert into ${schema}.call (id, subject, at, direction, dialed, flags, recorded_at) values
        ('miss','caller:line',5,'inbound','+12025550101','{}',5),
        ('attempt','caller:line',7,'outbound','+12025550101','{}',7),
        ('future','caller:line',11,'outbound','+12025550101','{}',11),
        ('late-out','caller:line',8,'outbound','+12025550101','{}',12),
        ('late-in','caller:line',2,'inbound','+12025550101','{}',12);
        update ${schema}.call set subject='record:other', line_subject='caller:line', party='{"role":"self","subject":"record:other","by":"desk","at":13}' where id='future';
        insert into ${schema}.call_result (id,answered,recorded_at) values ('late-in',false,12);
        insert into ${schema}.event (seq,type,at,subject,data) values (1,'callback.overdue',10,'caller:line',
          '{"call":"miss","subject":"caller:line","missedAt":5,"attempts":1,"source":"google","campaignId":"one"}');
        insert into ${schema}.alert (key,subject,at,tried_at,text) values ('unreturned:caller:line:miss','caller:line',10,10,'one attempt');
        insert into ${schema}.event_once (said_once,subject) values ('unreturned:caller:line:miss','caller:line'), ('unreturned:caller:line:late-in','caller:line');
        insert into ${schema}.touch (subject,at,detail) values ('caller:line',4,'{"gclid":"one","campaignId":"one"}')`)
      await store.migrate()
      const read = async () => (await pool.query(`select callback_calls from ${schema}.event where seq=1`)).rows[0]?.callback_calls?.sort()
      assert.deepEqual(await read(), ['attempt', 'miss'])
      const graph = createGraph(store)
      const move = (id: string) => graph.sayParty({ call: id, key: 'move-' + id, at: 13, party: { role: 'self', subject: 'record:other', by: 'desk' } })
      for (const id of ['future', 'late-out', 'late-in']) await move(id)
      assert.deepEqual(await read(), ['attempt', 'miss'])
      assert.deepEqual((await store.ops.undelivered()).map(row => row.text), ['one attempt'])
      await move('attempt')
      assert.equal(await read(), undefined)
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  test('upgrading old callback events drops attempts that could belong to a different record', async () => {
    const schema = `ag_test_${process.pid}_callback_sources`
    try {
      const store = await madeBefore(schema, 31)
      await pool.query(`insert into ${schema}.call (id, subject, line_subject, at, direction, dialed, flags, recorded_at, party)
        values ('attempt', 'record:b', 'caller:line', 3, 'outbound', '+12025550101', '{}', 3, '{"role":"self","subject":"record:b","by":"desk","at":7}');
        insert into ${schema}.event (seq, type, at, subject, data) values
          (1, 'callback.overdue', 6, 'caller:line', '{"call":"miss","subject":"caller:line","attempts":1,"missedAt":2}'),
          (2, 'callback.overdue', 6, 'caller:other', '{"call":"other","subject":"caller:other","attempts":1,"missedAt":2}'),
          (3, 'callback.overdue', 6, 'caller:line', '{"call":"later","subject":"caller:line","attempts":0,"missedAt":4}');
        insert into ${schema}.alert (key, subject, at, tried_at, text) values ('unreturned:caller:line:first', 'caller:line', 6, 6, '1 callback attempt');
        insert into ${schema}.event_once (said_once, subject) values ('unreturned:caller:line:first', 'caller:line')`)
      assert.ok((await store.migrate()).includes('calls behind callback notices'))
      assert.deepEqual((await store.read(tx => tx.eventsAfter(0, 100))).map(event => event.seq), [2, 3])
      assert.deepEqual(await store.ops.undelivered(), [])
      assert.deepEqual((await pool.query(`select * from ${schema}.event_once`)).rows, [])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

  for (const history of ['none', 'standing', 'erased', 'expired', 'ordinary']) test(`an unprovable old callback after upgrading a database with ${history} party history`, async () => {
    const schema = `ag_test_${process.pid}_old_route_${history}`
    const erased = history === 'erased' || history === 'expired'
    const corrected = erased || history === 'standing'
    try {
      const store = await madeBefore(schema, 31)
      // At version 30 the queue lost the physical line's channel visit, but kept the missed caller's credited event.
      await pool.query(`insert into ${schema}.call (id,subject,at,dialed,flags,recorded_at) values ('credit','caller:x',1,'+12025550101','{}',1), ('miss','caller:y',2,'+12025550102','{}',2), ('own','caller:other',2,'+12025550103','{}',2);
        insert into ${schema}.event (seq,type,at,subject,data) values
          (1,'callback.overdue',4,'caller:y','{"call":"miss","subject":"caller:y","missedAt":2,"attempts":0,"source":"google","campaign":null,"campaignId":"former"}'),
          (2,'callback.overdue',4,'caller:other','{"call":"own","subject":"caller:other","missedAt":2,"attempts":0,"source":"google","campaign":null,"campaignId":"own"}');
        insert into ${schema}.touch (subject,at,detail) values ('caller:other',1,'{"gclid":"own","campaignId":"own"}');
        insert into ${schema}.alert (key,subject,at,tried_at,text) values ('unreturned:caller:y:first','caller:y',4,4,'former'), ('unreturned:caller:z:pruned','caller:z',4,4,'no event remains'), ('unreturned:caller:other:own','caller:other',4,4,'own');
        insert into ${schema}.event_once (said_once,subject) select key,subject from ${schema}.alert`)
      if (history === 'standing') await pool.query(`update ${schema}.call set subject='record:b', line_subject='caller:x', party='{"role":"self","subject":"record:b","by":"desk","at":5}' where id='credit'`)
      if (erased || history === 'ordinary') {
        await pool.query(`delete from ${schema}.call where id='credit';
          insert into ${schema}.call (id,subject,at,dialed,flags,recorded_at) values ('orphan','caller:other',2,'+12025550103','{}',2);
          insert into ${schema}.event (seq,type,at,subject,data) values
            (3,'callback.overdue',4,'caller:other','{"call":"orphan","subject":"caller:other","missedAt":2,"attempts":1,"source":"google","campaign":null,"campaignId":"own"}'),
            (4,'callback.overdue',4,'caller:other','{"call":"lost","subject":"caller:other","missedAt":2,"attempts":0,"source":"google","campaign":null,"campaignId":"own"}')`)
        // After receipt pruning, only a party statement's key gets a call_update tombstone of version zero.
        await pool.query(`insert into ${schema}.receipt (type,key_mac,secret_id,digest_version,at,recorded_at,forgotten_at) values
          ('call','old-call','fixture',1,1,1,7), ('call_update','old-update','fixture',$1,5,5,7)`, [history === 'expired' ? 0 : 1])
        if (history === 'erased') await pool.query(`insert into ${schema}.setting (name,value) values ('callParty','old-revision')`)
      }
      await store.migrate()
      const events = async () => (await store.read(tx => tx.eventsAfter(0, 10))).map(event => event.seq)
      assert.deepEqual(await events(), corrected ? [2] : history === 'ordinary' ? [1, 2, 3, 4] : [1, 2])
      assert.equal((await store.ops.undelivered()).length, corrected ? 1 : 3)
      if (history === 'ordinary') return
      if (!corrected) await createGraph(store).sayParty({ call: 'credit', key: 'corrected', at: 6, party: { role: 'self', subject: 'record:b', by: 'desk' } })
      assert.deepEqual(await events(), [2])
      assert.deepEqual((await store.ops.undelivered()).map(alert => alert.key), ['unreturned:caller:other:own'])
      assert.deepEqual((await pool.query(`select said_once from ${schema}.event_once`)).rows, [{ said_once: 'unreturned:caller:other:own' }])
    } finally {
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
  })

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
