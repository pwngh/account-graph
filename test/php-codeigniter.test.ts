import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const probe = spawnSync('php', ['-r', "exit(extension_loaded('pdo_sqlite') ? 0 : 1);"])
const skip = probe.error ? 'php is not on the PATH' : probe.status !== 0 ? 'pdo_sqlite is not loaded' : false

test('the PHP guide shows how to link decisions for one pair across a repair', () => {
  const guide = readFileSync(join(root, 'docs/php.md'), 'utf8')
  const guidance = guide.split(/\n\s*\n/).find(p => p.includes('`decide`') && p.includes('`depends_on`'))
  assert.ok(guidance, 'the pair must carry an explicit decision dependency')
  for (const term of ['pair', 'merge', 'unmerge', 'split', 'unsplit', 'repair', 'older', 'newer', 'profile', 'at']) assert.match(guidance, new RegExp('\\b' + term + '\\b', 'i'))
  assert.match(guide, /->enqueue\(\s*\$\w+,\s*'decide',\s*\$\w+,\s*\$\w+\s*\)/)
})

test('a restarted CI3 worker sends merge before unmerge and split before unsplit after repair', { skip }, async t => {
  const app = mkdtempSync(join(root, '.ci-outbox-'))
  t.after(() => rmSync(app, { recursive: true, force: true }))
  mkdirSync(join(app, 'application'))
  symlinkSync(join(root, 'examples/php'), join(app, 'application/third_party'))
  const graph = accountGraph({ memory: true })
  const edge = createEdge(graph, { token: 'synthetic-test', limit: false })
  const server = createServer(edge).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closed
    await edge.drain()
    await graph.close()
  })
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const fixture = join(root, 'test/fixtures/php/codeigniter.php')
  const run = async (stage: 'queue' | 'repair') => {
    const { stdout, stderr } = await promisify(execFile)('php', [fixture, app, 'pdo_mysql', stage, join(app, 'outbox.sqlite'), url], { timeout: 10_000 })
    assert.equal(stderr, '')
    return JSON.parse(stdout) as { id: number; item_key: string; depends_on: number | null; state: string; answer: string }[]
  }
  const subjects = ['contact:0', 'contact:1', 'contact:2', 'contact:3']
  const { results } = await graph.record({ entries: subjects.map((subject, i) => ({ type: 'profile', subject, key: 'profile-' + i, at: 500, facts: { email: 'row' + i + '@example.org' } })) })
  assert.ok(results.every(row => row.ok))
  const parked = await run('queue')
  assert.deepEqual(parked.map(row => [row.item_key, row.state, row.depends_on]), [['merge', 'failed', null], ['unmerge', 'blocked', parked[0]!.id], ['split', 'failed', null], ['unsplit', 'blocked', parked[2]!.id]])
  assert.equal((await graph.lookup({ kind: 'person', subjects, at: 2000 })).decisions, 0)
  const sent = await run('repair')
  assert.deepEqual(sent.map(row => [row.state, JSON.parse(row.answer).value.recorded]), Array(4).fill(['sent', 1]))
  for (const [subject, expected] of [['contact:0', ['join', 'unjoin']], ['contact:2', ['separate', 'rejoin']]] as const) {
    const { entries } = await graph.lookup({ kind: 'journey', subject })
    const decisions = entries.filter(entry => entry.kind === 'decision').sort((a, b) => a.decision - b.decision)
    assert.deepEqual(decisions.map(entry => entry.action), expected)
  }
})

test('the CI3 model uses the host transaction and query builder with mysqli and PDO connections', { skip }, () => {
  const app = mkdtempSync(join(root, '.ci-outbox-'))
  try {
    mkdirSync(join(app, 'application'))
    symlinkSync(join(root, 'examples/php'), join(app, 'application/third_party'))
    const fixture = join(root, 'test/fixtures/php/codeigniter.php')
    for (const driver of ['mysqli', 'pdo_mysql', 'pdo_pgsql']) {
      const result = spawnSync('php', ['-d', 'zend.exception_ignore_args=0', '-d', 'zend.exception_string_param_max_len=1024', fixture, app, driver], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.equal(result.stdout.trim(), 'ok')
    }
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
})

test('the documented PostgreSQL outbox upgrade scrubs sent requests and requeues interrupted service writes', { skip: !process.env.DATABASE_URL && 'DATABASE_URL is not set' }, async () => {
  const { Client } = await import('pg')
  const { randomUUID } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  const db = new Client({ connectionString: process.env.DATABASE_URL! })
  const schema = 'ag_host_' + randomUUID().replaceAll('-', '')
  const docs = await readFile(join(root, 'docs/php.md'), 'utf8')
  const migration = docs.match(/\*\*PostgreSQL upgrade\*\*\s+`{3}sql\n([^]*?)\n`{3}/)?.[1]
  assert.ok(migration, 'an installed host needs the upgrade SQL')
  await db.connect()
  let owned = false
  try {
    await db.query('CREATE SCHEMA ' + schema)
    owned = true
    await db.query('SET search_path TO ' + schema)
    await db.query("CREATE TABLE account_graph_outbox (id BIGSERIAL PRIMARY KEY, record_id text NOT NULL, call_name text NOT NULL, request text NOT NULL, state text DEFAULT 'pending', answer text)")
    for (const [call, state, code] of [['record', 'sent', ''], ['forget', 'failed', 'AUTH.REJECTED'], ['record', 'failed', 'INPUT.MALFORMED']] as const) {
      const write = call === 'record' ? { entries: [{ type: 'profile', key: 'profile-key', facts: { email: 'row17@example.org' } }] } : { key: 'erasure-key' }
      await db.query('INSERT INTO account_graph_outbox(record_id, call_name, request, state, answer) VALUES ($1,$2,$3,$4,$5)', ['contact:17', call, JSON.stringify(write), state, JSON.stringify(code ? { fault: { code } } : { results: [] })])
    }
    // The first outbox accepted keys over 200 characters and entries missing their type.
    const malformedKey = 'k'.repeat(201)
    await db.query('INSERT INTO account_graph_outbox(record_id, call_name, request, state, answer) VALUES ($1,$2,$3,$4,$5)', ['contact:17', 'record', JSON.stringify({ entries: [{ key: malformedKey, at: 17 }] }), 'failed', JSON.stringify({ fault: { code: 'INPUT.MALFORMED' } })])
    await db.query(migration)
    const { rows } = await db.query('SELECT state, request, item_key, item_kind, answer, created_at, depends_on FROM account_graph_outbox ORDER BY id')
    assert.deepEqual(rows.map(r => [r.state, r.item_key, r.item_kind, r.request === null]), [['sent', 'profile-key', 'profile', true], ['pending', 'erasure-key', 'forget', false], ['failed', 'profile-key', 'profile', false], ['failed', malformedKey, 'record', false]])
    assert.deepEqual(JSON.parse(rows[0].answer), { results: [] })
    assert.ok(rows.every(r => r.created_at && r.depends_on === null))
  } finally {
    try {
      if (owned) {
        await db.query('ROLLBACK')
        await db.query('DROP SCHEMA ' + schema + ' CASCADE')
      }
    } finally {
      await db.end()
    }
  }
})
