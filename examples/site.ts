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
import { accountGraph } from '../src/index.ts'

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
<h1>${title}</h1>${body}<p><a href="/who">Show this browser's cluster</a></p>${tag(host)}`

/** The graph server, as your own backend would call it: over HTTP, with the service token. */
const graph = accountGraph({ url: GRAPH, token: TOKEN })

let accounts = Date.now() % 100_000

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const html = (text: string) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(text)
  const host = request.headers.host ?? `localhost:${PORT}`
  const device = /(?:^|; )ag_device=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
  try {
    if (url.pathname === '/') {
      return html(page(host, 'Example shop', `<p>Landing page. The script reports the <code>gclid</code> in the address to the server.</p>
        <form method="post" action="/signup" data-ag-fields><input name="email" type="email" placeholder="you@example.com" required> <button>Sign up</button>
        <label><input type="checkbox" name="other" data-ag-for-other> This is about somebody else, and the email is theirs</label></form>
        <p>The script also reports taps on <a href="tel:+15551230001">555-123-0001</a> and clicks on
        <button type="button" data-ag-event="brochure">Request a brochure</button>. Set <code>EVENTS=brochure,phone_click</code> on the server to record them.</p>
        <p><a href="${otherSite(host)}/">Second site</a>: the same site under another host name. Following the link keeps the visitor.
        <a href="/mail">Sample email</a> with a signed personal link.</p>`))
    }
    if (url.pathname === '/signup' && request.method === 'POST') {
      const form = new URLSearchParams(await new Response(request as unknown as ReadableStream).text())
      // The cookie names the visitor. Where there is none, the script tag added the same id to the form as it was
      // submitted, which is how a form posted to another system, one that never sees this site's cookie, carries it.
      // Ticked as about somebody else, the field has another name, and the cookie is that browser's too: it is whoever wrote, and not the account.
      const other = form.has('other')
      const filled = device ?? form.get(other ? 'ag_speaker_device' : 'ag_device')
      const subject = `account:${++accounts}`
      const at = Date.now()
      // Hand the server the facts as they are; it hashes the email and ties the account to the browser.
      // Count the sign-up too, so the report can set it beside what the campaign cost. The keys are the account's own, so a retry adds nothing.
      const { results } = await graph.record({ entries: [
        { type: 'profile', key: subject, at, subject, event: 'signup', facts: { email: form.get('email') ?? '', ...(filled && !other && { device: filled }) }, ...(filled && other && { speaker: { device: filled } }) },
        { type: 'conversion', key: subject, at, subject, stage: 'signup', value: 25, currency: 'USD' },
      ] })
      for (const result of results) if (!result.ok) throw new Error(`${result.type} was refused: ${result.reason}`)
      const { arrival, members } = (await graph.lookup({ kind: 'person', subjects: [subject], at })).people[0]!
      return html(page(host, 'Signed up', `<p>You are <code>${subject}</code>.</p>
        <p>${arrival ? `Attributed to <code>${arrival.source}${arrival.campaignId ? ` ${arrival.campaignId}` : ''}</code> at ${Math.round(arrival.confidence * 100)}% confidence.` : 'Unattributed.'}</p>
        <p>Known as: ${members.join(', ')}.</p>
        <p><a href="${GRAPH}/review#${encodeURIComponent(subject)}">Open the account</a> or <a href="${GRAPH}/review#!channels">the campaign report</a> on the reviewer screen. <a href="/">Back</a>.</p>`))
    }
    if (url.pathname === '/mail') {
      // Your backend knows a contact and asks the graph server for a link that names them. Needs LINK_SECRET on the server.
      const subject = `contact:${++accounts}`
      const at = Date.now()
      const { results: [link] } = await graph.record({ entries: [{ type: 'link', key: subject, at, subject, url: `http://${host}/`, expires: at + 30 * 86_400_000 }] })
      if (!link?.ok || link.type !== 'link') throw new Error('The link was refused')
      return html(page(host, 'Sample email', `<p>To <code>${subject}</code>: your offer is ready. <a href="${link.value.url}">Open it</a>.</p>
        <p>The link carries a signed token for this contact. Opening it links this browser to the contact.</p>`))
    }
    if (url.pathname === '/who') {
      const known = device ? (await graph.lookup({ kind: 'person', subjects: [`visitor:${device}`], at: Date.now() })).people[0] : undefined
      const cluster = known?.known ? known : null
      return html(page(host, 'Browser cluster', cluster
        ? `<p>This browser is <code>visitor:${device}</code>. Cluster members:</p><pre>${cluster.members.join('\n')}</pre>`
        : '<p>No data for this browser. Open the <a href="/">landing page</a> first.</p>'))
    }
    if (url.pathname === '/reset') {
      // Start over as a new visitor: forget the device id the collector kept in this browser.
      return response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['ag_device=; Max-Age=0; Path=/', 'ag_device=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'] })
        .end('<!doctype html><title>Reset</title><p id="out"></p><script>localStorage.removeItem("ag_device"); localStorage.removeItem("ag_click"); out.textContent = "Visitor reset. Device cookie present: " + /(^|; )ag_device=/.test(document.cookie)</script><a href="/">Back</a>')
    }
    response.writeHead(404).end('Not found')
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end(String((error as Error).message))
  }
}).listen(PORT, () => console.log(`example site: http://localhost:${PORT}/?gclid=demo-click&utm_id=20111`))
