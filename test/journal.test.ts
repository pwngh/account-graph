import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KeptMap, KeptSet, begin, createJournal, end, undo } from '../src/core/journal.ts'
import { accountGraph } from '../src/index.ts'
import { createMemoryStore } from '../src/core/memory.ts'

type Edge = { first: number; last: number; count: number }

test('an undone write puts back each entry it used, and an object two maps share stays shared', () => {
  const journal = createJournal()
  const bySubject = new KeptMap<string, Map<string, Edge>>(journal)
  const byIdentifier = new KeptMap<string, Map<string, Edge>>(journal)
  const ignored = new KeptSet<string>(journal)
  const edge = { first: 1, last: 1, count: 1 }
  bySubject.set('s', new Map([['i', edge]]))
  byIdentifier.set('i', new Map([['s', edge]]))
  ignored.add('kept')

  begin(journal)
  const held = bySubject.get('s')!.get('i')!
  held.last = 9
  held.count += 1
  bySubject.get('s')!.set('j', { first: 2, last: 2, count: 1 })
  bySubject.set('t', new Map())
  byIdentifier.delete('i')
  ignored.add('new')
  ignored.delete('kept')
  undo(journal)

  assert.deepEqual(edge, { first: 1, last: 1, count: 1 })
  assert.deepEqual([...bySubject.keys()], ['s'])
  assert.deepEqual([...bySubject.get('s')!.keys()], ['i'])
  assert.equal(bySubject.get('s')!.get('i'), byIdentifier.get('i')!.get('s'))
  assert.deepEqual([...ignored], ['kept'])
})

test('a write that reads a whole map and then changes it is put back whole', () => {
  const journal = createJournal()
  const calls = new KeptMap<string, { at: number; flags: string[] }>(journal)
  calls.set('a', { at: 1, flags: [] })
  calls.set('b', { at: 2, flags: [] })

  begin(journal)
  calls.set('c', { at: 3, flags: [] })
  for (const [, call] of calls) call.flags.push('seen')
  calls.delete('a')
  calls.set('d', { at: 4, flags: [] })
  undo(journal)

  assert.deepEqual(Object.fromEntries(calls), { a: { at: 1, flags: [] }, b: { at: 2, flags: [] } })
})

test('an entry deleted and put back keeps its place', () => {
  const journal = createJournal()
  const alerts = new KeptMap<string, number>(journal)
  const ignored = new KeptSet<string>(journal)
  for (const key of ['a', 'b', 'c']) {
    alerts.set(key, 1)
    ignored.add(key)
  }
  begin(journal)
  alerts.delete('a')
  alerts.set('d', 1)
  ignored.delete('b')
  ignored.add('b')
  undo(journal)
  assert.deepEqual([[...alerts.keys()], [...ignored]], [['a', 'b', 'c'], ['a', 'b', 'c']])
  // Emptied, then given and losing another key, a map comes back as it was.
  begin(journal)
  alerts.clear()
  alerts.set('e', 1)
  alerts.delete('e')
  undo(journal)
  assert.deepEqual([...alerts.keys()], ['a', 'b', 'c'])
})

test('a failed write to the memory store puts back the events it removed and the decisions it added', async () => {
  const store = createMemoryStore()
  await store.write((tx) => tx.emit([1, 2, 3].map((at) => ({ type: 'cluster.changed', at, subject: `s${at}`, data: { subject: `s${at}`, from: null, to: `s${at}` } }))))
  const head = await store.read((tx) => tx.eventHead())
  await assert.rejects(store.write(async (tx) => {
    // An event added before the first is removed is in the copy kept of the list, and must not stay.
    await tx.emit([{ type: 'cluster.changed', at: 4, subject: 's4', data: { subject: 's4', from: null, to: 's4' } }])
    await tx.pruneEvents(3)
    await tx.addDecision({ seq: 1, at: 4, action: 'ignore', about: ['email:x'], by: 'dana', reason: 'test', hash: 'h' } as never)
    throw new Error('undone')
  }, { whole: true }), /undone/)
  assert.deepEqual(await store.read((tx) => tx.eventHead()), head)
  assert.deepEqual((await store.read((tx) => tx.eventsAfter(0, 10))).map((event) => event.at), [1, 2, 3])
  assert.equal(await store.read((tx) => tx.lastDecision()), undefined)
})

test('a write that ends keeps what it changed', () => {
  const journal = createJournal()
  const settings = new KeptMap<string, string>(journal)
  begin(journal)
  settings.set('policy', 'p')
  end(journal)
  undo(journal)
  assert.equal(settings.get('policy'), 'p')
})

test('a write begun inside another and undone puts back only what it changed, and the one around it can still be undone', () => {
  const journal = createJournal()
  const calls = new KeptMap<string, { at: number; flags: string[] }>(journal)
  const ignored = new KeptSet<string>(journal)
  calls.set('a', { at: 1, flags: [] })
  calls.set('b', { at: 2, flags: [] })

  begin(journal)
  calls.get('a')!.flags.push('outer')
  calls.set('c', { at: 3, flags: [] })
  ignored.add('outer')
  begin(journal)
  calls.get('a')!.flags.push('inner')
  calls.get('c')!.at = 9
  calls.delete('b')
  calls.set('d', { at: 4, flags: [] })
  ignored.add('inner')
  ignored.delete('outer')
  undo(journal)

  assert.deepEqual([...calls], [['a', { at: 1, flags: ['outer'] }], ['b', { at: 2, flags: [] }], ['c', { at: 3, flags: [] }]])
  assert.deepEqual([...ignored], ['outer'])
  // What the inner write put back, the outer one had kept from before, so it is not kept again as changed.
  undo(journal)
  assert.deepEqual([...calls], [['a', { at: 1, flags: [] }], ['b', { at: 2, flags: [] }]])
  assert.deepEqual([...ignored], [])
})

test('a write that ended inside another is undone with it', () => {
  const journal = createJournal()
  const calls = new KeptMap<string, { at: number; flags: string[] }>(journal)
  const ignored = new KeptSet<string>(journal)
  calls.set('a', { at: 1, flags: [] })
  calls.set('b', { at: 2, flags: [] })
  ignored.add('kept')
  const settings = new KeptMap<string, string>(journal)
  settings.set('policy', 'p')

  begin(journal)
  calls.set('c', { at: 3, flags: [] })
  begin(journal)
  // Read whole and then added to, with nothing deleted: only the whole copy can take the new key out again.
  assert.deepEqual([...settings.values()], ['p'])
  settings.set('tap', '60')
  // The outer write never used `a` or `b`, so what the inner one keeps of them is all there is to put them back from.
  calls.get('b')!.flags.push('inner')
  calls.delete('a')
  for (const [, call] of calls) call.at += 10
  calls.set('d', { at: 4, flags: [] })
  ignored.delete('kept')
  end(journal)
  calls.get('b')!.at = 99
  calls.set('e', { at: 5, flags: [] })
  undo(journal)

  assert.deepEqual([...calls], [['a', { at: 1, flags: [] }], ['b', { at: 2, flags: [] }]])
  assert.deepEqual([...ignored], ['kept'])
  assert.deepEqual([...settings], [['policy', 'p']])
  // Nothing is still open.
  calls.set('f', { at: 6, flags: [] })
  undo(journal)
  assert.equal(calls.has('f'), true)
})

test('a write inside another to the memory store, undone, takes its events and decisions and leaves the rest', async () => {
  const store = createMemoryStore()
  const event = (at: number) => ({ type: 'cluster.changed' as const, at, subject: `s${at}`, data: { subject: `s${at}`, from: null, to: `s${at}` } })
  const ats = async () => (await store.read((tx) => tx.eventsAfter(0, 10))).map((each) => each.at)
  await store.write((tx) => tx.emit([1, 2, 3].map(event)))
  await store.write(async (tx) => {
    await tx.emit([event(4)])
    await assert.rejects(tx.nested(async () => {
      await tx.emit([event(5)])
      await tx.pruneEvents(3)
      await tx.addDecision({ seq: 1, at: 5, action: 'ignore', about: ['email:x'], by: 'dana', reason: 'test', hash: 'h' } as never)
      throw new Error('undone')
    }), /undone/)
    await tx.emit([event(6)])
  })
  assert.deepEqual(await ats(), [1, 2, 3, 4, 6])
  // The event after the undone one takes the number it had.
  assert.deepEqual((await store.read((tx) => tx.eventsAfter(0, 10))).map((each) => each.seq), [1, 2, 3, 4, 5])
  assert.equal(await store.read((tx) => tx.lastDecision()), undefined)

  // Events an inner write removed and kept removed come back when the write around it fails.
  const head = await store.read((tx) => tx.eventHead())
  await assert.rejects(store.write(async (tx) => {
    await tx.emit([event(7)])
    await tx.nested(async () => void (await tx.pruneEvents(4)))
    throw new Error('undone')
  }, { whole: true }), /undone/)
  assert.deepEqual(await ats(), [1, 2, 3, 4, 6])
  assert.deepEqual(await store.read((tx) => tx.eventHead()), head)
})

test('a write to the memory store takes as long with a long history as with a short one', async () => {
  const graph = accountGraph({ memory: true, workers: false })
  const T0 = Date.parse('2026-01-05T15:00:00Z')
  const call = (i: number) => ({ type: 'call' as const, key: `history-${i}`, at: T0 + i * 60_000, direction: 'inbound' as const, from: `+1${200 + (i % 700)}5550100`, to: '+12025550100', duration: 60, result: { answered: true } })
  let next = 0
  const timed = async (count: number) => {
    const start = performance.now()
    for (let i = 0; i < count; i++) await graph.record({ entries: [call(next++)] })
    return performance.now() - start
  }
  try {
    await timed(20)
    const short = await timed(50)
    for (let from = 0; from < 3000; from += 100) await graph.record({ entries: Array.from({ length: 100 }, () => call(next++)) })
    const long = await timed(50)
    // Each write used to copy the whole store first, so 3,000 more calls made it about forty times slower.
    assert.ok(long < short * 6, `50 writes took ${short.toFixed(0)} ms after 70 calls and ${long.toFixed(0)} ms after 3,070`)
  } finally {
    await graph.close()
  }
})
