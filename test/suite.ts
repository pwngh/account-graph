import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { brokenAt, createGraph, defaultPolicy, email, fit } from '../src/index.ts'
import type { Change, GraphOptions, Observation, Policy, Store } from '../src/index.ts'

export interface Opened {
  store: Store
  close(): Promise<void>
}

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

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

    test('counts say how much the graph holds', async () => {
      const { graph } = await fresh()
      assert.deepEqual(await graph.counts(), { subjects: 0, clusters: 0, identifiers: 0, edges: 0, sightings: 0, touches: 0, decisions: 0 })
      await graph.observe([
        { subject: 'a', identifiers: ['email:e', 'ip:198.51.100.2'], at: T0 },
        { subject: 'b', identifiers: ['email:e'], at: T0 },
        { subject: 'c', identifiers: ['email:other'], at: T0 },
      ])
      await graph.observe({ subject: 'a', identifiers: ['email:e'], at: T0 + HOUR })
      await graph.touch({ subject: 'a', at: T0, gclid: 'G' })
      await graph.ignore('ip:198.51.100.2')
      assert.deepEqual(await graph.counts(), { subjects: 3, clusters: 2, identifiers: 3, edges: 4, sightings: 5, touches: 1, decisions: 1 })
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

      const recent = await graph.recent()
      assert.deepEqual(recent.map((move) => [move.subject, move.from, move.to, move.at]), [
        ['duo:n', 'duo:n', 'duo:m', T0 + HOUR],
        ['pair:y', 'pair:y', 'pair:x', T0 + HOUR],
        ['team:c', 'team:c', 'team:a', T0],
        ['team:b', 'team:b', 'team:a', T0],
      ])
      assert.equal((await graph.recent(1)).length, 1)
      await graph.forget('pair:y')
      assert.equal((await graph.recent()).some((move) => move.subject === 'pair:y'), false)
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

    test('a cluster past the review size is flagged', async () => {
      const { graph } = await fresh({ ...defaultPolicy, review: 3 })
      for (const n of [1, 2, 3]) await graph.observe({ subject: `account:${n}`, identifiers: ['device:d'], at: T0 })
      assert.equal((await graph.cluster('account:1'))!.oversized, false)
      await graph.observe({ subject: 'account:4', identifiers: ['device:d'], at: T0 })
      assert.equal((await graph.cluster('account:1'))!.oversized, true)
    })

    test('value moving between tied accounts is reported with the tie', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'a', identifiers: ['hardware:h', 'canvas:c', 'ip:198.51.100.9'], at: T0 },
        { subject: 'b', identifiers: ['hardware:h'], at: T0 },
        { subject: 'd', identifiers: ['canvas:c', 'ip:198.51.100.9'], at: T0 },
        { subject: 'stranger', identifiers: ['email:s'], at: T0 },
      ])
      const first = await graph.transfer({ from: 'a', to: 'b', amount: 500, at: T0 })
      assert.equal(first.relation, 'same')
      assert.equal(first.score, 0.95)
      assert.deepEqual(first.reasons.map((reason) => reason.identifier), ['hardware:h'])
      assert.deepEqual([first.sent, first.received, first.count, first.imbalance], [500, 0, 1, 1])

      await graph.transfer({ from: 'a', to: 'b', amount: 500, at: T0 + HOUR })
      await graph.transfer({ from: 'b', to: 'a', amount: 200, at: T0 + 2 * HOUR })
      await graph.transfer({ from: 'a', to: 'stranger', amount: 5000, at: T0 })
      await graph.transfer({ from: 'd', to: 'a', amount: 40, at: T0, asset: 'gold' })
      assert.equal((await graph.transfer({ from: 'a', to: 'unknown', amount: 1, at: T0 })).relation, 'none')

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

      await assert.rejects(graph.transfer({ from: 'a', to: 'a', amount: 1, at: T0 }), TypeError)
      await assert.rejects(graph.transfer({ from: 'a', to: 'b', amount: 1.5, at: T0 }), TypeError)
      await assert.rejects(graph.transfer({ from: 'a', to: 'b', amount: 0, at: T0 }), TypeError)

      await graph.forget('b')
      assert.equal((await graph.flows('a')).some((row) => row.subject === 'b'), false)
    })

    test('value that goes round in a circle is found, with the least that made the trip', async () => {
      const { graph } = await fresh()
      await graph.observe([
        { subject: 'a', identifiers: ['hardware:h'], at: T0 },
        { subject: 'b', identifiers: ['hardware:h'], at: T0 },
      ])
      const pay = (from: string, to: string, amount: number, asset?: string) => graph.transfer({ from, to, amount, at: T0, ...(asset && { asset }) })
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
      assert.deepEqual(await graph.audit(), { sound: true })
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
      await assert.rejects(graph.observe({ subject: 'account:1', identifiers: ['email:a', 'shoe:9'], at: T0 }), TypeError)
      assert.equal(await graph.cluster('account:1'), undefined)
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
        const clusters = await store.read((tx) => tx.allLabels())
        results.push(JSON.stringify([...clusters].sort()))
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
      assert.equal(attribution.reason, 'low_confidence')
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

    test(`stored clusters match a full recompute after each of ${fuzzSteps} random operations`, async () => {
      // Low caps, so identifiers cross them in both directions often.
      const policy: Policy = {
        ...defaultPolicy,
        kinds: Object.fromEntries(Object.entries(defaultPolicy.kinds).map(([kind, rule]) => [kind, { ...rule, cap: kind === 'ip' ? 6 : 3 }])),
      }
      const seed = 20261123
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
        } else {
          const a = pick(40)
          await graph.transfer({ from: `account:${a}`, to: `account:${(a + 1 + pick(39)) % 40}`, amount: 1 + pick(1000), at: T0 })
        }
        assert.deepEqual(await graph.verify(), [], `seed ${seed}, step ${step}`)
      }
    })
  })
}
