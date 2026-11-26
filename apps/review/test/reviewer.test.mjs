import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { RouterContextProvider } from 'react-router'

const subject = 'account:42'
const path = '/accounts/' + encodeURIComponent(subject)
const other = 'contact:72'
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
let app, graph, origin, routes, revoked = false, failure = 0
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const bytes = []
  for await (const chunk of req) bytes.push(chunk)
  const input = bytes.length ? JSON.parse(Buffer.concat(bytes)) : null
  const authorization = req.headers.authorization
  requests.push({ path: url.pathname, query: url.searchParams, authorization, input })
  if (failure) return send(failure, { error: 'The sample graph is unavailable' })
  if (url.pathname === '/v1/events') {
    if (authorization !== 'Bearer ' + service) return send(403, { error: 'Only the service reads events' })
    const from = input.after === null ? 0 : Number(input.after.split('.').at(-1))
    return send(200, { ok: true, value: { schemaVersion: 1, events: changes.slice(from), cursor: 'sample.' + changes.length, more: false } })
  }
  if (revoked || authorization !== 'Bearer ' + reviewer) return send(401, { error: 'The token was not accepted' })
  switch (url.pathname) {
    case '/review/api/me': return send(200, { reviewer: 'dana', retraction: { targets: [], always: false }, targets: {}, limits: { returnHours: null, openHours: false } })
    case '/review/api/subject': return send(200, url.searchParams.get('subject') === subject ? account : { known: false, subject: url.searchParams.get('subject') })
    case '/review/api/clusters': return send(200, [{ id: subject, size: account.cluster.members.length, oversized: false }])
    case '/review/api/recent': return send(200, [])
    case '/review/api/decisions': return send(200, { decisions: [], next: null, total: 0 })
    case '/review/api/audit': return send(200, { sound: true, head: null })
    case '/review/api/pulse': return send(200, { version: changes.length })
    case '/v1/decide': {
      const previous = decisions.get(input.key)
      if (previous) assert.deepEqual(input, previous, 'reposting the same form must preserve its decision key and timestamp')
      decisions.set(input.key, input)
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
    return await fn({ request, params, context: new RouterContextProvider() })
  } catch (error) {
    if (error instanceof Response) return error
    throw error
  }
}

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
  const form = { intent: 'join', subject, other, reason: 'Confirmed by reviewer', key: crypto.randomUUID(), at: String(observed), seen: '0' }
  await invoke(accounts.action, new Request(origin + path, post(form, cookie)), { subject })
  assert.deepEqual(decisions.get(form.key)?.pairs, [{ a: subject, b: other }])
  assert.equal(decisions.get(form.key)?.by, 'dana')
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
  for (const foreign of ['https://elsewhere.example.org', null]) {
    const previous = requests.filter(call => call.path === '/v1/decide').length
    const refused = await fetch(action, post(fields, cookie, foreign))
    assert.ok([400, 403].includes(refused.status), 'the framework or the action rejects the Origin')
    assert.equal(requests.filter(call => call.path === '/v1/decide').length, previous)
  }
  for (let i = 0; i < 2; i++) {
    const response = await fetch(action, post(fields, cookie))
    assert.ok([200, 302, 303].includes(response.status), 'a valid join succeeds')
  }
  const input = decisions.get(fields.get('key'))
  assert.deepEqual(input?.pairs, [{ a: subject, b: 'contact:73' }])
  assert.equal(input?.reason, 'Confirmed at intake')
  assert.equal(input?.action, 'merge')
  const out = await fetch(origin + '/signout', post({}, cookie))
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  redirectToLogin(await fetch(origin + path, { redirect: 'manual', headers: { cookie } }))
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
