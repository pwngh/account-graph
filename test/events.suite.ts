import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWebhook, signWebhook, verifyWebhook } from '../src/contract/webhook.ts'
import { createWebhook } from '../src/core/delivery.ts'
import { cursorOf, seqOf } from '../src/core/events.ts'
import { createGraph } from '../src/core/graph.ts'
import type { Opened } from './suite.ts'

const AT = 1_790_000_000_000

export function eventsSuite(name: string, open: () => Promise<Opened>) {
  test(`${name}: a reader that follows along misses no event, whoever writes and whatever fails`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store)
    try {
      let done = false
      let at = 0
      const seen: number[] = []
      const read = async () => {
        const page = await store.read((tx) => tx.eventsAfter(at, 1000))
        seen.push(...page.map((event) => event.seq))
        at = page.at(-1)?.seq ?? at
      }
      const reader = (async () => {
        while (!done) await read()
      })()
      await Promise.all(Array.from({ length: 12 }, async (_, w) => {
        for (let i = 0; i < 12; i++) {
          if (i % 4 === 3) await store.write(async (tx) => { await tx.emit([{ type: 'delivery.paused', at: AT, data: { reason: 'x' } }]); throw new Error('rolled back') }, { whole: true }).catch(() => undefined)
          else if (i % 4 === 2) await store.write((tx) => tx.emit([{ type: 'delivery.late', at: AT, data: { oldestDue: i } }]))
          else await graph.observe({ subject: `s${w}-${i}`, identifiers: [`payment:${w}`], at: AT })
        }
      }))
      done = true
      await reader
      await read()
      const { seq } = await store.read((tx) => tx.eventHead())
      assert.deepEqual(seen, Array.from({ length: seq }, (_, i) => i + 1))
      assert.ok(seq > 40)
    } finally {
      await close()
    }
  })

  test(`${name}: an event said once is not said again, and goes with its subject`, async () => {
    const { store, close } = await open()
    try {
      const say = (once: string, subject?: string) => store.write((tx) => tx.emit([{ type: 'feed.quiet', at: AT, data: { feed: 'calls', last: null, hours: 1 }, once, ...(subject && { subject }) }]))
      assert.deepEqual([await say('a', 'caller:1'), await say('a', 'caller:1'), await say('b')], [1, 0, 1])
      await createGraph(store).forget('caller:1', { by: 'dana' })
      assert.deepEqual((await store.read((tx) => tx.eventsAfter(0, 10))).filter((event) => event.type === 'feed.quiet').length, 1)
      assert.equal(await say('a', 'caller:1'), 1)
    } finally {
      await close()
    }
  })

  test(`${name}: a cursor of another history, ahead of it or behind what is kept is lost`, async () => {
    const { store, close } = await open()
    try {
      await store.write((tx) => tx.emit([1, 2, 3, 4].map((n) => ({ type: 'delivery.late' as const, at: AT + n, data: { oldestDue: n } }))))
      const head = await store.read((tx) => tx.eventHead())
      assert.deepEqual([null, cursorOf(head, 4), cursorOf(head, 5), 'other.1', 'x', `${head.epoch}.-1`, `${head.epoch}.1e3`].map((cursor) => seqOf(head, cursor)), [0, 4, undefined, undefined, undefined, undefined, undefined])
      assert.equal(await store.write((tx) => tx.pruneEvents(AT + 3)), 2)
      const pruned = await store.read((tx) => tx.eventHead())
      assert.deepEqual([1, 2, 3].map((seq) => seqOf(pruned, cursorOf(head, seq))), [undefined, 2, 3])
      await store.write((tx) => tx.newEpoch())
      assert.equal(seqOf(await store.read((tx) => tx.eventHead()), cursorOf(head, 4)), undefined)
    } finally {
      await close()
    }
  })

  test(`${name}: events are posted signed, in order, by one process, and again until they are taken`, async () => {
    const { store, close } = await open()
    let now = AT
    let status = 500
    const bodies: { headers: Record<string, string>; body: string }[] = []
    const skipped: unknown[] = []
    const options = { url: 'https://r.example/hook', secret: 's', now: () => now, onSkipped: (each: unknown) => void skipped.push(each), fetch: (async (_: unknown, init: any) => (bodies.push({ headers: init.headers, body: init.body }), new Response('', { status }))) as typeof fetch }
    try {
      const [one, two] = [createWebhook(store, options), createWebhook(store, options)]
      // Begins with what comes after it was set up.
      assert.equal(await one.run(), 0)
      const late = (n: number) => store.write((tx) => tx.emit([{ type: 'delivery.late', at: AT, data: { oldestDue: n } }]))
      await late(1)
      await Promise.all([one.run(), two.run()])
      assert.equal(bodies.length, 1)
      await one.run()
      assert.equal(bodies.length, 1, 'not before it is due')
      now += 30_000
      status = 200
      await late(2)
      // After a refusal, one at a time.
      assert.equal((await Promise.all([one.run(), two.run()])).reduce((sum, each) => sum + each, 0), 2)
      const { headers, body } = bodies.at(-1)!
      assert.equal(await verifyWebhook({ headers, body }, { secret: 's', now, maxAgeMs: 1000 }), true)
      assert.deepEqual(bodies.slice(1).flatMap((each) => parseWebhook(each)).map((event) => event.type === 'delivery.late' && event.data.oldestDue), [1, 2])
      // Refused for a day, it is passed over and said.
      status = 400
      await late(3)
      for (let i = 0; i < 60 && skipped.length === 0; i++) {
        await one.run()
        now += 3_600_000
      }
      assert.equal(skipped.length, 1)
      status = 200
      await late(4)
      await one.run()
      assert.deepEqual(parseWebhook({ headers: {}, body: bodies.at(-1)!.body }).map((event) => event.type === 'delivery.late' && event.data.oldestDue), [4])
    } finally {
      await close()
    }
  })
}

test('a webhook is verified over its own body, time and secret, and reading one never throws', async () => {
  const body = '{"events":[]}'
  const signature = await signWebhook('secret', AT, body)
  const verify = (headers: Record<string, string>, text = body, options = {}) => verifyWebhook({ headers, body: text }, { secret: 'secret', now: AT + 1000, maxAgeMs: 5000, ...options })
  assert.equal(await verify({ 'X-Account-Graph-Signature': signature }), true)
  for (const [headers, text, options] of [[{}], [{ 'x-account-graph-signature': signature }, `${body} `], [{ 'x-account-graph-signature': signature }, body, { secret: 'other' }], [{ 'x-account-graph-signature': signature }, body, { now: AT + 6000 }], [{ 'x-account-graph-signature': signature }, body, { now: AT - 6000 }], [{ 'x-account-graph-signature': signature.replace(/.$/, (last) => (last === '0' ? '1' : '0')) }], [{ 'x-account-graph-signature': 't=x' }]] as [Record<string, string>, string?, object?][]) assert.equal(await verify(headers, text, options), false)
  for (const text of ['', 'null', '5', '[]', '{', '{"events":[null,1,{}]}', '{"events":{"a":1}}']) for (const event of parseWebhook({ headers: {}, body: text })) assert.equal(event.type, 'Unrecognized')
})
