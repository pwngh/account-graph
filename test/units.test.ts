import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { components, conversionEvent, createAlerter, createGraph, createMemoryStore, dayStart, defaultPolicy, fit, fold, googleClick, hashEmail, hashPhone, ingestRequest, ip, knownLink, ladderProblems, measure, normalizeEmail, normalizePhone, phoneOfType, policyFrom, policyHash, policyProblems, readToken, scorePairs, signToken, sourceOf, withStage } from '../src/index.ts'
import type { Edge, IdentifierState } from '../src/index.ts'
import { configFrom } from '../src/serve.ts'
import { createHandler } from '../src/server.ts'

const T0 = 1_700_000_000_000

test('emails and phones normalize the way Google documents', () => {
  assert.equal(normalizeEmail(' Cloudy.SanFrancisco+shopping@gmail.com '), 'cloudysanfrancisco@gmail.com')
  assert.equal(normalizeEmail('user.name+NYC@Example.com'), 'user.name+nyc@example.com')
  assert.equal(normalizePhone('(800) 555-0100'), '+18005550100')
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958')
  assert.throws(() => normalizePhone('555-0100'), TypeError)
  // The example hash from Google's Data Manager guide for john.smith@example.com.
  assert.equal(hashEmail('john.smith@example.com'), '8e621e3d0368631d263d07a351fa8d34fba0d17c15fbcdec11a5f58008d022a0')
})

test('an IPv6 address keeps its /64 prefix and an IPv4 address stays whole', () => {
  assert.equal(ip('2001:0db8:85a3:0000:1319:8a2e:0370:7344'), 'ip:2001:db8:85a3:0::/64')
  assert.equal(ip('2001:db8:85a3::8a2e:370:7334'), 'ip:2001:db8:85a3:0::/64')
  assert.equal(ip('::ffff:203.0.113.9'), 'ip:203.0.113.9')
  assert.equal(ip('203.0.113.9'), 'ip:203.0.113.9')
})

test('scoring ignores the order of its input', () => {
  const edge = (subject: string, identifier: string, at = T0): Edge => ({ subject, identifier, first: at, last: at, count: 1 })
  const edges = [
    edge('a', 'email:1'), edge('b', 'email:1'), edge('b', 'canvas:1'), edge('c', 'canvas:1'),
    edge('c', 'ip:1'), edge('a', 'ip:1'), edge('d', 'hardware:1'), edge('a', 'hardware:1'),
  ]
  const states = new Map<string, IdentifierState>(
    ['email:1', 'canvas:1', 'ip:1', 'hardware:1'].map((id) => [id, { fanout: 2, ignored: false }]),
  )
  const forward = scorePairs(defaultPolicy, edges, states)
  const backward = scorePairs(defaultPolicy, [...edges].reverse(), states)
  assert.deepEqual(backward, forward)
  assert.deepEqual(forward.map((pair) => `${pair.a}-${pair.b}:${pair.level}`), ['a-b:same', 'a-d:same', 'b-c:related'])
  assert.deepEqual([...components(['a', 'b', 'c', 'd'], forward)], [['a', 'a'], ['b', 'a'], ['c', 'c'], ['d', 'a']])
})

test('a conversion sends one click id and hashed match keys', () => {
  const request = ingestRequest({ customerId: '123-456-7890', conversionActionId: '99' }, [
    {
      transactionId: 'enroll-42',
      at: Date.UTC(2026, 10, 23, 15, 0, 0),
      click: { gclid: 'G1', wbraid: 'W1' },
      email: 'John.Smith@example.com',
      value: 30.03,
      consent: { adUserData: true, adPersonalization: false },
    },
  ])
  assert.deepEqual(request, {
    destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' }, productDestinationId: '99' }],
    encoding: 'HEX',
    events: [
      {
        transactionId: 'enroll-42',
        eventTimestamp: '2026-11-23T15:00:00.000Z',
        eventSource: 'WEB',
        adIdentifiers: { gclid: 'G1' },
        userData: {
          userIdentifiers: [{ emailAddress: '8e621e3d0368631d263d07a351fa8d34fba0d17c15fbcdec11a5f58008d022a0' }],
        },
        conversionValue: 30.03,
        currency: 'USD',
        consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: 'CONSENT_DENIED' },
      },
    ],
    validateOnly: true,
  })
  assert.deepEqual(conversionEvent({ transactionId: 't', at: 0, click: { wbraid: 'W1' } }).adIdentifiers, { wbraid: 'W1' })
  assert.throws(() => conversionEvent({ transactionId: 't', at: 0 }), TypeError)
})

test('measure reports how often each kind was right on its own', () => {
  const reason = (identifier: string) => ({ identifier, evidence: 0.5, fanout: 2, gap: 0 })
  const measured = measure([
    { reasons: [reason('fingerprint:1')], same: true },
    { reasons: [reason('fingerprint:2')], same: true },
    { reasons: [reason('fingerprint:3')], same: false },
    { reasons: [reason('fingerprint:4'), reason('ip:1')], same: true },
  ])
  assert.deepEqual(measured.fingerprint, { alone: { pairs: 3, same: 2 }, any: { pairs: 4, same: 3 }, precision: 2 / 3 })
  assert.equal(measured.ip!.precision, undefined)
})

test('the server takes a browser visit, links the enrollment, and guards its routes', async () => {
  const graph = createGraph(createMemoryStore())
  const handler = createHandler(graph, { token: 'secret', origins: ['https://site.example'], now: () => T0 })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const auth = { authorization: 'Bearer secret' }
  try {
    const visit = { device: 'd-1', ga: '123.456', canvas: 'c1', touch: { gclid: 'G1', source: 'google', bogus: 'x' } }
    const collected = await fetch(`${base}/collect`, {
      method: 'POST',
      headers: { origin: 'https://site.example', 'content-type': 'text/plain' },
      body: JSON.stringify(visit),
    })
    assert.equal(collected.status, 204)
    assert.equal(collected.headers.get('access-control-allow-origin'), 'https://site.example')

    const stranger = await fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })
    assert.equal(stranger.status, 403)
    assert.equal((await fetch(`${base}/links?subject=visitor:d-1`)).status, 401)

    const observed = await fetch(`${base}/observe`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ subject: 'account:1', identifiers: ['device:d-1'], at: T0 + 1000, event: 'enroll' }),
    })
    assert.equal(observed.status, 200)

    const attributed = await fetch(`${base}/attribute?subject=account:1&at=${T0 + 1000}`, { headers: auth })
    const attribution = (await attributed.json()) as any
    assert.equal(attribution.reason, 'credited')
    assert.equal(attribution.credited.gclid, 'G1')
    assert.equal(attribution.credited.bogus, undefined)
    assert.equal(googleClick(attribution, defaultPolicy.same)!.gclid, 'G1')

    const bad = await fetch(`${base}/observe`, { method: 'POST', headers: auth, body: JSON.stringify({ subject: 'a', identifiers: ['nope'], at: 1 }) })
    assert.equal(bad.status, 400)
  } finally {
    server.close()
  }
})

test('fit recovers the true weights from checked pairs', () => {
  // Make pairs where a fingerprint is right 80% of the time and an address 10%, far from the defaults.
  let seed = 9
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const truth = { fingerprint: 0.8, ip: 0.1 }
  const reason = (kind: 'fingerprint' | 'ip', n: number) => ({ identifier: `${kind}:${n}`, evidence: defaultPolicy.kinds[kind]!.weight, fanout: 2, gap: 0 })
  const labeled = Array.from({ length: 6000 }, (_, n) => {
    const kinds = (['fingerprint', 'ip'] as const).filter(() => next() < 0.6)
    const reasons = (kinds.length > 0 ? kinds : (['ip'] as const)).map((kind) => reason(kind, n))
    const same = reasons.some((each) => next() < truth[each.identifier.split(':')[0] as 'fingerprint' | 'ip'])
    return { reasons, same }
  })
  const fitted = fit(labeled, defaultPolicy)
  assert.ok(Math.abs(fitted.kinds.fingerprint!.after - 0.8) < 0.04, `fingerprint ${fitted.kinds.fingerprint!.after}`)
  assert.ok(Math.abs(fitted.kinds.ip!.after - 0.1) < 0.04, `ip ${fitted.kinds.ip!.after}`)
  assert.equal(fitted.kinds.fingerprint!.before, 0.97)
  assert.ok(fitted.loss.after < fitted.loss.before)
  assert.equal(fitted.policy.kinds.fingerprint!.weight, fitted.kinds.fingerprint!.after)
  assert.equal(fitted.policy.kinds.email!.weight, defaultPolicy.kinds.email!.weight)
  // Scores the fitted policy gives should match how often such pairs were truly one person.
  for (const bucket of fitted.calibration) assert.ok(Math.abs(bucket.predicted - bucket.actual) < 0.06, JSON.stringify(bucket))
  // With no data, nothing moves.
  assert.deepEqual(fit([], defaultPolicy).policy, defaultPolicy)
})

test('the server reads its settings from the environment and names everything wrong at once', () => {
  const config = configFrom({ DATABASE_URL: 'postgres://db', GRAPH_TOKEN: 'svc', ORIGINS: 'https://a.example/, https://b.example ', COOKIE: 'a.example', RATE_BURST: '5' })
  assert.deepEqual(config.origins, ['https://a.example', 'https://b.example'])
  assert.deepEqual([config.port, config.host, config.schema, config.outboxInterval], [8080, '0.0.0.0', 'account_graph', 30_000])
  assert.deepEqual(config.cookie, { domain: 'a.example' })
  assert.deepEqual(config.limit, { perMinute: 120, burst: 5 })
  assert.deepEqual([config.fingerprint, config.maxmind, config.google, config.meta, config.microsoft], [undefined, undefined, undefined, undefined, undefined])
  assert.equal(configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', RATE_LIMIT: 'off', COOKIE: 'true' }).limit, false)
  assert.equal(configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', COOKIE: 'true' }).cookie, true)
  assert.deepEqual(['true', 'false', '2', undefined].map((value) => configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', TRUST_PROXY: value }).trustProxy), [1, 0, 2, 0])
    const calls = configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', EVENTS: 'inquiry, brochure', CALL_NUMBERS: '{"555-123-0001":{"source":"google"}}', TWILIO_AUTH_TOKEN: 't', TWILIO_WEBHOOK_URL: 'https://g.example/calls/twilio' })
  assert.deepEqual([calls.events, calls.callNumbers, calls.callMinimum, calls.twilio], [['inquiry', 'brochure'], { '555-123-0001': { source: 'google' } }, 30, { authToken: 't', url: 'https://g.example/calls/twilio' }])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', CALL_NUMBERS: '{"12":{}}', TWILIO_AUTH_TOKEN: 't', REPORT_TIME_ZONE: 'Mars/Olympus' }), (error: Error) =>
    ['"12" is not a phone number', '"12" needs a source', 'TWILIO_WEBHOOK_URL or TWILIO_ACCOUNT_SID must be set along with TWILIO_AUTH_TOKEN', 'REPORT_TIME_ZONE must be a time zone'].every((line) => error.message.includes(line)))
  assert.throws(() => configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', CALL_NUMBERS: '[1]' }), /CALL_NUMBERS must be a JSON object/)

  const full = configFrom({
    DATABASE_URL: 'x', GRAPH_TOKEN: 'y', REVIEW_TOKEN: 'z', FINGERPRINT_SECRET: 'f', FINGERPRINT_REGION: 'eu',
    MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'k', GOOGLE_ADS_CUSTOMER_ID: '123', GOOGLE_SERVICE_ACCOUNT_FILE: '/key.json',
    META_PIXEL_ID: 'p', META_ACCESS_TOKEN: 't', META_SITE_URL: 'https://a.example/',
  })
  assert.deepEqual(full.fingerprint, { secretKey: 'f', region: 'eu' })
  assert.equal(full.maxmind!.service, 'insights')
  assert.equal(full.google!.keyFile, '/key.json')
  assert.equal(full.meta!.pixelId, 'p')

  assert.throws(
    () => configFrom({ GRAPH_TOKEN: 'same', REVIEW_TOKEN: 'same', PORT: 'eighty', MAXMIND_ACCOUNT_ID: '1', META_PIXEL_ID: 'p', FINGERPRINT_SECRET: 'f', FINGERPRINT_REGION: 'mars' }),
    (error: Error) =>
      ['DATABASE_URL is required', 'PORT must be a number', 'MAXMIND_LICENSE_KEY must be set along with MAXMIND_ACCOUNT_ID', 'META_ACCESS_TOKEN, META_SITE_URL must be set along with META_PIXEL_ID', 'FINGERPRINT_REGION must be us, eu, or ap', 'REVIEW_TOKEN must differ from GRAPH_TOKEN'].every((line) => error.message.includes(line)),
  )
})

test('a policy setting is laid over the default kind by kind, and everything wrong with it is named', () => {
  const given = { related: 0.4, kinds: { phone: { weight: 0.85, halfLife: 63_072_000_000 }, ip: { halfLife: 'none' }, badge: { weight: 0.8, dilution: 1, cap: 4, halfLife: 'none' } } }
  assert.deepEqual(policyProblems(given), [])
  const policy = policyFrom(given)
  assert.deepEqual(policy.kinds.phone, { ...defaultPolicy.kinds.phone, weight: 0.85, halfLife: 63_072_000_000 })
  assert.equal(policy.kinds.ip!.halfLife, Infinity)
  assert.deepEqual(policy.kinds.badge, { weight: 0.8, dilution: 1, cap: 4, halfLife: Infinity })
  assert.deepEqual([policy.same, policy.related, policy.kinds.email], [defaultPolicy.same, 0.4, defaultPolicy.kinds.email])

  // A kind may share its name with something every object has, and nothing but a rule of its own counts as one.
  const odd = policyFrom(JSON.parse('{"kinds":{"__proto__":{"weight":0.8,"dilution":0,"cap":4,"halfLife":"none"}}}'))
  assert.equal(Object.hasOwn(odd.kinds, '__proto__'), true)
  assert.notEqual(policyHash(odd), policyHash(defaultPolicy))

  // The hash names what scores and clusters, whatever order it was written in. The review size only flags, so it is not part of it.
  const backwards = { kinds: Object.fromEntries(Object.entries(given.kinds).reverse()), related: 0.4 }
  assert.equal(policyHash(policyFrom(backwards)), policyHash(policy))
  assert.equal(policyHash(policyFrom({})), policyHash(defaultPolicy))
  assert.equal(policyHash(policyFrom({ review: 9 })), policyHash(defaultPolicy))
  assert.notEqual(policyHash(policy), policyHash(defaultPolicy))
  assert.notEqual(policyHash(policyFrom({ kinds: { ip: { halfLife: 'none' } } })), policyHash(defaultPolicy))

  assert.deepEqual(policyProblems([]), ['must be an object, such as {"kinds":{"phone":{"weight":0.85}}}'])
  assert.deepEqual(policyProblems({ smae: 1, same: 2, review: 0, kinds: { phone: { weight: '0.9' }, 'Bad:kind': 5, badge: { weight: 1 }, ip: { cap: 1.5, dilution: -1, halfLife: 0, colour: 1 }, dialed: { weight: 0.1 } } }), [
    '"smae" is not a setting',
    '"same" must be a number from 0 to 1',
    '"review" must be a whole number above 0',
    'kind "phone" needs a weight from 0 to 1',
    'kind "Bad:kind" must be a name without a colon',
    'kind "Bad:kind" must be an object, such as {"weight":0.85}',
    'kind "badge" is new, so it needs its dilution',
    'kind "badge" is new, so it needs its cap',
    'kind "badge" is new, so it needs its halfLife',
    'kind "ip" has "colour", which is not part of a rule',
    'kind "ip" needs a dilution of zero or more',
    'kind "ip" needs a cap of zero or more, in whole subjects',
    'kind "ip" needs a halfLife in milliseconds, or "none"',
    'kind "dialed" is a note and links nothing, so its weight must stay 0',
  ])
  assert.deepEqual(policyProblems({ same: 0.4 }), ['"related" must not be above "same"'])
  assert.equal(policyProblems({ kinds: { review: { weight: 0.95 } } }).length, 1)

  const env = { DATABASE_URL: 'x', GRAPH_TOKEN: 'y' }
  assert.equal(configFrom(env).policy, undefined)
  assert.equal(configFrom({ ...env, POLICY: '{"same":0.95}' }).policy!.same, 0.95)
  assert.throws(() => configFrom({ ...env, POLICY: '{"same":9}' }), /POLICY: "same" must be a number from 0 to 1/)
  assert.throws(() => configFrom({ ...env, POLICY: 'nope' }), /POLICY must be JSON/)
  assert.throws(() => configFrom({ ...env, POLICY: '{}', POLICY_FILE: '/x' }), /must not both be set/)
  assert.throws(() => configFrom({ ...env, POLICY_FILE: '/no/such/file' }), /POLICY_FILE: "\/no\/such\/file" cannot be read/)
})

test('a day begins at local midnight, across a clock change', () => {
  assert.equal(dayStart('2026-03-01'), Date.parse('2026-03-01T00:00:00Z'))
  assert.equal(dayStart('2026-03-01', 'America/New_York'), Date.parse('2026-03-01T05:00:00Z'))
  // Clocks in New York go forward on 8 March 2026 and back on 1 November.
  assert.equal(dayStart('2026-03-08', 'America/New_York'), Date.parse('2026-03-08T05:00:00Z'))
  assert.equal(dayStart('2026-03-09', 'America/New_York'), Date.parse('2026-03-09T04:00:00Z'))
  assert.equal(dayStart('2026-11-01', 'America/New_York'), Date.parse('2026-11-01T04:00:00Z'))
  assert.equal(dayStart('2026-11-02', 'America/New_York'), Date.parse('2026-11-02T05:00:00Z'))
  assert.equal(dayStart('2026-03-01', 'Asia/Kolkata'), Date.parse('2026-02-28T18:30:00Z'))
  // In Havana the clocks go forward at midnight, so 8 March 2026 begins at one o'clock.
  assert.equal(dayStart('2026-03-08', 'America/Havana'), Date.parse('2026-03-08T05:00:00Z'))
  assert.equal(dayStart('2026-03-09', 'America/Havana'), Date.parse('2026-03-09T04:00:00Z'))
  assert.equal(dayStart('2026-09-06', 'America/Santiago'), Date.parse('2026-09-06T04:00:00Z'))
  assert.throws(() => dayStart('2026-3-1'), TypeError)
  assert.throws(() => dayStart('2026-13-01'), TypeError)
  assert.throws(() => dayStart('2026-02-30'), TypeError)
})

test('the report is the same whatever order its rows arrive in', () => {
  const cost = (day: string, source: string, campaignId: string, campaign: string, amount: number) => ({ day, source, campaignId, campaign, amount, currency: 'USD', clicks: 0, impressions: 0 })
  const touch = (at: number, more: object) => ({ subject: `visitor:${at}`, at, ...more })
  const costs = [
    cost('2026-03-01', 'google', '111', 'Old name', 10),
    cost('2026-03-02', 'google', '111', 'New name', 10),
    // Two Meta campaigns share a name; the name stands for the one that cost more.
    cost('2026-03-01', 'meta', '700', 'Retarget', 5),
    cost('2026-03-01', 'meta', '701', 'Retarget', 50),
    // A spreadsheet row that knows the campaign only by name.
    cost('2026-03-01', 'microsoft', '', 'Spring', 30),
  ]
  const touches = [
    touch(1, { gclid: 'a', campaignId: '111' }),
    touch(2, { fbclid: 'b', campaign: 'retarget' }),
    // The touch has an id no cost knows, and a name one does.
    touch(3, { msclkid: 'c', campaignId: '42', campaign: 'spring' }),
    // The id rides in utm_campaign on one arrival and in utm_id on the next; neither has a cost.
    touch(4, { ttclid: 'd', campaign: '9001' }),
    touch(5, { ttclid: 'e', campaignId: '9001', campaign: 'Beta' }),
    touch(6, { ttclid: 'f', campaignId: '9001', campaign: 'Alpha' }),
    // An id no cost knows, under a name a costed campaign with another id has: a different campaign.
    touch(9, { fbclid: 'g', campaignId: '799', campaign: 'Retarget' }),
    // A campaign nobody paid for, spelled two ways.
    touch(10, { source: 'newsletter', campaign: 'march' }),
    touch(11, { source: 'newsletter', campaign: 'March' }),
    // Sources and steps named after things every object has.
    touch(7, { source: 'constructor', campaign: 'toString' }),
    touch(8, { source: '__proto__' }),
  ]
  const outcome = (n: number, stage: string, value: number) => ({ transactionId: `t${n}`, subject: 's', at: n, stage, value, currency: 'USD' })
  const credited = [
    { outcome: outcome(1, 'enrolled', 200), touch: touches[2] },
    { outcome: outcome(2, '__proto__', 1), touch: touches[9] },
    { outcome: outcome(3, 'constructor', 2), touch: undefined },
  ]
  const expected = fold('2026-03-01', '2026-03-02', costs, touches, credited)
  assert.deepEqual(expected.rows.map((row) => [row.source, row.campaignId, row.campaign, row.cost, row.visits, Object.keys(row.stages)]), [
    ['meta', '701', 'Retarget', 50, 1, []],
    ['microsoft', '', 'Spring', 30, 1, ['enrolled']],
    ['google', '111', 'New name', 20, 1, []],
    ['meta', '700', 'Retarget', 5, 0, []],
    ['(none)', '', '', 0, 0, ['constructor']],
    ['constructor', '', 'toString', 0, 1, ['__proto__']],
    ['tiktok', '9001', 'Alpha', 0, 3, []],
    ['newsletter', '', 'March', 0, 2, []],
    ['__proto__', '', '', 0, 1, []],
    ['meta', '799', 'Retarget', 0, 1, []],
  ])
  assert.deepEqual(Object.entries(expected.total.stages).sort(), [['__proto__', { count: 1, value: 1 }], ['constructor', { count: 1, value: 2 }], ['enrolled', { count: 1, value: 200 }]])
  assert.equal(({} as any).count, undefined)
  // Every rotation and the reverse of each list gives the same report.
  const turn = <T>(list: T[], by: number) => [...list.slice(by), ...list.slice(0, by)]
  for (let by = 0; by < touches.length; by++) {
    assert.deepEqual(fold('2026-03-01', '2026-03-02', turn(costs, by % costs.length), turn(touches, by), turn(credited, by % credited.length)), expected)
    assert.deepEqual(fold('2026-03-01', '2026-03-02', turn(costs, by % costs.length).reverse(), turn(touches, by).reverse(), credited), expected)
  }
})

test('a touch is filed under the platform of its click id, then its tag, then the site that referred it', () => {
  const touch = { subject: 's', at: 0 }
  assert.equal(sourceOf({ ...touch, gbraid: 'x', source: 'newsletter' }), 'google')
  assert.equal(sourceOf({ ...touch, msclkid: 'x' }), 'microsoft')
  assert.equal(sourceOf({ ...touch, source: ' Instagram ' }), 'meta')
  assert.equal(sourceOf({ ...touch, source: 'Newsletter' }), 'newsletter')
  assert.equal(sourceOf({ ...touch, referrer: 'https://www.news.example/story?id=1' }), 'news.example')
  assert.equal(sourceOf({ ...touch, custom: { placement: 'top' } }), '(other)')
})

test('the server counts outcomes without an ad platform, takes costs, and reports to a reviewer', async () => {
  const graph = createGraph(createMemoryStore())
  const at = Date.parse('2026-03-02T12:00:00Z')
  const handler = createHandler(graph, { token: 'secret', reviewToken: 'reviewer', origins: ['https://site.example'], now: () => at, timeZone: 'UTC' })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, token = 'secret') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  try {
    const visit = { device: 'd-9', touch: { gclid: 'G9', campaignId: '111', adGroupId: '22', adId: '3', term: 'garden hose', content: 'blue', custom: { placement: 'top', 'bad name': 'x', long: 'y'.repeat(300) } } }
    assert.equal((await fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example' }, body: JSON.stringify(visit) })).status, 204)
    await post('/observe', { subject: 'account:9', identifiers: ['device:d-9'], at: at + 1000 })

    assert.deepEqual(await (await post('/costs', [{ day: '2026-03-02', source: 'google', campaignId: '111', campaign: 'Spring', amount: 50, clicks: 10 }])).json(), { recorded: 1 })
    assert.equal((await post('/costs', { costs: [{ day: 'bad', source: 'google', amount: 1 }] })).status, 400)
    assert.equal((await post('/costs', { nothing: true })).status, 400)
    assert.equal((await post('/costs', [], 'reviewer')).status, 403)

    // No ad platform is set up, so the outcome is counted and sent nowhere.
    assert.deepEqual(await (await post('/convert', { transactionId: 'enr-9', subject: 'account:9', at: at + 2000, stage: 'enrolled', value: 200 })).json(), [])
    assert.equal((await post('/convert', { subject: 'account:9', at })).status, 400)
    assert.deepEqual(await (await post('/restate', { transactionId: 'enr-9', value: 120 })).json(), [])

    const report = (await (await fetch(`${base}/report?from=2026-03-01&to=2026-03-02`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    assert.deepEqual(report.rows, [
      { source: 'google', campaignId: '111', campaign: 'Spring', cost: 50, clicks: 10, impressions: 0, visits: 1, stages: { enrolled: { count: 1, value: 120 } }, outcomes: 1, value: 120 },
    ])
    // With no days named, the report covers the thirty days up to today.
    const recent = (await (await fetch(`${base}/report`, { headers: { authorization: 'Bearer secret' } })).json()) as any
    assert.deepEqual([recent.from, recent.to, recent.total.cost], ['2026-02-01', '2026-03-02', 50])
    assert.equal((await fetch(`${base}/report?from=nope`, { headers: { authorization: 'Bearer secret' } })).status, 400)
    assert.equal((await fetch(`${base}/report`)).status, 401)

    const credited = (await graph.attribute('account:9', { at: at + 2000 })).credited!
    assert.deepEqual([credited.campaignId, credited.adGroupId, credited.adId, credited.term, credited.content], ['111', '22', '3', 'garden hose', 'blue'])
    assert.deepEqual(credited.custom, { placement: 'top' })
  } finally {
    server.close()
  }
})

test('a signed token reads back until it expires, and not after any change', () => {
  const now = 1_800_000_000_000
  const token = signToken('a-long-secret-value', 'known', 'contact:42', now + 60_000)
  assert.match(token, /^[\w-]+\.[0-9a-z]+\.[\w-]{22}$/)
  assert.equal(readToken('a-long-secret-value', 'known', token, now), 'contact:42')
  assert.equal(readToken('a-long-secret-value', 'known', token, now + 60_000), undefined)
  // Made for one use, it is not accepted for another; nor with another secret, another payload, or a later expiry.
  assert.equal(readToken('a-long-secret-value', 'carry', token, now), undefined)
  assert.equal(readToken('another-secret-value', 'known', token, now), undefined)
  const [body, until, signed] = token.split('.')
  assert.equal(readToken('a-long-secret-value', 'known', `${Buffer.from('contact:43').toString('base64url')}.${until}.${signed}`, now), undefined)
  assert.equal(readToken('a-long-secret-value', 'known', `${body}.${(Number.parseInt(until!, 36) + 9999).toString(36)}.${signed}`, now), undefined)
  for (const bad of [undefined, 42, '', 'a.b', 'a.b.c.d', `${body}.${until}.`, 'x'.repeat(2000)]) assert.equal(readToken('a-long-secret-value', 'known', bad, now), undefined)
  // One token has one spelling: the same bytes written another way do not read.
  for (const respelled of [`${body}=.${until}.${signed}`, `${body}.+${until}.${signed}`, `${body}. ${until}.${signed}`, `${body}.${until!.toUpperCase()}.${signed}`, `${body}.${until}!x.${signed}`]) {
    assert.equal(readToken('a-long-secret-value', 'known', respelled, now), undefined, respelled)
  }
  assert.throws(() => signToken('', 'known', 'x', now), TypeError)

  const link = knownLink('https://site.example/offer?utm_source=mailer#top', 'contact:42', { secret: 'a-long-secret-value', now: () => now })
  const address = new URL(link)
  assert.equal(address.origin + address.pathname + address.hash, 'https://site.example/offer#top')
  assert.equal(address.searchParams.get('utm_source'), 'mailer')
  // Thirty days unless told otherwise.
  assert.equal(readToken('a-long-secret-value', 'known', address.searchParams.get('ag'), now + 29 * 86_400_000), 'contact:42')
  assert.equal(readToken('a-long-secret-value', 'known', address.searchParams.get('ag'), now + 31 * 86_400_000), undefined)
  assert.throws(() => knownLink('not an address', 'contact:42', { secret: 's' }), TypeError)
  assert.throws(() => knownLink('https://site.example/', '', { secret: 's' }), TypeError)
  assert.throws(() => knownLink('javascript:alert(1)', 'contact:42', { secret: 's' }), TypeError)
  assert.throws(() => knownLink('https://site.example/', '中'.repeat(256), { secret: 's' }), TypeError)
  assert.throws(() => knownLink('https://site.example/', 'contact:42', { secret: 's', lasts: 1e300 }), TypeError)
  assert.throws(() => knownLink('https://site.example/', 'contact:42', { secret: 's', lasts: 0 }), TypeError)
  // The longest subject allowed still makes a token that reads back.
  const long = 'c'.repeat(512)
  assert.equal(readToken('s', 'known', new URL(knownLink('https://site.example/', long, { secret: 's', now: () => now })).searchParams.get('ag'), now), long)
})

test('a step fills in what an outcome leaves out, and nothing it states', () => {
  const ladder = { inquiry: { value: 5, currency: 'USD', action: { google: '111' } }, client: { value: 200 }, constructor: { value: 1 } }
  const base = { transactionId: 't', subject: 's', at: 1 }
  assert.deepEqual(withStage(ladder, { ...base, stage: 'inquiry' }), { ...base, stage: 'inquiry', value: 5, currency: 'USD', action: { google: '111' } })
  assert.deepEqual(withStage(ladder, { ...base, stage: 'client', value: 1250, currency: 'EUR' }), { ...base, stage: 'client', value: 1250, currency: 'EUR' })
  assert.deepEqual(withStage(ladder, { ...base, stage: 'inquiry', value: 0, action: 'other' }), { ...base, stage: 'inquiry', value: 0, currency: 'USD', action: 'other' })
  // A step nobody listed, no step, and no ladder each leave the outcome as it came.
  for (const outcome of [{ ...base, stage: 'unknown' }, base, { ...base, stage: 'toString' }]) assert.deepEqual(withStage(ladder, outcome), outcome)
  assert.deepEqual(withStage(undefined, { ...base, stage: 'inquiry' }), { ...base, stage: 'inquiry' })

  assert.deepEqual(ladderProblems(ladder, ['google', 'meta']), [])
  assert.deepEqual(ladderProblems({ a: { value: -1 }, b: 5, c: { action: 'x' }, d: { action: { tiktok: 'y' } }, e: { action: { google: '' } }, f: { currency: 7 } }, ['google', 'meta']), [
    'step "a" needs a value of zero or more',
    'step "b" must be an object, such as {"value":5}',
    'step "c" must name its action per platform, such as {"google":"…"}',
    'step "d" names "tiktok", which is not set up',
    'step "e" needs its action as text, or as one text per platform',
    'step "f" needs its currency as text',
  ])
  // With one platform a plain action is enough. With none, an action has nowhere to go, and saying so beats sending nothing quietly.
  assert.deepEqual(ladderProblems({ c: { action: 'x' } }, ['google']), [])
  assert.deepEqual(ladderProblems({ d: { action: { gogle: 'y' } }, e: { action: 'x' }, f: { value: 5 } }, []), [
    'step "d" has an action, but no ad platform is set up to send it to',
    'step "e" has an action, but no ad platform is set up to send it to',
  ])
  assert.deepEqual(ladderProblems({ g: { action: 5 }, h: { action: ['x'] }, i: { action: '' } }, ['google']).length, 3)
  assert.deepEqual(ladderProblems([1], []), ['must be an object of steps, such as {"inquiry":{"value":5}}'])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', STAGES: '{"inquiry":{"value":"5"}}' }), /STAGES: step "inquiry" needs a value of zero or more/)
  assert.deepEqual(configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', STAGES: '{"inquiry":{"value":5}}', ALERT_WEBHOOK: 'https://hooks.example/x' }).stages, { inquiry: { value: 5 } })
})

test('an alert is posted once per subject per quiet period, and a broken webhook breaks nothing', async () => {
  let clock = 1_000_000
  const posted: { url: string; body: any }[] = []
  const errors: unknown[] = []
  let status = 200
  const alert = createAlerter({
    url: 'https://hooks.example/abc',
    now: () => clock,
    onError: (error) => errors.push(error),
    fetch: (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) })
      if (status === 0) throw new Error('network down')
      return new Response('ok', { status })
    }) as typeof fetch,
  })
  assert.equal(await alert('conversions', 'two conversions failed'), true)
  assert.equal(await alert('conversions', 'three more failed'), false)
  assert.equal(await alert('outbox', 'the outbox could not run'), true)
  clock += 10 * 60_000
  assert.equal(await alert('conversions', 'x'.repeat(5000)), true)
  assert.deepEqual(posted.map((each) => [each.url, each.body.text.length]), [['https://hooks.example/abc', 22], ['https://hooks.example/abc', 24], ['https://hooks.example/abc', 3000]])

  clock += 10 * 60_000
  status = 500
  assert.equal(await alert('conversions', 'again'), false)
  status = 0
  assert.equal(await alert('outbox', 'again'), false)
  assert.deepEqual(errors.map((error) => (error as Error).message), ['The alert webhook answered 500', 'network down'])
  // An alert nobody heard does not hold back the next one of its kind.
  status = 200
  assert.equal(await alert('conversions', 'heard this time'), true)
  assert.equal(await alert('conversions', 'and now held back'), false)
})

test('a phone number counts by the kind of line it is', () => {
  const hash = hashPhone('+15558675309')
  assert.equal(phoneOfType('(555) 867-5309'), `phone:${hash}`)
  for (const type of ['mobile', 'landline', 'fixedVoip', 'personal', 'unknown']) assert.equal(phoneOfType('+15558675309', type), `phone:${hash}`)
  // A number from an app anyone can sign up to is recorded as the weaker kind; a line that is nobody's is not recorded.
  assert.equal(phoneOfType('+15558675309', 'nonFixedVoip'), `voip:${hash}`)
  for (const type of ['tollFree', 'premium', 'sharedCost', 'uan', 'voicemail', 'pager']) assert.equal(phoneOfType('+15558675309', type), undefined)
  assert.equal(defaultPolicy.kinds.voip!.weight < defaultPolicy.related + 0.01 && defaultPolicy.kinds.address!.weight < defaultPolicy.same, true)

  // Twilio serves call reports with a webhook address and line lookups with an account id; one token does for both.
  const both = configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', TWILIO_AUTH_TOKEN: 't', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_WEBHOOK_URL: 'https://g.example/calls/twilio', SMARTY_AUTH_ID: 'id', SMARTY_AUTH_TOKEN: 'tok' })
  assert.deepEqual([both.twilio, both.lineType, both.smarty], [{ authToken: 't', url: 'https://g.example/calls/twilio' }, { accountSid: 'AC1', authToken: 't' }, { authId: 'id', authToken: 'tok' }])
  const lookupOnly = configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', TWILIO_AUTH_TOKEN: 't', TWILIO_ACCOUNT_SID: 'AC1' })
  assert.deepEqual([lookupOnly.twilio, lookupOnly.lineType], [undefined, { accountSid: 'AC1', authToken: 't' }])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', GRAPH_TOKEN: 'y', TWILIO_ACCOUNT_SID: 'AC1', SMARTY_AUTH_ID: 'id' }), (error: Error) =>
    ['TWILIO_AUTH_TOKEN must be set along with TWILIO_ACCOUNT_SID', 'SMARTY_AUTH_TOKEN must be set along with SMARTY_AUTH_ID'].every((line) => error.message.includes(line)))
})
