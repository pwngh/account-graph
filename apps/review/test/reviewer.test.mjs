import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { RouterContextProvider } from 'react-router'

const subject = 'account:42'
const path = '/accounts/' + encodeURIComponent(subject)
const other = 'contact:72'
const specialSubjects = ['.', '..', ';id=.', 'contact:hello/世界?literal%2F#end.data']
const reviewer = 'sample-reviewer-token'
const service = 'sample-events-token'
const observed = Date.UTC(2026, 8, 21)
const account = {
  known: true, subject, dates: { [subject]: { firstSeen: observed, createdAt: observed - 86400_000 } },
  cluster: { id: subject, members: [subject, other], oversized: false },
  links: [{ subject: other, level: 'same', score: 0.98, reasons: [{ identifier: 'device:sample', evidence: 0.98, fanout: 2, gap: 0 }] }],
  edges: [{ a: subject, b: other, level: 'same', score: 0.98 }],
  history: [{ at: observed, event: 'First <visit>', identifier: 'device:sample' }],
  apart: [], separated: [], verdicts: [], flows: [], rings: [], consent: [],
}
const requests = []
const changes = []
const decisions = new Map()
const audited = []
let eventsRevoked = false, interrupted, beforeDecision, app, graph, origin, routes, revoked = false, failure = 0, lostReply = false
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const bytes = []
  for await (const chunk of req) bytes.push(chunk)
  const input = bytes.length ? JSON.parse(Buffer.concat(bytes)) : null
  const authorization = req.headers.authorization
  requests.push({ path: url.pathname, query: url.searchParams, authorization, input, time: performance.now() })
  if (url.pathname === '/review/api/audit' && interrupted === 'slow') return
  if (url.pathname === '/review/api/audit' && interrupted === 'down') return req.socket.destroy()
  if (failure) return send(failure, { error: 'The sample graph is unavailable' })
  if (url.pathname === '/v1/events') {
    if (eventsRevoked) return send(401, { error: 'Token revoked' })
    if (authorization !== 'Bearer ' + service) return send(403, { error: 'Only the service reads events' })
    const from = input.after === null ? 0 : Number(input.after.split('.').at(-1))
    return send(200, { ok: true, value: { schemaVersion: 1, events: changes.slice(from), cursor: 'sample.' + changes.length, more: false } })
  }
  // The graph accepts its service token on the reviewer routes too.
  if (url.pathname === '/review/api/pulse' && authorization === 'Bearer ' + service) return eventsRevoked ? send(401, { error: 'Token revoked' }) : send(200, { version: changes.length })
  if (revoked || authorization !== 'Bearer ' + reviewer) return send(401, { error: 'The token was not accepted' })
  switch (url.pathname) {
    case '/review/api/me': return send(200, { reviewer: 'dana', retraction: { targets: [], always: false }, targets: {}, limits: { returnHours: null, openHours: false } })
    // The graph has the account these tests open, and the records they join it to. It knows nothing of any other ID.
    case '/review/api/subject': return send(200, url.searchParams.get('subject') === subject ? account : { known: ['contact:73', 'contact:another', 'contact:browser-native'].includes(url.searchParams.get('subject')), subject: url.searchParams.get('subject') })
    case '/review/api/journey': return send(200, { entries: [], subjects: {}, next: null, more: 0 })
    case '/review/api/clusters': return send(200, [{ id: subject, size: account.cluster.members.length, oversized: false }])
    case '/review/api/recent': return send(200, [])
    case '/review/api/decisions': return send(200, { decisions: audited, next: null, total: audited.length })
    case '/review/api/audit': return send(200, { sound: true, head: null })
    case '/review/api/pulse': return send(200, { version: changes.length })
    case '/review/api/ops': return send(200, { at: observed, feeds: [], jobs: [], undelivered: [], alerts: false, outbox: null, pool: null })
    case '/review/api/policy': return send(200, { hash: 'sample-policy', due: false, warning: null, changed: [], rules: { same: 0.9, related: 0.5, bridge: 0.97, review: 50, kinds: { email: { weight: 0.99, cap: 10, dilution: 0, halfLife: 'none' } } } })
    case '/review/api/disputes': return send(200, [])
    case '/review/api/texts': return send(200, { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timeZone: 'America/New_York', at: observed, texts: [], next: null })
    case '/review/api/report': return send(200, { from: '2026-09-01', to: '2026-09-30', timeZone: 'America/New_York', days: 30, rows: [], excluded: 0, months: [], dimensions: [], currencies: [], steps: [], incomplete: null,
      total: { cost: 0, clicks: 0, visits: 0, missed: 0, notLeads: 0, outcomes: 0, value: 0, costDays: 0, missingDays: 0, insufficientData: false, costPerOutcome: null, returnOnCost: null, people: 0, stages: {}, valueChange: { outcomes: 0, first: 0, now: 0, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 } } })
    case '/review/api/undecided': return send(200, { pairs: [], total: 0, seen: 0, window: { kind: 'recent', older: true, oldest: observed } })
    case '/v1/lookup': return send(200, { by: 'subject', subjects: specialSubjects })
    case '/v1/decide': {
      if (beforeDecision) await beforeDecision
      const previous = decisions.get(input.key)
      if (previous) assert.deepEqual(input, previous, 'reposting the same form must preserve its decision key and timestamp')
      decisions.set(input.key, input)
      // The graph took the decision and its answer never arrived.
      if (lostReply) return req.socket.destroy()
      return send(200, { ok: true, value: { duplicate: Boolean(previous), recorded: previous ? 0 : 1, already: 0, changes: [], notAsAsked: [] } })
    }
    default: return send(404, { error: 'Unhandled stub route ' + url.pathname })
  }
}
function address(server) {
  return 'http://127.0.0.1:' + server.address().port
}
async function close(server) {
  if (!server?.listening) return
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
}
before(async () => {
  graph = createServer((req, res) => handler(req, res).catch(error => res.writeHead(500).end(String(error))))
  await once(graph.listen(0, '127.0.0.1'), 'listening')
  process.env.REVIEW_GRAPH_URL = address(graph)
  process.env.REVIEW_SESSION_SECRET = 'sample-secret-used-only-for-this-test'
  process.env.REVIEW_EVENTS_TOKEN = service
  const { reviewServer } = await import('../server.mjs')
  app = await reviewServer({ port: 0, host: '127.0.0.1' })
  origin = address(app)
  routes = (await import('../build/server/index.js')).routes
})
after(async () => {
  await close(app)
  await close(graph)
})
function post(values, cookie, from = origin) {
  return { method: 'POST', redirect: 'manual', headers: { ...(cookie && { cookie }), ...(from && { origin: from }) }, body: new URLSearchParams(values) }
}
function cookieFrom(response) {
  const header = response.headers.get('set-cookie')
  assert.ok(header, 'server sets a session cookie')
  return header.split(';')[0]
}
async function signin() {
  const response = await fetch(origin + '/signin', post({ token: reviewer }))
  assert.ok([302, 303].includes(response.status))
  return cookieFrom(response)
}
function routeModule(part) {
  const route = Object.values(routes).find(route => route.path?.includes(part))
  assert.ok(route, 'built route for ' + part)
  return route.module
}
async function invoke(fn, request, params = {}) {
  try {
    return await fn({ request, params, url: new URL(request.url), context: new RouterContextProvider() })
  } catch (error) {
    if (error instanceof Response) return error
    throw error
  }
}

test('the app refuses a session secret shorter than 32 characters', async () => {
  const { reviewServer } = await import('../server.mjs')
  // A server that starts anyway is closed, so the failure does not keep the test process open.
  await assert.rejects(reviewServer({ port: 0, host: '127.0.0.1', secret: 'x'.repeat(31) }).then(async server => { await close(server); return server }), /at least 32/)
  const accepted = await reviewServer({ port: 0, host: '127.0.0.1', secret: 'x'.repeat(32) })
  await close(accepted)
})

test('sign-in attempts are limited per address and a success clears the count', async () => {
  const { reviewServer } = await import('../server.mjs')
  const standalone = await reviewServer({ port: 0, host: '127.0.0.1' })
  try {
    const url = address(standalone)
    const attempt = token => fetch(url + '/signin', post({ token }, undefined, url))
    for (let i = 0; i < 9; i++) assert.equal((await attempt('a-wrong-token')).status, 401)
    assert.equal((await attempt(reviewer)).status, 303)
    for (let i = 0; i < 10; i++) assert.equal((await attempt('a-wrong-token')).status, 401)
    const asked = requests.filter(call => call.path === '/review/api/me').length
    const refused = await attempt(reviewer)
    assert.equal(refused.status, 429)
    assert.ok(Number(refused.headers.get('retry-after')) > 0)
    assert.match(await refused.text(), /Too many sign-in attempts from this address/)
    assert.equal(requests.filter(call => call.path === '/review/api/me').length, asked, 'a refused attempt does not reach the graph')
  } finally {
    await close(standalone)
  }
})

test('the sign-in page serves its favicon before a reviewer signs in', async () => {
  const html = await (await fetch(origin + '/signin')).text()
  const icon = /<link\b[^>]*\brel="icon"[^>]*>/.exec(html)?.[0]
  assert.ok(icon)
  const href = /\bhref="([^"]+)"/.exec(icon)?.[1]
  assert.equal(href, '/favicon.ico')
  const response = await fetch(origin + href, {redirect: 'manual'})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.match(await response.text(), /^<svg\b/)
})

test('loaders and actions check the graph token and submit a decision as the signed-in reviewer', async () => {
  const action = routeModule('signin').action
  const bad = await invoke(action, new Request(origin + '/signin', post({ token: 'wrong' })))
  assert.doesNotMatch(bad.headers?.get('set-cookie') ?? '', /sample-reviewer-token/)
  assert.ok(![302, 303].includes(bad.status ?? bad.init?.status), 'bad token does not sign in')
  const login = await invoke(action, new Request(origin + '/signin', post({ token: reviewer })))
  const cookie = cookieFrom(login)
  const accounts = routeModule('accounts')
  const view = await invoke(accounts.loader, new Request(origin + path, { headers: { cookie } }), { subject })
  assert.match(JSON.stringify(view), /First <visit>/)
  assert.ok(requests.some(call => call.path === '/review/api/subject' && call.query.get('subject') === subject))
  const form = { intent: 'join', subject, other: 'contact:73', reason: 'Confirmed by reviewer', key: crypto.randomUUID(), at: String(observed), seen: '0' }
  await invoke(accounts.action, new Request(origin + path, post(form, cookie)), { subject })
  assert.deepEqual(decisions.get(form.key)?.pairs, [{ a: subject, b: 'contact:73' }])
  assert.equal(decisions.get(form.key)?.by, 'dana')
})

test('production and non-loopback sessions require Secure and do not expose their credential', async () => {
  for (const address of ['https://review.example.org', 'http://review.example.org', 'https://localhost']) {
    // The hostname is used as input to the route handler. Its graph is the same loopback stub.
    const response = await invoke(routeModule('signin').action, new Request(address + '/signin', post({ token: reviewer }, undefined, address)))
    const header = response.headers.get('set-cookie')
    assert.match(header, /; Secure/i)
    const encoded = cookieFrom(response).split('=')[1]
    const value = JSON.parse(Buffer.from(decodeURIComponent(encoded).split('.')[0], 'base64').toString('utf8'))
    assert.deepEqual(Object.keys(value), ['id'])
    assert.notEqual(value.id, reviewer)
  }
})

function fieldsOf(form) {
  const result = new URLSearchParams()
  for (const [, attrs] of form.matchAll(/<(?:input|button)\b([^>]+)>/gi)) {
    const value = /\bvalue="([^"]*)"/i.exec(attrs)?.[1]
    const name = /\bname="([^"]+)"/i.exec(attrs)?.[1]
    if (name && value !== undefined) result.set(name, value)
  }
  return result
}
function redirectToLogin(response) {
  assert.ok([302, 303].includes(response.status), 'expected sign-in redirect, got ' + response.status)
  assert.equal(new URL(response.headers.get('location'), origin).pathname, '/signin')
}
test('a plain HTML client signs in, reads an account, posts its form twice and signs out both tabs', async () => {
  redirectToLogin(await fetch(origin + path, { redirect: 'manual' }))
  const signinPage = await fetch(origin + '/signin')
  assert.match(await signinPage.text(), /<form\b[^>]*method="post"/i)
  const login = await fetch(origin + '/signin', post({ token: reviewer }))
  const header = login.headers.get('set-cookie')
  assert.match(header, /; HttpOnly/i)
  assert.match(header, /; SameSite=Strict/i)
  assert.doesNotMatch(header, /; Secure/i, 'the test runs on loopback HTTP')
  const cookie = cookieFrom(login)
  const page = await fetch(origin + path, { headers: { cookie } })
  assert.equal(page.status, 200)
  const html = await page.text()
  const document = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replaceAll('<!-- -->', '')
  for (const evidence of ['Largest groups', 'Recent changes', 'Audit log', 'First seen here', 'Created in your system', '98%', 'Sightings', 'First &lt;visit&gt;', '<svg']) assert.ok(document.includes(evidence), 'SSR includes ' + evidence)
  assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'native POSTs keep their origin')
  const policy = page.headers.get('content-security-policy')
  const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(policy)?.[1]
  assert.ok(nonce, 'script policy carries a nonce')
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/)
  assert.match(policy, /frame-ancestors 'none'/)
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) assert.ok(tag.includes('nonce="' + nonce + '"'), tag)
  assert.doesNotMatch(html, /sample-reviewer-token|sample-events-token|on(?:click|submit|load)="/)
  const form = [...document.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(match => match[0]).find(form => fieldsOf(form).get('intent') === 'join')
  assert.ok(form, 'a rendered join form')
  const fields = fieldsOf(form)
  fields.set('other', 'contact:73')
  fields.set('reason', 'Confirmed at intake')
  const action = new URL(/\baction="([^"]+)"/.exec(form)?.[1] || path, origin)
  assert.equal(action.pathname, path, 'the form posts to the linked account address')
  for (const foreign of ['https://elsewhere.example.org', null]) {
    const previous = requests.filter(call => call.path === '/v1/decide').length
    const refused = await fetch(action, post(fields, cookie, foreign))
    assert.ok([400, 403].includes(refused.status), 'the framework or the action rejects the Origin')
    assert.equal(requests.filter(call => call.path === '/v1/decide').length, previous)
  }
  const invalid = new URLSearchParams(fields)
  invalid.set('other', subject)
  const rejected = await fetch(action, post(invalid, cookie))
  assert.equal(rejected.status, 400)
  assert.match((await rejected.text()).replace(/<script\b[^>]*>[^]*?<\/script>/gi, ''), /Choose two different IDs/)
  // An ID no record has is refused before anything is decided, and the page names the ID that was typed.
  const typo = new URLSearchParams(fields)
  typo.set('other', 'contact:37')
  const decided = requests.filter(call => call.path === '/v1/decide').length
  const unknown = await fetch(action, post(typo, cookie))
  assert.equal(unknown.status, 400)
  assert.match((await unknown.text()).replace(/<script\b[^>]*>[^]*?<\/script>/gi, ''), /No record has the ID contact:37\./)
  assert.equal(requests.filter(call => call.path === '/v1/decide').length, decided)
  for (const address of [action, origin + '/accounts/' + subject]) {
    const response = await fetch(address, post(fields, cookie))
    assert.equal(response.status, 303, 'a native submission redirects to its current account')
    assert.equal(response.headers.get('location'), path)
    const redirected = await fetch(new URL(response.headers.get('location'), origin), { headers: { cookie } })
    assert.match(await redirected.text(), /Created in your system/)
  }
  const input = decisions.get(fields.get('key'))
  assert.deepEqual(input?.pairs, [{ a: subject, b: 'contact:73' }])
  assert.equal(input?.reason, 'Confirmed at intake')
  assert.equal(input?.action, 'merge')
  const out = await fetch(origin + '/signout', post({}, cookie))
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  redirectToLogin(await fetch(origin + path, { redirect: 'manual', headers: { cookie } }))
})

test('a GET to /signout answers 405 without logging a server error', async () => {
  const cookie = await signin()
  const logged = []
  const { error } = console
  console.error = (...args) => logged.push(args)
  try {
    for (const headers of [{}, { cookie }]) {
      const answer = await fetch(origin + '/signout', { headers, redirect: 'manual' })
      assert.equal(answer.status, 405)
      assert.equal(answer.headers.get('allow'), 'POST')
      assert.match(await answer.text(), /Sign out button/)
    }
  } finally {
    console.error = error
  }
  assert.deepEqual(logged, [])
  assert.equal((await fetch(origin + path, { headers: { cookie } })).status, 200, 'a GET leaves the session signed in')
})

test('an account page links to the same record in the system of the firm, where the firm said how its addresses are made', async () => {
  const { reviewServer } = await import('../server.mjs')
  const page = async settings => {
    const standalone = await reviewServer({ port: 0, host: '127.0.0.1', ...settings })
    try {
      const url = address(standalone)
      const headers = { cookie: cookieFrom(await fetch(url + '/signin', post({ token: reviewer }, undefined, url))) }
      return (await (await fetch(url + path, { headers })).text()).replaceAll('<!-- -->', '').replaceAll('&amp;', '&')
    } finally {
      await close(standalone)
    }
  }
  // The ID is whatever follows the kind, and the link opens apart from the app.
  assert.ok((await page({ recordLinks: { account: 'https://crm.example.org/accounts/{id}?from=review' } })).includes('<a class="button" href="https://crm.example.org/accounts/42?from=review" target="_blank" rel="noopener noreferrer">Open in crm.example.org</a>'))
  // A firm that said nothing, or only of another kind of ID, gets no link.
  for (const settings of [{}, { recordLinks: { contact: 'https://crm.example.org/contacts/{id}' } }]) assert.doesNotMatch(await page(settings), /Open in /)
})

test('the original screen is linked only at REVIEW_LEGACY_URL, never at the graph address', async () => {
  const { reviewServer } = await import('../server.mjs')
  const pages = async settings => {
    const standalone = await reviewServer({ port: 0, host: '127.0.0.1', ...settings })
    try {
      const url = address(standalone)
      const headers = { cookie: cookieFrom(await fetch(url + '/signin', post({ token: reviewer }, undefined, url))) }
      return (await Promise.all(['/health', '/channels', '/decide'].map(async view => (await fetch(url + view, { headers })).text()))).join('').replaceAll('<!-- -->', '')
    } finally {
      await close(standalone)
    }
  }
  const unset = await pages({})
  assert.ok(!unset.includes(process.env.REVIEW_GRAPH_URL), 'the graph address is not in the page')
  assert.doesNotMatch(unset, /href="[^"]*#\/(health|channels|decide)"/)
  // Health, Channels and Matches are whole in the app, older records included, and none names the original screen.
  assert.match(unset, /<a href="\/decide\?older=all"[^>]*>Check older records<\/a>/)
  assert.doesNotMatch(unset, /original reviewer screen/)
  assert.doesNotMatch(unset, /Open the full|has the full/)
  for (const title of ['Health', 'Channels', 'Matches']) assert.match(unset, new RegExp('<h2 class="page-title"><svg[^>]*>.*?</svg>' + title + '</h2>'))
  const set = await pages({ legacyUrl: 'https://graph.example.org/review' })
  assert.doesNotMatch(set, /#\/(health|channels|decide)"/)
  assert.ok(!set.includes(process.env.REVIEW_GRAPH_URL))
  await assert.rejects(reviewServer({ port: 0, host: '127.0.0.1', legacyUrl: 'javascript:alert(1)' }).then(async server => { await close(server); return server }), /REVIEW_LEGACY_URL/)
})

test('pasted and linked subjects reopen the same record with their ID preserved', async () => {
  const cookie = await signin()
  const headers = { cookie }
  for (const view of ['accounts', 'journey']) {
    const pasted = '/' + view + '/' + subject + '?before=1'
    const page = await fetch(origin + pasted, { headers })
    assert.equal(page.status, 200)
    assert.equal(page.url, origin + '/' + view + '/account%3A42?before=1')
    const html = (await page.text()).split('<script')[0]
    assert.ok(html.includes(subject))
    const linkedView = view === 'accounts' ? 'journey' : 'accounts'
    const href = new RegExp('href="(/' + linkedView + '/[^"]+)"').exec(html)?.[1]
    assert.equal(href, '/' + linkedView + '/account%3A42')
    for (let read = 0; read < 2; read++) {
      const linked = await fetch(new URL(href, page.url), { headers, redirect: 'manual' })
      assert.equal(linked.status, 200)
      assert.match((await linked.text()).split('<script')[0], linkedView === 'accounts' ? /Created in your system/ : /No events/)
    }
  }
  const search = await fetch(origin + '/search', post({text: 'sample'}, cookie))
  assert.equal(search.status, 200)
  const matches = [...(await search.text()).split('<script')[0].matchAll(/<a\b[^>]*\bhref="(\/accounts\/[^"]+)"[^>]*><bdi>([^<]+)<\/bdi><\/a>/g)]
  assert.equal(matches.length, specialSubjects.length)
  assert.equal(new Set(matches.map(([, href]) => href)).size, specialSubjects.length)
  for (const id of specialSubjects) {
    const href = matches.find(([, , label]) => label === id)?.[1]
    assert.ok(href, 'search links to ' + id)
    for (let read = 0; read < 2; read++) {
      const linked = await fetch(new URL(href, search.url), { headers, redirect: 'manual' })
      assert.equal(linked.status, 200)
      assert.ok((await linked.text()).split('<script')[0].includes('">' + id + '</bdi></h2>'), id)
      assert.equal(requests.findLast(call => call.path === '/review/api/subject').query.get('subject'), id)
    }
  }
})

test('a graph refusal clears the session, a temporary outage renders an actionable error', async () => {
  const cookie = await signin()
  try {
    failure = 503
    const down = await fetch(origin + path, { redirect: 'manual', headers: { cookie } })
    assert.equal(down.status, 503)
    const page = (await down.text()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    assert.match(page, /try again|retry|reload/i)
    assert.doesNotMatch(page, /sample-reviewer-token/)
    failure = 0
    revoked = true
    const refused = await fetch(origin + path, { redirect: 'manual', headers: { cookie } })
    redirectToLogin(refused)
    assert.match(refused.headers.get('set-cookie') ?? '', /Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  } finally {
    failure = 0
    revoked = false
  }
  redirectToLogin(await fetch(origin + path, { redirect: 'manual', headers: { cookie } }))
})

test('a form sent while the graph is away is answered, so its page is not replaced', async () => {
  const cookie = await signin()
  const form = { intent: 'join', subject, other: 'contact:73', reason: 'Met at intake', key: crypto.randomUUID(), at: String(observed), seen: '0', _enhanced: '1' }
  const sent = () => requests.filter(call => call.path === '/v1/decide').length
  // What a page with scripts sends: the action alone, with no page around it.
  const send = async (address, fields) => { const answer = await fetch(address, post(fields, cookie)); return [answer.status, await answer.text()] }
  try {
    failure = 503
    const before = sent()
    const [status, said] = await send(origin + path + '.data', form)
    assert.equal(status, 503)
    assert.match(said, /The graph did not answer, so this may not have been saved\. What you entered is still here\./)
    assert.doesNotMatch(said, /could not be opened|sample-reviewer-token/)
    const [searched, found] = await send(origin + '/search.data', { text: 'Ana' })
    assert.equal(searched, 503)
    assert.doesNotMatch(found, /could not be opened/)
    assert.equal(sent(), before)
    // The graph takes the decision and its answer is lost. The reviewer is told the same, because the app cannot know which it was.
    failure = 0
    lostReply = true
    const lost = { ...form, key: crypto.randomUUID(), reason: 'Answer lost on the way' }
    const [dropped, unsure] = await send(origin + path + '.data', lost)
    assert.equal(dropped, 503)
    assert.match(unsure, /may not have been saved/)
    assert.equal(decisions.get(lost.key)?.reason, 'Answer lost on the way')
    // The same form sent again reaches the graph with the same key and time, which the graph records once.
    lostReply = false
    const [again, saved] = await send(origin + path + '.data', lost)
    assert.equal(again, 200)
    assert.match(saved, /Decision saved/)
    assert.deepEqual([...decisions.values()].filter(decision => decision.reason === 'Answer lost on the way').length, 1)
  } finally {
    failure = 0
    lostReply = false
  }
})

test('Chrome keeps a page that reads itself again while the graph does not answer, and says so', { skip: !process.env.CHROME && 'set CHROME to read a page again through an outage', timeout: 40000 }, async t => {
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, close: closeBrowser } = await browse(origin + path)
  t.after(closeBrowser)
  t.after(() => { failure = 0 })
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = ${JSON.stringify(reviewer)}
    input.form.requestSubmit()
  }`)
  await until('enhanced account', () => run("Boolean(document.querySelector('input[type=range]'))").catch(() => false))
  const reads = () => requests.filter(call => call.path !== '/v1/events' && call.path !== '/review/api/pulse').length
  await until('the stored zone', () => run("document.cookie.includes('review_zone=')").catch(() => false))
  for (let seen = -1; seen !== reads();) { seen = reads(); await new Promise(resolve => setTimeout(resolve, 500)) }
  // The page reads itself again, as it does on a change, and the graph does not answer. What it showed stays, with a note.
  failure = 503
  const before = reads()
  await run('window.__reactRouterDataRouter.revalidate()')
  const kept = await until('the note', () => run(`document.body.innerText.includes('The graph is not answering. This page shows what it last read.') && JSON.stringify([Boolean(document.querySelector('input[type=range]')), document.body.innerText.includes('could not be opened'), document.body.innerText.includes(${JSON.stringify(subject)})])`).catch(() => false))
  assert.deepEqual(JSON.parse(kept), [true, false, true])
  assert.ok(reads() > before, 'the page asked the graph')
  // Once the graph answers, the next read clears the note.
  failure = 0
  await run('window.__reactRouterDataRouter.revalidate()')
  await until('the note gone', () => run("!document.body.innerText.includes('The graph is not answering')").catch(() => false))
  // A page this tab has not shown has nothing to keep, and says it cannot be opened.
  failure = 503
  await run("window.__reactRouterDataRouter.navigate('/decide')")
  await until('the error page', () => run("document.body.innerText.includes('The page could not be opened')").catch(() => false))
})

test('Chrome keeps a form open with what was typed when the graph does not answer, and sends it once the graph is back', { skip: !process.env.CHROME && 'set CHROME to check a form through an outage', timeout: 40000 }, async t => {
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, close: closeBrowser } = await browse(origin + path)
  t.after(closeBrowser)
  t.after(() => { failure = 0 })
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = ${JSON.stringify(reviewer)}
    input.form.requestSubmit()
  }`)
  await until('enhanced account', () => run("Boolean(document.querySelector('input[type=range]'))").catch(() => false))
  // On its first load a page stores the browser's zone and reads itself once more. The outage begins after that, when the page is at rest.
  const reads = () => requests.filter(call => call.path !== '/v1/events' && call.path !== '/review/api/pulse').length
  await until('the stored zone', () => run("document.cookie.includes('review_zone=')").catch(() => false))
  for (let seen = -1; seen !== reads();) { seen = reads(); await new Promise(resolve => setTimeout(resolve, 500)) }
  const join = `document.querySelector('input[name=intent][value=join]').form`
  await run(`{
    const form = ${join}
    form.closest('details').open = true
    form.elements.other.value = 'contact:73'
    form.elements.reason.value = 'Met at intake, during the outage'
  }`)
  failure = 503
  await run(`${join}.requestSubmit()`)
  const kept = await until('the answer beside the form', () => run(`(() => {
    const form = document.querySelector('input[name=intent][value=join]')?.form
    if (!form || !document.body.innerText.includes('The graph did not answer')) return false
    return JSON.stringify([form.closest('details').open, form.elements.other.value, form.elements.reason.value, Boolean(document.querySelector('input[type=range]')), document.body.innerText.includes('The page could not be opened')])
  })()`).catch(() => false))
  assert.deepEqual(JSON.parse(kept), [true, 'contact:73', 'Met at intake, during the outage', true, false])
  // The same form, sent again once the graph answers, is recorded as it was typed.
  failure = 0
  await run(`${join}.requestSubmit()`)
  await until('the decision', () => [...decisions.values()].some(decision => decision.pairs?.[0]?.b === 'contact:73' && decision.reason === 'Met at intake, during the outage'))
})

test('a graph that drops the connection or never answers gives the reviewer a bounded recovery page', { timeout: 18000 }, async () => {
  const cookie = await signin()
  try {
    for (const issue of ['down', 'slow']) {
      interrupted = issue
      const query = await fetch(origin + path, { headers: { cookie }, signal: AbortSignal.timeout(13000) })
      assert.equal(query.status, 503)
      const visible = (await query.text()).replace(/<script\b[^>]*>[^]*?<\/script>/gi, '')
      assert.match(visible, /graph is unavailable/i)
      assert.match(visible, /Try again/i)
    }
  } finally {
    interrupted = undefined
  }
  const recovered = await fetch(origin + path, { headers: { cookie } })
  assert.match(await recovered.text(), /Created in your system/)
})

test('events resume at Last-Event-ID and sign-out ends the other tab’s stream', { timeout: 20000 }, async () => {
  const cookie = await signin()
  changes.push({ schemaVersion: 1, type: 'cluster.changed', seq: 1, at: observed, data: { subject, from: null, to: subject } })
  const controller = new AbortController()
  try {
    const response = await fetch(origin + '/events', { signal: controller.signal, headers: { cookie, 'last-event-id': 'sample.0' } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const stream = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let records = ''
    while (!/id:\s*sample\.1[^]*?\n\n/.test(records)) {
      const chunk = await stream.read()
      assert.equal(chunk.done, false)
      records += chunk.value.replaceAll('\r\n', '\n')
    }
    assert.match(records, /event:\s*change/)
    assert.match(records, /accounts/i)
    assert.match(records, /account:42/)
    assert.ok(requests.some(call => call.path === '/v1/events' && call.input.after === 'sample.0'))
    await fetch(origin + '/signout', post({}, cookie))
    while (!(await stream.read()).done) {}
  } finally {
    controller.abort()
  }
})

test('a graph 401 to the events token ends live updates and keeps the reviewer signed in', async () => {
  const cookie = await signin()
  eventsRevoked = true
  try {
    const stream = await fetch(origin + '/events', { headers: { cookie }, signal: AbortSignal.timeout(4000) })
    const text = await stream.text()
    assert.match(text, /event: unavailable/)
    assert.doesNotMatch(text, /event: signout/)
  } finally {
    eventsRevoked = false
  }
  assert.equal((await fetch(origin + path, { headers: { cookie }, redirect: 'manual' })).status, 200)
})

test('open tabs share one follower of the graph that starts with the first tab and stops with the last', { timeout: 30000 }, async () => {
  const tabs = []
  const reads = () => requests.filter(call => call.path === '/v1/events' || (call.path === '/review/api/pulse' && call.authorization === 'Bearer ' + service))
  try {
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController()
      const response = await fetch(origin + '/events', { signal: controller.signal, headers: { cookie: await signin() } })
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      assert.match((await reader.read()).value, /connected/)
      tabs.push({ controller, reader })
    }
    const from = reads().length
    const times = () => requests.filter(call => call.path === '/v1/events').map(call => call.time)
    const start = times().length
    while (times().length < start + 3) await new Promise(resolve => setTimeout(resolve, 50))
    const gaps = times().slice(start).map((time, i, all) => i ? time - all[i - 1] : Infinity)
    assert.ok(Math.min(...gaps) >= 1000, 'one follower polls at its own interval, not once per tab: ' + gaps.join(', '))
    assert.ok(reads().length - from <= 8, 'six tabs make one pulse and one events read per interval')
  } finally {
    for (const tab of tabs) tab.controller.abort()
  }
  await new Promise(resolve => setTimeout(resolve, 200))
  const after = reads().length
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(reads().length, after, 'the follower stops with the last tab')
})

test('a server shutdown ends open streams without signing the reviewer out', async () => {
  const { reviewServer } = await import('../server.mjs')
  const standalone = await reviewServer({ port: 0, host: '127.0.0.1', eventsToken: service })
  try {
    const url = address(standalone)
    const cookie = cookieFrom(await fetch(url + '/signin', post({ token: reviewer }, undefined, url)))
    const response = await fetch(url + '/events', { headers: { cookie }, signal: AbortSignal.timeout(8000) })
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let text = (await reader.read()).value
    assert.match(text, /connected/)
    standalone.close()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += chunk.value
    assert.doesNotMatch(text, /signout/)
  } finally {
    standalone.closeAllConnections()
  }
})

test('after a restart a reviewer is told their session ended, and is sent back to their page on signing in', async () => {
  const { reviewServer } = await import('../server.mjs')
  const first = await reviewServer({ port: 0, host: '127.0.0.1' })
  let cookie
  try {
    const url = address(first)
    cookie = cookieFrom(await fetch(url + '/signin', post({ token: reviewer }, undefined, url)))
    assert.equal((await fetch(url + '/accounts', { headers: { cookie }, redirect: 'manual' })).status, 200)
  } finally {
    first.closeAllConnections()
    first.close()
  }
  // Another process, with the same secret, has no record of the session the cookie names.
  const second = await reviewServer({ port: 0, host: '127.0.0.1' })
  try {
    const url = address(second)
    const sent = await fetch(url + '/accounts', { headers: { cookie }, redirect: 'manual' })
    assert.deepEqual([sent.status >= 300 && sent.status < 400, new URL(sent.headers.get('location'), url).pathname, new URL(sent.headers.get('location'), url).searchParams.get('next')], [true, '/signin', '/accounts'])
    const page = await fetch(new URL(sent.headers.get('location'), url), { headers: { cookie } })
    const html = (await page.text()).split('<script')[0].replaceAll('<!-- -->', '')
    assert.match(html, /<p role="status" id="ended">Your session has ended\. That happens when the review app is restarted, after eight hours, or when you sign out in another tab\. Sign in again and you return to the page you were on\./)
    assert.match(html, /name="next" value="\/accounts"/)
    // The answer clears no cookie. One that did could arrive after a sign-in from another tab and undo it.
    assert.equal(page.headers.get('set-cookie'), null)
    // Opened by itself, the page promises no return to a page it was not given.
    const bare = (await (await fetch(url + '/signin', { headers: { cookie } })).text()).split('<script')[0].replaceAll('<!-- -->', '')
    assert.match(bare, /in another tab\. Sign in again\. Decisions you had saved are kept\./)
    // Somebody who was never signed in is told nothing of the kind.
    assert.doesNotMatch((await (await fetch(url + '/signin')).text()).split('<script')[0], /Your session ended/)
    const again = await fetch(url + '/signin', post({ token: reviewer, next: '/accounts' }, undefined, url))
    assert.deepEqual([again.status, new URL(again.headers.get('location'), url).pathname], [303, '/accounts'])
  } finally {
    second.closeAllConnections()
    second.close()
  }
})

test('without a service events token authenticated HTML still works', async () => {
  const { reviewServer } = await import('../server.mjs')
  const standalone = await reviewServer({ port: 0, host: '127.0.0.1', eventsToken: '' })
  try {
    const url = address(standalone)
    const logged = await fetch(url + '/signin', post({ token: reviewer }, undefined, url))
    const headers = { cookie: cookieFrom(logged) }
    const answer = await fetch(url + '/events', { headers })
    assert.equal(answer.status, 204)
    assert.equal(await answer.text(), '')
    const page = await fetch(url + path, { headers })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Live updates are off\. Reload to see changes\./)
  } finally {
    await close(standalone)
  }
})

test('Chrome without a service events token opens no stream and never reports an interruption', { skip: !process.env.CHROME && 'set CHROME to check live updates in a browser', timeout: 40000 }, async t => {
  const { reviewServer } = await import('../server.mjs')
  const standalone = await reviewServer({ port: 0, host: '127.0.0.1', eventsToken: '' })
  t.after(() => close(standalone))
  const seen = []
  standalone.on('request', request => seen.push(request.url))
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, close: closeBrowser } = await browse(address(standalone) + path)
  t.after(closeBrowser)
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = ${JSON.stringify(reviewer)}
    input.form.requestSubmit()
  }`)
  await until('the enhanced account', () => run("Boolean(document.querySelector('input[type=range]'))").catch(() => false))
  // Effects that would open a stream have run. A later request from the page arrives after any request they made.
  assert.equal(await run("fetch('/favicon.ico').then(answer => answer.status)"), 200)
  await until('the later request', () => seen.includes('/favicon.ico'))
  assert.deepEqual(seen.filter(url => url.startsWith('/events')), [])
  const footer = await run("document.querySelector('footer').innerText")
  assert.match(footer, /Live updates are off/)
  assert.doesNotMatch(footer, /interrupted/i)
})

test('a caller hash is shortened in its link as on the original screen, with the full ID in its title', async () => {
  const cookie = await signin()
  const caller = 'caller:3ea1d013bd8f00c1a7e4b2d9c6f5a8e7'
  const original = { ...account }
  try {
    account.links = [...original.links, { ...original.links[0], subject: caller }]
    account.cluster = { ...original.cluster, members: [...original.cluster.members, caller] }
    const html = (await (await fetch(origin + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
    const link = new RegExp('<a class="link subject" title="' + caller + '" href="/accounts/caller%3A3ea1d013bd8f00c1a7e4b2d9c6f5a8e7"[^>]*><bdi>caller:3ea1d013bd8…</bdi></a>')
    assert.match(html, link)
  } finally {
    Object.assign(account, original)
  }
})

test('a decision by another system names its author as the original screen does', async () => {
  const cookie = await signin()
  audited.push({ seq: 7, action: 'join', about: [subject, other], by: 'system:desk', at: observed, reason: 'answered by staff' })
  try {
    const html = (await (await fetch(origin + path, { headers: { cookie } })).text()).replaceAll('<!-- -->', '')
    assert.match(html, /<span class="chip" title="Sent by another system">system <bdi>desk<\/bdi><\/span>/)
    assert.doesNotMatch(html.replace(/<script[^]*?<\/script>/g, ''), /system:desk/)
  } finally {
    audited.length = 0
  }
})

test('right-to-left names and IDs are isolated from the text around them', async () => {
  const cookie = await signin()
  const hebrew = 'contact:\u05e9\u05dc\u05d5\u05dd-7'
  const original = { ...account }
  try {
    account.links = [...original.links, { ...original.links[0], subject: hebrew }]
    audited.push({ seq: 8, action: 'separate', about: [subject, hebrew], by: '\u05d3\u05e0\u05d4', at: observed, reason: '' })
    const html = (await (await fetch(origin + path, { headers: { cookie } })).text()).split('<script')[0].replaceAll('<!-- -->', '')
    assert.ok(html.includes('<bdi>' + hebrew + '</bdi></a>'), 'a linked ID')
    assert.ok(html.includes('<bdi>' + subject + '</bdi> · <bdi>' + hebrew + '</bdi>'), 'IDs in the audit log')
    assert.ok(html.includes('<bdi>\u05d3\u05e0\u05d4</bdi> · '), 'a decision author')
    assert.ok(html.includes('<bdi id="name">dana</bdi><button id="leave">Sign out</button>'), 'the signed-in reviewer')
    assert.ok(html.includes('">' + subject + '</bdi></h2>'), 'the account heading')
  } finally {
    Object.assign(account, original)
    audited.length = 0
  }
})

test('times are in the zone the browser stored, and in the report zone until it has', async () => {
  const { reviewServer } = await import('../server.mjs')
  const standalone = await reviewServer({ port: 0, host: '127.0.0.1' })
  try {
    const url = address(standalone)
    const cookie = cookieFrom(await fetch(url + '/signin', post({ token: reviewer }, undefined, url)))
    const created = async zone => {
      const html = (await (await fetch(url + path, { headers: { cookie: cookie + (zone ? '; review_zone=' + zone : '') } })).text()).replaceAll('<!-- -->', '')
      return /Created in your system <time dateTime="2026-09-20T00:00:00.000Z" title="2026-09-20T00:00:00.000Z">([^<]+)<\/time>/.exec(html)?.[1]
    }
    const probes = () => requests.filter(call => call.path === '/review/api/texts').length
    const before = probes()
    assert.equal(await created(), 'Sep 19, 2026, 8:00 PM EDT')
    assert.equal(await created(encodeURIComponent('Asia/Tokyo')), 'Sep 20, 2026, 9:00 AM GMT+9')
    assert.equal(await created('Mars%2FOlympus'), 'Sep 19, 2026, 8:00 PM EDT')
    assert.equal(probes() - before, 1, 'the report zone is asked for once')
  } finally {
    await close(standalone)
  }
})

test('Chrome stores its zone on first load and the page shows times in it', { skip: !process.env.CHROME && 'set CHROME to check times in the browser zone', timeout: 40000 }, async t => {
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, send, close: closeBrowser } = await browse('about:blank')
  t.after(closeBrowser)
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' })
  await send('Page.navigate', { url: origin + path })
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = ${JSON.stringify(reviewer)}
    input.form.requestSubmit()
  }`)
  await until('the account in the browser zone', () => run(`[...document.querySelectorAll('time')].some(time => time.textContent === 'Sep 20, 2026, 9:00 AM GMT+9')`).catch(() => false))
  assert.match(await run('document.cookie'), /review_zone=Asia%2FTokyo/)
})

test('the server bounds a large graph drawing and keeps every link reachable by ordinary pagination', async () => {
  const cookie = await signin()
  const original = { ...account }
  try {
    account.links = Array.from({ length: 700 }, (_, i) => ({ ...original.links[0], subject: 'contact:volume-' + i }))
    account.cluster = { ...original.cluster, members: [subject, ...account.links.map(link => link.subject)], oversized: true }
    account.edges = account.links.map(link => ({ ...original.edges[0], b: link.subject }))
    const page = async query => {
      const response = await fetch(origin + path + query, { headers: { cookie } })
      assert.equal(response.status, 200)
      return (await response.text()).replaceAll('<!-- -->', '')
    }
    // The same bound applies to the server-rendered table and its hydration payload.
    const first = await page('')
    assert.match(first, /Showing 24 of 700/)
    assert.doesNotMatch(first, /contact:volume-699/)
    assert.ok(first.includes('?links=1#links"'), 'SSR offers the next page of links')
    assert.match(await page('?links=13'), /contact:volume-699/)
  } finally {
    Object.assign(account, original)
  }
})

test('keyboard navigation, narrow forced colors, pending form and history keep the visible account correct', { skip: !process.env.CHROME && 'set CHROME to run keyboard and layout checks', timeout: 40000 }, async t => {
  const { browse, until } = await import('../../../test/chrome.ts')
  const { run, send, close: closeBrowser } = await browse(origin + path)
  t.after(closeBrowser)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, mobile: false, deviceScaleFactor: 1 })
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
  await until('the sign-in form', () => run("Boolean(document.querySelector('input[name=token]'))").catch(() => false))
  await run(`{
    const input = document.querySelector('input[name=token]')
    input.value = ${JSON.stringify(reviewer)}
    input.form.requestSubmit()
  }`)
  await until('enhanced account', () => run("Boolean(document.querySelector('input[type=range]'))").catch(() => false))
  const camera = await run(`document.querySelector('svg[aria-label="Cluster graph"]').getAttribute('viewBox')`)
  await run(`document.querySelector('button[aria-label="Zoom in"]').click()`)
  await until('the graph zoom', () => run(`document.querySelector('svg[aria-label="Cluster graph"]').getAttribute('viewBox') !== ${JSON.stringify(camera)}`))
  await run(`document.querySelector('.graph a.node').focus()`)
  for (const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent', {type, key:'Enter', code:'Enter', windowsVirtualKeyCode:13})
  await until('the selected node', () => run(`document.activeElement.matches('.graph .card .shut')`))
  for (const type of ['keyDown','keyUp']) await send('Input.dispatchKeyEvent', {type, key:'Escape', code:'Escape', windowsVirtualKeyCode:27})
  assert.equal(await run(`document.activeElement.matches('.graph a.node')`), true)
  assert.equal(await run(`document.documentElement.scrollWidth <= 320`), true)
  assert.equal(await run(`matchMedia('(forced-colors: active)').matches`), true)
  await run(`document.activeElement.blur()`)
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  assert.ok(await run(`document.activeElement.matches('a,button,input,summary,select')`))
  let release
  beforeDecision = new Promise(resolve => { release = resolve })
  try {
    await run(`{
      const form = document.querySelector('input[name=intent][value=join]').form
      form.closest('details').open = true
      form.elements.other.value = 'contact:another'
      form.requestSubmit()
    }`)
    await until('the pending button', () => run(`Boolean(document.querySelector('.decision-form button:disabled'))`))
    await run(`document.querySelector('a.subject[href$="contact%3A72"]').click()`)
    await until('the next account', () => run(`location.pathname.endsWith('contact%3A72') && document.body.innerText.includes('No records')`))
    release()
    await until('the finished action', () => !beforeDecision || [...decisions.values()].some(d => d.pairs?.[0]?.b === 'contact:another'))
    assert.doesNotMatch(await run(`document.body.innerText`), /Decision saved/)
    await run('history.back()')
    await until('back to the first account', () => run(`document.body.innerText.includes('Created in your system')`))
    await run('history.forward()')
    await until('forward to the second account', () => run(`document.body.innerText.includes('No records')`))
  } finally {
    release()
    beforeDecision = undefined
  }
})

test('Chrome with scripts disabled signs in, posts a native form, follows an account link and reloads it', { skip: !process.env.CHROME && 'set CHROME to verify native browser forms with scripts disabled', timeout: 40000 }, async t => {
  const { browse, until } = await import('../../../test/chrome.ts')
  const browser = await browse('about:blank')
  t.after(browser.close)
  const postOrigins = []
  const observe = request => {
    if (request.method === 'POST') postOrigins.push(request.headers.origin)
  }
  app.on('request', observe)
  t.after(() => app.off('request', observe))

  async function cdp(method, params = {}) {
    const reply = await browser.send(method, params)
    assert.ok(!reply.error, reply.error?.message)
    return reply.result
  }
  async function node(selector) {
    const { root } = await cdp('DOM.getDocument', { depth: 0 })
    const found = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector })
    return found.nodeId
  }
  // A control inside a <details> exists before the summary's Enter has opened it, and is focusable only once it renders.
  async function focus(selector) {
    await until(selector + ' to accept focus', async () => {
      const nodeId = await node(selector).catch(() => 0)
      return nodeId && !(await browser.send('DOM.focus', { nodeId }).catch(error => ({ error }))).error
    })
  }
  const frame = async () => (await cdp('Page.getFrameTree')).frameTree.frame
  const loadedAccount = async () => {
    const active = await frame()
    if (decodeURIComponent(new URL(active.url).pathname) !== '/accounts/' + subject) return false
    return (await node('.page-title').catch(() => 0)) && active.loaderId
  }
  await cdp('Emulation.setScriptExecutionDisabled', { value: true })
  await cdp('Page.navigate', { url: origin + path })
  await focus('input[name=token]')
  await cdp('Input.insertText', { text: reviewer })
  await focus('form:has(input[name=token]) button')
  await browser.press('Enter')
  const signedIn = await until('server-rendered account after native sign-in', loadedAccount)
  assert.equal(await node('button[aria-label="Zoom in"]'), 0)

  const join = 'details:has(input[name=intent][value=join])'
  await focus(join + ' > summary')
  await browser.press('Enter')
  await focus(join + ' input[name=other]')
  await cdp('Input.insertText', { text: 'contact:browser-native' })
  await focus(join + ' button[type=submit]')
  await browser.press('Enter')
  await until('native decision and the redirected document', async () => {
    const loader = await loadedAccount()
    return loader && loader !== signedIn && [...decisions.values()].some(input => input.pairs?.[0]?.b === 'contact:browser-native')
  })
  assert.deepEqual(postOrigins, [origin, origin])
  await focus('#links a.subject')
  await browser.press('Enter')
  async function linkedAccount(previous) {
    const active = await frame()
    if (active.loaderId === previous || decodeURIComponent(new URL(active.url).pathname) !== '/accounts/' + other) return false
    const detail = await node('#detail').catch(() => 0)
    if (!detail) return false
    const { outerHTML } = await cdp('DOM.getOuterHTML', { nodeId: detail })
    return outerHTML.includes('">' + other + '</bdi></h2>') && outerHTML.includes('No records') && active.loaderId
  }
  const followed = await until('the linked account without scripts', linkedAccount)
  await cdp('Page.reload')
  await until('the same linked account after reloading', () => linkedAccount(followed))
})
