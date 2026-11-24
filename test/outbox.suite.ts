import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { GoogleError, MetaError, createBatcher, createGraph, createOutbox, googleAds, hashEmail, meta, microsoftAds, tiktok } from '../src/index.ts'
import type { IngestRequest, OutboxOptions, Outcome, Store } from '../src/index.ts'
import type { Opened } from './suite.ts'

const T0 = 1_700_000_000_000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const HOUR = 3_600_000

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

    test('the same id with different details is refused', async () => {
      const { outbox } = await fresh()
      await outbox.record(outcome(1))
      await assert.rejects(outbox.record(outcome(1, { value: 999 })), /already recorded/)
      await assert.rejects(outbox.record({ ...outcome(2), action: '' }), TypeError)
    })

    test('an outcome with nothing for Google to match is skipped, and so is one without consent', async () => {
      const { graph, outbox, remote } = await fresh()
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
        await graph.consent(who, { adUserData: false, adPersonalization: false }, { at: outcome(n).at + 1 })
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
      assert.deepEqual(await outbox.counts(), { pending: 0, sent: 0, skipped: 0, failed: 1 })
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
      assert.deepEqual(await outbox.counts(), { pending: 0, sent: 150, skipped: 0, failed: 0 })
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

    test('failed and skipped conversions can be listed and put back in line', async () => {
      const { graph, outbox, remote, clock } = await fresh()
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
