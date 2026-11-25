import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGraph } from '../src/core/graph.ts'
import { createEngine } from '../src/core/engine.ts'
import { createReceipts } from '../src/core/receipts.ts'
import { createSix } from '../src/core/six.ts'
import { defaultPolicy } from '../src/core/policy.ts'
import { recordCall } from '../src/core/calls.ts'
import { hashPhone } from '../src/core/identifiers.ts'
import type { IdentifierState, Sighting } from '../src/contract/types.ts'
import type { CallEvidence, Store, Tx } from '../src/core/store.ts'
import type { Opened } from './suite.ts'

const at = Date.UTC(2026, 0, 30, 12)
const window = { from: '2026-01-01', to: '2026-01-30', timeZone: 'UTC' }
const to = '+12025550100'
const size = 2_048

// Each history has a separate line and a small household. The frozen seed makes every failed comparison repeatable.
function histories() {
  let seed = 639290
  const pick = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor(seed / 4294967296 * n)
  }
  const active: Sighting[] = []
  const former: CallEvidence[] = []
  const ignored = new Set<string>()
  const subjects: string[] = []
  const keys: string[] = []
  for (let i = 0; i < size; i++) {
    const line = hashPhone('+1' + (201 + Math.floor(i / 100)) + '55501' + String(i % 100).padStart(2, '0'))
    const ids = ['phone:' + line, 'voip:' + line, 'dial:history-' + i]
    const family = Array.from({ length: 4 }, (_, j) => 'record:' + i + '-' + j)
    keys.push(...ids)
    subjects.push(family[0]!)
    if (pick(8) === 0) ignored.add(ids[pick(3)]!)
    for (const [j, subject] of family.entries()) {
      active.push({ subject, identifier: 'device:' + subject, at })
      for (const id of ids) {
        for (let n = pick(3); n > 0; n--) active.push({ subject, identifier: id, at: at - n })
        if (pick(3) !== 0) {
          const row = { subject, identifier: id, call: 'history-' + i, at: at - j, recorded: at }
          former.push(row)
          if (pick(2)) former.push({ ...row, call: 'repeat-' + i })
        }
      }
    }
  }
  return { active, former, ignored, subjects, keys }
}

// Count a holder once however many calls mentioned it and whether it still holds the active edge.
function reference(store: Store, active: Sighting[], former: CallEvidence[], ignored: Set<string>, visitors: Map<string, string>): Store {
  const holders = new Map<string, Set<string>>()
  for (const { identifier, subject } of [...active, ...former]) {
    if (!holders.has(identifier)) holders.set(identifier, new Set())
    holders.get(identifier)!.add(subject)
  }
  const states = async (ids: readonly string[]) => {
    const found = new Map<string, IdentifierState>()
    for (const id of ids) if (holders.has(id) || ignored.has(id)) found.set(id, { fanout: holders.get(id)?.size ?? 0, ignored: ignored.has(id) })
    return found
  }
  const evidence: Tx['callEvidence'] = async ({ subjects, identifiers, calls, before } = {}) => {
    const own = subjects && new Set(subjects)
    const ids = identifiers && new Set(identifiers)
    const of = calls && new Set(calls)
    return former.filter(row => (!own || own.has(row.subject)) && (!ids || ids.has(row.identifier)) && (!of || of.has(row.call)) && (before === undefined || row.recorded <= before))
  }
  return { ...store, read: work => store.read(tx => work({
    ...tx, states, callEvidence: evidence,
    // The general path also works before the first withdrawal.
    hasCallEvidence: async () => true,
    shared: async subjects => {
      const own = await tx.edgesOf(subjects)
      return new Map([...(await states(own.map(edge => edge.identifier)))].filter(([, state]) => state.fanout > 1 && !state.ignored))
    },
    matchingEdges: async subjects => {
      const edges = await tx.edgesOf(subjects)
      const own = new Set(subjects)
      const ids = new Set(edges.map(edge => edge.identifier))
      return { active: edges, reserved: former.some(row => own.has(row.subject) || ids.has(row.identifier)) }
    },
    callVisitors: async ids => {
      const found = new Map<string, string>()
      for (const id of ids) {
        const visitor = visitors.get(id)
        if (visitor && former.some(row => row.call === id && row.subject === visitor && ['dial:' + id, 'lease:' + id, 'text:call:' + id].includes(row.identifier) && !ignored.has(row.identifier))) found.set(id, visitor)
      }
      return found
    },
  })) }
}

export function readHistorySuite(name: string, open: () => Promise<Opened>, concurrentWrites: boolean) {
  test(name + ' skips withdrawn holder reads for a shared line with no withdrawals', async () => {
    const { store, close } = await open()
    try {
      const policy = { ...defaultPolicy, kinds: { ...defaultPolicy.kinds, phone: { ...defaultPolicy.kinds.phone!, relates: true as const } } }
      const line = 'phone:' + hashPhone('+12025550143')
      const writer = createGraph(store, policy, { now: () => at })
      await writer.observe(['record:a', 'record:b'].map(subject => ({ subject, identifiers: [line], at })))
      let reads = 0
      const reader = createGraph({ ...store, read: work => store.read(tx => work({ ...tx, callEvidence: filter => {
        reads++
        return tx.callEvidence(filter)
      } })) }, policy, { now: () => at })
      assert.deepEqual((await reader.links('record:a')).map(link => link.subject), ['record:b'])
      assert.equal(reads, 0)
    } finally {
      await close()
    }
  })

  test(name + ' reads 2,048 randomized histories with and without withdrawn evidence', async () => {
    const { store, close } = await open()
    try {
      const { active, former, ignored, subjects, keys } = histories()
      ignored.add('device:muted-empty')
      keys.push('device:muted-empty', 'device:never-held')
      await store.write(async tx => {
        await tx.addSightings(active)
        for (const id of ignored) await tx.setIgnored(id, true)
        for (const [i, subject] of subjects.entries()) {
          const call = { direction: 'inbound' as const, subject, at: at - size + i, to, flags: [], recorded: at, ...(i % 127 === 0 && { visitor: 'record:' + i + '-1' }) }
          await tx.setCall({ ...call, id: 'history-' + i })
          await tx.setCall({ ...call, at: at - 32 * 86_400_000, id: 'repeat-' + i })
          if (i % 19 === 0) await tx.setCallResult('history-' + i, { answered: false, recorded: at })
          await tx.setOutcome({ transactionId: 'sale-' + i, subject, at: at + i, stage: 'sale', value: 1 + i % 9, currency: 'USD' })
          await tx.addTouch({ subject: 'record:' + i + '-1', at: at - size - i, source: 'directory', campaignId: String(i % 3) })
        }
      })
      const snapshot = async (s: Store) => {
        const engine = createEngine(s, { policy: { ...defaultPolicy, same: 1, bridge: 1 }, now: () => at + size })
        const { graph } = engine
        const six = createSix(engine, { receipts: createReceipts(['r'.repeat(32)]) })
        return [
          await graph.report(window), await graph.board({ at: at + size, steps: [{ name: 'sale' }] }), await graph.callSummary(window), await graph.openCalls(window),
          await graph.followed({ ...window, at: at + size, step: 'sale', days: 3 }), await graph.attribute(subjects[17]!, { at }),
          await six.lookup({ kind: 'journey', subject: subjects[19]! }), await six.lookup({ kind: 'person', subjects: subjects.slice(0, 5), at }),
          await six.lookup({ kind: 'record', type: 'call', key: 'history-0', at }), await six.lookup({ kind: 'match', facts: { phone: '+12015550100' }, at }),
        ]
      }
      for (const corrections of [[], former]) {
        const visitors = new Map<string, string>()
        if (corrections.length) {
          await store.write(tx => tx.reserveCall(corrections))
          const writer = createGraph(store, defaultPolicy, { now: () => at + size })
          for (let i = 0; i < size; i += 127) {
            await writer.sayParty({ call: 'history-' + i, key: 'who-' + i, at, party: { role: 'self', subject: subjects[i]!, by: 'desk' } })
            visitors.set('history-' + i, 'record:' + i + '-1')
          }
        }
        const oracle = reference(store, active, corrections, ignored, visitors)
        const read = async (tx: Tx) => [
          await tx.states(keys), await tx.shared(subjects.slice(0, 93)), await tx.shared(subjects), await tx.callVisitors([...visitors.keys()]),
          (await tx.matchingEdges(subjects.slice(0, 3))).reserved, (await tx.matchingEdges(['record:unknown'])).reserved,
        ]
        assert.deepEqual(await store.read(read), await oracle.read(read))
        assert.deepEqual(await snapshot(store), await snapshot(oracle))
      }
    } finally {
      await close()
    }
  })

  test(name + ' keeps a campaign report in one snapshot across a party statement', async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store, defaultPolicy, { now: () => at })
      const call = { id: 'changing', from: '+12025550127', to, at: at - 2_000, duration: 60 }
      await recordCall(graph, call, { numbers: { [to]: { source: 'directory' } } })
      const before = await graph.report(window)
      let write: Promise<unknown> | undefined
      let readAfterWrite = false
      const reader = createGraph({ ...store, read: work => store.read(tx => work({
        ...tx,
        shared: async subjects => {
          const found = await tx.shared(subjects)
          if (!write) {
            write = graph.sayParty({ call: call.id, at, key: 'who', party: { role: 'self', subject: 'record:confirmed', by: 'desk' } })
            // Memory queues the writer behind this reader. PostgreSQL commits it on a second connection.
            if (concurrentWrites) await write
          }
          return found
        },
        touchesOf: async (...args) => {
          if (write) readAfterWrite = true
          return tx.touchesOf(...args)
        },
      })) }, defaultPolicy, { now: () => at })
      const during = await reader.report(window)
      assert.ok(write)
      await write
      assert.equal(readAfterWrite, true)
      assert.deepEqual(during, before)
      assert.notDeepEqual(await graph.report(window), before)
    } finally {
      await close()
    }
  })
}
