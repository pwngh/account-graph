import assert from 'node:assert/strict'
import { test } from 'node:test'
import { internalsOf } from '../src/client/internals.ts'
import { pauseSends, resumeSends, sendsPaused } from '../src/core/pause.ts'
import type { AccountGraph } from '../src/index.ts'
import { accountGraph } from '../src/index.ts'
import { runWorkers } from '../src/testing/index.ts'

const at = Date.parse('2026-11-01T12:00:00Z')

test('a stop on sends holds the outbox in every pass until it is taken back, and jobs wait as they were', async (t) => {
  let posted = 0
  const graph = accountGraph({ memory: true, workers: false, now: () => at, ads: { meta: { pixelId: '123', accessToken: 'token', siteUrl: 'https://example.org' } },
    fetch: async (_, init) => {
      posted += 1
      return Response.json({ events_received: JSON.parse(String(init?.body)).data.length })
    } })
  t.after(() => graph.close())
  const { engine } = await internalsOf(graph)!()
  const entry = { type: 'conversion' as const, key: 'held', at, stage: 'lead', subject: 'visitor:held', consent: { adUserData: true, adPersonalization: false }, email: 'held@example.org', actions: { meta: 'Lead' } }
  assert.ok((await graph.record({ entries: [entry] })).results[0]!.ok)

  assert.equal(await sendsPaused(engine.store), undefined)
  await pauseSends(engine.store, 'checking a wrong tie', at)
  assert.deepEqual(await sendsPaused(engine.store), { at, reason: 'checking a wrong tie' })
  await runWorkers(graph)
  await runWorkers(graph)
  assert.equal(posted, 0)
  assert.equal((await engine.outbox!.get('held'))[0]!.state, 'pending')

  await resumeSends(engine.store)
  assert.equal(await sendsPaused(engine.store), undefined)
  await runWorkers(graph)
  assert.equal(posted, 1)
  assert.equal((await engine.outbox!.get('held'))[0]!.state, 'sent')
})

test('a stop nobody can read still stops sends', async (t) => {
  const graph = accountGraph({ memory: true, workers: false })
  t.after(() => graph.close())
  const { engine } = await internalsOf(graph)!()
  await engine.store.write((tx) => tx.setSetting('sendsPaused', 'not json'))
  assert.deepEqual(await sendsPaused(engine.store), { at: 0, reason: 'unreadable' })
})

test('sends stop by themselves once enough conversions fail for good within an hour, and a resume starts the count again', async (t) => {
  let now = at
  let posted = 0
  const alerts: string[] = []
  const graph = accountGraph({ memory: true, workers: false, now: () => now, alerts: { url: 'https://alerts.example.org/hook' }, ads: { meta: { pixelId: '123', accessToken: 'token', siteUrl: 'https://example.org' }, pauseAfterFailures: 3 },
    fetch: async (url, init) => {
      if (String(url).startsWith('https://alerts.example.org')) return (alerts.push(JSON.parse(String(init?.body)).text), new Response('ok'))
      posted += 1
      return Response.json({ error: { message: 'Invalid parameter', code: 100 } }, { status: 400 })
    } })
  t.after(() => graph.close())
  const { engine } = await internalsOf(graph)!()
  let n = 0
  const send = async (on: AccountGraph, count: number) => {
    const entries = Array.from({ length: count }, () => ({ type: 'conversion' as const, key: `lead-${++n}`, at, stage: 'lead', subject: `visitor:${n}`, consent: { adUserData: true, adPersonalization: false }, email: `lead${n}@example.org`, actions: { meta: 'Lead' } }))
    assert.ok((await on.record({ entries })).results.every((result) => result.ok))
    await runWorkers(on)
  }

  // Two failures are under the limit, and a third an hour later starts a new count.
  await send(graph, 2)
  assert.equal(await sendsPaused(engine.store), undefined)
  now += 3_600_000
  await send(graph, 1)
  assert.equal(await sendsPaused(engine.store), undefined)
  await send(graph, 2)
  assert.deepEqual(await sendsPaused(engine.store), { at: now, reason: '3 conversions failed for good within an hour, and PAUSE_AFTER_FAILURES is 3' })
  assert.ok(alerts.some((text) => text.startsWith('account-graph: sends to ad platforms are paused. 3 conversions failed')))
  const page = await graph.events({ after: null, limit: 100 })
  assert.ok(page.ok)
  assert.equal(page.value.events.filter((event) => event.type === 'delivery.paused').length, 1)

  // Nothing more is sent while the stop stands.
  const before = posted
  await send(graph, 1)
  assert.equal(posted, before)

  // Taken back, the count starts again: one more failure does not stop sends at once.
  await resumeSends(engine.store)
  await runWorkers(graph)
  assert.equal(posted, before + 1)
  assert.equal(await sendsPaused(engine.store), undefined)
})
