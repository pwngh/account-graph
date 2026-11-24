import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { Outdated, brokenAt, callState, createGraph, createHours, defaultPolicy, dialed, email, fit, followUp, hashPhone, nameKeys, policyFrom, recordCall, recordCallResult, recordNotLead, recordReturn } from '../src/index.ts'
import type { Change, GraphOptions, Observation, Policy, Store } from '../src/index.ts'

export interface Opened {
  store: Store
  close(): Promise<void>
}

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Counts and values of steps alone, for tests that are not about people or time. */
export const counts = (stages: Record<string, { count: number; value: number }>) => Object.fromEntries(Object.entries(stages).map(([name, { count, value }]) => [name, { count, value }]))

/** A small deterministic generator, so a failing fuzz run can be replayed from its seed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Every store must pass this. `open` returns a fresh, empty store each call. */
export function suite(name: string, open: () => Promise<Opened>, fuzzSteps: number) {
  describe(name, () => {
    const opened: Opened[] = []
    const fresh = async (policy?: Policy, options?: GraphOptions) => {
      const next = await open()
      opened.push(next)
      return { graph: createGraph(next.store, policy, options), store: next.store }
    }
    /** Subjects in a row, each sharing one identifier of `kind` with the next. */
    const chain = (kind: string, ...subjects: string[]): Observation[] =>
      subjects.map((subject, i) => ({
        subject,
        identifiers: [i > 0 ? `${kind}:${subjects[i - 1]}-${subject}` : '', i < subjects.length - 1 ? `${kind}:${subject}-${subjects[i + 1]}` : ''].filter(Boolean),
        at: T0,
      }))
    const members = async (graph: ReturnType<typeof createGraph>, subject: string) => (await graph.cluster(subject))!.members
    after(async () => {
      for (const each of opened) await each.close()
    })

    test('two accounts on one machine join a cluster, with reasons', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'account:1', identifiers: ['hardware:h1', 'fingerprint:f1', 'ip:198.51.100.7'], at: T0, event: 'login' })
      const changes = await graph.observe({ subject: 'account:2', identifiers: ['hardware:h1', 'fingerprint:f1'], at: T0, event: 'trade' })

      assert.deepEqual(changes, [{ subject: 'account:2', from: 'account:2', to: 'account:1' }])
      assert.deepEqual(await graph.cluster('account:2'), { id: 'account:1', members: ['account:1', 'account:2'], oversized: false })
      const [link] = await graph.links('account:2')
      assert.equal(link!.subject, 'account:1')
      assert.equal(link!.level, 'same')
      assert.deepEqual(link!.reasons.map((reason) => reason.identifier), ['fingerprint:f1', 'hardware:h1'])
      assert.ok(Math.abs(link!.score - (1 - 0.05 * 0.03)) < 1e-12)
      assert.deepEqual((await graph.history('account:2')).map((s) => s.event), ['trade', 'trade'])
      // With a limit, the newest sightings come back, still oldest first.
      await graph.observe({ subject: 'account:2', identifiers: ['email:later'], at: T0 + DAY, event: 'login' })
      assert.deepEqual((await graph.history('account:2', 2)).map((s) => s.identifier), ['fingerprint:f1', 'email:later'])
      assert.deepEqual((await graph.history('account:2', 1)).map((s) => s.identifier), ['email:later'])
      assert.equal((await graph.history('account:2', 50)).length, 3)
      assert.deepEqual(await graph.history('account:2', 0), [])
    })

    test('what one store could not keep, neither takes', async () => {
      const { graph } = await fresh()
      const seen = (subject: unknown, more: Record<string, unknown> = {}) => graph.observe({ subject, identifiers: ['device:d'], at: T0, ...more } as Observation)
      // Kept in PostgreSQL, both halves would be one replacement character and these two one subject.
      for (const subject of ['account:\ud800', 'account:\udfff', 'account:\0', ['account:1'], '']) await assert.rejects(seen(subject), TypeError)
      for (const more of [{ identifiers: ['device:\ud800'] }, { identifiers: ['device:\0'] }, { event: '\0' }, { event: [] }, { at: T0 + 0.5 }, { at: 1e21 }, { at: NaN }]) await assert.rejects(seen('account:1', more), TypeError)
      await assert.rejects(graph.touch({ subject: 'account:1', at: T0 + 0.5 }), TypeError)
      await assert.rejects(graph.transfer({ id: 'x', from: 'account:1', to: 'account:2', amount: 1, at: T0 + 0.5 }), TypeError)
      await assert.rejects(graph.transfer({ id: 'x', from: ['account:1'] as unknown as string, to: 'account:2', amount: 1, at: T0 }), TypeError)
      await assert.rejects(graph.ignore('device:d', 'yes' as unknown as boolean), TypeError)
      await assert.rejects(graph.forget([] as unknown as string), TypeError)
      await assert.rejects(graph.prune(T0 + 0.5), TypeError)
      assert.equal((await graph.counts()).subjects, 0)
      assert.deepEqual(await graph.decisions(), [])
      await seen('account:\u{1f600}')
      assert.deepEqual(await graph.search('account:'), ['account:\u{1f600}'])
    })

    test('a shared address alone links nothing', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['ip:198.51.100.7'], at: T0 },
        { subject: 'account:2', identifiers: ['ip:198.51.100.7'], at: T0 },
      ])
      assert.deepEqual(await graph.links('account:1'), [])
      assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1'])
    })

    test('an unverified hash and an address relate two accounts without merging them', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['canvas:c1', 'ip:198.51.100.7'], at: T0 },
        { subject: 'account:2', identifiers: ['canvas:c1', 'ip:198.51.100.7'], at: T0 },
      ])
      const [link] = await graph.links('account:1')
      assert.equal(link!.level, 'related')
      assert.ok(Math.abs(link!.score - (1 - 0.5 * 0.7)) < 1e-12)
      assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1'])
    })

    test('a verified fingerprint alone joins two accounts', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['fingerprint:f1'], at: T0 },
        { subject: 'account:2', identifiers: ['fingerprint:f1'], at: T0 + 20 * DAY },
      ])
      assert.equal((await graph.links('account:1'))[0]!.level, 'same')
      assert.equal((await graph.cluster('account:2'))!.id, 'account:1')
    })

    test('evidence fades with the time between sightings and returns when they overlap', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'account:1', identifiers: ['canvas:c1'], at: T0 })
      await graph.observe({ subject: 'account:2', identifiers: ['canvas:c1'], at: T0 + 180 * DAY })
      assert.deepEqual(await graph.links('account:1'), [])
      await graph.observe({ subject: 'account:1', identifiers: ['canvas:c1'], at: T0 + 180 * DAY })
      assert.equal((await graph.links('account:1'))[0]!.level, 'related')
    })

    test('an identifier past its cap stops linking, and links again when it drops back', async () => {
      const { graph } = await fresh()
      const cap = defaultPolicy.kinds.device!.cap
      const subjects = Array.from({ length: cap + 1 }, (_, i) => `account:${String(i).padStart(2, '0')}`)
      for (const subject of subjects.slice(0, cap)) await graph.observe({ subject, identifiers: ['device:kiosk'], at: T0 })
      assert.equal((await graph.cluster(subjects[3]!))!.members.length, cap)

      const split = await graph.observe({ subject: subjects[cap]!, identifiers: ['device:kiosk'], at: T0 })
      assert.equal(split.length, cap - 1)
      assert.deepEqual((await graph.cluster(subjects[3]!))!.members, [subjects[3]])

      await graph.forget(subjects[cap]!)
      assert.equal((await graph.cluster(subjects[3]!))!.members.length, cap)
      assert.deepEqual(await graph.verify(), [])
    })

    test('a phone joins two subjects and only relates three, and a value held by a crowd links nobody', async () => {
      const { graph } = await fresh()
      const share = (kind: string, count: number) => Promise.all(Array.from({ length: count }, (_, i) => graph.observe({ subject: `${kind}:${String(i).padStart(2, '0')}`, identifiers: [`${kind}:shared`], at: T0 })))
      await share('phone', 2)
      assert.equal((await graph.cluster('phone:00'))!.members.length, 2)
      await graph.observe({ subject: 'phone:02', identifiers: ['phone:shared'], at: T0 })
      const [link] = await graph.links('phone:00')
      assert.deepEqual([link!.level, Math.round(link!.score * 1e9) / 1e9], ['related', 0.6])
      assert.deepEqual((await graph.cluster('phone:00'))!.members, ['phone:00'])
      await graph.observe({ subject: 'phone:03', identifiers: ['phone:shared'], at: T0 })
      assert.deepEqual(await graph.links('phone:00'), [])
      // An email still joins as many as ten, and the eleventh makes it nobody's.
      await share('email', 10)
      assert.equal((await graph.cluster('email:00'))!.members.length, 10)
      await graph.observe({ subject: 'email:10', identifiers: ['email:shared'], at: T0 })
      assert.deepEqual(await graph.links('email:00'), [])
      await share('voip', 2)
      assert.equal((await graph.links('voip:00'))[0]!.level, 'related')
      await graph.observe({ subject: 'voip:02', identifiers: ['voip:shared'], at: T0 })
      assert.deepEqual(await graph.links('voip:00'), [])
      assert.deepEqual(await graph.verify(), [])
    })

    test('ignoring an identifier splits a cluster and restoring it rejoins', async () => {
      const { graph } = await fresh()
      const shared = email('Front.Desk@example.com')
      await graph.observe([
        { subject: 'account:1', identifiers: [shared], at: T0 },
        { subject: 'account:2', identifiers: [shared], at: T0 },
      ])
      assert.equal((await graph.cluster('account:2'))!.id, 'account:1')
      assert.deepEqual(await graph.ignore(shared), [{ subject: 'account:2', from: 'account:1', to: 'account:2' }])
      assert.deepEqual(await graph.links('account:1'), [])
      await graph.ignore(shared, false)
      assert.equal((await graph.cluster('account:2'))!.id, 'account:1')
    })

    test('forgetting the subject that bridges a cluster splits it and erases the subject', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['email:a'], at: T0 },
        { subject: 'account:2', identifiers: ['email:a', 'email:b'], at: T0 },
        { subject: 'account:3', identifiers: ['email:b'], at: T0 },
      ])
      assert.deepEqual((await graph.cluster('account:3'))!.members, ['account:1', 'account:2', 'account:3'])
      await graph.forget('account:2')
      assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1'])
      assert.deepEqual((await graph.cluster('account:3'))!.members, ['account:3'])
      assert.equal(await graph.cluster('account:2'), undefined)
      assert.deepEqual(await graph.history('account:2'), [])
      assert.deepEqual(await graph.verify(), [])
    })

    test('a reviewer can join two subjects by hand', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['review:case-17'], at: T0, event: 'review' },
        { subject: 'account:2', identifiers: ['review:case-17'], at: T0, event: 'review' },
      ])
      assert.equal((await graph.cluster('account:2'))!.id, 'account:1')
    })

    test('one weak link cannot join two groups, and a second link can', async () => {
      const { graph } = await fresh()
      await graph.observe(chain('hardware', 'a', 'b', 'c', 'd'))
      assert.deepEqual(await members(graph, 'a'), ['a', 'b'])
      assert.deepEqual(await members(graph, 'd'), ['c', 'd'])
      // The two groups are still linked; they are just not one cluster.
      assert.equal((await graph.links('b')).find((link) => link.subject === 'c')!.level, 'same')

      const joined = await graph.observe([
        { subject: 'a', identifiers: ['phone:p'], at: T0 },
        { subject: 'd', identifiers: ['phone:p'], at: T0 },
      ])
      assert.deepEqual(joined.map((change) => change.subject), ['c', 'd'])
      assert.deepEqual(await members(graph, 'a'), ['a', 'b', 'c', 'd'])
      assert.deepEqual(await graph.verify(), [])
    })

    test('a strong link joins two groups on its own, and three in a row stay together', async () => {
      const { graph } = await fresh()
      await graph.observe(chain('email', 'a', 'b', 'c', 'd'))
      assert.deepEqual(await members(graph, 'a'), ['a', 'b', 'c', 'd'])
      await graph.observe(chain('hardware', 'x', 'y', 'z'))
      assert.deepEqual(await members(graph, 'x'), ['x', 'y', 'z'])
    })

    test('five in a weak chain split where two groups meet', async () => {
      const { graph } = await fresh()
      await graph.observe(chain('hardware', 'a', 'b', 'c', 'd', 'e'))
      assert.deepEqual(await members(graph, 'a'), ['a', 'b'])
      assert.deepEqual(await members(graph, 'e'), ['c', 'd', 'e'])
    })

    test('a decision made since someone looked refuses theirs about the same subject or identifier', async () => {
      const { graph, store } = await fresh()
      await graph.observe([1, 2, 3].map((n) => ({ subject: `account:${n}`, identifiers: ['email:e'], at: T0 })))
      await graph.separate('account:1', 'account:2', true, { by: 'lee' })
      const refused = (work: Promise<unknown>) => assert.rejects(work, (error) => error instanceof Outdated && error.decision.by === 'lee')
      await refused(graph.join('account:2', 'account:3', { by: 'dana', seen: 0 }))
      await refused(graph.separate('account:3', 'account:1', true, { seen: 0 }))
      await graph.join('account:3', 'account:4', { seen: 0 })
      await graph.join('account:2', 'account:3', { seen: 2 })
      await graph.ignore('email:e', true, { by: 'lee', seen: 3 })
      // Muting what another has muted since is refused too, though nothing would change. Undoing is not.
      await refused(graph.ignore('email:e', true, { seen: 3 }))
      await graph.ignore('email:e', false, { seen: 3 })
      await graph.separate('account:1', 'account:2', false, { seen: 0 })
      // A forget that is refused has deleted nothing, what was still to be sent included.
      await graph.separate('account:1', 'account:3', true, { by: 'lee' })
      await store.outbox.add({ transactionId: 't', target: 'google', subject: 'account:1', at: T0, action: 'x', keys: {}, state: 'pending', attempts: 0, due: T0 })
      await refused(graph.forget('account:1', { seen: 0 }))
      assert.deepEqual([(await store.outbox.get('t')).length, (await graph.history('account:1')).length], [1, 1])
      await graph.forget('account:1', { seen: (await graph.decisions()).length })
      assert.deepEqual([(await store.outbox.get('t')).length, (await graph.history('account:1')).length], [0, 0])
      // A prune names a time, which is nobody's id.
      await graph.prune(1)
      await graph.forget('1', { seen: (await graph.decisions()).length - 1 })
      await assert.rejects(graph.join('account:5', 'account:6', { seen: 0.5 }), TypeError)
      assert.equal((await graph.audit()).sound, true)
    })

    test('what a program muted and someone restored stays restored, and other text that cannot be kept is refused', async () => {
      const { graph } = await fresh()
      const check = { by: 'line check', automatic: true }
      await graph.ignore('phone:p', true, check)
      await graph.ignore('phone:p', false, { by: 'dana' })
      // A subject may be called what an identifier is called.
      await graph.join('phone:p', 'z', { by: 'dana' })
      await graph.ignore('phone:p', true, check)
      assert.deepEqual((await graph.decisions()).map(({ action, by }) => [action, by]), [['ignore', 'line check'], ['restore', 'dana'], ['join', 'dana']])
      // A person may still mute it.
      await graph.ignore('phone:p', true, { by: 'dana' })
      assert.equal((await graph.decisions()).length, 4)

      const deep = JSON.parse(`${'['.repeat(20_000)}${']'.repeat(20_000)}`)
      for (const bad of [{ x: 1 }, { x: deep }, { gclid: 5 }, { gclid: deep }, { campaignId: 123 }, { source: null }, { gclid: '\0' }, { custom: { a: deep } }, { custom: ['a'] }, { custom: 'a' }, { custom: { a: 5 } }, { custom: { a: '\ud800' } }]) {
        await assert.rejects(graph.touch({ subject: 'visitor:1', at: T0, ...bad } as never), TypeError)
      }
      await graph.touch({ subject: 'visitor:1', at: T0, gclid: 'G', custom: { 'two words': 'x' } })
      for (const half of ['\ud800', 'a\0']) {
        await assert.rejects(graph.join('a', half), TypeError)
        await assert.rejects(graph.separate(half, 'b'), TypeError)
        await assert.rejects(graph.ignore(`email:${half}`), TypeError)
        await assert.rejects(graph.ignore('email:e', true, { reason: half }), TypeError)
        await assert.rejects(graph.forget(half), TypeError)
        await assert.rejects(graph.outcome({ transactionId: half, subject: 'a', at: T0 }), TypeError)
        await assert.rejects(graph.consent('a', { adUserData: true, adPersonalization: true }, { at: 1, source: half }), TypeError)
        await assert.rejects(graph.spend({ day: '2026-03-01', source: 'google', campaign: half, amount: 1 }), TypeError)
      }
      assert.equal((await graph.decisions()).length, 4)
    })

    test('a reviewer keeps two subjects apart, and can change their mind', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'account:1', identifiers: ['email:shared'], at: T0 },
        { subject: 'account:2', identifiers: ['email:shared'], at: T0 },
      ])
      assert.deepEqual(await graph.separate('account:2', 'account:1'), [{ subject: 'account:2', from: 'account:1', to: 'account:2' }])
      assert.deepEqual(await graph.links('account:1'), [])
      assert.deepEqual(await members(graph, 'account:1'), ['account:1'])
      // More shared evidence does not undo the decision.
      await graph.observe([
        { subject: 'account:1', identifiers: ['device:d'], at: T0 },
        { subject: 'account:2', identifiers: ['device:d'], at: T0 },
      ])
      assert.deepEqual(await members(graph, 'account:1'), ['account:1'])
      await graph.separate('account:1', 'account:2', false)
      assert.deepEqual(await members(graph, 'account:1'), ['account:1', 'account:2'])
      await assert.rejects(graph.separate('account:1', 'account:1'), TypeError)
    })

    test('separating two subjects tied through a third cuts the weaker tie', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'a', identifiers: ['email:ac'], at: T0 },
        { subject: 'c', identifiers: ['email:ac', 'hardware:cb'], at: T0 },
        { subject: 'b', identifiers: ['hardware:cb'], at: T0 },
      ])
      assert.deepEqual(await members(graph, 'a'), ['a', 'b', 'c'])
      await graph.separate('a', 'b')
      assert.deepEqual(await members(graph, 'a'), ['a', 'c'])
      assert.deepEqual(await members(graph, 'b'), ['b'])
      assert.deepEqual(await graph.verify(), [])
    })

    test('a decision made before any evidence still holds when the evidence arrives', async () => {
      const { graph } = await fresh()
      assert.deepEqual(await graph.separate('x', 'y'), [])
      await graph.observe([
        { subject: 'x', identifiers: ['email:xy'], at: T0 },
        { subject: 'y', identifiers: ['email:xy'], at: T0 },
      ])
      assert.deepEqual(await members(graph, 'x'), ['x'])
      await graph.forget('x')
      await graph.observe({ subject: 'x', identifiers: ['email:xy'], at: T0 })
      assert.deepEqual(await members(graph, 'x'), ['x', 'y'])
    })

    test('a reviewer joins two subjects, and the largest clusters are listed for review', async () => {
      const clock = { now: T0 + DAY }
      const { graph } = await fresh({ ...defaultPolicy, review: 2 }, { now: () => clock.now })
      await graph.observe(chain('email', 'a', 'b', 'c'))
      await graph.observe(chain('email', 'x', 'y'))
      await graph.observe({ subject: 'solo', identifiers: ['email:solo'], at: T0 })
      assert.deepEqual(await graph.clusters(), [
        { id: 'a', size: 3, oversized: true },
        { id: 'x', size: 2, oversized: false },
      ])
      assert.deepEqual(await graph.clusters(1), [{ id: 'a', size: 3, oversized: true }])

      assert.deepEqual(await graph.join('solo', 'y', { by: 'dana' }), [{ subject: 'y', from: 'x', to: 'solo' }, { subject: 'x', from: 'x', to: 'solo' }].sort((p, q) => (p.subject < q.subject ? -1 : 1)))
      assert.deepEqual(await members(graph, 'solo'), ['solo', 'x', 'y'])
      assert.deepEqual((await graph.history('solo')).at(-1), { subject: 'solo', identifier: 'review:join-1', at: T0 + DAY, event: 'review', recorded: T0 + DAY })
      assert.deepEqual((await graph.decisions()).map((d) => [d.action, d.about, d.by]), [['join', ['solo', 'y'], 'dana']])
      await assert.rejects(graph.join('solo', 'solo'), TypeError)
      await assert.rejects(graph.join('solo', 7 as unknown as string), TypeError)

      // Ids that contain a plus sign must not be confused: these two joins involve four different subjects.
      await graph.join('p', 'q+r')
      await graph.join('p+q', 'r')
      assert.deepEqual(await members(graph, 'p'), ['p', 'q+r'])
      assert.deepEqual(await members(graph, 'r'), ['p+q', 'r'])
      // A join can be undone by muting its identifier, and made again afterwards.
      await graph.ignore('review:join-2')
      assert.deepEqual(await members(graph, 'p'), ['p'])
      // The next join would be named review:join-4. Two strangers already hold that name; it must not join them to p.
      await graph.observe([
        { subject: 'stranger:1', identifiers: ['review:join-4'], at: T0 },
        { subject: 'stranger:2', identifiers: ['review:join-4'], at: T0 },
      ])
      await graph.join('p', 'q+r')
      assert.deepEqual(await members(graph, 'p'), ['p', 'q+r'])
      // Forgetting one side leaves nothing that names it.
      await graph.forget('p')
      assert.equal((await graph.history('q+r')).some((sighting) => sighting.identifier.includes('p')), false)

      await graph.separate('y', 'a')
      await graph.separate('b', 'y')
      assert.deepEqual(await graph.separations('y'), ['a', 'b'])
      assert.deepEqual(await graph.separations('solo'), [])
    })

    test('clusters of equal size are listed in the same order by every store', async () => {
      const { graph } = await fresh()
      // Mixed case and punctuation sort differently under a database's language rules than in JavaScript.
      for (const id of ['a1', 'B1', '_x', 'a-1', 'a 1']) await graph.observe(chain('email', id, `${id}~`))
      assert.deepEqual((await graph.clusters()).map((cluster) => cluster.id), ['B1', '_x', 'a 1', 'a-1', 'a1'])
      assert.deepEqual((await graph.clusters(2)).map((cluster) => cluster.id), ['B1', '_x'])
    })

    test('the version changes with every write and with nothing else', async () => {
      const { graph } = await fresh()
      const start = await graph.version()
      await graph.observe({ subject: 'a', identifiers: ['email:e'], at: T0 })
      const seen = await graph.version()
      assert.ok(seen > start)
      await graph.links('a')
      await graph.verify()
      assert.equal(await graph.version(), seen)
      await graph.outcome({ transactionId: 't1', subject: 'a', at: T0, value: 1 })
      const counted = await graph.version()
      await graph.restate('t1', 2)
      assert.ok(counted > seen && (await graph.version()) > counted)
    })

    test('counts say how much the graph holds', async () => {
      const { graph } = await fresh()
      assert.deepEqual(await graph.counts(), { subjects: 0, clusters: 0, identifiers: 0, edges: 0, sightings: 0, touches: 0, decisions: 0, outcomes: 0 })
      await graph.observe([
        { subject: 'a', identifiers: ['email:e', 'ip:198.51.100.2'], at: T0 },
        { subject: 'b', identifiers: ['email:e'], at: T0 },
        { subject: 'c', identifiers: ['email:other'], at: T0 },
      ])
      await graph.observe({ subject: 'a', identifiers: ['email:e'], at: T0 + HOUR })
      await graph.touch({ subject: 'a', at: T0, gclid: 'G' })
      await graph.ignore('ip:198.51.100.2')
      await graph.outcome({ transactionId: 't1', subject: 'a', at: T0 })
      assert.deepEqual(await graph.counts(), { subjects: 3, clusters: 2, identifiers: 3, edges: 4, sightings: 5, touches: 1, decisions: 1, outcomes: 1 })
    })

    test('what one step cost counts that step alone, on the days the cost is known', async () => {
      const { graph } = await fresh()
      const at = Date.UTC(2026, 2, 2, 12)
      await graph.spend([{ day: '2026-03-02', source: 'google', campaignId: '1', amount: 1872 }, { day: '2026-03-02', source: 'google', campaignId: '2', amount: 100 }])
      for (let n = 0; n < 12; n++) {
        await graph.touch({ subject: `visitor:${n}`, at: at - HOUR, gclid: `G${n}`, campaignId: '1' })
        await graph.outcome({ transactionId: `o${n}`, subject: `visitor:${n}`, at, stage: n < 9 ? 'call' : 'enrolled', value: n < 9 ? 5 : 200 })
      }
      const of = async (per?: string) => {
        const { rows, total, ...rest } = await graph.report({ from: '2026-03-02', to: '2026-03-02', ...(per && { per }) })
        return [rest.per, rows.map((row) => [row.campaignId, row.costPerOutcome]), rows[0]!.returnOnCost, total.costPerOutcome]
      }
      const back = Math.round((645 / 1872) * 1e6) / 1e6
      assert.deepEqual(await of(), [undefined, [['1', 156], ['2', null]], back, Math.round((1972 / 12) * 1e6) / 1e6])
      assert.deepEqual(await of('enrolled'), ['enrolled', [['1', 624], ['2', null]], back, Math.round((1972 / 3) * 1e6) / 1e6])
      assert.deepEqual(await of('never'), ['never', [['1', null], ['2', null]], back, null])
    })

    test('the report sets what each campaign cost beside what it brought in', async () => {
      const { graph } = await fresh()
      const day = (n: number) => Date.parse('2026-03-01T12:00:00Z') + n * DAY
      // Three visitors arrive: one from a Google campaign named by id, one from a Meta campaign named only by name, one from another site.
      const arrive = async (n: number, at: number, touch: object) => {
        await graph.observe({ subject: `visitor:${n}`, identifiers: [`device:${n}`], at, event: 'visit' })
        await graph.touch({ subject: `visitor:${n}`, at, ...touch })
        await graph.observe({ subject: `contact:${n}`, identifiers: [`device:${n}`], at: at + HOUR, event: 'enroll' })
      }
      await arrive(1, day(0), { gclid: 'G1', campaignId: '111', campaign: 'Spring', custom: { placement: 'top' } })
      await arrive(2, day(1), { fbclid: 'F2', source: 'Facebook', campaign: 'retarget' })
      await arrive(3, day(1), { referrer: 'https://www.partner.example/list' })
      await graph.observe({ subject: 'contact:4', identifiers: ['email:walk-in'], at: day(2) })

      await graph.spend([
        { day: '2026-03-01', source: 'google', campaignId: '111', campaign: 'Spring sale', amount: 40.1, currency: 'USD', clicks: 30, impressions: 900 },
        { day: '2026-03-02', source: 'google', campaignId: '111', campaign: 'Spring sale', amount: 20.2, currency: 'USD', clicks: 12, impressions: 400 },
        { day: '2026-03-02', source: 'Meta', campaignId: '777', campaign: 'Retarget', amount: 15, currency: 'USD', clicks: 9 },
        { day: '2026-03-02', source: 'google', campaignId: '222', campaign: 'Brand', amount: 5, currency: 'USD' },
        { day: '2026-04-01', source: 'google', campaignId: '111', campaign: 'Spring sale', amount: 999 },
      ])
      // Writing a day again replaces it.
      await graph.spend({ day: '2026-03-02', source: 'google', campaignId: '222', campaign: 'Brand', amount: 6, currency: 'USD' })

      assert.equal(await graph.outcome({ transactionId: 'inq-1', subject: 'contact:1', at: day(0) + 2 * HOUR, stage: 'inquiry', value: 5, currency: 'USD' }), true)
      assert.equal(await graph.outcome({ transactionId: 'enr-1', subject: 'contact:1', at: day(2), stage: 'enrolled', value: 200, currency: 'USD' }), true)
      assert.equal(await graph.outcome({ transactionId: 'enr-2', subject: 'contact:2', at: day(2), stage: 'enrolled', value: 200, currency: 'USD' }), true)
      assert.equal(await graph.outcome({ transactionId: 'inq-3', subject: 'contact:3', at: day(1) + 2 * HOUR, stage: 'inquiry', value: 5 }), true)
      assert.equal(await graph.outcome({ transactionId: 'enr-4', subject: 'contact:4', at: day(2), stage: 'enrolled', value: 200 }), true)
      // The first record of an id stands; restating changes its value.
      assert.equal(await graph.outcome({ transactionId: 'enr-2', subject: 'contact:2', at: day(2), stage: 'enrolled', value: 1 }), false)
      assert.equal(await graph.restate('enr-2', 150.5), true)
      assert.equal(await graph.restate('nobody', 1), false)

      const report = await graph.report({ from: '2026-03-01', to: '2026-03-03' })
      const line = (source: string, campaignId: string) => report.rows.find((row) => row.source === source && row.campaignId === campaignId)
      assert.deepEqual(report.rows.map((row) => [row.source, row.campaignId, row.campaign]), [
        ['google', '111', 'Spring sale'],
        ['meta', '777', 'Retarget'],
        ['google', '222', 'Brand'],
        ['(none)', '', ''],
        ['partner.example', '', ''],
      ])
      assert.deepEqual(line('google', '111'), {
        source: 'google', campaignId: '111', campaign: 'Spring sale', cost: 60.3, clicks: 42, impressions: 1300, visits: 1, missed: 0, notLeads: 0,
        stages: { inquiry: { count: 1, value: 5, people: 1, delay: { count: 1, median: 0.1, p95: 0.1, inside: 1 } }, enrolled: { count: 1, value: 200, people: 1, delay: { count: 1, median: 2, p95: 2, inside: 1 } } }, outcomes: 2, value: 205, people: 1, valueChange: { outcomes: 2, first: 205, now: 205, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 },
        // Cost data for two of three days. The enrollment on the third is not set against their cost.
        costDays: 2, missingDays: 1, insufficientData: false, costPerOutcome: 60.3, returnOnCost: 0.082919,
      })
      // The Meta touch named its campaign only by name, in another case, and its source by an alias.
      assert.deepEqual(line('meta', '777'), {
        source: 'meta', campaignId: '777', campaign: 'Retarget', cost: 15, clicks: 9, impressions: 0, visits: 1, missed: 0, notLeads: 0,
        stages: { enrolled: { count: 1, value: 150.5, people: 1, delay: { count: 1, median: 1, p95: 1, inside: 1 } } }, outcomes: 1, value: 150.5, people: 1, valueChange: { outcomes: 1, first: 200, now: 150.5, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 },
        // One day of three is too few to say what anything cost.
        costDays: 1, missingDays: 2, insufficientData: true, costPerOutcome: null, returnOnCost: null,
      })
      assert.equal(line('google', '222')!.cost, 6)
      assert.deepEqual(counts(line('(none)', '')!.stages), { enrolled: { count: 1, value: 200 } })
      assert.deepEqual(report.total, {
        cost: 81.3, clicks: 51, impressions: 1300, visits: 3, missed: 0, notLeads: 0,
        stages: { inquiry: { count: 2, value: 10, people: 2, delay: { count: 2, median: 0.1, p95: 0.1, inside: 1 } }, enrolled: { count: 3, value: 550.5, people: 3, delay: { count: 2, median: 1.5, p95: 2, inside: 1 } } }, outcomes: 5, value: 560.5, people: 4, valueChange: { outcomes: 5, first: 610, now: 560.5, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 },
        // Of the campaigns with enough cost data alone: never all spend over all outcomes.
        costDays: 2, missingDays: 1, insufficientData: false, costPerOutcome: 60.3, returnOnCost: 0.082919,
      })
      assert.deepEqual(report.currencies, ['USD'])

      // A narrower range leaves out the later days, and a day belongs to the time zone asked for.
      const first = await graph.report({ from: '2026-03-01', to: '2026-03-01' })
      assert.deepEqual([first.total.cost, first.total.outcomes, first.total.visits], [40.1, 1, 1])
      // Midnight on Kiritimati comes fourteen hours before UTC's, so its 1 March ended before the first outcome.
      const kiritimati = await graph.report({ from: '2026-03-01', to: '2026-03-01', timeZone: 'Pacific/Kiritimati' })
      assert.deepEqual([kiritimati.total.outcomes, kiritimati.total.visits, kiritimati.total.cost], [0, 0, 40.1])
      // And in Pago Pago, eleven hours behind, 2 March runs until 11:00 UTC on the 3rd, an hour before the enrollments.
      const pagoPago = await graph.report({ from: '2026-03-02', to: '2026-03-02', timeZone: 'Pacific/Pago_Pago' })
      assert.deepEqual(counts(pagoPago.total.stages), { inquiry: { count: 1, value: 5 } })

      // The custom parameter came back with the touch.
      assert.deepEqual((await graph.attribute('contact:1', { at: day(2) })).credited!.custom, { placement: 'top' })

      // Forgetting a person takes their outcomes out of the report.
      await graph.forget('contact:2')
      assert.equal((await graph.report({ from: '2026-03-01', to: '2026-03-03' })).total.outcomes, 4)

      // What a caller sends as a name is kept as text, whatever it was.
      await graph.spend({ day: '2026-03-03', source: 'google', campaignId: 333 as unknown as string, campaign: 2026 as unknown as string, amount: 1 })
      assert.equal((await graph.report({ from: '2026-03-03', to: '2026-03-03' })).rows.find((row) => row.campaignId === '333')!.campaign, '2026')
      await assert.rejects(graph.outcome({ transactionId: 'x', subject: 'contact:1', at: day(0), value: '5' as unknown as number }), TypeError)
      await assert.rejects(graph.outcome({ transactionId: 'x', subject: 'contact:1', at: day(0) + 0.5 }), TypeError)
      await assert.rejects(graph.outcome({ transactionId: 'x', subject: 'contact:1', at: day(0), stage: 7 as unknown as string }), TypeError)
      await assert.rejects(graph.spend({ day: 'March 1', source: 'google', amount: 1 }), TypeError)
      await assert.rejects(graph.spend({ day: '2026-03-01', source: 'google', amount: -1 }), TypeError)
      await assert.rejects(graph.report({ from: '2026-03-02', to: '2026-03-01' }), TypeError)
      await assert.rejects(graph.report({ from: '2026-03-01', to: '2026-03-01', timeZone: 'Mars/Olympus' }), TypeError)
    })

    test('a report, open calls and the board read many people together, and credit each as attribute does', async () => {
      const { graph, store } = await fresh()
      const next = random(7)
      const day = Date.parse('2026-03-02T00:00:00Z')
      const PEOPLE = 40
      for (let i = 0; i < PEOPLE; i++) {
        // Chains of two links, links too weak to credit, arrivals at one moment, people kept apart, and a browser two people share.
        await graph.observe([
          { subject: `visitor:${i}`, identifiers: [`device:d${i}`, `ip:${i % 5}`], at: day - 2 * DAY },
          { subject: `account:${i}`, identifiers: [`device:d${next() < 0.2 ? (i + 1) % PEOPLE : i}`, `email:e${i}`], at: day - DAY },
          { subject: `lead:${i}`, identifiers: [`email:e${i}`, `canvas:c${i % 9}`], at: day - DAY },
        ])
        for (let k = 0; k < 2; k++) await graph.touch({ subject: `visitor:${i}`, at: day - Math.floor(next() * 4) * 60 * DAY, source: 'google', campaignId: `c${i}${k}` })
        if (next() < 0.2) await graph.separate(`visitor:${i}`, `lead:${i}`)
        await graph.outcome({ transactionId: `o${i}`, subject: `lead:${i}`, at: day + i, stage: 'signup' })
        await graph.keepCallResult(`k${i}`, { answered: false })
        await graph.keepCall({ id: `k${i}`, direction: 'inbound', subject: `account:${i}`, at: day + i, to: '+15550100101', flags: [] })
      }
      const reads = new Map<string, number>()
      const counting: Store = {
        ...store,
        read: (fn) => store.read((tx) => fn(new Proxy(tx, { get: (it, key) => (reads.set(String(key), (reads.get(String(key)) ?? 0) + 1), Reflect.get(it, key)) }))),
      }
      const counted = createGraph(counting)
      const range = { from: '2026-03-02', to: '2026-03-02' }
      const own = async (subject: string, at: number) => (await graph.attribute(subject, { at })).credited
      const credits = new Map<string, number>()
      for (let i = 0; i < PEOPLE; i++) {
        const touch = await own(`lead:${i}`, day + i)
        const campaign = touch?.campaignId ?? ''
        credits.set(campaign, (credits.get(campaign) ?? 0) + 1)
      }
      assert.ok(credits.size > 10)
      const rows = (await counted.report(range)).rows.filter((row) => row.outcomes > 0)
      assert.deepEqual(new Map(rows.map((row) => [row.campaignId, row.outcomes] as const).sort()), new Map([...credits].sort()))
      const open = await counted.openCalls({ ...range, limit: PEOPLE })
      assert.equal(open.length, PEOPLE)
      for (const each of open) assert.deepEqual(each.touch, await own(each.call.subject, each.call.at))
      const { columns } = await counted.board({ steps: [{ name: 'signup' }], days: 7, at: day + HOUR })
      assert.ok(columns.some((column) => column.rows.length > 0))
      for (const { rows } of columns) for (const row of rows) assert.deepEqual(row.touch, await own(row.subject, row.at))
      for (const key of ['edgesOf', 'edgesOn', 'states', 'separatedOf', 'touchesOf']) assert.ok(reads.get(key)! <= 12, `${key} was read ${reads.get(key)} times`)
    })

    test('what a decision would do is what it does, and foreseeing it writes nothing', async () => {
      const { graph } = await fresh()
      await graph.observe([1, 2, 3].map((n) => ({ subject: `a:${n}`, identifiers: ['device:a'], at: T0 })))
      await graph.observe([1, 2].map((n) => ({ subject: `b:${n}`, identifiers: ['email:b'], at: T0 })))
      await graph.observe({ subject: 'c:1', identifiers: ['device:c'], at: T0 })
      const sizes = async (...subjects: string[]) => [...new Map(await Promise.all(subjects.map(async (subject) => { const cluster = (await graph.cluster(subject))!; return [cluster.id, cluster.members.length] as const })))].map(([, size]) => size).sort().reverse()
      const seen = (list: { size: number }[]) => list.map(({ size }) => size)
      const check = async (supposed: Parameters<typeof graph.foresee>[0], subjects: string[], act: () => Promise<readonly unknown[]>, expected: [number[], number[]]) => {
        const before = await graph.version()
        const { moved, before: was, after } = await graph.foresee(supposed)
        assert.equal(await graph.version(), before)
        assert.deepEqual([seen(was), seen(after)], expected)
        assert.deepEqual(await sizes(...subjects), expected[0])
        const changes = await act()
        assert.deepEqual([changes.length > 0, await sizes(...subjects)], [moved > 0, expected[1]])
        assert.equal(changes.length, moved)
      }
      await check({ action: 'join', a: 'a:1', b: 'b:1' }, ['a:1', 'b:1'], () => graph.join('a:1', 'b:1'), [[3, 2], [5]])
      await check({ action: 'separate', a: 'a:1', b: 'b:1' }, ['a:1', 'b:1'], () => graph.separate('a:1', 'b:1'), [[5], [3, 2]])
      // A separation holds over a join.
      await check({ action: 'join', a: 'b:1', b: 'a:1' }, ['a:1', 'b:1'], () => graph.join('a:1', 'b:1'), [[3, 2], [3, 2]])
      await check({ action: 'separate', a: 'b:1', b: 'a:1', separated: false }, ['a:1', 'b:1'], () => graph.separate('a:1', 'b:1', false), [[3, 2], [5]])
      await check({ action: 'ignore', identifier: 'email:b' }, ['b:1', 'b:2'], () => graph.ignore('email:b'), [[5], [4, 1]])
      await check({ action: 'ignore', identifier: 'email:b', ignored: false }, ['b:1', 'b:2'], () => graph.ignore('email:b', false), [[4, 1], [5]])
      // One kept from the first goes over to another it is tied to, which is neither named nor moved and still counts.
      await graph.observe([{ subject: 'd:1', identifiers: ['device:d', 'email:d'], at: T0 }, { subject: 'd:3', identifiers: ['device:d', 'email:d', 'payment:d'], at: T0 }, { subject: 'd:2', identifiers: ['payment:d'], at: T0 }])
      await graph.separate('d:1', 'd:2')
      await check({ action: 'separate', a: 'd:1', b: 'd:3' }, ['d:1', 'd:2', 'd:3'], () => graph.separate('d:1', 'd:3'), [[2, 1], [2, 1]])
      assert.deepEqual((await graph.cluster('d:3'))!.members, ['d:2', 'd:3'])
      assert.deepEqual(await graph.foresee({ action: 'ignore', identifier: 'email:nobody' }), { moved: 0, before: [], after: [] })
      assert.deepEqual(await graph.foresee({ action: 'join', a: 'c:1', b: 'never:seen' }), { moved: 1, before: [{ id: 'c:1', size: 1 }, { id: 'never:seen', size: 1 }], after: [{ id: 'c:1', size: 2 }] })
      for (const bad of [{}, { action: 'forget' }, { action: 'join', a: 'a:1' }, { action: 'join', a: 'a:1', b: 'a:1' }, { action: 'ignore' }, { action: 'ignore', identifier: 'email:b', ignored: 'false' }, { action: 'separate', a: 'a:1', b: 'b:1', separated: 0 }]) await assert.rejects(graph.foresee(bad as never), TypeError)
    })

    test('a call from a number left out, or placed to one, records nothing, and one recorded before still settles', async () => {
      const { graph } = await fresh()
      const options = { exclude: ['(555) 010-0021'], results: 'expected' as const }
      const call = { from: '+15550100021', to: '+15550100001', at: T0, duration: 60 }
      const left = await recordCall(graph, { id: 'X1', ...call, answered: true }, options)
      assert.deepEqual([left.flags, left.counted, left.duplicate], [['left_out'], false, false])
      const rung = await recordCall(graph, { id: 'X2', direction: 'outbound', ...call, from: call.to, to: call.from }, options)
      assert.deepEqual(rung.flags, ['left_out'])
      assert.deepEqual([await graph.keptCall('X1'), await graph.keptCall('X2'), await graph.cluster(left.subject)].map((each) => each ?? null), [null, null, null])
      assert.equal((await recordCall(graph, { id: 'X3', ...call, from: '+15550100022' }, options)).flags.includes('left_out'), false)
      // Kept and then cut off before its note was written: the report of it that comes again finishes it.
      await graph.keepCall({ id: 'X5', direction: 'inbound', subject: left.subject, at: T0, to: '+15550100001', flags: [] })
      const again = await recordCall(graph, { id: 'X5', ...call, answered: true }, options)
      assert.deepEqual([again.flags.includes('left_out'), again.state], [false, 'answered'])
      // Recorded before the number was left out: what is known of it can still be made right.
      await recordCall(graph, { id: 'X4', ...call }, { results: 'expected' })
      assert.deepEqual([(await recordCall(graph, { id: 'X4', ...call, answered: true }, options)).counted, (await graph.keptCall('X4'))!.subject], [true, left.subject])
    })

    test('a call is tied to the visitor who tapped the number, or filed under the number it rang', async () => {
      const { graph } = await fresh()
      const numbers = { '(555) 123-0001': { source: 'google', campaignId: '111' }, '+15551230002': { source: 'mailer', campaign: 'postcard' } }
      const MINUTE = 60_000
      const caller = (number: string) => `caller:${hashPhone(number)}`

      // A visitor arrives from an ad, taps the number, and the call begins twenty seconds later.
      await graph.observe({ subject: 'visitor:a', identifiers: ['device:a'], at: T0, event: 'visit' })
      await graph.touch({ subject: 'visitor:a', at: T0, gclid: 'G-a', campaignId: '111' })
      await graph.observe({ subject: 'visitor:a', identifiers: ['device:a', dialed('+1 555 123 0001', T0 + MINUTE)], at: T0 + MINUTE, event: 'phone_click' })
      const tied = await recordCall(graph, { id: 'CA1', from: '555-867-5309', to: '+15551230001', at: T0 + MINUTE + 20_000, duration: 95 }, { numbers })
      assert.deepEqual(tied, { subject: caller('+15558675309'), flags: [], counted: true, state: 'unknown', visitor: 'visitor:a', duplicate: false })
      assert.deepEqual(await members(graph, 'visitor:a'), [caller('+15558675309'), 'visitor:a'].sort())
      const credited = (await graph.attribute(tied.subject, { at: T0 + 2 * MINUTE })).credited!
      assert.deepEqual([credited.gclid, credited.subject], ['G-a', 'visitor:a'])

      // The provider reports the same call again: nothing is written twice.
      const sightings = (await graph.counts()).sightings
      assert.deepEqual(await recordCall(graph, { id: 'CA1', from: '555-867-5309', to: '+15551230001', at: T0 + MINUTE + 20_000, duration: 95 }, { numbers }), {
        subject: tied.subject, flags: [], counted: false, state: 'unknown', duplicate: true,
      })
      assert.equal((await graph.counts()).sightings, sightings)

      // One tap leads to one caller. A different number ringing a minute later is not that visitor; the same caller ringing back is.
      const stranger = await recordCall(graph, { id: 'CA1b', from: '+15559990000', to: '+15551230001', at: T0 + 2 * MINUTE, duration: 60 }, { numbers })
      assert.deepEqual([stranger.flags, stranger.visitor], [[], undefined])
      assert.equal((await graph.attribute(stranger.subject, { at: T0 + 3 * MINUTE })).credited!.landing, 'tel:+15551230001')
      const back = await recordCall(graph, { id: 'CA1c', from: '+15558675309', to: '+15551230001', at: T0 + 2 * MINUTE + 30_000, duration: 60 }, { numbers })
      assert.deepEqual([back.flags, back.visitor], [['repeat'], 'visitor:a'])

      // Nobody tapped the postcard's number, so the call is filed under the postcard. The caller enrolls later with the same phone.
      const mailed = await recordCall(graph, { id: 'CA2', from: '+15550001111', to: '555-123-0002', at: T0 + HOUR, duration: 200 }, { numbers })
      assert.deepEqual([mailed.flags, mailed.counted, mailed.visitor], [[], true, undefined])
      await graph.observe({ subject: 'account:9', identifiers: [`phone:${hashPhone('+15550001111')}`], at: T0 + DAY, event: 'enroll' })
      const viaPhone = (await graph.attribute('account:9', { at: T0 + DAY })).credited!
      assert.deepEqual([viaPhone.source, viaPhone.medium, viaPhone.campaign, viaPhone.landing], ['mailer', 'call', 'postcard', 'tel:+15551230002'])

      // The same number calls again and hangs up: flagged, recorded, not counted.
      const again = await recordCall(graph, { id: 'CA3', from: '+15550001111', to: '+15551230002', at: T0 + 2 * HOUR, duration: 4 }, { numbers })
      assert.deepEqual([again.flags, again.counted], [['short', 'repeat'], false])

      // A hidden number and a toll-free line each tie the call to nobody.
      const hidden = await recordCall(graph, { id: 'CA4', from: 'anonymous', to: '+15551230002', at: T0 + 3 * HOUR, duration: 60 }, { numbers })
      assert.deepEqual([hidden.subject, hidden.flags, hidden.counted], ['call:CA4', ['blocked'], true])
      // Carriers also report a hidden caller as a word spelled in digits. Each such call is its own subject, never one shared caller.
      for (const [n, from] of ['+266696687', '+7378742833', '+86282452253', '+2562533', '+8656696', ''].entries()) {
        const masked = await recordCall(graph, { id: `CA4-${n}`, from, to: '+15551230002', at: T0 + 3 * HOUR, duration: 5 }, { numbers })
        assert.deepEqual([masked.subject, masked.flags], [`call:CA4-${n}`, ['blocked', 'short']])
      }
      const switchboard = await recordCall(graph, { id: 'CA5', from: '+18885550100', to: '+15551230002', at: T0 + 3 * HOUR, duration: 60 }, { numbers })
      assert.deepEqual(switchboard.flags, ['toll_free'])
      assert.deepEqual(await graph.links(switchboard.subject), [])
      assert.deepEqual((await graph.history(switchboard.subject)).map((sighting) => sighting.identifier), ['dialed:call-CA5'])

      // One visitor, one caller, for good: tapping again later does not earn a browser a second stranger's call.
      await graph.observe({ subject: 'visitor:a', identifiers: ['device:a', dialed('+15551230001', T0 + 20 * HOUR)], at: T0 + 20 * HOUR, event: 'phone_click' })
      assert.equal((await recordCall(graph, { id: 'CA1d', from: '+15553334444', to: '+15551230001', at: T0 + 20 * HOUR + 5000, duration: 5 }, { numbers })).visitor, undefined)
      assert.equal((await recordCall(graph, { id: 'CA1e', from: '+15558675309', to: '+15551230001', at: T0 + 20 * HOUR + 9000, duration: 5 }, { numbers })).visitor, 'visitor:a')

      // Two visitors tap the same number in the same minute: the call cannot say which, so it is tied to neither.
      for (const who of ['b', 'c']) await graph.observe({ subject: `visitor:${who}`, identifiers: [`device:${who}`, dialed('+15551230001', T0 + 5 * HOUR)], at: T0 + 5 * HOUR, event: 'phone_click' })
      const unsure = await recordCall(graph, { id: 'CA6', from: '+15552223333', to: '+15551230001', at: T0 + 5 * HOUR + 10_000, duration: 60 }, { numbers })
      assert.deepEqual([unsure.flags, unsure.visitor], [['ambiguous'], undefined])
      // A tap four minutes before a call is too old to be the reason for it.
      const late = await recordCall(graph, { id: 'CA7', from: '+15554445555', to: '+15551230001', at: T0 + 5 * HOUR + 4 * MINUTE, duration: 60 }, { numbers })
      assert.deepEqual([late.flags, late.visitor], [[], undefined])

      // Counted calls are outcomes of the `call` step: CA1, CA1b, CA1c, CA2, CA4, CA5, CA6, CA7.
      const report = await graph.report({ from: '2023-11-14', to: '2023-11-15' })
      assert.deepEqual(counts(report.total.stages), { call: { count: 8, value: 0 } })
      assert.equal(report.rows.find((row) => row.campaignId === '111')!.stages.call!.count, 5)
      assert.deepEqual(await graph.verify(), [])

      await assert.rejects(recordCall(graph, { id: 'bad id', to: '+15551230001', at: T0 }), TypeError)
      await assert.rejects(recordCall(graph, { id: 'CA8', to: 'nope', at: T0 }), TypeError)
      await assert.rejects(recordCall(graph, { id: 'CA8', to: '+15551230001', at: T0 + 0.5 }), TypeError)
      await assert.rejects(recordCall(graph, { id: 'CA8', to: '+15551230001', at: 3e21 }), TypeError)
      await assert.rejects(recordCall(graph, { id: 'CA8', to: '+15551230001', at: T0, duration: 'abc' as unknown as number }), TypeError)
      // A channel is read for its four fields and nothing else.
      const odd = { '+15551230003': { source: 'radio', subject: 'someone-else', at: 1 } as unknown as { source: string } }
      const filed = await recordCall(graph, { id: 'CA9', from: '+15556667777', to: '+15551230003', at: T0 + 6 * HOUR, duration: 60 }, { numbers: odd })
      const touch = (await graph.attribute(filed.subject, { at: T0 + 6 * HOUR })).credited!
      assert.deepEqual([touch.subject, touch.at, touch.source], [filed.subject, T0 + 6 * HOUR, 'radio'])
      // If counting the call fails, nothing lasting was written: reported again, it is recorded once.
      await assert.rejects(recordCall(graph, { id: 'CA10', from: '+15557778888', to: '+15551230002', at: T0 + 7 * HOUR, duration: 60 }, { numbers, convert: () => Promise.reject(new Error('down')) }), /down/)
      const retried = await recordCall(graph, { id: 'CA10', from: '+15557778888', to: '+15551230002', at: T0 + 7 * HOUR, duration: 60 }, { numbers })
      assert.equal(retried.duplicate, false)
      assert.equal((await graph.attribute(retried.subject, { at: T0 + 8 * HOUR })).touches.length, 1)
      // A reviewer kept this caller and this visitor apart. The caller ringing after another tap is filed under the number, not given to the visitor.
      await graph.observe({ subject: 'visitor:s', identifiers: ['device:s', dialed('+15551230002', T0 + 9 * HOUR)], at: T0 + 9 * HOUR, event: 'phone_click' })
      const before = await recordCall(graph, { id: 'CA11', from: '+15550100011', to: '+15551230002', at: T0 + 9 * HOUR + 5000, duration: 60 }, { numbers })
      assert.equal(before.visitor, 'visitor:s')
      await graph.separate(before.subject, 'visitor:s')
      await graph.observe({ subject: 'visitor:s', identifiers: ['device:s', dialed('+15551230002', T0 + 10 * HOUR)], at: T0 + 10 * HOUR, event: 'phone_click' })
      const apart = await recordCall(graph, { id: 'CA12', from: '+15550100011', to: '+15551230002', at: T0 + 10 * HOUR + 5000, duration: 60 }, { numbers })
      assert.equal(apart.visitor, undefined)
      assert.equal((await graph.attribute(apart.subject, { at: T0 + 10 * HOUR + 6000 })).credited!.campaign, 'postcard')
      // One tracking number written wrong does not stop calls to the others.
      const mistyped = await recordCall(graph, { id: 'CA13', from: '+15550100013', to: '+15551230002', at: T0 + 11 * HOUR, duration: 60 }, { numbers: { 'not a number': { source: 'x' }, ...numbers } })
      assert.equal((await graph.attribute(mistyped.subject, { at: T0 + 11 * HOUR })).credited!.campaign, 'postcard')
    })

    test('a caller who waits in a queue and hangs up is not an answered call', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const options = { results: 'expected' as const, now: () => clock.now, numbers: { '+15550100001': { source: 'google', campaignId: '111' } } }
      const call = (id: string, more: object = {}) => ({ id, from: '+15550100099', to: '+15550100001', at: T0, duration: 45, ...more })
      const count = async () => (await graph.report({ from: '2023-11-14', to: '2023-11-14' })).total
      // The phone system picked up, and the caller listened to music for 45 seconds. Nothing says a person spoke, so nothing is counted.
      const waiting = await recordCall(graph, call('Q1'), options)
      assert.deepEqual([waiting.state, waiting.counted], ['waiting', false])
      assert.deepEqual((await count()).stages, {})
      // Past the wait it reads as unknown, and is still not counted. A result settles it even then.
      clock.now = T0 + 45_000 + 30 * 60_000
      assert.equal(callState((await graph.keptCall('Q1'))!, clock.now - 1, options), 'waiting')
      assert.equal(callState((await graph.keptCall('Q1'))!, clock.now, options), 'unknown')
      assert.deepEqual(await recordCallResult(graph, { id: 'Q1', answered: false, waited: 45 }, options), { state: 'missed', counted: false })
      const missed = await count()
      assert.deepEqual([missed.stages, missed.missed], [{}, 1])
      const [waiting1] = await graph.openCalls({ from: '2023-11-14', to: '2023-11-14' })
      assert.deepEqual([waiting1!.call.id, waiting1!.touch!.campaignId, waiting1!.followUp.attempts], ['Q1', '111', 0])
      assert.deepEqual((await graph.callSummary({ from: '2023-11-14', to: '2023-11-14' })).coverage, { visitor: 0, channel: 1, neither: 0, noResult: 0 })
      // It is filed under the number it rang, like any call: missed, credited, and never an outcome.
      assert.deepEqual((await graph.report({ from: '2023-11-14', to: '2023-11-14' })).rows.map((row) => [row.source, row.campaignId, row.missed, row.outcomes]), [['google', '111', 1, 0]])

      // A result may come before its call, and come again: it is taken once.
      assert.equal(await recordCallResult(graph, { id: 'Q2', answered: true, waited: 8 }, options), undefined)
      const answered = await recordCall(graph, call('Q2', { at: T0 + 1000, duration: 120 }), options)
      assert.deepEqual([answered.state, answered.counted], ['answered', true])
      for (let i = 0; i < 2; i++) assert.deepEqual(await recordCallResult(graph, { id: 'Q2', answered: true, waited: 8 }, options), { state: 'answered', counted: true })
      assert.deepEqual(counts((await count()).stages), { call: { count: 1, value: 0 } })
      // How long the caller waited may be known when nothing says whether they were answered. It is kept, and it answers nothing.
      const waited = await recordCall(graph, call('Q3', { at: T0 + 2000, waited: 20 }), options)
      assert.deepEqual([waited.state, waited.counted, (await graph.callResult('Q3'))!.waited], ['waiting', false, 20])
      assert.deepEqual(await recordCallResult(graph, { id: 'Q3', answered: false }, options), { state: 'missed', counted: false })
      assert.equal((await graph.callResult('Q3'))!.waited, 20)
      const mail = await recordCall(graph, call('Q4', { at: T0 + 3000, duration: 60, answered: false, voicemail: true }), options)
      assert.deepEqual([mail.state, mail.counted], ['voicemail', false])
      // A report of the call that carries a result settles it as well.
      await recordCall(graph, call('Q5', { at: T0 + 4000 }), options)
      const again = await recordCall(graph, call('Q5', { at: T0 + 4000, answered: true }), options)
      assert.deepEqual([again.duplicate, again.state, again.counted], [true, 'answered', true])
      assert.equal((await count()).stages.call!.count, 2)

      // With no results expected, a call counts by its length as ever. A result that says otherwise takes it back, and may give it back.
      const plain = await recordCall(graph, call('P1', { at: T0 + 5000 }), { now: () => clock.now })
      assert.deepEqual([plain.state, plain.counted], ['unknown', true])
      assert.deepEqual(await recordCallResult(graph, { id: 'P1', answered: false }, { now: () => clock.now }), { state: 'missed', counted: false })
      assert.deepEqual([(await count()).stages.call!.count, (await count()).missed], [2, 4])
      assert.equal((await recordCallResult(graph, { id: 'P1', answered: true }))!.counted, true)
      assert.deepEqual([(await count()).stages.call!.count, (await count()).missed], [3, 3])

      // A result and its call arriving at once, in both orders: however they cross, the call ends up counted once.
      await Promise.all(Array.from({ length: 12 }, (_, i) => [() => recordCall(graph, call(`R${i}`, { at: T0 + 6000 + i, from: `+155501001${String(i).padStart(2, '0')}` }), options), () => recordCallResult(graph, { id: `R${i}`, answered: i % 2 === 0 }, options)]).flat().map((each) => each()))
      for (let i = 0; i < 12; i++) assert.equal(Boolean(await graph.outcomeOf(`call:R${i}`)), i % 2 === 0, `R${i}`)

      for (const bad of [{ id: 'X', answered: 'yes' }, { id: 'X' }, { id: 'bad id', answered: true }, { id: 'X', answered: true, voicemail: true }, { id: 'X', answered: false, waited: -1 }]) await assert.rejects(recordCallResult(graph, bad as never, options), TypeError)
      assert.equal(await graph.callResult('X'), undefined)

      // Forgetting the caller deletes their calls and results. Forgetting a visitor leaves the call without them.
      await graph.observe({ subject: 'visitor:t', identifiers: ['device:t', dialed('+15550100001', T0 + DAY)], at: T0 + DAY, event: 'phone_click' })
      const tapped = await recordCall(graph, call('V1', { at: T0 + DAY + 5000, from: '+15550100050', answered: false }), options)
      assert.equal((await graph.keptCall('V1'))!.visitor, 'visitor:t')
      await graph.forget('visitor:t')
      assert.equal('visitor' in (await graph.keptCall('V1'))!, false)
      await graph.forget(tapped.subject)
      assert.deepEqual([await graph.keptCall('V1'), await graph.callResult('V1')], [undefined, undefined])
      // Pruning deletes results whose call never came, and keeps the rest.
      await recordCallResult(graph, { id: 'never', answered: true }, options)
      clock.now += DAY
      await graph.prune(clock.now)
      assert.deepEqual([await graph.callResult('never'), (await graph.callResult('Q1'))!.answered], [undefined, false])
    })

    test('a missed call is returned where one of your own systems says the caller was reached', async () => {
      const clock = { now: T0 + 10 * HOUR }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const now = () => clock.now
      const from = '+15550100081'
      const miss = (id: string, at: number, who = from) => recordCall(graph, { id, from: who, to: '+15550100001', at, duration: 20, answered: false }, { results: 'expected', now })
      const became = async (id: string) => followUp((await graph.keptCall(id))!, await graph.callsOf([(await graph.keptCall(id))!.subject]))
      const open = async () => (await graph.openCalls({ from: '2023-11-14', to: '2023-11-15' })).map((each) => each.call.id)
      await miss('M1', T0)
      await miss('M2', T0 + HOUR)
      await miss('M3', T0 + 5 * HOUR)
      await recordCall(graph, { id: 'O1', direction: 'outbound', from: '+15550100001', to: from, at: T0 + 2 * HOUR, answered: false }, { now })
      assert.deepEqual(await open(), ['M1', 'M2', 'M3'])
      // Reached at three hours: that closes the misses before, and not the one after.
      assert.deepEqual(await recordReturn(graph, { id: 'M1', at: T0 + 3 * HOUR }, { now }), { state: 'returned', by: 'M1', delay: 3 * HOUR, reported: true, attempts: 1 })
      assert.deepEqual(await became('M2'), { state: 'returned', by: 'M1', delay: 2 * HOUR, reported: true, attempts: 1 })
      assert.deepEqual([(await became('M3')).state, await open()], ['open', ['M3']])
      const summary = async () => (await graph.callSummary({ from: '2023-11-14', to: '2023-11-15', at: clock.now, results: 'expected' })).total
      assert.deepEqual([(await summary()).returned, (await summary()).reported, (await summary()).missed], [2, 2, 3])
      // A call that did reach them first is what closed it, and the report adds nothing.
      await recordCall(graph, { id: 'O2', direction: 'outbound', from: '+15550100001', to: from, at: T0 + 2 * HOUR + 1, answered: true }, { now })
      assert.deepEqual(await became('M2'), { state: 'returned', by: 'O2', delay: HOUR + 1, attempts: 1 })
      assert.deepEqual([(await summary()).returned, (await summary()).reported], [2, 0])
      // Reported again the last time stands, and taken back it is open again. How the call went is kept through both.
      await recordReturn(graph, { id: 'M3', at: T0 + 6 * HOUR }, { now })
      assert.equal((await recordReturn(graph, { id: 'M3', at: T0 + 7 * HOUR }, { now }))!.delay, 2 * HOUR)
      await recordCallResult(graph, { id: 'M3', answered: false, waited: 12 }, { now })
      const kept = (await graph.keptCall('M3'))!.result!
      assert.deepEqual([kept.answered, kept.waited, kept.returned], [false, 12, T0 + 7 * HOUR])
      assert.equal((await recordReturn(graph, { id: 'M3', returned: false }, { now }))!.state, 'open')
      assert.deepEqual(await open(), ['M3'])
      // Left unsaid, it was now. Said before the call is known, it waits for it.
      assert.equal((await recordReturn(graph, { id: 'M3' }, { now }))!.delay, 5 * HOUR)
      assert.equal(await recordReturn(graph, { id: 'M4', at: T0 + 9 * HOUR }, { now }), undefined)
      await miss('M4', T0 + 8 * HOUR, '+15550100082')
      assert.deepEqual((await became('M4')).reported, true)
      // Taken back before it is known, nothing is left of it.
      await recordReturn(graph, { id: 'M5', at: T0 + 9 * HOUR }, { now })
      await recordReturn(graph, { id: 'M5', returned: false }, { now })
      assert.equal(await graph.callResult('M5'), undefined)
      // Taking it back needs no time, right or wrong.
      await recordReturn(graph, { id: 'M5', at: 1.5, returned: false }, { now })
      // A caller who hid their number can be reached too, and is nobody else.
      await miss('H1', T0, '')
      assert.equal((await became('H1')).state, 'hidden')
      assert.deepEqual((await recordReturn(graph, { id: 'H1', at: T0 + HOUR }, { now }))!.state, 'returned')
      // Said before its call is known, it counts only once the call turns out to be a miss that began before.
      const other = '+15550100084'
      await miss('E1', T0, other)
      await recordReturn(graph, { id: 'E2', at: T0 + HOUR }, { now })
      await recordReturn(graph, { id: 'E3', at: T0 + HOUR }, { now })
      await recordReturn(graph, { id: 'E4', at: T0 + HOUR }, { now })
      await recordCall(graph, { id: 'E2', from: other, to: '+15550100001', at: T0 + 100, duration: 60 }, { results: 'expected', now })
      await recordCall(graph, { id: 'E3', direction: 'outbound', from: '+15550100001', to: other, at: T0 + 200, answered: false }, { now })
      await miss('E4', T0 + 2 * HOUR, other)
      assert.deepEqual([(await became('E1')).state, (await open()).includes('E1')], ['open', true])
      await recordCallResult(graph, { id: 'E2', answered: false }, { now })
      assert.deepEqual([(await became('E1')).reported, (await open()).includes('E1'), (await became('E4')).state], [true, false, 'open'])
      // A call back that began first and connected after they were reached is not what reached them.
      await recordCall(graph, { id: 'E5', direction: 'outbound', from: '+15550100001', to: other, at: T0 + HOUR - 60_000, answered: true, waited: 120 }, { now })
      assert.equal((await became('E1')).reported, true)
      await recordCall(graph, { id: 'E6', direction: 'outbound', from: '+15550100001', to: other, at: T0 + HOUR - 50_000, answered: true, waited: 20 }, { now })
      assert.equal((await became('E1')).by, 'E6')
      // Another caller's is not touched, and an answered call was not missed.
      await recordCall(graph, { id: 'A1', from: '+15550100083', to: '+15550100001', at: T0, duration: 60, answered: true }, { now })
      assert.equal(await recordReturn(graph, { id: 'A1', at: T0 + HOUR }, { now }), undefined)
      for (const bad of [{ id: 'M1', at: T0 }, { id: 'M1', at: clock.now + 1 }, { id: 'M1', at: 1.5 }, { id: '' }, { id: 'O1' }, { id: 'M1', returned: 'yes' }]) await assert.rejects(recordReturn(graph, bad as never, { now }), TypeError)
      await graph.forget(`caller:${hashPhone(from)}`)
      assert.equal(await graph.callResult('M1'), undefined)
    })

    test('a missed call is returned by ringing back, or closed by the caller getting through', async () => {
      const { graph } = await fresh(undefined, { now: () => T0 + 40 * HOUR })
      const options = { results: 'expected' as const, now: () => T0 + 40 * HOUR }
      const inbound = (id: string, hours: number, answered?: boolean, from = '+15550100041') => recordCall(graph, { id, from, to: '+15550100001', at: T0 + hours * HOUR, duration: 60, ...(answered !== undefined && { answered }) }, options)
      const outbound = (id: string, hours: number, answered?: boolean, to = '+15550100041') => recordCall(graph, { id, direction: 'outbound', from: '+15550100001', to, at: T0 + hours * HOUR, duration: 20, ...(answered !== undefined && { answered }) }, options)
      const became = async (id: string) => {
        const miss = (await graph.keptCall(id))!
        return followUp(miss, await graph.callsOf([miss.subject]))
      }
      // Rung before the miss: it says nothing about it, even when reported after. Rung twice with no answer, then answered.
      await inbound('M1', 10, false)
      await outbound('O0', 9, true)
      assert.deepEqual(await became('M1'), { state: 'open', attempts: 0 })
      const tried = await outbound('O1', 11, false)
      assert.deepEqual([tried.counted, tried.state, tried.flags], [false, 'missed', []])
      await outbound('O2', 12)
      assert.deepEqual(await became('M1'), { state: 'open', attempts: 2 })
      await outbound('O3', 14, true)
      assert.deepEqual(await became('M1'), { state: 'returned', by: 'O3', delay: 4 * HOUR, attempts: 2 })
      // An outbound call is settled by its result too, and is never an outcome.
      assert.deepEqual(await recordCallResult(graph, { id: 'O2', answered: true }, options), { state: 'answered', counted: false })
      assert.deepEqual(await became('M1'), { state: 'returned', by: 'O2', delay: 2 * HOUR, attempts: 1 })
      assert.deepEqual([await graph.outcomeOf('call:O2'), await graph.outcomeOf('call:O3')], [undefined, undefined])

      // Missed twice more, then the caller gets through: one answer closes every miss before it.
      await inbound('M2', 20, false)
      await inbound('M3', 21, false)
      await inbound('A1', 23, true)
      assert.deepEqual(await became('M2'), { state: 'called again', by: 'A1', delay: 3 * HOUR, attempts: 0 })
      assert.deepEqual(await became('M3'), { state: 'called again', by: 'A1', delay: 2 * HOUR, attempts: 0 })
      // Ringing in and missing again is not getting through, and somebody else answering is nothing to this caller.
      await inbound('M4', 30, false)
      await inbound('M5', 31, false)
      await outbound('O9', 32, true, '+15550100042')
      assert.equal((await became('M4')).state, 'open')
      // A hidden caller cannot be rung back.
      await recordCall(graph, { id: 'H1', to: '+15550100001', at: T0 + 5 * HOUR, duration: 9, answered: false }, options)
      assert.deepEqual(await became('H1'), { state: 'hidden', attempts: 0 })

      // What is still open, oldest first, a page at a time, and the same as asking of each miss.
      const days = { from: '2023-11-14', to: '2023-11-17' }
      const open = await graph.openCalls(days)
      assert.deepEqual(open.map((each) => [each.call.id, each.followUp.state]), [['M4', 'open'], ['M5', 'open']])
      const [first] = await graph.openCalls({ ...days, limit: 1 })
      assert.deepEqual((await graph.openCalls({ ...days, limit: 1, after: first!.call })).map((each) => each.call.id), ['M5'])
      assert.deepEqual(await graph.openCalls({ from: '2023-11-14', to: '2023-11-14' }), [])
      const summary = await graph.callSummary({ ...days, results: 'expected' })
      assert.deepEqual([summary.total.calls, summary.total.missed, summary.total.returned, summary.total.calledAgain, summary.total.hidden, summary.returnedWithin], [7, 6, 1, 2, 1, 2 * HOUR])

      // Ringing someone records nothing about who they are, and is not a missed call in the report.
      assert.deepEqual([await graph.cluster(`caller:${hashPhone('+15550100042')}`), (await graph.counts()).touches], [undefined, 0])
      assert.equal((await graph.report({ from: '2023-11-14', to: '2023-11-17' })).total.missed, 6)
      // Reported twice it is kept once, and an id cannot be both.
      assert.equal((await outbound('O1', 11, false)).duplicate, true)
      await assert.rejects(inbound('O1', 11), TypeError)
      await assert.rejects(outbound('M1', 10), TypeError)
      await assert.rejects(recordCall(graph, { id: 'O10', direction: 'outbound', to: '+15550100041', at: T0 }, options), TypeError)
      await assert.rejects(recordCall(graph, { id: 'O10', direction: 'outbound', from: 'nope', to: '+15550100041', at: T0, answered: true }, options), TypeError)
      assert.equal(await graph.callResult('O10'), undefined)
      await assert.rejects(recordCall(graph, { id: 'O10', direction: 'sideways' as 'inbound', to: '+15550100041', at: T0 }, options), TypeError)
      // Forgetting the caller deletes the calls you placed to them.
      await graph.forget(`caller:${hashPhone('+15550100042')}`)
      assert.equal(await graph.keptCall('O9'), undefined)
    })

    test('the report counts people beside outcomes, and says how long each step takes', async () => {
      const NOW = Date.parse('2026-03-31T12:00:00Z')
      const { graph } = await fresh(undefined, { now: () => NOW })
      const visit = (n: number, daysAgo: number) => graph.touch({ subject: `visitor:${n}`, at: NOW - daysAgo * DAY, gclid: `G${n}`, campaignId: '111' })
      const sale = (id: string, subject: string, daysAgo: number, stage = 'sale') => graph.outcome({ transactionId: id, subject, at: NOW - daysAgo * DAY, stage, value: 10 })
      // One person under two accounts and a renewal: three sales, one person.
      await graph.observe([{ subject: 'visitor:1', identifiers: ['device:1'], at: T0 }, { subject: 'account:1', identifiers: ['device:1', 'email:a'], at: T0 }, { subject: 'account:1b', identifiers: ['email:a'], at: T0 }])
      await visit(1, 12)
      await sale('a', 'account:1', 10)
      await sale('b', 'account:1b', 9)
      await sale('c', 'account:1', 2, 'renewal')
      // Someone else, whose newest arrival is 100 days before their sale: outside the window, so credited to nothing and still counted as late.
      await graph.observe([{ subject: 'visitor:2', identifiers: ['device:2'], at: T0 }, { subject: 'account:2', identifiers: ['device:2'], at: T0 }])
      await visit(2, 105)
      await sale('d', 'account:2', 5)
      // And one with no arrival at all, who is not in the cluster of anyone.
      await sale('e', 'account:3', 5)
      const report = await graph.report({ from: '2026-03-01', to: '2026-03-31' })
      const google = report.rows.find((row) => row.campaignId === '111')!
      assert.deepEqual([google.outcomes, google.people, google.stages.sale!.count, google.stages.sale!.people], [3, 1, 2, 1])
      assert.deepEqual([report.total.outcomes, report.total.people, report.total.stages.sale!.people], [5, 3, 3])
      // Two and three days after the arrival, and a hundred: the step takes a median of three, and two in three came inside the window.
      assert.deepEqual(report.total.stages.sale!.delay, { count: 3, median: 3, p95: 100, inside: 0.666667 })
      assert.deepEqual(google.stages.sale!.delay, { count: 2, median: 2.5, p95: 3, inside: 1 })
      // Keep the two accounts apart and they are two people again.
      await graph.separate('account:1', 'account:1b')
      assert.equal((await graph.report({ from: '2026-03-01', to: '2026-03-31' })).total.stages.sale!.people, 4)
      // Three say too little of how long a step takes to call anything too recent.
      assert.equal('incomplete' in report, false)
      for (let n = 0; n < 20; n++) {
        await graph.observe({ subject: `visitor:f${n}`, identifiers: [`device:f${n}`], at: T0 })
        await graph.touch({ subject: `visitor:f${n}`, at: NOW - 20 * DAY, gclid: 'F', campaignId: '222' })
        await sale(`f${n}`, `visitor:f${n}`, 20 - (n < 19 ? 4 : 6.5), 'signup')
      }
      const filling = async (from: string, to: string) => (await graph.report({ from, to })).incomplete
      // 95 in 100 sign-ups come within four days, so arrivals of the last four have not had theirs.
      assert.deepEqual(await filling('2026-03-12', '2026-03-30'), { after: '2026-03-27', days: 4 })
      assert.equal(await filling('2026-03-12', '2026-03-27'), undefined)
      // Asked about a day with an arrival and no outcomes yet, it still says so: that is the day it is for.
      await graph.touch({ subject: 'visitor:late', at: NOW - DAY, gclid: 'L', campaignId: '222' })
      assert.equal((await graph.report({ from: '2026-03-30', to: '2026-03-30' })).total.visits, 1)
      assert.deepEqual(await filling('2026-03-30', '2026-03-30'), { after: '2026-03-27', days: 4 })
      // Hundreds of a step that comes at once do not hide the slower one.
      for (let n = 0; n < 520; n++) await graph.outcome({ transactionId: `tap${n}`, subject: 'visitor:late', at: NOW - DAY + 1000 + n, stage: 'tap' })
      assert.deepEqual(await filling('2026-03-30', '2026-03-30'), { after: '2026-03-27', days: 4 })
    })

    test('every value an outcome has had is kept, and the report says what it was first and what it is now', async () => {
      const clock = { now: Date.parse('2026-02-27T12:00:00Z') }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const day = (text: string) => Date.parse(`${text}T12:00:00Z`)
      await graph.touch({ subject: 'lead:1', at: day('2026-02-26'), gclid: 'G', campaignId: '111' })
      const sale = (n: number, subject: string, value: number) => graph.outcome({ transactionId: `s${n}`, subject, at: clock.now, stage: 'client', value, currency: 'USD' })
      const read = async (id: string) => (await graph.values(id)).map((each) => [each.value, each.currency, new Date(each.at).toISOString().slice(0, 10)])
      await sale(1, 'lead:1', 200)
      await sale(2, 'lead:1', 200)
      await sale(3, 'lead:2', 100)
      clock.now = day('2026-03-02')
      await sale(4, 'lead:1', 200)
      // The collected amount comes in later, in parts; one paid nothing, one paid what was expected.
      await graph.restate('s1', 350)
      await graph.restate('s2', 0)
      clock.now = day('2026-03-20')
      await graph.restate('s1', 420.5, 'CAD')
      await graph.restate('s4', 200)
      assert.deepEqual(await read('s1'), [[200, 'USD', '2026-02-27'], [350, 'USD', '2026-03-02'], [420.5, 'CAD', '2026-03-20']])
      assert.deepEqual(await read('s4'), [[200, 'USD', '2026-03-02']])
      assert.deepEqual(await graph.values('nobody'), [])
      const report = await graph.report({ from: '2026-02-01', to: '2026-03-31' })
      const line = report.rows.find((row) => row.campaignId === '111')!
      assert.deepEqual(line.valueChange, { outcomes: 3, first: 600, now: 620.5, refunded: 0, writtenOff: 0, zeroed: 1, firstUnknown: 0 })
      assert.equal(line.value, line.valueChange.now)
      assert.deepEqual(report.total.valueChange, { outcomes: 4, first: 700, now: 720.5, refunded: 0, writtenOff: 0, zeroed: 1, firstUnknown: 0 })
      assert.deepEqual(report.months, [
        { month: '2026-02', outcomes: 3, first: 500, now: 520.5, refunded: 0, writtenOff: 0, zeroed: 1, firstUnknown: 0 },
        { month: '2026-03', outcomes: 1, first: 200, now: 200, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 },
      ])
      // Taken out of the report and back, it goes on from the value it had.
      await graph.withdraw('s4')
      assert.equal((await graph.report({ from: '2026-02-01', to: '2026-03-31' })).total.valueChange.outcomes, 3)
      await graph.outcome({ transactionId: 's4', subject: 'lead:1', at: day('2026-03-02'), stage: 'client', value: 200, currency: 'USD' })
      assert.equal((await read('s4')).length, 1)
      // Pruning leaves values alone; forgetting the person deletes theirs, also of an outcome no longer in the report.
      // The same id used again for someone else starts a history of its own, and each is forgotten with its subject.
      await graph.withdraw('s3')
      await graph.outcome({ transactionId: 's3', subject: 'lead:9', at: clock.now, stage: 'client', value: 7, currency: 'USD' })
      assert.deepEqual(await read('s3'), [[7, 'USD', '2026-03-20']])
      await graph.forget('lead:9')
      assert.deepEqual(await read('s3'), [])
      await graph.outcome({ transactionId: 's3', subject: 'lead:2', at: clock.now, stage: 'client', value: 100, currency: 'USD' })
      // Recorded at nothing, raised, and back at nothing: restated to zero, whatever it was at first.
      await graph.outcome({ transactionId: 's5', subject: 'lead:2', at: day('2026-03-20'), stage: 'client', value: 0, currency: 'USD' })
      await graph.outcome({ transactionId: 's6', subject: 'lead:2', at: day('2026-03-20'), stage: 'client', value: 0, currency: 'USD' })
      await graph.restate('s5', 90)
      await graph.restate('s5', 0)
      assert.equal((await graph.report({ from: '2026-03-20', to: '2026-03-20' })).total.valueChange.zeroed, 1)
      assert.deepEqual((await graph.report({ from: '2026-02-01', to: '2026-03-31' })).currencies, ['CAD', 'USD'])
      await graph.withdraw('s2')
      await graph.prune(clock.now + DAY)
      assert.equal((await read('s1')).length, 3)
      await graph.forget('lead:1')
      assert.deepEqual([await read('s1'), await read('s2'), (await read('s3')).length], [[], [], 1])
    })

    test('what a platform says it brought stands beside what is credited to it', async () => {
      const { graph } = await fresh(undefined, { now: () => Date.parse('2026-03-04T12:00:00Z') })
      const at = (day: string) => Date.parse(`${day}T10:00:00Z`)
      await graph.touch({ subject: 'lead:1', at: at('2026-03-01'), gclid: 'G', campaignId: '111' })
      await graph.touch({ subject: 'lead:2', at: at('2026-03-01'), fbclid: 'F', campaignId: '777' })
      for (const [n, day, stage] of [[1, '2026-03-01', 'inquiry'], [2, '2026-03-02', 'client'], [3, '2026-03-03', 'client']] as const) await graph.outcome({ transactionId: `t${n}`, subject: 'lead:1', at: at(day), stage, value: 100, currency: 'USD' })
      await graph.outcome({ transactionId: 't4', subject: 'lead:2', at: at('2026-03-01'), stage: 'client', value: 50, currency: 'USD' })
      const read = async (options: object = {}) => (await graph.report({ from: '2026-03-01', to: '2026-03-09', ...options }))
      const of = (report: Awaited<ReturnType<typeof read>>, id: string) => report.rows.find((row) => row.campaignId === id)!.reported
      await graph.spend({ day: '2026-03-01', source: 'google', campaignId: '111', amount: 10, currency: 'USD' })
      const before = await read()
      assert.deepEqual([of(before, '111'), before.total.reported], [undefined, undefined])
      // The third of March is a day the platform said nothing about, so what was credited then is not set beside it.
      await graph.spend([
        { day: '2026-03-01', source: 'google', campaignId: '111', amount: 10, currency: 'USD', conversions: 2.5, conversionValue: 250.1 },
        { day: '2026-03-02', source: 'google', campaignId: '111', amount: 10, currency: 'USD', conversions: 0 },
        { day: '2026-03-03', source: 'google', campaignId: '111', amount: 10, currency: 'USD' },
        { day: '2026-03-01', source: 'meta', campaignId: '777', amount: 5, currency: 'USD', conversions: 1 },
        { day: '2026-03-08', source: 'meta', campaignId: '777', amount: 5, currency: 'USD', conversions: 70 },
      ])
      const after = await read()
      assert.deepEqual(of(after, '111'), { days: 2, conversions: 2.5, value: 250.1, credited: 2, creditedValue: 200 })
      assert.deepEqual(of(after, '777'), { days: 1, conversions: 1, value: null, credited: 1, creditedValue: 50 })
      assert.deepEqual(after.total.reported, { days: 2, conversions: 3.5, value: null, credited: 3, creditedValue: 250 })
      assert.equal(after.total.outcomes, 4)
      const clients = await read({ per: 'client' })
      assert.deepEqual([of(clients, '111')!.credited, of(clients, '111')!.creditedValue, clients.total.reported!.credited], [1, 100, 2])
      // A value may be below nothing, where the platform took back more than it added.
      await graph.spend({ day: '2026-03-01', source: 'meta', campaignId: '777', amount: 5, conversions: 0, conversionValue: -20 })
      assert.deepEqual(of(await read(), '777'), { days: 1, conversions: 0, value: -20, credited: 1, creditedValue: 50 })
      // A row sent again replaces all of the one before, and one that says nothing of conversions takes them out.
      await graph.spend({ day: '2026-03-01', source: 'meta', campaignId: '777', amount: 5, conversions: 1, conversionValue: 0 })
      assert.equal(of(await read(), '777')!.value, 0)
      await graph.spend({ day: '2026-03-01', source: 'meta', campaignId: '777', amount: 5 })
      assert.equal(of(await read(), '777'), undefined)
      for (const bad of [{ conversions: -1 }, { conversions: Number.NaN }, { conversions: '2' }, { conversionValue: 5 }, { conversions: 1, conversionValue: Infinity }]) await assert.rejects(graph.spend({ day: '2026-03-01', source: 'google', amount: 1, ...bad } as never), TypeError)
    })

    test('what was refunded and written off is counted apart from what was corrected', async () => {
      const clock = { now: Date.parse('2026-03-02T12:00:00Z') }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      await graph.touch({ subject: 'lead:1', at: clock.now - HOUR, gclid: 'G', campaignId: '111' })
      for (const [id, subject] of [['s1', 'lead:1'], ['s2', 'lead:1'], ['s3', 'lead:2']] as const) await graph.outcome({ transactionId: id, subject, at: clock.now, stage: 'client', value: 200, currency: 'USD' })
      const worth = async () => (await graph.report({ from: '2026-03-02', to: '2026-03-02' })).total.valueChange
      // What was collected, then some given back, twice, and the rest never paid.
      await graph.restate('s1', 350)
      await graph.restate('s1', 300, undefined, 'refund')
      await graph.restate('s1', 299.9, 'USD', 'refund')
      await graph.restate('s1', 100, 'USD', 'write_off')
      await graph.restate('s2', 0, undefined, 'refund')
      await graph.restate('s3', 150)
      assert.deepEqual((await graph.values('s1')).map((each) => [each.value, each.kind]), [[200, undefined], [350, undefined], [300, 'refund'], [299.9, 'refund'], [100, 'write_off']])
      assert.deepEqual(await worth(), { outcomes: 3, first: 600, now: 250, refunded: 250.1, writtenOff: 199.9, zeroed: 1, firstUnknown: 0 })
      const report = await graph.report({ from: '2026-03-02', to: '2026-03-02' })
      assert.deepEqual(report.rows.find((row) => row.campaignId === '111')!.valueChange, { outcomes: 2, first: 400, now: 100, refunded: 250.1, writtenOff: 199.9, zeroed: 1, firstUnknown: 0 })
      assert.deepEqual(report.months.map((each) => [each.month, each.refunded, each.writtenOff]), [['2026-03', 250.1, 199.9]])
      // Said again, it counts once. A journey says why.
      await graph.restate('s2', 0, undefined, 'refund')
      assert.equal((await worth()).refunded, 250.1)
      assert.deepEqual((await graph.journey('lead:1')).entries.flatMap((entry) => (entry.kind === 'value' && entry.transactionId === 's2' ? [entry.to.kind] : [])), ['refund'])
      // One said by mistake is taken back, and no more than was said: the rest was no refund.
      await assert.rejects(graph.restate('s3', 160, undefined, 'refund'), /cannot reverse more than was refunded/)
      await assert.rejects(graph.restate('s1', 301, undefined, 'write_off'), /cannot reverse more than was written off/)
      await assert.rejects(graph.restate('s3', 100, 'CAD', 'refund'), /currency/)
      await assert.rejects(graph.restate('s3', 100, undefined, 'gift' as never), /`refund` or `write_off`/)
      assert.equal((await graph.values('s3')).at(-1)!.value, 150)
      await graph.restate('s1', 299.9, undefined, 'write_off')
      await graph.restate('s2', 200, undefined, 'refund')
      assert.deepEqual(await worth(), { outcomes: 3, first: 600, now: 649.9, refunded: 50.1, writtenOff: 0, zeroed: 0, firstUnknown: 0 })
      // However large, all of it can be taken back, and no more.
      await graph.outcome({ transactionId: 'large', subject: 'lead:2', at: clock.now - 90 * DAY, stage: 'client', value: 100_000_000, currency: 'USD' })
      await graph.restate('large', 99_999_999.9, undefined, 'refund')
      await graph.restate('large', 1)
      await assert.rejects(graph.restate('large', 1.1001, undefined, 'refund'), /cannot reverse more than was refunded/)
      assert.equal(await graph.restate('large', 1.1, undefined, 'refund'), true)
      await assert.rejects(graph.restate('large', 1.2, undefined, 'refund'), /cannot reverse more than was refunded/)
      await graph.withdraw('large')
      // What it was corrected from has no part in how much may be taken back.
      await graph.outcome({ transactionId: 'typo', subject: 'lead:2', at: clock.now - 90 * DAY, stage: 'client', value: 1e16, currency: 'USD' })
      await graph.restate('typo', 10)
      await graph.restate('typo', 9, undefined, 'refund')
      await assert.rejects(graph.restate('typo', 11, undefined, 'refund'), /cannot reverse more than was refunded/)
      assert.equal(await graph.restate('typo', 10, undefined, 'refund'), true)
      await graph.withdraw('typo')
      // Many small ones after a large one round down as they are added, and still come back in full.
      await graph.outcome({ transactionId: 'many', subject: 'lead:2', at: clock.now - 90 * DAY, stage: 'client', value: 1e8, currency: 'USD' })
      await graph.restate('many', 0, undefined, 'refund')
      for (let n = 0; n < 20; n++) {
        await graph.restate('many', 0.02)
        await graph.restate('many', 0, undefined, 'refund')
      }
      await assert.rejects(graph.restate('many', 100_000_000.41, undefined, 'refund'), /cannot reverse more than was refunded/)
      assert.equal(await graph.restate('many', 100_000_000.4, undefined, 'refund'), true)
      await graph.withdraw('many')
      // In another currency now, what was lost in the one before stays in the sum, and the report says which it adds up.
      // It cannot be taken back in the new one.
      await graph.restate('s1', 250, 'CAD')
      await graph.restate('s1', 240, undefined, 'refund')
      await assert.rejects(graph.restate('s1', 251, undefined, 'refund'), /cannot reverse more than was refunded/)
      await graph.restate('s1', 250, undefined, 'refund')
      await graph.restate('s1', 250, 'EUR')
      assert.equal((await worth()).refunded, 50.1)
      assert.deepEqual((await graph.report({ from: '2026-03-02', to: '2026-03-02' })).currencies, ['CAD', 'EUR', 'USD'])
      assert.equal(await graph.restate('nobody', 1, undefined, 'refund'), false)
      // Forgotten with the rest of their values, and an outcome nobody changed has none.
      await graph.forget('lead:1')
      assert.deepEqual(await worth(), { outcomes: 1, first: 200, now: 150, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 })
    })

    test('the report is broken down by what an arrival said, what is known of an outcome, and when it happened', async () => {
      const { graph } = await fresh()
      const day = Date.parse('2026-03-02T15:00:00Z')
      const arrive = async (n: number, custom?: Record<string, string>) => {
        await graph.observe({ subject: `visitor:${n}`, identifiers: [`device:${n}`], at: day, event: 'visit' })
        await graph.touch({ subject: `visitor:${n}`, at: day, gclid: `G${n}`, campaignId: '111', ...(custom && { custom }) })
        await graph.observe({ subject: `contact:${n}`, identifiers: [`device:${n}`], at: day, event: 'enroll' })
      }
      // Two arrivals name the advertised office, one by the short name that fits in an ad's address. One says nothing.
      await arrive(1, { office: 'north', lang: 'es' })
      await arrive(2, { office_advertised: 'north' })
      await arrive(3)
      const enroll = (n: number, at: number, tags?: Record<string, string>) => graph.outcome({ transactionId: `e${n}`, subject: `contact:${n}`, at, stage: 'enrolled', value: 100 * n, ...(tags && { tags }) })
      await enroll(1, day + HOUR, { office_served: 'river', language: 'es' })
      await enroll(2, day + 2 * HOUR, { office_served: 'north' })
      await enroll(3, day + 20 * HOUR)
      await recordCall(graph, { id: 'M1', from: '+15550100061', to: '+15550100001', at: day, duration: 5, answered: false, tags: { language: 'es' } }, { numbers: { '+15550100001': { source: 'google', campaignId: '111', tags: { office_advertised: 'river', language: 'en' } } } })

      const split = async (by: string, timeZone?: string) => {
        const report = await graph.report({ from: '2026-03-02', to: '2026-03-03', by, ...(timeZone && { timeZone }) })
        // Whatever it is broken down by, the parts add up to the line, and the lines to the whole.
        for (const row of [...report.rows, report.total]) {
          const parts = row.breakdown!
          assert.deepEqual([parts.reduce((sum, part) => sum + part.outcomes, 0), parts.reduce((sum, part) => sum + part.value, 0), parts.reduce((sum, part) => sum + part.missed, 0)], [row.outcomes, row.value, row.missed], by)
          for (const [stage, { count }] of Object.entries(row.stages)) assert.equal(parts.reduce((sum, part) => sum + (part.stages[stage]?.count ?? 0), 0), count)
        }
        assert.equal(report.total.breakdown!.at(-1)!.name, '(not set)')
        return Object.fromEntries(report.total.breakdown!.map((part) => [part.name, [part.outcomes, part.value, part.missed]]))
      }
      // Where it was advertised and where the person was served are two things, and neither is guessed.
      assert.deepEqual(await split('touch.office_advertised'), { north: [2, 300, 0], river: [0, 0, 1], '(not set)': [1, 300, 0] })
      assert.deepEqual(await split('outcome.office_served'), { north: [1, 200, 0], river: [1, 100, 0], '(not set)': [1, 300, 1] })
      assert.deepEqual(await split('touch.language'), { en: [0, 0, 1], es: [1, 100, 0], '(not set)': [2, 500, 0] })
      assert.deepEqual(await split('outcome.language'), { es: [1, 100, 1], '(not set)': [2, 500, 0] })
      assert.deepEqual(await split('outcome.nobody_said'), { '(not set)': [3, 600, 1] })
      assert.deepEqual(await split('outcome.constructor'), { '(not set)': [3, 600, 1] })
      // Ten in the morning in New York, and the next morning.
      assert.deepEqual(await split('hour', 'America/New_York'), { '06': [1, 300, 0], '10': [0, 0, 1], '11': [1, 100, 0], '12': [1, 200, 0], '(not set)': [0, 0, 0] })
      assert.deepEqual(Object.keys(await split('weekday')), ['Mon', 'Tue', '(not set)'])
      const inOrder = (await graph.report({ from: '2026-03-02', to: '2026-03-03', by: 'hour', timeZone: 'America/New_York' })).total.breakdown!.map((part) => part.name)
      assert.deepEqual(inOrder, ['06', '10', '11', '12', '(not set)'])
      const report = await graph.report({ from: '2026-03-02', to: '2026-03-03' })
      assert.deepEqual(report.dimensions, ['hour', 'weekday', 'outcome.language', 'outcome.office_served', 'touch.language', 'touch.office_advertised'])
      assert.equal('breakdown' in report.rows[0]!, false)

      // A changed value keeps what is known of the outcome, and forgetting the person deletes it.
      await graph.restate('e1', 5)
      assert.deepEqual((await graph.outcomeOf('e1'))!.tags, { office_served: 'river', language: 'es' })
      await graph.forget('contact:1')
      assert.deepEqual(await split('outcome.office_served'), { north: [1, 200, 0], '(not set)': [1, 300, 1] })
      // An answered call carries its tags on to its outcome, also where the answer came later.
      await recordCall(graph, { id: 'A1', from: '+15550100062', to: '+15550100009', at: day, duration: 60, tags: { language: ' es ' } }, { results: 'expected' })
      await recordCallResult(graph, { id: 'A1', answered: true }, { results: 'expected' })
      assert.deepEqual((await graph.outcomeOf('call:A1'))!.tags, { language: 'es' })

      // A call you place carries its own, and makes no outcome of them. A number's are checked before anything is written.
      await recordCall(graph, { id: 'P1', direction: 'outbound', from: '+15550100009', to: '+15550100062', at: day, tags: { language: 'es' } })
      assert.deepEqual((await graph.keptCall('P1'))!.tags, { language: 'es' })
      await assert.rejects(recordCall(graph, { id: 'N1', from: '+15550100063', to: '+15550100008', at: day, duration: 60 }, { numbers: { '+15550100008': { source: 'x', tags: { Office: 'n' } } } }), TypeError)
      assert.equal(await graph.keptCall('N1'), undefined)
      await recordCall(graph, { id: 'N2', from: '+15550100064', to: '+15550100008', at: day, duration: 60 }, { numbers: { '+15550100008': { source: 'x', tags: { office_advertised: ' north ' } } } })
      assert.equal((await graph.report({ from: '2026-03-02', to: '2026-03-02', by: 'touch.office_advertised' })).rows.find((row) => row.source === 'x')!.breakdown![0]!.name, 'north')
      // An arrival that says it is not recorded is one that says nothing.
      await graph.touch({ subject: 'visitor:8', at: day, gclid: 'G8', custom: { office: ' (not set) ' } })
      await assert.rejects(graph.touch({ subject: 'visitor:8', at: day + 1, gclid: 'G8', custom: { office: null as unknown as string } }), TypeError)
      await graph.outcome({ transactionId: 'e8', subject: 'visitor:8', at: day + HOUR, stage: 'enrolled' })
      assert.equal((await graph.report({ from: '2026-03-02', to: '2026-03-03', by: 'touch.office_advertised' })).total.breakdown!.filter((part) => part.name.includes('not set')).length, 1)
      // A parameter that cannot be asked for is not offered.
      await graph.touch({ subject: 'visitor:9', at: day, gclid: 'G9', custom: { 'two words': 'x' } })
      assert.ok((await graph.report({ from: '2026-03-02', to: '2026-03-02' })).dimensions.every((each) => !each.includes(' ')))

      const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tag_${'abcdefghi'[i]}`, 'x']))
      for (const tags of [nine, { Office: 'x' }, { office: '' }, { office: 'x'.repeat(65) }, { office: 5 }, { office: '(not set)' }, ['x'], 'x']) await assert.rejects(graph.outcome({ transactionId: 'bad', subject: 'contact:1', at: day, tags: tags as never }), TypeError)
      for (const by of ['office', 'touch.', 'touch.a b', 'outcome', 'minute']) await assert.rejects(graph.report({ from: '2026-03-02', to: '2026-03-03', by }), TypeError)
    })

    test('what followed a call is counted by person, whatever account or number they used', async () => {
      const clock = { now: T0 + 60 * DAY }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const call = (id: string, from: string, hours: number, more: object = {}) => recordCall(graph, { id, from, to: '+15550100001', at: T0 + hours * HOUR, duration: 120, answered: true, ...more }, { results: 'expected' })
      // One person rings from two numbers on file as theirs, and becomes a client under their account.
      const owns = (subject: string, ...numbers: string[]) => graph.observe({ subject, identifiers: numbers.map((number) => `phone:${hashPhone(number)}`), at: T0 })
      await call('A1', '+15550100071', 1, { tags: { language: 'es' } })
      await call('A2', '+15550100072', 5)
      await owns('contact:a', '+15550100071', '+15550100072')
      await graph.outcome({ transactionId: 'client-a', subject: 'contact:a', at: T0 + 10 * DAY, stage: 'client', value: 1 })
      await graph.outcome({ transactionId: 'inquiry-a', subject: 'contact:a', at: T0, stage: 'inquiry' })
      // Another is missed and rung back, and does not.
      await call('B1', '+15550100073', 2, { answered: false })
      await recordCall(graph, { id: 'B2', direction: 'outbound', from: '+15550100001', to: '+15550100073', at: T0 + 4 * HOUR, answered: true })
      const asked = await graph.followed({ from: '2023-11-14', to: '2023-11-20', step: 'client', days: 30, least: 1 })
      const rows = (by: string) => asked.groups.find((each) => each.by === by)!.rows.map((row) => [row.name, row.people, row.reached])
      assert.deepEqual(rows('answer'), [['answered', 1, 1], ['missed', 1, 0]])
      assert.deepEqual(rows('language'), [['es', 1, 1], ['(not set)', 1, 0]])
      assert.deepEqual(rows('returned'), [['returned within a day', 1, 0]])
      // With the usual least of twenty, nothing so thin is shown.
      const usual = await graph.followed({ from: '2023-11-14', to: '2023-11-20', step: 'client', days: 30 })
      assert.deepEqual(usual.groups.map((each) => [each.rows.length, each.suppressed]), [[0, 2], [0, 1], [0, 2], [0, 1]])
      await graph.forget('contact:a')
      assert.deepEqual((await graph.followed({ from: '2023-11-14', to: '2023-11-20', step: 'client', days: 30, least: 1 })).groups[0]!.rows.map((row) => row.reached), [0, 0])
      for (const bad of [{ step: '' }, { days: 0 }, { days: 1.5 }, { days: 400 }, { from: '2023-12-01' }]) await assert.rejects(graph.followed({ from: '2023-11-14', to: '2023-11-20', step: 'client', days: 30, ...bad }), TypeError)
    })

    test('no two visitors hold one number at one time, whoever asks and whenever', async () => {
      for (const seed of [1, 2, 3]) {
        const next = random(seed)
        const pick = (count: number) => Math.floor(next() * count)
        const { graph } = await fresh()
        const numbers = ['+15550100001', '+15550100002', '+15550100003']
        const held: { number: string; subject: string; start: number; until: number }[] = []
        let at = T0
        for (let step = 0; step < 120; step++) {
          // Time mostly goes forward. Another server's clock may be a little behind.
          at += pick(6) * 60_000
          const asked = at - (pick(5) === 0 ? pick(90_000) : 0)
          const subject = `visitor:${pick(8)}`
          const lease = await graph.lease(subject, { numbers, minutes: 1 + pick(15), at: asked })
          if (!lease) {
            // None was free, and that is the only reason.
            assert.equal(await graph.leasesAt(numbers, Math.max(...held.map((each) => each.start))) > 0, true)
            for (const number of numbers) assert.ok(held.some((each) => each.number === number && each.until > asked))
            continue
          }
          assert.equal(lease.subject, subject)
          assert.ok(lease.until > asked)
          const same = held.findIndex((each) => each.number === lease.number && each.start === lease.start)
          if (same >= 0) {
            assert.equal(held[same]!.subject, subject)
            held[same] = lease
          } else held.push(lease)
          for (const x of held) for (const y of held) if (x !== y && x.number === y.number) assert.ok(x.until <= y.start || y.until <= x.start, `seed ${seed}, step ${step}`)
          // Whoever asks about the moment is told the one who holds it.
          assert.equal(await graph.leaseholder(lease.number, lease.start), subject)
        }
        assert.ok(held.length > 10)
      }
    })

    test('visitors who ask for a number at one moment each get their own, or none', async () => {
      const { graph } = await fresh()
      const numbers = Array.from({ length: 5 }, (_, i) => `+1555010010${i}`)
      // Twelve visitors, each asking twice at once, as two tabs of one browser do.
      const given = await Promise.all(Array.from({ length: 24 }, (_, i) => graph.lease(`visitor:${i % 12}`, { numbers, minutes: 15, at: T0 + (i % 3) }).then((lease) => [`visitor:${i % 12}`, lease?.number] as const)))
      const holders = new Map<string, Set<string>>()
      for (const [subject, number] of given) if (number) holders.set(number, (holders.get(number) ?? new Set()).add(subject))
      assert.deepEqual([...holders.keys()].sort(), numbers)
      assert.ok([...holders.values()].every((subjects) => subjects.size === 1))
      assert.equal(new Set([...holders.values()].flatMap((subjects) => [...subjects])).size, 5)
      assert.equal(given.filter(([, number]) => number).length, 10)
    })

    test('a number is renewed for whoever holds it, then goes to the next by longest rest, and is deleted with its holder or by age', async () => {
      const { graph } = await fresh(undefined, { now: () => T0 })
      const numbers = ['+15550100001', '+15550100002']
      const MIN = 60_000
      const lease = (subject: string, at: number) => graph.lease(subject, { numbers, minutes: 15, at })
      const first = (await lease('visitor:a', T0))!
      assert.deepEqual(first, { number: '+15550100001', subject: 'visitor:a', start: T0, until: T0 + 15 * MIN })
      assert.deepEqual(await lease('visitor:a', T0 + 5 * MIN), { ...first, until: T0 + 20 * MIN })
      assert.equal((await lease('visitor:b', T0 + 6 * MIN))!.number, '+15550100002')
      assert.equal(await lease('visitor:c', T0 + 7 * MIN), undefined)
      assert.equal(await graph.leasesAt(numbers, T0 + 7 * MIN), 2)
      assert.equal(await graph.leasesAt(numbers, T0 + 20 * MIN), 1)
      // At the moment one ends it is free, and the one that has rested longest goes first.
      assert.equal((await lease('visitor:c', T0 + 20 * MIN))!.number, '+15550100001')
      assert.equal(await lease('visitor:d', T0 + 20 * MIN), undefined)
      assert.equal((await lease('visitor:d', T0 + 60 * MIN))!.number, '+15550100002')
      // Who held it when, and for a while after when nobody has since.
      const who = (minutes: number, grace = 0) => graph.leaseholder('+15550100001', T0 + minutes * MIN, grace)
      assert.deepEqual([await who(-1, 1e9), await who(0), await who(19), await who(20), await who(34), await who(35)], [undefined, 'visitor:a', 'visitor:a', 'visitor:c', 'visitor:c', undefined])
      assert.deepEqual([await who(40, 5 * MIN), await who(41, 5 * MIN)], ['visitor:c', undefined])
      // Forgotten, nobody held it, and it does not go back to whoever did before: somebody has held it since.
      assert.equal(await who(25, 120 * MIN), 'visitor:c')
      await graph.forget('visitor:c')
      assert.equal(await who(25, 120 * MIN), undefined)
      assert.equal((await graph.leasesAt(numbers, T0 + 25 * MIN)), 1)
      assert.equal(await graph.prune(T0 + 22 * MIN), 2)
      assert.equal(await who(5), undefined)
      // Asked to, it lends only to somebody who arrived and has not opted out.
      const strictly = (subject: string) => graph.lease(subject, { numbers, minutes: 15, at: T0 + 500 * MIN, arrivedSince: T0 })
      assert.equal(await strictly('visitor:e'), null)
      await graph.touch({ subject: 'visitor:e', at: T0 - 1, gclid: 'old' })
      await graph.touch({ subject: 'visitor:e', at: T0 + 501 * MIN, gclid: 'not yet' })
      assert.equal(await strictly('visitor:e'), null)
      await graph.touch({ subject: 'visitor:e', at: T0 + 1, gclid: 'new' })
      assert.equal((await strictly('visitor:e'))!.subject, 'visitor:e')
      await graph.consent('visitor:e', { adUserData: false, adPersonalization: false }, { at: T0 + 2 })
      assert.equal(await strictly('visitor:e'), null)
      for (const bad of [{ minutes: 0 }, { minutes: 15, at: 1.5 }]) await assert.rejects(graph.lease('visitor:a', { numbers, ...bad }), TypeError)
      await assert.rejects(graph.lease('', { numbers, minutes: 15 }), TypeError)
      assert.equal(await graph.lease('visitor:a', { numbers: [], minutes: 15, at: T0 }), undefined)
    })

    test('a call to a pool number is its holder\'s, without a tap, and never two callers\'', async () => {
      const { graph } = await fresh()
      const MIN = 60_000
      const pool = { numbers: ['+1 (555) 010-0001', '+15550100002'], grace: 120 * MIN }
      const numbers = ['+15550100001', '+15550100002']
      for (const name of ['a', 'b', 'c']) {
        await graph.observe({ subject: `visitor:${name}`, identifiers: [`device:${name}`], at: T0, event: 'visit' })
        await graph.touch({ subject: `visitor:${name}`, at: T0, gclid: `click-${name}` })
      }
      await graph.lease('visitor:a', { numbers, minutes: 15, at: T0 })
      const call = (id: string, from: string, minutes: number, to = '+15550100001') => recordCall(graph, { id, from, to, at: T0 + minutes * MIN, duration: 60 }, { pool })
      const during = await call('P1', '+15550100071', 5)
      assert.deepEqual([during.visitor, during.flags, during.counted], ['visitor:a', ['pool'], true])
      assert.deepEqual((await graph.links('visitor:a')).map((link) => [link.subject, link.score, link.reasons.map((reason) => reason.identifier)]), [[during.subject, 0.9, ['lease:P1']]])
      assert.equal((await graph.attribute(during.subject, { at: T0 + 5 * MIN })).credited?.gclid, 'click-a')
      // Reported again, it is the same call.
      assert.equal((await call('P1', '+15550100071', 5)).duplicate, true)
      // After it ended and before anyone else has it, it is still theirs: they wrote the number down.
      assert.equal((await call('P2', '+15550100071', 60)).visitor, 'visitor:a')
      // Another caller on it is somebody else: a visitor is tied to one caller.
      assert.equal((await call('P3', '+15550100072', 61)).visitor, undefined)
      // Leased again, it is the new holder's, and past the grace it is nobody's.
      assert.equal((await graph.lease('visitor:b', { numbers: ['+15550100001'], minutes: 15, at: T0 + 70 * MIN }))!.start, T0 + 70 * MIN)
      assert.equal((await call('P4', '+15550100073', 71)).visitor, 'visitor:b')
      assert.equal((await call('P5', '+15550100074', 85 + 121)).visitor, undefined)
      // Two callers reported at once on one holder's number: one of them is the visitor's caller, and never both.
      await graph.observe({ subject: 'visitor:d', identifiers: ['device:d'], at: T0, event: 'visit' })
      await graph.lease('visitor:d', { numbers: ['+15550100001'], minutes: 15, at: T0 + 300 * MIN })
      const both = await Promise.all(['+15550100078', '+15550100079'].map((from, i) => call(`Q${i}`, from, 301)))
      assert.equal(both.filter((each) => each.visitor === 'visitor:d').length, 1)
      assert.equal((await graph.links('visitor:d')).length, 1)
      // Forgotten between the match and the tie, or between the tie and the keeping of the call, a visitor stays forgotten.
      await graph.forget('visitor:d')
      // Seen again since, they are still not the one the call was matched to.
      await graph.observe({ subject: 'visitor:d', identifiers: ['device:d'], at: T0 + 302 * MIN, event: 'visit' })
      assert.equal(await graph.tieCall('caller:x', 'visitor:d', 'lease:late', T0 + 301 * MIN, { pool: '+15550100001', grace: 0 }), false)
      assert.equal(await graph.tieCall('caller:x', 'visitor:d', 'dial:late', T0 + 301 * MIN, { notes: [dialed('+15550100001', T0 + 301 * MIN)] }), false)
      await graph.keepCall({ id: 'LATE', direction: 'inbound', subject: 'caller:x', at: T0, to: '+15550100001', flags: [], visitor: 'visitor:d' })
      assert.deepEqual([(await graph.links('visitor:d')).length, (await graph.keptCall('LATE'))!.visitor], [0, undefined])
      // A holder a reviewer keeps apart from the caller is passed over.
      await graph.lease('visitor:c', { numbers: ['+15550100002'], minutes: 15, at: T0 })
      await graph.separate('visitor:c', `caller:${hashPhone('+15550100075')}`)
      assert.equal((await call('P6', '+15550100075', 1, '+15550100002')).visitor, undefined)
      // A number not in the pool is tied by a tap alone, whoever once held it.
      assert.equal((await recordCall(graph, { id: 'P7', from: '+15550100076', to: '+15550100001', at: T0 + 72 * MIN, duration: 60 })).visitor, undefined)
      // Nobody holds it: a tap says whose it is, as on any other number.
      await graph.observe({ subject: 'visitor:c', identifiers: [dialed('+15550100001', T0 + 500 * MIN)], at: T0 + 500 * MIN, event: 'phone_click' })
      const tapped = await call('P8', '+15550100077', 500)
      assert.deepEqual([tapped.visitor, tapped.flags], ['visitor:c', []])
      await graph.verify().then((wrong) => assert.deepEqual(wrong, []))
    })

    test('between says what two subjects share, however weak, and how they stand', async () => {
      const { graph } = await fresh()
      const see = (subject: string, ...identifiers: string[]) => graph.observe({ subject, identifiers, at: T0, event: 'login' })
      await see('a', 'ip:192.0.2.1', 'email:a')
      await see('b', 'ip:192.0.2.1', 'email:b')
      const weak = await graph.between('a', 'b')
      assert.deepEqual([weak.known, weak.joined, weak.apart, weak.reasons.map((reason) => reason.identifier)], [true, false, false, ['ip:192.0.2.1']])
      assert.ok(weak.score > 0 && weak.score < defaultPolicy.related)
      assert.deepEqual(await graph.links('a'), [])
      // A reviewer's mark joins them and is not among what they share.
      await graph.join('a', 'b')
      assert.deepEqual(await graph.between('b', 'a'), { ...weak, joined: true })
      await graph.separate('a', 'b')
      assert.deepEqual(await graph.between('a', 'b'), { ...weak, apart: true })
      assert.deepEqual(await graph.between('a', 'nobody'), { known: false, joined: false, apart: false, score: 0, reasons: [], idle: [] })
      assert.deepEqual((await graph.between('a', 'a')).reasons, [])
      await graph.ignore('ip:192.0.2.1')
      const muted = await graph.between('a', 'b')
      assert.deepEqual([muted.score, muted.reasons, muted.idle], [0, [], ['ip:192.0.2.1']])
      // Known by a reviewer's mark alone, there is nothing to compare.
      await graph.forget('b')
      await graph.joinAll([{ a: 'a', b: 'b' }], { by: 'system:crm' })
      assert.deepEqual([(await graph.between('a', 'b')).known, (await graph.between('a', 'b')).apart], [false, false])
    })

    test('undecided lists pairs related and not joined, and a join taken back by its mark is a label no more', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const see = (subject: string, ...identifiers: string[]) => graph.observe({ subject, identifiers, at: T0, event: 'login' })
      await see('a:1', 'canvas:c1', 'ip:192.0.2.1')
      await see('a:2', 'canvas:c1', 'ip:192.0.2.1')
      await see('b:1', 'canvas:c2', 'voip:v')
      await see('b:2', 'canvas:c2', 'voip:v')
      clock.now += 1000
      await see('j:1', 'email:j')
      await see('j:2', 'email:j')
      await see('lone', 'email:lone')
      const names = async (options?: object) => (await graph.undecided(options)).pairs.map((pair) => `${pair.a} ${pair.b}`)
      // Joined pairs and those that share too little are not here.
      const found = await graph.undecided()
      assert.deepEqual(found.pairs.map((pair) => [pair.a, pair.b, pair.level]), [['b:1', 'b:2', 'related'], ['a:1', 'a:2', 'related']])
      assert.ok(found.pairs[0]!.score > found.pairs[1]!.score && found.pairs[1]!.reasons.length === 2)
      assert.deepEqual([found.total, found.seen], [2, 7])
      assert.deepEqual(await names({ limit: 1 }), ['b:1 b:2'])
      // Only subjects something was last recorded about are looked at.
      assert.deepEqual(await names({ sightings: 3 }), [])

      clock.now += 1000
      await see('b:1', 'canvas:c2')
      assert.deepEqual(await names({ sightings: 1 }), ['b:1 b:2'])
      // A cut inside one batch falls by subject, whatever the order they were given in.
      clock.now += 1000
      await graph.observe(['b:2', 'a:2', 'a:1'].map((subject) => ({ subject, identifiers: ['canvas:c1'], at: T0 })))
      assert.deepEqual(await names({ sightings: 2 }), ['a:1 a:2'])
      await graph.forget('b:2')
      await see('b:2', 'canvas:c2', 'voip:v')

      // Kept apart, a pair is decided. Allowed again, it is back.
      await graph.separate('b:1', 'b:2', true, { by: 'dana' })
      assert.deepEqual(await names(), ['a:1 a:2'])
      assert.deepEqual((await graph.reviewed()).map((pair) => pair.same), [false])
      await graph.separate('b:1', 'b:2', false, { by: 'dana' })
      assert.deepEqual(await names(), ['b:1 b:2', 'a:1 a:2'])

      // Joined, it is decided, and a label. Its mark no longer linking, it is neither.
      await graph.join('a:1', 'a:2', { by: 'dana' })
      const mark = async () => (await graph.links('a:1'))[0]!.reasons.map((reason) => reason.identifier).find((identifier) => identifier.startsWith('review:'))!
      assert.deepEqual(await names(), ['b:1 b:2'])
      assert.deepEqual((await graph.reviewed()).map((pair) => pair.same), [true])
      const first = await mark()
      await graph.ignore(first, true, { by: 'dana', reason: 'undo' })
      assert.deepEqual(await names(), ['b:1 b:2', 'a:1 a:2'])
      assert.deepEqual(await graph.reviewed(), [])
      assert.notEqual((await graph.cluster('a:1'))!.id, (await graph.cluster('a:2'))!.id)
      // Linking through it once more joins them again, and undoing an older join leaves a later one alone.
      await graph.ignore(first, false, { by: 'dana' })
      assert.deepEqual((await graph.reviewed()).map((pair) => pair.same), [true])
      await graph.join('a:1', 'a:2', { by: 'dana' })
      await graph.ignore(first, true, { by: 'dana' })
      assert.deepEqual((await graph.reviewed()).map((pair) => pair.same), [true])
      assert.deepEqual(await names(), ['b:1 b:2'])
      // A join made in bulk where a mark stands makes no other: muting that one takes it back too.
      await see('k:1', 'canvas:k')
      await see('k:2', 'canvas:k')
      await graph.join('k:1', 'k:2')
      const held = (await graph.links('k:1'))[0]!.reasons.find((reason) => reason.identifier.startsWith('review:'))!.identifier
      await graph.separate('k:1', 'k:2')
      await graph.separate('k:1', 'k:2', false)
      await graph.joinAll([{ a: 'k:1', b: 'k:2' }], { by: 'system:crm' })
      assert.equal((await graph.reviewed()).length, 2)
      await graph.ignore(held)
      assert.equal((await graph.reviewed()).length, 1)
      for (const each of ['k:1', 'k:2']) await graph.forget(each)
      // Where a system's decisions are left out, its mark does not keep a reviewer's join that was taken back.
      await see('s:1', 'canvas:s')
      await see('s:2', 'canvas:s')
      await graph.join('s:1', 's:2', { by: 'dana' })
      const danas = (await graph.links('s:1'))[0]!.reasons.find((reason) => reason.identifier.startsWith('review:'))!.identifier
      const before = (await graph.reviewed({ exclude: 'system:' })).length
      await graph.ignore(danas)
      await graph.joinAll([{ a: 's:1', b: 's:2' }], { by: 'system:crm' })
      assert.equal((await graph.reviewed({ exclude: 'system:' })).length, before - 1)
      assert.equal((await graph.reviewed()).length, before)
      for (const each of ['s:1', 's:2']) await graph.forget(each)
      // Joined but held apart by a separation through a third: it was decided, so it is not asked about again.
      await graph.separate('a:1', 'b:1', true, { by: 'dana' })
      await graph.join('a:2', 'b:1', { by: 'dana' })
      assert.deepEqual(await names(), ['b:1 b:2'])
      await graph.forget('b:2')
      assert.deepEqual(await names(), [])
    })

    test('the board has each person once, at the furthest step they reached, with missed calls first', async () => {
      const { graph } = await fresh(undefined, { now: () => T0 })
      const steps = [{ name: 'inquiry', wait: 24 }, { name: 'client' }]
      // T0 is 2023-11-14 22:13:20 UTC, so `today` began 22 hours and some before it.
      const hours = (n: number) => T0 - n * HOUR
      const step = (subject: string, stage: string, at: number, value = 5, tags?: Record<string, string>) => graph.outcome({ transactionId: `${stage}-${subject}-${at}`, subject, at, stage, value, currency: 'USD', ...(tags && { tags }) })
      const miss = (id: string, from: string, at: number) => recordCall(graph, { id, from, to: '+15550100001', at, duration: 20, answered: false, tags: { language: 'es' } }, { results: 'expected' })
      await step('a:new', 'inquiry', hours(1))
      await step('a:late', 'inquiry', hours(40))
      // An inquiry, then a client today: at the last step, and done at the first.
      await step('a:up', 'inquiry', hours(60))
      await step('a:up', 'client', hours(2), 200)
      // A second inquiry does not take a client back.
      await step('a:again', 'client', hours(50), 200, { language: 'en' })
      await step('a:again', 'inquiry', hours(3))
      await step('a:other', 'brochure', hours(5))
      // Two subjects of one person are in one place, at the further of their steps.
      await graph.observe([{ subject: 'b:1', identifiers: ['device:b', 'email:b'], at: hours(70) }, { subject: 'b:2', identifiers: ['device:b', 'email:b'], at: hours(70) }])
      await step('b:1', 'client', hours(70), 300)
      await step('b:2', 'inquiry', hours(30))
      await graph.touch({ subject: 'b:2', at: hours(80), source: 'mailer', campaign: 'postcard', custom: { lang: 'es' } })
      // A client whose call was missed is first of all somebody to ring back.
      await miss('M1', '+15550100061', hours(30))
      await graph.observe([{ subject: 'c:1', identifiers: [`phone:${hashPhone('+15550100061')}`, 'email:c'], at: hours(90) }])
      await step('c:1', 'client', hours(90), 400)
      // A miss that was returned today is done, and one from a hidden number cannot be returned.
      await miss('M2', '+15550100062', hours(30))
      await recordCall(graph, { id: 'R2', direction: 'outbound', from: '+15550100001', to: '+15550100062', at: hours(4), duration: 60, answered: true })
      await miss('M3', '', hours(30))

      const board = await graph.board({ steps, at: T0, returnHours: 24 })
      assert.deepEqual(board.columns.map(({ rows, wait, ...column }) => ({ ...column, rows: rows.map((row) => row.subject) })), [
        { step: null, people: 1, fresh: 0, late: 1, done: 1, rows: [`caller:${hashPhone('+15550100061')}`] },
        { step: 'inquiry', people: 2, fresh: 1, late: 1, done: 1, rows: ['a:late', 'a:new'] },
        { step: 'client', people: 3, fresh: 1, late: null, done: null, rows: ['b:1', 'a:again', 'a:up'] },
      ])
      assert.deepEqual([board.unplaced, board.day, board.from], [1, '2023-11-14', '2023-08-17'])
      const [missed, , client] = board.columns
      assert.deepEqual([missed!.rows[0]!.step, missed!.rows[0]!.outcome?.value, missed!.rows[0]!.call?.id, missed!.rows[0]!.language, missed!.rows[0]!.late], ['client', 400, 'M1', 'es', true])
      assert.deepEqual([client!.rows[0]!.touch?.campaign, client!.rows[0]!.language, client!.rows[1]!.language, client!.rows[2]!.language], ['postcard', 'es', 'en', undefined])

      // No limit set: nobody waits too long. Fewer rows: the counts are still of everybody.
      const plain = await graph.board({ steps, at: T0, limit: 1 })
      assert.deepEqual(plain.columns.map((column) => [column.people, column.late, column.rows.length]), [[1, null, 1], [2, 1, 1], [3, null, 1]])
      // Reached on one of two numbers, a person is reached. Missed again since, they are done today and waiting too.
      await graph.observe([{ subject: 'd:1', identifiers: [`phone:${hashPhone('+15550100063')}`, `phone:${hashPhone('+15550100064')}`, 'email:d'], at: hours(95) }])
      await recordCall(graph, { id: 'A4', from: '+15550100064', to: '+15550100001', at: hours(310), duration: 60, answered: true }, { results: 'expected' })
      await miss('M4', '+15550100063', hours(300))
      await recordCall(graph, { id: 'R4', direction: 'outbound', from: '+15550100001', to: '+15550100064', at: hours(6), duration: 60, answered: true })
      const reached = (await graph.board({ steps, at: T0 })).columns[0]!
      assert.deepEqual([reached.people, reached.done], [1, 2])
      await miss('M5', '+15550100064', hours(5))
      const again = (await graph.board({ steps, at: T0 })).columns[0]!
      assert.deepEqual([again.people, again.done, again.fresh], [2, 2, 1])
      // An older miss of somebody on the board still counts as open, before the period's first day.
      await miss('M6', '+15550100065', hours(60))
      await graph.observe([{ subject: 'e:1', identifiers: [`phone:${hashPhone('+15550100065')}`, 'email:e'], at: hours(60) }])
      await step('e:1', 'inquiry', hours(1))
      assert.equal((await graph.board({ steps, at: T0, days: 2 })).columns[0]!.rows.some((row) => row.subject === `caller:${hashPhone('+15550100065')}`), true)
      await graph.forget('e:1')
      // A short call that counts for nothing is still having called.
      await graph.observe([{ subject: 'f:1', identifiers: [`phone:${hashPhone('+15550100066')}`, 'email:f'], at: hours(2000) }])
      await step('f:1', 'client', hours(2000))
      await recordCall(graph, { id: 'S1', from: '+15550100066', to: '+15550100001', at: hours(30), duration: 9, answered: true }, { results: 'expected' })
      assert.ok((await graph.board({ steps, at: T0, days: 3 })).columns[2]!.rows.some((row) => row.subject === 'f:1'))
      for (const n of [3, 4, 5]) await graph.forget(`caller:${hashPhone(`+1555010006${n}`)}`)
      // A shorter period leaves out who did nothing in it.
      assert.deepEqual((await graph.board({ steps, at: T0, days: 1 })).columns.map((column) => column.rows.map((row) => row.subject)), [[], ['a:new'], ['a:again', 'a:up']])
      // A shifted zone moves today.
      assert.equal((await graph.board({ steps, at: T0, timeZone: 'Asia/Tokyo' })).day, '2023-11-15')
      for (const days of [0, 1.5, 366]) await assert.rejects(graph.board({ steps, at: T0, days }), TypeError)
      await graph.forget('a:late')
      assert.deepEqual((await graph.board({ steps, at: T0 })).columns[1]!.rows.map((row) => row.subject), ['a:new'])
    })

    test('with opening hours, the board counts waiting while open, and the summary the calls that came while closed', async () => {
      const { graph } = await fresh(undefined, { now: () => T0 })
      // T0 is a Tuesday, 22:13:20 in UTC. Open 9 to 17 on weekdays.
      const week = ['09:00-17:00']
      const hours = createHours({ mon: week, tue: week, wed: week, thu: week, fri: week })
      const at = (day: number, hour: number) => Date.UTC(2023, 10, day, hour)
      const options = { results: 'expected' as const }
      await recordCall(graph, { id: 'D1', from: '+15550100091', to: '+15550100001', at: at(10, 16), duration: 20, answered: false }, options)
      await recordCall(graph, { id: 'D2', from: '+15550100092', to: '+15550100001', at: at(11, 12), duration: 20, answered: false }, options)
      await recordCall(graph, { id: 'D3', from: '+15550100093', to: '+15550100001', at: at(14, 20), duration: 60, answered: true }, options)
      await graph.outcome({ transactionId: 'i', subject: 'a', at: at(14, 12), stage: 'inquiry', value: 1, currency: 'USD' })
      const late = async (more: object) => (await graph.board({ steps: [{ name: 'inquiry', wait: 5 }], at: T0, returnHours: 16.5, ...more })).columns.map((column) => [column.late, column.rows.filter((row) => row.late).map((row) => row.at)])
      // Exactly the limit is not longer than it, whether or not the wait began while you were closed.
      assert.deepEqual([(await late({ hours, returnHours: 16 }))[0], (await late({ hours, returnHours: 17 }))[0]], [[1, [at(10, 16)]], [0, []]])
      // By the clock all have waited. Open, the Friday miss has waited 17 hours and the Saturday one 16, and the inquiry of noon 5.
      assert.deepEqual(await late({}), [[2, [at(10, 16), at(11, 12)]], [1, [at(14, 12)]]])
      assert.deepEqual(await late({ hours }), [[1, [at(10, 16)]], [0, []]])
      const summary = await graph.callSummary({ from: '2023-11-10', to: '2023-11-14', at: T0, ...options, hours })
      assert.deepEqual([summary.total.calls, summary.closed!.calls, summary.closed!.missed, summary.closed!.answered], [3, 2, 1, 1])
      assert.equal((await graph.callSummary({ from: '2023-11-10', to: '2023-11-14', at: T0, ...options })).closed, null)
    })

    test('what was no lead stays on record, is counted apart, and counts nowhere else until that is taken back', async () => {
      const { graph } = await fresh(undefined, { now: () => T0 + DAY })
      const options = { results: 'expected' as const, now: () => T0 + DAY }
      const days = { from: '2023-11-14', to: '2023-11-15' }
      for (const name of ['a', 'b']) {
        await graph.observe({ subject: `visitor:${name}`, identifiers: [`device:${name}`], at: T0, event: 'visit' })
        await graph.touch({ subject: `visitor:${name}`, at: T0, gclid: name, campaignId: '1', campaign: 'Search' })
        await graph.observe({ subject: `lead:${name}`, identifiers: [`device:${name}`], at: T0 + 1 })
        await graph.outcome({ transactionId: `inquiry-${name}`, subject: `lead:${name}`, at: T0 + 1, stage: 'inquiry', value: 10, currency: 'USD', tags: { language: 'es' } })
      }
      const call = (id: string, n: number, answered: boolean) => recordCall(graph, { id, from: `+155501000${n}`, to: '+15550100001', at: T0 + 2000 + n, duration: 60, answered }, options)
      await call('C1', 71, true)
      await call('C2', 72, false)
      await call('C3', 73, false)
      const seen = async () => {
        const report = await graph.report({ ...days, by: 'outcome.language' })
        const summary = (await graph.callSummary({ ...days, at: T0 + DAY, ...options })).total
        const board = await graph.board({ steps: [{ name: 'call' }, { name: 'inquiry' }], at: T0 + DAY })
        return {
          report: [report.total.outcomes, report.total.value, report.total.people, report.total.missed, report.total.notLeads],
          row: report.rows.filter((row) => row.campaignId === '1').map((row) => [row.outcomes, row.notLeads]),
          spanish: report.total.breakdown!.filter((part) => part.name === 'es').map((part) => [part.outcomes, part.notLeads]),
          calls: [summary.calls, summary.answered, summary.missed, summary.notLeads],
          open: (await graph.openCalls(days)).map((each) => each.call.id),
          board: board.columns.map((column) => column.people),
          first: (await graph.followed({ ...days, step: 'inquiry', days: 1, at: T0 + 30 * DAY, least: 1 })).groups[0]!.rows.reduce((sum, row) => sum + row.people, 0),
        }
      }
      const before = await seen()
      assert.deepEqual(before, { report: [3, 20, 3, 2, 0], row: [[2, 0]], spanish: [[2, 0]], calls: [3, 1, 2, 0], open: ['C2', 'C3'], board: [2, 1, 2], first: 3 })
      assert.deepEqual(await recordNotLead(graph, { transactionId: 'inquiry-a', kind: 'spam' }, options), { id: 'inquiry-a', lead: false })
      assert.deepEqual(await recordNotLead(graph, { call: 'C1' }, options), { id: 'call:C1', lead: false })
      await recordNotLead(graph, { call: 'C2', kind: 'spam' }, options)
      assert.deepEqual(await seen(), { report: [1, 10, 1, 1, 3], row: [[1, 1]], spanish: [[1, 1]], calls: [1, 0, 1, 2], open: ['C3'], board: [1, 0, 1], first: 1 })
      // It is there to be seen, and said again in other words it is still one.
      await recordNotLead(graph, { call: 'C2', kind: 'other' }, options)
      const told = (await graph.journey('lead:a')).entries.find((entry) => entry.kind === 'outcome') as any
      assert.deepEqual([told.outcome.transactionId, told.notLead], ['inquiry-a', 'spam'])
      const rang = (await graph.journey(`caller:${hashPhone('+15550100072')}`)).entries.find((entry) => entry.kind === 'call') as any
      assert.equal(rang.notLead, 'other')
      assert.equal((await graph.notLeads(['call:C1', 'nothing'])).size, 1)
      // An answered call that was no lead is no conversation with them: the miss before it is still waiting, everywhere.
      await recordCall(graph, { id: 'C6', from: '+15550100075', to: '+15550100001', at: T0 + 2400, duration: 20, answered: false }, options)
      await recordCall(graph, { id: 'C5', from: '+15550100075', to: '+15550100001', at: T0 + 2500, duration: 60, answered: true }, options)
      assert.deepEqual((await graph.openCalls(days)).map((each) => each.call.id), ['C3'])
      await recordNotLead(graph, { call: 'C5' }, options)
      const [, waiting] = await graph.openCalls(days)
      assert.deepEqual([waiting!.call.id, waiting!.followUp.state], ['C6', 'open'])
      const after = (await graph.callSummary({ ...days, at: T0 + DAY, ...options })).total
      assert.deepEqual([after.calledAgain, after.notLeads], [0, 3])
      assert.equal((await graph.board({ steps: [{ name: 'call' }], at: T0 + DAY })).columns[0]!.people, 2)
      // In the report once, whether or not it ever was an outcome.
      assert.equal((await graph.report(days)).total.notLeads, 4)
      await graph.withdraw('call:C5')
      assert.equal((await graph.report(days)).total.notLeads, 4)
      await graph.forget(`caller:${hashPhone('+15550100075')}`)
      // A call said to be none before it came, or before its result did, is not counted when it comes.
      await recordNotLead(graph, { call: 'C4' }, options)
      await recordCall(graph, { id: 'C4', from: '+15550100074', to: '+15550100001', at: T0 + 2100, duration: 60 }, options)
      assert.deepEqual(await recordCallResult(graph, { id: 'C4', answered: true }, options), { state: 'answered', counted: false })
      assert.equal(await graph.outcomeOf('call:C4'), undefined)
      await recordNotLead(graph, { call: 'C4', lead: true }, options)
      assert.equal((await graph.outcomeOf('call:C4'))!.stage, 'call')
      // What it was restated to meanwhile is kept when the mark is taken back.
      await graph.restate('call:C4', 77)
      await recordNotLead(graph, { call: 'C4' }, options)
      await recordNotLead(graph, { call: 'C4', lead: true }, options)
      assert.equal((await graph.outcomeOf('call:C4'))!.value, 77)
      await graph.forget(`caller:${hashPhone('+15550100074')}`)
      // Taken back, everything is as it was.
      for (const report of [{ transactionId: 'inquiry-a' }, { call: 'C1' }, { call: 'C2' }]) await recordNotLead(graph, { ...report, lead: true }, options)
      assert.deepEqual(await seen(), before)
      for (const bad of [{}, { call: 'C1', transactionId: 'x' }, { call: '' }, { call: 'C1', kind: 'junk' }, { call: 'C1', lead: 'no' }, { transactionId: '' }]) await assert.rejects(recordNotLead(graph, bad as never, options), TypeError)
      // Forgotten with its subject, and pruned where it never came.
      await recordNotLead(graph, { transactionId: 'inquiry-b' }, options)
      await recordNotLead(graph, { call: 'C3' }, options)
      await recordNotLead(graph, { transactionId: 'never' }, options)
      await graph.forget('lead:b')
      await graph.forget(`caller:${hashPhone('+15550100073')}`)
      assert.deepEqual([...(await graph.notLeads(['inquiry-b', 'call:C3', 'never'])).keys()], ['never'])
      await graph.prune(T0 + DAY)
      assert.equal((await graph.notLeads(['never'])).size, 1)
      await graph.prune(T0 + DAY + 1)
      assert.equal((await graph.notLeads(['never'])).size, 0)
    })

    test('a journey is everything about one person, in order, and why each subject is them', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      const at = (hours: number) => T0 + hours * HOUR
      const numbers = { '+15550100001': { source: 'google', campaignId: '111' } }
      // An ad click, a tap, a missed call that is returned, an inquiry, a client step that is restated, consent, and a decision.
      await graph.observe({ subject: 'visitor:j', identifiers: ['device:j', 'ip:192.0.2.9'], at: at(0), event: 'visit' })
      await graph.touch({ subject: 'visitor:j', at: at(0), gclid: 'G', campaignId: '111', custom: { office: 'north' } })
      await graph.observe({ subject: 'visitor:j', identifiers: ['device:j', dialed('+15550100001', at(1))], at: at(1), event: 'phone_click' })
      await recordCall(graph, { id: 'J1', from: '+15550100081', to: '+15550100001', at: at(1) + 5000, duration: 20, answered: false, tags: { language: 'es' } }, { numbers })
      const callerId = `caller:${hashPhone('+15550100081')}`
      await recordCall(graph, { id: 'J2', direction: 'outbound', from: '+15550100001', to: '+15550100081', at: at(3), duration: 90, answered: true })
      await graph.observe({ subject: 'contact:j', identifiers: ['device:j', `phone:${hashPhone('+15550100081')}`], at: at(5), event: 'signup' })
      await graph.consent('contact:j', { adUserData: true, adPersonalization: false }, { at: at(5), source: 'form' })
      clock.now = at(6)
      await graph.outcome({ transactionId: 'client-j', subject: 'contact:j', at: at(6), stage: 'client', value: 100, currency: 'USD' })
      clock.now = at(30)
      await graph.restate('client-j', 250)
      clock.now = at(31)
      await graph.separate('contact:j', 'contact:k', true, { by: 'dana', reason: 'two people' })
      // Somebody else's, sharing too little to be this person, and somebody kept apart who shares enough.
      await graph.observe({ subject: 'visitor:stranger', identifiers: ['ip:192.0.2.9'], at: at(0), event: 'visit' })
      await graph.observe({ subject: 'contact:k', identifiers: ['device:j'], at: at(4), event: 'signup' })
      await graph.touch({ subject: 'contact:k', at: at(4), gclid: 'K' })

      const journey = await graph.journey('contact:j')
      const say = (entry: (typeof journey.entries)[number]) => `${(entry.at - T0) / HOUR === Math.floor((entry.at - T0) / HOUR) ? (entry.at - T0) / HOUR : 'x'} ${entry.kind} ${entry.subject === callerId ? 'caller' : entry.subject}`
      assert.deepEqual(journey.entries.map(say), [
        '0 visit visitor:j', '0 sighting visitor:j', '1 sighting visitor:j', 'x call caller', '3 call caller', '5 consent contact:j', '5 sighting contact:j', '6 outcome contact:j', '30 value contact:j', '31 decision contact:j',
      ])
      assert.deepEqual([journey.next, journey.more], [null, 0])
      const [tap, miss, step, value] = [journey.entries[2], journey.entries[3], journey.entries[7], journey.entries[8]] as any[]
      assert.deepEqual([tap.event, tap.identifiers.length], ['phone_click', 2])
      assert.deepEqual([miss.call.id, miss.call.visitor, miss.followUp.state, miss.call.tags], ['J1', 'visitor:j', 'returned', { language: 'es' }])
      assert.deepEqual([step.first.value, step.outcome.value, value.from.value, value.to.value], [100, 250, 100, 250])
      // Why each subject is this person: itself, and by what it is tied.
      assert.deepEqual(Object.keys(journey.subjects).sort(), [callerId, 'contact:j', 'visitor:j'].sort())
      assert.deepEqual([journey.subjects['contact:j']!.how, journey.subjects['contact:j']!.score], ['self', 1])
      const tie = journey.subjects['visitor:j']!
      assert.deepEqual([tie.how, tie.kinds, tie.via], ['cluster', ['device'], ['contact:j']])
      assert.ok(tie.score! > 0.9)
      // Asked of any of them, it is the same story.
      assert.deepEqual((await graph.journey('visitor:j')).entries.map(say), journey.entries.map(say))

      // A page holds the newest, and ends between moments and not inside one.
      const page = await graph.journey('contact:j', { limit: 4 })
      assert.deepEqual(page.entries.map((entry) => entry.kind), ['consent', 'sighting', 'outcome', 'value', 'decision'])
      const before = await graph.journey('contact:j', { limit: 99, before: page.next! })
      assert.deepEqual([...before.entries, ...page.entries].map(say), journey.entries.map(say))

      assert.deepEqual((await graph.journey('nobody')).entries, [])
      // What was forgotten is in no journey but for the decision to forget it.
      await graph.forget('visitor:j')
      assert.equal((await graph.journey('contact:j')).entries.some((entry) => entry.subject === 'visitor:j'), false)
      await graph.forget('contact:j')
      assert.deepEqual((await graph.journey('contact:j')).entries.map((entry) => entry.kind), ['decision', 'decision'])
    })

    test('a journey is the whole cluster\'s, whoever of it is asked about, and a path through somebody kept apart does not hide a direct one', async () => {
      const { graph } = await fresh()
      const see = (subject: string, ...identifiers: string[]) => graph.observe({ subject, identifiers, at: T0, event: 'visit' })
      // A chain of four: each shares a device with the next, so the ends are three links apart.
      await see('w:1', 'device:12')
      await see('w:2', 'device:12', 'device:23')
      await see('w:3', 'device:23', 'device:34')
      await see('w:4', 'device:34')
      const asked = await graph.journey('w:1')
      assert.deepEqual(asked.entries.map((entry) => entry.subject), ['w:1', 'w:2', 'w:3', 'w:4'])
      assert.deepEqual([asked.subjects['w:4']!.how, asked.subjects['w:4']!.via, asked.subjects['w:4']!.kinds], ['cluster', ['w:1', 'w:2', 'w:3'], ['device']])
      assert.ok(asked.subjects['w:4']!.score! > 0.8)
      // Four of one person, and y kept apart from one of them, with a cut between. x is tied to one of the four only, and z best through y.
      for (const each of ['a:1', 'a:2', 'a:3', 'a:4']) await see(each, 'device:a', 'email:a')
      await see('a:1', 'device:y', 'device:z')
      await see('y', 'device:y', 'email:yz', 'device:yz')
      await see('z', 'device:z', 'email:yz', 'device:yz')
      await see('x', 'device:yz', 'device:x')
      await see('a:4', 'device:x')
      await graph.separate('a:2', 'y', true)
      assert.notEqual((await graph.cluster('a:1'))!.id, (await graph.cluster('z'))!.id)
      const people = async (subject: string) => Object.keys((await graph.journey(subject)).subjects).sort()
      for (const each of ['a:1', 'a:2', 'a:3', 'a:4']) assert.deepEqual(await people(each), ['a:1', 'a:2', 'a:3', 'a:4', 'x', 'z'])
      assert.deepEqual((await graph.journey('a:3')).subjects.x!.via, ['a:4'])
      // A sighting called after a call or a review that no call or decision tells stays.
      await graph.observe({ subject: 'w:1', identifiers: ['device:12'], at: T0 + 1, event: 'call' })
      await graph.observe({ subject: 'w:1', identifiers: ['device:12'], at: T0 + 2, event: 'review' })
      assert.deepEqual((await graph.journey('w:1')).entries.slice(-2).map((entry) => entry.kind === 'sighting' && entry.event), ['call', 'review'])
      await assert.rejects(graph.journey('w:1', { limit: 0 }), TypeError)
    })

    test('a chain of links is never longer than was asked for, whatever its subjects are called', async () => {
      for (const [x, y] of [['m:1', 'm:2'], ['m:2', 'm:1']] as const) {
        const { graph } = await fresh()
        const see = (subject: string, ...identifiers: string[]) => graph.observe({ subject, identifiers, at: T0, event: 'visit' })
        // From s, x is the better way to y than y itself, and z is one link past y.
        await see('s', 'device:sx', 'email:sx', 'phone:sy')
        await see(x, 'device:sx', 'email:sx', 'device:xy', 'email:xy')
        await see(y, 'phone:sy', 'device:xy', 'email:xy', 'device:yz')
        await see('z', 'device:yz')
        await graph.touch({ subject: 'z', at: T0, gclid: 'Z' })
        const { touches } = await graph.attribute('s', { at: T0 + 1, hops: 2 })
        assert.deepEqual(touches.map((touch) => touch.via), [['s', y]])
        assert.ok(touches[0]!.confidence < 0.9)
      }
    })

    test('the review queue pages, subjects are found by prefix, and recent changes are listed', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      // Three clusters of sizes 3, 2 and 2, and one account on its own.
      await graph.observe(chain('email', 'team:a', 'team:b', 'team:c'))
      clock.now = T0 + HOUR
      await graph.observe(chain('email', 'pair:x', 'pair:y'))
      await graph.observe(chain('email', 'duo:m', 'duo:n'))
      await graph.observe({ subject: 'solo%', identifiers: ['email:solo'], at: T0 })

      assert.deepEqual((await graph.clusters(2)).map((c) => c.id), ['team:a', 'duo:m'])
      assert.deepEqual((await graph.clusters(2, 2)).map((c) => c.id), ['pair:x'])
      assert.deepEqual(await graph.clusters(2, 3), [])

      assert.deepEqual(await graph.search('team:'), ['team:a', 'team:b', 'team:c'])
      assert.deepEqual(await graph.search('pair:', 1), ['pair:x'])
      // A percent sign means itself, not "anything".
      assert.deepEqual(await graph.search('solo%'), ['solo%'])
      assert.deepEqual(await graph.search('%'), [])
      assert.deepEqual(await graph.search('nobody'), [])

      // An ad click id is found whole, in whichever field it came, and goes with whoever is forgotten.
      for (const [subject, click] of [['team:b', { gclid: 'Click-1' }], ['team:a', { fbclid: 'Click-1', msclkid: 'ms-2' }], ['team:a', { fbclid: 'Click-1' }], ['team:c', { campaign: 'Click-1' }]] as const) await graph.touch({ subject, at: T0, ...click })
      assert.deepEqual([await graph.clicked('Click-1'), await graph.clicked('Click-1', 1), await graph.clicked('ms-2')], [['team:a', 'team:b'], ['team:a'], ['team:a']])
      assert.deepEqual([await graph.clicked('Click'), await graph.clicked('click-1'), await graph.clicked('%')], [[], [], []])

      const recent = await graph.recent()
      assert.deepEqual(recent.map((move) => [move.subject, move.from, move.to, move.at]), [
        ['duo:n', 'duo:n', 'duo:m', T0 + HOUR],
        ['pair:y', 'pair:y', 'pair:x', T0 + HOUR],
        ['team:c', 'team:c', 'team:a', T0],
        ['team:b', 'team:b', 'team:a', T0],
      ])
      assert.equal((await graph.recent(1)).length, 1)
      // A system that keeps the number it got to reads each change once, whatever size its pages are.
      const read = async (from: number) => {
        const out = []
        for (let page = await graph.changes({ after: from, limit: 3 }); ; page = await graph.changes({ after: page.next, limit: 3 })) {
          out.push(...page.changes)
          if (!page.more) return { out, next: page.next }
        }
      }
      const all = await read(0)
      assert.deepEqual(all.out.slice(-4).reverse().map(({ seq: _, ...move }) => move), recent.slice(0, 4))
      assert.deepEqual([...all.out].sort((x, y) => x.seq - y.seq), all.out)
      // Followed from the start, the changes say where everyone is: whoever they never named is on their own.
      const followed = new Map(all.out.map((move) => [move.subject, move.to]))
      for (const name of ['team', 'duo', 'pair', 'solo']) for (const subject of await graph.search(`${name}:`)) assert.equal(followed.get(subject) ?? subject, (await graph.cluster(subject))?.id ?? subject)
      assert.deepEqual(await graph.changes({ after: all.next }), { changes: [], next: all.next, more: false })
      for (const bad of [-1, 1.5, NaN]) await assert.rejects(graph.changes({ after: bad }), TypeError)
      await graph.forget('pair:y')
      assert.equal((await graph.recent()).some((move) => move.subject === 'pair:y'), false)
      // Numbers are not used again, so what comes after a deletion is still after where the reader got to.
      assert.equal((await read(0)).out.some((move) => move.subject === 'pair:y'), false)
      await graph.observe([{ subject: 'late:1', identifiers: ['device:late'], at: T0 }, { subject: 'late:2', identifiers: ['device:late'], at: T0 }])
      assert.deepEqual((await read(all.next)).out.map((move) => move.subject).filter((subject) => subject.startsWith('late:')), ['late:2'])
    })

    test('reviewer decisions become the checked pairs that set the weights', async () => {
      const { graph } = await fresh()
      // Reviewers looked at pairs that shared a canvas hash: three were one person, five were not.
      for (let n = 0; n < 8; n++) {
        await graph.observe([
          { subject: `left:${n}`, identifiers: [`canvas:c${n}`], at: T0 },
          { subject: `right:${n}`, identifiers: [`canvas:c${n}`], at: T0 },
        ])
        if (n < 3) await graph.join(`left:${n}`, `right:${n}`)
        else await graph.separate(`left:${n}`, `right:${n}`)
      }
      // A decision that was withdrawn, and a pair that shares nothing, say nothing.
      await graph.separate('left:7', 'right:7', false)
      await graph.join('left:0', 'left:1')

      const reviewed = await graph.reviewed()
      assert.equal(reviewed.length, 7)
      assert.deepEqual(reviewed.map((pair) => pair.same).sort(), [false, false, false, false, true, true, true])
      // The reviewer's own join mark is the answer, not evidence, so it is not among the reasons.
      assert.ok(reviewed.every((pair) => pair.reasons.length === 1 && pair.reasons[0]!.identifier.startsWith('canvas:')))

      const fitted = fit(reviewed, defaultPolicy)
      assert.equal(fitted.kinds.canvas!.pairs, 7)
      assert.ok(fitted.kinds.canvas!.after < 0.5 && fitted.kinds.canvas!.after > 0.35, String(fitted.kinds.canvas!.after))
    })

    test('a list of pairs from a system is decided in one write, once, and told apart from people', async () => {
      const { graph, store } = await fresh()
      let writes = 0
      const counted = createGraph({ ...store, write: (work) => (writes++, store.write(work)) })
      const shared = (subject: string, ...identifiers: string[]) => ({ subject, identifiers, at: T0 })
      // Two people on opposite sides share a phone; one of them is on file twice, under one email.
      await graph.observe([shared('contact:p', 'phone:h'), shared('contact:r', 'phone:h', 'email:r'), shared('contact:r2', 'email:r'), shared('contact:x', 'phone:z'), shared('contact:y', 'phone:z')])
      assert.deepEqual(await members(graph, 'contact:p'), ['contact:p', 'contact:r', 'contact:r2'])
      const list = [{ a: 'contact:r', b: 'contact:p', reason: 'sides of one matter' }, { a: 'contact:p', b: 'contact:r2' }, { a: 'contact:y', b: 'contact:x' }]
      const first = await counted.separateAll(list, { by: 'system:cases', reason: 'intake check' })
      assert.deepEqual([first.recorded, first.already, writes], [3, 0, 1])
      assert.deepEqual(await members(graph, 'contact:p'), ['contact:p'])
      assert.deepEqual(await members(graph, 'contact:r'), ['contact:r', 'contact:r2'])
      assert.deepEqual(await members(graph, 'contact:x'), ['contact:x'])
      assert.deepEqual((await graph.decisions()).map((d) => [d.action, d.about, d.by, d.reason]), [
        ['separate', ['contact:p', 'contact:r'], 'system:cases', 'sides of one matter'],
        ['separate', ['contact:p', 'contact:r2'], 'system:cases', 'intake check'],
        ['separate', ['contact:x', 'contact:y'], 'system:cases', 'intake check'],
      ])
      // The whole list sent again decides nothing.
      assert.deepEqual(await graph.separateAll(list, { by: 'system:cases' }), { changes: [], recorded: 0, already: 3 })
      // A duplicate record of one side that turns up later still joins that side, and not the other.
      await graph.observe(shared('contact:r3', 'phone:new', 'email:r'))
      assert.deepEqual(await members(graph, 'contact:r3'), ['contact:r', 'contact:r2', 'contact:r3'])
      // Withdrawn, they may join again. A withdrawal of what was never said is nothing.
      const back = await graph.separateAll([{ a: 'contact:x', b: 'contact:y', separated: false }, { a: 'contact:x', b: 'contact:p', separated: false }], { by: 'system:cases' })
      assert.deepEqual([back.recorded, back.already], [1, 1])
      assert.deepEqual(await members(graph, 'contact:x'), ['contact:x', 'contact:y'])
      // One bad pair and nothing of the list is written.
      const before = (await graph.decisions()).length
      await assert.rejects(graph.separateAll([{ a: 'contact:x', b: 'contact:p' }, { a: 'contact:x', b: 'contact:x' }]), TypeError)
      assert.equal((await graph.decisions()).length, before)

      // Named twice, a pair is taken in order from how it stood: already apart, so the first says nothing new.
      await graph.separateAll([{ a: 'contact:x', b: 'contact:y' }, { a: 'contact:y', b: 'contact:x', separated: false }, { a: 'contact:x', b: 'contact:y' }, { a: 'contact:x', b: 'contact:y' }], { by: 'system:cases' })
      assert.deepEqual((await graph.decisionPage({ limit: 3 })).map((d) => d.action), ['separate', 'rejoin', 'separate'])
      const twice = await graph.separateAll([{ a: 'contact:x', b: 'contact:y' }, { a: 'contact:x', b: 'contact:y', separated: false }], { by: 'system:cases' })
      assert.deepEqual([twice.recorded, (await graph.decisionPage({ limit: 1 }))[0]!.action], [1, 'rejoin'])

      // Two records merged elsewhere are joined here, and neither is forgotten.
      const joined = await graph.joinAll([{ a: 'contact:m2', b: 'contact:m1' }, { a: 'contact:m2', b: 'contact:m3' }], { by: 'system:crm' })
      assert.deepEqual([joined.recorded, joined.already], [2, 0])
      assert.deepEqual(await members(graph, 'contact:m1'), ['contact:m1', 'contact:m2', 'contact:m3'])
      assert.equal((await graph.joinAll([{ a: 'contact:m1', b: 'contact:m2' }], { by: 'system:crm' })).already, 1)
      // Muting the join undoes it, so the same report is news again.
      await graph.ignore((await graph.history('contact:m1'))[0]!.identifier)
      assert.equal((await graph.joinAll([{ a: 'contact:m1', b: 'contact:m2' }], { by: 'system:crm' })).recorded, 1)
      // So is a separation whose subject was forgotten and came back.
      await graph.forget('contact:r')
      await graph.observe(shared('contact:r', 'phone:h'))
      assert.equal((await graph.separateAll([list[0]!], { by: 'system:cases' })).recorded, 1)
      assert.deepEqual(await members(graph, 'contact:p'), ['contact:p'])

      // Decisions come a page at a time, newest first, by people or by systems.
      await graph.separate('contact:m1', 'contact:x', true, { by: 'dana' })
      const page = await graph.decisionPage({ limit: 2 })
      assert.deepEqual(page.map((d) => [d.action, d.by]), [['separate', 'dana'], ['separate', 'system:cases']])
      assert.deepEqual((await graph.decisionPage({ limit: 1, before: page[1]!.seq })).map((d) => d.action), ['forget'])
      assert.deepEqual((await graph.decisionPage({ limit: 9, author: 'people' })).map((d) => d.action), ['separate', 'forget', 'ignore'])
      assert.ok((await graph.decisionPage({ limit: 99, author: 'system' })).every((d) => d.by!.startsWith('system:')))
      assert.equal((await graph.decisionPage({ limit: 99, author: 'system:crm' })).length, 3)
      // What systems said can be left out of the pairs the weights are fitted to.
      const people = await graph.reviewed({ exclude: 'system:' })
      assert.ok((await graph.reviewed()).length > people.length)
      assert.deepEqual(await graph.verify(), [])
      assert.equal((await graph.audit()).sound, true)
    })

    test('a pair that systems keep reversing is flagged', async () => {
      const { graph } = await fresh()
      const pair = [{ a: 'contact:1', b: 'contact:2' }]
      const cases = () => graph.separateAll(pair, { by: 'system:cases' })
      const crm = () => graph.joinAll(pair, { by: 'system:crm' })
      await cases()
      await crm()
      await cases()
      // Sent again unchanged, it is not another reversal, and neither is what a person decides.
      await cases()
      await graph.join('contact:1', 'contact:2', { by: 'dana' })
      await cases()
      assert.deepEqual(await graph.disputes(), [])
      await crm()
      const [found] = await graph.disputes()
      assert.deepEqual([found!.a, found!.b, found!.reversals, found!.last.action, found!.last.by], ['contact:1', 'contact:2', 3, 'join', 'system:crm'])
      // The join is the last word on the record, and the separation is still what holds.
      assert.deepEqual([found!.apart!.by, await graph.separations('contact:1')], ['system:cases', ['contact:2']])
      await cases()
      // However often the system reported it, the join is one mark beside dana's own.
      const marks = (await graph.history('contact:1')).filter((sighting) => sighting.identifier.startsWith('review:')).map((sighting) => sighting.identifier)
      assert.equal(marks.length, 2)
      assert.deepEqual((await graph.verdicts([['contact:2', 'contact:1'], ['contact:1', 'contact:3']])).map((each) => [each.a, each.b, each.last.action]), [['contact:1', 'contact:2', 'separate']])
    })

    test('a cluster past the review size is flagged', async () => {
      const { graph } = await fresh({ ...defaultPolicy, review: 3 })
      for (const n of [1, 2, 3]) await graph.observe({ subject: `account:${n}`, identifiers: ['device:d'], at: T0 })
      assert.equal((await graph.cluster('account:1'))!.oversized, false)
      await graph.observe({ subject: 'account:4', identifiers: ['device:d'], at: T0 })
      assert.equal((await graph.cluster('account:1'))!.oversized, true)
    })

    test('a flow sent twice is counted once, and its id is kept for it', async () => {
      const { graph } = await fresh()
      const flow = { id: 'trade 1:a', from: 'a', to: 'b', amount: 500, at: T0, asset: 'gold' }
      assert.equal((await graph.transfer(flow)).duplicate, false)
      const again = await graph.transfer(flow)
      assert.deepEqual([again.duplicate, again.subject, again.sent, again.count], [true, 'b', 500, 1])
      // Sent many times at once, as by a client that gave up waiting.
      const many = await Promise.all(Array.from({ length: 8 }, () => graph.transfer({ ...flow, id: 'trade 2' })))
      assert.equal(many.filter((each) => !each.duplicate).length, 1)
      const total = async () => (await graph.flows('a')).map((row) => [row.subject, row.asset, row.sent, row.received, row.count])
      assert.deepEqual(await total(), [['b', 'gold', 1000, 0, 2]])

      for (const other of [{ from: 'c' }, { to: 'c' }, { amount: 501 }, { at: T0 + 1 }, { asset: 'silver' }, { asset: undefined }]) await assert.rejects(graph.transfer({ ...flow, ...other } as typeof flow), /different details/)
      for (const id of [undefined, '', ' ', 7, null, 'x'.repeat(201), 'a\0', '\ud800']) await assert.rejects(graph.transfer({ ...flow, id } as typeof flow), TypeError)
      await assert.rejects(graph.transfer({ ...flow, id: 'x', asset: 7 as unknown as string }), TypeError)
      assert.deepEqual(await total(), [['b', 'gold', 1000, 0, 2]])
      assert.deepEqual(await graph.flows('c'), [])

      // Nothing of a forgotten subject is kept, the ids of its flows included, whichever side it was on.
      await graph.transfer({ ...flow, id: 'trade 3', from: 'z', to: 'a' })
      await graph.forget('a')
      for (const id of ['trade 1:a', 'trade 2', 'trade 3']) assert.equal((await graph.transfer({ id, from: 'm', to: 'n', amount: 1, at: T0 })).duplicate, false)
    })

    test('value moving between tied accounts is reported with the tie', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'a', identifiers: ['hardware:h', 'canvas:c', 'ip:198.51.100.9'], at: T0 },
        { subject: 'b', identifiers: ['hardware:h'], at: T0 },
        { subject: 'd', identifiers: ['canvas:c', 'ip:198.51.100.9'], at: T0 },
        { subject: 'stranger', identifiers: ['email:s'], at: T0 },
      ])
      const first = await graph.transfer({ id: 'f1', from: 'a', to: 'b', amount: 500, at: T0 })
      assert.equal(first.relation, 'same')
      assert.equal(first.score, 0.95)
      assert.deepEqual(first.reasons.map((reason) => reason.identifier), ['hardware:h'])
      assert.deepEqual([first.sent, first.received, first.count, first.imbalance], [500, 0, 1, 1])

      await graph.transfer({ id: 'f2', from: 'a', to: 'b', amount: 500, at: T0 + HOUR })
      await graph.transfer({ id: 'f3', from: 'b', to: 'a', amount: 200, at: T0 + 2 * HOUR })
      await graph.transfer({ id: 'f4', from: 'a', to: 'stranger', amount: 5000, at: T0 })
      await graph.transfer({ id: 'f5', from: 'd', to: 'a', amount: 40, at: T0, asset: 'gold' })
      assert.equal((await graph.transfer({ id: 'f6', from: 'a', to: 'unknown', amount: 1, at: T0 })).relation, 'none')

      const flows = await graph.flows('a')
      assert.deepEqual(
        flows.map((row) => [row.subject, row.asset, row.relation, row.sent, row.received, row.count]),
        [
          ['stranger', '', 'none', 5000, 0, 1],
          ['b', '', 'same', 1000, 200, 3],
          ['d', 'gold', 'related', 0, 40, 1],
          ['unknown', '', 'none', 1, 0, 1],
        ],
      )
      assert.ok(Math.abs(flows[1]!.imbalance - 800 / 1200) < 1e-12)
      assert.deepEqual([flows[1]!.first, flows[1]!.last], [T0, T0 + 2 * HOUR])
      assert.deepEqual((await graph.collusion('a')).map((row) => row.subject), ['b'])
      assert.deepEqual((await graph.collusion('a', 1)).map((row) => row.subject), ['b', 'd'])
      assert.deepEqual((await graph.flows('b')).map((row) => [row.subject, row.sent, row.received]), [['a', 200, 1000]])

      await assert.rejects(graph.transfer({ id: 'f7', from: 'a', to: 'a', amount: 1, at: T0 }), TypeError)
      await assert.rejects(graph.transfer({ id: 'f8', from: 'a', to: 'b', amount: 1.5, at: T0 }), TypeError)
      await assert.rejects(graph.transfer({ id: 'f9', from: 'a', to: 'b', amount: 0, at: T0 }), TypeError)

      await graph.forget('b')
      assert.equal((await graph.flows('a')).some((row) => row.subject === 'b'), false)
    })

    test('value that goes round in a circle is found, with the least that made the trip', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'a', identifiers: ['hardware:h'], at: T0 },
        { subject: 'b', identifiers: ['hardware:h'], at: T0 },
      ])
      let paid = 0
      const pay = (from: string, to: string, amount: number, asset?: string) => graph.transfer({ id: `p${paid++}`, from, to, amount, at: T0, ...(asset && { asset }) })
      // a -> b -> c -> a, and a second, smaller ring a -> d -> a.
      await pay('a', 'b', 900)
      await pay('b', 'c', 700)
      await pay('c', 'a', 800)
      await pay('a', 'd', 50)
      await pay('d', 'a', 60)
      // Loose ends that close nothing: a pays e, f pays a, and silver moves one way.
      await pay('a', 'e', 5000)
      await pay('f', 'a', 5000)
      await pay('a', 'b', 400, 'silver')
      await pay('b', 'c', 400, 'silver')

      assert.deepEqual(await graph.rings('a'), [
        { subjects: ['a', 'b', 'c'], asset: '', amount: 700, tied: 1 },
        { subjects: ['a', 'd'], asset: '', amount: 50, tied: 0 },
      ])
      // The same ring seen from another member starts with that member.
      assert.deepEqual(await graph.rings('c'), [{ subjects: ['c', 'a', 'b'], asset: '', amount: 700, tied: 0 }])
      assert.deepEqual(await graph.rings('e'), [])
      assert.deepEqual(await graph.rings('nobody'), [])
      // A ring of three is not found when rings are limited to two.
      assert.deepEqual((await graph.rings('a', 2)).map((ring) => ring.subjects), [['a', 'd']])

      // A ring of five needs a longer reach than the default of four.
      for (const [from, to] of [['p', 'q'], ['q', 'r'], ['r', 's'], ['s', 't'], ['t', 'p']]) await pay(from!, to!, 10)
      assert.deepEqual(await graph.rings('p'), [])
      assert.deepEqual((await graph.rings('p', 5)).map((ring) => ring.subjects), [['p', 'q', 'r', 's', 't']])
    })

    test('the listener hears each cluster change after it commits', async () => {
      const heard: Change[][] = []
      const { graph } = await fresh(undefined, { onChange: (changes) => void heard.push(changes) })
      await graph.observe({ subject: 'account:1', identifiers: ['email:e'], at: T0 })
      assert.equal(heard.length, 0)
      await graph.observe({ subject: 'account:2', identifiers: ['email:e'], at: T0 })
      assert.deepEqual(heard, [[{ subject: 'account:2', from: 'account:2', to: 'account:1' }]])
      await graph.separate('account:1', 'account:2')
      assert.equal(heard.length, 2)
    })

    test('every decision is recorded, sealed, and can be replayed to see the past', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      await graph.observe([
        { subject: 'a', identifiers: ['email:shared'], at: T0 },
        { subject: 'b', identifiers: ['email:shared'], at: T0 },
      ])
      clock.now = T0 + 10 * DAY
      await graph.observe({ subject: 'c', identifiers: ['email:shared'], at: T0 + 10 * DAY })
      clock.now = T0 + 20 * DAY
      await graph.ignore('email:shared', true, { by: 'dana', reason: 'front desk mailbox' })
      clock.now += DAY
      await graph.separate('b', 'a', true, { by: 'dana' })
      await graph.forget('nobody')

      const decisions = await graph.decisions()
      assert.deepEqual(
        decisions.map(({ seq, at, action, about, by, reason }) => ({ seq, at, action, about, by, reason })),
        [
          { seq: 1, at: T0 + 20 * DAY, action: 'ignore', about: ['email:shared'], by: 'dana', reason: 'front desk mailbox' },
          { seq: 2, at: T0 + 21 * DAY, action: 'separate', about: ['a', 'b'], by: 'dana', reason: undefined },
          { seq: 3, at: T0 + 21 * DAY, action: 'forget', about: ['nobody'], by: undefined, reason: undefined },
        ],
      )
      assert.equal((await graph.audit()).sound, true)
      // Altering or dropping an entry breaks the seal from that point on.
      assert.equal(brokenAt(decisions.map((d) => (d.seq === 1 ? { ...d, reason: 'edited' } : d))), 1)
      assert.equal(brokenAt(decisions.filter((d) => d.seq !== 2)), 3)

      // Before c appeared; after c, before the mailbox was ignored; and after.
      assert.deepEqual((await (await graph.asOf(T0 + 5 * DAY)).cluster('a'))!.members, ['a', 'b'])
      assert.equal(await (await graph.asOf(T0 + 5 * DAY)).cluster('c'), undefined)
      assert.deepEqual((await (await graph.asOf(T0 + 15 * DAY)).cluster('a'))!.members, ['a', 'b', 'c'])
      assert.deepEqual((await (await graph.asOf(T0 + 20 * DAY)).cluster('a'))!.members, ['a'])
      assert.deepEqual((await graph.cluster('a'))!.members, ['a'])
    })

    test('the past is what had been written down, not what had happened', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      await graph.observe({ subject: 'a', identifiers: ['email:late'], at: T0 })
      // b did this on day 1, but the record of it only arrived on day 30.
      clock.now = T0 + 30 * DAY
      await graph.observe({ subject: 'b', identifiers: ['email:late'], at: T0 + DAY, event: 'import' })
      assert.deepEqual(await graph.history('b'), [{ subject: 'b', identifier: 'email:late', at: T0 + DAY, event: 'import', recorded: T0 + 30 * DAY }])

      // On day 15 nobody knew about b, so a decision made then could not have rested on it.
      assert.deepEqual((await (await graph.asOf(T0 + 15 * DAY)).cluster('a'))!.members, ['a'])
      assert.deepEqual((await (await graph.asOf(T0 + 30 * DAY)).cluster('a'))!.members, ['a', 'b'])
    })

    test('every answer about advertising is kept, and the newest by when it was given stands', async () => {
      const clock = { now: T0 + 10 * DAY }
      const given = [
        { at: T0 + DAY, adUserData: true, adPersonalization: true, source: 'banner' },
        { at: T0 + 3 * DAY, adUserData: false, adPersonalization: false, source: 'browser signal' },
        { at: T0 + 2 * DAY, adUserData: true, adPersonalization: false, source: 'form' },
      ]
      // Whatever order they arrive in, the same one stands and the history reads the same.
      for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
        const { graph } = await fresh(undefined, { now: () => clock.now })
        for (const n of order) await graph.consent('a', given[n]!, { at: given[n]!.at, source: given[n]!.source })
        assert.deepEqual((await graph.consentOf(['a', 'b'])), new Map([['a', { adUserData: false, adPersonalization: false }]]))
        assert.deepEqual((await graph.consentHistory('a')).map(({ recorded: _, ...answer }) => answer), [given[1], given[2], given[0]])
      }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      // Given at one moment, the one written down later stands; written down at one moment too, the refusal does.
      await graph.consent('a', { adUserData: false, adPersonalization: false }, { at: T0 })
      clock.now += 1
      await graph.consent('a', { adUserData: true, adPersonalization: true }, { at: T0 })
      assert.equal((await graph.consentOf(['a'])).get('a')!.adUserData, true)
      await graph.consent('a', { adUserData: false, adPersonalization: true }, { at: T0 })
      await graph.consent('a', { adUserData: true, adPersonalization: false }, { at: T0 })
      assert.deepEqual((await graph.consentOf(['a'])).get('a'), { adUserData: false, adPersonalization: true })
      // With no time given it is now. A time ahead would stand over every real answer, so it is refused.
      await graph.consent('a', { adUserData: true, adPersonalization: true })
      assert.deepEqual((await graph.consentHistory('a'))[0], { at: clock.now, adUserData: true, adPersonalization: true, recorded: clock.now })
      for (const at of [clock.now + 2 * DAY, 0.5, -1, '1' as unknown as number]) await assert.rejects(graph.consent('a', { adUserData: true, adPersonalization: true }, { at }), TypeError)

      // Pruning keeps the answer that stands, however old.
      await graph.consent('old', { adUserData: false, adPersonalization: false }, { at: T0 })
      clock.now += 30 * DAY
      await graph.consent('a', { adUserData: false, adPersonalization: false })
      assert.equal(await graph.prune(clock.now), 5)
      assert.deepEqual([(await graph.consentHistory('a')).length, (await graph.consentHistory('old')).length], [1, 1])
      assert.equal((await graph.consentOf(['old'])).get('old')!.adUserData, false)
      // Forgetting deletes the history, and that deletion is on the record.
      await graph.forget('a')
      assert.deepEqual(await graph.consentHistory('a'), [])
      assert.deepEqual((await graph.decisionPage({ limit: 1 })).map((d) => [d.action, d.about]), [['forget', ['a']]])
      // The newest entry's hash is what to keep a copy of.
      const audit = await graph.audit()
      assert.deepEqual([audit.sound, audit.head], [true, { seq: 2, hash: (await graph.decisionPage({ limit: 1 }))[0]!.hash }])
    })

    test('pruning deletes old sightings and leaves links and clusters alone', async () => {
      const clock = { now: T0 }
      const { graph } = await fresh(undefined, { now: () => clock.now })
      await graph.observe([
        { subject: 'a', identifiers: ['email:e', 'ip:198.51.100.3'], at: T0 },
        { subject: 'b', identifiers: ['email:e'], at: T0 },
      ])
      clock.now = T0 + 100 * DAY
      await graph.observe({ subject: 'a', identifiers: ['email:e'], at: T0 + 100 * DAY })
      const links = await graph.links('a')

      assert.equal(await graph.prune(T0 + 50 * DAY, { by: 'ops', reason: '90 day retention' }), 3)
      assert.equal(await graph.prune(T0 + 50 * DAY), 0)
      assert.deepEqual((await graph.history('a')).map((s) => s.at), [T0 + 100 * DAY])
      assert.deepEqual(await graph.history('b'), [])
      // What the graph believes is unchanged.
      assert.deepEqual(await graph.links('a'), links)
      assert.deepEqual((await graph.cluster('b'))!.members, ['a', 'b'])
      assert.deepEqual(await graph.verify(), [])
      assert.deepEqual((await graph.decisions()).map((d) => [d.action, d.about, d.by]), [
        ['prune', [String(T0 + 50 * DAY)], 'ops'],
        ['prune', [String(T0 + 50 * DAY)], undefined],
      ])
      await assert.rejects(graph.prune(Number.NaN), TypeError)
    })

    test('an identifier of an unknown kind is refused and nothing is written', async () => {
      const { graph } = await fresh()
      await assert.rejects(graph.observe({ subject: 'a', identifiers: ['constructor:x'], at: T0 }), TypeError)
      await assert.rejects(graph.observe({ subject: 'account:1', identifiers: ['email:a', 'shoe:9'], at: T0 }), TypeError)
      assert.equal(await graph.cluster('account:1'), undefined)
    })

    test('a check finds what is wrong wherever it is, and a rebuild puts it right', async () => {
      const next = random(11)
      const { graph, store } = await fresh()
      await graph.observe(Array.from({ length: 150 }, (): Observation => ({
        subject: `account:${Math.floor(next() * 60)}`,
        identifiers: [`email:${Math.floor(next() * 40)}`, `canvas:${Math.floor(next() * 12)}`, `ip:${Math.floor(next() * 9)}`],
        at: T0 + Math.floor(next() * 30) * DAY,
      })))
      await graph.separate('account:1', 'account:2')
      await graph.ignore('email:3')
      assert.deepEqual(await graph.verify(), [])
      // One split off from its own, and one put with a stranger.
      const before = new Map<string, { component: string; cluster: string } | undefined>()
      await store.read(async (tx) => {
        for await (const batch of tx.everyone()) for (const { subject, labels } of batch) before.set(subject, labels)
      })
      const joined = [...before].filter(([subject, labels]) => labels!.cluster !== subject).map(([subject]) => subject).sort()
      const single = [...before].filter(([subject, labels]) => labels!.cluster === subject && ![...before.values()].some((other, i) => [...before.keys()][i] !== subject && other!.cluster === subject)).map(([subject]) => subject).sort()
      assert.ok(joined.length > 0 && single.length > 1)
      await store.write((tx) => tx.setLabels(new Map([[joined[0]!, { component: joined[0]!, cluster: joined[0]! }], [single[0]!, { component: single[1]!, cluster: single[1]! }]])))
      assert.deepEqual((await graph.verify()).map((change) => [change.subject, change.to]), [joined[0]!, single[0]!].sort().map((subject) => [subject, before.get(subject)!.cluster]))
      assert.deepEqual((await graph.rebuild()).map((change) => change.subject), [joined[0]!, single[0]!].sort())
      assert.deepEqual(await graph.verify(), [])
      assert.deepEqual(await graph.rebuild(), [])
      // A kind the policy no longer names is refused where it would link, and not passed over.
      const card = { weight: 0.95, dilution: 0, cap: 10, halfLife: Infinity }
      const wide = createGraph(store, { ...defaultPolicy, kinds: { ...defaultPolicy.kinds, card } })
      await wide.observe([{ subject: 'z:1', identifiers: ['card:x'], at: T0 }, { subject: 'z:2', identifiers: ['card:x'], at: T0 }, { subject: 'z:3', identifiers: ['card:y'], at: T0 }])
      await assert.rejects(graph.verify(), /"card:x" has a kind that is missing from the policy/)
      await assert.rejects(graph.rebuild(), /"card:x" has a kind that is missing from the policy/)
      for (const subject of ['z:1', 'z:2', 'z:3']) await wide.forget(subject)
      // As of now, the copy is the graph, and it moved as often as if it had been read at once.
      const past = await graph.asOf(Date.now())
      assert.equal(await past.version(), 3)
      for (const subject of before.keys()) assert.deepEqual((await past.cluster(subject))!.members, (await graph.cluster(subject))!.members)
    })

    test('clusters do not depend on the order observations arrive in', async () => {
      const next = random(7)
      const observations: Observation[] = Array.from({ length: 120 }, () => ({
        subject: `account:${Math.floor(next() * 30)}`,
        identifiers: [`email:${Math.floor(next() * 12)}`, `fingerprint:${Math.floor(next() * 6)}`, `canvas:${Math.floor(next() * 6)}`, `ip:${Math.floor(next() * 4)}`],
        at: T0 + Math.floor(next() * 100) * DAY,
      }))
      const results: string[] = []
      for (let round = 0; round < 3; round++) {
        const { graph, store } = await fresh()
        const shuffled = [...observations].sort(() => next() - 0.5)
        for (const observation of shuffled) await graph.observe(observation)
        const clusters: unknown[] = []
        await store.read(async (tx) => {
          for await (const batch of tx.everyone()) clusters.push(...batch.map(({ subject, labels }) => [subject, labels]))
        })
        results.push(JSON.stringify(clusters.sort()))
      }
      assert.equal(results[1], results[0])
      assert.equal(results[2], results[0])
    })

    test('an enrollment is credited to the ad click made in the same browser', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'visitor:v1', identifiers: ['device:v1', 'fingerprint:f1', 'ip:198.51.100.7'], at: T0, event: 'visit' })
      await graph.touch({ subject: 'visitor:v1', at: T0, gclid: 'G1', source: 'google', medium: 'cpc' })
      await graph.observe({ subject: 'account:9', identifiers: ['device:v1', email('pat@example.com')], at: T0 + 2 * HOUR, event: 'enroll' })

      const attribution = await graph.attribute('account:9', { at: T0 + 2 * HOUR })
      assert.equal(attribution.reason, 'credited')
      assert.equal(attribution.credited!.gclid, 'G1')
      assert.deepEqual(attribution.credited!.via, ['account:9'])
      assert.ok(Math.abs(attribution.credited!.confidence - 0.98) < 1e-12)
      assert.equal((await graph.attribute('account:9', { at: T0 + 200 * DAY })).reason, 'no_touch')
      assert.equal((await graph.attribute('account:9', { at: T0 - HOUR })).reason, 'no_touch')
    })

    test('a click matched only by an unverified hash is reported but not credited', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'visitor:v2', identifiers: ['device:v2', 'canvas:c2', 'ip:198.51.100.8'], at: T0, event: 'visit' })
      await graph.touch({ subject: 'visitor:v2', at: T0, gclid: 'G2' })
      await graph.observe({ subject: 'account:10', identifiers: ['device:other', 'canvas:c2', 'ip:198.51.100.8'], at: T0, event: 'enroll' })

      const attribution = await graph.attribute('account:10', { at: T0 + HOUR })
      assert.equal(attribution.reason, 'low_confidence')
      assert.equal(attribution.credited, undefined)
      assert.equal(attribution.touches[0]!.gclid, 'G2')
      assert.ok(Math.abs(attribution.touches[0]!.confidence - 0.65) < 1e-12)
    })

    test('a click on another site is credited through a verified fingerprint', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'visitor:site-a', identifiers: ['device:site-a', 'fingerprint:f3'], at: T0, event: 'visit' })
      await graph.touch({ subject: 'visitor:site-a', at: T0, gclid: 'G3' })
      await graph.observe({ subject: 'account:11', identifiers: ['device:site-b', 'fingerprint:f3'], at: T0, event: 'enroll' })
      const attribution = await graph.attribute('account:11', { at: T0 + HOUR })
      assert.equal(attribution.credited!.gclid, 'G3')
      assert.ok(Math.abs(attribution.credited!.confidence - 0.97) < 1e-12)
    })

    test('a touch two links away keeps the product of both scores', async () => {
      const { graph } = await fresh()
      await graph.observe({ subject: 'visitor:a', identifiers: ['device:a', 'ga:1.1'], at: T0 })
      await graph.touch({ subject: 'visitor:a', at: T0, msclkid: 'M1' })
      await graph.observe({ subject: 'visitor:b', identifiers: ['device:b', 'ga:1.1'], at: T0 + HOUR })
      await graph.observe({ subject: 'account:5', identifiers: ['device:b'], at: T0 + 2 * HOUR })
      const attribution = await graph.attribute('account:5', { at: T0 + 2 * HOUR })
      assert.deepEqual(attribution.touches[0]!.via, ['account:5', 'visitor:b'])
      assert.ok(Math.abs(attribution.touches[0]!.confidence - 0.98 * 0.9) < 1e-12)
      // The two links make the three one cluster, so the ad is theirs, however the two multiply.
      assert.equal(attribution.touches[0]!.joined, true)
      assert.equal(attribution.reason, 'credited')
      // Kept apart, they are two people, and the chain goes nowhere.
      await graph.separate('account:5', 'visitor:a')
      assert.equal((await graph.attribute('account:5', { at: T0 + 2 * HOUR })).reason, 'no_touch')
    })

    test('an ad click is credited to a caller whose name was taken on the phone', async () => {
      const { graph } = await fresh()
      await graph.touch({ subject: 'visitor:1', at: T0, gclid: 'G1', source: 'google', campaignId: '30111' })
      await graph.observe({ subject: 'visitor:1', identifiers: ['device:1', dialed('+15550100101', T0)], at: T0, event: 'phone_click' })
      await recordCall(graph, { id: 'L1', from: '+15550100141', to: '+15550100101', at: T0 + 20_000, duration: 300 })
      await graph.observe({ subject: 'contact:7', identifiers: [`phone:${hashPhone('+15550100141')}`], at: T0 + HOUR, event: 'intake' })
      await graph.outcome({ transactionId: 'paid', subject: 'contact:7', at: T0 + DAY, stage: 'client', value: 1250, currency: 'USD' })
      const { credited } = await graph.attribute('contact:7', { at: T0 + DAY })
      assert.ok(Math.abs(credited!.confidence - 0.92 * 0.9) < 1e-12)
      const { rows } = await graph.report({ from: '2023-11-14', to: '2023-11-16' })
      assert.deepEqual(rows.filter((row) => row.value > 0).map((row) => [row.campaignId, row.value]), [['30111', 1250]])
    })

    test('a changed policy is noticed, and a rebuild brings every cluster to it', async () => {
      const { graph, store } = await fresh()
      assert.equal((await graph.policy()).due, false)
      const next = random(7)
      const pick = (count: number) => Math.floor(next() * count)
      for (let i = 0; i < 120; i++) await graph.observe({ subject: `account:${pick(30)}`, identifiers: [`phone:${pick(12)}`, `hardware:${pick(12)}`], at: T0 + i })
      const before = await graph.policy()
      assert.deepEqual([before.builtWith, before.due], [before.hash, false])
      assert.deepEqual(await graph.verify(), [])

      // The same database under another policy: scores follow it at once, stored clusters do not.
      const other: Policy = { ...defaultPolicy, kinds: { ...defaultPolicy.kinds, phone: { ...defaultPolicy.kinds.phone!, weight: 0.6 }, hardware: { ...defaultPolicy.kinds.hardware!, weight: 0.7 } } }
      const changed = createGraph(store, other)
      const state = await changed.policy()
      assert.deepEqual([state.builtWith, state.due], [before.hash, true])
      assert.notDeepEqual(await changed.verify(), [])
      // A write under it leaves clusters of both, and going back does not make that the first policy's work again.
      await changed.observe({ subject: 'account:1', identifiers: ['phone:1'], at: T0 })
      assert.equal((await graph.policy()).builtWith, 'mixed')
      assert.equal((await createGraph(store).policy()).due, true)

      await changed.rebuild({ by: 'ops' })
      const after = await changed.policy()
      assert.deepEqual([after.builtWith, after.due], [after.hash, false])
      assert.deepEqual(await changed.verify(), [])
      assert.equal((await graph.policy()).due, true)
      // A server still running the first policy writes after the rebuild: the clusters are no longer all of one policy.
      await graph.observe({ subject: 'account:2', identifiers: ['phone:2'], at: T0 })
      assert.equal((await changed.policy()).due, true)
      await changed.rebuild()
      // When the last subject is gone, whoever writes next starts afresh.
      const gone = await fresh()
      await gone.graph.observe({ subject: 'a', identifiers: ['phone:1'], at: T0 })
      await gone.graph.forget('a')
      const anew = createGraph(gone.store, other)
      await anew.observe({ subject: 'b', identifiers: ['phone:1'], at: T0 })
      assert.equal((await anew.policy()).due, false)
      // The caller's own copy of the policy can change without changing what this graph runs.
      const own = structuredClone(other)
      const fixed = createGraph(gone.store, own)
      ;(own.kinds as any).phone.weight = 0.1
      assert.equal((await fixed.policy()).rules.kinds.phone!.weight, 0.6)
      // The review size only flags clusters, so changing it calls for nothing.
      assert.equal((await createGraph(store, { ...other, review: 3 }).policy()).due, false)
    })

    test('nothing of one side is credited to the other, through a third subject either', async () => {
      const { graph } = await fresh()
      // A child is on file with each parent's email. The parents are on opposite sides, and one of them clicked the ad.
      await graph.observe([
        { subject: 'contact:p', identifiers: ['email:p'], at: T0 },
        { subject: 'contact:child', identifiers: ['email:p', 'email:r'], at: T0 },
        { subject: 'contact:r', identifiers: ['email:r'], at: T0 },
      ])
      await graph.touch({ subject: 'contact:p', at: T0, gclid: 'G1' })
      assert.equal((await graph.attribute('contact:r', { at: T0 + HOUR })).credited?.gclid, 'G1')
      await graph.separateAll([{ a: 'contact:p', b: 'contact:r' }], { by: 'system:cases' })
      assert.equal((await graph.attribute('contact:r', { at: T0 + HOUR })).reason, 'no_touch')
    })

    test('a household shares its phone, address and connection, and that is one fact', async () => {
      const household = policyFrom(JSON.parse(readFileSync(new URL('../examples/household.json', import.meta.url), 'utf8')))
      const cases: [string[], number, string, number, string][] = [
        [['phone:1'], 0.9, 'same', 0.85, 'related'],
        [['phone:1', 'address:1'], 0.96, 'same', 0.85, 'related'],
        [['phone:1', 'email:1'], 0.999, 'same', 0.9985, 'same'],
        [['ip:198.51.100.7', 'address:1'], 0.72, 'related', 0.6, 'related'],
      ]
      for (const [identifiers, score, level, inside, insideLevel] of cases) {
        for (const [policy, expected, reached] of [[undefined, score, level], [household, inside, insideLevel]] as const) {
          const { graph } = await fresh(policy)
          await graph.observe(['a', 'b'].map((subject) => ({ subject, identifiers, at: T0 })))
          const [link] = await graph.links('a')
          assert.ok(Math.abs(link!.score - expected) < 1e-9, `${identifiers} ${link!.score}`)
          assert.equal(link!.level, reached)
          // Every reason is there for a reviewer to see, whether or not it counted.
          assert.equal(link!.reasons.length, identifiers.length)
          assert.equal((await graph.cluster('a'))!.members.length, reached === 'same' ? 2 : 1)
        }
      }
      const { graph } = await fresh(household)
      await graph.observe(['a', 'b'].map((subject) => ({ subject, identifiers: ['phone:1', 'address:1'], at: T0 })))
      assert.deepEqual((await graph.links('a'))[0]!.reasons.map((reason) => [reason.identifier, reason.group, reason.counted]), [['phone:1', 'household', undefined], ['address:1', 'household', false]])
      // With the strongest muted, the next one counts.
      await graph.ignore('phone:1')
      assert.deepEqual((await graph.links('a')).map((link) => [link.score, link.level, link.reasons[0]!.counted]), [[0.6, 'related', undefined]])
      // A number seen on two people four years apart has faded to a quarter.
      const old = await fresh({ ...household, related: 0 })
      await old.graph.observe([{ subject: 'a', identifiers: ['phone:1'], at: T0 }, { subject: 'b', identifiers: ['phone:1'], at: T0 + 4 * 365 * DAY }])
      assert.ok(Math.abs((await old.graph.links('a'))[0]!.score - 0.85 / 4) < 1e-9)
    })

    test('a name confirms a link and never makes one', async () => {
      const household = policyFrom(JSON.parse(readFileSync(new URL('../examples/household.json', import.meta.url), 'utf8')))
      const secret = 'a-secret-of-thirty-two-characters!'
      const key = (first: string, last: string, known: { zip5?: string; dob?: string }) => nameKeys(secret, first, last, known)
      const score = async (identifiers: string[], policy = household) => {
        const { graph } = await fresh(policy)
        await graph.observe(['a', 'b'].map((subject) => ({ subject, identifiers, at: T0 })))
        const [link] = await graph.links('a')
        return link && [Math.round(link.score * 10_000) / 10_000, link.level, link.reasons.map((reason) => [reason.identifier.split(':')[0], reason.counted])]
      }
      const both = key('Ana', 'Lima', { zip5: '62701', dob: '1990-02-03' })
      assert.equal(both.length, 2)
      // A name alone, even by two keys, is nothing at all.
      assert.equal(await score(both), undefined)
      // With a phone it makes the pair one person, and two keys of one name count once.
      assert.deepEqual(await score(['phone:1']), [0.85, 'related', [['phone', undefined]]])
      assert.deepEqual(await score(['phone:1', both[0]!]), [0.94, 'same', [['phone', undefined], ['name', undefined]]])
      assert.deepEqual(await score(['phone:1', ...both]), [0.94, 'same', [['phone', undefined], ['name', undefined], ['name', false]]])
      // What does not relate two without it does not relate them with it: an address many share, and a name.
      assert.equal(await score(['ip:198.51.100.7', both[0]!]), undefined)
      const { graph } = await fresh(household)
      await graph.observe(['a', 'b'].map((subject) => ({ subject, identifiers: ['ip:198.51.100.7', both[0]!], at: T0 })))
      const between = await graph.between('a', 'b')
      assert.deepEqual([Math.round(between.score * 100), between.reasons.map((reason) => reason.counted)], [30, [false, undefined]])
      // Accents and case fold to one key on either store, and past the cap a key is nobody's.
      await graph.observe([
        { subject: 'c', identifiers: ['phone:2', ...key('José', 'Muñoz-Ruiz', { zip5: '62701' })], at: T0 },
        { subject: 'd', identifiers: ['phone:2', ...key('JOSE', 'munoz ruiz', { zip5: '62701-1234' })], at: T0 },
      ])
      assert.equal((await graph.links('c'))[0]!.level, 'same')
      await graph.observe([1, 2, 3, 4].map((n) => ({ subject: `crowd:${n}`, identifiers: key('Jose', 'Munoz Ruiz', { zip5: '62701' }), at: T0 })))
      assert.equal((await graph.links('c'))[0]!.level, 'related')
      assert.deepEqual(await graph.verify(), [])
      // The default policy knows no names.
      await assert.rejects((await fresh()).graph.observe({ subject: 'a', identifiers: both, at: T0 }), /kind that is missing from the policy/)
    })

    test('overlapping writes leave clusters sound', async () => {
      const { graph } = await fresh()
      await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          graph.observe({ subject: `account:${i % 20}`, identifiers: [`email:${i % 7}`, `hardware:${i % 5}`], at: T0 + i }),
        ),
      )
      assert.deepEqual(await graph.verify(), [])
    })

    for (const grouped of [false, true]) test(`stored clusters match a full recompute after each of ${fuzzSteps} random operations${grouped ? ', with kinds in groups and one that only confirms' : ''}`, async () => {
      // Low caps, so identifiers cross them in both directions often.
      const policy: Policy = {
        ...defaultPolicy,
        kinds: Object.fromEntries(Object.entries(defaultPolicy.kinds).map(([kind, rule]) => [kind, { ...rule, cap: kind === 'ip' ? 6 : 3, ...(grouped && ['email', 'device', 'hardware'].includes(kind) && { group: 'one' }), ...(grouped && ['canvas', 'fingerprint'].includes(kind) && { group: 'two' }), ...(grouped && kind === 'canvas' && { corroborates: true as const }) }])),
      }
      const seed = 20261123 + Number(grouped)
      const next = random(seed)
      const pick = (count: number) => Math.floor(next() * count)
      const identifier = () =>
        [`email:${pick(14)}`, `device:${pick(14)}`, `hardware:${pick(10)}`, `fingerprint:${pick(8)}`, `canvas:${pick(8)}`, `ip:${pick(5)}`][pick(6)]!
      const observation = (): Observation => ({
        subject: `account:${pick(40)}`,
        identifiers: Array.from({ length: 1 + pick(3) }, identifier),
        at: T0 + pick(200) * DAY,
      })
      const { graph } = await fresh(policy)

      for (let step = 0; step < fuzzSteps; step++) {
        const roll = next()
        if (roll < 0.68) await graph.observe(observation())
        else if (roll < 0.76) await graph.observe(Array.from({ length: 2 + pick(5) }, observation))
        else if (roll < 0.84) await graph.ignore(identifier(), next() < 0.6)
        else if (roll < 0.9) await graph.forget(`account:${pick(40)}`)
        else if (roll < 0.97) {
          const a = pick(40)
          await graph.separate(`account:${a}`, `account:${(a + 1 + pick(39)) % 40}`, next() < 0.7)
        } else if (roll < 0.98) {
          // A call, its result, or both, in whatever order, with results expected.
          const id = `F${pick(30)}`
          const call = { id, from: `+1555010${String(pick(20)).padStart(4, '0')}`, to: '+15550100001', at: T0 + pick(200) * DAY, duration: pick(120) }
          const placed = id.endsWith('7')
          if (next() < 0.6) await recordCall(graph, placed ? { ...call, direction: 'outbound', from: call.to, to: call.from } : call, { results: 'expected' })
          if (next() < 0.6) await recordCallResult(graph, { id, answered: next() < 0.5, waited: pick(40) }, { results: 'expected' })
          if (next() < 0.3 && !placed) await recordReturn(graph, { id, at: T0 + pick(220) * DAY, ...(next() < 0.3 && { returned: false }) }).catch((error) => assert.ok(error instanceof TypeError))
        } else if (roll < 0.99) {
          // Pairs from a system, separations and withdrawals together, some of them named twice.
          const pairs = Array.from({ length: 1 + pick(6) }, () => {
            const a = pick(40)
            return { a: `account:${a}`, b: `account:${(a + 1 + pick(39)) % 40}`, separated: next() < 0.7 }
          })
          const told = next() < 0.8 ? await graph.separateAll(pairs, { by: 'system:a' }) : await graph.joinAll(pairs, { by: 'system:b' })
          assert.equal(told.recorded + told.already, pairs.length)
        } else {
          const a = pick(40)
          await graph.transfer({ id: `flow-${step}`, from: `account:${a}`, to: `account:${(a + 1 + pick(39)) % 40}`, amount: 1 + pick(1000), at: T0 })
        }
        assert.deepEqual(await graph.verify(), [], `seed ${seed}, step ${step}`)
      }
      assert.equal((await graph.audit()).sound, true)
      // Every call counts exactly when a person answered it and it was long enough.
      for (let n = 0; n < 30; n++) {
        const call = await graph.keptCall(`F${n}`)
        const counts = call?.direction === 'inbound' && call.result?.answered === true && call.duration! >= 30
        assert.equal(Boolean(await graph.outcomeOf(`call:F${n}`)), counts, `F${n}`)
      }
      // What is undecided is exactly what is linked, in two clusters, and not joined by a mark.
      const linked = new Map<string, boolean>()
      for (let n = 0; n < 40; n++) {
        for (const link of await graph.links(`account:${n}`)) {
          const pair = [`account:${n}`, link.subject].sort()
          if ((await graph.cluster(pair[0]!))!.id === (await graph.cluster(pair[1]!))!.id) continue
          linked.set(pair.join(' '), link.reasons.some((reason) => reason.identifier.startsWith('review:join-')))
        }
      }
      const undecided = (await graph.undecided({ limit: 10_000 })).pairs.filter((pair) => pair.a.startsWith('account:') || pair.b.startsWith('account:'))
      assert.deepEqual(undecided.map((pair) => `${pair.a} ${pair.b}`).sort(), [...linked].filter(([, joined]) => !joined).map(([pair]) => pair).sort())
      // What is open is exactly what followUp says of each call.
      const all = await graph.openCalls({ from: '2023-11-01', to: '2024-07-01', limit: 1000 })
      const still: string[] = []
      for (let n = 0; n < 30; n++) {
        const call = await graph.keptCall(`F${n}`)
        if (call?.direction === 'inbound' && call.result?.answered === false && followUp(call, await graph.callsOf([call.subject])).state === 'open') still.push(call.id)
      }
      assert.deepEqual(all.map((each) => each.call.id).sort(), still.sort())
      // The board has each person in one place, and everybody with a call to return in the first column.
      const board = await graph.board({ steps: [{ name: 'call' }], at: T0 + 201 * DAY, days: 365 })
      const placed: string[] = []
      for (const row of board.columns.flatMap((column) => column.rows)) placed.push((await graph.cluster(row.subject))?.id ?? row.subject)
      assert.equal(new Set(placed).size, placed.length)
      const open = await graph.openCalls({ from: '2023-11-01', to: '2024-07-01', limit: 1000 })
      const waiting = new Set<string>()
      for (const { call } of open) waiting.add((await graph.cluster(call.subject))?.id ?? call.subject)
      assert.deepEqual(placed.slice(0, board.columns[0]!.people).sort(), [...waiting].sort())
      assert.equal(board.unplaced, 0)
    })
  })
}
