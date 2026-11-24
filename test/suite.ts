import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, describe, test } from 'node:test'
import { brokenAt, createGraph, defaultPolicy, dialed, email, fit, hashPhone, policyFrom, recordCall } from '../src/index.ts'
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
        source: 'google', campaignId: '111', campaign: 'Spring sale', cost: 60.3, clicks: 42, impressions: 1300, visits: 1,
        stages: { inquiry: { count: 1, value: 5 }, enrolled: { count: 1, value: 200 } }, outcomes: 2, value: 205,
      })
      // The Meta touch named its campaign only by name, in another case, and its source by an alias.
      assert.deepEqual(line('meta', '777'), {
        source: 'meta', campaignId: '777', campaign: 'Retarget', cost: 15, clicks: 9, impressions: 0, visits: 1,
        stages: { enrolled: { count: 1, value: 150.5 } }, outcomes: 1, value: 150.5,
      })
      assert.equal(line('google', '222')!.cost, 6)
      assert.deepEqual(line('(none)', '')!.stages, { enrolled: { count: 1, value: 200 } })
      assert.deepEqual(report.total, {
        cost: 81.3, clicks: 51, impressions: 1300, visits: 3,
        stages: { inquiry: { count: 2, value: 10 }, enrolled: { count: 3, value: 550.5 } }, outcomes: 5, value: 560.5,
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
      assert.deepEqual(pagoPago.total.stages, { inquiry: { count: 1, value: 5 } })

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
      assert.deepEqual(tied, { subject: caller('+15558675309'), flags: [], counted: true, visitor: 'visitor:a', duplicate: false })
      assert.deepEqual(await members(graph, 'visitor:a'), [caller('+15558675309'), 'visitor:a'].sort())
      const credited = (await graph.attribute(tied.subject, { at: T0 + 2 * MINUTE })).credited!
      assert.deepEqual([credited.gclid, credited.subject], ['G-a', 'visitor:a'])

      // The provider reports the same call again: nothing is written twice.
      const sightings = (await graph.counts()).sightings
      assert.deepEqual(await recordCall(graph, { id: 'CA1', from: '555-867-5309', to: '+15551230001', at: T0 + MINUTE + 20_000, duration: 95 }, { numbers }), {
        subject: tied.subject, flags: [], counted: false, duplicate: true,
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
      assert.deepEqual(report.total.stages, { call: { count: 8, value: 0 } })
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

    test('overlapping writes leave clusters sound', async () => {
      const { graph } = await fresh()
      await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          graph.observe({ subject: `account:${i % 20}`, identifiers: [`email:${i % 7}`, `hardware:${i % 5}`], at: T0 + i }),
        ),
      )
      assert.deepEqual(await graph.verify(), [])
    })

    for (const grouped of [false, true]) test(`stored clusters match a full recompute after each of ${fuzzSteps} random operations${grouped ? ', with kinds in groups' : ''}`, async () => {
      // Low caps, so identifiers cross them in both directions often.
      const policy: Policy = {
        ...defaultPolicy,
        kinds: Object.fromEntries(Object.entries(defaultPolicy.kinds).map(([kind, rule]) => [kind, { ...rule, cap: kind === 'ip' ? 6 : 3, ...(grouped && ['email', 'device', 'hardware'].includes(kind) && { group: 'one' }), ...(grouped && ['canvas', 'fingerprint'].includes(kind) && { group: 'two' }) }])),
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
        } else if (roll < 0.985) {
          // Pairs from a system, separations and withdrawals together, some of them named twice.
          const pairs = Array.from({ length: 1 + pick(6) }, () => {
            const a = pick(40)
            return { a: `account:${a}`, b: `account:${(a + 1 + pick(39)) % 40}`, separated: next() < 0.7 }
          })
          const told = next() < 0.8 ? await graph.separateAll(pairs, { by: 'system:a' }) : await graph.joinAll(pairs, { by: 'system:b' })
          assert.equal(told.recorded + told.already, pairs.length)
        } else {
          const a = pick(40)
          await graph.transfer({ from: `account:${a}`, to: `account:${(a + 1 + pick(39)) % 40}`, amount: 1 + pick(1000), at: T0 })
        }
        assert.deepEqual(await graph.verify(), [], `seed ${seed}, step ${step}`)
      }
      assert.equal((await graph.audit()).sound, true)
    })
  })
}
