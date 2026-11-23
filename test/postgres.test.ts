import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import pg from 'pg'
import { createGraph } from '../src/index.ts'
import { createPostgresStore, upgrades } from '../src/postgres.ts'
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

  suite('postgres store', open, 400)
  outboxSuite('postgres store', open)
}
