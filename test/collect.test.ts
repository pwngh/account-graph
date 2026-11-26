import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { carry, collect, event, fields, fill, pool, read, texts, watch, withCode } from '../src/edge/collect.ts'
import { browserScripts } from '../src/edge/tag.ts'
import { browse, until, without } from './chrome.ts'

/** Just enough of a browser for the collector: a URL, cookies, storage, and a beacon. */
function browser(href: string, cookies: Record<string, string> = {}, gpc = false) {
  const jar = new Map(Object.entries(cookies))
  const storage = new Map<string, string>()
  const sent: any[] = []
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('location', { href, origin: new URL(href).origin })
  define('document', {
    referrer: '',
    get cookie() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    },
    set cookie(text: string) {
      const [pair = ''] = text.split(';')
      const name = pair.slice(0, pair.indexOf('='))
      if (/; Max-Age=0(;|$)/.test(text)) jar.delete(name)
      else jar.set(name, pair.slice(pair.indexOf('=') + 1))
    },
  })
  define('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) })
  define('navigator', {
    globalPrivacyControl: gpc,
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then((text) => sent.push(JSON.parse(text)))
      return true
    },
  })
  return {
    sent,
    jar,
    go(next: string) {
      define('location', { href: next, origin: new URL(next).origin })
    },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('the collector reads click ids and tags from the URL, decoded', async () => {
  const page = browser('https://site.example/start?gclid=G%2D1&utm_source=google&utm_medium=cpc&utm_campaign=spring%20sale&fbclid=F1', {
    _ga: 'GA1.1.1234567890.1700000000',
  })
  await collect({ endpoint: 'https://graph.example/collect', canvas: Promise.resolve('hash-1'), fingerprintEvent: Promise.reject(new Error('blocked')) })
  await settle()
  const [visit] = page.sent
  assert.match(visit.device, /^[0-9a-f-]{36}$/)
  assert.equal(page.jar.get('ag_device'), visit.device)
  assert.deepEqual(
    { ...visit, device: 'd' },
    {
      device: 'd',
      url: 'https://site.example/start',
      ga: '1234567890.1700000000',
      touch: { gclid: 'G-1', fbclid: 'F1', source: 'google', medium: 'cpc', campaign: 'spring sale', landing: 'https://site.example/start' },
      canvas: 'hash-1',
    },
  )
})

test('Meta\'s browser id goes along with an arrival and is never one by itself', async () => {
  const page = browser('https://site.example/start?fbclid=F1', { _fbp: 'fb.1.1700000000000.1234567890' })
  await collect({ endpoint: 'https://graph.example/collect' })
  page.go('https://site.example/pricing')
  await collect({ endpoint: 'https://graph.example/collect' })
  page.go('https://site.example/start?fbclid=F2')
  await collect({ endpoint: 'https://graph.example/collect', consent: { adUserData: false, adPersonalization: false } })
  await settle()
  assert.deepEqual(page.sent.map((visit) => visit.touch?.fbp), ['fb.1.1700000000000.1234567890', undefined, undefined])
  assert.equal(page.sent[1].touch, undefined)
  // A cookie that cannot be read loses nothing else.
  const broken = browser('https://site.example/start?fbclid=F1', { _fbp: '%E0%A4%A' })
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.deepEqual([broken.sent[0].touch.fbclid, broken.sent[0].touch.fbp], ['F1', undefined])
})

test('a click kept in the Google tag cookie is reported once, and reading does not consume it', async () => {
  const page = browser('https://site.example/', { _gcl_aw: 'GCL.1700000000.COOKIE-CLICK' })
  assert.equal(read().touch?.gclid, 'COOKIE-CLICK')
  assert.equal(read().touch?.gclid, 'COOKIE-CLICK')

  await collect({ endpoint: 'https://graph.example/collect' })
  page.go('https://site.example/pricing')
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.equal(page.sent.length, 2)
  assert.equal(page.sent[0].touch.gclid, 'COOKIE-CLICK')
  assert.equal(page.sent[1].touch, undefined)
  assert.equal(page.sent[1].device, page.sent[0].device)

  // A new ad click in the URL is always an arrival.
  page.go('https://site.example/?gclid=NEW-CLICK')
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.equal(page.sent[2].touch.gclid, 'NEW-CLICK')
})

test('a plain page view inside the site reports no touch', async () => {
  const tiktokVisit = browser('https://site.example/?ttclid=TT1&msclkid=MS1')
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.deepEqual(tiktokVisit.sent[0].touch, { msclkid: 'MS1', ttclid: 'TT1', landing: 'https://site.example/' })

  const page = browser('https://site.example/about')
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.equal(page.sent[0].touch, undefined)
})

test('an opted-out visitor is reported without anything about ads', async () => {
  const page = browser('https://site.example/?gclid=G1&utm_source=google', { _ga: 'GA1.1.1.2' }, true)
  await collect({ endpoint: 'https://graph.example/collect', canvas: 'hash-1' })
  await settle()
  assert.deepEqual({ ...page.sent[0], device: 'd' }, { device: 'd', url: 'https://site.example/', gpc: true, canvas: 'hash-1' })

  const banner = browser('https://site.example/?gclid=G2')
  await collect({ endpoint: 'https://graph.example/collect', consent: { adUserData: false, adPersonalization: false } })
  await collect({ endpoint: 'https://graph.example/collect', consent: { adUserData: true, adPersonalization: true } })
  await settle()
  assert.equal(banner.sent[0].touch, undefined)
  assert.equal(banner.sent[1].touch.gclid, 'G2')
})

test('the collector reads campaign, ad group and ad ids, and parameters of your own', async () => {
  const page = browser('https://site.example/offer?gclid=G1&utm_id=111&campaignid=999&adgroupid=22&creative=3&utm_term=garden%20hose&utm_content=blue&mailing=march&placement=&other=x')
  await collect({ endpoint: 'https://graph.example/collect', params: ['mailing', 'placement', 'missing'] })
  await settle()
  assert.deepEqual(page.sent[0].touch, {
    gclid: 'G1',
    campaignId: '111',
    adGroupId: '22',
    adId: '3',
    term: 'garden hose',
    content: 'blue',
    custom: { mailing: 'march' },
    landing: 'https://site.example/offer',
  })

  // A parameter of your own is enough to count as an arrival.
  page.go('https://site.example/offer?mailing=april')
  assert.deepEqual(read(['mailing']).touch, { custom: { mailing: 'april' }, landing: 'https://site.example/offer' })
  assert.equal(read().touch, undefined)
})

test('page events are reported by name, from code and from marked elements', async () => {
  const page = browser('https://site.example/contact?x=1')
  const posted: string[] = []
  ;(globalThis as any).navigator.sendBeacon = (url: string, blob: Blob) => {
    posted.push(url)
    void blob.text().then((text) => page.sent.push(JSON.parse(text)))
    return true
  }
  const listeners = new Map<string, (happened: object) => void>()
  Object.assign((globalThis as any).document, {
    addEventListener: (name: string, listener: (happened: object) => void) => void listeners.set(name, listener),
    removeEventListener: (name: string) => void listeners.delete(name),
  })
  /** A stand-in element: `closest` answers for the selectors it was made to match. */
  const element = (matches: Record<string, object>) => ({ closest: (selector: string) => matches[selector] ?? null })
  const node = (tagName: string, attributes: Record<string, string>) => ({ tagName, getAttribute: (name: string) => attributes[name] ?? null })
  const options = { endpoint: 'https://graph.example/collect' }

  await event(options, 'inquiry', { id: 'form-7' })
  const stop = watch(options)
  listeners.get('click')!({ target: element({ 'a[href^="tel:"]': node('A', { href: 'tel:%2B1-555-123-0001' }) }) })
  listeners.get('click')!({ target: element({ '[data-ag-event]': node('BUTTON', { 'data-ag-event': 'brochure', 'data-ag-id': 'b-1' }) }) })
  // A marked form reports when it is submitted, not when something inside it is clicked.
  const form = node('FORM', { 'data-ag-event': 'inquiry' })
  listeners.get('click')!({ target: element({ '[data-ag-event]': form }) })
  listeners.get('submit')!({ target: element({ 'form[data-ag-event]': form }) })
  listeners.get('click')!({ target: element({}) })
  // A phone link that is not properly escaped is reported as written, and does not stop the marked element around it.
  listeners.get('click')!({ target: element({ 'a[href^="tel:"]': node('A', { href: 'tel:%' }), '[data-ag-event]': node('DIV', { 'data-ag-event': 'footer' }) }) })
  await settle()

  const device = page.jar.get('ag_device')
  assert.deepEqual(new Set(posted), new Set(['https://graph.example/collect']))
  assert.deepEqual(page.sent, [
    { kind: 'event', device, event: 'inquiry', url: 'https://site.example/contact', id: 'form-7' },
    { kind: 'event', device, event: 'phone_click', url: 'https://site.example/contact', number: '+1-555-123-0001' },
    { kind: 'event', device, event: 'brochure', url: 'https://site.example/contact', id: 'b-1' },
    { kind: 'event', device, event: 'inquiry', url: 'https://site.example/contact' },
    { kind: 'event', device, event: 'phone_click', url: 'https://site.example/contact', number: '%' },
    { kind: 'event', device, event: 'footer', url: 'https://site.example/contact' },
  ])
  stop()
  assert.equal(listeners.size, 0)
})

test('a page event carries a new banner refusal or the current browser privacy signal', async () => {
  const page = browser('https://example.org/form')
  const options = { endpoint: 'https://example.org/collect', consent: { adUserData: true, adPersonalization: true } }
  const banner = { adUserData: false, adPersonalization: false }
  const globals = globalThis as typeof globalThis & { accountGraphConsent?: typeof banner }
  try {
    globals.accountGraphConsent = banner
    await event(options, 'lead')
    delete globals.accountGraphConsent
    ;(globalThis as any).navigator.globalPrivacyControl = true
    await event(options, 'lead')
    await settle()
    assert.deepEqual(page.sent[0].consent, banner)
    assert.equal(page.sent[1].gpc, true)
  } finally {
    delete globals.accountGraphConsent
  }
})

test('tokens on the address are sent once and taken out of the address bar', async () => {
  const page = browser('https://site.example/offer?ag=KNOWN.token.x&utm_source=mailer&ag_from=CARRY.token.y#top')
  const replaced: string[] = []
  Object.defineProperty(globalThis, 'history', { value: { state: null, replaceState: (_state: unknown, _title: string, url: string) => void replaced.push(url) }, configurable: true })
  await collect({ endpoint: 'https://graph.example/collect' })
  await settle()
  assert.deepEqual([page.sent[0].known, page.sent[0].carried, page.sent[0].touch.source], ['KNOWN.token.x', 'CARRY.token.y', 'mailer'])
  assert.deepEqual(replaced, ['https://site.example/offer?utm_source=mailer#top'])

  // A page with neither leaves the address alone.
  page.go('https://site.example/offer?utm_source=mailer')
  await collect({ endpoint: 'https://graph.example/collect' })
  assert.equal(replaced.length, 1)
})

test('a staff link leaves a mark in the browser, sent with each visit and event until it is taken off', async () => {
  const page = browser('https://site.example/team?ag_staff=STAFF.token.z')
  const replaced: string[] = []
  Object.defineProperty(globalThis, 'history', { value: { state: null, replaceState: (_state: unknown, _title: string, url: string) => void replaced.push(url) }, configurable: true })
  const options = { endpoint: 'https://graph.example/collect' }
  // An event on the page the link led to may be reported before the visit is.
  await event(options, 'inquiry')
  await settle()
  assert.equal(page.sent.shift().staff, 'STAFF.token.z')
  page.jar.delete('ag_staff')
  await collect(options)
  await settle()
  assert.deepEqual([page.sent[0].staff, replaced, page.jar.get('ag_staff')], ['STAFF.token.z', ['https://site.example/team'], 'STAFF.token.z'])
  page.go('https://site.example/clients')
  await collect(options)
  await event(options, 'inquiry')
  await settle()
  assert.deepEqual(page.sent.slice(1).map((sent: any) => sent.staff), ['STAFF.token.z', 'STAFF.token.z'])
  page.go('https://site.example/?ag_staff=off')
  await event(options, 'inquiry')
  await collect(options)
  await settle()
  assert.deepEqual(page.sent.slice(3).map((sent: any) => [sent.staff, Boolean(sent.device)]), [[undefined, true], [undefined, true]])
  assert.equal(replaced.at(-1), 'https://site.example/')
})

test('links to your other sites carry the visitor along, and no other link is touched', async () => {
  browser('https://site.example/')
  ;(globalThis as any).location.hostname = 'site.example'
  const asked: { url: string; init: RequestInit }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, init })
    return new Response(JSON.stringify({ token: `token-${asked.length}` }))
  }) as typeof fetch
  const listeners = new Map<string, (happened: object) => void>()
  Object.assign((globalThis as any).document, {
    addEventListener: (name: string, listener: (happened: object) => void) => void listeners.set(name, listener),
    removeEventListener: (name: string) => void listeners.delete(name),
  })
  const follow = (href: string, button = 0) => {
    const link = { href }
    listeners.get('pointerdown')!({ button, target: { closest: () => link } })
    return link.href
  }
  try {
    const stop = carry({ endpoint: 'https://graph.example/collect', domains: ['shop.example', ' Help.Example ', 'bücher.example', 'not a host'] })
    await settle()
    assert.equal(asked[0]!.url, 'https://graph.example/collect')
    assert.equal(asked[0]!.init.credentials, 'include')
    assert.equal(follow('https://shop.example/cart?x=1#pay'), 'https://shop.example/cart?x=1&ag_from=token-1#pay')
    assert.equal(follow('https://help.example/'), 'https://help.example/?ag_from=token-1')
    // A name in another script is matched in the form a link's host reads back in.
    assert.equal(follow('https://bücher.example/'), 'https://xn--bcher-kva.example/?ag_from=token-1')
    // The right button opens a menu that can copy the address, so it gets no token.
    assert.equal(follow('https://shop.example/cart', 2), 'https://shop.example/cart')
    // A long press, or a click with a key held, opens the same menu after the press: the token comes off again.
    const pressed = { href: 'https://shop.example/cart?x=1' }
    listeners.get('pointerdown')!({ button: 0, target: { closest: () => pressed } })
    assert.equal(pressed.href, 'https://shop.example/cart?x=1&ag_from=token-1')
    listeners.get('contextmenu')!({ target: { closest: () => pressed } })
    assert.equal(pressed.href, 'https://shop.example/cart?x=1')
    // The same site, a stranger's site, and something that is not an address are left alone.
    assert.equal(follow('https://site.example/next'), 'https://site.example/next')
    assert.equal(follow('https://elsewhere.example/'), 'https://elsewhere.example/')
    assert.equal(follow('not an address'), 'not an address')
    listeners.get('click')!({ target: { closest: () => null } })
    assert.equal(asked.length, 1)
    // A tab that comes back into view with a token still fresh asks for nothing.
    ;(globalThis as any).document.visibilityState = 'visible'
    listeners.get('visibilitychange')!({})
    assert.equal(asked.length, 1)
    stop()
    assert.equal(listeners.size, 0)
    // With no other sites named, nothing is asked and nothing listens.
    carry({ endpoint: 'https://graph.example/collect' })()
    assert.equal(asked.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a form carries the device id and the landing page to whatever receives it', async () => {
  const page = browser('https://site.example/landing?gclid=G1')
  const session = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', { value: { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => void session.set(key, value) }, configurable: true })
  await collect({ endpoint: 'https://graph.example/collect' })
  // The session began on the landing page; three pages later that is still what a form reports.
  page.go('https://site.example/contact')
  await collect({ endpoint: 'https://graph.example/collect' })
  const device = page.jar.get('ag_device')!
  assert.deepEqual(fields(), { ag_device: device, ag_landing: 'https://site.example/landing?gclid=G1' })

  const listeners = new Map<string, (happened: object) => void>()
  const created: { type: string; name: string; value: string }[] = []
  Object.assign((globalThis as any).document, {
    addEventListener: (name: string, listener: (happened: object) => void) => void listeners.set(name, listener),
    removeEventListener: (name: string) => void listeners.delete(name),
    createElement: () => ({ type: '', name: '', value: '' }),
  })
  /** A stand-in form: it remembers the inputs appended to it and finds them again by name. */
  const form = (marked: boolean, inputs: { name: string; value: string }[] = [], method: string | null = 'post') => {
    const self = {
      inputs,
      getAttribute: (name: string) => (name === 'method' ? method : null),
      hasAttribute: (name: string) => marked && name === 'data-ag-fields',
      querySelector: (selector: string) => inputs.find((input) => selector === `input[name="${input.name}"]`) ?? null,
      append: (input: { type: string; name: string; value: string }) => void (inputs.push(input), created.push(input)),
      closest: () => self,
    }
    return self
  }
  const submit = (target: object) => listeners.get('submit')!({ target })

  const stop = fill()
  // A form sent by a script fires no submit event: its gathered data gets the same fields, and a stale device is replaced.
  const scripted = form(true)
  const pairs = (data: FormData) => {
    const out: [string, string][] = []
    data.forEach((value, name) => void out.push([name, String(value)]))
    return out
  }
  const gathered = new FormData()
  gathered.set('name', 'Pat')
  gathered.set('ag_device', 'stale')
  listeners.get('formdata')!({ target: scripted, formData: gathered })
  assert.deepEqual(pairs(gathered), [['name', 'Pat'], ['ag_device', device], ['ag_landing', 'https://site.example/landing?gclid=G1']])
  const unmarked = new FormData()
  listeners.get('formdata')!({ target: form(false), formData: unmarked })
  assert.deepEqual(pairs(unmarked), [])
  const marked = form(true)
  submit(marked)
  assert.deepEqual(marked.inputs, [{ type: 'hidden', name: 'ag_device', value: device }, { type: 'hidden', name: 'ag_landing', value: 'https://site.example/landing?gclid=G1' }])
  // Submitting again fills the same two fields, and a form that already has one keeps it.
  submit(marked)
  assert.equal(marked.inputs.length, 2)
  const own = form(true, [{ name: 'ag_device', value: 'stale' }])
  submit(own)
  assert.deepEqual(own.inputs.map((input) => [input.name, input.value]), [['ag_device', device], ['ag_landing', 'https://site.example/landing?gclid=G1']])
  // An unmarked form is left alone, unless every form was asked for.
  const plain = form(false)
  submit(plain)
  assert.equal(plain.inputs.length, 0)
  stop()
  const stopAll = fill({ all: true })
  submit(plain)
  assert.equal(plain.inputs.length, 2)
  // A form that sends its fields in the address is filled only when marked: an address is seen by more than its receiver.
  const search = form(false, [], null)
  submit(search)
  assert.equal(search.inputs.length, 0)
  const markedSearch = form(true, [], 'GET')
  submit(markedSearch)
  assert.equal(markedSearch.inputs.length, 2)
  stopAll()

  // A visitor who opted out of advertising: the device id still goes, the landing page with its ad click does not.
  assert.deepEqual(fields({ adUserData: false, adPersonalization: false }), { ag_device: device })
  ;(globalThis as any).navigator.globalPrivacyControl = true
  assert.deepEqual(fields(), { ag_device: device })
  fill({ all: true })
  const optedOut = form(false)
  submit(optedOut)
  assert.deepEqual(optedOut.inputs.map((input) => input.name), ['ag_device'])
  // A form the script filled before the visitor opted out gives up the landing page it was holding.
  submit(plain)
  assert.deepEqual(plain.inputs.map((input) => [input.name, input.value]), [['ag_device', device], ['ag_landing', '']])
})

test('a form about somebody else sends the device as the speaker\'s and never as theirs, in a real browser', { skip: without }, async (t) => {
  const page = `<!doctype html><meta charset="utf-8"><iframe name="away"></iframe>
    <form id="box" method="post" action="/in" target="away" data-ag-fields><input name="ag_device" value="as written"><input type="checkbox" name="other" data-ag-for-other></form>
    <form id="radio" method="post" action="/in" target="away" data-ag-fields><input type="radio" name="who" value="me" data-ag-for-other checked><input type="radio" name="who" value="other" data-ag-for-other></form>
    <form id="select" method="post" action="/in" target="away" data-ag-fields></form><select name="who" form="select" data-ag-for-other><option value="me"><option value="other"></select>
    <form id="plain" method="post" action="/in" target="away" data-ag-fields><input type="checkbox" name="other" checked><input name="ag_speaker_device" value="its own"></form>
    <script type="module" src="/collect.js"></script>`
  const posted: URLSearchParams[] = []
  const server = createServer(async (request, response) => {
    const body = await new Response(request as unknown as ReadableStream).text()
    if (request.url === '/in') posted.push(new URLSearchParams(body))
    const script = request.url === '/collect.js'
    response.writeHead(200, { 'content-type': script ? 'text/javascript' : 'text/html' }).end(script ? browserScripts().collect : request.url?.startsWith('/page') ? page : 'in')
  }).listen(0, '127.0.0.1')
  t.after(() => (server.closeAllConnections(), server.close()))
  await new Promise((resolve) => server.once('listening', resolve))
  const { run, close } = await browse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/page?gclid=G1`)
  t.after(close)
  await until('the script', () => run(`Boolean(globalThis.accountGraph?.fields)`))
  const device = await run(`localStorage.getItem('ag_device')`)
  const landing = await run(`location.href`)
  const submit = async (id: string, before = '', how = 'requestSubmit') => {
    await run(`{ const form = document.getElementById('${id}'); ${before}; form.${how}() }`)
    const body = await until(`${id} to be sent`, () => posted.pop())
    return [body.getAll('ag_device'), body.getAll('ag_speaker_device'), body.getAll('ag_landing')]
  }
  const [mine, theirs] = [[[device], [], [landing]], [[], [device], [landing]]]
  assert.deepEqual(await submit('box'), mine)
  // A script's form.submit() fires no submit event, as some form plugins send, and still carries the same fields.
  assert.deepEqual(await submit('box', '', 'submit'), mine)
  assert.deepEqual(await submit('box', `form.elements.other.checked = true`, 'submit'), theirs)
  await run(`document.getElementById('box').elements.other.checked = false`)
  // Ticked, unticked and ticked again: one name each time, also where the page wrote the field itself.
  assert.deepEqual(await submit('box', `form.elements.other.checked = true`), theirs)
  assert.deepEqual(await submit('box'), theirs)
  assert.equal(await run(`document.querySelector('#box [name=ag_device]').value`), '')
  assert.deepEqual(await submit('box', `form.elements.other.checked = false`), mine)
  assert.deepEqual(await submit('box', `form.elements.other.checked = true`), theirs)
  for (const id of ['radio', 'select']) {
    assert.deepEqual(await submit(id), mine, id)
    assert.deepEqual(await submit(id, `form.elements.who.value = 'other'`), theirs, id)
    assert.deepEqual(await submit(id, `form.elements.who.value = 'me'`), mine, id)
  }
  // Nothing says what an unmarked box means, and a form that is not about somebody else does not send a speaker.
  assert.deepEqual(await submit('plain'), mine)
  // A script that posts a form itself asks with the form.
  assert.deepEqual(await run(`['box', 'radio'].map((id) => Object.keys(accountGraph.fields(document.getElementById(id))))`), [['ag_speaker_device', 'ag_landing'], ['ag_device', 'ag_landing']])
  assert.deepEqual(await run(`Object.keys(accountGraph.fields())`), ['ag_device', 'ag_landing'])
  // Opted out of advertising, the landing page goes from this form too, and the device is still the speaker's.
  await run(`Object.defineProperty(navigator, 'globalPrivacyControl', { value: true })`)
  assert.deepEqual(await submit('box'), [[], [device], ['']])
})

test('an element marked data-ag-code shows the code, and a page with no use for one asks for none, in a real browser', { skip: without }, async (t) => {
  const page = (body: string) => `<!doctype html><meta charset="utf-8">${body}<script type="module" src="/collect.js?text=1"></script>`
  const asked: any[] = []
  const server = createServer(async (request, response) => {
    const body = await new Response(request as unknown as ReadableStream).text()
    if (request.url === '/collect') {
      const sent = JSON.parse(body)
      if (sent.kind !== 'text_code') return void response.writeHead(204).end()
      asked.push(sent)
      return void (sent.gpc ? response.writeHead(204).end() : response.writeHead(200, { 'content-type': 'application/json' }).end('{"code":"K7Q2MX"}'))
    }
    const script = request.url!.startsWith('/collect.js')
    const words = `<p id="p">Your code is <b data-ag-code></b></p>${request.url === '/both' ? '<a href="sms:+15550100101?body=Hi">Text</a>' : ''}`
    response.writeHead(200, { 'content-type': script ? 'text/javascript' : 'text/html' }).end(script ? browserScripts().collect : page(request.url === '/none' ? '' : words))
  }).listen(0, '127.0.0.1')
  t.after(() => (server.closeAllConnections(), server.close()))
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const { run, close } = await browse(`${base}/none`)
  t.after(close)
  await until('the script', () => run(`Boolean(globalThis.accountGraph)`))
  assert.equal(asked.length, 0)
  // An element that comes later is asked for when the page is touched, and one after that is filled from what is known.
  for (const id of ['one', 'two']) {
    await run(`document.body.insertAdjacentHTML('beforeend', '<i id="${id}" data-ag-code></i>'); document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))`)
    await until(id, () => run(`document.getElementById('${id}').textContent === 'K7Q2MX'`))
  }
  assert.equal(asked.length, 1)
  await run(`location.href = '/both'`)
  await until('the code', () => run(`document.getElementById('p')?.textContent === 'Your code is K7Q2MX'`).catch(() => false))
  // The text link is as it was.
  assert.deepEqual(await run(`{
    const link = document.querySelector('a'), seen = []
    addEventListener('click', (event) => { seen.push(link.getAttribute('href')); event.preventDefault() })
    link.click()
    new Promise((done) => setTimeout(() => done([...seen, link.getAttribute('href')]), 50))
  }`), ['sms:+15550100101?body=Hi%20Ref%20K7Q2MX', 'sms:+15550100101?body=Hi'])
})

test('a marked element shows the visitor a number of their own while it is theirs, and then its own again', async (t) => {
  const page = browser('https://site.example/')
  const realFetch = globalThis.fetch
  t.after(() => (globalThis.fetch = realFetch))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const asked: any[] = []
  let answer: object | undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, body: JSON.parse(String(init.body)) })
    return answer ? new Response(JSON.stringify(answer)) : new Response(null, { status: 204 })
  }) as typeof fetch
  const texts = [{ nodeValue: 'Call us: (555) 010-0100, day or night' }, { nodeValue: 'or write' }]
  const link = { href: 'tel:+15550100100', getAttribute: () => link.href, setAttribute: (_: string, value: string) => void (link.href = value) }
  const listeners = new Map<string, () => void>()
  const document = Object.assign((globalThis as any).document, {
    visibilityState: 'visible',
    addEventListener: (name: string, listener: () => void) => void listeners.set(name, listener),
    removeEventListener: (name: string) => void listeners.delete(name),
    querySelector: () => link,
    querySelectorAll: () => [link],
    createTreeWalker: () => {
      let at = -1
      return { nextNode: () => texts[++at] ?? null }
    },
  })
  Object.defineProperty(globalThis, 'NodeFilter', { value: { SHOW_TEXT: 4 }, configurable: true })
  const turn = async (ms: number) => {
    t.mock.timers.tick(ms)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const stop = pool({ endpoint: 'https://graph.example/collect' })
  // The visit may not have arrived yet, so a visitor who gets nothing asks again soon.
  await turn(1_000)
  assert.deepEqual([asked.length, asked[0].url, asked[0].body], [1, 'https://graph.example/collect', { kind: 'number', device: page.jar.get('ag_device') }])
  assert.equal(link.href, 'tel:+15550100100')
  answer = { number: '+15550100001', until: 0, lasts: 900_000 }
  await turn(3_000)
  assert.deepEqual([asked.length, link.href, texts.map((text) => text.nodeValue)], [2, 'tel:+15550100001', ['Call us: (555) 010-0001, day or night', 'or write']])
  // Kept every five minutes while in view.
  await turn(300_000)
  assert.equal(asked.length, 3)
  // Out of view nobody renews it. When it runs out, the page shows its own number.
  document.visibilityState = 'hidden'
  await turn(890_000)
  assert.deepEqual([asked.length, link.href], [3, 'tel:+15550100001'])
  await turn(20_000)
  assert.deepEqual([link.href, texts[0]!.nodeValue], ['tel:+15550100100', 'Call us: (555) 010-0100, day or night'])
  // Back in view it asks at once, and may get another.
  document.visibilityState = 'visible'
  answer = { number: '+442071838750', until: 0, lasts: 900_000 }
  listeners.get('visibilitychange')!()
  await turn(0)
  assert.deepEqual([asked.length, link.href, texts[0]!.nodeValue], [4, 'tel:+442071838750', 'Call us: +442071838750, day or night'])
  // An answer that took long counts from when it was asked for, and one too late is no answer.
  answer = { number: '+15550100002', until: 0, lasts: 60_000 }
  const quick = globalThis.fetch
  globalThis.fetch = (async (...given: Parameters<typeof fetch>) => (t.mock.timers.tick(70_000), quick(...given))) as typeof fetch
  listeners.get('visibilitychange')!()
  await turn(0)
  assert.equal(link.href, 'tel:+442071838750')
  globalThis.fetch = quick
  answer = { number: '+442071838750', until: 0, lasts: 900_000 }
  listeners.get('visibilitychange')!()
  await turn(0)
  // With none to give, what is shown stands until it runs out.
  answer = undefined
  await turn(300_000)
  assert.equal(link.href, 'tel:+442071838750')
  await turn(600_000)
  assert.equal(link.href, 'tel:+15550100100')
  stop()
  await turn(600_000)
  assert.deepEqual([listeners.size, link.href], [0, 'tel:+15550100100'])
})

test('a text link carries the code at the end of what it fills in, once', () => {
  for (const [href, marked] of [
    ['sms:+15550100101', 'sms:+15550100101?&body=Ref%20K7Q2MX'],
    ['sms:+15550100101?body=I%20need%20a%20lawyer', 'sms:+15550100101?body=I%20need%20a%20lawyer%20Ref%20K7Q2MX'],
    ['sms:+15550100101;?&body=Hi', 'sms:+15550100101;?&body=Hi%20Ref%20K7Q2MX'],
    ['sms:+15550100101&body=Hi', 'sms:+15550100101&body=Hi%20Ref%20K7Q2MX'],
    ['sms:+15550100101?body=', 'sms:+15550100101?body=Ref%20K7Q2MX'],
    ['sms:+15550100101?service=x', 'sms:+15550100101?service=x&body=Ref%20K7Q2MX'],
    ['sms:+15550100101?body=Hi%20Ref%20ABCDEF', 'sms:+15550100101?body=Hi%20Ref%20ABCDEF%20Ref%20K7Q2MX'],
    ['sms:+15550100101?body=Hi%20Ref%20K7Q2MX', 'sms:+15550100101?body=Hi%20Ref%20K7Q2MX'],
    ['tel:+15550100101', 'tel:+15550100101'],
  ] as const) assert.equal(withCode(href, 'K7Q2MX'), marked)
})

test('the page asks for a code when it has a text link, and puts it in as the link is followed', async () => {
  browser('https://site.example/')
  const listeners = new Map<string, (event: any) => void>()
  let href = 'sms:+15550100101?body=Hi'
  let there = false
  const link = { getAttribute: () => href, setAttribute: (_: string, value: string) => void (href = value) }
  Object.assign(globalThis.document, {
    querySelector: () => (there ? link : null),
    querySelectorAll: () => [],
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  })
  const asked: string[] = []
  let answer: () => any = () => ({ status: 503 })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (url: string) => (asked.push(url), answer()) })
  const stop = texts({ endpoint: 'https://graph.example/collect' })
  const follow = () => listeners.get('click')!({ target: { closest: () => link } })
  await settle()
  assert.deepEqual(asked, [])
  // A link that comes later is asked for when the page is touched, and again after an answer without one.
  there = true
  for (const failing of [() => { throw new TypeError('offline') }, () => ({ status: 429 })]) {
    answer = failing
    listeners.get('pointerdown')!({})
    await settle()
  }
  answer = () => ({ status: 200, json: async () => ({ code: 'K7Q2MX' }) })
  follow()
  assert.equal(href, 'sms:+15550100101?body=Hi')
  await settle()
  assert.deepEqual(asked, Array(3).fill('https://graph.example/collect'))
  follow()
  assert.equal(href, 'sms:+15550100101?body=Hi%20Ref%20K7Q2MX')
  await settle()
  assert.equal(href, 'sms:+15550100101?body=Hi')
  stop()
  assert.equal(listeners.size, 0)
})
