import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRefused } from '../src/contract/fault.ts'
import { createGraph } from '../src/core/graph.ts'
import { createReceipts } from '../src/core/receipts.ts'
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
  test(`${name}: confirming one call moves its history and erases only that call's guesses`, async () => {
    const { store, close } = await open()
    const line = 'caller:line'
    const owner = 'record:a'
    const phone = 'phone:line'
    const to = '+12025550101'
    const calls = ['old', 'new']
    try {
      await store.write(async (tx) => {
        for (const [i, id] of calls.entries()) {
          const at = AT + i
          await tx.setCall({ id, direction: 'inbound', subject: line, at, to, flags: [], recorded: at })
          await tx.addSightings([phone, `dialed:call-${id}`].map(identifier => ({ subject: line, identifier, at, recorded: at, event: 'call' })))
        }
        for (const subject of [line, 'visitor:web']) await tx.addSightings([{ subject, identifier: 'dial:old', at: AT, recorded: AT, event: 'call' }])
        await tx.addTouch({ subject: line, at: AT, source: 'line', landing: `tel:${to}` })
        await tx.setOutcome({ transactionId: 'call:old', subject: line, at: AT, stage: 'call', value: 0, currency: '' })
        await tx.addValue('call:old', line, { value: 0, currency: '', at: AT })
        await tx.outbox.add({ transactionId: 'call:old', target: 'test', subject: line, action: 'sale', at: AT, keys: { phone: 'line' }, due: AT, state: 'pending', attempts: 0 })
        await tx.addSaid({ topic: 'party', about: 'old', key: 'who', at: AT + 2, data: { role: 'representative', subject: owner, by: 'desk' } })
        const affected = await tx.applyCallParty('old')
        assert.ok(affected.includes(line))
        assert.equal((await tx.callOf('old'))?.subject, owner)
        assert.equal(await tx.callLine('old'), line)
        assert.deepEqual((await tx.callsOf([line])).map(call => call.id), ['new'])
        assert.deepEqual((await tx.callsOf([owner])).map(call => call.id), ['old'])
        assert.equal((await tx.outcomeOf('call:old'))?.subject, owner)
        assert.equal((await tx.valuesOf('call:old', owner)).length, 1)
        assert.equal((await tx.valuesOf('call:old', line)).length, 0)
        const [job] = await tx.outbox.get('call:old')
        assert.deepEqual([job?.state, job?.note, job?.keys], ['skipped', 'call_party', {}])
        assert.deepEqual(await tx.edgesOn(['dial:old', 'dialed:call-old']), [])
        assert.deepEqual(await tx.history('visitor:web'), [])
        assert.deepEqual(await tx.edgesOn([phone]), [{ subject: line, identifier: phone, first: AT + 1, last: AT + 1, count: 1 }])
        assert.deepEqual(await tx.touchesOf([line], AT, AT), [])
        const keys = await tx.keysOf([owner])
        assert.ok(keys.some(k => k.type === 'call' && k.key === 'old'))
        await tx.removeSubject(owner)
        assert.equal(await tx.callOf('old'), undefined)
        assert.equal(await tx.outcomeOf('call:old'), undefined)
        assert.deepEqual(await tx.saidOf('party', 'old'), [])
        assert.deepEqual(await tx.outbox.get('call:old'), [])
        assert.ok(await tx.callOf('new'))
      })
    } finally {
      await close()
    }
  })

  test(`${name}: a party named before a call can be forgotten before or after the call`, async () => {
    const { store, close } = await open()
    try {
      await store.write(async (tx) => {
        for (const id of ['arrived', 'pending']) {
          await tx.addSaid({ topic: 'party', about: id, key: id, at: AT, data: { role: 'self', subject: 'record:a', by: 'desk' } })
          assert.deepEqual(await tx.applyCallParty(id), [])
        }
        await tx.setCall({ id: 'arrived', direction: 'outbound', subject: 'caller:line', at: AT, to: '+12025550101', recorded: AT, flags: [] })
        await tx.applyCallParty('arrived', true)
        assert.equal((await tx.callOf('arrived'))?.subject, 'record:a')
        assert.equal(await tx.callLine('arrived'), 'caller:line')
        await tx.addSaid({ topic: 'party', about: 'arrived', key: 'later', at: AT + 1, data: { role: 'unknown', by: 'desk' } })
        await tx.applyCallParty('arrived')
        await tx.pruneCallResults(AT + 1_000)
        await tx.pruneSightings(AT + 1_000)
        await tx.pruneReceipts(AT + 1_000)
        assert.equal((await tx.saidOf('party', 'pending')).length, 1)
        assert.equal(await tx.callLine('arrived'), 'caller:line')
        assert.equal((await tx.callOf('arrived'))?.subject, 'call:arrived')
        assert.deepEqual((await tx.keysOf(['record:a'])).filter(k => k.type === 'call').map(k => k.key).sort(), ['arrived', 'pending'])
        assert.deepEqual((await tx.keysOf(['record:a'])).filter(k => k.type === 'call_update').map(k => k.key).sort(), ['arrived', 'later', 'pending'])
        await tx.removeSubject('record:a')
        assert.deepEqual(await tx.saidOf('party', 'pending'), [])
        assert.equal(await tx.callOf('arrived'), undefined)
      })
    } finally {
      await close()
    }
  })

  test(`${name}: confirming a call keeps a simultaneous text tie and other sightings of the line, even after pruning`, async () => {
    const { store, close } = await open()
    try {
      for (const pruned of [false, true]) await store.write(async tx => {
        const text = `message-${Number(pruned)}`
        const id = `text-${text}`
        const line = `caller:line-${text}`
        const visitor = `visitor:v-${text}`
        const phone = `phone:line-${text}`
        const dial = `dial:${id}`
        const to = '+12025550101'
        await tx.setCall({ id, subject: line, visitor, at: AT, to, direction: 'inbound', flags: [], recorded: AT })
        await tx.setText({ id: text, subject: line, visitor, at: AT, to, direction: 'inbound', flags: [], recorded: AT })
        await tx.addSightings([AT, AT, AT + 1].map(at => ({ subject: line, identifier: phone, at, recorded: at, event: 'call' })))
        for (const subject of [line, visitor]) await tx.addSightings([dial, dial].map(identifier => ({ subject, identifier, at: AT, recorded: AT, event: 'call' })))
        if (pruned) await tx.pruneSightings(AT + 1)
        await tx.addSaid({ topic: 'party', about: id, key: id, at: AT + 3, data: { role: 'self', subject: 'record:a', by: 'desk' } })
        await tx.applyCallParty(id)
        const after = await tx.edgesOn([phone, dial])
        assert.deepEqual(after.map(edge => [edge.identifier, edge.count]).sort(), [[dial, 1], [dial, 1], [phone, 2]].sort())
        assert.equal((await tx.textOf(text))?.visitor, visitor)
        assert.deepEqual((await tx.history(visitor)).map(row => row.identifier), pruned ? [] : [dial])
      })
    } finally {
      await close()
    }
  })

  test(`${name}: deleting the physical line tombstones updates made with another receipt secret`, async () => {
    const { store, close } = await open()
    const first = createReceipts(['a'.repeat(32)])
    const rotated = createReceipts(['b'.repeat(32), 'a'.repeat(32)])
    try {
      await store.write(async tx => {
        const line = 'caller:line'
        const call = { type: 'call' as const, key: 'shared', at: AT, direction: 'inbound' as const, from: '+12025550100', to: '+12025550101' }
        const reference = { type: 'call', key: call.key }
        const result = { type: 'call_update' as const, key: 'report', call: call.key, at: AT, change: { kind: 'result' as const, result: { answered: true } } }
        await tx.addReceipt(first.make(call, AT), [line])
        await tx.addReceipt(rotated.make(result, AT + 1, reference), [])
        await tx.setCall({ id: call.key, direction: call.direction, subject: line, at: call.at, to: call.to, flags: [], recorded: AT })
        await tx.addSaid({ topic: 'party', about: call.key, key: 'named', at: AT + 2, data: { role: 'self', subject: 'record:a', by: 'desk' } })
        await tx.applyCallParty(call.key)
        const keys = (await tx.keysOf([line])).map(({ type, key }) => ({ type, ...rotated.mac(type, key) }))
        await tx.forgetReceipts([line], keys, AT + 3)
        await tx.removeSubject(line)
        for (const entry of [call, result]) assert.equal((await tx.receiptOf(entry.type, rotated.mac(entry.type, entry.key).all))?.forgotten, AT + 3)
        assert.deepEqual(await tx.saidOf('party', call.key), [])
        assert.equal(await tx.callOf(call.key), undefined)
      })
    } finally {
      await close()
    }
  })

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
