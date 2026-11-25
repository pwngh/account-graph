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
import { createGraph, createMemoryStore, hashPhone } from '../tools/internals.ts'
import { createHandler } from '../src/edge/server.ts'

const KEY = 'a made-up key'
const said = { id: 444, customer_phone_number: '+15550100142', tracking_phone_number: '+15550100101', start_time: '2026-11-24T09:04:00.000-06:00', duration: '95', answered: false, voicemail: false, direction: 'inbound' }
const sign = (raw: string) => createHmac('sha1', KEY).update(raw).digest('base64')
const at = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

test('a call of a tracking service becomes one the server takes', () => {
  assert.deepEqual(toCall(said), { call: { id: 'callrail-444', at: Date.parse('2026-11-24T15:04:00Z'), from: '+15550100142', to: '+15550100101', duration: 95, answered: false } })
  assert.deepEqual(toCall({ ...said, direction: 'outbound', answered: true }), { call: { id: 'callrail-444', at: Date.parse('2026-11-24T15:04:00Z'), direction: 'outbound', from: '+15550100101', to: '+15550100142', duration: 95, answered: true } })
  // Voicemail is not an answer, and what is not known is not said.
  const { call } = toCall({ ...said, answered: true, voicemail: true, duration: null }) as { call: object }
  assert.deepEqual([(call as any).answered, (call as any).voicemail, 'duration' in call], [false, true, false])
  assert.equal('answered' in (toCall({ ...said, answered: null }) as any).call, false)
  // A hidden number is a call from nobody known.
  assert.equal('from' in (toCall({ ...said, customer_phone_number: 'anonymous' }) as any).call, false)
  for (const [changed, problem] of [[{ id: undefined }, /id/], [{ start_time: '2026-11-24T09:04:00' }, /zone/], [{ start_time: 'soonZ' }, /zone/], [{ tracking_phone_number: '' }, /tracking/], [{ direction: 'outbound', customer_phone_number: '' }, /outbound/]] as const) assert.match((toCall({ ...said, ...changed }) as any).problem, problem)
})

test('only a body signed with the key is taken', () => {
  const raw = Buffer.from(JSON.stringify(said))
  assert.equal(signed(raw, sign(raw.toString()), KEY), true)
  for (const [given, key] of [[sign('other'), KEY], [sign(raw.toString()), 'another'], [undefined, KEY], ['', KEY], ['x', KEY], [sign(raw.toString()), '']] as const) assert.equal(signed(raw, given, key), false)
})

test('a call reaches the graph by way of the folder, once, and waits there while the server is away', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'calls-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const graph = createGraph(createMemoryStore(), undefined, { now: () => Date.parse('2026-11-24T16:00:00Z') })
  const server = createServer(createHandler(graph, { token: 'service', origins: [], calls: {}, now: () => Date.parse('2026-11-24T16:00:00Z') }))
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
  const { state } = (await (await fetch(`${at(server)}/call?id=callrail-444`, { headers: { authorization: 'Bearer service' } })).json()) as { state: string }
  assert.equal(state, 'missed')
  // Sent again by the service, it is the same call.
  await post(raw)
  await forwarder.flush()
  assert.equal((await graph.callsOf([`caller:${hashPhone('+15550100142')}`])).length, 1)
  // What the server refuses is set aside and does not hold up the rest.
  forwarder.take({ id: 'callrail-bad', at: 1, to: 5 })
  forwarder.take({ ...(toCall({ ...said, id: 445 }) as any).call })
  const { sent, refused, left } = await forwarder.flush()
  assert.deepEqual([sent, refused, left], [1, 1, 0])
  assert.match(waiting()[0]!, /\.refused$/)
})
