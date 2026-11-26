import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { firmHistory } from '../../../examples/firm/history.ts'
import { loadFirmHistory } from '../../../examples/firm/load-history.ts'
import { PRACTICES } from '../../../examples/firm/practice.ts'
import { createGraph, createMemoryStore, policyFrom } from '../../../tools/internals.ts'
import { createPostgresStore } from '../../../src/store/postgres.ts'

const monday = Date.UTC(2026, 10, 16, 14, 50)
const policy = policyFrom(JSON.parse(readFileSync(new URL('../../../examples/household.json', import.meta.url), 'utf8')))

async function seed(store, practice, batch) {
  let writing
  const now = () => writing ?? monday
  const graph = createGraph(store, policy, { now })
  const history = firmHistory(PRACTICES[practice], now, at => { writing = at }, false, () => {})
  const start = performance.now()
  if (batch) await loadFirmHistory({ store, policy, now }, history.fill, () => {})
  else await history.fill(graph)
  return { elapsed: performance.now() - start, counts: await graph.counts(), verify: await graph.verify() }
}

function contents(store) {
  // A new history has its own stream epoch and one committed write.
  const { writes, epoch, ...rows } = store.snapshot()
  return rows
}

test('the full history uses one PostgreSQL transaction and bounded SQL trips', async t => {
  const queries = []
  const query = async sql => {
    queries.push(sql)
    return { rows: [] }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'sample')
  let writing
  const now = () => writing ?? monday
  const history = firmHistory(PRACTICES.family, now, at => { writing = at }, false, () => {})
  await loadFirmHistory({ store, policy, now }, history.fill, () => {})
  assert.equal(queries.filter(sql => sql === 'begin').length, 1)
  assert.equal(queries.filter(sql => sql.endsWith('commit')).length, 1)
  assert.ok(queries.length < 50, `${queries.length} SQL trips for the sample`)
  t.diagnostic(`${queries.length} SQL trips including begin and commit`)
})

for (const practice of ['family', 'injury']) test(`the full ${practice} seed keeps the original graph and every recorded detail`, async t => {
  const direct = createMemoryStore()
  const loaded = createMemoryStore()
  const before = await seed(direct, practice, false)
  const after = await seed(loaded, practice, true)
  assert.deepEqual(after.counts, before.counts)
  assert.deepEqual(before.verify, [])
  assert.deepEqual(after.verify, [])
  assert.deepEqual(contents(loaded), contents(direct))
  t.diagnostic(`original and batched counts ${JSON.stringify(after.counts)}, verify []`)
})

test('PostgreSQL full seed and restart each take under ten seconds and match the original PostgreSQL writes', { skip: !process.env.DATABASE_URL && 'set DATABASE_URL to run PostgreSQL seed timing' }, async t => {
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const prefix = `firm_seed_${randomUUID().replaceAll('-', '')}`
  try {
    let before
    for (const run of ['original', 'start', 'restart']) {
      const schema = `${prefix}_${run}`
      const store = createPostgresStore(pool, schema)
      try {
        await store.migrate()
        const result = await seed(store, 'family', run !== 'original')
        t.diagnostic(`${run} ${Math.round(result.elapsed)} ms, counts ${JSON.stringify(result.counts)}, verify ${JSON.stringify(result.verify)}`)
        assert.deepEqual(result.verify, [])
        if (run === 'original') before = result
        else {
          assert.deepEqual(result.counts, before.counts)
          assert.ok(result.elapsed < 10_000, `${run} took ${result.elapsed} ms`)
        }
      } finally {
        await pool.query(`drop schema if exists ${schema} cascade`)
      }
    }
  } finally {
    await pool.end()
  }
})
