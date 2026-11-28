import assert from 'node:assert/strict'
import { test } from 'node:test'
import { campaignsOf, startFirm } from '../../../examples/firm/firm.ts'
import { PRACTICES } from '../../../examples/firm/practice.ts'
import { hashPhone } from '../../../tools/internals.ts'
import { browse, pageCommands, until } from '../../../test/chrome.ts'

type Practice = keyof typeof PRACTICES
type Scene = { title: string, see: [string, string], spot?: string[] }
const without = process.env.CHROME || process.env.CI ? false : 'set CHROME to run the stage in a browser'

function story(practice: Practice) {
  const kind = PRACTICES[practice]
  const names = campaignsOf(kind)
  const said = (name: string) => name.replaceAll('|', '\\|')
  const last = kind.links.last
  const first = kind.value.toLocaleString('en-US')
  const caller = `caller:${hashPhone('+15550100042')}`
  // What each scene says, and what the view it points to says then and did not before.
  const step = (name: string, value: string) => (text: string) => (text.includes(`${name} · ${value}`) ? name : '')
  const column = (name: string) => (text: string) => (new RegExp(`\n${name}\n[^]*contact:ines-vega`).test(text.slice(0, text.indexOf('contact:ines-vega') + 17)) ? `in ${[...text.slice(0, text.indexOf('contact:ines-vega')).matchAll(/\n(inquiry|intake|signed|scheduled|client)\n/g)].at(-1)?.[1]}` : '')
  const expected: [RegExp, (text: string) => string][] = [
    [/office north, language es/, (text) => row(text, names.spanish)],
    [/by the tap\. State: waiting\. Counted: no/, (text) => (/Waiting/.test(text) ? text : '')],
    [/State: missed\. Counted: no\. Sent to the ad platform: no/, (text) => (text.includes(caller.slice(0, 14)) ? 'on the board' : '')],
    [/Missed call: returned\./, (text) => (/returned after/i.test(text) && /answered/i.test(text) ? 'returned' : '')],
    // Tied to a name, and not yet sure enough to credit the ad.
    [/tied to a name\. Ad credit: (7|8)\d%, below the 90%/, (text) => (text.includes('contact:ines-vega') && text.includes('phone 85%') ? 'by phone' : '')],
    [/Link for form: not opened/, () => 'nothing yet'],
    [new RegExp(`whose browser this is\\. Ad credit: 92%, to ${said(names.spanish)}`), (text) => (/link 92%/.test(text) ? 'by link' : '')],
    [/Step recorded: intake/, column('intake')],
    [new RegExp(`Step recorded: ${kind.papers}`), column(kind.papers)],
    [new RegExp(`Step recorded: scheduled, ${kind.lead} ortega`), column('scheduled')],
    [/Outbound call answered/, (text) => (text.includes('Duration 1,290 s') ? 'called' : '')],
    [new RegExp(`Text recorded\\. Link for ${last}: not opened`), (text) => (new RegExp(`Link sent · ${last}\\s*Not opened`).test(text) ? 'not opened' : '')],
    [new RegExp(`Link for ${last}: opened after 3 minutes\\. ${kind.told.lastOpen}`), (text) => (new RegExp(`Link sent · ${last}\\s*Opened after 3 min`).test(text) ? 'opened' : '')],
    [new RegExp(`${kind.told.won}: ${kind.value} USD\\. Advertised: north\\. Served: river\\. Attributed to ${said(names.spanish)} at 92%`), (text) => step(kind.won, `${first} USD`)(text) && `${/office served: river/.test(text)} ${text.includes(`${kind.lead}: ortega`)}`],
    [new RegExp(`Sent to the sample ad platform: ${kind.value} USD, for the first ad click`), (text) => (new RegExp(`${kind.won} · ${first} USD[^]{0,120}Sent to google`).test(text) ? 'sent' : '')],
    [new RegExp(`Initial value ${kind.value} USD, current value ${kind.later} USD.*ad platform: ${kind.later} USD`), (text) => (text.includes(`from ${first} USD to ${kind.later.toLocaleString('en-US')} USD`) ? 'restated' : '')],
    [/Before: joined.*Same cluster: no/, (text) => (text.includes('contact:tomas-vega') && /separated/i.test(text) ? 'separated' : '')],
    [/By the number, on Inés’s timeline: yes\. Said by dana: contact:tomas-vega\. On Inés’s timeline now: no\./, (text) => (/Duration 180 s · Record holder confirmed by dana/.test(text) ? 'his call' : '')],
    [/Refused: dana answered first\. The call stays as dana left it\./, (text) => (/confirmed by (\w+)/.exec(text)?.[1] ?? '')],
    [new RegExp(`Attributed to ${said(names.listing)}`), (text) => row(text, names.listing)],
    [new RegExp(`Step recorded: inquiry\\. Credited to ${said(names.river)} at 9\\d%, by the browser`), (text) => (text.includes('contact:rosa-marin') ? 'in inquiry' : '')],
    [/Linked at 85% by phone: related/, (text) => (text.includes('contact:marta-lago') && text.includes('contact:teo-lago') ? 'a pair' : '')],
    [/Marta’s two contacts: joined\. Marta and Teo: separated\./, (text) => (text.includes('contact:marta-lago-2') && /separated/i.test(text) ? 'joined and apart' : '')],
    [/Linked at 85%: related/, (text) => (text.includes('contact:newborn-1') && text.includes('contact:newborn-2') ? 'a pair' : '')],
    [/First: may be texted\. Again, with STOP: no more texts\. The opt-out was added\./, (text) => (text.includes('Asked for no more texts') ? 'stopped' : '')],
    [/Opened from the number\. Nothing was recorded\./, () => 'nothing new'],
    [/no calls for 12 hours/, (text) => (text.includes('Calls feed is stale') ? 'quiet' : '')],
  ]
  /** The line of a campaign in the Campaigns table, where a visit or a call is counted. The ranked list above it has one measure only. */
  function row(text: string, name: string, length = 120) {
    const at = text.indexOf(name, Math.max(0, text.indexOf('Attribution')))
    return at < 0 ? '' : text.slice(at, at + length)
  }
  return { names, said, expected }
}

function stageClient(graph: string) {
  let cookie = ''
  return async function request(path: string, values?: URLSearchParams, signal?: AbortSignal) {
    let url = new URL(path, graph)
    for (let redirect = 0; redirect < 4; redirect++) {
      assert.equal(url.origin, graph)
      const response = await fetch(url, { method: values ? 'POST' : 'GET', redirect: 'manual', headers: { cookie, ...(values && { origin: graph }) }, body: values, signal })
      const issued = response.headers.get('set-cookie')
      if (issued) cookie = issued.split(';')[0]!
      if (![302, 303].includes(response.status)) return response
      assert.ok(response.headers.get('location'))
      url = new URL(response.headers.get('location')!, url)
      values = undefined
    }
    throw new Error('Too many redirects from the stage')
  }
}

function sceneForm(html: string) {
  const text = html.replace(/<script\b[^>]*>[^]*?<\/script>/gi, '')
  for (const [form] of text.matchAll(/<form\b[^>]*>[^]*?<\/form>/gi)) {
    const fields = new URLSearchParams()
    for (const [, tag, node] of form.matchAll(/<(input|button)\b([^>]+)>/gi)) {
      const name = /\bname="([^"]+)"/i.exec(node!)?.[1]
      const value = /\bvalue="([^"]*)"/i.exec(node!)?.[1]
      if (name && value !== undefined && (tag === 'input' || value === 'run')) fields.set(name, value)
    }
    if (fields.get('intent') === 'run') return fields
  }
  throw new Error('Missing server-rendered Next form')
}

function visibleText(html: string) {
  return html.replace(/<script\b[^>]*>[^]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
}

/** The page without the cards its detail marks open. A card holds other divisions, so its end is found by counting them. */
function withoutCards(html: string) {
  let kept = ''
  let at = 0
  for (;;) {
    const start = html.indexOf('<div class="card-pop', at)
    if (start < 0) return kept + html.slice(at)
    kept += html.slice(at, start)
    const tag = /<(\/?)div\b/g
    tag.lastIndex = start
    let depth = 0
    at = html.length
    for (let found = tag.exec(html); found; found = tag.exec(html)) {
      depth += found[1] ? -1 : 1
      if (depth === 0) {
        at = html.indexOf('>', found.index) + 1
        break
      }
    }
  }
}

/** A page shows a person by name or number, with the exact ID first in a title. The scenes name people by ID, so each is read back as its ID. */
function byId(html: string) {
  return html.replace(/<bdi title="([^" ]+)[^"]*">[^<]*<\/bdi>/g, '<bdi>$1</bdi>').replace(/(<a class="link subject" title="([^" ]+)[^"]*"[^>]*>)<bdi>[^<]*<\/bdi>/g, '$1<bdi>$2</bdi>')
    .replace(/(<span class="queue-names">)<span title="([^"]+)">[^<]*<\/span><span title="([^"]+)">[^<]*<\/span>/g, '$1<span>$2</span><span>$3</span>')
}

async function reportText(client: ReturnType<typeof stageClient>, path: string) {
  const page = await client(path)
  assert.equal(page.status, 200, path)
  const html = byId((await page.text()).match(/<main\b[^>]*>([^]*?)<\/main>/)?.[1] ?? '')
  return visibleText(withoutCards(html).replace(/<details\b[^>]*>[^]*?<\/details>/g, '').replace(/<\/?(?:h[1-6]|li|div|section|p|td|tr)\b[^>]*>/g, '\n')).replace(/\n+/g, '\n')
}

test('the browser helper preserves DevTools protocol and page errors and matches each pending reply', async () => {
  const events = new EventTarget()
  const commands: { id: number, method: string, params: {returnByValue?: boolean} }[] = []
  const page = pageCommands({
    readyState: WebSocket.OPEN,
    addEventListener: events.addEventListener.bind(events),
    send(message) { commands.push(JSON.parse(String(message))) },
  })
  function reply(id: number, fields: object) {
    events.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, ...fields }) }))
  }
  // Runtime.evaluate can refuse a value before it supplies a JavaScript result.
  const document = page.run('document')
  const ready = page.run('true')
  assert.ok(commands.every(command => command.method === 'Runtime.evaluate' && command.params.returnByValue))
  reply(commands[1]!.id, { result: { result: { type: 'boolean', value: true } } })
  reply(commands[0]!.id, { error: { code: -32000, message: 'Object reference chain is too long' } })
  assert.equal(await ready, true)
  await assert.rejects(document, { message: 'Runtime.evaluate: Object reference chain is too long (-32000)' })
  const threw = page.run('missing()')
  reply(commands[2]!.id, { result: { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: missing is not defined' } } } })
  await assert.rejects(threw, { message: 'ReferenceError: missing is not defined' })
  const missing = page.run('42')
  reply(commands[3]!.id, {})
  await assert.rejects(missing, { message: 'Runtime.evaluate: DevTools returned no result' })
  const empty = page.run('42')
  reply(commands[4]!.id, { result: {} })
  await assert.rejects(empty, { message: 'Runtime.evaluate returned no evaluated value' })
  const unset = page.run('undefined')
  reply(commands[5]!.id, { result: { result: { type: 'undefined' } } })
  assert.equal(await unset, undefined)
  const interrupted = page.send('Page.getFrameTree', {})
  events.dispatchEvent(new Event('close'))
  await assert.rejects(interrupted, { message: 'Chrome closed the debugging connection' })
})

test('the stage publishes intermediate progress, completion and scene results to the waiting client', { timeout: 15000 }, async t => {
  let release!: () => void
  const loading = new Promise<void>(resolve => { release = resolve })
  const firm = await startFirm({}, { quick: true, say: () => loading })
  const controller = new AbortController()
  t.after(async () => {
    release()
    controller.abort()
    await firm.close()
  })
  const page = stageClient(firm.graph)
  const start = await page('/stage')
  const document = visibleText(await start.text())
  assert.match(document, /0 of 40 people/)
  const csp = start.headers.get('content-security-policy')!
  assert.ok(csp.split(';').map(rule => rule.trim()).includes('frame-src ' + firm.site))
  const events = await page('/events?stage=1', undefined, controller.signal)
  assert.match(events.headers.get('content-type')!, /text\/event-stream/)
  const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  async function next() {
    while (!buffered.includes('\n\n')) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      buffered += chunk.value
    }
    const boundary = buffered.indexOf('\n\n')
    const message = buffered.slice(0, boundary)
    buffered = buffered.slice(boundary + 2)
    assert.match(message, /event: stage/)
    return JSON.parse(message.split('data: ')[1]!)
  }
  const initial = await next()
  assert.equal(initial.ready, false)
  release()
  let state = initial
  const milestones: string[] = []
  while (!state.ready) {
    state = await next()
    milestones.push(state.progress)
  }
  assert.ok(milestones.includes('16 of 40 people') && milestones.includes('40 of 40 people'))
  assert.equal(state.boot, initial.boot)
  const ready = await page('/stage')
  const form = sceneForm(await ready.text())
  form.set('_enhanced', '1')
  const action = await page('/stage.data', form)
  assert.equal(action.status, 200)
  assert.equal(action.url, firm.graph + '/stage.data')
  assert.match(action.headers.get('content-type') ?? '', /text\/x-script/)
  assert.match(await action.text(), /"saved"/)
  while (state.next === 0) state = await next()
  assert.match(state.told.lines.join(' '), /office north, language es/)
  await page('/stage', new URLSearchParams({ intent: 'restart', boot: state.boot, expected: '1' }))
  while (state.boot === initial.boot || !state.ready) state = await next()
  assert.equal(state.next, 0)
  assert.deepEqual(state.told.lines, [])
})

for (const practice of ['family', 'injury'] as const) test('the ' + practice + ' stage runs all 27 scenes with JavaScript off', { timeout: 120_000 }, async t => {
  const began = performance.now()
  const firm = await startFirm({}, { quick: practice === 'injury', practice })
  t.after(() => firm.close())
  const page = stageClient(firm.graph)
  const { expected } = story(practice)
  let html = await until('seeded history', async () => {
    const html = await (await page('/stage')).text()
    return html.includes('data-ready="true"') ? html : undefined
  })
  const loadedMs = Math.round(performance.now() - began)
  let longestScene = 0, sceneIndex = 0, longestResponse = 0, responseIndex = 0
  const { scenes } = await (await page('/stage/scenes')).json() as { scenes: Scene[] }
  for (const [i, [tells, seen]] of expected.entries()) {
    const see = new URL(scenes[i]!.see[1], firm.graph)
    const path = see.hash.slice(1) || see.pathname
    const before = seen(await reportText(page, path))
    const fields = sceneForm(html)
    assert.equal(fields.get('expected'), String(i))
    const start = performance.now()
    const response = await page('/stage', fields)
    assert.equal(response.status, 200, 'scene ' + (i + 1))
    html = await response.text()
    const elapsed = Math.round(performance.now() - start)
    if (elapsed > longestResponse) {
      longestResponse = elapsed
      responseIndex = i + 1
    }
    assert.match(html, new RegExp('data-at="' + (i + 1) + '"'))
    assert.match(visibleText(html), tells)
    const after = seen(await reportText(page, path))
    if (['Form texted', 'Two at one call', 'What is behind a number'].includes(scenes[i]!.title)) assert.equal(after, before)
    else assert.ok(after && after !== before, 'scene ' + (i + 1) + ' affects ' + path + ' (' + JSON.stringify([before, after]).slice(0, 180) + ')')
    const ms = Number(/data-ms="([0-9]+)"/.exec(html)?.[1])
    if (ms > longestScene) {
      longestScene = ms
      sceneIndex = i + 1
    }
    assert.ok(ms < 1000, 'scene ' + (i + 1) + ' took ' + ms + ' ms')
    if (i === 0) {
      await page('/stage', fields)
      const replay = await (await page('/stage')).text()
      assert.match(replay, /data-at="1"/, 'double posting cannot advance another scene')
    }
  }
  t.diagnostic((practice === 'family' ? '320' : '40') + ' people, stage ready in ' + loadedMs + ' ms, slowest scene #' + sceneIndex + ' at ' + longestScene + ' ms, slowest form with complete HTML #' + responseIndex + ' at ' + longestResponse + ' ms')
})

for (const practice of ['family', 'injury'] as const) test('the ' + practice + ' stage shows loading progress and the effect of every scene without a reload', { skip: without, timeout: 180_000 }, async t => {
  const { run, press, send, close } = await browse('about:blank')
  t.after(close)
  let release!: () => void
  const proceed = new Promise<void>(resolve => { release = resolve })
  let restarts = 0
  const firm = await startFirm({}, { quick: true, practice, restart: () => { restarts++ }, say: () => proceed })
  t.after(() => { release(); return firm.close() })
  await send('Page.navigate', { url: firm.graph + '/stage' })
  const bar = async (name: string) => String(await run(`document.querySelector('#stage')?.dataset.${name} ?? ''`).catch(() => ''))
  await until('server progress on first load', async () => await bar('ready') === 'false' && await run(`/\\d+ of \\d+ people/i.test(document.body.innerText)`))
  assert.equal(await run(`document.querySelector('#stage button[value=run]').disabled`), true)
  const frame = async () => (await send('Page.getFrameTree', {})).result.frameTree.frame.loaderId
  const firstDocument = await frame()
  assert.ok(firstDocument)
  release()
  await until('live completion on the same page', async () => await bar('ready') === 'true')
  assert.equal(await frame(), firstDocument, 'loading completes in the same document')
  assert.equal(await run(`!(sessionStorage.getItem('token') || localStorage.getItem('token'))`), true)
  assert.equal(await run(`document.querySelector('.with-phone .device')?.dataset.state`), 'ad')
  const { scenes } = await run("fetch('/stage/scenes').then(response => response.json())") as { scenes: Scene[] }
  assert.equal(scenes.length, 27)
  assert.ok([400,403].includes((await fetch(firm.graph + '/stage', { method: 'POST' })).status))
  const links = scenes.map(({ see }) => see[1])
  const screen = await browse(firm.graph + '/stage')
  t.after(screen.close)
  // This browser has its own cookies. Let its stage sign-in finish before navigating away.
  await until('second screen signed in', () => screen.run(`Boolean(document.querySelector('#stage[data-ready="true"]'))`).catch(() => false))
  const view = async (href: string) => {
    const modernPath = new URL(href, firm.graph).hash.slice(1) || new URL(href, firm.graph).pathname
    const url = firm.graph + modernPath
    await screen.send('Page.navigate', { url: 'about:blank' })
    await until('a fresh document', () => screen.run("location.href === 'about:blank'").catch(() => false))
    await screen.send('Page.navigate', { url })
    const shown = await until('document for ' + href, () => screen.run(`document.readyState !== 'loading' && document.getElementById('view') && { href: location.href, text: document.getElementById('view').innerText, named: [...document.getElementById('view').querySelectorAll('a.subject[title], bdi[title], .queue-names span[title]')].filter(each => each.offsetParent !== null && !each.querySelector('bdi[title]')).map(each => [each.innerText, each.title.split(' · ')[0]]) }`).catch(() => false))
    const actual = new URL(shown.href)
    const requested = new URL(url)
    assert.equal(actual.origin, requested.origin)
    assert.deepEqual(actual.pathname.split('/').map(decodeURIComponent), requested.pathname.split('/').map(decodeURIComponent))
    assert.equal(actual.search, requested.search)
    // A person is shown by name or number. Each is read back as its ID, in the order the page shows them.
    let text = shown.text as string
    let from = 0
    for (const [seen, id] of shown.named as [string, string][]) {
      const at = seen ? text.indexOf(seen, from) : -1
      if (at < 0) continue
      text = text.slice(0, at) + id + text.slice(at + seen.length)
      from = at + id.length
    }
    return text.includes('\nAttribution') ? text.slice(text.indexOf('\nAttribution')) : text
  }
  const { names, said, expected } = story(practice)
  const read = async (path: string) => (await fetch(`${firm.graph}/review/api${path}`, { headers: { authorization: 'Bearer demo' } })).json() as Promise<any>
  const feeds = async () => ((await read('/ops')).feeds as { name: string; hours: number; quiet: boolean }[]).map(({ name, hours, quiet }) => [name, hours, quiet] as const)
  for (const [i, [tells, seen]] of expected.entries()) {
    const before = seen(await view(links[i]!))
    const began = performance.now()
    await press('Space')
    // The bar can receive the event before the loader finishes drawing the matching reviewer view.
    await until(`scene ${i + 1} and its reviewer view`, () => run(`
      document.querySelector('#stage[data-at="${i + 1}"][data-running="false"]') !== null &&
      document.querySelector('#stage-view')?.childElementCount > 0 &&
      Boolean(document.querySelector('#stage-view .spot')) === ${Boolean(scenes[i]!.spot)}
    `))
    assert.ok(performance.now() - began < 1000, 'scene ' + (i + 1) + ' reaches the presenter in under one second')
    assert.equal(await frame(), firstDocument, 'scene ' + (i + 1) + ' updates the original stage document')
    assert.match((await run(`document.querySelector('#stage .told').textContent`)) as string, tells)
    assert.ok(Number(await bar('ms')) < 1000, `scene ${i + 1} took ${await bar('ms')} ms`)
    // The stage opens what the scene changed, without a problem, and the phone goes once the call is over.
    assert.equal(await run(`document.getElementById('notice').textContent`), '')
    assert.equal(await run(`Boolean(document.querySelector('.with-phone'))`), i < 14)
    assert.equal(await run(`Boolean(document.querySelector('.spot'))`), Boolean(scenes[i]!.spot), `scene ${i + 1} lights its row`)
    // Until the last scene every feed is within its limit, however far the clock has moved.
    if (i < scenes.length - 1) assert.deepEqual((await feeds()).filter(([, , quiet]) => quiet), [], `the feeds after scene ${i + 1}`)
    // While it rings, the firm's own screen says where the caller came from.
    if (i === 1) assert.match((await run(`document.getElementById('stage-desk').textContent`)) as string, new RegExp(`Incoming call.*New, \\(555\\) 010-0042.*google · ${said(names.spanish)}.*/es.*No missed calls`))
    if (scenes[i]!.title === 'Details entered') assert.match((await run(`document.getElementById('stage-desk').textContent`)) as string, /Contact saved.*No duplicate on file · a caller and a site visit, by phone POST \/match/)
    if (scenes[i]!.title === 'Separation') assert.match((await run(`document.getElementById('stage-desk').textContent`)) as string, /Conflict check.*Inés Vega, Tomás Vega.*Kept apart, on record/)
    if (scenes[i]!.title === 'Two at one call') assert.match((await run(`document.getElementById('stage-desk').textContent`)) as string, /Who was on this call.*Refused: dana answered first.*Tomás Vega, by dana/)
    if (scenes[i]!.title === 'What is behind a number') assert.match((await run(`[...document.querySelectorAll('.card-pop:popover-open')].map(node => node.innerText).join(' ')`)) as string, /Answered[^]*Target 90%, set by you/)
    const after = seen(await view(links[i]!))
    // A link that was made and not opened changes nothing in the account.
    if (['Form texted', 'Two at one call', 'What is behind a number'].includes(scenes[i]!.title)) assert.equal(after, before)
    else assert.ok(after && after !== before, `scene ${i + 1} shows on its view: ${JSON.stringify([before, after])}`)
  }
  // The clock moved, and of the four feeds only the calls have been silent too long. Every visit is recorded at the firm's address.
  assert.deepEqual(await feeds(), [['touches', 24, false], ['calls', 12, true], ['results', 24, false], ['costs', 48, false]])
  assert.equal((await read('/journey?subject=visitor:v-4821')).entries.find((entry: { kind: string }) => entry.kind === 'visit').touch.landing, 'https://www.firm.example.org/es')
  // There is nothing after the last.
  assert.equal(await run(`[...document.querySelectorAll('#stage button')].some(each => each.textContent.startsWith('Next') && !each.disabled && each.checkVisibility())`), false)
  // The show plays from the start only.
  await run(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))`)
  assert.match((await run(`document.querySelector('#stage .told').textContent`)) as string, /Press R to restart/)
  // After the last scene the bar offers to start over. The stage waits for the next start, so nothing else is pressed.
  assert.match(String(await run(`document.querySelector('#stage .primary:not([hidden])')?.textContent`)), /Restart/)
  assert.ok([400,403].includes((await fetch(firm.graph + '/stage', { method: 'POST', body: new URLSearchParams({ intent: 'restart' }) })).status))
  await run(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))`)
  await until('the restart', () => restarts === 1)
  await until('the new round after restart', async () => (await bar('at')) === '0' && (await bar('ready')) === 'true')
  assert.equal(await frame(), firstDocument, 'restart updates the original stage document')
  // The site shows a visitor from an ad a number of their own, in their language.
  await screen.run(`location.href = ${JSON.stringify(`${firm.site}/es?gclid=you&utm_id=30333`)}`)
  await until('a pool number', async () => ((await screen.run(`document.querySelector('.call')?.textContent ?? ''`).catch(() => '')) as string).includes('(555) 010-011'))
  // A mother writes about her son: her browser and her number are related to him, and are not his.
  await screen.run(`{
    const form = document.querySelector('form'), say = (name, value) => (form.elements[name].value = value)
    say('first', 'Alma')
    say('last', 'Ferrer')
    say('phone', '(555) 010-0047')
    form.elements.about_other.click()
    say('their_first', 'Dario')
    say('their_last', 'Ferrer')
    form.requestSubmit()
  }`)
  await until('the form', () => screen.run(`Boolean(document.querySelector('.received'))`).catch(() => false))
  const device = await screen.run(`localStorage.getItem('ag_device')`)
  assert.equal((await read(`/journey?subject=visitor:${device}`)).entries.find((entry: { kind: string }) => entry.kind === 'visit').touch.landing, 'https://www.firm.example.org/es')
  const his = JSON.stringify(await (await fetch(`${firm.graph}/review/api/subject?subject=contact:dario-ferrer`, { headers: { authorization: 'Bearer demo' } })).json())
  assert.deepEqual([`visitor:${device}`, `caller:${hashPhone('+15550100047')}`, 'behalf:', `device:${device}`, `phone:${hashPhone('+15550100047')}`].map((each) => his.includes(`"${each}`)), [true, true, true, false, false], his)
})
