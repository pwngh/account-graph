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
      // No ad platform is configured, so there is no outbox to post to.
      assert.equal((await fetch(`${base}/convert`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: '{}' })).status, 404)
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
