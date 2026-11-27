import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordCall } from '../src/core/calls.ts'
import { createGraph, createMemoryStore } from '../tools/internals.ts'

const T0 = Date.parse('2026-11-02T15:00:00Z')

test('a call on a busy line does not doubt again the recent calls already doubted, with nothing on them', async () => {
  let now = T0
  const graph = createGraph(createMemoryStore(), undefined, { now: () => now })
  const doubted: string[] = []
  const watched = { ...graph, doubtCall: (id: string, ambiguous: boolean, line?: Parameters<typeof graph.doubtCall>[2]) => (doubted.push(id), graph.doubtCall(id, ambiguous, line)) }
  // Twelve calls a second apart, as an import or a busy hour records them, each within a minute of the ones before.
  const each: number[] = []
  for (let i = 0; i < 12; i++) {
    now = T0 + i * 1000
    const before = doubted.length
    await recordCall(watched, { id: `CA${i}`, from: `+1202555010${i % 10}`, to: '+12025550100', at: now, answered: true }, { now: () => now })
    each.push(doubted.length - before)
  }
  // Each call doubts the one before it, which has nothing on it yet. Doubting the rest again would change nothing,
  // and used to cost one write for every recent call, so a busy line slowed with every call.
  assert.deepEqual(each, [0, ...Array(11).fill(1)])
  assert.deepEqual(await graph.ignored(Array.from({ length: 12 }, (_, i) => `dial:CA${i}`)), new Set(Array.from({ length: 11 }, (_, i) => `dial:CA${i}`)))
})
