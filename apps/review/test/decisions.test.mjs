import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { reviewServer } from '../server.mjs'

const root = createRequire(new URL('../../../package.json', import.meta.url))
const { accountGraph } = await import(root.resolve('account-graph'))
const { createEdge } = await import(root.resolve('account-graph/edge'))
const address = server => 'http://127.0.0.1:' + server.address().port

test('native review forms change a memory graph and replay the decision and deletion only once', async t => {
  const graph = accountGraph({ memory: true, policy: { kinds: { phone: { weight: 0.85 } } } })
  const a = 'contact:alba', b = 'contact:ben', c = 'contact:cai', d = 'contact:dev'
  const { results } = await graph.record({ entries: [a, b, c, d].map((subject, i) => ({
    type: 'profile', key: 'sample-' + i, at: Date.now(), subject,
    facts: i < 2 ? { phone: '+15550100064' } : { device: 'sample-kiosk' },
  })) })
  assert.ok(results.every(result => result.ok))
  const edge = createEdge(graph, { token: 'service-fixture', reviewers: { dana: 'review-fixture' }, origins: [], limit: false })
  const upstream = createServer(edge)
  await once(upstream.listen(0, '127.0.0.1'), 'listening')
  const ui = await reviewServer({ host: '127.0.0.1', port: 0, graphUrl: address(upstream), secret: 'local-review-test-secret-without-other-uses' })
  t.after(async () => {
    for (const server of [ui, upstream]) {
      const done = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await done
    }
    await edge.drain()
    await graph.close()
  })
  const origin = address(ui)
  let cookie = ''
  const post = (path, fields) => fetch(origin + path, { method: 'POST', headers: { cookie, origin }, body: new URLSearchParams(fields), redirect: 'manual' })
  const login = await post('/signin', { token: 'review-fixture' })
  assert.equal(login.status, 303)
  cookie = login.headers.get('set-cookie').split(';')[0]
  const pageOf = subject => '/accounts/' + encodeURIComponent(subject)
  const read = async path => {
    const reply = await fetch(address(upstream) + '/review/api/' + path, { headers: { authorization: 'Bearer review-fixture' } })
    assert.equal(reply.status, 200)
    return reply.json()
  }
  const profile = subject => read('subject?subject=' + encodeURIComponent(subject))
  const decisions = async () => (await read('decisions')).decisions

  async function form(path, intent, matches = () => true) {
    const html = await (await fetch(origin + path, { headers: { cookie } })).text()
    for (const [form] of html.split('</main>')[0].matchAll(/<form\b[^>]*>[^]*?<\/form>/gi)) {
      const fields = new URLSearchParams()
      for (const [, tag] of form.matchAll(/<input\b([^>]+)>/gi)) {
        if (!tag.includes('type="hidden"')) continue
        const name = /\bname="([^"]+)"/.exec(tag)?.[1]
        const value = /\bvalue="([^"]*)"/.exec(tag)?.[1]
        if (name && value !== undefined) fields.set(name, value)
      }
      if (fields.get('intent') === intent && matches(fields)) return fields
    }
    assert.fail('Missing native form for ' + intent + ' at ' + path)
  }
  const subject = pageOf(a)
  const pair = await form('/decide', 'join', fields => [fields.get('subject'), fields.get('other')].sort().join() === [a, b].join())
  assert.equal((await post('/decide', pair)).status, 303)
  assert.equal((await post('/decide', pair)).status, 303)
  assert.deepEqual((await profile(a)).cluster.members, [a, b])
  assert.deepEqual((await decisions()).map(entry => [entry.action, entry.by]), [['join', 'dana']])
  assert.equal((await post(subject, await form(subject, 'separate', fields => fields.get('other') === b))).status, 303)
  assert.deepEqual((await profile(a)).separated, [b])
  assert.deepEqual((await profile(a)).cluster.members, [a])
  assert.equal((await post(subject, await form(subject, 'rejoin'))).status, 303)
  assert.deepEqual((await profile(a)).cluster.members, [a, b])
  assert.deepEqual((await profile(a)).separated, [])

  const kiosk = pageOf(c)
  const muted = await form(kiosk, 'mute')
  assert.equal((await post(kiosk, muted)).status, 303)
  assert.deepEqual((await profile(c)).cluster.members, [c])
  const restore = await form(kiosk, 'restore')
  assert.equal(restore.get('identifier'), muted.get('identifier'))
  assert.equal((await post(kiosk, restore)).status, 303)
  assert.deepEqual((await profile(c)).cluster.members, [c, d])

  const forget = await form(pageOf(b), 'forget')
  const unchecked = await post(pageOf(b), forget)
  assert.equal(unchecked.status, 400)
  assert.ok((await profile(b)).known)
  forget.set('confirm', 'yes')
  assert.equal((await post(pageOf(b), forget)).status, 303)
  assert.equal((await post(pageOf(b), forget)).status, 303)
  assert.equal((await profile(b)).known, false)
  assert.equal((await decisions()).filter(entry => entry.action === 'forget').length, 1)
  assert.equal((await profile(a)).known, true)
})

test('Matches says when pairs among older sightings are left out', async t => {
  const graph = accountGraph({ memory: true })
  const at = Date.now()
  await graph.record({ entries: ['contact:old-a', 'contact:old-b'].map((subject, i) => ({ type: 'profile', key: 'old-' + i, at, subject, facts: { identifiers: ['canvas:shared'] } })) })
  const edge = createEdge(graph, { token: 'service-fixture', reviewers: { dana: 'review-fixture' }, origins: [], limit: false })
  // Ten thousand newer sightings are slow to write here, so the queue's answer is given the window the graph gives
  // when they push older pairs out. test/suite.ts checks that window with real sightings.
  let older = true
  const upstream = createServer(async (request, response) => {
    if (!request.url.startsWith('/review/api/undecided')) return edge(request, response)
    const answer = await (await fetch(address(real) + request.url, { headers: { authorization: request.headers.authorization } })).json()
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...answer, window: { ...answer.window, oldest: at, older } }))
  })
  const real = createServer(edge)
  for (const server of [upstream, real]) await once(server.listen(0, '127.0.0.1'), 'listening')
  const ui = await reviewServer({ host: '127.0.0.1', port: 0, graphUrl: address(upstream), secret: 'local-review-test-secret-without-other-uses' })
  t.after(async () => {
    for (const server of [ui, upstream, real]) {
      const done = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await done
    }
    await edge.drain()
    await graph.close()
  })
  const origin = address(ui)
  const login = await fetch(origin + '/signin', { method: 'POST', headers: { origin }, body: new URLSearchParams({ token: 'review-fixture' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const page = async () => (await fetch(origin + '/decide', { headers: { cookie } })).text()
  assert.match(await page(), /<p class="meta older">Pairs among sightings before <time dateTime="[^"]+"[^>]*>[^<]+<\/time> are not in this queue\.<\/p>/)
  // With nothing left out, nothing is said.
  older = false
  assert.doesNotMatch(await page(), /class="older"/)
})

test('Health says when sends to ad platforms are stopped, why, since when, and how to resume', async t => {
  const graph = accountGraph({ memory: true })
  const edge = createEdge(graph, { token: 'service-fixture', reviewers: { dana: 'review-fixture' }, origins: [], limit: false })
  // The graph's ops answer with a stop, as test/integrations.test.ts checks it gives one.
  let paused = { at: Date.now() - 120_000, reason: 'checking a wrong tie' }
  // What the graph answers a retry with: 'gone' when the token was revoked, 'down' when the connection drops.
  let retry = 'gone'
  const upstream = createServer(async (request, response) => {
    if (request.url.startsWith('/review/api/retry')) return retry === 'gone' ? void response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Token revoked"}') : void request.socket.destroy()
    if (!request.url.startsWith('/review/api/ops')) return edge(request, response)
    const answer = await (await fetch(address(real) + request.url, { headers: { authorization: request.headers.authorization } })).json()
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...answer, paused }))
  })
  const real = createServer(edge)
  for (const server of [upstream, real]) await once(server.listen(0, '127.0.0.1'), 'listening')
  const ui = await reviewServer({ host: '127.0.0.1', port: 0, graphUrl: address(upstream), secret: 'local-review-test-secret-without-other-uses' })
  t.after(async () => {
    for (const server of [ui, upstream, real]) {
      const done = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await done
    }
    await edge.drain()
    await graph.close()
  })
  const origin = address(ui)
  const login = await fetch(origin + '/signin', { method: 'POST', headers: { origin }, body: new URLSearchParams({ token: 'review-fixture' }), redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const page = async () => (await (await fetch(origin + '/health', { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  assert.match(await page(), /<ul class="needs"><li role="alert"><b>Sends to ad platforms are paused\.<\/b> checking a wrong tie\. Since <time dateTime="[^"]+"[^>]*>[12] min ago<\/time>\. Run account-graph sends resume once the cause is fixed\.<\/li>/)
  assert.match(await page(), /<dt><span class="term">Issues<button[^]*?<\/dt><dd><span class="tile-line"><b>1<\/b>/)
  paused = null
  assert.doesNotMatch(await page(), /Sends to ad platforms are paused/)
  assert.match(await page(), /<dt><span class="term">Issues<button[^]*?<\/dt><dd><span class="tile-line"><b>0<\/b>/)
  // A retry the graph does not answer says so and keeps the session. One it refuses as signed out ends the session.
  const again = () => fetch(origin + '/health', { method: 'POST', headers: { cookie, origin }, body: new URLSearchParams({ intent: 'retry', transactionId: 'sale-1', target: 'google' }), redirect: 'manual' })
  retry = 'down'
  const lost = await again()
  assert.equal(lost.status, 503)
  assert.match(await lost.text(), /The graph did not answer\. Reload Health to see whether the conversion was queued\./)
  assert.equal((await fetch(origin + '/health', { headers: { cookie }, redirect: 'manual' })).status, 200)
  retry = 'gone'
  const revoked = await again()
  assert.equal(revoked.status, 303)
  assert.equal(revoked.headers.get('location'), '/signin')
  assert.ok([302, 303].includes((await fetch(origin + '/health', { headers: { cookie }, redirect: 'manual' })).status), 'the session ended')
})
