import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'
import { accountGraph } from '../src/index.ts'
import type { AccountGraph, RecordEntry } from '../src/index.ts'
import { restoreCheck } from '../tools/restore-check.ts'

const url = process.env.DATABASE_URL
const secret = 'restore-rehearsal-fixture'.repeat(2)
const people = 240

async function history(graph: AccountGraph) {
  const start = Date.now() - 86_400_000
  for (let i = 0; i < people; i++) {
    const at = start + i * 100
    const subject = 'contact:' + i
    const phone = '+1' + [202, 206, 212][Math.floor(i / 100)] + '55501' + String(i % 100).padStart(2, '0')
    const line = '+13035550100'
    const key = 'row-' + i
    const entries: RecordEntry[] = [
      { type: 'profile', key, at, subject, facts: { email: `contact-${i}@example.org`, phone } },
      { type: 'arrival', key, at, subject, source: 'search', campaignId: key },
      { type: 'cost', key, at, rows: [{ day: new Date(at).toISOString().slice(0, 10), source: 'search', campaignId: key, amount: 3, currency: 'USD' }] },
      { type: 'conversion', key, at, subject, stage: 'completed', value: 20, currency: 'USD' },
      { type: 'restatement', key, at: at + 1, of: { type: 'conversion', key }, change: { kind: 'correct', value: 18, currency: 'USD' } },
      { type: 'payment', key, at: at + 2, conversion: key, direction: 'received', amount: 18, currency: 'USD' },
      { type: 'call', key, at, direction: 'inbound', from: phone, to: line, duration: 60, result: { answered: false } },
      { type: 'call_update', key, at: at + 3, call: key, change: { kind: 'returned', reachedAt: at + 2 } },
      { type: 'text', key, at, direction: 'inbound', from: phone, to: line, text: 'hello' },
      { type: 'consent', key, at, subject, consent: { adUserData: false, adPersonalization: false } },
      { type: 'link', key, at, subject, url: 'https://example.org/contact', expires: at + 86_400_000 },
      { type: 'transfer', key, at, from: subject, to: 'contact:' + ((i + 1) % people), amount: 3, asset: 'usd' },
    ]
    const { results } = await graph.record({ entries })
    for (const item of results) assert.ok(item.ok, JSON.stringify(item))
  }
  assert.ok((await graph.decide({ key: 'merge', at: start + 30_000, by: 'staff', action: 'merge', pairs: [{ a: 'contact:2', b: 'contact:3' }] })).ok)
}

test('the backup runbook runs both recovery commands on the restored database from an installation or checkout', async () => {
  const docs = await readFile(new URL('../docs/operations.md', import.meta.url), 'utf8')
  const backups = docs.split('\n## Backups\n')[1]!.split('\n## ')[0]!
  const commands = ['verify', 'events new-epoch']
  const installed = commands.map(cmd => 'DATABASE_URL="$NEW_DATABASE_URL" account-graph ' + cmd).join('\n')
  const checkout = commands.map(cmd => 'DATABASE_URL="$NEW_DATABASE_URL" node src/bin.ts ' + cmd).join('\n')
  assert.ok(backups.includes(installed))
  assert.ok(backups.indexOf(checkout) > backups.indexOf(installed))
})

test('restores every graph table and the latest audit decision from a PostgreSQL snapshot', { skip: !url ? 'set DATABASE_URL to run the restore rehearsal' : (spawnSync('pg_dump', ['--version']).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'pg_dump is missing from PATH' : false }, async () => {
  const schema = 'ag_restore_' + randomBytes(10).toString('hex')
  const original = schema + '_source'
  const env = { DATABASE_URL: url!, NEW_DATABASE_URL: url!, GRAPH_SCHEMA: schema, RECEIPT_SECRETS: secret, GRAPH_TOKEN: 'fixture', LINK_SECRET: secret }
  const db = new pg.Client({ connectionString: url! })
  const lines: string[] = []
  const log = (line: string) => { lines.push(line) }
  let owned = false
  try {
    await db.connect()
    await db.query('begin')
    await db.query(`create schema ${schema}`)
    // pg_dump carries this mark to the restored schema. Cleanup checks it before dropping either name.
    await db.query(`comment on schema ${schema} is '${schema}'`)
    await db.query('commit')
    owned = true
    const graph = accountGraph({ databaseUrl: url!, schema, receiptSecrets: [secret], linkSecret: secret, workers: false })
    try {
      await history(graph)
    } finally {
      await graph.close()
    }
    await assert.rejects(restoreCheck(env, log), /target database is not empty/)
    await db.query(`create table ${schema}."extra table" (example text)`)
    await db.query(`insert into ${schema}."extra table" values ('one')`)
    const { rows: [receipt] } = await db.query(`select count(*)::int as n from ${schema}.receipt`)
    const { rows: [audit] } = await db.query(`select hash from ${schema}.decision order by seq desc limit 1`)
    const { rows: [tables] } = await db.query('select count(*)::int as n from pg_catalog.pg_tables where schemaname = $1', [schema])
    assert.equal(receipt.n, people * 12 + 1)
    assert.match(audit.hash, /^[0-9a-f]{64}$/)

    // Leaving the source in place must stop the restore before pg_restore can write to it.
    await assert.rejects(restoreCheck(env, log, { vacant: original, archiveReady: async () => {} }), /target graph schema already exists/)
    lines.length = 0
    await restoreCheck(env, log, {
      vacant: original,
      async archiveReady() {
        const { rows: [lock] } = await db.query("select pg_try_advisory_lock(0, hashtext('account-graph restore-check')) as held")
        assert.equal(lock.held, false)
        await db.query('begin')
        // This committed change is newer than the archive. The rehearsal must compare against the captured snapshot.
        await db.query(`insert into ${schema}."extra table" values ('two')`)
        await db.query(`alter schema ${schema} rename to ${original}`)
        await db.query('commit')
      },
    })
    assert.deepEqual(lines.map(line => line.replace(/: \d+ ms$/, '')), ['check empty target', 'source counts and audit hash', 'pg_dump', 'recheck empty target', 'pg_restore', 'verify: 0 cluster changes, policy current', 'verify', 'compare counts and audit hash', `${tables.n} table counts match, newest audit hash: ${audit.hash}`])
    assert.deepEqual((await db.query(`select example from ${schema}."extra table"`)).rows, [{ example: 'one' }])
    assert.deepEqual((await db.query(`select example from ${original}."extra table" order by example`)).rows, [{ example: 'one' }, { example: 'two' }])
  } finally {
    try {
      if (owned) {
        await db.query('rollback')
        const marked = await db.query("select nspname from pg_catalog.pg_namespace where nspname = any($1) and pg_catalog.obj_description(oid, 'pg_namespace') = $2", [[schema, original], schema])
        for (const row of marked.rows) await db.query(`drop schema ${row.nspname} cascade`)
      }
    } finally {
      await db.end()
    }
  }
})
