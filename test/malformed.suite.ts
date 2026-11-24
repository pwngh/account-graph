import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createBatcher, createGraph } from '../src/index.ts'
import { createHandler } from '../src/server.ts'
import type { Opened } from './suite.ts'

const T0 = 1_700_000_000_000

/** A good request of every route that takes something, except `/calls/twilio`, which needs a signature, and `/retry`, `/conversion` and `/conversions`, which need an ad platform. Each field of each is then made bad in turn. */
const GET: Record<string, Record<string, string>> = {
  '/subject': { subject: 'account:1' }, '/cluster': { subject: 'account:1' }, '/links': { subject: 'account:1' }, '/history': { subject: 'account:1' }, '/journey': { subject: 'account:1', before: '9' },
  '/flows': { subject: 'account:1' }, '/collusion': { subject: 'account:1' }, '/rings': { subject: 'account:1' }, '/consent': { subject: 'account:1' }, '/outcome': { id: 't1' }, '/call': { id: 'C1' },
  '/search': { q: 'a' }, '/clusters': { offset: '0' }, '/attribute': { subject: 'account:1', at: String(T0) }, '/decisions': { limit: '5', before: '9', author: 'people' },
  '/report': { from: '2026-01-01', to: '2026-01-02', tz: 'UTC', by: 'hour' }, '/calls': { from: '2026-01-01', to: '2026-01-02', tz: 'UTC', after: '1 c' }, '/calls/summary': { from: '2026-01-01', to: '2026-01-02', tz: 'UTC' },
  '/followed': { from: '2026-01-01', to: '2026-01-02', tz: 'UTC', step: 'call', days: '30' }, '/board': { days: '90' },
}
const POST: Record<string, object> = {
  '/observe': { subject: 'account:1', identifiers: ['device:d1'], at: T0, event: 'login' },
  '/identify': { subject: 'account:1', device: 'd1', email: 'a@example.com', phone: '+15551230001', ip: '203.0.113.9', at: T0, event: 'x' },
  '/touch': { subject: 'account:1', at: T0, gclid: 'g', source: 'google', campaign: 'c', campaignId: '1', custom: { office: 'north' } },
  '/ignore': { identifier: 'device:d9', ignored: true, by: 'me', reason: 'r', seen: 99 },
  '/join': { a: 'account:1', b: 'account:2', by: 'me', reason: 'r', seen: 99 },
  '/separate': { a: 'account:1', b: 'account:3', separated: true, by: 'me', reason: 'r', seen: 99 },
  '/forget': { subject: 'account:gone', by: 'me', reason: 'r', seen: 99 },
  '/consent': { subject: 'account:1', consent: { adUserData: true, adPersonalization: true }, at: T0, source: 's' },
  '/transfer': { id: 'f1', from: 'account:1', to: 'account:2', amount: 1, at: T0, asset: 'usd' },
  '/find': { text: 'a' },
  '/rebuild': { by: 'me', reason: 'r' }, '/prune': { before: 1, by: 'me', reason: 'r' },
  '/convert': { transactionId: 't1', subject: 'account:1', at: T0, stage: 's', value: 1, currency: 'USD', tags: { office: 'north' } },
  '/restate': { transactionId: 't1', value: 1, currency: 'USD' },
  '/link': { url: 'https://e.example/', subject: 'account:1', days: 1 }, '/staff-link': { url: 'https://e.example/', days: 1 },
  '/call': { id: 'C1', from: '+15551230001', to: '+15551230002', at: T0, duration: 60, direction: 'inbound', answered: true, waited: 1, tags: { language: 'es' } },
  '/call/result': { id: 'C1', answered: true, voicemail: false, waited: 1 },
  '/costs': [{ day: '2026-01-01', source: 'google', amount: 1, campaignId: '1', campaign: 'c', currency: 'USD', clicks: 1, impressions: 1 }],
}
/** What a browser sends, from a site the server takes visits from. */
const VISIT: Record<string, object> = {
  '/collect': { device: 'd1', touch: { gclid: 'g', custom: { office: 'north' } }, consent: { adUserData: true, adPersonalization: true }, gpc: false, known: 'k', carried: 'c', staff: 's', canvas: 'x' },
  '/event': { device: 'd1', event: 'brochure', id: 'e1', number: '+15551230001' },
  '/carry': { device: 'd1' },
}
const deep = JSON.parse(`${'['.repeat(20_000)}${']'.repeat(20_000)}`)
const BAD = ['a\0', 'device:\0x', '\ud800', 'device:\udfff', '', ' ', null, true, -1, 0, 1.5, 1e308, 9e15, 9007199254740992, 1e21, {}, [], ['x'], { __proto__: { x: 1 } }, 'x'.repeat(70_000), 'x']
const BAD_QUERY = ['%00', 'a%00', '%ff', 'x', '-1', '1.5', '1e308', '99999999999999999999', 'NaN', '', 'a'.repeat(6000)]
const BAD_BODY = ['', 'null', '1', '"x"', '[]', '{}', '[null]', '[1]', '{"pairs":null}', '{"source":"crm","pairs":[{"a":1}]}', '﻿{}']

/** Whatever is sent, the answer says what was wrong with it. Run on each store, because what one cannot keep the other may. */
export function malformedSuite(name: string, open: () => Promise<Opened>) {
  test(`${name}: no malformed request gets a server error, on the routes above`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store)
    const server = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'], events: ['brochure'], limit: false, linkSecret: 'x'.repeat(32), now: () => T0 })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const failed: string[] = []
    let sent = 0
    const send = async (method: string, path: string, body: string | undefined, what: string) => {
      sent += 1
      const response = await fetch(base + path, { method, headers: path in VISIT ? { origin: 'https://site.example', 'user-agent': 'Mozilla/5.0' } : { authorization: 'Bearer service' }, ...(body !== undefined && { body }) })
      await response.arrayBuffer()
      if (response.status >= 500) failed.push(`${response.status} ${method} ${what}`)
    }
    const stop = console.error
    console.error = () => {}
    try {
      await graph.observe([1, 2].map((n) => ({ subject: `account:${n}`, identifiers: ['device:d1', 'payment:p1'], at: T0 })))
      for (const [path, good] of Object.entries({ ...POST, ...VISIT })) {
        for (const body of BAD_BODY) await send('POST', path, body, `${path} ${body.slice(0, 30)}`)
        const list = Array.isArray(good)
        for (const key of Object.keys(list ? good[0] : good)) {
          for (const bad of [...BAD, deep]) {
            const one = { ...(list ? good[0] : good), [key]: bad }
            // JSON.stringify would overflow on the deep one before it was sent.
            const text = bad === deep ? JSON.stringify({ ...one, [key]: '@deep' }).replace('"@deep"', `${'['.repeat(20_000)}${']'.repeat(20_000)}`) : JSON.stringify(one)
            await send('POST', path, list ? `[${text}]` : text, `${path} ${key}=${bad === deep ? 'deep' : JSON.stringify(bad)?.slice(0, 24)}`)
          }
        }
      }
      for (const [path, good] of Object.entries(GET)) {
        for (const key of Object.keys(good)) {
          // Alone too: what is left out is worked out from what was sent.
          for (const bad of [...BAD_QUERY, '-271821-04-20', '+275760-09-13', '0000-01-01']) await send('GET', `${path}?${key}=${bad}`, undefined, `${path} only ${key}=${bad.slice(0, 20)}`)
          for (const bad of BAD_QUERY) await send('GET', `${path}?${Object.entries(good).map(([name, value]) => `${name}=${name === key ? bad : encodeURIComponent(value)}`).join('&')}`, undefined, `${path} ${key}=${bad.slice(0, 20)}`)
        }
      }
      assert.deepEqual(failed, [], `${failed.length} of ${sent}`)
      assert.ok(sent > 1500)
      assert.equal((await graph.audit()).sound, true)
      assert.deepEqual(await graph.verify(), [])
    } finally {
      console.error = stop
      server.closeAllConnections()
      server.close()
      await close()
    }
  })

  test(`${name}: a bad observation in a batch fails alone`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store)
    const queue = createBatcher(graph)
    const bad = new Set([3, 20])
    try {
      const results = await Promise.allSettled(Array.from({ length: 40 }, (_, n) => queue.observe({ subject: bad.has(n) ? `account:${n}\0` : `account:${n}`, identifiers: [`device:${n}`], at: T0 })))
      assert.deepEqual(results.flatMap(({ status }, n) => (status === 'rejected' ? [n] : [])), [...bad])
      assert.equal((await graph.counts()).subjects, 38)
    } finally {
      await close()
    }
  })
}
