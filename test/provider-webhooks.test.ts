import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createWebhook } from '../src/core/delivery.ts'
import { createGraph } from '../src/core/graph.ts'
import { createOps } from '../src/core/ops.ts'
import { createMemoryStore } from '../tools/internals.ts'

test('a loopback receiver verifies event bytes independently and receives an unsigned alert', async t => {
  const at = 1_790_000_000_000
  const received: { path: string | undefined; signature: string | undefined; body: Buffer }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const signature = req.headers['x-account-graph-signature']
    received.push({ path: req.url, body: Buffer.concat(chunks), signature: typeof signature === 'string' ? signature : undefined })
    res.writeHead(204).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const store = createMemoryStore()
  const secret = 'only-for-this-loopback-test'
  const webhook = createWebhook(store, { url: base + '/events', secret, now: () => at })
  assert.equal(await webhook.run(), 0)
  await store.write(tx => tx.emit([{ type: 'delivery.late', at, data: { oldestDue: at } }]))
  assert.equal(await webhook.run(), 1)
  assert.equal(await webhook.run(), 0)
  const ops = createOps(createGraph(store), store.ops, { url: base + '/alerts' })
  assert.deepEqual(await ops.test(), { delivered: true })
  assert.deepEqual(received.map(row => row.path), ['/events', '/alerts'])
  const [event, alert] = received
  const digest = createHmac('sha256', secret).update(String(at) + '.').update(event!.body).digest('hex')
  assert.equal(event!.signature, 't=' + at + ',v1=' + digest)
  assert.deepEqual(JSON.parse(event!.body.toString()).events.map((row: { seq: number }) => row.seq), [1])
  assert.equal(alert!.signature, undefined)
  assert.deepEqual(JSON.parse(alert!.body.toString()), { text: 'account-graph: test alert.' })
})
