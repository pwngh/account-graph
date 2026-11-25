import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { internalsOf } from '../src/client/internals.ts'
import type { AccountGraph } from '../src/contract/api.ts'
import type { Item } from '../src/core/outbox.ts'
import { createEdge } from '../src/edge/index.ts'
import { createHandler } from '../src/edge/server.ts'
import { metaEvent, tiktok } from '../src/providers/targets.ts'

const at = 1_790_000_000_000
const origin = 'https://example.org'
const key = '5c82d0473c3fb'
const secretPage = origin + '/files/' + key + '?grant=' + key
const publicPage = origin + '/welcome?grant=' + key + '#private'
const rules = { allowPages: ['/welcome', '/search'], refusePages: ['/files/*'] }

export async function pageServer(graph: AccountGraph) {
  const { engine, call } = await internalsOf(graph)!()
  const options = { ...rules, token: 'service', origins: [origin], cookie: true, limit: false as const }
  assert.throws(() => createEdge(graph, { ...options, refusePages: ['(something)+'] }), /literal paths/)
  let checks = 0
  const checked = async () => {
    checks += 1
    return undefined
  }
  const edge = createHandler({
    graph: engine.graph, service: { ...engine.service, pool: ['+12025550105'] }, v1: (name, input, signal) => call(name, input, { signal }),
    called: async () => {}, texted: async () => {}, forget: async () => ({ changes: [], sent: [] }),
  }, { ...options, events: ['phone_click'], now: () => at, texts: { codes: true }, pool: { numbers: ['+12025550105'], minutes: 15, grace: 10 }, linkSecret: 'l'.repeat(32),
    fingerprint: checked, ipInfo: checked })
  const server = createServer(edge).listen(0, '127.0.0.1')
  await new Promise<void>((done, fail) => server.once('listening', done).once('error', fail))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const post = (path: string, body: unknown, referer?: string) => fetch(base + path, { method: 'POST', headers: { origin, authorization: 'Bearer service', ...(referer && { referer }) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    const start = await engine.graph.counts()
    const before = await graph.events({ after: null, limit: 100 })
    const blocked = { device: 'browser', event: 'phone_click', number: '202-555-0105', fingerprintEvent: 'event' }
    for (const [route, kind] of [['/collect', 'visit'], ['/event', 'event'], ['/carry', 'carry'], ['/number', 'number'], ['/text-code', 'text_code']]) {
      for (const path of new Set([route!, '/collect'])) {
        for (const fields of [{ url: secretPage }, { url: publicPage, touch: { landing: secretPage } }, { url: publicPage, touch: { referrer: secretPage } }, {}]) {
          const response = await post(path, { ...blocked, ...fields, kind })
          assert.deepEqual([response.status, response.headers.get('set-cookie'), await response.text()], [204, null, ''], path + ' ' + kind)
        }
      }
    }
    for (const referer of [secretPage, origin, origin + '/']) {
      const hidden = await post('/collect', { ...blocked, url: publicPage }, referer)
      assert.deepEqual([hidden.status, hidden.headers.get('set-cookie'), checks], [204, null, 0])
    }
    const first = { type: 'arrival', key: 'arrival', at, subject: 'account:one', source: 'search' }
    const link = { type: 'link', key: 'sent', at, subject: 'account:one', expires: at + 86_400_000 }
    for (const entry of [{ ...first, key: 'other', landing: secretPage }, { ...first, key: 'other', referrer: secretPage }, { ...link, url: secretPage }]) {
      const response = await post('/v1/record', { entries: [first, entry] })
      assert.equal(response.status, 400)
      assert.doesNotMatch(await response.text(), new RegExp(key))
    }
    for (const path of ['/collect', '/v1/record']) {
      const bad = await post(path, '{"url": "' + secretPage + '", BAD')
      assert.equal(bad.status, 400)
      assert.doesNotMatch(await bad.text(), new RegExp(key))
    }
    assert.deepEqual(await engine.graph.counts(), start)
    assert.deepEqual(await graph.events({ after: null, limit: 100 }), before)
    assert.deepEqual(await engine.graph.decisions(), [])
    const arrival = { ...first, landing: publicPage, referrer: 'https://search.example.org/search?q=' + key, clicks: { fbclid: 'meta', ttclid: 'tiktok' } }
    const recorded = await post('/v1/record', { entries: [arrival, { ...link, url: publicPage }] })
    assert.equal(recorded.status, 200)
    const reply = await recorded.json()
    assert.equal(reply.results[0].ok, true)
    assert.equal(reply.results[0].value.duplicate, false)
    assert.equal(new URL(reply.results[1].value.url).searchParams.has('ag'), true)
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(key))
    const visit = await post('/collect', { url: publicPage, device: 'browser', touch: { source: 'paid', landing: publicPage, referrer: arrival.referrer } })
    assert.equal(visit.status, 204)
    const touches = await engine.store.read(tx => tx.touchesOf(['account:one', 'visitor:browser'], 0, at))
    assert.deepEqual(touches.map(({ landing, referrer }) => [landing, referrer]), Array(2).fill([origin + '/welcome', 'https://search.example.org/search']))
    const journey = await engine.graph.journey('account:one')
    const saved = [journey, await graph.events({ after: null, limit: 100 }), await engine.graph.decisions(), await engine.graph.audit()]
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(key))
    const item: Item = { job: { transactionId: 'conversion', subject: 'account:one', action: 'Lead', at, target: 'meta', keys: {}, state: 'pending', attempts: 0, due: at }, consent: undefined,
      touch: (await engine.graph.attribute('account:one', { at })).touches[0] }
    assert.equal(metaEvent('Lead', item, origin).event_source_url, origin + '/welcome')
    let sent: any
    const target = tiktok({ pixelCode: 'pixel', accessToken: 'test', url: origin, fetch: async (_input, options) => {
      sent = JSON.parse(String(options?.body))
      return Response.json({ code: 0 })
    } })
    await target.deliver('Lead', [item])
    assert.equal(sent.data[0].page.url, origin + '/welcome')
    assert.doesNotMatch(JSON.stringify(sent), new RegExp(key))
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
}
