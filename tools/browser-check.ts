// A local site plus the graph server, for running collect.ts in a real browser.
//   npm run build && DATABASE_URL=postgres://... node tools/browser-check.ts
// Then open http://localhost:8787/landing?gclid=TEST&utm_source=google and read the page.
// Open http://localhost:8787/cleanup afterwards to remove the cookies it set.
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createGraph, createOutbox, email, googleAds } from './internals.ts'
import { createPostgresStore } from '../src/store/postgres.ts'
import { createHandler } from '../test/harness.ts'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = createPostgresStore(pool, 'ag_browser')
if (!process.env.KEEP) await pool.query('drop schema if exists ag_browser cascade')
await store.migrate()
const graph = createGraph(store)
const sent: unknown[] = []
const outbox = createOutbox(graph, store.outbox, {
  targets: [googleAds({ customerId: '123-456-7890', send: async (request) => (sent.push(request), { requestId: 'local-1' }) })],
})
const handler = createHandler(graph, { token: 'local-token', origins: ['http://localhost:8787'], outbox, cookie: true })
const collectJs = readFileSync(new URL('../dist/collect.js', import.meta.url), 'utf8')
const page = `<!doctype html><meta charset=utf-8><title>collector test</title><pre id=out>running</pre>
<script type=module>
import { collect, read } from '/collect.js'
const out = document.getElementById('out')
try {
  // Stand in for the Google tag: it sets these two cookies on a real site.
  document.cookie = '_ga=GA1.1.1234567890.1700000000; path=/'
  if (new URLSearchParams(location.search).has('cookieclick')) document.cookie = '_gcl_aw=GCL.1700000000.COOKIE-GCLID-9; path=/'
  const seen = read()
  await collect({ endpoint: 'http://localhost:8787/collect', canvas: 'browser-hash-1' })
  await new Promise((resolve) => setTimeout(resolve, 400))
  const enrolled = await (await fetch('/enroll', { method: 'POST' })).json()
  // With the server keeping the cookie, script must not be able to read it.
  const scriptSeesDeviceCookie = /(?:^|; )ag_device=/.test(document.cookie)
  out.textContent = JSON.stringify({ seen, scriptSeesDeviceCookie, enrolled }, null, 1)
} catch (error) { out.textContent = 'ERROR ' + error }
document.title = 'done'
</script>`
// Numbered from the clock, so a restart never reuses an id the outbox already holds.
let contact = Date.now() % 1_000_000
createServer(async (request, response) => {
  try {
    await serve(request, response)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
  }
}).listen(8787, 'localhost', () => console.log('listening on http://localhost:8787'))

async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost:8787')
  if (url.pathname === '/collect.js') return void response.writeHead(200, { 'content-type': 'text/javascript' }).end(collectJs)
  if (url.pathname === '/' || url.pathname === '/landing') return void response.writeHead(200, { 'content-type': 'text/html' }).end(page)
  if (url.pathname === '/cleanup') {
    // Cookies on localhost are shared by every port, so remove the ones this check set.
    // The device cookie is HttpOnly and Secure, so it is expired with the same attributes and then checked from the server side.
    const expire = ['ag_device', '_ga', '_gcl_aw'].flatMap((name) => [`${name}=; Max-Age=0; Path=/`, `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`])
    return void response
      .writeHead(200, { 'content-type': 'text/html', 'set-cookie': expire })
      .end('<!doctype html><title>cleaned</title><pre id=out>checking</pre><script>localStorage.removeItem("ag_device"); localStorage.removeItem("ag_click"); fetch("/cookies").then((r) => r.text()).then((left) => { out.textContent = "cookies left: " + left; document.title = "checked" })</script>')
  }
  if (url.pathname === '/cookies') {
    const left = (request.headers.cookie ?? '').split('; ').filter((part) => /^(ag_device|_ga|_gcl_aw)=/.test(part)).length
    return void response.writeHead(200, { 'content-type': 'text/plain' }).end(String(left))
  }
  if (url.pathname === '/enroll') {
    // What your own backend does at sign-up: read the device cookie, observe the contact, record the outcome.
    const device = /(?:^|; )ag_device=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
    const subject = `contact:${++contact}`
    const at = Date.now()
    await graph.observe({ subject, identifiers: [`device:${device}`, email(`person${contact}@example.com`)], at, event: 'enroll' })
    const attribution = await graph.attribute(subject, { at })
    await outbox.record({ transactionId: `enroll-${contact}`, subject, at, action: '900', value: 200, email: `person${contact}@example.com` })
    const pass = await outbox.run()
    const body = { deviceCookieSeenByServer: device, subject, reason: attribution.reason, credited: attribution.credited, pass, job: await outbox.get(`enroll-${contact}`), lastRequest: sent.at(-1), history: await graph.history(`visitor:${device}`) }
    return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  }
  return handler(request, response)
}
