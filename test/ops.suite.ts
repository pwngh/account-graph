import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { createGraph, createHours, createOps, hashPhone, recordCall } from '../tools/internals.ts'
import type { OpsOptions } from '../tools/internals.ts'
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
