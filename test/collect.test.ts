import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collect, read } from '../src/collect.ts'

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
