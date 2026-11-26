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
const origin = 'https://www.example.org'
const sites = [origin, 'https://alias.example.org', 'https://example.org']
const key = '5c82d0473c3fb'
const secretPage = origin + '/files/' + key + '?grant=' + key
const publicPage = origin + '/welcome?grant=' + key + '#private'
const rules = { allowPages: ['/welcome', '/search'], refusePages: ['/files/*'] }

export async function pageServer(graph: AccountGraph) {
  const { engine, call } = await internalsOf(graph)!()
  const options = { ...rules, token: 'service', origins: [origin, 'https://intake.example.org'], serviceTokens: [{ name: 'recorder', token: 'arrivals', calls: { record: ['arrival'] as const } }], cookie: true, limit: false as const }
  assert.throws(() => createEdge(graph, { ...options, refusePages: ['(something)+'] }), /literal paths/)
  let checks = 0
  const checked = async () => {
    checks += 1
    return undefined
  }
  const edge = (origins: string[]) => createHandler({
    graph: engine.graph, service: { ...engine.service, pool: ['+12025550105'] }, v1: (name, input, signal) => call(name, input, { signal }),
    called: async () => {}, texted: async () => {}, forget: async () => ({ changes: [], sent: [] }),
  }, { ...options, origins, events: ['phone_click'], now: () => at, texts: { codes: true }, pool: { numbers: ['+12025550105'], minutes: 15, grace: 10 }, linkSecret: 'l'.repeat(32),
    fingerprint: checked, ipInfo: checked })
  const servers = [options.origins, []].map(origins => createServer(edge(origins)).listen(0, '127.0.0.1'))
  await Promise.all(servers.map(server => new Promise<void>((done, fail) => server.once('listening', done).once('error', fail))))
  const post = (path: string, body: unknown, referer?: string, token = 'service', server = servers[0]!) => fetch('http://127.0.0.1:' + (server.address() as AddressInfo).port + path, { method: 'POST', headers: { origin, authorization: 'Bearer ' + token, ...(referer && { referer }) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    const start = await engine.graph.counts()
    const before = await graph.events({ after: null, limit: 100 })
    const blocked = { device: 'browser', event: 'phone_click', number: '202-555-0105', fingerprintEvent: 'event' }
    const privatePages = sites.map(site => site + '/files/' + key + '?grant=' + key)
    assert.equal((await post('/collect', { device: 'closed', url: publicPage }, undefined, 'service', servers[1]!)).status, 403)
    for (const [route, kind] of [['/collect', 'visit'], ['/event', 'event'], ['/carry', 'carry'], ['/number', 'number'], ['/text-code', 'text_code']]) {
      for (const path of new Set([route!, '/collect'])) {
        for (const fields of [...privatePages.flatMap(url => [{ url }, { url: publicPage, touch: { landing: url } }]), {}]) {
          const response = await post(path, { ...blocked, ...fields, kind })
          assert.deepEqual([response.status, response.headers.get('set-cookie'), await response.text()], [204, null, ''], path + ' ' + kind)
        }
      }
    }
    for (const referer of [...privatePages, origin, origin + '/']) {
      const hidden = await post('/collect', { ...blocked, url: publicPage }, referer)
      assert.deepEqual([hidden.status, hidden.headers.get('set-cookie'), checks], [204, null, 0])
    }
    const first = { type: 'arrival', key: 'arrival', at, subject: 'account:one', source: 'search' }
    const link = { type: 'link', key: 'sent', at, subject: 'account:one', expires: at + 86_400_000 }
    const privateArrival = { ...first, key: 'private', landing: secretPage }
    for (const token of ['service', 'arrivals']) {
      const refused = await post('/v1/record', { entries: [privateArrival, { ...first, key: 'referrer', referrer: secretPage }, { ...link, url: secretPage }] }, undefined, token)
      assert.equal(refused.status, 200)
      const body = await refused.text()
      assert.doesNotMatch(body, new RegExp(key))
      assert.deepEqual(JSON.parse(body).results.map((row: any) => [row.key, row.ok, row.reason]), [['private', false, 'FORBIDDEN'], ['referrer', false, 'FORBIDDEN'], ['sent', false, 'FORBIDDEN']])
    }
    // Contract shape errors still refuse everything before the first row is dispatched.
    const invalid = await post('/v1/record', { entries: [first, { ...privateArrival, landing: secretPage + 'x'.repeat(3000) }] })
    assert.equal(invalid.status, 400)
    assert.doesNotMatch(await invalid.text(), new RegExp(key))
    for (const path of ['/collect', '/v1/record']) {
      const bad = await post(path, '{"url": "' + secretPage + '", BAD')
      assert.equal(bad.status, 400)
      assert.doesNotMatch(await bad.text(), new RegExp(key))
    }
    assert.deepEqual(await engine.graph.counts(), start)
    assert.deepEqual(await graph.events({ after: null, limit: 100 }), before)
    assert.deepEqual(await engine.graph.decisions(), [])
    const arrival = { ...first, landing: publicPage, referrer: 'https://news.example.org/story/42?q=' + key + '#file', clicks: { fbclid: 'meta', ttclid: 'tiktok' } }
    const recorded = await post('/v1/record', { entries: [privateArrival, arrival, { ...link, url: publicPage }, { ...first, key: 'intake', landing: 'https://intake.example.org/files/' + key }] })
    assert.equal(recorded.status, 200)
    const reply = await recorded.json()
    assert.deepEqual(reply.results.map((row: any) => [row.key, row.ok ? row.value.duplicate : row.reason]), [['private', 'FORBIDDEN'], ['arrival', false], ['sent', false], ['intake', 'FORBIDDEN']])
    assert.equal(new URL(reply.results[2].value.url).searchParams.has('ag'), true)
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(key))
    const visit = await post('/collect', { url: publicPage, device: 'browser', touch: { source: 'paid', landing: publicPage, referrer: arrival.referrer } })
    assert.equal(visit.status, 204)
    const touches = await engine.store.read(tx => tx.touchesOf(['account:one', 'visitor:browser'], 0, at))
    assert.deepEqual(touches.map(({ landing, referrer }) => [landing, referrer]), Array(2).fill([origin + '/welcome', 'https://news.example.org/story/42']))
    // A refused previous page does not cancel an independent campaign on this page.
    for (const [i, [referrer, expected]] of [
      [secretPage, undefined], ['https://intake.example.org/files/' + key, undefined],
      ['https://search.example.org/?q=' + key, 'https://search.example.org/'], ['https://news.example.org/files/article#' + key, 'https://news.example.org/files/article'],
    ].entries()) {
      const device = 'from-' + i
      const res = await post('/collect', { device, url: publicPage, touch: { landing: publicPage, gclid: 'G1', referrer } }, publicPage)
      assert.equal(res.status, 204)
      const [touch] = await engine.store.read(tx => tx.touchesOf(['visitor:' + device], 0, at))
      assert.deepEqual([touch?.landing, touch?.gclid, touch?.referrer], [origin + '/welcome', 'G1', expected])
    }
    for (const [i, site] of sites.entries()) {
      const page = site + '/welcome'
      const from = site + '/files/article?q=' + key
      for (const [j, [url, landing, referer]] of [[page, '/welcome', '/welcome'], ['/welcome', page, '/welcome'], ['/welcome', '/welcome', page]].entries()) {
        const device = 'alias-from-' + i + '-' + j
        assert.equal((await post('/collect', { device, url, touch: { gclid: 'G1', landing, referrer: from } }, referer)).status, 204)
        const [touch] = await engine.store.read(tx => tx.touchesOf(['visitor:' + device], 0, at))
        assert.deepEqual([touch?.gclid, touch?.referrer], ['G1', undefined], device)
      }
    }
    for (const [i, server] of servers.entries()) {
      for (const [j, site] of sites.entries()) {
        const subject = 'account:site-' + i + '-' + j
        const id = 'site-' + i + '-' + j
        const landing = site + '/welcome?grant=' + key
        const privateUrl = site + '/files/' + key + '?grant=' + key
        const other = 'https://news.example.org/files/article'
        const cross = await post('/v1/record', { entries: [
          { ...first, subject, key: id + '-landing', landing: privateUrl }, { ...link, subject, key: id + '-link', url: privateUrl },
          { ...first, subject, key: id + '-from', landing, referrer: privateUrl }, { ...first, subject, key: id + '-ok', landing, referrer: other + '?q=' + key + '#' + key },
          { ...link, subject, key: id + '-public', url: landing },
        ] }, undefined, 'service', server)
        const reply = await cross.json()
        assert.deepEqual(reply.results.map((row: any) => row.ok || row.reason), ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', true, true], subject)
        const signed = new URL(reply.results[4].value.url)
        assert.equal(signed.origin + signed.pathname, site + '/welcome')
        assert.doesNotMatch(JSON.stringify(reply), new RegExp(key))
        assert.deepEqual((await engine.store.read(tx => tx.touchesOf([subject], 0, at))).map(t => [t.landing, t.referrer]), [[site + '/welcome', other]])
      }
    }
    const unknown = await post('/v1/record', { entries: [{ ...first, key: 'unknown', landing: '/welcome', referrer: secretPage }] }, undefined, 'service', servers[1]!)
    assert.equal((await unknown.json()).results[0].reason, 'FORBIDDEN')
    const mixed = await post('/v1/record', { entries: [privateArrival, arrival, { ...first, key: 'accepted', subject: 'account:limited', landing: '/welcome' }, { ...link, url: publicPage }] }, undefined, 'arrivals')
    assert.deepEqual((await mixed.json()).results.map((row: any) => row.ok ? row.value.duplicate : row.reason), ['FORBIDDEN', true, false, 'FORBIDDEN'])
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
    for (const server of servers) server.closeAllConnections()
    await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))))
  }
}
