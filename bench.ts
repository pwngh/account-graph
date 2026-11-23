/**
 * Measures write and read speed on this machine.
 *   node bench.ts                      memory store
 *   DATABASE_URL=postgres://... node bench.ts   PostgreSQL too
 */
import { createBatcher, createGraph, createMemoryStore } from './src/index.ts'
import type { Graph, Observation } from './src/index.ts'

const ACCOUNTS = 20_000
const T0 = 1_700_000_000_000

let seed = 1
const next = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (count: number) => Math.floor(next() * count)

/** A login: the account's own email and usual device, plus an address and fingerprint others share. */
function login(i: number): Observation {
  const account = pick(ACCOUNTS)
  return {
    subject: `account:${account}`,
    identifiers: [
      `email:${account}`,
      `device:${next() < 0.97 ? account : pick(ACCOUNTS)}`,
      `fingerprint:${next() < 0.9 ? account : pick(2_000)}`,
      `ip:${pick(8_000)}`,
    ],
    at: T0 + i * 1000,
    event: 'login',
  }
}

async function run(name: string, graph: Graph, writes: number) {
  seed = 1
  let start = performance.now()
  for (let i = 0; i < writes; i++) await graph.observe(login(i))
  const single = (writes / (performance.now() - start)) * 1000

  start = performance.now()
  for (let i = 0; i < writes; i += 100) await graph.observe(Array.from({ length: 100 }, (_, j) => login(writes + i + j)))
  const batched = (writes / (performance.now() - start)) * 1000

  // The same load arriving all at once, as it does from many requests, through the write queue.
  start = performance.now()
  const batcher = createBatcher(graph)
  await Promise.all(Array.from({ length: writes }, (_, i) => batcher.observe(login(2 * writes + i))))
  const queued = (writes / (performance.now() - start)) * 1000

  const reads = Math.min(writes, 2000)
  start = performance.now()
  for (let i = 0; i < reads; i++) await graph.links(`account:${pick(ACCOUNTS)}`)
  const linksMs = (performance.now() - start) / reads

  start = performance.now()
  const unsound = (await graph.verify()).length
  const verifyMs = performance.now() - start

  console.log(
    `${name}: ${Math.round(single)} observations/s one at a time, ${Math.round(batched)}/s in batches of 100, ${Math.round(queued)}/s through the write queue, ` +
      `links() ${linksMs.toFixed(2)} ms, full verify ${Math.round(verifyMs)} ms (${unsound} unsound)`,
  )
}

await run('memory', createGraph(createMemoryStore()), 50_000)

if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg')
  const { createPostgresStore } = await import('./src/postgres.ts')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const schema = `ag_bench_${process.pid}`
  const store = createPostgresStore(pool, schema)
  await store.migrate()
  try {
    await run('postgres', createGraph(store), 10_000)
  } finally {
    await pool.query(`drop schema ${schema} cascade`)
    await pool.end()
  }
}
