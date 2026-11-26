import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const probe = spawnSync('php', ['-r', "exit(extension_loaded('pdo_sqlite') ? 0 : 1);"])
const skip = probe.error ? 'php is not on the PATH' : probe.status !== 0 ? 'pdo_sqlite is not loaded' : false

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
