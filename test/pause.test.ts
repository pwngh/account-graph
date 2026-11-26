import assert from 'node:assert/strict'
import { test } from 'node:test'
import { internalsOf } from '../src/client/internals.ts'
import { pauseSends, resumeSends, sendsPaused } from '../src/core/pause.ts'
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
