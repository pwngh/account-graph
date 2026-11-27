import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { pageAddress, validPageRules } from '../src/edge/collect.ts'
import { browserScripts } from '../src/edge/tag.ts'
import { configFrom } from '../src/bin.ts'

const rules = { allowPages: ['/welcome', '/support/*', '/files/*'], refusePages: ['/files/*', '/support/résumé/*'] }
const key = 'f0a864ebefba'
const origin = 'https://example.org'

test('page patterns cover only the named path or subtree, including when a router folds case or Unicode', () => {
  for (const path of ['/welcome', '/support', '/support/', '/support/r%C3%A9sum%C3%A9s', '/support/desk?private=' + key + '#fragment']) {
    assert.equal(pageAddress(path, rules), path.split('?')[0])
  }
  for (const path of ['/welcome-back', '/WELCOME', '/ｗｅｌｃｏｍｅ', '/welcome/', '/%77elcome', '/files', '/files/' + key, '/FiLeS/' + key, '/ｆｉｌｅｓ/' + key, '/support/RÉSUMÉ/' + key,
    '/support%2F' + key, '/support/%252F' + key, '/support/%2e%2e/files/' + key, '/support/../files/' + key, '/support\\files/' + key,
    '/support/;/' + key, '/support/%3b' + key, '/support//' + key, '/support/%00', '/support/%ZZ', '//example.org/welcome',
    'https://user:' + key + '@example.org/welcome', 'sms:+12025550100', 'welcome']) {
    assert.equal(pageAddress(path, rules), undefined, path)
  }
  assert.equal(pageAddress('https://intake.example.org/private', { allowPages: ['/public'], origins: ['HTTPS://INTAKE.EXAMPLE.ORG:443'] }), undefined)
  assert.equal(pageAddress('https://outside.example.org/report;view/%2F?q=key#private', { allowPages: [], origins: [origin] }), undefined)
  assert.equal(pageAddress('/public', { allowPages: [] }), undefined)
  assert.equal(pageAddress('/public', { refusePages: [] }), '/public')
  for (const setting of ['not a list', null, [''], [42], ['/x*y'], ['/x?private'], ['//x'], ['/a/..']]) assert.equal(validPageRules({ allowPages: setting } as never), false)
  const base = { DATABASE_URL: 'unused', GRAPH_TOKEN: 'service', RECEIPT_SECRETS: 's'.repeat(32), IDENTIFIER_SECRET: 'i'.repeat(32) }
  const { edge } = configFrom({ ...base, ALLOW_PAGES: '/welcome, /support/*', REFUSE_PAGES: '/files/*' })
  assert.deepEqual([edge.allowPages, edge.refusePages], [['/welcome', '/support/*'], ['/files/*']])
  assert.throws(() => configFrom({ ...base, ALLOW_PAGES: '.*' }), /ALLOW_PAGES/)
})

test('the served tag waits for its page and banner, tears down on navigation and discards an outstanding fingerprint', async () => {
  const listeners = new Map<string, Set<() => void>>()
  const navigation = new Map<string, () => void>()
  const cookies = new Map<string, string>()
  const storage = new Map<string, string>()
  const session = new Map<string, string>()
  const posted: any[] = []
  const fingerprints: (() => void)[] = []
  let ids = 0
  let imports = 0
  const location = new URL(origin + '/files/' + key + '?q=' + key)
  const go = (_state: unknown, _unused: string, path: string) => { location.href = new URL(path, location).href }
  const history = { pushState: go, replaceState: go }
  const document = {
    referrer: '',
    visibilityState: 'visible',
    get cookie() { return [...cookies].map(([name, value]) => name + '=' + value).join('; ') },
    set cookie(text: string) {
      const [name, value] = text.split(';')[0]!.split('=')
      cookies.set(name!, value!)
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(name: string, fn: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(fn)
    },
    removeEventListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn) },
  }
  const store = (held: Map<string, string>) => ({ getItem: (name: string) => held.get(name), setItem: (name: string, value: string) => held.set(name, value) })
  const env: any = { URL, AbortController, location, document, history, localStorage: store(storage), sessionStorage: store(session), navigator: {},
    crypto: { randomUUID: () => {
      ids += 1
      return 'page-device'
    } }, setTimeout, clearTimeout,
    addEventListener: (name: string, fn: () => void) => navigation.set(name, fn),
    fetch: async (_url: string, init: RequestInit) => {
      assert.equal(init.referrerPolicy, 'no-referrer')
      posted.push(JSON.parse(String(init.body)))
      return { ok: true, status: 204, json: async () => ({ token: 'carry' }) }
    },
    helper: async () => {
      imports += 1
      return { fingerprintEvent: () => new Promise(resolve => fingerprints.push(() => resolve('verified'))), openFingerprint: async () => 'canvas' }
    },
  }
  const options = '?allowPages=/*&consent=required&fingerprint=test&canvas=open&pool=1&text=1&forms=all&domains=shop.example.org'
  const script = browserScripts(rules).collect.replace(/^export /gm, '').replace('import.meta.url', JSON.stringify(origin + '/collect.js' + options)).replace("import(new URL('fingerprint.js', self).href)", 'globalThis.helper()')
  runInNewContext(script, env)
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  const listening = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  const quiet = async () => {
    await env.accountGraph.event('phone_click', { number: '202-555-0100' })
    assert.equal(Object.keys(env.accountGraph.fields()).length, 0)
    assert.deepEqual([ids, posted.length, listening(), fingerprints.length, cookies.size, storage.size, session.size], [0, 0, 0, 0, 0, 0, 0])
  }
  await quiet()
  history.pushState(null, '', '/welcome')
  await quiet()
  env.accountGraphConsent = { adUserData: false, adPersonalization: false }
  env.accountGraph.refresh()
  await quiet()
  env.accountGraphConsent = { adUserData: true, adPersonalization: false }
  history.replaceState(null, '', '/files/' + key + '?q=' + key)
  await quiet()
  history.pushState(null, '', '/welcome')
  await settle()
  assert.equal(fingerprints.length, 1)
  const consentCount = posted.length
  delete env.accountGraphConsent
  fingerprints.shift()!()
  await settle()
  await env.accountGraph.event('phone_click')
  assert.equal(posted.length, consentCount)
  assert.equal(env.accountGraph.fields().ag_device, undefined)
  env.accountGraph.refresh()
  assert.equal(listening(), 0)
  env.accountGraphConsent = { adUserData: true, adPersonalization: false }
  env.accountGraph.refresh()
  await settle()
  const count = posted.length
  history.pushState(null, '', '/files/' + key)
  fingerprints.shift()!()
  await settle()
  await env.accountGraph.event('phone_click')
  assert.equal(listening(), 0)
  assert.equal(posted.length, count)
  const loaded = imports
  document.referrer = 'https://search.example.org/support/guide?q=' + key + '#private'
  location.href = origin + '/welcome?utm_campaign=contact&q=' + key + '#private'
  navigation.get('popstate')!()
  await settle()
  assert.equal(imports, loaded)
  const visit = posted.find(body => body.touch?.campaign === 'contact')
  assert.equal(visit.fingerprintEvent, undefined)
  assert.equal(visit.canvas, undefined)
  assert.equal(visit.touch.campaign, 'contact')
  assert.equal(visit.touch.referrer, 'https://search.example.org/support/guide')
  assert.equal(visit.url, origin + '/welcome')
  assert.equal(session.get('ag_landing'), origin + '/welcome')
  session.set('ag_landing', origin + '/files/' + key + '?q=' + key)
  assert.equal(env.accountGraph.fields().ag_landing, undefined)
  session.set('ag_landing', origin + '/welcome?q=' + key)
  assert.equal(env.accountGraph.fields().ag_landing, origin + '/welcome')
  location.href = origin + '/files/' + key
  navigation.get('hashchange')!()
  assert.equal(listening(), 0)
  for (const [page, referrer] of [['/welcome#' + key, ''], ['/welcome?key=' + key, ''], ['/welcome', origin + '/support#' + key], ['/welcome', origin + '/support?key=' + key]]) {
    document.referrer = referrer!
    history.pushState(null, '', page!)
    await settle()
    assert.equal(imports, loaded)
    const body = posted.at(-1)
    assert.deepEqual([body.url, body.fingerprintEvent, body.canvas], [origin + '/welcome', undefined, undefined])
    history.pushState(null, '', '/files/' + key)
  }
  document.referrer = ''
  history.pushState(null, '', '/welcome?q=' + key)
  await settle()
  await env.collect({ ...rules, endpoint: origin + '/collect', fingerprintEvent: 'already-made', canvas: Promise.reject(new Error('blocked')) })
  assert.deepEqual([posted.at(-1).fingerprintEvent, posted.at(-1).canvas], [undefined, undefined])
  history.pushState(null, '', '/files/' + key)
  history.pushState(null, '', '/welcome')
  await settle()
  fingerprints.shift()!()
  await settle()
  assert.equal(imports, loaded + 2)
  assert.deepEqual([posted.at(-1).fingerprintEvent, posted.at(-1).canvas], ['verified', 'canvas'])
  history.pushState(null, '', '/files/' + key)
  assert.doesNotMatch(JSON.stringify(posted), new RegExp(key))
})

test('bundled entry points stop before reading cookies or installing listeners on a refused page', async () => {
  const { read, event, watch, carry, fill, fields, collect, pool, texts, deviceId } = await import('../src/edge/collect.ts')
  const options = { ...rules, endpoint: origin + '/collect', domains: ['shop.example.org'], fingerprintEvent: async () => { throw new Error('The vendor was started') } }
  Object.defineProperty(globalThis, 'location', { value: { href: origin + '/files/' + key }, configurable: true })
  try {
    // No document, navigator, storage or fetch implementation is needed on a refused page.
    assert.equal(read([], options), undefined)
    assert.equal(deviceId(options), undefined)
    assert.deepEqual(fields(undefined, undefined, options), {})
    await collect(options)
    await event(options, 'phone_click')
    for (const start of [watch, carry, fill, pool, texts]) start(options)()
  } finally {
    Reflect.deleteProperty(globalThis, 'location')
  }
})

test('a vendor that finishes loading after navigation never starts identification on the new page', async () => {
  for (const [name, load] of [['fingerprintEvent', 'start'], ['openFingerprint', 'load']]) {
    for (const later of ['module', 'agent']) {
      let active = true
      let starts = 0
      let reads = 0
      const vendor = { [load!]: async () => {
        starts += 1
        if (later === 'agent') active = false
        return { get: async () => { reads += 1 } }
      } }
      const env = { active: () => active, vendor: async () => {
        if (later === 'module') active = false
        return vendor
      } }
      const script = browserScripts().fingerprint.replace(/^export /gm, '').replace(/import\(.*?url\)/g, 'globalThis.vendor()')
      const args = name === 'fingerprintEvent' ? '{ apiKey: "test" }, active' : 'active'
      assert.equal(await runInNewContext(script + '\n' + name + '(' + args + ')', env), undefined)
      assert.deepEqual([starts, reads], [Number(later === 'agent'), 0])
    }
  }
})

test('the served tag keeps arrivals from other sites and drops a private previous page without losing the click', async () => {
  const sister = 'https://intake.example.org'
  const allow = { allowPages: ['/pricing', '/services/*'], origins: [origin, sister] }
  const refuse = { refusePages: ['/files/*'], origins: [origin, sister] }
  const news = 'https://news.example.org'
  const search = 'https://search.example.org'
  for (const [rules, path, referrer, expected] of [
    [allow, '/pricing', search + '/', search + '/'],
    [allow, '/pricing', news + '/report;view/%2F?q=' + key + '#private', news + '/report;view/%2F'],
    [allow, '/services/consult', news + '/story/42?q=' + key + '#' + key, news + '/story/42'],
    [allow, '/pricing', origin + '/services/consult', undefined],
    [refuse, '/pricing', news + '/files/article?q=' + key, news + '/files/article'],
    [refuse, '/pricing', origin + '/files/' + key, undefined],
    [refuse, '/pricing', sister + '/files/' + key, undefined],
  ] as const) {
    const location = new URL(origin + path + '?gclid=G1')
    const sent: any[] = []
    const store = { getItem: () => null, setItem() {} }
    const env = { URL, AbortController, location, localStorage: store, sessionStorage: store, navigator: {},
      crypto: { randomUUID: () => 'browser' }, history: { pushState() {}, replaceState() {} }, addEventListener() {},
      document: { referrer, cookie: '', addEventListener() {}, removeEventListener() {} },
      fetch: async (_url: string, init: RequestInit) => sent.push(JSON.parse(String(init.body))),
    }
    const script = browserScripts(rules).collect.replace(/^export /gm, '').replace('import.meta.url', JSON.stringify(origin + '/collect.js'))
    runInNewContext(script, env)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.deepEqual(sent.map(body => [body.url, body.touch.gclid, body.touch.referrer]), [[origin + path, 'G1', expected]])
  }
})

test('the served tag checks form landings and carry destinations on every site alias', async () => {
  const www = 'https://www.example.org'
  const aliases = ['https://alias.example.org', 'https://example.org']
  for (const origins of [[], [www]]) {
    const location = new URL(www + '/pricing?gclid=G1')
    const storage = new Map([['ag_landing', aliases[0] + '/files/' + key]])
    const store = { getItem: (name: string) => storage.get(name), setItem: (name: string, value: string) => storage.set(name, value) }
    const listeners = new Map<string, (event: unknown) => void>()
    const env: any = { URL, AbortController, location, localStorage: store, sessionStorage: store, navigator: {},
      crypto: { randomUUID: () => 'browser' }, history: { pushState() {}, replaceState() {} }, addEventListener() {},
      document: { referrer: '', cookie: '', addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn), removeEventListener() {} },
      fetch: async () => ({ ok: true, json: async () => ({ token: 'carry' }) }),
    }
    const script = browserScripts({ allowPages: ['/pricing'], refusePages: ['/files/*'], origins }).collect.replace(/^export /gm, '').replace('import.meta.url', JSON.stringify(www + '/collect.js?domains=alias.example.org,example.org'))
    runInNewContext(script, env)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(storage.get('ag_landing'), www + '/pricing')
    for (const site of aliases) {
      for (const [path, allowed] of [['/files/' + key, false], ['/pricing', true]] as const) {
        const href = site + path + '?q=' + key
        const link = { href }
        storage.set('ag_landing', href)
        assert.equal(env.accountGraph.fields().ag_landing, allowed ? site + path : undefined)
        listeners.get('pointerdown')!({ target: { closest: () => link } })
        assert.equal(new URL(link.href).searchParams.get('ag_from'), allowed ? 'carry' : null)
      }
    }
  }
})
