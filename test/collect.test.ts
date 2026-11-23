import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collect, event, read, watch } from '../src/collect.ts'

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
  await settle()

  const device = page.jar.get('ag_device')
  assert.deepEqual(new Set(posted), new Set(['https://graph.example/event']))
  assert.deepEqual(page.sent, [
    { device, event: 'inquiry', url: 'https://site.example/contact', id: 'form-7' },
    { device, event: 'phone_click', url: 'https://site.example/contact', number: '+1-555-123-0001' },
    { device, event: 'brochure', url: 'https://site.example/contact', id: 'b-1' },
    { device, event: 'inquiry', url: 'https://site.example/contact' },
  ])
  stop()
  assert.equal(listeners.size, 0)
})
