import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AccountGraph, DecideRequest, LookupRequest, RecordEntry, ReportRequest } from '../src/index.ts'
import { createEdge } from '../src/edge/index.ts'

const reviewReads = ['me', 'subject', 'ops', 'pulse', 'clusters', 'recent', 'journey', 'policy', 'decisions', 'disputes', 'audit', 'texts', 'calls', 'calls/summary', 'between', 'undecided', 'board', 'followed', 'report', 'conversions']
const reviewWrites = ['ignore', 'forget', 'join', 'find', 'foresee', 'separate', 'retry']
const at = 1790000000000
const subject = 'contact:guard'
const window = { from: '2026-01-01', to: '2026-01-02', timeZone: 'UTC' }

export async function tokenRoutes(local: AccountGraph) {
  const graph = createEdge(local, {
    token: 'root-key', reviewers: { dana: ['desk-key', 'old-key'] },
    serviceTokens: [
      { name: 'intake', token: 'intake-key', calls: { record: ['profile', 'call_update'], decide: ['split'], lookup: ['party'], report: ['calls'] } },
      { name: 'corrections', token: 'corrections-key', calls: { decide: ['withdraw'] } },
      { name: 'full', token: 'full-key', calls: { record: true, decide: true, forget: true, lookup: true, report: true, events: true } },
      { name: 'closed', token: 'closed-key', calls: {} },
    ],
    origins: ['https://example.org'], textCodes: true, twilio: { authToken: 'callback-key', calls: 'https://example.org/calls/twilio', texts: 'https://example.org/texts/twilio' },
  })
  const server = createServer(graph).listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  async function ask(token: string, path: string, method = 'POST', body?: unknown) {
    const answer = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + token }, ...(method === 'POST' && { body: JSON.stringify(body ?? {}) }) })
    const content = await answer.text()
    return { status: answer.status, value: answer.headers.get('content-type')?.includes('application/json') ? JSON.parse(content) : null }
  }
  const log: string[] = []
  const info = console.info
  console.info = line => log.push(String(line))
  try {
    for (const [n, key] of ['root-key', 'desk-key', 'old-key', 'intake-key', 'corrections-key', 'full-key', 'closed-key', 'wrong'].entries()) {
      const root = key === 'root-key'
      const reviewer = key === 'desk-key' || key === 'old-key'
      const intake = key === 'intake-key'
      const corrections = key === 'corrections-key'
      const full = key === 'full-key'
      const refused = key === 'wrong' ? 401 : 403
      const by = reviewer ? 'dana' : full ? 'system:full' : corrections ? 'system:corrections' : 'system:intake'
      const call = (name: string, body: unknown) => ask(key, '/v1/' + name, 'POST', body)
      for (const [method, names] of [['GET', reviewReads], ['POST', reviewWrites]] as const) {
        for (const name of names) {
          const { status } = await ask(key, '/review/api/' + name, method)
          // A named service that may read events may also ask whether anything has changed. That is the one route of the screen it opens.
          if (root || reviewer || (full && method === 'GET' && name === 'pulse')) assert.ok(![401, 403].includes(status), name + ' ' + key)
          else assert.equal(status, refused, name + ' ' + key)
        }
      }
      for (const path of ['/health', '/collect.js', '/fingerprint.js']) assert.equal((await ask(key, path, 'GET')).status, 200, path)
      for (const path of ['/collect', '/carry', '/event', '/text-code', '/number', '/calls/twilio', '/texts/twilio']) assert.equal((await ask(key, path)).status, 403, path)
      for (const path of ['/metrics', '/stats', '/observe', '/v1/other']) assert.equal((await ask(key, path)).status, 404, path)
      assert.equal((await ask(key, '/review', 'GET')).status, 404)
      assert.equal((await ask(key, '/v1/record', 'GET')).status, 405)
      const fields = { at, key: 'entry-' + n }
      const entries: RecordEntry[] = [
        { ...fields, type: 'profile', subject, facts: { email: 'guard@example.org' } }, { ...fields, type: 'arrival', subject }, { ...fields, type: 'cost', rows: [{ day: window.from, source: 'example', amount: 1, currency: 'USD' }] },
        { ...fields, type: 'conversion', subject, stage: 'sale' }, { ...fields, type: 'restatement', of: { type: 'conversion', key: 'absent' }, change: { kind: 'lead' } }, { ...fields, type: 'payment', conversion: 'payment', direction: 'received', amount: 1 },
        { ...fields, type: 'call', direction: 'inbound', to: '+12025550100' }, { ...fields, type: 'call_update', call: 'pending', change: { kind: 'party', role: 'unknown', by } },
        { ...fields, type: 'text', direction: 'inbound', from: '+12025550101', to: '+12025550100' }, { ...fields, type: 'consent', subject, consent: { adUserData: false, adPersonalization: false } },
        { ...fields, type: 'link', subject, url: 'https://example.org/', expires: at + 86400000 }, { ...fields, type: 'transfer', from: subject, to: 'contact:other', amount: 1 },
      ]
      for (const entry of entries) {
        const party = entry.type === 'call_update'
        const result = await call('record', { entries: [entry] })
        const allowed = root || full || (reviewer && party) || (intake && (party || entry.type === 'profile'))
        assert.equal(result.status, allowed || intake ? 200 : refused, key + ' ' + entry.type + ' ' + JSON.stringify(result.value))
        if (result.status === 200) assert.equal(result.value.results[0].reason === 'FORBIDDEN', !allowed)
      }
      for (const action of ['merge', 'unmerge', 'split', 'unsplit', 'mute', 'unmute'] as const) {
        const decision = { key: 'decision-' + n + '-' + action, at, by, action, ...(['mute', 'unmute'].includes(action) ? { fact: { email: 'guard@example.org' } } : { pairs: [{ a: subject, b: 'contact:other' }] }) } as DecideRequest
        assert.equal((await call('decide', decision)).status, root || full || reviewer || (intake && action === 'split') ? 200 : refused, action)
      }
      const withdrawal = { action: 'withdraw', key: 'withdraw-' + n, at, by, subject, fact: { email: 'guard@example.org' } }
      assert.equal((await call('decide', withdrawal)).status, root || full || corrections ? 200 : refused)
      for (const query of [
        { kind: 'person', subjects: [subject], at }, { kind: 'journey', subject }, { kind: 'find', text: subject }, { kind: 'match', facts: { email: 'guard@example.org' }, at }, { kind: 'caller', to: '+12025550100', at },
        { kind: 'party', call: 'pending' }, { kind: 'conflicts', subjects: [subject] }, { kind: 'record', type: 'call', key: 'missing', at }, { kind: 'transfers', subject },
      ] satisfies LookupRequest[]) assert.equal((await call('lookup', query)).status, root || full || (reviewer && ['journey', 'find', 'party'].includes(query.kind)) || (intake && query.kind === 'party') ? 200 : refused, query.kind)
      for (const query of [
        { kind: 'campaigns', window }, { kind: 'pipeline', days: 1, at }, { kind: 'calls', window, at }, { kind: 'callbacks', window, at }, { kind: 'texts', window, at },
        { kind: 'after_calls', window, step: 'sale', days: 1, at }, { kind: 'deliveries', state: 'sent' },
      ] satisfies ReportRequest[]) assert.equal((await call('report', query)).status, root || full || reviewer || (intake && query.kind === 'calls') ? 200 : refused, query.kind)
      assert.equal((await call('events', { after: null, limit: 10 })).status, root || full ? 200 : refused)
      assert.equal((await call('forget', { at, key: 'forget-' + n, subjects: ['contact:absent'], platforms: 'report', by })).status, root || full || reviewer ? 200 : refused)
    }
    const party = { type: 'call_update', at, key: 'spoof', call: 'guard', change: { kind: 'party', role: 'unknown', by: 'dana' } }
    const conversion = { type: 'conversion', at, key: 'exists', subject, stage: 'sale' }
    await local.record({ entries: [conversion as RecordEntry] })
    const profile = { type: 'profile', at, key: 'owned', subject, facts: { device: 'guard' } }
    const mixed = await ask('intake-key', '/v1/record', 'POST', { entries: [conversion, profile, { ...conversion, key: 'fresh' }, party, profile] })
    assert.deepEqual(mixed.value.results.map((row: any) => row.ok ? row.value.duplicate : row.reason), ['FORBIDDEN', false, 'FORBIDDEN', 'FORBIDDEN', true])
    const merge = { action: 'merge', key: 'merge-9', at, by: 'dana', pairs: [{ a: subject, b: 'contact:other' }] }
    assert.equal((await ask('root-key', '/v1/decide', 'POST', merge)).value.ok, true)
    const refused = async (name: string, body: object, key: string) => {
      const request = (key: string) => ask('intake-key', '/v1/' + name, 'POST', { ...body, key })
      const known = await request(key)
      assert.equal(known.status, 403)
      assert.deepEqual(known, await request('unused'))
    }
    await refused('decide', { ...merge, by: 'system:intake' }, 'merge-9')
    await refused('lookup', { kind: 'record', type: 'conversion', at }, 'exists')
    for (const token of ['root-key', 'intake-key']) {
      const conflict = await ask(token, '/v1/decide', 'POST', { ...merge, action: 'split', at: at + 1, by: 'system:intake' })
      assert.deepEqual(conflict.value, { ok: false, reason: 'KEY_REUSED', fields: ['action'] })
    }
    const otherType = await ask('intake-key', '/v1/record', 'POST', { entries: [{ ...profile, key: 'exists' }] })
    assert.equal(otherType.value.results[0].value.duplicate, false)
    const forget = { at, key: 'merge-9', by: 'system:full', subjects: ['contact:absent'], platforms: 'report' }
    assert.equal((await ask('full-key', '/v1/forget', 'POST', forget)).value.ok, true)
    await refused('forget', { ...forget, by: 'system:intake' }, 'merge-9')
    for (const name of ['decide', 'forget']) assert.equal((await ask('full-key', '/v1/' + name, 'POST', { by: 'dana' })).status, 403)
    assert.ok(log.includes('service intake requested record'))
    assert.doesNotMatch(log.join('\n'), /intake-key|corrections-key|full-key|closed-key/)
  } finally {
    console.info = info
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
