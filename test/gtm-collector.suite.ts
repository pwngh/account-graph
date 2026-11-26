import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runInNewContext } from 'node:vm'
import type { AccountGraph } from '../src/contract/api.ts'
import { createEdge } from '../src/edge/index.ts'

export async function gtmCollector(local: AccountGraph) {
  const origin = 'https://example.org'
  const server = createServer(createEdge(local, { token: 'service', origins: [origin], events: ['phone_click', 'inquiry', 'text_click'] })).listen(0, '127.0.0.1')
  await new Promise<void>((done, fail) => server.once('listening', done).once('error', fail))
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  try {
    const src = base + '/collect.js?gtm=1'
    const script = await (await fetch(src)).text()
    const module = await (await fetch(base + '/collect.js')).text()
    assert.match(module, /^export /m)
    assert.match(module, /import\.meta\.url/)
    assert.equal(await (await fetch(base + '/collect.js?gtm=0')).text(), module)

    for (const [query, events] of [
      ['&events=phone_click,inquiry&forms=all&text=1', ['phone_click', 'inquiry']],
      ['&events=&consent=required&allowPages=/contact,/closed&refusePages=/closed', []],
      ['', ['phone_click', 'inquiry', 'text_click']],
    ] as const) {
      const location = new URL(origin + '/contact')
      type Input = { name: string, value: string, remove(): void }
      const inputs = new Map<string, Input>()
      const form = { elements: [], hasAttribute: () => false, getAttribute: () => 'POST', append: (input: Input) => inputs.set(input.name, input),
        querySelector: (selector: string) => inputs.get(selector.split('"')[1]!) }
      const label = { textContent: 'code' }
      const listeners = new Map<string, Set<(event: object) => void>>()
      const document = { currentScript: { src: src + query }, cookie: '', referrer: '', querySelector: () => label, querySelectorAll: () => [label],
        createElement: () => ({ name: '', remove() { inputs.delete(this.name) } }),
        addEventListener(name: string, callback: (event: object) => void) {
          if (!listeners.has(name)) listeners.set(name, new Set())
          listeners.get(name)!.add(callback)
        },
        removeEventListener(name: string, callback: (event: object) => void) { listeners.get(name)?.delete(callback) },
      }
      const emit = (name: string, selector: string, element: unknown) => {
        for (const listener of listeners.get(name) ?? []) listener({ target: { closest: (match: string) => match === selector ? element : null } })
      }
      const posts: { kind: string, event?: string, number?: string }[] = []
      const fetches: Promise<Response>[] = []
      const signals: AbortSignal[] = []
      const quiet = () => [...listeners.values()].every(set => set.size === 0)
      const env: any = { location, document, URL, AbortController, history: { pushState() {}, replaceState() {} }, addEventListener() {}, navigator: { sendBeacon: () => true }, crypto,
        fetch: (endpoint: string, init: RequestInit) => {
          assert.equal(endpoint, base + '/collect')
          const body = JSON.parse(String(init.body))
          posts.push(body)
          if (init.signal) signals.push(init.signal)
          if (body.kind === 'text_code') return Promise.resolve(Response.json({ code: 'AG1234' }))
          const response = fetch(endpoint, { ...init, headers: { ...init.headers, origin } })
          fetches.push(response)
          return response
        },
      }
      runInNewContext(script, env)
      const tag = env.accountGraph
      await tag.event('inquiry')
      assert.deepEqual([document.cookie, posts.length, quiet(), Object.keys(tag.fields())], ['', 0, true, []])
      assert.equal(tag.setStorageGranted(true), true)
      if (query.includes('consent=required')) {
        await tag.event('inquiry')
        assert.deepEqual([document.cookie, posts.length, quiet()], ['', 0, true])
        env.accountGraphConsent = { adUserData: true, adPersonalization: false }
        for (const path of ['/closed', '/other']) {
          location.pathname = path
          tag.refresh()
          assert.deepEqual([document.cookie, posts.length, quiet()], ['', 0, true])
        }
        location.pathname = '/contact'
        tag.refresh()
      }
      tag.setStorageGranted(true)
      await new Promise<void>(done => setImmediate(done))
      assert.equal(posts.filter(body => !body.kind).length, 1)
      assert.ok(tag.fields().ag_device)
      const link = { getAttribute: () => 'tel:+12025550112' }
      emit('click', 'a[href^="tel:"]', link)
      await tag.event('inquiry')
      await tag.event('text_click')
      assert.deepEqual(posts.filter(body => body.event).map(body => body.event), events)
      assert.equal(posts.find(body => body.event === 'phone_click')?.number, events.length ? '+12025550112' : undefined)
      emit('submit', 'form', form)
      assert.equal(inputs.has('ag_device'), query.includes('forms=all'))
      assert.equal(label.textContent, query.includes('text=1') ? 'AG1234' : 'code')
      assert.ok((await Promise.all(fetches)).every(response => response.ok))
      const subject = 'visitor:' + tag.fields().ag_device
      const { entries } = await local.lookup({ kind: 'journey', subject })
      assert.deepEqual(entries.flatMap(entry => entry.subject === subject && entry.kind === 'conversion' ? [entry.stage] : []).sort(), [...events].sort())
      const sent = posts.length
      assert.equal(tag.setStorageGranted(false), true)
      await tag.event('inquiry')
      assert.deepEqual([Object.keys(tag.fields()), inputs.size, quiet(), label.textContent, posts.length], [[], 0, true, 'code', sent])
      assert.equal(signals.length, posts.length)
      assert.ok(signals.every(signal => signal.aborted))
      tag.setStorageGranted(true)
      tag.setStorageGranted(false)
      await new Promise<void>(done => setImmediate(done))
      assert.deepEqual([posts.filter(body => !body.kind).length, label.textContent], [1, 'code'])
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
  }
}
