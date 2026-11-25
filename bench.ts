/**
 * Measures write and read speed on this machine.
 *   node bench.ts                      memory store
 *   DATABASE_URL=postgres://... node bench.ts   PostgreSQL too
 *   DATABASE_URL=postgres://... node bench.ts scale 1000000 5000000
 *
 * The last makes a graph of that many edges in PostgreSQL, in a schema of its
 * own that is dropped after, and measures what reads all of it: a rebuild, a
 * check and the graph as of a time. Each runs in a process of its own, so its
 * peak memory is its own.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createBatcher, createGraph, createMemoryStore } from './tools/internals.ts'
import type { Graph, Observation } from './tools/internals.ts'

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

/** Makes a graph of about this many edges: for every five, one account with an email, a device, a fingerprint and two addresses, most of them its own. */
async function fill(pool: { query(text: string): Promise<{ rows: any[] }> }, schema: string, edges: number) {
  const accounts = Math.round(edges / 5)
  const some = (salt: number, count: number) => `abs(hashint8extended(i, ${salt})) % ${Math.max(1, Math.round(count))}`
  await pool.query(`
    insert into ${schema}.edge (subject, identifier, first_at, last_at, sightings)
      select distinct 'account:' || i, identifier, ${T0} + i, ${T0} + i, 1 from generate_series(1, ${accounts}) as i, lateral unnest(array[
        'email:' || i,
        'device:' || case when ${some(1, 100)} < 97 then i else ${some(2, accounts)} end,
        'fingerprint:' || case when ${some(3, 100)} < 90 then i else -(${some(4, accounts / 10)}) end,
        'ip:' || ${some(5, accounts * 0.4)},
        'ip:' || ${some(6, accounts * 0.4)}]) as identifier;
    insert into ${schema}.identifier (id, fanout, ignored) select identifier, count(*), false from ${schema}.edge group by identifier;
    insert into ${schema}.subject (id, component, cluster) select distinct subject, subject, subject from ${schema}.edge;
    insert into ${schema}.sighting (subject, identifier, at, event, recorded_at) select subject, identifier, first_at, 'login', first_at from ${schema}.edge;`)
  await pool.query(`analyze ${schema}.edge, ${schema}.identifier, ${schema}.subject, ${schema}.sighting`)
}

/** One measurement on a graph made before, in this process alone. */
async function measure(what: string, schema: string) {
  const { default: pg } = await import('pg')
  const { createPostgresStore } = await import('./src/store/postgres.ts')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const graph = createGraph(createPostgresStore(pool, schema))
  let start = performance.now()
  let said = ''
  if (what === 'rebuild') said = `${(await graph.rebuild()).length} subjects moved`
  if (what === 'verify') said = `${(await graph.verify()).length} unsound`
  if (what === 'asOf') said = `${(await (await graph.asOf(Number.MAX_SAFE_INTEGER)).counts()).subjects} subjects`
  if (what === 'day to day') {
    const observe: number[] = []
    const links: number[] = []
    for (let i = 1; i <= 300; i++) {
      start = performance.now()
      await graph.observe({ subject: `account:${i * 97}`, identifiers: [`email:${i * 97}`, `ip:${i}`], at: T0 + i, event: 'login' })
      observe.push(performance.now() - start)
      start = performance.now()
      await graph.links(`account:${i * 89}`)
      links.push(performance.now() - start)
    }
    const at = (list: number[], share: number) => list.sort((x, y) => x - y)[Math.floor(list.length * share)]!.toFixed(1)
    said = `observe ${at(observe, 0.5)} ms (95% under ${at(observe, 0.95)}), links ${at(links, 0.5)} ms (95% under ${at(links, 0.95)})`
  } else said = `${((performance.now() - start) / 1000).toFixed(1)} s, ${said}`
  await pool.end()
  // Node counts it in kilobytes.
  const peak = process.resourceUsage().maxRSS / 1024
  console.log(`${what}: ${said}, peak memory ${Math.round(peak)} MB`)
}

async function scale(sizes: readonly number[]) {
  const { default: pg } = await import('pg')
  const { createPostgresStore } = await import('./src/store/postgres.ts')
  for (const edges of sizes) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    // Made by this run and by no other, so it is this run's to drop.
    const schema = `ag_bench_${randomUUID().replaceAll('-', '')}`
    await pool.query(`create schema ${schema}`)
    try {
      await createPostgresStore(pool, schema).migrate()
      const start = performance.now()
      await fill(pool, schema, edges)
      const { rows } = await pool.query(`select count(*)::int as edges from ${schema}.edge`)
      const { rows: size } = await pool.query(`select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '${schema}' and c.relkind = 'r'`)
      console.log(`\n${rows[0].edges} edges, ${size[0].size} on disk, made in ${Math.round((performance.now() - start) / 1000)} s`)
      for (const what of ['rebuild', 'verify', 'asOf', 'day to day']) {
        try {
          execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'measure', what, schema], { stdio: ['ignore', 'inherit', 'pipe'] })
        } catch (error) {
          const said = String((error as { stderr?: Buffer }).stderr)
          console.log(`${what}: failed, ${/heap out of memory/.test(said) ? 'out of memory' : said.split('\n').find((line) => /Error/.test(line)) ?? 'no reason given'}`)
        }
      }
    } finally {
      await pool.query(`drop schema ${schema} cascade`)
      await pool.end()
    }
  }
}

const [mode, ...given] = process.argv.slice(2)
if (mode === 'measure') {
  await measure(given[0]!, given[1]!)
  process.exit(0)
}
if (mode === 'scale') {
  await scale(given.map(Number))
  process.exit(0)
}

await run('memory', createGraph(createMemoryStore()), 50_000)

if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg')
  const { createPostgresStore } = await import('./src/store/postgres.ts')
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
