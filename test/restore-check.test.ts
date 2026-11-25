import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { accountGraph } from '../src/index.ts'
import type { AccountGraph, RecordEntry } from '../src/index.ts'
import { capture, restoreAndVerify, restoreCheck } from '../tools/restore-check.ts'

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

test('restores every graph table and the latest audit decision from a PostgreSQL snapshot', { skip: !url ? 'set DATABASE_URL to run the restore rehearsal' : (spawnSync('pg_dump', ['--version']).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'pg_dump is missing from PATH' : false }, async () => {
  const schema = 'ag_restore_' + randomBytes(10).toString('hex')
  const original = schema + '_source'
  const env = { DATABASE_URL: url!, GRAPH_SCHEMA: schema, RECEIPT_SECRETS: secret, GRAPH_TOKEN: 'fixture', LINK_SECRET: secret }
  const dir = await mkdtemp(join(tmpdir(), 'ag-test-restore-'))
  const archive = join(dir, 'graph.dump')
  const db = new pg.Client({ connectionString: url! })
  const lines: string[] = []
  const log = (line: string) => { lines.push(line) }
  let owned = false
  try {
    await db.connect()
    // Claim both names before cleanup can drop either schema.
    await db.query('begin')
    await db.query(`create schema ${schema}`)
    await db.query(`create schema ${original}`)
    await db.query('commit')
    owned = true
    const graph = accountGraph({ databaseUrl: url!, schema, receiptSecrets: [secret], linkSecret: secret, workers: false })
    try {
      await history(graph)
    } finally {
      await graph.close()
    }
    await assert.rejects(restoreCheck({ ...env, NEW_DATABASE_URL: url }, log), /target database is not empty/)
    await db.query(`create table ${schema}."extra table" (example text)`)
    await db.query(`insert into ${schema}."extra table" values ('one')`)
    const before = await capture(new URL(url!), schema, archive, log)
    assert.equal(before.counts.get('extra table'), '1')
    assert.equal(before.counts.get('receipt'), String(people * 12 + 1))
    await assert.rejects(restoreAndVerify(env, archive, before, log), /target graph schema already exists/)
    assert.match(before.auditHash ?? '', /^[0-9a-f]{64}$/)

    // pg_restore keeps original schema names. Move only this test's source aside so the copy fits in the caller's database.
    await db.query('begin')
    await db.query(`drop schema ${original}`)
    await db.query(`alter schema ${schema} rename to ${original}`)
    await db.query('commit')
    await restoreAndVerify(env, archive, before, log)
    assert.ok(lines.some(line => line === 'verify: 0 cluster changes, policy current'))
    assert.ok(lines.some(line => line === `${before.counts.size} table counts match, newest audit hash: ${before.auditHash}`))
    assert.deepEqual((await db.query(`select example from ${schema}."extra table"`)).rows, [{ example: 'one' }])
  } finally {
    try {
      if (owned) {
        await db.query('rollback')
        await db.query(`drop schema if exists ${schema} cascade`)
        await db.query(`drop schema if exists ${original} cascade`)
      }
    } finally {
      try {
        await db.end()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
})
