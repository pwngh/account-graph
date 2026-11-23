import { after, test } from 'node:test'
import pg from 'pg'
import { createPostgresStore } from '../src/postgres.ts'
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
  suite('postgres store', open, 400)
  outboxSuite('postgres store', open)
}
