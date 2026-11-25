import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { command, configFrom } from '../src/bin.ts'

const run = promisify(execFile)
type Log = (line: string) => void
type Env = Record<string, string | undefined>
type Manifest = { schema: string; counts: Map<string, string>; auditHash: string | null }

async function timed<T>(name: string, log: Log, work: () => Promise<T>): Promise<T> {
  const at = performance.now()
  try {
    return await work()
  } finally {
    log(`${name}: ${Math.round(performance.now() - at)} ms`)
  }
}

async function withClient<T>(connectionString: string, work: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString })
  await db.connect()
  try {
    return await work(db)
  } finally {
    await db.end()
  }
}

function databaseUrl(value: string | undefined, name: string): URL {
  let url: URL
  try {
    url = new URL(value ?? '')
  } catch {
    throw new Error(`Give ${name} as a PostgreSQL URL with a database name`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error(`Give ${name} with an explicit PostgreSQL host and database name`)
  // libpq and node-postgres interpret routing overrides differently. Both must reach the database we checked.
  if (['host', 'hostaddr', 'port', 'dbname', 'database', 'service', 'load_balance_hosts', 'target_session_attrs'].some(key => url.searchParams.has(key)) || decodeURI(url.pathname) !== decodeURIComponent(url.pathname)) throw new Error(`Put the database address in the authority and path of ${name}`)
  return url
}

async function postgresTool(program: 'pg_dump' | 'pg_restore', url: URL, archive: string, args: string[]) {
  // A private libpq service file keeps the address and any SSL credentials out of the process list.
  const service = join(dirname(archive), program + '.conf')
  const settings = new Map(url.searchParams)
  const connection = new pg.Client({ connectionString: url.href })
  settings.set('host', connection.host)
  settings.set('port', String(connection.port))
  settings.set('dbname', connection.database!)
  if (connection.user) settings.set('user', connection.user)
  if (connection.host.includes(',')) throw new Error('Give one PostgreSQL host per URL')
  const env: NodeJS.ProcessEnv = { ...process.env, PGSERVICEFILE: service }
  // An inherited hostaddr takes precedence over the host name even when the URL gives it explicitly.
  delete env.PGHOSTADDR
  if (connection.password) env.PGPASSWORD = connection.password
  settings.delete('password')
  const lines = ['[rehearsal]']
  for (const [name, value] of settings) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name) || value !== value.trim() || /[\r\n\0]/.test(value)) throw new Error('The PostgreSQL URL contains an invalid connection parameter')
    lines.push(name + '=' + value)
  }
  await writeFile(service, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
  try {
    await run(program, ['--no-password', '--dbname=service=rehearsal', ...args], { env })
  } catch (error) {
    // A failed COPY can put a row in stderr.
    throw new Error(`${program} failed (${(error as NodeJS.ErrnoException).code ?? 'interrupted'})`)
  } finally {
    await rm(service)
  }
}

const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"'

async function manifest(db: pg.Client, schema: string): Promise<Manifest> {
  const { rows } = await db.query<{ name: string; kind: string }>(`select c.relname as name, c.relkind as kind from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relkind in ('r', 'p', 'f') order by c.relname collate "C"`, [schema])
  if (rows.some(row => row.kind === 'f')) throw new Error('Foreign tables cannot be verified from a graph schema dump')
  const table = (name: string) => identifier(schema) + '.' + identifier(name)
  const counts = new Map<string, string>()
  for (const { name } of rows) {
    const { rows: [result] } = await db.query(`select count(*)::text as n from ${table(name)}`)
    counts.set(name, result.n)
  }
  const { rows: decisions } = await db.query(`select hash from ${table('decision')} order by seq desc limit 1`)
  return { schema, counts, auditHash: decisions[0]?.hash ?? null }
}

async function requireEmpty(db: pg.Client) {
  const { rows: [row] } = await db.query(`select exists (
      select from pg_catalog.pg_namespace n where n.nspname <> 'information_schema' and n.nspname !~ '^pg_' and
        (n.nspname <> 'public' or exists (select from pg_catalog.pg_depend d where d.refclassid = 'pg_catalog.pg_namespace'::regclass and d.refobjid = n.oid)
          or exists (select from pg_catalog.pg_class c where c.relnamespace = n.oid))
      union all select from pg_catalog.pg_extension where extname <> 'plpgsql'
      union all select from pg_catalog.pg_largeobject_metadata
      union all select from pg_catalog.pg_event_trigger
      union all select from pg_catalog.pg_publication
      union all select from pg_catalog.pg_foreign_data_wrapper
      union all select from pg_catalog.pg_subscription where subdbid = (select oid from pg_catalog.pg_database where datname = current_database())
      union all select from pg_catalog.pg_default_acl
    ) as occupied`)
  if (row.occupied) throw new Error('The target database is not empty')
}

export async function capture(source: URL, schema: string, archive: string, log: Log): Promise<Manifest> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('GRAPH_SCHEMA must be a plain lowercase PostgreSQL name')
  return withClient(source.href, async db => {
    await db.query('begin isolation level repeatable read read only')
    const { rows: [snapshot] } = await db.query('select pg_catalog.pg_export_snapshot() as id')
    const before = await timed('source counts and audit hash', log, () => manifest(db, schema))
    await timed('pg_dump', log, () => postgresTool('pg_dump', source, archive, ['--format=custom', `--schema=${schema}`, `--snapshot=${snapshot.id}`, `--file=${archive}`]))
    await db.query('commit')
    return before
  })
}

export async function restoreAndVerify(env: Env, archive: string, before: Manifest, log: Log) {
  const target = databaseUrl(env.DATABASE_URL, 'target')
  if (env.GRAPH_SCHEMA !== before.schema) throw new Error('The target schema must match the schema in the archive')
  if (env.GRAPH_SCHEMA === 'public') {
    await withClient(target.href, requireEmpty)
  } else {
    await withClient(target.href, async db => {
      const { rowCount } = await db.query('select from pg_catalog.pg_namespace where nspname = $1', [env.GRAPH_SCHEMA])
      if (rowCount) throw new Error('The target graph schema already exists')
    })
  }
  await timed('pg_restore', log, () => postgresTool('pg_restore', target, archive, ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error', archive]))
  await timed('verify', log, () => command(env, ['verify'], line => {
    const { changes, policy } = JSON.parse(line)
    if (changes.length || policy.due) throw new Error(`verify found ${changes.length} cluster changes, policy due: ${policy.due}`)
    log('verify: 0 cluster changes, policy current')
  }))
  await timed('compare counts and audit hash', log, () => withClient(target.href, async db => {
    await db.query('begin isolation level repeatable read read only')
    const after = await manifest(db, env.GRAPH_SCHEMA!)
    for (const name of new Set([...before.counts.keys(), ...after.counts.keys()])) {
      if (before.counts.get(name) !== after.counts.get(name)) throw new Error(`Count differs for ${name}: source ${before.counts.get(name) ?? 'absent'}, restored ${after.counts.get(name) ?? 'absent'}`)
    }
    if (before.auditHash !== after.auditHash) throw new Error('The newest audit hashes differ')
    await db.query('commit')
  }))
  log(`${before.counts.size} table counts match, newest audit hash: ${before.auditHash ?? 'none'}`)
}

export async function restoreCheck(env: Env, log: Log = console.log) {
  const source = databaseUrl(env.DATABASE_URL, 'DATABASE_URL')
  const target = databaseUrl(env.NEW_DATABASE_URL, 'NEW_DATABASE_URL')
  const schema = env.GRAPH_SCHEMA || 'account_graph'
  // The command opens the graph without workers. Its edge token is required by the server config but never served.
  const verify = { DATABASE_URL: target.href, GRAPH_SCHEMA: schema, GRAPH_TOKEN: 'local-restore-check', RECEIPT_SECRETS: env.RECEIPT_SECRETS, LINK_SECRET: env.LINK_SECRET, IDENTIFIER_SECRET: env.IDENTIFIER_SECRET, POLICY: env.POLICY, POLICY_FILE: env.POLICY_FILE }
  configFrom(verify)
  await withClient(target.href, async db => {
    await timed('check empty target', log, async () => {
      // Reserve the target against another rehearsal until this session closes, including while the source is being dumped.
      const { rows: [lock] } = await db.query("select pg_catalog.pg_try_advisory_lock(0, pg_catalog.hashtext('account-graph restore-check')) as held")
      if (!lock.held) throw new Error('Another restore rehearsal holds the target database')
      await requireEmpty(db)
    })
    const dir = await mkdtemp(join(tmpdir(), 'ag-restore-'))
    try {
      const archive = join(dir, 'graph.dump')
      const before = await capture(source, schema, archive, log)
      // A long dump gives another operator time to have picked the same target.
      await timed('recheck empty target', log, () => requireEmpty(db))
      await restoreAndVerify(verify, archive, before, log)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await restoreCheck(process.env)
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
