import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createForwarder, createTracker, signed, toCall } from '../examples/call-tracking.ts'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'

const KEY = 'a made-up key'
const said = { id: 444, customer_phone_number: '+15550100142', tracking_phone_number: '+15550100101', start_time: '2026-11-24T09:04:00.000-06:00', duration: '95', answered: false, voicemail: false, direction: 'inbound' }
const sign = (raw: string) => createHmac('sha1', KEY).update(raw).digest('base64')
const at = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

test('a call of a tracking service becomes one the server takes', () => {
  assert.deepEqual(toCall(said), { call: { type: 'call', key: 'callrail-444', at: Date.parse('2026-11-24T15:04:00Z'), direction: 'inbound', from: '+15550100142', to: '+15550100101', duration: 95, result: { answered: false } } })
  assert.deepEqual(toCall({ ...said, direction: 'outbound', answered: true }), { call: { type: 'call', key: 'callrail-444', at: Date.parse('2026-11-24T15:04:00Z'), direction: 'outbound', from: '+15550100101', to: '+15550100142', duration: 95 } })
  // Voicemail is not an answer, and what is not known is not said.
  const { call } = toCall({ ...said, answered: true, voicemail: true, duration: null }) as { call: object }
  assert.deepEqual([(call as any).result, 'duration' in call], [{ answered: false, voicemail: true }, false])
  assert.equal('result' in (toCall({ ...said, answered: null }) as any).call, false)
  // A hidden number is a call from nobody known.
  assert.equal('from' in (toCall({ ...said, customer_phone_number: 'anonymous' }) as any).call, false)
  for (const [changed, problem] of [[{ id: undefined }, /id/], [{ start_time: '2026-11-24T09:04:00' }, /zone/], [{ start_time: 'soonZ' }, /zone/], [{ tracking_phone_number: '' }, /tracking/], [{ direction: 'outbound', customer_phone_number: '' }, /outbound/]] as const) assert.match((toCall({ ...said, ...changed }) as any).problem, problem)
})

test('an automated answer is unknown and an unknown direction cannot become an inbound call', () => {
  const reported = toCall({ ...said, answered: true })
  assert.ok('call' in reported)
  assert.equal('result' in reported.call, false)
  const people = toCall({ ...said, answered: true }, true)
  assert.ok('call' in people && people.call.type === 'call')
  assert.deepEqual(people.call.result, { answered: true })
  for (const direction of [undefined, 'unknown']) assert.deepEqual(toCall({ ...said, direction }), { problem: 'no call direction' })
})

test('only a body signed with the key is taken', () => {
  const raw = Buffer.from(JSON.stringify(said))
  assert.equal(signed(raw, sign(raw.toString()), KEY), true)
  for (const [given, key] of [[sign('other'), KEY], [sign(raw.toString()), 'another'], [undefined, KEY], ['', KEY], ['x', KEY], [sign(raw.toString()), '']] as const) assert.equal(signed(raw, given, key), false)
})

test('a signed CallRail post reaches the graph once and a phone system waits for a human result', async (t) => {
  const body = JSON.stringify({ ...said, id: 900100, voicemail: true, start_time: '2018-02-19T18:41:00Z' })
  const callrail = { key: KEY, body, signature: sign(body) }
  const now = Date.parse('2018-02-19T18:45:00Z')
  const graph = accountGraph({ memory: true, now: () => now, phones: { resultsExpectedWithinMinutes: 60 } })
  const server = createServer(createEdge(graph, { token: 'service' }))
  await once(server.listen(0, '127.0.0.1'), 'listening')
  t.after(() => server.close())
  const folder = mkdtempSync(join(tmpdir(), 'callrail-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const forwarder = createForwarder({ folder, graph: at(server), token: 'service' })
  const tracker = createTracker({ key: callrail.key, forwarder })
  await once(tracker.listen(0, '127.0.0.1'), 'listening')
  t.after(() => tracker.close())
  const post = async (raw: string, signature: string) => {
    const response = await fetch(at(tracker) + '/calls', { method: 'POST', headers: { signature, 'content-type': 'application/json' }, body: raw })
    await forwarder.flush()
    return response.status
  }
  const counts = async () => (await graph.report({ kind: 'calls', window: { from: '2018-02-19', to: '2018-02-19', timeZone: 'UTC' }, at: now })).value.total
  assert.equal(await post(callrail.body + '\n', callrail.signature), 401)
  assert.equal((await counts()).calls, 0)
  for (let i = 0; i < 2; i++) {
    assert.equal(await post(callrail.body, callrail.signature), 204)
    const { calls, voicemail } = await counts()
    assert.deepEqual([calls, voicemail], [1, 1])
  }
  const automated = JSON.stringify({ ...said, start_time: '2018-02-19T18:42:00Z', answered: true })
  assert.equal(await post(automated, createHmac('sha1', callrail.key).update(automated).digest('base64')), 204)
  const { calls, waiting, answered } = await counts()
  assert.deepEqual([calls, waiting, answered], [2, 1, 0])
  assert.deepEqual(readdirSync(folder), [])
})

test('a call reaches the graph by way of the folder, once, and waits there while the server is away', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'calls-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const now = Date.parse('2026-11-24T16:00:00Z')
  const graph = accountGraph({ memory: true, now: () => now })
  const server = createServer(createEdge(graph, { token: 'service' }))
  let away = true
  const forwarder = createForwarder({ folder: join(folder, 'spool'), graph: 'http://graph.example', token: 'service', fetch: async (url, init) => (away ? Promise.reject(new Error('away')) : fetch(String(url).replace('http://graph.example', at(server)), init)) })
  const tracker = createTracker({ key: KEY, forwarder })
  for (const each of [server, tracker]) {
    await once(each.listen(0, '127.0.0.1'), 'listening')
    t.after(() => each.close())
  }
  const post = (raw: string, signature = sign(raw)) => fetch(`${at(tracker)}/calls`, { method: 'POST', headers: { signature }, body: raw })
  const waiting = () => readdirSync(join(folder, 'spool'))
  const raw = JSON.stringify(said)
  assert.equal((await post(raw, 'bad')).status, 401)
  assert.deepEqual([(await post('[]')).status, (await post('{')).status, (await post(JSON.stringify({ ...said, id: undefined }))).status, (await fetch(at(tracker))).status], [400, 400, 422, 404])
  assert.deepEqual(waiting(), [])
  assert.equal((await post(raw)).status, 204)
  assert.equal((await post(raw)).status, 204)
  assert.equal((await forwarder.flush()).left, 1)
  assert.equal(statSync(join(folder, 'spool', waiting()[0]!)).mode & 0o077, 0)
  away = false
  assert.deepEqual(await forwarder.flush(), { sent: 1, refused: 0, left: 0 })
  const kept = await graph.lookup({ kind: 'record', type: 'call', key: 'callrail-444', at: now })
  assert.equal(kept?.type === 'call' && kept.state, 'missed')
  // Sent again by the service, it is the same call.
  await post(raw)
  await forwarder.flush()
  assert.equal((await graph.report({ kind: 'calls', window: { from: '2026-11-24', to: '2026-11-24', timeZone: 'UTC' }, at: now })).value.total.calls, 1)
  // What the server refuses is set aside and does not hold up the rest.
  forwarder.take({ type: 'call', key: 'callrail-bad', at: 1, direction: 'inbound', to: 5 } as never)
  forwarder.take({ ...(toCall({ ...said, id: 445 }) as any).call })
  const { sent, refused, left } = await forwarder.flush()
  assert.deepEqual([sent, refused, left], [1, 1, 0])
  assert.match(waiting()[0]!, /\.refused$/)
})
