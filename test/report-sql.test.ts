import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReportRequest } from '../src/contract/api.ts'
import { createEngine } from '../src/core/engine.ts'
import { createReceipts } from '../src/core/receipts.ts'
import { createSix } from '../src/core/six.ts'
import { createPostgresStore } from '../src/store/postgres.ts'

const at = Date.UTC(2026, 0, 30, 12)
const window = { from: '2026-01-01', to: '2026-01-30', timeZone: 'UTC' }
const reports: ReportRequest[] = [
  { kind: 'campaigns', window }, { kind: 'pipeline', at, days: 30 }, { kind: 'calls', window, at }, { kind: 'callbacks', window, at },
  { kind: 'texts', window, at }, { kind: 'after_calls', window, at, step: 'sale', days: 30 }, { kind: 'deliveries', state: 'failed' },
]

// Ten thousand outcomes exercise the large shared-identifier query. Two people share an email and an arrival.
function fixture() {
  const outcomes = Array.from({ length: 10_000 }, (_, i) => ({
    subject: 'record:' + i, transaction_id: 'sale-' + i, at: at - (10_000 - i) * 240_000, stage: 'sale', value: 5, currency: 'USD', tags: null,
  }))
  const call = { id: 'miss', direction: 'inbound', subject: outcomes[0]!.subject, at: at - 20_000, dialed: '+12025550101', duration: 0, flags: [], visitor: null, tags: null, recorded_at: at, answered: false, voicemail: null, waited: null, returned_at: null, result_at: at }
  const message = { id: 'text', direction: 'inbound', subject: outcomes[1]!.subject, at: at - 20_000, ours: '+12025550101', flags: [], visitor: null, tags: null, recorded_at: at }
  const joined = [outcomes[0]!.subject, outcomes[1]!.subject]
  const email = 'email:desk@example.org'
  const edge = (subject: string) => ({ subject, identifier: joined.includes(subject) ? email : 'email:' + subject.slice(7) + '@example.org', first_at: at - 30 * 86_400_000, last_at: at - 30 * 86_400_000, sightings: 1 })
  const touch = { subject: joined[0]!, at: outcomes[0]!.at - 100, detail: { gclid: 'sample', campaign: 'January' } }
  function answer(sql: string, values: unknown[]) {
    const ids = new Set(Array.isArray(values[0]) ? values[0] as string[] : [])
    if (sql.startsWith('select * from stub.outcome where at')) return outcomes
    if (sql.startsWith('select * from stub.outcome where subject')) return outcomes.filter(row => ids.has(row.subject))
    if (sql.includes('as newest where n')) return outcomes.slice(-200).reverse()
    if (sql.startsWith('with theirs as')) return outcomes.map(row => ({ ...row, most: 5, refunded: 0, written_off: 0, lost_in: [] }))
    if (sql.startsWith('select distinct c.subject')) return [{ subject: call.subject }]
    if (sql.includes('from stub.call c left join stub.call_result')) return ids.size && !ids.has(call.subject) && !ids.has(call.id) ? [] : [call]
    if (sql.includes('distinct on (m.subject)') || (sql.startsWith('select * from stub.message where subject') && ids.has(message.subject))) return [message]
    if (sql.startsWith('select subject, at, detail from stub.touch')) {
      const bySubject = sql.includes('where subject')
      const [from, to] = values.slice(bySubject ? 1 : 0) as number[]
      return (!bySubject || ids.has(touch.subject)) && from! <= touch.at && touch.at <= to! ? [touch] : []
    }
    if (sql.startsWith('select id, component, cluster')) {
      if (sql.includes('where component') && joined.some(id => ids.has(id))) joined.forEach(id => ids.add(id))
      return [...ids].map(id => ({ id, component: joined.includes(id) ? joined[0] : id, cluster: joined.includes(id) ? joined[0] : id }))
    }
    if (sql.startsWith('select * from stub.edge where subject')) return [...ids].map(edge)
    if (sql.startsWith('select * from stub.edge where identifier')) return ids.has(email) ? joined.map(edge) : []
    if (sql.startsWith('select id, fanout, ignored')) return [...ids].map(id => ({ id, fanout: id === email ? 2 : 1, ignored: false }))
    if (sql.startsWith('select id, fanout, case') && joined.some(id => ids.has(id))) return [{ id: email, fanout: 2 }]
    if (sql.startsWith('select writes from')) return [{ writes: 1 }]
    return []
  }
  const statements: string[] = []
  let rows = 0
  const query = async (sql: string, values: unknown[] = []) => {
    const found = answer(sql, values)
    statements.push(sql)
    rows += found.length
    return { rows: found }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
  const target = { name: 'test', keys: () => ({}), click: () => undefined, deliver: async () => ({}), retryable: () => false, batch: 10 }
  const engine = createEngine(store, { now: () => at, stages: { sale: {} }, delivery: { targets: [target] } })
  const six = createSix(engine, { receipts: createReceipts(['r'.repeat(32)]) })
  return { six, statements, count: () => [statements.length, rows] }
}

test('cold reports read base identifiers and probe once in each snapshot that needs them', async () => {
  for (const request of reports) {
    const { six, statements, count } = fixture()
    const answer = await six.report(request)
    assert.ok(answer.value)
    // Includes transaction control and the two party revision reads around cacheable reports.
    const budget = {
      campaigns: [33, 60_208], pipeline: [34, 30_269], calls: [16, 4], callbacks: [20, 17],
      texts: [20, 17], after_calls: [19, 8], deliveries: [1, 0],
    }
    assert.deepEqual(count(), budget[request.kind], request.kind)
    assert.ok(statements.every(sql => !sql.includes('match_identifier')), request.kind)
    const probes = statements.filter(sql => sql.includes('call_evidence'))
    assert.equal(probes.length, Number(['campaigns', 'pipeline', 'callbacks', 'texts'].includes(request.kind)), request.kind)
    assert.ok(probes.every(sql => sql === 'select from stub.call_evidence limit 1'))
  }
})

test('concurrent identifier reads share a probe, and each later snapshot checks again', async () => {
  let reserved = false
  const statements: string[] = []
  const query = async (sql: string) => {
    statements.push(sql)
    return { rows: sql === 'select from stub.call_evidence limit 1' && reserved ? [{}] : [] }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
  const many = Array.from({ length: 2000 }, (_, i) => 'record:' + i)
  for (const any of [false, true, false]) {
    reserved = any
    statements.length = 0
    await store.read(async tx => {
      const [, , , has] = await Promise.all([tx.states(['dial:one']), tx.shared(many), tx.matchingEdges(many), tx.hasCallEvidence()])
      assert.equal(has, any)
      await tx.callEvidence({ subjects: many })
      await tx.callVisitors(['one'])
      await tx.builtWith()
    })
    assert.equal(statements[0], 'begin isolation level repeatable read read only')
    assert.equal(statements.at(-1), 'commit')
    assert.equal(statements.filter(sql => sql === 'select from stub.call_evidence limit 1').length, 1)
    const withEvidence = statements.filter(sql => sql.includes('call_evidence') && !sql.endsWith('limit 1'))
    if (any) {
      assert.equal(withEvidence.length, 5)
      assert.ok(withEvidence.some(sql => sql.startsWith('with wanted as materialized (select distinct identifier as id from stub.edge where subject = any(')))
      assert.ok(withEvidence.some(sql => sql.startsWith('with wanted as materialized (select distinct unnest(')))
    } else assert.deepEqual(withEvidence, [])
  }
})
