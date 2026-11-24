import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import pg from 'pg'
import { createGraph } from '../src/index.ts'
import { createPostgresStore, upgrades } from '../src/postgres.ts'
import { serve } from '../src/serve.ts'
import { outboxSuite } from './outbox.suite.ts'
import { suite } from './suite.ts'

const url = process.env.DATABASE_URL

if (!url) {
  test('postgres store', { skip: 'set DATABASE_URL to run the suite against PostgreSQL' }, () => {})
} else {
  const pool = new pg.Pool({ connectionString: url, max: 8 })
  let count = 0
  after(() => pool.end())

  const open = async () => {
    const schema = `ag_test_${process.pid}_${count++}`
    const store = createPostgresStore(pool, schema)
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

  test('a database from before the policy was recorded is due a rebuild, and a kind with no rule stops the server', async () => {
    const schema = `ag_test_${process.pid}_policy`
    const env = { DATABASE_URL: url, GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKEN: 'review', PORT: '0', HOST: '127.0.0.1' }
    try {
      const old = await madeBefore(schema, 6)
      await pool.query(`insert into ${schema}.subject values ('account:1', 'account:1', 'account:1');
        insert into ${schema}.edge values ('account:1', 'badge:7', 1, 1, 1); insert into ${schema}.identifier values ('badge:7', 1)`)
      await old.migrate()
      await assert.rejects(serve(env, () => {}), /identifiers of kind "badge" are stored, and the policy names no such kind/)
      const lines: string[] = []
      const running = await serve({ ...env, POLICY: '{"kinds":{"badge":{"weight":0.5,"dilution":0,"cap":3,"halfLife":"none"},"phone":{"weight":0.85}}}' }, (line) => lines.push(line))
      try {
        assert.ok(lines.some((line) => /^policy [0-9a-f]{12} from settings; .*rebuild is due/.test(line)), lines.join('\n'))
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

  test('the server starts from the environment alone and serves a visit end to end', async () => {
    const schema = `ag_test_${process.pid}_serve`
    const lines: string[] = []
    const running = await serve({ DATABASE_URL: url, GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'service', REVIEW_TOKEN: 'review', ORIGINS: 'https://site.example', PORT: '0', HOST: '127.0.0.1' }, (line) => lines.push(line))
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
      assert.deepEqual([report.rows[0].source, report.rows[0].stages], ['google', { enrolled: { count: 1, value: 200 } }])
    } finally {
      await running.close()
      await pool.query(`drop schema if exists ${schema} cascade`)
    }
    // A second start finds nothing to upgrade.
    await assert.rejects(serve({ GRAPH_TOKEN: 'x' }), /DATABASE_URL is required/)
  })

  suite('postgres store', open, 400)
  outboxSuite('postgres store', open)
}
