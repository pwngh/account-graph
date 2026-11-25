import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngine } from '../src/core/engine.ts'
import type { EngineOptions, Inside } from '../src/core/engine.ts'
import { recordCall, recordCallResult } from '../src/core/calls.ts'
import { recordText } from '../src/core/texts.ts'
import type { Store, Tx } from '../src/core/store.ts'

const AT = 1_790_000_000_000

/** A store whose transactions fail at the nth thing asked of them, or never. `asked` counts them. */
export function failing(store: Store, at: number): Store & { asked: number } {
  const wrapped = {
    asked: 0,
    outbox: store.outbox,
    ops: store.ops,
    read: store.read,
    write: ((work: (tx: Tx) => Promise<unknown>, options: any) =>
      store.write((tx) => {
        const step = () => {
          wrapped.asked += 1
          if (wrapped.asked === at) throw new Error('cut off')
        }
        const spied = <T extends object>(of: T): T =>
          new Proxy(of, {
            get(target, name) {
              const value = Reflect.get(target, name)
              if (name === 'outbox') return spied(value as object)
              if (name === 'nested' || typeof value !== 'function') return value
              return (...given: unknown[]) => {
                step()
                return value.apply(target, given)
              }
            },
          })
        return work(spied(tx))
      }, options)) as Store['write'],
  }
  return wrapped
}

const target = { name: 'ads', restates: true, batch: 10, keys: (outcome: { email?: string; phone?: string }) => ({ ...(outcome.email && { email: 'h' }), ...(outcome.phone && { phone: 'h' }) }), click: () => undefined, retryable: () => true, deliver: async () => ({}) }
const options: EngineOptions = {
  delivery: { targets: [target] },
  stages: { call: { value: 10, currency: 'USD', action: { ads: 'Call' } }, text: { value: 5, currency: 'USD', action: { ads: 'Text' } } },
  calls: { numbers: { '+15551230001': { source: 'google', campaignId: '1' } }, results: 'expected' },
  now: () => AT + 1000,
}
const ENTRIES: Record<string, (inside: Inside) => Promise<unknown>> = {
  call: ({ graph, service }) => recordCall(graph, { id: 'C1', from: '+15558675309', to: '+15551230001', at: AT, duration: 90, answered: true }, service.calling()),
  'call result': async ({ graph, service }) => recordCallResult(graph, { id: 'C0', answered: true }, service.calling()),
  text: ({ graph, service }) => recordText(graph, { id: 'T1', from: '+15558675309', to: '+15551230001', at: AT, text: 'hello' }, service.textOptions()),
  conversion: ({ service }) => service.convert({ transactionId: 'O1', subject: 'contact:1', at: AT, stage: 'sale', value: 100, currency: 'USD', action: { ads: 'Sale' }, email: 'a@example.com' }),
  payment: ({ outbox }) => outbox!.pay({ id: 'P1', transactionId: 'O0', amount: 5 }),
  restatement: ({ outbox }) => outbox!.restate('O0', 20),
  profile: ({ service }) => service.identify({ subject: 'contact:1', email: 'a@example.com', phone: '+15558675309', at: AT }),
  forget: ({ outbox }) => outbox!.forget(['contact:0'], { by: 'dana' }),
}

export interface Dumped {
  store: Store
  /** Everything kept, to compare. */
  dump(): Promise<unknown>
  close(): Promise<void>
}

export function unitSuite(name: string, open: () => Promise<Dumped>) {
  for (const [entry, work] of Object.entries(ENTRIES)) {
    test(`${name}: ${entry} cut off anywhere leaves nothing, and done again leaves all of it`, async () => {
      const { store, dump, close } = await open()
      try {
        const first = createEngine(store, options)
        await first.unit(async ({ graph, service }) => {
          await graph.observe({ subject: 'visitor:0', identifiers: ['device:d0', 'email:e0'], at: AT - 5000 })
          await graph.observe({ subject: 'contact:0', identifiers: ['device:d0'], at: AT - 5000 })
          await graph.touch({ subject: 'visitor:0', at: AT - 5000, source: 'google', gclid: 'g' })
          await service.convert({ transactionId: 'O0', subject: 'contact:0', at: AT - 4000, stage: 'sale', value: 50, currency: 'USD', action: { ads: 'Sale' }, email: 'b@example.com' })
          await recordCall(graph, { id: 'C0', from: '+15558675310', to: '+15551230001', at: AT - 4000, duration: 60 }, service.calling())
        })
        const before = await dump()
        let cuts = 0
        for (let at = 1; ; at++) {
          const wrapped = failing(store, at)
          const cut = await createEngine(wrapped, options).unit(work).then(() => false, (error) => {
            if (error.message !== 'cut off') throw error
            return true
          })
          if (!cut) break
          cuts += 1
          assert.deepEqual(await dump(), before, `cut off at ${at}`)
          assert.ok(at < 500)
        }
        assert.ok(cuts >= 3, `${cuts} places`)
        assert.notDeepEqual(await dump(), before)
      } finally {
        await close()
      }
    })
  }

  test(`${name}: a write that fails inside another is undone, and the other stands`, async () => {
    const { store, close } = await open()
    try {
      const { unit, graph } = createEngine(store, {})
      await unit(async (inside) => {
        await inside.graph.observe({ subject: 'a', identifiers: ['email:x'], at: AT })
        await inside.graph.observe({ subject: 'b', identifiers: ['nosuch:x'], at: AT }).catch(() => undefined)
        await inside.graph.observe({ subject: 'c', identifiers: ['email:x'], at: AT })
        assert.deepEqual(inside.changes.map((change) => [change.subject, change.to]).at(-1), ['c', 'a'])
      })
      assert.deepEqual((await graph.cluster('a'))!.members, ['a', 'c'])
    } finally {
      await close()
    }
  })

  test(`${name}: somebody forgotten while a call of theirs is recorded is gone, whichever comes first`, async () => {
    const { store, close } = await open()
    try {
      const engine = createEngine(store, options)
      for (let n = 0; n < 6; n++) {
        const id = `R${n}`
        const number = `+1555867${String(6000 + n)}`
        const recorded = engine.unit(({ graph, service }) => recordCall(graph, { id, from: number, to: '+15551230001', at: AT, duration: 90, answered: true }, service.calling()))
        const subject = `caller:${(await import('../src/core/identifiers.ts')).hashPhone(number)}`
        const gone = engine.unit(({ outbox }) => outbox!.forget(subject, { by: 'dana' }))
        await Promise.all([recorded, gone])
        assert.deepEqual([await engine.graph.cluster(subject), await engine.graph.keptCall(id), await engine.graph.outcomeOf(`call:${id}`), await engine.outbox!.get(`call:${id}`)], [undefined, undefined, undefined, []])
      }
    } finally {
      await close()
    }
  })
}
