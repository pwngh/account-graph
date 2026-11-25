import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRefused } from '../src/contract/fault.ts'
import { createGraph } from '../src/core/graph.ts'
import type { Graph } from '../src/core/graph.ts'
import type { Opened } from './suite.ts'

const AT = 1_790_000_000_000
const together = async (graph: Graph, a: string, b: string) => (await graph.standingOf([[a, b]]))[0]!.together
const refusal = (work: Promise<unknown>) => work.then(() => undefined, (error) => (isRefused(error) ? error.refusal : Promise.reject(error)))
const join = (graph: Graph, ...pairs: [string, string][]) => Promise.all(pairs.map(([a, b]) => graph.joinAll([{ a, b }], { by: 'dana' })))
const unjoin = (graph: Graph, ...pairs: [string, string][]) => graph.unjoinAll(pairs.map(([a, b]) => ({ a, b })), { by: 'dana' })

export function unjoinSuite(name: string, open: () => Promise<Opened>) {
  const trace = (what: string, work: (graph: Graph) => Promise<void>) => test(`${name}: a join taken back, ${what}`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store)
    try {
      for (const [n, subject] of ['a', 'b', 'c', 'z'].entries()) await graph.observe({ subject, identifiers: [`payment:${n}`], at: AT })
      await work(graph)
      assert.deepEqual(await graph.verify(), [])
      assert.equal((await graph.audit()).sound, true)
    } finally {
      await close()
    }
  })

  trace('whose mark has a name somebody else held', async (graph) => {
    await graph.observe({ subject: 'z', identifiers: ['review:join-1'], at: AT })
    await join(graph, ['a', 'b'])
    assert.ok((await graph.history('a')).some((each) => each.identifier === 'review:join-1+'))
    await unjoin(graph, ['a', 'b'])
    assert.equal(await together(graph, 'a', 'b'), false)
  })
  trace('with a third joined to one of the two', async (graph) => {
    await join(graph, ['a', 'b'], ['b', 'c'])
    await unjoin(graph, ['b', 'a'])
    assert.deepEqual([await together(graph, 'a', 'b'), await together(graph, 'b', 'c')], [false, true])
  })
  trace('with another way round', async (graph) => {
    await join(graph, ['a', 'b'], ['b', 'c'], ['a', 'c'])
    await unjoin(graph, ['a', 'b'])
    assert.deepEqual(await graph.standingOf([['a', 'b']]), [{ together: true, apart: false, joined: false }])
    assert.deepEqual(await refusal(unjoin(graph, ['a', 'b'])), { reason: 'NOT_JOINED', pairs: [{ a: 'a', b: 'b', because: 'other_merges' }] })
  })
  trace('that was made twice', async (graph) => {
    await graph.join('a', 'b', { by: 'dana' })
    await graph.join('a', 'b', { by: 'dana' })
    await unjoin(graph, ['a', 'b'])
    assert.equal(await together(graph, 'a', 'b'), false)
  })
  trace('that was never made, of two the graph joined itself', async (graph) => {
    await graph.observe([{ subject: 'a', identifiers: ['hardware:h'], at: AT }, { subject: 'b', identifiers: ['hardware:h'], at: AT }])
    assert.deepEqual(await refusal(unjoin(graph, ['a', 'b'])), { reason: 'NOT_JOINED', pairs: [{ a: 'a', b: 'b', because: 'evidence' }] })
  })
  trace('of two the graph joined itself as well', async (graph) => {
    await graph.observe([{ subject: 'a', identifiers: ['hardware:h'], at: AT }, { subject: 'b', identifiers: ['hardware:h'], at: AT }])
    await join(graph, ['a', 'b'])
    await unjoin(graph, ['a', 'b'])
    assert.deepEqual(await graph.standingOf([['a', 'b']]), [{ together: true, apart: false, joined: false }])
  })
  trace('over a split that stood', async (graph) => {
    await graph.separate('a', 'b', true, { by: 'dana' })
    await join(graph, ['a', 'b'])
    assert.deepEqual(await graph.standingOf([['a', 'b']]), [{ together: false, apart: true, joined: true }])
    await unjoin(graph, ['a', 'b'])
    await graph.separate('a', 'b', false, { by: 'dana' })
    assert.equal(await together(graph, 'a', 'b'), false)
  })
  trace('of strangers, and of one pair among several', async (graph) => {
    await join(graph, ['a', 'b'])
    const before = (await graph.decisions()).length
    assert.deepEqual(await refusal(unjoin(graph, ['a', 'b'], ['b', 'c'], ['x', 'y'])), { reason: 'NOT_JOINED', pairs: [{ a: 'b', b: 'c', because: 'apart' }, { a: 'x', b: 'y', because: 'apart' }] })
    assert.equal(await together(graph, 'a', 'b'), true)
    assert.equal((await graph.decisions()).length, before)
  })
  trace('is the last word, until they are joined again', async (graph) => {
    await join(graph, ['a', 'b'])
    await unjoin(graph, ['a', 'b'])
    const [verdict] = await graph.verdicts([['a', 'b']])
    assert.deepEqual([verdict!.last.action, verdict!.last.about, verdict!.last.by], ['unjoin', ['a', 'b'], 'dana'])
    assert.deepEqual((await graph.reviewed()).length, 0)
    assert.equal((await graph.joinAll([{ a: 'a', b: 'b' }], { by: 'dana' })).recorded, 1)
    assert.equal(await together(graph, 'a', 'b'), true)
    await assert.rejects(graph.unjoinAll([{ a: 'a', b: 'b' }], { by: 'eve', seen: 1 }), { name: 'Outdated' })
  })
}
