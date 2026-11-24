import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SETTINGS } from '../tools/accuracy/rates.ts'
import { report } from '../tools/accuracy/run.ts'
import { interval, score } from '../tools/accuracy/score.ts'
import { makeWorld } from '../tools/accuracy/world.ts'

const contact = (n: number, people: string[], ...facts: string[]) => ({ subject: `contact:${n}`, people, facts })

test('what is found, missed and wrong is counted by pair and by person', () => {
  const truths = [
    contact(1, ['pat'], 'phone 1'),
    contact(2, ['pat'], 'phone 1', 'email 2'),
    contact(3, ['pat'], 'email 3'),
    contact(4, ['lee'], 'email 2'),
    { subject: 'caller:1', people: ['lee'], facts: ['phone 4'] },
  ]
  const clusters = new Map([['contact:1', 'a'], ['contact:2', 'a'], ['contact:4', 'a'], ['contact:3', 'b'], ['caller:1', 'c']])
  const { all, kinds, people, mixed, recorded, mixedRecords, wrongClusters, clusters: many } = score(truths, clusters)
  assert.deepEqual(all, { same: 4, joinable: 1, found: 1, foundJoinable: 1, wrong: 2 })
  assert.deepEqual(kinds.get('caller contact'), { same: 1, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
  assert.deepEqual([people, mixed, wrongClusters, many], [2, 2, 1, 3])
  assert.deepEqual([recorded, mixedRecords], [2, 2])
})

test('two people who truly share a browser are not a wrong join by it, and are one when nothing is shared', () => {
  const browser = { subject: 'visitor:1', people: ['pat', 'lee'], facts: ['device 1'] }
  const truths = [contact(1, ['pat'], 'device 1'), browser, contact(2, ['lee'], 'device 1')]
  const { all, mixed } = score(truths, new Map(truths.map((each) => [each.subject, 'a'])))
  // The browser belongs with both. The two contacts do not belong together.
  assert.deepEqual(all, { same: 2, joinable: 2, found: 2, foundJoinable: 2, wrong: 1 })
  assert.equal(mixed, 2)
  // Both share two things: one pair, counted once.
  const telephone = { subject: 'caller:1', people: ['lee', 'pat'], facts: ['phone 1'] }
  assert.deepEqual(score([browser, telephone], new Map()).all, { same: 1, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
})

test('a fact reached through another of the same person\'s subjects makes a pair joinable', () => {
  const truths = [contact(1, ['pat'], 'phone 1'), contact(2, ['pat'], 'phone 1', 'email 2'), contact(3, ['pat'], 'email 2'), contact(4, ['lee'], 'email 9', 'phone 1')]
  assert.deepEqual(score(truths, new Map()).all, { same: 3, joinable: 3, found: 0, foundJoinable: 0, wrong: 0 })
})

test('a subject the graph never heard of is alone', () => {
  const truths = [contact(1, ['pat'], 'x'), contact(2, ['lee'], 'x')]
  assert.deepEqual(score(truths, new Map()).all, { same: 0, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
})

test('an interval is wider the more the worlds differ', () => {
  const { mean, low, high } = interval([1, 2, 3])
  assert.equal(mean, 2)
  assert.ok(Math.abs(high - (2 + 4.303 / Math.sqrt(3))) < 1e-9 && Math.abs(low - (2 - 4.303 / Math.sqrt(3))) < 1e-9)
  assert.deepEqual(interval([5, 5]), { mean: 5, low: 5, high: 5 })
  assert.throws(() => interval([1]), TypeError)
})

test('a world is the same for the same seed, and every subject of it has an owner', () => {
  const size = { people: 200, days: 60, start: Date.parse('2026-03-02T15:00:00Z'), seed: 7 }
  const { events, truths, calls } = makeWorld(SETTINGS.high!.rates, size)
  assert.deepEqual(makeWorld(SETTINGS.high!.rates, size).events, events)
  assert.notDeepEqual(makeWorld(SETTINGS.high!.rates, { ...size, seed: 8 }).events, events)
  assert.deepEqual(events.map((event) => event.at), events.map((event) => event.at).sort((x, y) => x - y))
  assert.ok(truths.every((each) => each.people.length > 0 && each.facts.length > 0))
  const told = new Set(truths.map((each) => each.subject))
  for (const event of events) {
    if (event.kind === 'record') assert.ok(told.has(event.subject))
    else if (event.kind === 'call') assert.ok(calls.has(event.id))
    else assert.ok(told.has(`visitor:${event.device}`))
  }
})

test('a world is reported to a server, and everyone told of is found there', async () => {
  const world = makeWorld(SETTINGS.base!.rates, { people: 60, days: 30, start: Date.parse('2026-03-02T15:00:00Z'), seed: 3 })
  const { truths, clusterOf } = await report(world)
  // A caller who hid their number is a subject of its own.
  assert.ok(truths.length >= world.truths.length)
  for (const { subject } of world.truths) assert.ok(clusterOf.has(subject), subject)
})
