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

test('Matches says when pairs among older sightings are left out, and where to check them', async t => {
  const graph = accountGraph({ memory: true })
  const at = Date.now()
  await graph.record({ entries: ['contact:old-a', 'contact:old-b'].map((subject, i) => ({ type: 'profile', key: 'old-' + i, at, subject, facts: { identifiers: ['canvas:shared'] } })) })
  const edge = createEdge(graph, { token: 'service-fixture', reviewers: { dana: 'review-fixture' }, origins: [], limit: false })
  // Ten thousand newer sightings are slow to write here, so the queue's answer is given the window the graph gives
  // when they push older pairs out. test/review.test.ts checks that window with real sightings.
  let older = true
  const upstream = createServer(async (request, response) => {
    if (!request.url.startsWith('/review/api/undecided')) return edge(request, response)
    const answered = await fetch(address(real) + request.url, { headers: { authorization: request.headers.authorization } })
    // A refusal goes on as it came.
    if (!answered.ok) return void response.writeHead(answered.status, { 'content-type': 'application/json' }).end(await answered.text())
    const answer = await answered.json()
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...answer, window: { ...answer.window, oldest: at, older } }))
  })
  const real = createServer(edge)
  for (const server of [upstream, real]) await once(server.listen(0, '127.0.0.1'), 'listening')
  const ui = await reviewServer({ host: '127.0.0.1', port: 0, graphUrl: address(upstream), secret: 'local-review-test-secret-without-other-uses', legacyUrl: address(real) + '/review' })
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
  const page = async (path = '/decide') => (await (await fetch(origin + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
  assert.match(await page(), /<p class="meta older">Pairs among sightings before <time dateTime="[^"]+"[^>]*>[^<]+<\/time> are not in this queue\. <a href="\/decide\?older=all"[^>]*>Check older records<\/a><\/p>/)
  // Checking every record: where it is, the last page, the way back, and the pairs it lists keep to the check.
  const every = await page('/decide?older=all')
  assert.match(every, /<p class="meta older">Checking every record, <bdi>[^<]+<\/bdi> to <bdi>[^<]+<\/bdi>\. These are the last\. <a href="\/decide"[^>]*>Back to recent<\/a><\/p>/)
  assert.match(every, /class="queue-pair"[^>]*href="\/decide\?older=all&amp;pair=contact%3Aold-a/)
  // A place that is not one is read as the recent queue, and one the graph does not take starts the check again.
  assert.doesNotMatch(await page('/decide?older=' + encodeURIComponent('<nope>')), /Checking every record/)
  const refused = await fetch(origin + '/decide?older=not-a-cursor', { headers: { cookie }, redirect: 'manual' })
  assert.deepEqual([refused.status, refused.headers.get('location')], [303, '/decide?older=all'])
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

test('Matches skips pairs for this visit, restores them, and lists what the reviewer decided since signing in, with Undo', async t => {
  const graph = accountGraph({ memory: true, policy: { kinds: { phone: { weight: 0.85 } } } })
  const [a, b, c, d] = ['contact:ann', 'contact:bo', 'contact:cy', 'contact:di']
  const { results } = await graph.record({ entries: [a, b, c, d].map((subject, i) => ({ type: 'profile', key: 'session-' + i, at: Date.now(), subject, facts: { phone: i < 2 ? '+15550100071' : '+15550100072' } })) })
  assert.ok(results.every(result => result.ok))
  const edge = createEdge(graph, { token: 'service-fixture', reviewers: { dana: 'review-fixture', lee: 'lee-fixture' }, origins: [], limit: false })
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
  cookie = login.headers.get('set-cookie').split(';')[0]
  const page = async path => (await (await fetch(origin + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '').replaceAll('&amp;', '&')
  const open = html => html.match(/<section class="pair"[\s\S]*?<\/section>/)?.[0] ?? ''
  const hidden = (html, intent) => {
    for (const [form] of html.matchAll(/<form\b[^>]*>[^]*?<\/form>/gi)) {
      const fields = new URLSearchParams([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map(([, name, value]) => [name, value]))
      if (fields.get('intent') === intent) return fields
    }
  }
  const first = await page('/decide')
  const skip = first.match(/<a class="button choice"[^>]*>Skip/)[0].match(/href="([^"]+)"/)[1]
  assert.match(skip, /skip=/)
  // Skipped, the other pair is open, and the skipped one can be brought back.
  const skipped = await page(skip)
  assert.notEqual(open(skipped), open(first))
  assert.match(skipped, />Restore skipped</)
  assert.match(skipped, /Skipped[\s\S]*?1[\s\S]*?This session/)
  assert.doesNotMatch(await page('/decide'), />Restore skipped</)
  // Joined from the page, the pair is listed under This session with Undo, and U is its key.
  assert.equal((await post('/decide', hidden(first, 'join'))).status, 303)
  const after = await page('/decide')
  assert.match(after, /<h2>This session<\/h2><ul class="decided"><li><span class="chip same">Joined<\/span>/)
  const undo = hidden(after, 'unjoin')
  assert.ok(undo, 'an Undo form')
  assert.match(after, /aria-keyshortcuts="u"/)
  assert.equal((await post('/decide', undo)).status, 303)
  // Taken back, the pair is no longer listed, and is pending again.
  const undone = await page('/decide')
  assert.doesNotMatch(undone, /<h2>This session<\/h2>/)
  assert.equal((await graph.lookup({ kind: 'pair', a, b }).catch(() => null))?.together ?? false, false)
  // A pair Dana joined and another reviewer separated since is that reviewer's, and Dana has no Undo for it.
  const head = async token => (await (await fetch(address(upstream) + '/review/api/decisions?limit=1', { headers: { authorization: 'Bearer ' + token } })).json()).decisions[0]?.seq ?? 0
  const joined = await fetch(address(upstream) + '/review/api/join', { method: 'POST', headers: { authorization: 'Bearer review-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ a: c, b: d, by: 'dana', seen: await head('review-fixture') }) })
  assert.equal(joined.status, 200, await joined.clone().text())
  assert.match(await page('/decide'), /<h2>This session<\/h2>/)
  // Dana's own decision on the pair named in the address is not news to Dana.
  const named = '/decide?' + new URLSearchParams({ pair: c + '\n' + d })
  assert.doesNotMatch(await page(named), /class="banner" role="status"/)
  const separated = await fetch(address(upstream) + '/review/api/separate', { method: 'POST', headers: { authorization: 'Bearer lee-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ a: c, b: d, by: 'lee', seen: await head('lee-fixture') }) })
  assert.equal(separated.status, 200, await separated.clone().text())
  assert.doesNotMatch(await page('/decide'), /<h2>This session<\/h2>/)
  // Open on that pair, Dana is told who decided it since, in either order of the two.
  assert.match(await page(named), /<p class="banner" role="status"><b>lee<\/b> separated <bdi[^>]*>[^<]+<\/bdi> and <bdi[^>]*>[^<]+<\/bdi> <time/)
  assert.match(await page('/decide?' + new URLSearchParams({ pair: d + '\n' + c })), /<b>lee<\/b> separated/)
})
