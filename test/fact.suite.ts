import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Sighting } from '../src/contract/types.ts'
import { createEngine } from '../src/core/engine.ts'
import { createGraph } from '../src/core/graph.ts'
import { email, hashPhone } from '../src/core/identifiers.ts'
import { namedKeys } from '../src/core/names.ts'
import { defaultPolicy } from '../src/core/policy.ts'
import { createMemoryStore } from '../src/core/memory.ts'
import { createReceipts } from '../src/core/receipts.ts'
import { createSix } from '../src/core/six.ts'
import type { Opened } from './suite.ts'

const at = 1_790_000_000_000
const by = 'intake'
const subject = 'contact:one'
const other = 'contact:two'
const phone = '+12025550116'
const to = '+12025550132'
const address = 'robin@example.org'
const profile = (key: string, subject: string, facts: { email?: string; phone?: string; device?: string }, when = at) => ({ type: 'profile' as const, at: when, key, subject, facts })
const remove = (key: string, fact: { email: string } | { phone: string } | { device: string } | { identifier: string }, when = at) => ({ action: 'withdraw' as const, key, at: when, by, subject, fact })

export function factSuite(name: string, open: () => Promise<Opened>) {
  test(name + ' withdraws exactly one fact across ordering, alias, merge, separation, prune and forget', async () => {
    const { store, close } = await open()
    try {
      const engine = createEngine(store, { now: () => at + 100 })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const graph = engine.graph
      const holders = async () => (await graph.holders([email(address)])).map(e => e.subject).sort()
      const cutoff = remove('\uE000', { email: address })
      await six.record({ entries: [profile('a', subject, { email: address }), profile('b', other, { email: address, device: 'extra' })] })
      assert.equal((await graph.cluster(subject))?.members.length, 2)
      const decisions = await Promise.all([six.decide(cutoff), six.decide(cutoff)])
      assert.deepEqual(decisions.map(r => r.ok && r.value.duplicate).sort(), [false, true])
      assert.deepEqual(await holders(), [other])
      assert.deepEqual((await graph.cluster(subject))?.members, [subject])
      assert.deepEqual((await graph.match([email(address)])).map(c => c.subject), [other])
      assert.equal((await graph.between(subject, other)).score, 0)
      assert.deepEqual(await graph.verify(), [])
      assert.deepEqual(await graph.rebuild(), [])
      const retried = await six.record({ entries: [profile('a', subject, { email: address })] })
      assert.ok(retried.results[0]?.ok && retried.results[0].value.duplicate)
      assert.deepEqual(await holders(), [other])
      const alias = await six.decide({ ...cutoff, subject: other })
      assert.ok(!alias.ok && alias.reason === 'KEY_REUSED' && alias.fields.includes('subject'))
      await six.record({ entries: [profile('y', subject, { email: address }), profile('older', subject, { email: address }, at - 1), profile('else', subject, { device: 'separate' }, at + 1)] })
      assert.deepEqual(await holders(), [other])
      await graph.join(subject, other, { by })
      assert.equal((await graph.cluster(subject))?.members.length, 2)
      assert.deepEqual(await holders(), [other])
      await graph.separate(subject, other, true, { by })
      assert.deepEqual((await graph.cluster(subject))?.members, [subject])
      await six.record({ entries: [profile('\u{10000}', subject, { email: address })] })
      assert.deepEqual(await holders(), [subject, other])
      assert.deepEqual((await graph.cluster(subject))?.members, [subject])
      const replay = await six.decide(cutoff)
      assert.ok(replay.ok && !replay.value.stands)
      const win = remove('latest', { identifier: email(address) }, at + 3)
      const once = await six.decide(win)
      assert.ok(once.ok && once.value.stands)
      await graph.prune(at + 101)
      await store.write(tx => tx.pruneReceipts(at + 101))
      await six.record({ entries: [profile('replayed', subject, { email: address })] })
      assert.deepEqual(await holders(), [other])
      assert.deepEqual(await graph.verify(), [])
      await six.forget({ key: 'erase', at: at + 5, by, subjects: [subject], platforms: 'report' })
      assert.deepEqual(await six.decide(win), { ok: false, reason: 'FORGOTTEN' })
      assert.deepEqual(await six.decide(cutoff), { ok: false, reason: 'FORGOTTEN' })
      assert.deepEqual(await store.read(tx => tx.factHistory(at + 101)), [])
      await six.record({ entries: [profile('recreated', subject, { email: address }, at - 8)] })
      assert.deepEqual(await holders(), [subject, other])
    } finally {
      await close()
    }
  })

  test(name + ' can confirm a new call for a returning record whose only matching fact was withdrawn', async () => {
    const { store, close } = await open()
    try {
      let clock = at
      const engine = createEngine(store, { now: () => clock })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      await six.record({ entries: [profile('previous', subject, { device: 'former' })] })
      await six.forget({ key: 'deleted', subjects: [subject], at: ++clock, by, platforms: 'report' })
      const call = { type: 'call' as const, key: 'return-call', direction: 'inbound' as const, from: phone, to, at: ++clock }
      await six.record({ entries: [profile('return-profile', subject, { email: address }, clock), call] })
      await six.decide(remove('returned-address', { email: address }, ++clock))
      await engine.graph.prune(++clock)
      const confirm = { type: 'call_update' as const, key: 'confirmation', call: call.key, at: ++clock, change: { kind: 'party' as const, role: 'self' as const, by, subject } }
      const [result] = (await six.record({ entries: [confirm] })).results
      assert.ok(result?.ok && result.value.stands, JSON.stringify(result))
      assert.equal((await engine.graph.keptCall(call.key))?.subject, subject)
      assert.deepEqual(await engine.graph.holders([email(address)]), [])
      await six.forget({ key: 'deleted-again', subjects: [subject], at: ++clock, by, platforms: 'report' })
      assert.deepEqual((await six.record({ entries: [confirm] })).results[0], { key: confirm.key, type: 'call_update', ok: false, reason: 'FORGOTTEN' })
    } finally {
      await close()
    }
  })

  test(name + ' preserves calls, visits, staff confirmations and the phone opt-out while removing their inferred owner and credit', async () => {
    const { store, close } = await open()
    try {
      const engine = createEngine(store, { now: () => at + 50, calls: { numbers: { [to]: { source: 'directory' } } } })
      const graph = engine.graph
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const line = 'caller:' + hashPhone(phone)
      const call = (key: string, when: number) => ({ type: 'call' as const, key, direction: 'inbound' as const, from: phone, to, at: when, duration: 60 })
      const results = await six.record({ entries: [profile('p', subject, { phone }), { type: 'arrival', key: 'arrive', subject, at, source: 'search', campaign: 'spring' },
        call('first', at + 1), call('confirmed', at + 2), { type: 'text', key: 'stop', at: at + 3, direction: 'inbound', from: phone, to, text: 'STOP' },
        { type: 'call_update', key: 'party', at: at + 4, call: 'confirmed', change: { kind: 'party', role: 'self', subject, by } }] })
      assert.ok(results.results.every(r => r.ok))
      const visible = async () => (await graph.journey(subject)).entries.filter(e => e.kind === 'call').map(e => e.call.id).sort()
      assert.deepEqual(await visible(), ['confirmed', 'first'])
      assert.equal((await graph.attribute(line, { at: at + 4 })).credited?.campaign, 'spring')
      const withdrawn = await six.decide(remove('no-phone', { phone }, at + 5))
      assert.ok(withdrawn.ok && withdrawn.value.stands, JSON.stringify(withdrawn))
      assert.deepEqual(await graph.links(subject), [])
      assert.deepEqual((await graph.cluster(subject))?.members, [subject])
      await six.record({ entries: [call('after', at + 6)] })
      assert.deepEqual(await visible(), ['confirmed'])
      assert.equal((await graph.keptCall('first'))?.subject, line)
      assert.equal((await graph.keptCall('after'))?.subject, line)
      assert.equal((await graph.keptCall('confirmed'))?.party?.role, 'self')
      assert.ok((await graph.journey(subject)).entries.some(e => e.kind === 'visit' && e.touch.campaign === 'spring'))
      assert.ok(!(await graph.attribute(line, { at: at + 9 })).touches.some(t => t.campaign === 'spring'))
      assert.equal((await graph.texting(line))?.optedOut, true)
      assert.ok((await graph.history(subject)).some(s => s.identifier === 'phone:' + hashPhone(phone)))
      assert.deepEqual(await graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(name + ' keeps independent name evidence and the same muted speaker mark across withdrawals', async () => {
    const { store, close } = await open()
    try {
      let clock = at + 2
      const secret = 'i'.repeat(32)
      const engine = createEngine(store, { policy: { ...defaultPolicy, apart: ['given'] }, identifierSecret: secret, now: () => clock })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const facts = { email: address, phone, ip: '192.0.2.42', device: 'owned', identifiers: ['passkey:verified'], name: { first: 'Robin', last: 'Green' } }
      const said = { type: 'profile' as const, key: 'record', at, subject, facts, speaker: { device: 'desk' } }
      const keys = async () => store.read(async tx => (await tx.edgesOf([subject])).map(edge => edge.identifier))
      await six.record({ entries: [said] })
      const mark = (await keys()).find(id => id.startsWith('behalf:'))!
      assert.ok(mark)
      await engine.graph.ignore(mark, true, { by })
      clock += 1
      const previous = clock - 1
      const before = await keys()
      const emailKeys = namedKeys(secret, [email(address)], 'Robin', 'Green')
      const phoneKeys = namedKeys(secret, ['phone:' + hashPhone(phone)], 'Robin', 'Green')
      assert.ok(emailKeys.length && phoneKeys.length && [...emailKeys, ...phoneKeys].every(id => before.includes(id)))
      const cutoff = remove('assumed', { email: address }, at + 1)
      await six.decide(cutoff)
      assert.deepEqual((await keys()).sort(), before.filter(id => id !== email(address) && !emailKeys.includes(id)).sort())
      assert.ok((await (await engine.graph.asOf(previous)).holders([email(address)])).some(e => e.subject === subject))
      assert.deepEqual(await (await engine.graph.asOf(clock)).holders([email(address)]), [])
      for (const [key, fact] of [['device', { device: 'owned' }], ['passkey', { identifier: 'passkey:verified' }], ['ip', { identifier: before.find(id => id.startsWith('ip:'))! }]] as const) {
        const result = await six.decide(remove(key, fact, at + 1))
        assert.ok(result.ok && result.value.stands)
      }
      await six.record({ entries: [{ ...said, key: 'later', facts: { email: address, name: facts.name }, at: at + 3 }] })
      const restored = await keys()
      assert.ok([...phoneKeys, ...emailKeys].every(id => restored.includes(id)))
      assert.deepEqual(restored.filter(id => id.startsWith('behalf:')), [mark])
      assert.equal(await engine.graph.spokenForBy(subject, new Set(['visitor:desk'])), false)
      assert.ok(!restored.some(id => /^(device|ip|passkey):/.test(id)))
      assert.deepEqual(await engine.graph.verify(), [])
      const wire = await six.events({ after: null, limit: 100 })
      assert.doesNotMatch(JSON.stringify(wire), /example\.org|phone:|named:/)
    } finally {
      await close()
    }
  })

  test(name + ' credits pending conversions afresh and keeps an already delivered conversion and its value corrections', async () => {
    const { store, close } = await open()
    try {
      const sent: { id: string; value: number | undefined; credited: string | undefined }[] = []
      const engine = createEngine(store, { now: () => at + 100, delivery: { targets: [{
        name: 'example', batch: 10, restates: true, keys: outcome => outcome.email ? { email: email(outcome.email) } : {}, click: found => found.credited, retryable: () => false,
        deliver: async (_, items) => {
          for (const { job, touch } of items) sent.push({ id: job.transactionId, value: job.value, credited: touch?.campaign })
          return {}
        },
      }] } })
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      await six.record({ entries: [profile('owner', subject, { email: address }), profile('visitor', 'visitor:ad', { email: address }),
        { key: 'visit', subject: 'visitor:ad', at, type: 'arrival', source: 'search', campaign: 'spring' }] })
      const sale = { type: 'conversion' as const, subject, at: at + 1, stage: 'sale', value: 8, actions: { example: 'sale' }, consent: { adUserData: true, adPersonalization: false } }
      await six.record({ entries: [{ ...sale, key: 'delivered', email: 'sale@example.org' }] })
      await engine.outbox!.run()
      assert.deepEqual(sent, [{ id: 'delivered', value: 8, credited: 'spring' }])
      await six.record({ entries: [{ ...sale, key: 'pending' }] })
      await six.decide(remove('return-address', { email: address }, at + 3))
      assert.equal((await engine.outbox!.get('delivered'))[0]?.state, 'sent')
      assert.equal((await engine.outbox!.run()).retried, 1)
      await engine.outbox!.restate('delivered', 4)
      await engine.outbox!.run()
      assert.deepEqual(sent, [{ id: 'delivered', value: 8, credited: 'spring' }, { id: 'delivered', value: 4, credited: undefined }])
    } finally {
      await close()
    }
  })

  test(name + ' retains distinct authors of simultaneous withdrawals and checks both phone aliases on a replay', async () => {
    const { store, close } = await open()
    try {
      const engine = createEngine(store, { now: () => at + 10 })
      const graph = engine.graph
      const six = createSix(engine, { receipts: createReceipts(['r'.repeat(40)]) })
      const hash = hashPhone(phone)
      const direct = 'phone:' + hash
      const alias = 'voip:' + hash
      const cuts = [remove('owner', { identifier: alias }, at + 1), { ...remove('email', { email: address }, at + 1), by: 'office' }]
      const results = await Promise.all([six.record({ entries: [profile('before', subject, { phone, email: address })] }), ...cuts.map(c => six.decide(c))])
      assert.ok(results.every(r => 'results' in r ? r.results.every(result => result.ok) : r.ok))
      const audit = await graph.decisions()
      const owners = (await store.read(tx => tx.factHistory(at + 10))).map(row => [row.key, audit.find(d => d.seq === row.decision)?.by])
      assert.deepEqual(owners.sort(), [['email', 'office'], ['owner', by]])
      assert.deepEqual(await graph.holders([direct, alias]), [])
      await six.record({ entries: [{ type: 'profile', key: 'alias', subject, at: at + 2, facts: { identifiers: [alias] } }] })
      const said = await six.decide(cuts[0]!)
      assert.ok(said.ok && !said.value.stands)
      assert.deepEqual((await graph.holders([direct, alias])).map(e => e.identifier), [alias])
      const again = await six.decide(remove('take-back', { phone }, at + 3))
      assert.ok(again.ok && again.value.stands)
      assert.deepEqual(await graph.holders([direct, alias]), [])
      assert.deepEqual(await graph.verify(), [])
    } finally {
      await close()
    }
  })

  test(name + ' compares 2,048 shuffled fact histories to a graph rebuilt without the withdrawn facts', async () => {
    const { store, close } = await open()
    try {
      const oracle = createMemoryStore()
      const base: Sighting[] = []
      const late: Sighting[] = []
      const kept: Sighting[] = []
      const cuts: { subject: string; identifier: string; at: number; key: string }[] = []
      let seed = 0x813a7
      const pick = (n: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8) % n
      const subjects: string[] = []
      for (let i = 0; i < 2048; i++) {
        const subject = 'contact:' + i
        const peer = 'visitor:' + i
        const id = email('case' + i + '@example.org')
        const cut = { subject, identifier: id, at: at + pick(4), key: 'c' + pick(6) }
        const rows = Array.from({ length: 1 + pick(4) }, () => ({ subject, identifier: id, at: at + pick(4), profileKey: 'c' + pick(6) }))
        for (const row of rows) (pick(2) ? base : late).push(row)
        const permanent = [{ subject, identifier: 'device:own-' + i, at }, { subject: peer, identifier: id, at }]
        base.push(...permanent)
        kept.push(...permanent)
        if (rows.some(r => r.at > cut.at || (r.at === cut.at && r.profileKey > cut.key))) kept.push(...rows)
        cuts.push(cut)
        subjects.push(subject, peer)
      }
      await store.write(async tx => {
        await tx.addSightings(base)
        for (const row of cuts) await tx.withdrawFact(row.subject, [row.identifier], row.at, row.key, at)
        await tx.addSightings(late)
      })
      await oracle.write(tx => tx.addSightings(kept))
      await Promise.all([store, oracle].map(s => createGraph(s).rebuild()))
      const read = async (s: typeof store) => s.read(async tx => {
        const edges = (await tx.edgesOf(subjects)).sort((a, b) => a.subject.localeCompare(b.subject) || a.identifier.localeCompare(b.identifier))
        return [edges, await tx.labelsOf(subjects), await tx.states(cuts.map(row => row.identifier))]
      })
      assert.deepEqual(await read(store), await read(oracle))
      assert.deepEqual(await createGraph(store).verify(), [])
    } finally {
      await close()
    }
  })

  test(name + ' separates a thousand records when their only bridge is withdrawn', async () => {
    const { store, close } = await open()
    try {
      const graph = createGraph(store)
      const members = Array.from({ length: 1000 }, (_, i) => 'record:' + String(i).padStart(4, '0'))
      await graph.observe(members.map((subject, i) => ({ subject, identifiers: ['email:left' + i, 'email:left' + (i + 1)], at })))
      assert.equal((await graph.cluster(members[0]!))?.members.length, 1000)
      await graph.withdrawFact(members[500]!, ['email:left500'], at + 1, 'middle', { by })
      assert.equal((await graph.cluster(members[0]!))?.members.length, 500)
      assert.equal((await graph.cluster(members[999]!))?.members.length, 500)
      assert.deepEqual(await graph.verify(), [])
    } finally {
      await close()
    }
  })
}
