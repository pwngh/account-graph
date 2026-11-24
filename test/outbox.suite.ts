import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { GoogleError, MetaError, createBatcher, createGraph, createOutbox, googleAds, hashEmail, meta, microsoftAds, tiktok, recordNotLead } from '../src/index.ts'
import type { IngestRequest, OutboxOptions, Outcome, Store } from '../src/index.ts'
import type { Opened } from './suite.ts'

const T0 = 1_700_000_000_000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A stand-in for Google that records every request and can be told to refuse. */
function google() {
  const requests: IngestRequest[] = []
  let refuse: ((request: IngestRequest) => Error | undefined) | undefined
  return {
    requests,
    refuseWith(rule: typeof refuse) {
      refuse = rule
    },
    ids: () => requests.flatMap((request) => request.events.map((event) => event.transactionId as string)),
    send: async (request: IngestRequest) => {
      const error = refuse?.(request)
      if (error) throw error
      requests.push(request)
      return { requestId: `req-${requests.length}` }
    },
  }
}

/** Every store must pass this too. */
export function outboxSuite(name: string, open: () => Promise<Opened>) {
  describe(`${name}: outbox`, () => {
    const opened: Opened[] = []
    after(async () => {
      for (const each of opened) await each.close()
    })
    const fresh = async (options: Partial<OutboxOptions> = {}) => {
      const next = await open()
      opened.push(next)
      const graph = createGraph(next.store)
      const remote = google()
      const clock = { now: T0 + 2 * HOUR }
      const outbox = createOutbox(graph, next.store.outbox, {
        targets: [googleAds({ customerId: '123-456-7890', send: remote.send })],
        now: () => clock.now,
        random: () => 1,
        ...options,
      })
      return { graph, outbox, remote, clock, store: next.store as Store }
    }
    /** A visitor clicks an ad, then enrolls in the same browser as `contact:<n>`. */
    const enroll = async (graph: ReturnType<typeof createGraph>, n: number) => {
      await graph.observe({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at: T0, event: 'visit' })
      await graph.touch({ subject: `visitor:v${n}`, at: T0, gclid: `G${n}` })
      await graph.observe({ subject: `contact:${n}`, identifiers: [`device:v${n}`], at: T0 + HOUR, event: 'enroll' })
    }
    const outcome = (n: number, more: Partial<Outcome> = {}): Outcome => ({
      transactionId: `enroll-${n}`,
      subject: `contact:${n}`,
      at: T0 + HOUR,
      action: '900',
      value: 200,
      ...more,
    })

    test('an outcome is sent once, with its click and hashed email', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1, { email: 'Pat.Lee@gmail.com' }))
      await outbox.record(outcome(1, { email: 'Pat.Lee@gmail.com' }))

      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 0 })
      assert.equal(remote.requests.length, 1)
      const [request] = remote.requests
      assert.equal(request!.validateOnly, false)
      assert.deepEqual(request!.destinations, [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '900' }])
      assert.deepEqual(request!.events, [
        {
          transactionId: 'enroll-1',
          eventTimestamp: new Date(T0 + HOUR).toISOString(),
          eventSource: 'WEB',
          adIdentifiers: { gclid: 'G1' },
          userData: { userIdentifiers: [{ emailAddress: hashEmail('patlee@gmail.com') }] },
          conversionValue: 200,
          currency: 'USD',
        },
      ])
      const [job] = await outbox.get('enroll-1')
      assert.equal(job!.state, 'sent')
      assert.equal(job!.target, 'google')
      assert.equal(job!.requestId, 'req-1')
      assert.deepEqual(job!.click, { gclid: 'G1' })
      assert.equal(job!.confidence, 0.98)
      assert.deepEqual(job!.keys, { email: hashEmail('patlee@gmail.com') })
      assert.equal(JSON.stringify(job).includes('Pat.Lee'), false)
    })

    test("a person's own click is sent however weak the chain to it, unless a lowest confidence was asked for", async () => {
      for (const [options, sent] of [[{}, 1], [{ confidence: 0.9 }, 0]] as const) {
        const { graph, outbox, remote } = await fresh(options)
        // The browser, the caller it called as, and the contact taken on the phone: two links of 0.92 and 0.9.
        await graph.observe([
          { subject: 'visitor:v1', identifiers: ['device:v1', 'dial:c1'], at: T0 },
          { subject: 'caller:1', identifiers: ['dial:c1', 'phone:p1'], at: T0 },
          { subject: 'contact:1', identifiers: ['phone:p1'], at: T0 },
        ])
        await graph.touch({ subject: 'visitor:v1', at: T0, gclid: 'G1' })
        await outbox.record(outcome(1))
        assert.equal((await outbox.run()).sent, sent)
        const [job] = await outbox.get('enroll-1')
        if (sent) assert.ok(Math.abs(job!.confidence! - 0.92 * 0.9) < 1e-12)
        else assert.equal(job!.note, 'no_match_key')
        assert.equal(remote.requests.length, sent)
      }
    })

    test('nothing is queued for someone forgotten between their outcome and its job', async () => {
      const { graph, outbox, store } = await fresh()
      await outbox.record(outcome(1, { email: 'pat@example.org' }))
      const [job] = await outbox.get('enroll-1')
      await graph.forget('contact:1')
      assert.deepEqual(await outbox.get('enroll-1'), [])
      // The job of a record that was under way arrives after the deletion.
      assert.equal(await store.outbox.add(job!, true), undefined)
      // And one that arrives while the deletion is under way.
      await outbox.record(outcome(2))
      const [second] = await outbox.get('enroll-2')
      await Promise.all([graph.forget('contact:2'), store.outbox.add(second!, true)])
      assert.deepEqual(await outbox.get('enroll-2'), [])
      assert.deepEqual(await outbox.get('enroll-1'), [])
    })

    test('an outcome with nothing to match by waits for a click, and is given up on in the end', async () => {
      const { graph, outbox, remote, clock } = await fresh()
      await graph.observe({ subject: 'visitor:v1', identifiers: ['device:v1'], at: T0 })
      await graph.touch({ subject: 'visitor:v1', at: T0, gclid: 'G1' })
      await outbox.record(outcome(1))
      await outbox.record(outcome(2))
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 2 })
      const [waiting] = await outbox.get('enroll-1')
      assert.deepEqual([waiting!.state, waiting!.note, waiting!.attempts], ['pending', 'no_match_key', 0])
      // Not due again yet, it is left alone.
      await outbox.run()
      assert.equal((await outbox.get('enroll-1'))[0]!.rev, waiting!.rev)
      // Their browser is known now, and the conversion goes out with its click.
      await graph.observe({ subject: 'contact:1', identifiers: ['device:v1'], at: T0 + 3 * HOUR })
      clock.now += DAY
      assert.equal((await outbox.run()).sent, 1)
      const [sent] = await outbox.get('enroll-1')
      assert.deepEqual([sent!.state, sent!.click, sent!.note], ['sent', { gclid: 'G1' }, undefined])
      // The other is looked at a few dozen times at most, and no more after a week.
      let looked = 0
      for (; (await outbox.get('enroll-2'))[0]!.state === 'pending'; looked++) {
        clock.now = (await outbox.get('enroll-2'))[0]!.due
        await outbox.run()
      }
      assert.ok(looked > 3 && looked < 40, `${looked}`)
      assert.deepEqual([(await outbox.get('enroll-2'))[0]!.state, remote.requests.length], ['skipped', 1])
      assert.equal(clock.now, T0 + HOUR + 7 * DAY, 'on the last day, and not after it')
    })

    test('a payment changes what the platform holds, once', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      await outbox.run()
      const paid = await outbox.pay({ id: 'p1', transactionId: 'enroll-1', amount: 75 })
      assert.deepEqual([paid.duplicate, paid.value, paid.jobs.length], [false, 75, 1])
      await outbox.run()
      assert.equal((await outbox.pay({ id: 'p1', transactionId: 'enroll-1', amount: 75 })).jobs.length, 0)
      await outbox.run()
      assert.deepEqual(remote.requests.flatMap((request) => request.events.map((event: any) => event.conversionValue)), [200, 75])
    })

    test('a payment before its conversion is sent changes what is sent, not when', async () => {
      const { graph, outbox, remote, clock } = await fresh({ delay: HOUR })
      await enroll(graph, 1)
      await outbox.pay({ id: 'p0', transactionId: 'enroll-1', amount: 50 })
      assert.deepEqual((await outbox.record(outcome(1))).map((job) => job.value), [50])
      const due = (await outbox.get('enroll-1'))[0]!.due
      await outbox.pay({ id: 'p1', transactionId: 'enroll-1', amount: 25 })
      const [job] = await outbox.get('enroll-1')
      assert.deepEqual([job!.value, job!.due, job!.state], [75, due, 'pending'])
      assert.deepEqual((await outbox.record(outcome(1))).map((each) => each.value), [75], 'recorded again it is the same')
      await outbox.run()
      assert.equal(remote.requests.length, 0)
      clock.now = due
      await outbox.run()
      assert.deepEqual(remote.requests.flatMap((request) => request.events.map((event: any) => event.conversionValue)), [75])
    })

    test('payments at once leave the platform at their sum', async () => {
      const { graph, outbox, store, clock } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      await outbox.run()
      await Promise.all([1, 2, 3, 4, 5].map((n) => outbox.pay({ id: `p${n}`, transactionId: 'enroll-1', amount: 10 })))
      assert.deepEqual((await outbox.get('enroll-1')).map((job) => job.value), [50])
      // The first is cut off before it tells the platform, and the second is told meanwhile.
      const late = createOutbox({ ...graph, pay: async (payment) => {
        const paid = await graph.pay(payment)
        await outbox.pay({ id: 'p7', transactionId: 'enroll-1', amount: 10 })
        return paid
      } }, store.outbox, { targets: [googleAds({ customerId: '123-456-7890', send: google().send })], now: () => clock.now })
      await late.pay({ id: 'p6', transactionId: 'enroll-1', amount: 10 })
      assert.deepEqual((await outbox.get('enroll-1')).map((job) => job.value), [70])
      // One stored after another that found nothing to change is put right.
      await enroll(graph, 2)
      await outbox.record(outcome(2))
      await outbox.run()
      let first = true
      const paused = createOutbox({ ...graph, outcomeOf: async (id) => {
        const found = await graph.outcomeOf(id)
        if (first) {
          first = false
          await outbox.pay({ id: 'q2', transactionId: 'enroll-2', amount: 100 })
        }
        return found
      } }, store.outbox, { targets: [googleAds({ customerId: '123-456-7890', send: google().send })], now: () => clock.now })
      await paused.pay({ id: 'q1', transactionId: 'enroll-2', amount: 100 })
      assert.deepEqual((await outbox.get('enroll-2')).map((job) => job.value), [200])
    })

    test('the same id with different details is refused', async () => {
      const { outbox } = await fresh()
      await outbox.record(outcome(1))
      await assert.rejects(outbox.record(outcome(1, { value: 999 })), /already recorded/)
      await assert.rejects(outbox.record({ ...outcome(2), action: '' }), TypeError)
    })

    test('an outcome with nothing for Google to match is skipped, and so is one without consent', async () => {
      const { graph, outbox, remote } = await fresh({ patience: 0 })
      await enroll(graph, 1)
      await outbox.record(outcome(7))
      await outbox.record(outcome(1, { consent: { adUserData: false, adPersonalization: false } }))
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 2, failed: 0, retried: 0 })
      assert.equal((await outbox.get('enroll-7'))[0]!.note, 'no_match_key')
      assert.equal((await outbox.get('enroll-1'))[0]!.note, 'consent_denied')
      assert.equal(remote.requests.length, 0)
    })

    test('stored consent decides when the outcome carries none', async () => {
      const { graph, outbox, remote } = await fresh()
      for (const n of [1, 2, 3]) await enroll(graph, n)
      // 1: the browser that clicked opted out. 2: both agreed. 3: nobody answered.
      await graph.consent('visitor:v1', { adUserData: false, adPersonalization: false })
      await graph.consent('visitor:v2', { adUserData: true, adPersonalization: false })
      await graph.consent('contact:2', { adUserData: true, adPersonalization: true })
      for (const n of [1, 2, 3]) await outbox.record(outcome(n))
      assert.deepEqual(await outbox.run(), { sent: 2, skipped: 1, failed: 0, retried: 0 })
      assert.equal((await outbox.get('enroll-1'))[0]!.note, 'consent_denied')
      const events = Object.fromEntries(remote.requests[0]!.events.map((event) => [event.transactionId, event.consent]))
      assert.deepEqual(events['enroll-2'], { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' })
      assert.equal(events['enroll-3'], undefined)
    })

    test('the answer given last decides, not the one that arrived last', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      await graph.consent('contact:1', { adUserData: false, adPersonalization: false }, { at: T0 + 20, source: 'form' })
      await graph.consent('contact:1', { adUserData: true, adPersonalization: true }, { at: T0 + 10, source: 'import' })
      await outbox.record(outcome(1))
      assert.equal((await outbox.run()).skipped, 1)
      assert.deepEqual([(await outbox.get('enroll-1'))[0]!.note, remote.requests], ['consent_denied', []])
      await graph.consent('contact:1', { adUserData: true, adPersonalization: true }, { at: T0 + 30, source: 'form' })
      await outbox.retry('enroll-1')
      assert.equal((await outbox.run()).sent, 1)
      // An outcome that says yes itself is still not sent once the person, or the browser that clicked, has said no since.
      for (const [n, who] of [[2, 'contact:2'], [3, 'visitor:v3']] as const) {
        await enroll(graph, n)
        await outbox.record(outcome(n, { consent: { adUserData: true, adPersonalization: true } }))
        await graph.consent(who, { adUserData: false, adPersonalization: false }, { at: outcome(n).at + (n - 2) })
        assert.deepEqual([await outbox.run(), (await outbox.get(`enroll-${n}`))[0]!.note], [{ sent: 0, skipped: 1, failed: 0, retried: 0 }, 'consent_denied'])
      }
      // A refusal from before the outcome does not stand against it.
      await enroll(graph, 4)
      await graph.consent('contact:4', { adUserData: false, adPersonalization: false }, { at: outcome(4).at - 1 })
      await outbox.record(outcome(4, { consent: { adUserData: true, adPersonalization: true } }))
      assert.equal((await outbox.run()).sent, 1)
    })

    test('a weakly tied click is left out and the email is sent alone', async () => {
      const { graph, outbox, remote } = await fresh()
      await graph.observe({ subject: 'visitor:w', identifiers: ['canvas:c', 'ip:198.51.100.8'], at: T0 })
      await graph.touch({ subject: 'visitor:w', at: T0, gclid: 'GW' })
      await graph.observe({ subject: 'contact:3', identifiers: ['canvas:c', 'ip:198.51.100.8'], at: T0 })
      await outbox.record(outcome(3, { email: 'sam@example.com', phone: '(800) 555-0100' }))
      await outbox.run()
      const [event] = remote.requests[0]!.events
      assert.equal(event!.adIdentifiers, undefined)
      assert.equal((event!.userData as any).userIdentifiers.length, 2)
      assert.equal((await outbox.get('enroll-3'))[0]!.click, undefined)
    })

    test('an outage is retried with backoff and then sent', async () => {
      const { graph, outbox, remote, clock } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      remote.refuseWith(() => new GoogleError(503, 'unavailable'))

      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 1 })
      let job = (await outbox.get('enroll-1'))[0]!
      assert.equal(job.state, 'pending')
      assert.equal(job.attempts, 1)
      assert.equal(job.due, clock.now + 30_000)
      assert.match(job.note!, /503/)

      clock.now += 29_000
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 0 })
      clock.now += 1_000
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 1 })
      assert.equal((await outbox.get('enroll-1'))[0]!.due, clock.now + 60_000)

      remote.refuseWith(undefined)
      clock.now += 60_000
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      job = (await outbox.get('enroll-1'))[0]!
      assert.equal(job.state, 'sent')
      assert.equal(job.attempts, 3)
    })

    test('each wait before a retry is longer than the one before, in milliseconds, up to an hour', async () => {
      const waits = async (random: () => number) => {
        const { graph, outbox, remote, clock } = await fresh({ maxAttempts: 12, random })
        await enroll(graph, 1)
        await outbox.record(outcome(1))
        remote.refuseWith(() => new GoogleError(503, 'unavailable'))
        const out: number[] = []
        for (let i = 0; i < 11; i++) {
          assert.equal((await outbox.run()).retried, 1)
          const { due } = (await outbox.get('enroll-1'))[0]!
          out.push(due - clock.now)
          // One millisecond early is too early; on time is not.
          clock.now = due - 1
          assert.equal((await outbox.run()).retried, 0)
          clock.now = due
        }
        return out
      }
      const longest = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000]
      assert.deepEqual(await waits(() => 1), longest)
      // Shortened by as much as half, the waits keep the same shape.
      assert.deepEqual(await waits(() => 0), longest.map((wait) => wait / 2))
    })

    test('a job that keeps failing stops after the last attempt', async () => {
      const heard: string[][] = []
      const { graph, outbox, remote, clock } = await fresh({
        maxAttempts: 3,
        onFailed: (jobs) => {
          heard.push(jobs.map((job) => `${job.transactionId} ${job.target} ${job.state}: ${job.note}`))
          throw new Error('the listener itself fails')
        },
      })
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      remote.refuseWith(() => new Error('socket hang up'))
      for (let i = 0; i < 3; i++) {
        await outbox.run()
        clock.now += 3_600_000
      }
      assert.equal((await outbox.get('enroll-1'))[0]!.state, 'failed')
      assert.deepEqual(await outbox.counts(), { held: 0, pending: 0, sent: 0, skipped: 0, failed: 1 })
      // The listener heard once, on the pass that gave up, and its own failure changed nothing.
      assert.deepEqual(heard, [['enroll-1 google failed: socket hang up']])
    })

    test('one bad event does not sink the rest of its request', async () => {
      const { graph, outbox, remote } = await fresh()
      for (const n of [1, 2, 3]) {
        await enroll(graph, n)
        await outbox.record(outcome(n))
      }
      remote.refuseWith((request) =>
        request.events.some((event) => event.transactionId === 'enroll-2') ? new GoogleError(400, 'invalid event') : undefined,
      )
      assert.deepEqual(await outbox.run(), { sent: 2, skipped: 0, failed: 1, retried: 0 })
      assert.deepEqual(remote.ids().sort(), ['enroll-1', 'enroll-3'])
      const bad = (await outbox.get('enroll-2'))[0]!
      assert.equal(bad.state, 'failed')
      assert.match(bad.note!, /invalid event/)
    })

    test('outcomes for different conversion actions go in separate requests', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      await outbox.record({ ...outcome(1), transactionId: 'paid-1', action: '901', value: 500 })
      await outbox.run()
      assert.deepEqual(remote.requests.map((request) => (request.destinations[0] as any).productDestinationId).sort(), ['900', '901'])
    })

    test('a held outcome waits out its delay, and a dead worker leaves its job to another', async () => {
      const { graph, outbox, remote, clock, store } = await fresh({ delay: 6 * HOUR, lease: 60_000 })
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 0 })

      clock.now += 6 * HOUR
      // A worker claims the job and dies before saving anything.
      assert.equal((await store.outbox.claim(clock.now, 60_000, 10)).length, 1)
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 0 })
      clock.now += 60_000
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      assert.equal((await outbox.get('enroll-1'))[0]!.attempts, 2)
      assert.equal(remote.requests.length, 1)
    })

    test('workers running at once send each job exactly once', async () => {
      const { graph, outbox, remote } = await fresh({ batch: 40 })
      await graph.observe(Array.from({ length: 150 }, (_, n) => ({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at: T0 })))
      await graph.observe(Array.from({ length: 150 }, (_, n) => ({ subject: `contact:${n}`, identifiers: [`device:v${n}`], at: T0 + HOUR })))
      for (let n = 0; n < 150; n++) {
        await graph.touch({ subject: `visitor:v${n}`, at: T0, gclid: `G${n}` })
        await outbox.record(outcome(n))
      }
      const passes = await Promise.all(Array.from({ length: 6 }, () => outbox.run()))
      await outbox.run()
      assert.ok(passes.filter((pass) => pass.sent > 0).length > 1 || passes[0]!.sent === 40)
      const ids = remote.ids()
      assert.equal(ids.length, 150)
      assert.equal(new Set(ids).size, 150)
      assert.deepEqual(await outbox.counts(), { held: 0, pending: 0, sent: 150, skipped: 0, failed: 0 })
    })

    test('a restated value is sent again under the same id', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      await outbox.run()
      const [restated] = await outbox.restate('enroll-1', 120)
      assert.equal(restated!.state, 'pending')
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      assert.deepEqual(remote.requests.map((request) => [request.events[0]!.transactionId, request.events[0]!.conversionValue]), [
        ['enroll-1', 200],
        ['enroll-1', 120],
      ])
      // Recording the original again is still a no-op, not a conflict.
      assert.equal((await outbox.record(outcome(1)))[0]!.value, 120)
      assert.deepEqual(await outbox.restate('unknown', 5), [])
      await assert.rejects(outbox.restate('enroll-1', -1), TypeError)

      // The report counts the outcome once, at its restated value, whatever was sent.
      const report = await graph.report({ from: '2023-11-14', to: '2023-11-15' })
      assert.deepEqual([report.total.outcomes, report.total.value, report.rows[0]!.source], [1, 120, 'google'])
      // An outcome that names no action is counted and sent nowhere.
      assert.deepEqual(await outbox.record({ transactionId: 'walk-in', subject: 'contact:1', at: T0 + HOUR, stage: 'visit' }), [])
      assert.equal((await graph.report({ from: '2023-11-14', to: '2023-11-15' })).total.stages.visit!.count, 1)
      // An outcome the report refuses queues nothing to send.
      await assert.rejects(outbox.record(outcome(2, { value: '12.5' as unknown as number })), TypeError)
      assert.deepEqual(await outbox.get('enroll-2'), [])
    })

    test('one outcome goes to Google and to Meta, each in its own shape', async () => {
      const next = await open()
      opened.push(next)
      const graph = createGraph(next.store)
      const remote = google()
      const posted: { url: string; body: any }[] = []
      let refuse: number | undefined
      const fetcher = (async (url: any, init: any) => {
        if (refuse) return new Response(JSON.stringify({ error: { message: 'bad', type: 'OAuthException', code: refuse === 400 ? 100 : 190 } }), { status: 400 })
        posted.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'trace-1' }))
      }) as typeof fetch
      const clock = { now: T0 + 2 * HOUR }
      const outbox = createOutbox(graph, next.store.outbox, {
        targets: [
          googleAds({ customerId: '123-456-7890', send: remote.send }),
          meta({ pixelId: '555', accessToken: async () => 'meta-token', url: 'https://site.example/', fetch: fetcher }),
        ],
        now: () => clock.now,
        random: () => 1,
      })
      // One browser clicked a Google ad and a Meta ad, then enrolled.
      await graph.observe({ subject: 'visitor:v', identifiers: ['device:v'], at: T0 })
      await graph.touch({ subject: 'visitor:v', at: T0, gclid: 'G1' })
      await graph.touch({ subject: 'visitor:v', at: T0 + 1000, fbclid: 'FbClickId', landing: 'https://site.example/offer' })
      // The pixel's cookie came after the click, with a later arrival of the same browser. Another browser's is not theirs.
      await graph.touch({ subject: 'visitor:v', at: T0 + 2000, source: 'newsletter', fbp: 'fb.1.1700000002000.987654321' })
      await graph.observe({ subject: 'visitor:w', identifiers: ['device:v'], at: T0 })
      await graph.touch({ subject: 'visitor:w', at: T0 + 3000, source: 'newsletter', fbp: 'fb.1.1700000003000.555' })
      await graph.observe({ subject: 'contact:1', identifiers: ['device:v'], at: T0 + HOUR })

      await assert.rejects(outbox.record({ ...outcome(1) }), /per target/)
      await assert.rejects(outbox.record({ ...outcome(1), action: { tiktok: 'x' } }), /unknown target/)
      const jobs = await outbox.record({ ...outcome(1), action: { google: '900', meta: 'Lead' }, email: 'Pat.Lee@gmail.com', phone: '(800) 555-0100' })
      assert.deepEqual(jobs.map((job) => job.target), ['google', 'meta'])
      assert.deepEqual(await outbox.run(), { sent: 2, skipped: 0, failed: 0, retried: 0 })

      assert.deepEqual(remote.requests[0]!.events[0]!.adIdentifiers, { gclid: 'G1' })
      assert.equal(posted[0]!.url, 'https://graph.facebook.com/v27.0/555/events?access_token=meta-token')
      assert.deepEqual(posted[0]!.body, {
        data: [
          {
            event_name: 'Lead',
            event_time: (T0 + HOUR) / 1000,
            event_id: 'enroll-1',
            action_source: 'website',
            event_source_url: 'https://site.example/offer',
            user_data: {
              // Meta keeps the dots in a Gmail address and wants the phone without the plus.
              em: [sha256('pat.lee@gmail.com')],
              ph: [sha256('18005550100')],
              fbc: `fb.1.${T0 + 1000}.FbClickId`,
              fbp: 'fb.1.1700000002000.987654321',
            },
            custom_data: { value: 200, currency: 'USD' },
          },
        ],
      })
      assert.notEqual(jobs[1]!.keys.em, jobs[0]!.keys.email)
      const byTarget = Object.fromEntries((await outbox.get('enroll-1')).map((job) => [job.target, job]))
      assert.deepEqual(byTarget.meta!.click, { fbclid: 'FbClickId' })
      assert.equal(byTarget.meta!.requestId, 'trace-1')

      // Only Google can restate a value.
      assert.deepEqual((await outbox.restate('enroll-1', 50)).map((job) => job.target), ['google'])

      // Meta refuses an event more than seven days old, so it is never sent.
      await outbox.record({ ...outcome(1), transactionId: 'late', at: T0 - 8 * 86_400_000, action: { meta: 'Lead' }, email: 'a@example.com' })
      // A bad token is worth retrying; a rejected event is not.
      await outbox.record({ ...outcome(1), transactionId: 'token', action: { meta: 'Lead' }, email: 'a@example.com' })
      refuse = 190
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 1, failed: 0, retried: 1 })
      assert.equal((await outbox.get('late'))[0]!.note, 'too_old')
      refuse = 400
      clock.now += 60_000
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 1, retried: 0 })
      assert.ok(new MetaError(400, '{"error":{"code":190}}').code === 190)
    })

    test('Microsoft gets its own request shape, and a part-refused request is retried one by one', async () => {
      const next = await open()
      opened.push(next)
      const graph = createGraph(next.store)
      const posted: { url: string; headers: Record<string, string>; body: any }[] = []
      let status = 200
      const fetcher = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        posted.push({ url: String(url), headers: init.headers, body })
        if (status !== 200) return new Response(JSON.stringify({ Errors: [{ Code: 105, ErrorCode: 'InvalidCredentials' }] }), { status })
        // Refuse any conversion for the goal's bad click, the way Microsoft reports it: a 200 with PartialErrors.
        const refused = body.OfflineConversions.flatMap((c: any, Index: number) => (c.MicrosoftClickId === 'BAD' ? [{ Index, ErrorCode: 'OfflineConversionMicrosoftClickIdInvalid', Message: 'bad click' }] : []))
        return new Response(JSON.stringify({ PartialErrors: refused }), { headers: { TrackingId: 'track-1' } })
      }) as typeof fetch
      const clock = { now: T0 + 2 * HOUR }
      const outbox = createOutbox(graph, next.store.outbox, {
        targets: [microsoftAds({ accessToken: () => 'ms-token', developerToken: 'dev', customerId: '11', customerAccountId: '22', fetch: fetcher })],
        now: () => clock.now,
        random: () => 1,
      })
      for (const [n, click] of [[1, 'M1'], [2, 'BAD']] as const) {
        await graph.observe({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at: T0 })
        await graph.touch({ subject: `visitor:v${n}`, at: T0, msclkid: click })
        await graph.observe({ subject: `contact:${n}`, identifiers: [`device:v${n}`], at: T0 + HOUR })
      }
      await outbox.record({ ...outcome(1), action: 'Enrolled', email: ' Pat@Example.com ', phone: '(800) 555-0100' })
      await outbox.record({ ...outcome(2), action: 'Enrolled' })

      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 1, retried: 0 })
      assert.equal(posted[0]!.url, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply')
      assert.deepEqual(posted[0]!.headers, { authorization: 'Bearer ms-token', DeveloperToken: 'dev', CustomerId: '11', CustomerAccountId: '22', 'content-type': 'application/json' })
      assert.deepEqual(posted[0]!.body.OfflineConversions[0], {
        ConversionName: 'Enrolled',
        ConversionTime: new Date(T0 + HOUR).toISOString(),
        ConversionValue: 200,
        ConversionCurrencyCode: 'USD',
        MicrosoftClickId: 'M1',
        HashedEmailAddress: sha256('pat@example.com'),
        HashedPhoneNumber: sha256('+18005550100'),
      })
      // The pair went together once, was part-refused, then each went alone.
      assert.deepEqual(posted.map((request) => request.body.OfflineConversions.length), [2, 1, 1])
      const [good] = await outbox.get('enroll-1')
      assert.equal(good!.state, 'sent')
      assert.equal(good!.requestId, 'track-1')
      assert.deepEqual(good!.click, { msclkid: 'M1' })
      const [bad] = await outbox.get('enroll-2')
      assert.equal(bad!.state, 'failed')
      assert.match(bad!.note!, /bad click/)

      // A refused token is worth another try.
      await outbox.record({ ...outcome(1), transactionId: 'later', action: 'Enrolled' })
      status = 401
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 1 })
    })

    test('a platform that has a way is told when someone is forgotten, only where that is asked for', async () => {
      const next = await open()
      opened.push(next)
      const graph = createGraph(next.store)
      const posted: { url: string; body: any }[] = []
      let answer: () => Response = () => new Response('{}')
      const fetcher = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        posted.push({ url: String(url), body })
        return String(url).includes('Adjustments') ? answer() : new Response('{}')
      }) as typeof fetch
      const clock = { now: T0 + 2 * HOUR }
      const keeps = (name: string, deliver: () => Promise<object>) => ({ name, restates: false, batch: 10, retryable: () => true, keys: () => ({ k: 'hashed' }), click: () => undefined, deliver })
      const targets = [
        microsoftAds({ accessToken: 'ms-token', developerToken: 'dev', customerId: '11', customerAccountId: '22', fetch: fetcher }),
        keeps('keeps', async () => ({})),
        keeps('lost', async () => { throw new Error('timed out') }),
      ]
      const options = { targets, now: () => clock.now, random: () => 1 }
      const telling = createOutbox(graph, next.store.outbox, { ...options, retractOnForget: true })
      const quiet = createOutbox(graph, next.store.outbox, options)
      const enroll = async (n: number) => {
        await graph.observe({ subject: `visitor:v${n}`, identifiers: [`device:v${n}`], at: T0 })
        await graph.touch({ subject: `visitor:v${n}`, at: T0, msclkid: `MSCLK-${n}` })
        await graph.observe({ subject: `contact:${n}`, identifiers: [`device:v${n}`], at: T0 + HOUR })
        await telling.record({ ...outcome(n), action: { microsoft: 'Enrolled', keeps: 'a', lost: 'b' }, email: `pat${n}@example.org` })
      }
      const retractions = () => posted.filter((each) => each.url.includes('Adjustments'))
      for (const n of [1, 2, 3, 4, 5]) await enroll(n)
      await telling.record({ ...outcome(1), transactionId: 'waits', action: { microsoft: 'Enrolled' }, email: 'pat1@example.org' })
      const [waits] = await next.store.outbox.get('waits')
      await next.store.outbox.swap(waits!, { ...waits!, state: 'held' })
      await telling.run()

      const at = T0 + HOUR
      const told = await telling.forget('contact:1', { by: 'dana' })
      assert.ok(told.changes.length > 0)
      assert.deepEqual(told.sent, [
        { transactionId: 'enroll-1', target: 'keeps', action: 'a', at, state: 'not_requested' },
        { transactionId: 'enroll-1', target: 'lost', action: 'b', at, state: 'not_requested', note: 'may not have arrived' },
        { transactionId: 'enroll-1', target: 'microsoft', action: 'Enrolled', at, state: 'accepted' },
      ])
      // Only what had arrived there, and nothing about what had not.
      assert.equal(retractions().length, 1)
      assert.equal(retractions()[0]!.url, 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversionAdjustments/Apply')
      const [{ AdjustmentTime, ...adjustment }, ...others] = retractions()[0]!.body.OfflineConversionAdjustments
      assert.ok(Number.isFinite(Date.parse(AdjustmentTime)))
      assert.deepEqual(adjustment, { AdjustmentType: 'Retract', ConversionName: 'Enrolled', ConversionTime: new Date(at).toISOString(), MicrosoftClickId: 'MSCLK-1', HashedEmailAddress: sha256('pat1@example.org') })
      assert.deepEqual(others, [])
      // Gone here, and nothing of it is kept for later.
      assert.deepEqual([await telling.get('enroll-1'), await telling.get('waits')], [[], []])
      assert.equal((await graph.decisions()).at(0)!.action, 'forget')
      assert.deepEqual(await telling.forget('contact:1'), { changes: [], sent: [] })

      // A refusal, of one or of all, does not stop a person from being forgotten, and says nothing of what was sent.
      answer = () => new Response(JSON.stringify({ PartialErrors: [{ Index: 0, ErrorCode: 'OfflineConversionAdjustmentNotFound', Message: sha256('pat2@example.org') }] }))
      assert.deepEqual((await telling.forget('contact:2')).sent.find((each) => each.target === 'microsoft'), { transactionId: 'enroll-2', target: 'microsoft', action: 'Enrolled', at, state: 'rejected', note: 'OfflineConversionAdjustmentNotFound' })
      answer = () => new Response(`no such ${sha256('pat3@example.org')} and MSCLK-3`, { status: 500 })
      const refused = (await telling.forget('contact:3')).sent.find((each) => each.target === 'microsoft')!
      assert.equal(refused.state, 'rejected')
      assert.match(refused.note!, /500: no such \(left out\) and \(left out\)$/)
      assert.deepEqual([await telling.get('enroll-2'), await telling.get('enroll-3')], [[], []])

      // A decision refused because somebody decided first tells nobody. Nor does anything, unless it was asked for.
      const before = retractions().length
      await graph.separate('contact:4', 'contact:6')
      await assert.rejects(telling.forget('contact:4', { seen: 0 }))
      assert.equal((await telling.get('enroll-4')).length, 3)
      assert.deepEqual((await quiet.forget('contact:5')).sent.map((each) => [each.target, each.state]), [['keeps', 'not_requested'], ['lost', 'not_requested'], ['microsoft', 'not_requested']])
      assert.equal(retractions().length, before)
      // Asked for with one deletion, it is asked for that one.
      answer = () => new Response('{}')
      await enroll(7)
      await enroll(8)
      await quiet.run()
      assert.deepEqual([quiet.retraction, telling.retraction.always], [{ targets: ['microsoft'], always: false }, true])
      assert.equal((await quiet.forget('contact:7', {}, { retract: true })).sent.find((each) => each.target === 'microsoft')!.state, 'accepted')
      assert.equal((await quiet.forget('contact:8')).sent.find((each) => each.target === 'microsoft')!.state, 'not_requested')
      assert.equal(retractions().length, before + 1)

      // Forgotten twice in one moment, it is told once. A target's own words are kept clear of what it was given.
      const own = createOutbox(graph, next.store.outbox, { ...options, retractOnForget: true, targets: [{ ...keeps('keeps', async () => ({})), forget: async (jobs) => jobs.map((job) => `unknown ${job.keys.k}`) }] })
      const both = (await Promise.all([own.forget('contact:4'), own.forget('contact:4')])).map((each) => each.sent)
      assert.deepEqual(both.find((each) => each.length > 0)!.map((each) => [each.target, each.state, each.note]), [['keeps', 'rejected', 'unknown (left out)'], ['lost', 'not_requested', 'may not have arrived'], ['microsoft', 'not_requested', undefined]])
      assert.equal(both.filter((each) => each.length > 0).length, 1)
    })

    test('failed and skipped conversions can be listed and put back in line', async () => {
      const { graph, outbox, remote, clock } = await fresh({ patience: 0 })
      for (const n of [1, 2]) await enroll(graph, n)
      await outbox.record(outcome(1))
      await outbox.record(outcome(2))
      await outbox.record(outcome(9))
      remote.refuseWith((request) => (request.events.some((event) => event.transactionId === 'enroll-2') ? new GoogleError(400, 'conversion action not found') : undefined))
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 1, failed: 1, retried: 0 })

      const failed = await outbox.list('failed')
      assert.deepEqual(failed.map((job) => [job.transactionId, job.state]), [['enroll-2', 'failed']])
      assert.match(failed[0]!.note!, /conversion action not found/)
      assert.deepEqual((await outbox.list('skipped')).map((job) => [job.transactionId, job.note]), [['enroll-9', 'no_match_key']])
      assert.deepEqual((await outbox.list('sent', 5)).map((job) => job.transactionId), ['enroll-1'])

      // The cause is fixed, so the failed one goes round again. A sent one is left alone.
      remote.refuseWith(undefined)
      clock.now += 1000
      assert.deepEqual((await outbox.retry('enroll-2')).map((job) => [job.state, job.attempts, job.note]), [['pending', 0, 'retried']])
      assert.deepEqual(await outbox.retry('enroll-1'), [])
      assert.deepEqual(await outbox.retry('unknown'), [])
      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      assert.deepEqual(await outbox.list('failed'), [])
    })

    test('TikTok gets a web event with its click id, and a refusal inside a 200 fails the job', async () => {
      const next = await open()
      opened.push(next)
      const graph = createGraph(next.store)
      const posted: { url: string; headers: Record<string, string>; body: any }[] = []
      let answer: { status: number; body: object } = { status: 200, body: { code: 0, message: 'OK', request_id: 'req-tt' } }
      const fetcher = (async (url: any, init: any) => {
        posted.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
        return new Response(JSON.stringify(answer.body), { status: answer.status })
      }) as typeof fetch
      const clock = { now: T0 + 2 * HOUR }
      const outbox = createOutbox(graph, next.store.outbox, {
        targets: [tiktok({ pixelCode: 'PIXEL1', accessToken: 'tt-token', url: 'https://site.example/', fetch: fetcher })],
        now: () => clock.now,
        random: () => 1,
      })
      await graph.observe({ subject: 'visitor:v', identifiers: ['device:v'], at: T0 })
      await graph.touch({ subject: 'visitor:v', at: T0, ttclid: 'TT-CLICK', landing: 'https://site.example/offer' })
      await graph.observe({ subject: 'contact:1', identifiers: ['device:v'], at: T0 + HOUR })
      // The examples from TikTok's own reference: an email with spaces and capitals, a phone with brackets.
      await outbox.record({ ...outcome(1), action: 'CompleteRegistration', email: ' ALICE_abc@gmail.com ', phone: '(+1)2133734253' })

      assert.deepEqual(await outbox.run(), { sent: 1, skipped: 0, failed: 0, retried: 0 })
      assert.equal(posted[0]!.url, 'https://business-api.tiktok.com/open_api/v1.3/event/track/')
      assert.deepEqual(posted[0]!.headers, { 'Access-Token': 'tt-token', 'content-type': 'application/json' })
      assert.deepEqual(posted[0]!.body, {
        event_source: 'web',
        event_source_id: 'PIXEL1',
        data: [
          {
            event: 'CompleteRegistration',
            event_time: (T0 + HOUR) / 1000,
            event_id: 'enroll-1',
            user: {
              ttclid: 'TT-CLICK',
              email: '848a771458438fc2ec420560d769fb9b9b86851ee338ec56517baabd79d3bb4f',
              phone: '9f7ec22d72092cd3c0b58726ed9c2d91b92e51a3f29837508fb2948bb22dd2fd',
            },
            page: { url: 'https://site.example/offer' },
            properties: { value: 200, currency: 'USD' },
          },
        ],
      })
      const [sent] = await outbox.get('enroll-1')
      assert.deepEqual([sent!.state, sent!.requestId, sent!.click], ['sent', 'req-tt', { ttclid: 'TT-CLICK' }])

      // A bad token comes back as 401 and is tried again; a refusal inside a 200 is final.
      await outbox.record({ ...outcome(1), transactionId: 'second', action: 'CompleteRegistration' })
      answer = { status: 401, body: { code: 40105, message: 'Access token is incorrect or has been revoked.' } }
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 1 })
      answer = { status: 200, body: { code: 40002, message: 'Invalid event' } }
      clock.now += 60_000
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 1, retried: 0 })
      assert.match((await outbox.get('second'))[0]!.note!, /Invalid event/)
    })

    test('a held outcome is sent once released, and one taken back is retracted where the platform allows', async () => {
      const { graph, outbox, remote } = await fresh()
      await enroll(graph, 1)
      const first = outcome(1)
      const [held] = await outbox.hold(first)
      assert.equal(held!.state, 'held')
      assert.deepEqual(await outbox.run(), { sent: 0, skipped: 0, failed: 0, retried: 0 })
      assert.equal(await graph.outcomeOf('enroll-1'), undefined)
      // Released with nothing but its id and its value, it goes out with the keys that were hashed when it was held.
      const { email: _, ...bare } = first
      await outbox.release(bare)
      assert.equal((await outbox.run()).sent, 1)
      assert.deepEqual((await outbox.get('enroll-1'))[0]!.keys, held!.keys)
      assert.ok(await graph.outcomeOf('enroll-1'))
      // Releasing again, or holding what is on its way, does nothing.
      await outbox.release(bare)
      await outbox.hold(first)
      assert.equal((await outbox.run()).sent, 0)

      // Taken back after it was sent: out of the report, and restated to nothing where the platform can restate.
      await outbox.withdraw('enroll-1')
      assert.equal(await graph.outcomeOf('enroll-1'), undefined)
      assert.equal((await outbox.run()).sent, 1)
      assert.equal((remote.requests.at(-1)!.events[0] as any).conversionValue, 0)
      await outbox.withdraw('enroll-1')
      assert.equal((await outbox.run()).sent, 0)
      // Given back: counted again, and its value again.
      await outbox.release(bare)
      assert.equal((await outbox.run()).sent, 1)
      assert.equal((remote.requests.at(-1)!.events[0] as any).conversionValue, first.value)

      // Taken back before it was sent: never sent.
      await enroll(graph, 2)
      await outbox.record(outcome(2))
      await outbox.withdraw('enroll-2')
      const requests = remote.requests.length
      await outbox.run()
      assert.deepEqual([remote.requests.length, (await outbox.get('enroll-2'))[0]!.state], [requests, 'held'])
      assert.deepEqual(await outbox.counts(), { held: 1, pending: 0, sent: 1, skipped: 0, failed: 0 })
    })

    test('what was taken back is not sent by an old pass, a retry, or a later change of mind', async () => {
      let during: (() => Promise<unknown>) | undefined
      let refuse: Error | undefined
      const { graph, outbox, remote, clock, store } = await fresh({ patience: 0 })
      const values = () => remote.requests.flatMap((request) => request.events.map((event: any) => [event.transactionId, event.conversionValue]))
      // Skipped for want of a key, then taken back: putting skipped jobs in line again does not send it.
      await graph.observe({ subject: 'contact:9', identifiers: ['email:none'], at: T0 })
      await outbox.record({ transactionId: 'enroll-9', subject: 'contact:9', at: T0 + HOUR, action: '900', value: 5 })
      assert.equal((await outbox.run()).skipped, 1)
      await outbox.withdraw('enroll-9')
      assert.deepEqual([await outbox.retry('enroll-9'), (await outbox.get('enroll-9'))[0]!.state], [[], 'held'])

      // Taken back while a request that will be refused is on its way: the pass does not put it back in line.
      const slow = createOutbox(graph, store.outbox, { targets: [googleAds({ customerId: '1', send: async (request) => { await during?.(); if (refuse) throw refuse; return remote.send(request) } })], now: () => clock.now, random: () => 1 })
      await enroll(graph, 1)
      await slow.record(outcome(1))
      during = () => slow.withdraw('enroll-1')
      refuse = new GoogleError(503, 'unavailable')
      assert.equal((await slow.run()).retried, 0)
      during = refuse = undefined
      clock.now += 2 * HOUR
      await slow.run()
      assert.deepEqual([values(), (await slow.get('enroll-1'))[0]!.state], [[], 'held'])

      // Taken back after a worker claimed it and before it went out.
      await enroll(graph, 2)
      await slow.record(outcome(2))
      const early = { ...store.outbox, standing: async (jobs: Parameters<typeof store.outbox.standing>[0]) => (await slow.withdraw('enroll-2'), store.outbox.standing(jobs)) }
      await createOutbox(graph, early, { targets: [googleAds({ customerId: '1', send: remote.send })], now: () => clock.now }).run()
      assert.deepEqual(values(), [])

      // Sent, then no, yes and no again before the next pass: the last word stands on the platform.
      await enroll(graph, 3)
      await slow.record(outcome(3))
      await slow.run()
      await slow.withdraw('enroll-3')
      await slow.release(outcome(3))
      await slow.withdraw('enroll-3')
      await slow.run()
      assert.deepEqual(values(), [['enroll-3', 200], ['enroll-3', 0]])

      // A nothing on its way while the value is given back and sent by another worker: whichever arrived last, the value is sent once more.
      await slow.release(outcome(3))
      await slow.run()
      await slow.withdraw('enroll-3')
      during = async () => {
        during = undefined
        await slow.release(outcome(3))
        await outbox.run()
      }
      await slow.run()
      await slow.run()
      assert.deepEqual(values().at(-1), ['enroll-3', 200])
      assert.deepEqual(values().filter(([id]) => id === 'enroll-3').map(([, value]) => value), [200, 0, 200, 200, 0, 200])

      // The same outcome held by many reports at once is one job, whoever came first.
      await enroll(graph, 5)
      const holds = await Promise.all(Array.from({ length: 20 }, () => outbox.hold(outcome(5))))
      assert.ok(holds.every(([job]) => job!.state === 'held' && job!.transactionId === 'enroll-5'))
      assert.equal((await outbox.get('enroll-5')).length, 1)

      // Taken back and given back in the same moment, a job claimed again is not the one the first worker holds.
      await enroll(graph, 4)
      await slow.record(outcome(4))
      const [first] = await store.outbox.claim(clock.now, 60_000, 10)
      await slow.withdraw('enroll-4')
      await slow.release(outcome(4))
      const [second] = await store.outbox.claim(clock.now, 60_000, 10)
      assert.deepEqual([first!.state, first!.attempts, first!.due], [second!.state, second!.attempts, second!.due])
      assert.deepEqual(await store.outbox.standing([first!]), [])
      assert.equal(await store.outbox.swap(first!, { ...first!, state: 'failed' }), false)
    })

    test('a platform that keeps what it was sent says so, and one taken back on its way is retracted', async () => {
      let midway: (() => Promise<unknown>) | undefined
      const values: unknown[] = []
      const target = (name: string, restates: boolean) => ({
        name, restates, batch: 10, keys: () => ({ email: 'hashed' }), click: () => undefined, retryable: () => false,
        deliver: async (_action: string, items: readonly { job: { value?: number } }[]) => {
          values.push([name, items[0]!.job.value])
          await midway?.()
          return {}
        },
      })
      const { graph, outbox } = await fresh({ targets: [target('keeps', false), target('changes', true)] })
      await enroll(graph, 1)
      await outbox.record(outcome(1, { action: { keeps: 'a', changes: 'b' } }))
      assert.equal((await outbox.run()).sent, 2)
      await outbox.withdraw('enroll-1')
      assert.deepEqual((await outbox.get('enroll-1')).sort((x, y) => (x.target < y.target ? -1 : 1)).map((job) => [job.target, job.state, job.note]), [['changes', 'pending', 'withdrawn'], ['keeps', 'sent', 'withdrawn, but this platform keeps it']])
      await outbox.run()
      assert.deepEqual(values.map(String).sort(), ['changes,0', 'changes,200', 'keeps,200'])

      // The result comes while the request is on its way. What arrived is retracted by the next pass.
      values.length = 0
      await enroll(graph, 2)
      await outbox.record(outcome(2, { action: { changes: 'b' } }))
      midway = () => outbox.withdraw('enroll-2')
      await outbox.run()
      midway = undefined
      assert.equal(await graph.outcomeOf('enroll-2'), undefined)
      await outbox.run()
      assert.deepEqual(values, [['changes', 200], ['changes', 0]])
    })

    test('what was no lead is not sent, is retracted where it was, and goes out again when that is taken back', async () => {
      const { graph, outbox, remote, clock, store } = await fresh()
      const values = () => remote.requests.flatMap((request) => request.events.map((event) => [event.transactionId, event.conversionValue]))
      const options = { takeBack: outbox.takeBack, giveBack: outbox.giveBack }
      const job = async (n: number) => (await outbox.get(`enroll-${n}`))[0]!
      // Not sent yet: it waits, and the outcome is still on record.
      await enroll(graph, 1)
      await outbox.record(outcome(1))
      await recordNotLead(graph, { transactionId: 'enroll-1', kind: 'spam' }, options)
      await outbox.run()
      assert.deepEqual([values(), (await job(1)).state, (await graph.outcomeOf('enroll-1'))!.value], [[], 'held', 200])
      // Restated while it waits, it goes out at that.
      await outbox.restate('enroll-1', 260, 'EUR')
      // Said before it was queued, the pass finds it.
      await enroll(graph, 2)
      await recordNotLead(graph, { transactionId: 'enroll-2' }, options)
      await outbox.record(outcome(2))
      await outbox.run()
      assert.deepEqual([values(), (await job(2)).state], [[], 'held'])
      await outbox.run()
      // Sent already: worth nothing on a platform that can be told.
      await enroll(graph, 3)
      await outbox.record(outcome(3))
      await outbox.run()
      await recordNotLead(graph, { transactionId: 'enroll-3' }, options)
      await recordNotLead(graph, { transactionId: 'enroll-3', kind: 'spam' }, options)
      await outbox.run()
      assert.deepEqual(values(), [['enroll-3', 200], ['enroll-3', 0]])
      // Restated meanwhile, nothing is said of it. Taken back, they go out at what they are worth now.
      await outbox.restate('enroll-3', 350)
      await outbox.run()
      for (const n of [1, 2, 3]) await recordNotLead(graph, { transactionId: `enroll-${n}`, lead: true }, options)
      await outbox.run()
      assert.deepEqual(values().slice(2).sort(), [['enroll-1', 260], ['enroll-2', 200], ['enroll-3', 350]])
      assert.equal((await job(1)).currency, 'EUR')
      // Said while it was on its way, it is retracted by the next pass.
      let during: (() => Promise<unknown>) | undefined
      const slow = createOutbox(graph, store.outbox, { targets: [googleAds({ customerId: '1', send: async (request) => (await during?.(), remote.send(request)) })], now: () => clock.now, random: () => 1 })
      await enroll(graph, 4)
      await slow.record(outcome(4))
      during = async () => {
        during = undefined
        await recordNotLead(graph, { transactionId: 'enroll-4' }, { takeBack: slow.takeBack })
      }
      await slow.run()
      await slow.run()
      assert.deepEqual(values().filter(([id]) => id === 'enroll-4'), [['enroll-4', 200], ['enroll-4', 0]])
      // Marked before it is recorded, restated and given back before any pass, on a platform that keeps what it is sent.
      const kept: [string, number | undefined][] = []
      const keeps = createOutbox(graph, store.outbox, { targets: [{ name: 'keeps', restates: false, batch: 1, retryable: () => false, keys: () => ({ k: 'hashed' }), click: () => undefined, deliver: async (_action, items) => (kept.push(...items.map(({ job }) => [job.transactionId, job.value] as [string, number | undefined])), {}) }], now: () => clock.now })
      await enroll(graph, 5)
      await recordNotLead(graph, { transactionId: 'enroll-5' }, { takeBack: keeps.takeBack })
      const again = { ...outcome(5), action: { keeps: 'x' } }
      await keeps.record(again)
      await keeps.restate('enroll-5', 90)
      await recordNotLead(graph, { transactionId: 'enroll-5', lead: true }, { giveBack: keeps.giveBack })
      await keeps.run()
      assert.deepEqual(kept, [['enroll-5', 90]])
      // Only its currency restated while it waits, and it had named none.
      const { currency: __, ...unnamed } = { ...outcome(7), action: { keeps: 'x' } }
      await enroll(graph, 7)
      await keeps.record(unnamed)
      await recordNotLead(graph, { transactionId: 'enroll-7' }, { takeBack: keeps.takeBack })
      await keeps.restate('enroll-7', 200, 'EUR')
      await recordNotLead(graph, { transactionId: 'enroll-7', lead: true }, { giveBack: keeps.giveBack })
      assert.deepEqual((await keeps.get('enroll-7')).map((each) => [each.value, each.currency]), [[200, 'EUR']])
      // The same outcome recorded again is still the same one, with or without a value of its own.
      await keeps.record(again)
      const { value: _, ...bare } = { ...outcome(6), action: { keeps: 'x' } }
      await enroll(graph, 6)
      await keeps.record(bare)
      await recordNotLead(graph, { transactionId: 'enroll-6' }, { takeBack: keeps.takeBack })
      await recordNotLead(graph, { transactionId: 'enroll-6', lead: true }, { giveBack: keeps.giveBack })
      await keeps.record(bare)
      // Where there is no such outcome, nothing is given back.
      await outbox.withdraw('enroll-1')
      await recordNotLead(graph, { transactionId: 'enroll-1', lead: true }, options)
      assert.equal((await job(1)).withdrawn, true)
    })

    test('forgetting a subject deletes its unsent conversions', async () => {
      const { graph, outbox } = await fresh()
      await enroll(graph, 1)
      await outbox.record(outcome(1, { email: 'pat@example.com' }))
      await graph.forget('contact:1')
      assert.deepEqual(await outbox.get('enroll-1'), [])
    })

    test('queued observations are written in batches and a bad one fails alone', async () => {
      const { graph, store } = await fresh()
      let writes = 0
      const counting: Store = { ...store, write: (work) => (writes++, store.write(work)) }
      const batcher = createBatcher(createGraph(counting), 50)
      const results = await Promise.allSettled([
        ...Array.from({ length: 200 }, (_, i) => batcher.observe({ subject: `account:${i % 40}`, identifiers: [`email:${i % 23}`], at: T0 + i })),
        batcher.observe({ subject: 'account:bad', identifiers: ['shoe:9'], at: T0 }),
      ])
      await batcher.drain()
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
      assert.equal(results[200]!.status, 'rejected')
      assert.ok(writes < 80, `expected batched writes, saw ${writes}`)
      assert.equal(await graph.cluster('account:bad'), undefined)
      assert.equal((await graph.cluster('account:39'))!.members.length > 1, true)
      assert.deepEqual(await graph.verify(), [])
    })
  })
}
