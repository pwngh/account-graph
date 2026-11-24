import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { createGraph, createOps, hashPhone, recordCall } from '../src/index.ts'
import type { OpsOptions } from '../src/index.ts'
import type { Opened } from './suite.ts'

const T0 = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

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
      const hook = { status: 200 }
      const fetcher = (async (_url: string, init: { body: string }) => {
        if (hook.status !== 200) return new Response('no', { status: hook.status })
        posted.push(JSON.parse(init.body).text)
        return new Response('ok')
      }) as unknown as typeof fetch
      const graph = createGraph(next.store, undefined, { now: () => clock.now })
      const errors: unknown[] = []
      const make = (more: OpsOptions = {}) => createOps(graph, next.store.ops, { url: 'https://hooks.example/x', fetch: fetcher, now: () => clock.now, onError: (error) => void errors.push(error), ...options, ...more })
      return { graph, ops: make(), make, clock, posted, hook, errors, store: next.store }
    }

    test('a feed that goes quiet is said once, and once more when it goes quiet again', async () => {
      const { graph, ops, make, clock, posted } = await fresh({ quiet: { touches: 6, costs: 48 }, timeZone: 'America/New_York' })
      const touch = () => graph.touch({ subject: 'visitor:1', at: clock.now, gclid: 'G' })
      await touch()
      clock.now += 6 * HOUR - 1
      await ops.check()
      assert.deepEqual(posted, [])
      clock.now += 1
      for (let i = 0; i < 3; i++) await ops.check()
      assert.deepEqual(posted, ['account-graph: no touches for 6 hours. The last was written down Nov 14, 2023, 5:13 PM (America/New_York).'])
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
      assert.match(posted.at(-1)!, /no costs for 48 hours\. None has ever been recorded\./)
      // Each feed is fed by its own records. A touch dated in the past still fed it now.
      await graph.spend({ day: '2023-11-14', source: 'google', amount: 1 })
      await graph.touch({ subject: 'visitor:1', at: 5, gclid: 'G' })
      await recordCall(graph, { id: 'C1', from: '+15550100001', to: '+15550100002', at: T0, duration: 60, answered: true })
      assert.deepEqual((await ops.state()).feeds.map((feed) => feed.last), [clock.now, clock.now, clock.now, clock.now])
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
      assert.match(posted[0]!, /a caller from google, Search has waited over 24 hours for a call back\. Missed Nov 14, 2023, 10:13 PM \(UTC\)\. Rung back once, not reached\. caller:/)
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

    test('an alert that could not be delivered stays until it is', async () => {
      const { graph, ops, make, clock, posted, hook, errors, store } = await fresh({ quiet: { touches: 1 }, returnHours: 1 })
      await graph.touch({ subject: 'visitor:1', at: T0, gclid: 'G' })
      await recordCall(graph, { id: 'A1', from: '+15550100011', to: '+15550100001', at: T0, duration: 9, answered: false }, { numbers: { '+15550100001': { source: 'google', campaignId: '1' } } })
      clock.now += 2 * HOUR
      hook.status = 500
      await ops.check()
      assert.equal(await ops.alert('outbox', 'the outbox could not run'), false)
      const left = (await ops.state()).undelivered
      assert.deepEqual(left.map((alert) => [alert.key.split(':')[0], alert.error]).sort(), [['alert', 'The alert webhook answered 500'], ['quiet', 'The alert webhook answered 500'], ['unreturned', 'The alert webhook answered 500']])
      assert.equal(errors.length, 3)
      // The same words again are the same message. Other words are another, and neither takes the other's place.
      assert.equal(await ops.alert('outbox', 'the outbox could not run'), false)
      assert.equal((await ops.state()).undeliveredCount, 3)
      assert.equal(await ops.alert('outbox', 'the outbox still could not run'), false)
      assert.equal((await ops.state()).undeliveredCount, 4)
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
      assert.deepEqual(await ops.test(), { delivered: false, error: 'The alert webhook answered 404' })
      assert.match((await ops.state()).undelivered.at(-1)!.text, /this is a test alert/)
      assert.deepEqual(await createOps(graph, store.ops, { now: () => clock.now }).test(), { delivered: false, error: 'No webhook is set. Set ALERT_WEBHOOK.' })
    })

    test('jobs say when they began and how they ended, and one that never finished says so', async () => {
      const { graph, ops, make, clock } = await fresh()
      const version = await graph.version()
      assert.equal(await ops.run('costs', async () => 7), 7)
      clock.now += 1000
      await assert.rejects(ops.run('costs', () => Promise.reject(new Error('refused with 401'))), /401/)
      let finish!: () => void
      const hanging = ops.run('outbox', () => new Promise<void>((resolve) => (finish = resolve)))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const read = async () => Object.fromEntries((await ops.state()).jobs.map((job) => [job.name, job]))
      let jobs = await read()
      assert.deepEqual(jobs.costs, { name: 'costs', started: T0 + 1000, succeeded: T0, failed: T0 + 1000, error: 'refused with 401', open: [], state: 'failed' })
      assert.equal(jobs.outbox!.state, 'running')
      // Restarted a minute later and run again: the run that never finished stays on record as its own.
      clock.now += 60_000
      await make().run('outbox', async () => undefined)
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', []])
      clock.now += 15 * 60_000
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', [T0 + 1000]])
      // An older run ending does not make a newer one that hangs look finished.
      let finishNewer!: () => void
      const newer = make().run('outbox', () => new Promise<void>((resolve) => (finishNewer = resolve)))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const began = clock.now
      finish()
      await hanging
      clock.now += 15 * 60_000
      jobs = await read()
      assert.deepEqual([jobs.outbox!.state, jobs.outbox!.open], ['stuck', [began]])
      finishNewer()
      await newer
      assert.deepEqual([(await read()).outbox!.state, (await read()).outbox!.open], ['done', []])
      // None of it counts as a write, so no screen reloads because a job ran.
      assert.equal(await graph.version(), version)
    })
  })
}
