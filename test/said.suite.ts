import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRefused } from '../src/contract/fault.ts'
import { createGraph } from '../src/core/graph.ts'
import type { Graph } from '../src/core/graph.ts'
import type { Opened } from './suite.ts'

const AT = 1_790_000_000_000

function* orders<T>(list: readonly T[]): Generator<T[]> {
  if (list.length <= 1) yield [...list]
  else for (const [i, each] of list.entries()) for (const rest of orders([...list.slice(0, i), ...list.slice(i + 1)])) yield [each, ...rest]
}

/** Does each, in order, and again what was refused for coming too early, until nothing is. */
async function inOrder(steps: readonly (() => Promise<unknown>)[]) {
  let left = [...steps]
  while (left.length > 0) {
    const early: typeof left = []
    for (const step of left) await step().catch((error) => {
      if (!isRefused(error)) throw error
      if (error.refusal.reason === 'UNKNOWN_REFERENCE') early.push(step)
      else assert.equal(error.refusal.reason, 'PAID')
    })
    if (early.length === left.length) throw new Error('nothing goes on')
    left = early
  }
}

export function saidSuite(name: string, open: () => Promise<Opened>) {
  const sameInEveryOrder = (what: string, build: (graph: Graph, n: number) => (() => Promise<unknown>)[], read: (graph: Graph, n: number) => Promise<unknown>, expected: unknown) =>
    test(`${name}: ${what}, whatever order it is said in`, async () => {
      const { store, close } = await open()
      const graph = createGraph(store, undefined, { now: () => AT + 1_000_000 })
      try {
        let n = 0
        const steps = build(graph, 0).length
        for (const order of orders([...Array(steps).keys()])) {
          n += 1
          const made = build(graph, n)
          await inOrder(order.map((i) => made[i]!))
          assert.deepEqual(await read(graph, n), expected, `order ${order}`)
        }
      } finally {
        await close()
      }
    })

  const worth = (n: number) => async (graph: Graph) => (await graph.outcomeOf(`t${n}`))!.value
  const revise = (graph: Graph, n: number, key: string, at: number, change: Parameters<Graph['revise']>[0]['change']) => () => graph.revise({ key: `${key}-${n}`, at: AT + at, transactionId: `t${n}`, change })
  const outcome = (graph: Graph, n: number) => () => graph.outcome({ transactionId: `t${n}`, subject: `a${n}`, at: AT, value: 100, currency: 'USD' })

  sameInEveryOrder('a refund, a write-off, a correction and a reversal', (graph, n) => [
    outcome(graph, n),
    revise(graph, n, 'r', 10, { kind: 'refund', amount: 30 }),
    revise(graph, n, 'w', 20, { kind: 'write_off', amount: 15 }),
    revise(graph, n, 'c', 15, { kind: 'correct', value: 90 }),
    revise(graph, n, 'u', 30, { kind: 'reverse', restatement: `w-${n}` }),
  ], (graph, n) => worth(n)(graph), 60)

  sameInEveryOrder('two corrections at one time, told apart by their keys', (graph, n) => [
    outcome(graph, n),
    revise(graph, n, 'a', 10, { kind: 'correct', value: 70 }),
    revise(graph, n, 'b', 10, { kind: 'correct', value: 80 }),
    revise(graph, n, 'c', 9, { kind: 'correct', value: 90 }),
  ], (graph, n) => worth(n)(graph), 80)

  sameInEveryOrder('payments over what was said of the worth', (graph, n) => [
    outcome(graph, n),
    () => graph.pay({ id: `p${n}`, transactionId: `t${n}`, amount: 40 }),
    () => graph.pay({ id: `q${n}`, transactionId: `t${n}`, amount: 10, kind: 'refund' }),
    revise(graph, n, 'c', 10, { kind: 'correct', value: 70 }),
    revise(graph, n, 'r', 11, { kind: 'refund', amount: 5 }),
  ], (graph, n) => worth(n)(graph), 30)

  sameInEveryOrder('how a call went and when they were reached', (graph, n) => [
    () => graph.keepCall({ id: `C${n}`, direction: 'inbound', subject: `caller:${n}`, at: AT, to: '+15551230001', flags: [] }),
    () => graph.sayResult({ call: `C${n}`, key: 'a', at: AT + 10, result: { answered: true, waited: 9 } }),
    () => graph.sayResult({ call: `C${n}`, key: 'b', at: AT + 20, result: { answered: false, voicemail: true } }),
    () => graph.sayReturn({ call: `C${n}`, key: 'x', at: AT + 30, reachedAt: AT + 5 }),
    () => graph.sayReturn({ call: `C${n}`, key: 'y', at: AT + 25 }),
  ], async (graph, n) => {
    const { recorded: _, ...result } = (await graph.keptCall(`C${n}`))!.result!
    return result
  }, { answered: false, voicemail: true, returned: AT + 5 })

  sameInEveryOrder('no lead, and a lead after all', (graph, n) => [
    () => graph.sayLead({ id: `t${n}`, key: 'a', at: AT + 10, kind: 'spam' }),
    () => graph.sayLead({ id: `t${n}`, key: 'b', at: AT + 20 }),
    () => graph.sayLead({ id: `t${n}`, key: 'c', at: AT + 30, kind: 'other' }),
    () => graph.sayLead({ id: `t${n}`, key: 'd', at: AT + 30, kind: 'spam' }),
  ], async (graph, n) => [...(await graph.notLeads([`t${n}`])).values()], [{ kind: 'spam', at: AT + 30 }])

  sameInEveryOrder('the newest read of a cost', (graph, n) => [
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 5 }, { at: AT + 1, key: 'a' }),
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 7 }, { at: AT + 2, key: 'a' }),
    () => graph.spend({ day: '2026-09-01', source: `s${n}`, campaignId: '1', amount: 6 }, { at: AT + 2, key: 'B' }),
  ], async (graph, n) => (await graph.report({ from: '2026-09-01', to: '2026-09-01' })).rows.find((row) => row.source === `s${n}`)!.cost, 7)

  sameInEveryOrder('consent given twice at one time', (graph, n) => [
    () => graph.consent(`a${n}`, { adUserData: true, adPersonalization: true }, { at: AT, key: 'b' }),
    () => graph.consent(`a${n}`, { adUserData: false, adPersonalization: false }, { at: AT, key: 'a' }),
    () => graph.consent(`a${n}`, { adUserData: false, adPersonalization: false }, { at: AT - 1, key: 'z' }),
  ], async (graph, n) => (await graph.consentOf([`a${n}`])).get(`a${n}`), { adUserData: true, adPersonalization: true })

  sameInEveryOrder('what was lost beside payments', (graph, n) => [
    outcome(graph, n),
    () => graph.pay({ id: `lp${n}`, transactionId: `t${n}`, amount: 40 }),
    () => graph.pay({ id: `lq${n}`, transactionId: `t${n}`, amount: 10, kind: 'refund' }),
    revise(graph, n, 'r', 11, { kind: 'refund', amount: 5 }),
  ], async (graph, n) => {
    const { valueChange } = (await graph.report({ from: new Date(AT).toISOString().slice(0, 10), to: new Date(AT).toISOString().slice(0, 10) })).total
    return [await worth(n)(graph), valueChange.refunded / n, valueChange.now / n]
  }, [30, 10, 30])

  test(`${name}: what was lost is in the report as it was said, and goes with the subject`, async () => {
    const { store, close } = await open()
    const graph = createGraph(store, undefined, { now: () => AT + 1_000_000 })
    try {
      await graph.outcome({ transactionId: 't', subject: 'a', at: AT, value: 100, currency: 'USD' })
      await graph.revise({ key: 'r', at: AT + 1, transactionId: 't', change: { kind: 'refund', amount: 30 } })
      await graph.revise({ key: 'w', at: AT + 2, transactionId: 't', change: { kind: 'write_off', amount: 20 } })
      await graph.revise({ key: 'x', at: AT + 2, transactionId: 't', change: { kind: 'write_off', amount: 5 } })
      await graph.revise({ key: 'u', at: AT + 3, transactionId: 't', change: { kind: 'reverse', restatement: 'x' } })
      const day = new Date(AT).toISOString().slice(0, 10)
      const { valueChange } = (await graph.report({ from: day, to: day })).total
      assert.deepEqual([valueChange.first, valueChange.now, valueChange.refunded, valueChange.writtenOff], [100, 50, 30, 20])
      await graph.forget('a', { by: 'dana' })
      await graph.outcome({ transactionId: 't', subject: 'b', at: AT, value: 100, currency: 'USD' })
      assert.equal((await graph.outcomeOf('t'))!.value, 100)
    } finally {
      await close()
    }
  })
}
