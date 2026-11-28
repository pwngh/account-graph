import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { accountGraph } from '../src/index.ts'
import { createEngine } from '../src/core/engine.ts'
import { createReceipts } from '../src/core/receipts.ts'
import { createSix } from '../src/core/six.ts'
import { defaultPolicy, policyHash } from '../src/core/policy.ts'
import { createPostgresStore } from '../src/store/postgres.ts'
import { createEdge } from '../src/edge/index.ts'
import { internalsOf } from '../src/client/internals.ts'
import { twilioSignature } from '../src/providers/twilio.ts'

const at = 1_790_000_000_000
const entry = { type: 'call', key: 'call-1', direction: 'inbound', at, from: '+12025550123', to: '+12025550180', duration: 60 } as const
const address = 'https://example.org/calls/twilio'

// Report one call on a graph already marked with this policy, before anyone has called, tapped or named a party.
function fixture() {
  const statements: string[] = []
  let call: Record<string, unknown> | undefined
  let outcome: Record<string, unknown> | undefined
  const edges = new Map<string, { subject: string; identifier: string; first_at: number; last_at: number; sightings: number }>()
  function answer(sql: string, values: any[]) {
    if (sql.includes('from stub.built')) return [{ policy: policyHash(defaultPolicy), reserved: false }]
    if (sql.startsWith('insert into stub.call (')) {
      const [id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags] = values
      call = { id, subject, at, dialed, duration, flags, visitor, recorded_at, direction, tags, result_at: null, party: null }
    }
    if (sql.includes('from stub.call c left join stub.call_result') && call) return [call]
    if (sql.startsWith('select coalesce(line_subject, subject) as line') && call) return [{ line: call.subject }]
    if (sql.startsWith('insert into stub.outcome (')) {
      const [transaction_id, subject, at, stage, value, currency, tags] = values
      outcome = { transaction_id, subject, at, stage, value, currency, tags }
    }
    if (sql.startsWith('select * from stub.outcome where transaction_id') && outcome) return [outcome]
    if (sql.startsWith('with upserted as')) {
      const [[subject], [identifier], [first_at], [last_at], [sightings]] = values
      edges.set(identifier, { subject, identifier, first_at, last_at, sightings })
      return [{ identifier, added: 1 }]
    }
    if (sql.startsWith('select id, fanout, ignored')) return [...edges.keys()].filter(id => values[0].includes(id)).map(id => ({ id, fanout: 1, ignored: false }))
    if (sql.startsWith('select * from stub.edge where identifier') || sql.startsWith('with active as')) return [...edges.values()].filter(e => values[0].includes(e.identifier))
    if (sql.startsWith('select * from stub.edge where subject')) return [...edges.values()].filter(e => values[0].includes(e.subject))
    if (sql.startsWith('select id, component, cluster')) return [...new Set([...edges.values()].map(e => e.subject))].filter(id => values[0].includes(id)).map(id => ({ id, component: id, cluster: id }))
    return []
  }
  const query = async (sql: string, values: any[] = []) => {
    statements.push(sql)
    return { rows: answer(sql, values) }
  }
  const store = createPostgresStore({ query, connect: async () => ({ query, release() {} }) }, 'stub')
  return { store, statements, saved: () => [call?.id, outcome?.transaction_id, edges.size] }
}

async function callback(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const fields = { CallSid: entry.key, From: entry.from, To: entry.to, CallStatus: 'completed', CallDuration: '60', Timestamp: new Date(at + 60_000).toUTCString() }
  const request = Object.assign(Readable.from([Buffer.from(new URLSearchParams(fields).toString())]), {
    method: 'POST', url: '/calls/twilio', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-twilio-signature': twilioSignature('test', address, fields) },
  }) as unknown as IncomingMessage
  let status: number | undefined
  const response = {
    writeHead(code: number) {
      status = code
      return this
    },
    end() {},
  }
  await handler(request, response as unknown as ServerResponse)
  assert.equal(status, 204)
}

test('a signed callback and a recorded call use the same SQL write budget', async () => {
  for (const path of ['callback', 'record']) {
    const { store, statements, saved } = fixture()
    const now = () => at + 60_000
    const graph = accountGraph({ memory: true, workers: false, now })
    try {
      const local = await internalsOf(graph)!()
      local.engine = createEngine(store, { now })
      local.six = createSix(local.engine, { receipts: createReceipts(['r'.repeat(32)]) })
      if (path === 'callback') await callback(createEdge(graph, { token: 'service', twilio: { authToken: 'test', calls: address } }))
      else {
        const [result] = (await graph.record({ entries: [entry] })).results
        assert.ok(result?.ok && result.type === 'call' && result.value.counted)
      }
    } finally {
      await graph.close()
    }
    assert.deepEqual(saved(), [entry.key, 'call:' + entry.key, 2])
    // The final trip increments the write counter and commits in two SQL statements.
    const sql = statements.flatMap(query => query.split(';').filter(part => part.trim()))
    // One of them keeps the caller's number beside its hash, and one says the call arrived.
    assert.ok(sql.length <= 53, `${path}: ${sql.length} statements in ${statements.length} trips`)
  }
})
