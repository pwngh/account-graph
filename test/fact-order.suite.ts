import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEngine } from '../src/core/engine.ts'
import { createGraph } from '../src/core/graph.ts'
import { email, phone } from '../src/core/identifiers.ts'
import { createMemoryStore } from '../src/core/memory.ts'
import { createReceipts } from '../src/core/receipts.ts'
import { createSix } from '../src/core/six.ts'
import type { Store } from '../src/core/store.ts'
import type { Opened } from './suite.ts'

type Fact = { phone: string } | { email: string } | { device: string }
interface Statement { subject: string; key: string; at: number; facts: Fact[]; withdrawn: boolean }
const id = (fact: Fact) => 'phone' in fact ? phone(fact.phone) : 'email' in fact ? email(fact.email) : 'device:' + fact.device

export function factOrderSuite(name: string, open: () => Promise<Opened>) {
  test(name + ' agrees with a fresh graph in both orders of mixed multi-record profiles and withdrawals', async () => {
    const at = 1_790_000_000_000
    let seed = 99
    const pick = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % n
    const subjects: string[] = []
    const statements: Statement[] = []
    for (let i = 0; i < 36; i++) {
      const owners = ['a', 'b', 'c'].map(key => 'contact:' + i + key)
      subjects.push(...owners)
      const address = { email: 'robin' + i + '@example.org' }
      const number = { phone: '+120255501' + String(i).padStart(2, '0') }
      const device = { device: 'browser-' + i }
      const facts = [address, number, device]
      const keys = ['a', 'b', 'c', '\uE000', '\u{10000}', 'z', 'm', 'q']
      for (const key of keys) {
        const when = at + pick(3)
        const subject = owners[pick(3)]!
        const first = facts[pick(3)]!
        const second = facts[pick(3)]!
        statements.push({ subject, key: i + key, at: when, facts: first === second ? [first] : [first, second], withdrawn: false })
        statements.push({ subject: pick(2) ? subject : owners[pick(3)]!, key: i + key, at: pick(2) ? when : at + pick(3), facts: [pick(2) ? first : facts[pick(3)]!], withdrawn: true })
      }
    }
    // Group by exact owner and fact. At equal times byte order decides, with a withdrawal last on an identical key.
    const winners = new Map<string, Statement>()
    const ordered = [...statements].sort((a, b) => a.at - b.at || Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || Number(a.withdrawn) - Number(b.withdrawn))
    for (const statement of ordered) for (const fact of statement.facts) winners.set(statement.subject + ' ' + id(fact), statement)
    const oracle = createMemoryStore()
    const kept = statements.flatMap(statement => statement.withdrawn ? [] : statement.facts.filter(fact => !winners.get(statement.subject + ' ' + id(fact))!.withdrawn)
      .map(fact => ({ subject: statement.subject, identifier: id(fact), at: statement.at })))
    await oracle.write(tx => tx.addSightings(kept))
    await createGraph(oracle).rebuild()
    const read = (store: Store) => store.read(async tx => {
      const edges = (await tx.edgesOf(subjects)).sort((a, b) => a.subject.localeCompare(b.subject) || a.identifier.localeCompare(b.identifier))
      const labels = await tx.labelsOf(subjects)
      return { edges, groups: subjects.map(s => labels.get(s)?.cluster ?? s) }
    })
    const want = await read(oracle)
    for (const order of [statements, [...statements].reverse()]) {
      const { store, close } = await open()
      try {
        const engine = createEngine(store, { now: () => at + 10 })
        const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
        for (const { at, key, subject, facts, withdrawn } of order) {
          const result = withdrawn ? await six.decide({ action: 'withdraw', subject, key, at, by: 'system:intake', fact: facts[0]! })
            : (await six.record({ entries: [{ type: 'profile', subject, key, at, facts: Object.assign({}, ...facts) }] })).results[0]
          assert.ok(result?.ok, JSON.stringify(result))
        }
        assert.deepEqual(await read(store), want)
        assert.deepEqual(await engine.graph.verify(), [])
        await engine.graph.prune(at + 11)
        await engine.graph.rebuild()
        assert.deepEqual(await read(store), want)
      } finally {
        await close()
      }
    }
  })
}
