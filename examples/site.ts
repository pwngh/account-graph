/**
 * A two-page site that uses the graph server the way a real one would:
 * a script tag on every page, and a sign-up that tells the server who the
 * visitor turned out to be.
 *
 *   docker compose up --build        the graph server on :8080
 *   node examples/site.ts            this site on :3000
 *
 * Open http://localhost:3000/?gclid=demo-click&utm_id=20111 and sign up.
 * Then open http://localhost:8080/review with the review token, and press
 * Channels to see the sign-up under its campaign.
 * http://localhost:3000/reset makes this browser a new visitor again.
 */
import { createServer } from 'node:http'

const GRAPH = process.env.GRAPH_URL ?? 'http://localhost:8080'
const TOKEN = process.env.GRAPH_TOKEN ?? 'change-me-service-token'
const PORT = Number(process.env.PORT ?? 3000)

// The same site answers on two host names, which a browser treats as two sites with separate cookies.
const HOSTS = ['localhost', '127.0.0.1']
const otherSite = (host: string) => `http://${HOSTS.find((name) => name !== host.split(':')[0]) ?? HOSTS[0]}:${PORT}`

// The one line a site adds. The script reports each visit to the server it was loaded from.
// `domains` names the other site, so a link to it carries the visitor along.
const tag = (host: string) => `<script type="module" src="${GRAPH}/collect.js?domains=${new URL(otherSite(host)).hostname}"></script>`

const page = (host: string, title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}pre{background:#f3f3f0;padding:1rem;overflow:auto}</style>
<h1>${title}</h1>${body}<p><a href="/who">Who does the graph think this browser is?</a></p>${tag(host)}`

/** Calls the graph server as your own backend would: over HTTP, with the service token. */
async function graph(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(GRAPH + path, { method, headers: { authorization: `Bearer ${TOKEN}` }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

let accounts = Date.now() % 100_000

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const html = (text: string) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(text)
  const host = request.headers.host ?? `localhost:${PORT}`
  const device = /(?:^|; )ag_device=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
  try {
    if (url.pathname === '/') {
      return html(page(host, 'Example shop', `<p>A landing page. If you arrived with <code>?gclid=…</code>, the script below has already told the graph server.</p>
        <form method="post" action="/signup" data-ag-fields><input name="email" type="email" placeholder="you@example.com" required> <button>Sign up</button></form>
        <p>Two things the script reports without any code here: a tap on <a href="tel:+15551230001">555-123-0001</a>, and a click on
        <button type="button" data-ag-event="brochure">Request a brochure</button>. The server keeps them when started with <code>EVENTS=brochure,phone_click</code>.</p>
        <p><a href="${otherSite(host)}/">Our other site</a> is this one under another host name. Follow the link and you stay one visitor there; type its address by hand and you are a stranger.
        <a href="/mail">See an email</a> with a link that names the person it was sent to.</p>`))
    }
    if (url.pathname === '/signup' && request.method === 'POST') {
      const form = new URLSearchParams(await new Response(request as unknown as ReadableStream).text())
      // The cookie names the visitor. Where there is none, the script tag added the same id to the form as it was
      // submitted, which is how a form posted to another system, one that never sees this site's cookie, carries it.
      const filled = device ?? form.get('ag_device')
      const subject = `account:${++accounts}`
      const at = Date.now()
      // Hand the server the facts as they are; it hashes the email and ties the account to the browser.
      const { changes } = await graph('POST', '/identify', { subject, at, event: 'signup', email: form.get('email'), ...(filled && { device: filled }) })
      // Count the sign-up, so the report can set it beside what the campaign cost.
      await graph('POST', '/convert', { transactionId: `signup-${subject}`, subject, at, stage: 'signup', value: 25, currency: 'USD' })
      const attribution = await graph('GET', `/attribute?subject=${encodeURIComponent(subject)}&at=${at}`)
      return html(page(host, 'Signed up', `<p>You are <code>${subject}</code>.</p>
        <p>The graph server ${attribution.credited ? `credits the ad click <code>${attribution.credited.gclid ?? attribution.credited.source ?? 'a visit'}</code> at ${Math.round(attribution.credited.confidence * 100)}% confidence.` : `found no ad click to credit (${attribution.reason}).`}</p>
        <p>Cluster changes from this sign-up: ${changes.length}.</p>
        <p><a href="${GRAPH}/review#${encodeURIComponent(subject)}">Open this account on the reviewer screen</a> (it asks for the review token), or <a href="${GRAPH}/review#!channels">see it in the channel report</a>. <a href="/">Back</a>.</p>`))
    }
    if (url.pathname === '/mail') {
      // Your backend knows a contact and asks the graph server for a link that names them. Needs LINK_SECRET on the server.
      const subject = `contact:${++accounts}`
      const link = await graph('POST', '/link', { url: `http://${host}/`, subject })
      return html(page(host, 'An email we might send', `<p>To <code>${subject}</code>: your offer is ready. <a href="${link.url}">Open it</a>.</p>
        <p>The link carries a signed token naming the contact. Opening it ties this browser to them, and the script takes the token out of the address bar.</p>`))
    }
    if (url.pathname === '/who') {
      const cluster = device ? await graph('GET', `/cluster?subject=${encodeURIComponent(`visitor:${device}`)}`) : null
      return html(page(host, 'Who this browser is', cluster
        ? `<p>This browser is <code>visitor:${device}</code>. The graph treats these as one person:</p><pre>${cluster.members.join('\n')}</pre>`
        : '<p>The graph has not seen this browser yet. Open the <a href="/">first page</a> and come back.</p>'))
    }
    if (url.pathname === '/reset') {
      // Start over as a new visitor: forget the device id the collector kept in this browser.
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['ag_device=; Max-Age=0; Path=/', 'ag_device=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'] })
        .end('<!doctype html><title>Reset</title><p id="out"></p><script>localStorage.removeItem("ag_device"); localStorage.removeItem("ag_click"); out.textContent = "This browser is a new visitor again. Device cookie present: " + /(^|; )ag_device=/.test(document.cookie)</script><a href="/">Back</a>')
    }
    response.writeHead(404).end('Not found')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end(String((error as Error).message))
  }
}).listen(PORT, () => console.log(`example site: http://localhost:${PORT}/?gclid=demo-click&utm_id=20111`))
