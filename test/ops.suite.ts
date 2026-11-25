import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { createGraph, createHours, createOps, codeNote, dialed, hashPhone, recordCall } from '../tools/internals.ts'
import type { OpsOptions, Store } from '../tools/internals.ts'
import type { Opened } from './suite.ts'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const until = async (ready: () => unknown) => {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 2))
}

/** Every store must pass this too. */
export function opsSuite(name: string, open: () => Promise<Opened>) {
  describe(`${name}: ops`, () => {
    const opened: Opened[] = []
    after(async () => {
      for (const each of opened) await each.close()
    })
    const fresh = async (options: OpsOptions = {}) => {
      const next = await open()
      opened.push(next)
      const clock = { now: T0 }
      const posted: string[] = []
      const hook = { status: 200, refuse: '' }
      const fetcher = (async (_url: string, init: { body: string }) => {
        if (hook.status !== 200 || (hook.refuse && JSON.parse(init.body).text === hook.refuse)) return new Response('no', { status: hook.status === 200 ? 400 : hook.status })
        posted.push(JSON.parse(init.body).text)
        return new Response('ok')
      }) as unknown as typeof fetch
      const graph = createGraph(next.store, undefined, { now: () => clock.now })
      const errors: unknown[] = []
      const make = (more: OpsOptions = {}) => createOps(graph, next.store.ops, { url: 'https://hooks.example/x', fetch: fetcher, now: () => clock.now, onError: (error) => void errors.push(error), ...options, ...more })
      return { graph, ops: make(), make, clock, posted, hook, errors, store: next.store }
    }

    test('conversions that wait past their time are said once a day while it lasts', async () => {
      const { make, clock, posted, store, errors } = await fresh()
      const ops = make({ outbox: store.outbox, lateHours: 6 })
      const job = (transactionId: string, due: number, state: 'pending' | 'held' = 'pending') => store.outbox.add({ transactionId, target: 'google', subject: 'contact:1', at: T0, action: 'x', keys: {}, state, attempts: 0, due })
      assert.equal(await store.outbox.oldestDue(), undefined)
      await job('held', T0 - 100 * HOUR, 'held')
      await job('later', T0 + 2 * HOUR)
      await job('first', T0)
      assert.equal(await store.outbox.oldestDue(), T0)
      clock.now = T0 + 6 * HOUR - 1
      await ops.check()
      assert.deepEqual(posted, [])
      clock.now += 1
      for (let i = 0; i < 3; i++) await ops.check()
      assert.deepEqual(posted, ['account-graph: conversions are overdue. The oldest was due Nov 14, 2023, 10:13 PM (UTC).'])
      clock.now += 24 * HOUR
      await ops.check()
      assert.equal(posted.length, 2)
      clock.now += 24 * HOUR
      await make({ outbox: store.outbox }).check()
      assert.equal(posted.length, 2)
      // An outbox that cannot be read is reported, and the rest is still looked for.
      for (const oldestDue of [async () => Promise.reject(new Error('down')), () => { throw new Error('down') }]) {
        const before = errors.length
        await make({ outbox: { oldestDue }, lateHours: 6, quiet: { touches: 1 } }).check()
        assert.equal(errors.length, before + 1)
      }
    })

    test('a feed that goes quiet is said once, and once more when it goes quiet again', async () => {
      const { graph, ops, make, clock, posted } = await fresh({ quiet: { touches: 6, costs: 48 }, timeZone: 'America/New_York' })
      const touch = () => graph.touch({ subject: 'visitor:1', at: clock.now, gclid: 'G' })
      await touch()
      clock.now += 6 * HOUR - 1
      await ops.check()
      assert.deepEqual(posted, [])
      clock.now += 1
      for (let i = 0; i < 3; i++) await ops.check()
      assert.deepEqual(posted, ['account-graph: no touches for 6 hours. Last record: Nov 14, 2023, 5:13 PM (America/New_York).'])
      const state = await ops.state()
      assert.deepEqual(state.feeds.map((feed) => [feed.name, feed.last, feed.hours, feed.quiet]), [['touches', T0, 6, true], ['calls', null, 0, false], ['results', null, 0, false], ['costs', null, 48, false]])
      // It speaks, and goes quiet again.
      await touch()
      await ops.check()
      assert.equal(posted.length, 1)
      clock.now += 7 * HOUR
      await ops.check()
      assert.equal(posted.length, 2)
      // A feed that never wrote anything is quiet too, once it has been watched that long, whatever restarted meanwhile.
      clock.now = T0 + 6 * HOUR + 48 * HOUR
      await make().check()
      assert.match(posted.at(-1)!, /no costs for 48 hours\. No records exist\./)
      // Each feed is fed by its own records. A touch dated in the past still fed it now.
      await graph.spend({ day: '2023-11-14', source: 'google', amount: 1 })
      await graph.touch({ subject: 'visitor:1', at: 5, gclid: 'G' })
      await recordCall(graph, { id: 'C1', from: '+15550100001', to: '+15550100002', at: T0, duration: 60, answered: true })
      assert.deepEqual((await ops.state()).feeds.map((feed) => feed.last), [clock.now, clock.now, clock.now, clock.now])
    })

    test('a statement about the caller removes a pending callback alert that names the line', async () => {
      const { graph, ops, clock, posted, hook, store } = await fresh({ returnHours: 1 })
      const to = '+12025550116'
      const owner = 'contact:owner'
      await graph.touch({ subject: owner, at: T0, source: 'google', gclid: 'own', campaignId: 'own' })
      await recordCall(graph, { id: 'miss', from: '+12025550115', to, at: T0 + 1, answered: false }, { numbers: { [to]: { source: 'google', campaignId: 'line' } } })
      clock.now += 2 * HOUR
      hook.status = 503
      await ops.check()
      assert.match((await store.ops.undelivered())[0]!.key, /^unreturned:caller:/)
      await graph.sayParty({ call: 'miss', key: 'heard', at: clock.now, party: { role: 'self', subject: owner, by: 'desk' } })
      assert.deepEqual(await store.ops.undelivered(), [])
      hook.status = 200
      await ops.check()
      assert.equal(posted.length, 1)
      assert.match(posted[0]!, /own.*contact:owner/)
    })

    test('a kept alert starts its request while its last ownership check still holds', async () => {
      const { graph, store, clock } = await fresh()
      const id = 'at-dispatch'
      await graph.keepCall({ id, subject: 'caller:line', direction: 'inbound', at: T0, to: '+12025550101', flags: [] })
      await store.ops.addAlert({ key: 'alert:conversions:dispatch', text: `• call:${id} to test: rejected`, at: T0 })
      clock.now += 120_000
      let corrected = false
      const sentAfterCorrection: boolean[] = []
      const racing = { ...store.ops, pendingAlert: async (...args: Parameters<typeof store.ops.pendingAlert>) => {
        const waiting = await store.ops.pendingAlert(...args)
        await graph.sayParty({ call: id, key: id, at: clock.now, party: { role: 'self', subject: 'record:a', by: 'desk' } })
        corrected = true
        return waiting
      } }
      await createOps(graph, racing, { now: () => clock.now, url: 'https://example.org/alerts', fetch: async () => {
        sentAfterCorrection.push(corrected)
        return new Response(null, { status: 200 })
      } }).check()
      assert.equal(corrected, true)
      assert.deepEqual(sentAfterCorrection, [false])
      assert.deepEqual(await store.ops.undelivered(), [])
    })

    test('a rejected batch forgets a call counted beyond the ten named failures', async () => {
      const { graph, store } = await fresh()
      const id = 'unnamed'
      const subject = 'caller:line'
      await graph.keepCall({ id, subject, at: T0, direction: 'inbound', to: '+12025550101', flags: [] })
      const failures = async (ids: string[]) => {
        const jobs = []
        for (const transactionId of ids) {
          const job = await store.outbox.add({ transactionId, subject, at: T0, target: 'test', action: 'test', due: T0, state: 'failed', attempts: 1, note: 'rejected', keys: {} })
          jobs.push(job!)
        }
        await createOps(graph, store.ops, { now: () => T0 }).failed(jobs, store)
      }
      const ten = Array.from({ length: 10 }, (_, i) => 'first-' + i)
      await failures([...ten, `call:${id}`])
      await failures(Array.from({ length: 11 }, (_, i) => 'other-' + i))
      const alerts = async () => (await store.ops.undelivered()).map(alert => alert.text)
      const legacy = { key: 'alert:conversions:legacy', at: T0, text: '11 conversions rejected.\n…and 1 more' }
      await store.ops.addAlert(legacy)
      const before = await alerts()
      assert.equal(before.length, 3)
      assert.ok(before.every(text => text.includes('…and 1 more') && !text.includes(id)))
      await graph.forget('record:unrelated')
      assert.deepEqual(await alerts(), before)
      await graph.sayParty({ call: id, key: id, at: T0 + 1, party: { role: 'self', subject: 'record:a', by: 'desk' } })
      assert.deepEqual(await alerts(), before.filter(text => text.includes('other-0')))
    })

    test('a failure alert already claimed drops a corrected call before posting', async () => {
      const { graph, store, clock } = await fresh()
      const id = 'already-claimed'
      await graph.keepCall({ id, subject: 'caller:line', direction: 'inbound', at: T0, to: '+12025550101', flags: [] })
      await store.ops.addAlert({ key: 'alert:conversions:stale', text: `• call:${id} to test: rejected`, at: T0 })
      clock.now += 120_000
      let claims = 0
      let posts = 0
      const racing = { ...store.ops, claimAlert: async (at: number, before: number) => {
        const kept = await store.ops.claimAlert(at, before)
        if (kept) {
          claims++
          await graph.sayParty({ call: id, key: id, at, party: { role: 'self', subject: 'record:a', by: 'desk' } })
        }
        return kept
      } }
      await createOps(graph, racing, { now: () => clock.now, url: 'https://example.org/alerts', fetch: async () => {
        posts++
        return new Response(null, { status: 200 })
      } }).check()
      assert.deepEqual([claims, posts, await store.ops.undelivered()], [1, 0, []])
    })

    for (const correction of ['move', 'forget']) test(`a callback event loses another record’s attempt after ${correction}`, async () => {
      const { graph, store, clock } = await fresh()
      const to = '+12025550101'
      const from = '+12025550102'
      const other = '+12025550103'
      const attempt = 'return-attempt'
      const mine = 'contact:a'
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now, emit: (event) => store.write((tx) => tx.emit([event])) })
      const events = async () => (await store.read((tx) => tx.eventsAfter(0, 100))).filter((event) => event.type === 'callback.overdue')
      await graph.touch({ subject: mine, at: T0, source: 'google', gclid: 'visit' })
      // The alert key names the first open miss, which is too old to be the one shown in the event.
      for (const [id, line, at] of [['first', from, T0 - 60 * DAY], ['shown', from, T0 + 1], ['independent', other, T0 + 2]] as const) {
        const { subject } = await recordCall(graph, { id, from: line, to, at, answered: false })
        if (id === 'independent') await graph.touch({ subject, at: T0, source: 'google', gclid: 'other' })
        else await graph.sayParty({ call: id, key: id, at: T0 + 2, party: { role: 'self', subject: mine, by: 'desk' } })
      }
      // A separate physical line allows its deletion without deleting the inbound misses.
      const placed = await recordCall(graph, { id: attempt, direction: 'outbound', from: to, to: '+12025550104', at: T0 + 3, answered: false })
      await graph.sayParty({ call: attempt, key: 'initial', at: T0 + 4, party: { role: 'self', subject: mine, by: 'desk' } })
      clock.now += 2 * HOUR
      await ops.check()
      const before = await events()
      assert.deepEqual(before.map(({ data }) => [data.call, data.attempts]), [['shown', 1], ['independent', 0]])
      if (correction === 'forget') await graph.forget(placed.subject)
      else await graph.sayParty({ call: attempt, key: 'corrected', at: clock.now, party: { role: 'self', subject: 'contact:b', by: 'desk' } })
      assert.deepEqual(await events(), [before[1]])
      await ops.check()
      const fixed = await events()
      assert.deepEqual(fixed.map(({ data }) => [data.call, data.attempts]), [['independent', 0], ['shown', 0]])
      assert.ok(fixed[1]!.seq > before[1]!.seq)
    })

    test('a corrected call keeps a callback notice whose paid visit still earns it through another sighting', async () => {
      const { graph, store, clock } = await fresh()
      const from = '+12025550115'
      const to = '+12025550116'
      await graph.touch({ subject: 'record:lead', at: T0, campaignId: 'kept', gclid: 'click' })
      await graph.observe({ subject: 'record:lead', identifiers: [`phone:${hashPhone(from)}`], at: T0 })
      await recordCall(graph, { id: 'earlier', from, to, at: T0 + 1, answered: true })
      await recordCall(graph, { id: 'miss', from, to, at: T0 + 2, answered: false })
      clock.now += 2 * HOUR
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now, emit: event => store.write(tx => tx.emit([event])) })
      const read = async () => [(await store.read(tx => tx.eventsAfter(0, 100))).filter(event => event.type === 'callback.overdue'), await store.ops.undelivered()]
      await ops.check()
      const before = await read()
      assert.deepEqual(before.map(rows => rows.length), [1, 1])
      await graph.sayParty({ call: 'earlier', key: 'corrected', at: clock.now, party: { role: 'self', subject: 'record:b', by: 'desk' } })
      assert.deepEqual(await read(), before)
    })

    test('a separate cut can move callback credit away from a surviving link', async () => {
      const { graph, store, clock } = await fresh()
      await graph.observe({ subject: 'visitor:ad', identifiers: [codeNote('K7Q2MZ'), 'hardware:shared', 'email:bv@example.org'], at: T0 - 300 })
      await graph.touch({ subject: 'visitor:ad', at: T0 - 200, source: 'google', campaignId: 'former', gclid: 'click' })
      const { subject: first } = await recordCall(graph, { id: 'code', from: '+12025550101', to: '+12025550105', at: T0 - 100, answered: true, code: 'K7Q2MZ' })
      const { subject: line } = await recordCall(graph, { id: 'miss', from: '+12025550102', to: '+12025550106', at: T0, answered: false })
      await graph.observe([{ subject: first, identifiers: ['email:mu@example.org'], at: T0 - 400 }, { subject: line, identifiers: ['email:mu@example.org','hardware:shared'], at: T0 - 400 }, { subject: 'contact:apart', identifiers: ['email:bv@example.org'], at: T0 - 400 }])
      await graph.separate(line, 'contact:apart')
      clock.now += 2 * HOUR
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now, emit: event => store.write(tx => tx.emit([event])) })
      const events = async () => (await store.read(tx => tx.eventsAfter(0, 100))).filter(event => event.type === 'callback.overdue')
      await ops.check()
      assert.deepEqual((await events()).map(event => event.data.campaignId), ['former'])
      await graph.sayParty({ call: 'code', key: 'corrected', at: clock.now, party: { role: 'self', subject: 'record:other', by: 'desk' } })
      assert.equal((await graph.attribute(line, { at: T0 })).credited, undefined)
      assert.deepEqual([await events(), await store.ops.undelivered()], [[], []])
    })

    for (const tie of ['tap', 'phone']) test(`a callback notice loses an arrival credited through a corrected call’s ${tie}`, async () => {
      const { graph, store, clock } = await fresh()
      const from = '+12025550112'
      const number = '+12025550113'
      const other = '+12025550114'
      const source = tie === 'tap' ? 'visitor:web' : 'record:lead'
      await graph.touch({ subject: source, at: T0, source: 'google', gclid: 'visit' })
      await graph.observe({ subject: source, identifiers: [tie === 'tap' ? dialed(number, T0) : `phone:${hashPhone(from)}`], at: T0 })
      await recordCall(graph, { id: 'earlier', from, to: number, at: T0 + 1000, answered: true })
      // A carrier marked this second call's line as shared. The first call still supplies the link until staff correct it.
      const { subject: line } = await recordCall(graph, { id: 'miss', from, to: other, at: T0 + 2000, answered: false }, { lineType: async () => ({ type: 'tollFree', carrier: undefined }) })
      clock.now += 2 * HOUR
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now, emit: (event) => store.write((tx) => tx.emit([event])) })
      const events = async () => (await store.read((tx) => tx.eventsAfter(0, 100))).filter(event => event.type === 'callback.overdue')
      await ops.check()
      assert.deepEqual([(await events()).length, (await store.ops.undelivered()).length], [1, 1])
      await graph.sayParty({ call: 'earlier', key: 'corrected', at: clock.now, party: { role: 'self', subject: 'record:b', by: 'desk' } })
      assert.equal((await graph.attribute(line, { at: T0 + 2000 })).credited, undefined)
      assert.deepEqual([await events(), await store.ops.undelivered()], [[], []])
    })

    for (const keepEvent of [false, true]) test(`a callback notice loses credit from a call staff moved, events ${keepEvent ? 'on' : 'off'}`, async () => {
      const { graph, store, clock } = await fresh()
      const from = '+12025550105'
      const channel = '+12025550106'
      // Only the earlier call left the paid channel visit. The later, missed call rang a number with no channel.
      await recordCall(graph, { id: 'paid-line', from, to: channel, at: T0 - 1, answered: true }, { numbers: { [channel]: { source: 'google', campaignId: 'desk' } } })
      await recordCall(graph, { id: 'miss', from, to: '+12025550107', at: T0, answered: false })
      clock.now += 2 * HOUR
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now, ...(keepEvent && { emit: (event) => store.write((tx) => tx.emit([event])) }) })
      const events = async () => (await store.read((tx) => tx.eventsAfter(0, 100))).filter((event) => event.type === 'callback.overdue')
      await ops.check()
      assert.deepEqual([(await events()).length, (await store.ops.undelivered()).length], [Number(keepEvent), 1])
      await graph.sayParty({ call: 'paid-line', key: 'corrected', at: clock.now, party: { role: 'self', subject: 'contact:b', by: 'desk' } })
      assert.deepEqual([await events(), await store.ops.undelivered()], [[], []])
    })

    test('assigning an answered return to the waiting record cancels its pending notice', async () => {
      const { graph, store, clock } = await fresh()
      const owner = 'contact:a'
      const to = '+12025550108'
      await recordCall(graph, { id: 'miss', from: '+12025550109', to, at: T0 + 1, answered: false })
      await graph.sayParty({ call: 'miss', key: 'first', at: T0 + 2, party: { role: 'self', subject: owner, by: 'desk' } })
      await graph.touch({ subject: owner, at: T0, source: 'google', gclid: 'visit' })
      await recordCall(graph, { id: 'return', direction: 'outbound', from: to, to: '+12025550110', at: T0 + 3, answered: true })
      clock.now += 2 * HOUR
      const ops = createOps(graph, store.ops, { returnHours: 1, now: () => clock.now })
      await ops.check()
      assert.equal((await store.ops.undelivered()).length, 1)
      await graph.sayParty({ call: 'return', key: 'corrected', at: clock.now, party: { role: 'self', subject: owner, by: 'desk' } })
      assert.deepEqual(await store.ops.undelivered(), [])
    })

    test('the callback event and alert use the current paid arrival', async () => {
      const { graph, store, clock } = await fresh()
      const subject = 'contact:desk'
      await graph.touch({ subject, at: T0, source: 'google', campaign: 'before', gclid: 'first' })
      await recordCall(graph, { id: 'miss', from: '+12025550173', to: '+12025550174', at: T0 + 2, answered: false })
      await graph.sayParty({ call: 'miss', key: 'party', at: T0 + 3, party: { role: 'self', subject, by: 'desk' } })
      clock.now += 2 * HOUR
      let changed = false
      const reader = { ...graph, openCalls: async (...args: Parameters<typeof graph.openCalls>) => {
        const page = await graph.openCalls(...args)
        if (!changed) {
          changed = true
          await graph.touch({ subject, at: T0 + 1, source: 'google', campaign: 'after', gclid: 'second' })
        }
        return page
      } }
      const ops = createOps(reader, store.ops, { returnHours: 1, now: () => clock.now, emit: (event) => store.write((tx) => tx.emit([event])) })
      const events = async () => (await store.read((tx) => tx.eventsAfter(0, 100))).filter((event) => event.type === 'callback.overdue')
      await ops.check()
      assert.deepEqual([await events(), await store.ops.undelivered()], [[], []])
      await ops.check()
      assert.deepEqual((await events()).map((event) => [event.data.call, event.data.subject, event.data.campaign]), [['miss', subject, 'after']])
      assert.match((await store.ops.undelivered())[0]!.text, /google, after .*contact:desk$/)
    })

    for (const change of ['reassign', 'erase']) for (const during of ['enqueue', 'retry']) test(`a callback alert held during ${during} cannot name a record after ${change}`, async () => {
      const { graph, store, clock } = await fresh()
      const from = '+12025550171'
      const to = '+12025550172'
      const id = 'miss'
      for (const subject of ['contact:a', 'contact:b']) await graph.touch({ subject, at: T0, source: 'google', campaignId: subject.slice(-1), gclid: subject.slice(-1) })
      await recordCall(graph, { id, from, to, at: T0 + 1, answered: false })
      await graph.sayParty({ call: id, key: 'first', at: T0 + 2, party: { role: 'self', subject: 'contact:a', by: 'desk' } })
      clock.now += 2 * HOUR
      let changed = false
      const move = async () => {
        changed = true
        if (change === 'erase') await graph.forget('contact:a')
        else await graph.sayParty({ call: id, key: 'second', at: clock.now, party: { role: 'self', subject: 'contact:b', by: 'desk' } })
      }
      const events = async () => (await store.read((tx) => tx.eventsAfter(0, 100))).filter((event) => event.type === 'callback.overdue')
      const racing: Store = { ...store,
        write: async (work, options) => {
          const result = await store.write(work, options)
          if (during === 'enqueue' && !changed && (await events()).length > 0) await move()
          return result
        },
        ops: { ...store.ops, claimAlert: async (at, before) => {
          const alert = await store.ops.claimAlert(at, before)
          if (during === 'retry' && !changed && alert) await move()
          return alert
        } },
      }
      const posted: string[] = []
      const options: OpsOptions = { now: () => clock.now, returnHours: 1, emit: (event) => racing.write((tx) => tx.emit([event])) }
      const reader = createGraph(racing)
      if (during === 'retry') {
        await createOps(reader, racing.ops, options).check()
        assert.equal((await store.ops.undelivered()).length, 1)
        clock.now += 120_000
      }
      const ops = createOps(reader, racing.ops, { ...options, url: 'https://example.org/hooks', fetch: async (_url, init) => {
        posted.push(JSON.parse(String(init?.body)).text)
        return new Response(null, { status: 200 })
      } })
      await ops.check()
      assert.ok(changed)
      assert.deepEqual(posted, [])
      assert.deepEqual(await events(), [])
      assert.deepEqual(await store.ops.undelivered(), [])
      await ops.check()
      if (change === 'reassign') {
        assert.equal(posted.length, 1)
        assert.match(posted[0]!, /google, b .*contact:b$/)
        assert.deepEqual((await events()).map((event) => event.data), [{ call: id, subject: 'contact:b', missedAt: T0 + 1, attempts: 0, source: 'google', campaign: null, campaignId: 'b' }])
      } else assert.deepEqual([posted, await events()], [[], []])
    })

    test('a missed caller from a paid arrival is told once, when they have waited long enough', async () => {
      const { graph, ops, make, clock, posted } = await fresh({ returnHours: 24 })
      const numbers = { '+15550100001': { source: 'google', campaignId: '111', campaign: 'Search' }, '+15550100002': { source: 'mailer', campaign: 'postcard' } }
      const miss = (id: string, from: string, to = '+15550100001', at = clock.now) => recordCall(graph, { id, from, to, at, duration: 9, answered: false }, { numbers })
      await miss('A1', '+15550100011')
      await miss('B1', '+15550100012', '+15550100002')
      await miss('C1', '+15550100013')
      clock.now += HOUR
      await miss('A2', '+15550100011')
      await recordCall(graph, { id: 'OUT', direction: 'outbound', from: '+15550100001', to: '+15550100013', at: clock.now, answered: true })
      await recordCall(graph, { id: 'TRY', direction: 'outbound', from: '+15550100001', to: '+15550100011', at: clock.now + 1, answered: false })
      clock.now = T0 + 24 * HOUR - 1
      await ops.check()
      assert.deepEqual(posted, [])
      // One for the caller, not one for each of their misses. None for the one from a postcard, and none for the one rung back.
      clock.now += 1
      await Promise.all([ops.check(), make().check()])
      clock.now += 5 * HOUR
      await ops.check()
      assert.equal(posted.length, 1)
      assert.match(posted[0]!, /a caller from google, Search has waited over 24 hours for a callback\. Missed Nov 14, 2023, 10:13 PM \(UTC\)\. 1 callback attempt\. caller:/)
      // They miss again: still the same wait. They are reached, and miss again later: a new one.
      await miss('A3', '+15550100011')
      clock.now += 25 * HOUR
      await ops.check()
      assert.equal(posted.length, 1)
      await recordCall(graph, { id: 'GOT', direction: 'outbound', from: '+15550100001', to: '+15550100011', at: clock.now, answered: true })
      clock.now += HOUR
      await miss('A4', '+15550100011')
      clock.now += 25 * HOUR
      await ops.check()
      assert.equal(posted.length, 2)
      // Pruning everything does not make it news again.
      await graph.prune(clock.now)
      await ops.check()
      assert.equal(posted.length, 2)
      // Off, nothing is said. Far in the past, it is for the Calls view.
      await miss('D1', '+15550100014')
      clock.now += 25 * HOUR
      await make({ returnHours: 0 }).check()
      clock.now += 20 * DAY
      await ops.check()
      assert.equal(posted.length, 2)
      assert.deepEqual((await ops.state()).undelivered, [])
      // A wait longer than the look back is told about all the same.
      await miss('E1', '+15550100015')
      clock.now += 20 * DAY
      await make({ returnHours: 480 }).check()
      assert.equal(posted.length, 3)
    })

    test('with opening hours, a night says nothing about calls, and a caller waits while you are open', async () => {
      // T0 is a Tuesday, 22:13 in UTC. Open 9 to 17 on weekdays, and Thursday is a holiday.
      const week = ['09:00-17:00']
      const hours = createHours({ mon: week, tue: week, wed: week, thu: week, fri: week, holidays: ['2023-11-16'] })
      const { graph, ops, clock, posted } = await fresh({ quiet: { calls: 4, touches: 4 }, returnHours: 8, hours })
      const at = (day: number, hour: number) => Date.UTC(2023, 10, day, hour)
      clock.now = at(14, 16)
      await graph.touch({ subject: 'visitor:1', at: at(14, 15), gclid: 'G', campaign: 'Search' })
      await graph.observe({ subject: 'visitor:1', identifiers: [`phone:${hashPhone('+15550100071')}`], at: at(14, 15) })
      await recordCall(graph, { id: 'N1', from: '+15550100071', to: '+15550100001', at: at(14, 16), duration: 20, answered: false }, { results: 'expected', now: () => clock.now })
      // All night, and until noon, under four hours open have passed. Visits come at night too, so their feed is counted by the clock.
      clock.now = at(15, 11)
      await ops.check()
      assert.deepEqual(posted.map((text) => /no (touches|calls) for (\d+ \w+)/.exec(text)?.slice(1)), [['touches', '4 hours']])
      assert.deepEqual((await ops.state()).feeds.map((feed) => [feed.name, feed.quiet]).slice(0, 2), [['touches', true], ['calls', false]])
      clock.now = at(15, 12)
      await ops.check()
      assert.match(posted.at(-1)!, /no calls for 4 open hours/)
      assert.equal((await ops.state()).feeds[1]!.quiet, true)
      // Eight hours open since the miss: an hour on Tuesday, and seven on Wednesday. Thursday is a holiday.
      clock.now = at(15, 15)
      await ops.check()
      assert.equal(posted.some((text) => text.includes('callback')), false)
      clock.now = at(15, 16)
      await ops.check()
      assert.match(posted.at(-1)!, /has waited over 8 open hours for a callback/)
      // Two weeks past due and no more, counted from when it was due and not from when they rang.
      await recordCall(graph, { id: 'N2', from: '+15550100072', to: '+15550100001', at: at(15, 16), duration: 20, answered: false }, { results: 'expected', now: () => clock.now })
      await graph.touch({ subject: `caller:${hashPhone('+15550100072')}`, at: at(15, 15), gclid: 'H' })
      // Due on Friday at 16: an hour on Wednesday, none on Thursday, seven on Friday.
      clock.now = at(17, 16) + 14 * DAY - HOUR
      const count = posted.length
      await ops.check()
      assert.equal(posted.slice(count).filter((text) => text.includes('callback')).length, 1)
    })

    test('a miss that was no lead is told to nobody, and does not hide the next one', async () => {
      const { graph, ops, clock, posted } = await fresh({ returnHours: 1 })
      const from = '+15550100074'
      const miss = (id: string, at: number) => recordCall(graph, { id, from, to: '+15550100001', at, duration: 20, answered: false }, { results: 'expected', now: () => clock.now })
      await graph.touch({ subject: `caller:${hashPhone(from)}`, at: T0, gclid: 'G' })
      await miss('S1', T0 + 1000)
      clock.now = T0 + 2 * HOUR
      await ops.check()
      assert.equal(posted.length, 1)
      await graph.markNotLead('call:S1', 'other')
      await miss('S2', T0 + 2 * HOUR)
      clock.now = T0 + 4 * HOUR
      await ops.check()
      assert.equal(posted.length, 2)
      await miss('S3', T0 + 5 * HOUR)
      await graph.markNotLead('call:S3', 'spam')
      await graph.markNotLead('call:S2', 'spam')
      clock.now = T0 + 9 * HOUR
      await ops.check()
      assert.equal(posted.length, 2)
    })

    test('an alert that could not be delivered stays until it is', async () => {
      const { graph, ops, make, clock, posted, hook, errors, store } = await fresh({ quiet: { touches: 1 }, returnHours: 1 })
      await graph.touch({ subject: 'visitor:1', at: T0, gclid: 'G' })
      await recordCall(graph, { id: 'A1', from: '+15550100011', to: '+15550100001', at: T0, duration: 9, answered: false }, { numbers: { '+15550100001': { source: 'google', campaignId: '1' } } })
      clock.now += 2 * HOUR
      hook.status = 500
      await ops.check()
      assert.equal(await ops.alert('outbox', 'the outbox could not run'), false)
      const left = (await ops.state()).undelivered
      assert.deepEqual(left.map((alert) => [alert.key.split(':')[0], alert.error]).sort(), [['alert', 'The alert webhook returned 500'], ['quiet', 'The alert webhook returned 500'], ['unreturned', 'The alert webhook returned 500']])
      assert.equal(errors.length, 3)
      // The same words again are the same message. Other words are another, and neither takes the other's place.
      assert.equal(await ops.alert('outbox', 'the outbox could not run'), false)
      assert.equal((await ops.state()).undelivered.length, 3)
      assert.equal(await ops.alert('outbox', 'the outbox still could not run'), false)
      assert.equal((await ops.state()).undelivered.length, 4)
      // Delivered once the webhook answers, by one server of two, each exactly once.
      hook.status = 200
      clock.now += 60_000
      await Promise.all([ops.check(), make().check()])
      assert.equal(posted.length, 4)
      assert.ok(posted.includes('the outbox could not run') && posted.includes('the outbox still could not run'))
      assert.deepEqual((await ops.state()).undelivered, [])
      clock.now += 60_000
      await ops.check()
      assert.equal(posted.length, 4)
      // One that was not delivered is settled by delivering it, and by nothing else.
      hook.status = 500
      clock.now += HOUR
      await ops.alert('costs:google', 'stale')
      hook.status = 200
      assert.equal(await ops.alert('costs:google', 'stale still'), true)
      assert.deepEqual((await ops.state()).undelivered.map((alert) => alert.text), ['stale'])
      clock.now += 60_000
      await ops.check()
      assert.deepEqual([posted.at(-1), (await ops.state()).undelivered], ['stale', []])
      // The very same words, not delivered again after they once were: they wait again.
      hook.status = 500
      clock.now += HOUR
      await ops.alert('costs:google', 'stale')
      assert.deepEqual((await ops.state()).undelivered.map((alert) => alert.text), ['stale'])
      hook.status = 200
      clock.now += 60_000
      await ops.check()
      await ops.alert('costs:google', 'stale still')
      assert.deepEqual((await ops.state()).undelivered, [])
      // A webhook that is down is tried once a pass, not once for every alert that waits.
      hook.status = 500
      for (let n = 0; n < 5; n++) await ops.alert(`many:${n}`, `one of many ${n}`)
      const tries = errors.length
      clock.now += 60_000
      await ops.check()
      assert.equal(errors.length, tries + 1)
      hook.status = 200
      clock.now += 60_000
      await ops.check()
      clock.now += 60_000
      await ops.check()
      assert.deepEqual((await ops.state()).undelivered, [])
      // One the webhook will never take does not keep the others from their turn.
      hook.refuse = 'poison'
      await ops.alert('a', 'poison')
      hook.status = 500
      await ops.alert('b', 'ordinary')
      hook.status = 200
      for (let pass = 0; pass < 3; pass++) {
        clock.now += 60_000
        await ops.check()
      }
      assert.deepEqual((await ops.state()).undelivered.map((alert) => alert.text), ['poison'])
      hook.refuse = ''
      clock.now += 60_000
      await ops.check()
      assert.deepEqual((await ops.state()).undelivered, [])
      // The same kind is held back for ten minutes.
      assert.equal(await ops.alert('costs:google', 'again'), false)

      // Forgetting the caller deletes the alert about them. Pruning deletes old delivered ones and never one still to deliver.
      hook.status = 500
      await recordCall(graph, { id: 'B1', from: '+15550100012', to: '+15550100001', at: clock.now, duration: 9, answered: false }, { numbers: { '+15550100001': { source: 'google', campaignId: '1' } } })
      clock.now += 2 * HOUR
      await ops.check()
      assert.equal((await ops.state()).undelivered.filter((alert) => alert.subject).length, 1)
      await graph.forget(`caller:${hashPhone('+15550100012')}`)
      assert.equal((await ops.state()).undelivered.filter((alert) => alert.subject).length, 0)
      await ops.alert('outbox', 'down again')
      const waiting = (await ops.state()).undelivered.length
      clock.now += 60 * DAY
      await graph.prune(clock.now)
      assert.equal((await ops.state()).undelivered.length, waiting)

      hook.status = 200
      assert.deepEqual(await ops.test(), { delivered: true })
      hook.status = 404
      assert.deepEqual(await ops.test(), { delivered: false, error: 'The alert webhook returned 404' })
      assert.match((await ops.state()).undelivered.at(-1)!.text, /test alert/)
      assert.deepEqual(await createOps(graph, store.ops, { now: () => clock.now }).test(), { delivered: false, error: 'No webhook is set. Set ALERT_WEBHOOK.' })
    })

    test('jobs say when they began and how they ended, and one that never finished says so', async () => {
      const { graph, ops, make, clock } = await fresh()
      const version = await graph.version()
      assert.equal(await ops.run('costs', async () => 7), 7)
      clock.now += 1000
      await assert.rejects(ops.run('costs', () => Promise.reject(new Error('refused with 401'))), /401/)
      let finish: () => void = undefined!
      const hanging = ops.run('outbox', () => new Promise<void>((resolve) => (finish = resolve)))
      await until(() => finish)
      const read = async () => Object.fromEntries((await ops.state()).jobs.map((job) => [job.name, job]))
      let jobs = await read()
      assert.deepEqual(jobs.costs, { name: 'costs', started: T0 + 1000, succeeded: T0, failed: T0 + 1000, error: 'refused with 401', outcome: 'failed', open: [], state: 'failed' })
      assert.equal(jobs.outbox!.state, 'running')
      // Restarted a minute later and run again: the run that never finished stays on record as its own.
      clock.now += 60_000
      await make().run('outbox', async () => undefined)
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', []])
      clock.now += 15 * 60_000
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', [T0 + 1000]])
      // An older run ending does not make a newer one that hangs look finished.
      let finishNewer: () => void = undefined!
      const newer = make().run('outbox', () => new Promise<void>((resolve) => (finishNewer = resolve)))
      await until(() => finishNewer)
      const began = clock.now
      clock.now += 1
      finish()
      await hanging
      clock.now += 15 * 60_000
      jobs = await read()
      assert.deepEqual([jobs.outbox!.state, jobs.outbox!.open], ['stuck', [began]])
      finishNewer()
      await newer
      // The newer run succeeds, then an older one fails: the state is still the newer one's, and the failure is on record.
      let failOlder: (error: Error) => void = undefined!
      const older = ops.run('outbox', () => new Promise<void>((_, reject) => (failOlder = reject)))
      await until(() => failOlder)
      clock.now += 1
      await make().run('outbox', async () => undefined)
      clock.now += 1
      failOlder(new Error('late'))
      await assert.rejects(older, /late/)
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.failed, (await read()).outbox!.error], ['done', clock.now, 'late'])
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', []])
      // None of it counts as a write, so no screen reloads because a job ran.
      assert.equal(await graph.version(), version)
    })
  })
}
