import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOps } from '../src/core/ops.ts'
import { createGraph, createMemoryStore } from '../tools/internals.ts'

const T0 = Date.parse('2026-11-02T15:00:00Z')
const DAY = 86_400_000

test('an alert says once a day that more pairs wait for review than REVIEW_PENDING_LIMIT', async () => {
  let now = T0
  const store = createMemoryStore()
  const graph = createGraph(store, undefined, { now: () => now })
  // Three pairs of records, each pair with one weak identifier in common, are three pairs to review.
  await graph.observe([1, 2, 3].flatMap((n) => ['a', 'b'].map((side) => ({ subject: `contact:${n}${side}`, at: T0, identifiers: [`canvas:shared-${n}`] }))))
  assert.equal((await graph.undecided()).total, 3)
  const posted: string[] = []
  const fetch = (async (_url: string, init: { body: string }) => (posted.push(JSON.parse(init.body).text), new Response('ok'))) as unknown as typeof globalThis.fetch
  const checks = (reviewPending: number) => createOps(graph, store.ops, { url: 'https://alerts.example.org/hook', reviewPending, now: () => now, fetch })

  await checks(3).check()
  assert.deepEqual(posted, [], 'three pairs are not more than three')
  await checks(2).check()
  await checks(2).check()
  assert.deepEqual(posted, ['account-graph: 3 pairs wait for review in Matches, more than REVIEW_PENDING_LIMIT of 2.'])
  now += DAY
  await checks(2).check()
  assert.equal(posted.length, 2, 'the next day it is said again')
  await checks(0).check()
  assert.equal(posted.length, 2, 'without a limit nothing is said')
})
