import assert from 'node:assert/strict'
import { test } from 'node:test'
import { carry, collect, event, fields, fill, read, watch } from '../src/collect.ts'

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
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
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
  assert.deepEqual(new Set(posted), new Set(['https://graph.example/event']))
  assert.deepEqual(page.sent, [
    { device, event: 'inquiry', url: 'https://site.example/contact', id: 'form-7' },
    { device, event: 'phone_click', url: 'https://site.example/contact', number: '+1-555-123-0001' },
    { device, event: 'brochure', url: 'https://site.example/contact', id: 'b-1' },
    { device, event: 'inquiry', url: 'https://site.example/contact' },
    { device, event: 'phone_click', url: 'https://site.example/contact', number: '%' },
    { device, event: 'footer', url: 'https://site.example/contact' },
  ])
  stop()
  assert.equal(listeners.size, 0)
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
    assert.equal(asked[0]!.url, 'https://graph.example/carry')
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
})
