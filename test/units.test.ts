import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { birthKeys, components, conversionEvent, createAlerter, createGraph, createHours, createMemoryStore, dayStart, defaultPolicy, fit, fold, googleClick, hashEmail, hashPhone, hoursProblems, ingestRequest, ip, knownLink, ladderProblems, measure, meta, metaEvent, nameKeys, normalizeEmail, normalizePhone, phoneOfType, codeIn, policyFrom, policyHash, policyProblems, readToken, scorePairs, signToken, sourceOf, textCode, withStage } from '../tools/internals.ts'
import { summarizeCalls } from '../src/core/callreport.ts'
import { followed } from '../src/core/followed.ts'
import type { Caller, Followed } from '../src/core/followed.ts'
import { dayIn, paid } from '../src/core/report.ts'
import { weigh } from '../src/core/policy.ts'
import type { Edge, IdentifierState, KeptCall, Reason } from '../tools/internals.ts'
import { signWebhook } from '../src/contract/webhook.ts'
import { readEnvironment as configFrom } from '../src/bin.ts'
import { createHandler } from './harness.ts'
import { counts } from './suite.ts'

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

test('with no groups a score is what it always was, and with groups only the strongest of each counts', () => {
  let seed = 42
  const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff)
  // One kind of the default only confirms, and is weighed by its own test.
  const kinds = Object.keys(defaultPolicy.kinds).filter((kind) => !defaultPolicy.kinds[kind]!.corroborates)
  const grouped = { ...defaultPolicy, kinds: Object.fromEntries(Object.entries(defaultPolicy.kinds).map(([kind, rule], i) => [kind, { ...rule, ...(i % 3 > 0 && { group: `g${i % 3}` }) }])) }
  for (let round = 0; round < 500; round++) {
    const reasons = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i): Reason => ({ identifier: `${kinds[Math.floor(next() * kinds.length)]}:${i}`, evidence: next(), fanout: 2, gap: 0 }))
    const plain = reasons.map((reason) => ({ ...reason }))
    // The order they arrive in does not matter, so shuffle.
    assert.equal(weigh(defaultPolicy, plain.reverse()), 1 - [...reasons].sort((x, y) => y.evidence - x.evidence).reduce((rest, reason) => rest * (1 - reason.evidence), 1))
    assert.ok(plain.every((reason) => !('group' in reason) && !('counted' in reason)))

    const inGroups = reasons.map((reason) => ({ ...reason }))
    const best = new Map<string, number>()
    for (const { identifier, evidence } of reasons) {
      const group = grouped.kinds[identifier.split(':')[0]!]!.group ?? identifier
      best.set(group, Math.max(best.get(group) ?? 0, evidence))
    }
    assert.ok(Math.abs(weigh(grouped, inGroups) - (1 - [...best.values()].reduce((rest, evidence) => rest * (1 - evidence), 1))) < 1e-12)
    assert.equal(inGroups.filter((reason) => reason.counted !== false).length, best.size)
  }
})

test('names fold to one key, and placeholders to none', () => {
  const secret = 'a-secret-of-thirty-two-characters!'
  const key = (first: string, last: string, known: object = { zip5: '62701' }) => nameKeys(secret, first, last, known)
  for (const [x, y] of [
    [['José', 'Núñez'], ['JOSE', 'Nunez']],
    [['Jose\u0301', 'Nu\u0301n\u0303ez'], ['josé', 'núñez']],
    [['Søren', 'Łukasz'], ['soren', 'lukasz']],
    [['Weiß', 'Æsop'], ['WEISS', 'aesop']],
    [['İpek', 'Yıldız'], ['ipek', 'yildiz']],
    [['Anne-Marie', "O'Brien"], [' anne  marie ', 'OBrien']],
    [['J. R.', 'Smith, Jr.'], ['j r', 'smith jr']],
    [['Ａｎａ', 'Lima'], ['ana', 'lima']],
  ] as const) assert.deepEqual(key(x[0], x[1]), key(y[0], y[1]), `${x} ${y}`)
  // A letter that is a word of its own is a name, and another name is another key.
  assert.equal(key('李', '王').length, 1)
  assert.notDeepEqual(key('李', '王'), key('王', '李'))
  assert.notDeepEqual(key('Ana', 'Lima'), key('Ana', 'Lime'))
  // Which of the two fields a word is in matters, and so does where the two meet.
  assert.notDeepEqual(key('Ana Maria', 'Lima'), key('Ana', 'Maria Lima'))
  for (const [first, last] of [['Unknown', 'Lima'], ['Ana', 'UNKNOWN'], ['No', ''], ['', ''], ['Test', 'Test'], ['John', 'Doe'], ['n/a', 'N/A'], ['J', 'Lima'], ['123', '456'], ['Wireless', 'Caller'], ['No', 'Name'], ['Not', 'Given']] as const) assert.deepEqual(key(first, last), [], `${first} ${last}`)
  // A name alone is nobody's. A zip code or a date of birth each make a key, and neither makes the other's.
  assert.deepEqual(key('Ana', 'Lima', {}), [])
  const [byZip, byBirth] = key('Ana', 'Lima', { zip5: '62701-1234', dob: '1990-02-03' })
  assert.deepEqual([[byZip], [byBirth]], [key('Ana', 'Lima'), key('Ana', 'Lima', { dob: '1990-02-03' })])
  assert.match(byZip!, /^name:[0-9a-f]{64}$/)
  for (const known of [{ zip5: '6270' }, { zip5: '00000' }, { zip5: 'abcde' }, { dob: '1990-02-30' }, { dob: '02/03/1990' }, { dob: '1900-01-01' }, { dob: '1970-01-01' }]) assert.deepEqual(key('Ana', 'Lima', known), [], JSON.stringify(known))
  // Another secret makes other keys, and a short one is refused.
  assert.notDeepEqual(nameKeys('another-secret-of-thirty-two-chars!', 'Ana', 'Lima', { zip5: '62701' }), key('Ana', 'Lima'))
  assert.throws(() => nameKeys('short', 'Ana', 'Lima', { zip5: '62701' }), TypeError)
  assert.throws(() => nameKeys(secret, 'Ana', 5 as never, {}), TypeError)
})

test('a kind that only confirms is a sound rule, names its policy, and fit gives it no more than it confirms', () => {
  const name = { weight: 0.6, dilution: 1, cap: 5, halfLife: 'none', corroborates: true }
  assert.deepEqual(policyProblems({ kinds: { name } }), [])
  assert.deepEqual(policyProblems({ kinds: { name: { ...name, corroborates: false } } }), ['kind "name" requires its corroborates as true, or left out'])
  assert.deepEqual(policyProblems({ kinds: { review: { corroborates: true } } }), ['kind "review" is a reviewer\'s join, so it cannot only corroborate'])
  const policy = policyFrom({ kinds: { name } })
  assert.notEqual(policyHash(policy), policyHash(policyFrom({ kinds: { name: { ...name, corroborates: undefined } } })))
  const reason = (kind: string, evidence: number): Reason => ({ identifier: `${kind}:x`, evidence, fanout: 2, gap: 0 })
  // Weighed beside an address it counts, and beside an IP, or alone, it does not, however strong it is.
  assert.ok(Math.abs(weigh(policy, [reason('name', 0.6), reason('address', 0.6)]) - 0.84) < 1e-9)
  assert.ok(Math.abs(weigh(policy, [reason('name', 0.99), reason('ip', 0.3)]) - 0.3) < 1e-9)
  assert.equal(weigh(policy, [reason('name', 0.99)]), 0)
  // In a group with the rest, the strongest that may count does, whichever it is.
  const oneGroup = policyFrom({ kinds: { name: { ...name, group: 'g' }, address: { group: 'g' } } })
  const both = [reason('address', 0.55), reason('name', 0.9)]
  assert.deepEqual([Math.round(weigh(oneGroup, both) * 100), both.map((each) => each.counted)], [90, [undefined, false]])
  const weak = [reason('address', 0.45), reason('name', 0.9)]
  assert.deepEqual([Math.round(weigh(oneGroup, weak) * 100), weak.map((each) => [each.identifier, each.counted])], [45, [['name:x', false], ['address:x', undefined]]])
  assert.equal(weigh({ ...policy, related: 0 }, [reason('name', 0.99)]), 0)
  // Pairs a name alone would relate teach nothing, so their labels move nothing.
  const labeled = [...Array.from({ length: 50 }, (_, i) => ({ same: i < 40, reasons: [reason('phone', 0.9), reason('name', 0.6)] })), ...Array.from({ length: 50 }, (_, i) => ({ same: i < 25, reasons: [reason('phone', 0.9)] }))]
  const without = fit(labeled, policy)
  const lone = fit([...labeled, ...Array.from({ length: 200 }, () => ({ same: false, reasons: [reason('name', 0.6)] }))], policy)
  assert.deepEqual(lone.kinds, without.kinds)
  assert.ok(without.kinds.name!.after > 0 && without.loss.after <= without.loss.before)
  // Rounded up, a weight just under `related` would let the name count. Where that is worse, the weights are given back as they were.
  const edge = policyFrom({ kinds: { name, address: { weight: 0.4999 } } })
  const kept = fit(Array.from({ length: 40 }, (_, i) => ({ same: i < 20, reasons: [reason('address', 0.4999), reason('name', 0.6)] })), edge, 1e9)
  assert.deepEqual([kept.kinds.address!.after, kept.policy.kinds.address!.weight, kept.loss.after], [0.4999, 0.4999, kept.loss.before])
})

test('the household preset is a sound policy, and fit counts a group once', () => {
  const given = JSON.parse(readFileSync(new URL('../examples/household.json', import.meta.url), 'utf8'))
  assert.deepEqual(policyProblems(given), [])
  // The page that explains it shows the same thing.
  const shown = /```json\n([\s\S]*?)```/.exec(readFileSync(new URL('../docs/matching.md', import.meta.url), 'utf8'))![1]!
  assert.deepEqual(JSON.parse(shown), given)
  assert.deepEqual(policyProblems({ kinds: { phone: { group: '' } } }), ['kind "phone" requires its group as a string'])

  const policy = policyFrom(given)
  // Pairs that share only a phone are strangers, and pairs that share an address too are one person. The address starts in the
  // phone's shadow, and the fit still finds that it is the one that says something.
  const phone = { identifier: 'phone:p', evidence: 0.85, fanout: 2, gap: 0 }
  const address = { identifier: 'address:a', evidence: 0.6, fanout: 2, gap: 0 }
  const labeled = [...Array.from({ length: 100 }, () => ({ same: false, reasons: [phone] })), ...Array.from({ length: 300 }, () => ({ same: true, reasons: [phone, address] }))]
  const fitted = fit(labeled, policy, 0.01)
  assert.ok(fitted.kinds.phone!.after < 0.2 && fitted.kinds.address!.after > 0.9, JSON.stringify(fitted.kinds))
  assert.ok(fitted.loss.after < fitted.loss.before)
  // The same holds where the address is thinned by the seven who share it.
  const thinned = fit([...Array.from({ length: 70 }, () => ({ same: false, reasons: [phone] })), ...Array.from({ length: 30 }, () => ({ same: true, reasons: [phone, { ...address, evidence: (0.6 * 2) / 7, fanout: 7 }] }))], policy, 0.01)
  assert.ok(thinned.kinds.phone!.after < 0.3 && thinned.kinds.address!.after > 0.9, JSON.stringify(thinned.kinds))
  // A pair's score is the stronger of the two, not the two combined.
  const half = fit(Array.from({ length: 40 }, (_, i) => ({ same: i < 24, reasons: [phone, address] })), policy, 100_000)
  assert.ok(Math.abs(half.calibration[0]!.predicted - 0.85) < 0.01, JSON.stringify(half.calibration))
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

test('the server reads its settings from the environment and names everything wrong at once', async (t) => {
  const config = configFrom({ DATABASE_URL: 'postgres://db', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'svc', ORIGINS: 'https://a.example/, https://b.example ', COOKIE: 'a.example', RATE_BURST: '5' })
  assert.deepEqual(config.origins, ['https://a.example', 'https://b.example'])
  assert.deepEqual([config.port, config.host, config.schema, config.receiptSecrets], [8080, '0.0.0.0', 'account_graph', ['r'.repeat(32)]])
  assert.deepEqual(config.cookie, { domain: 'a.example' })
  assert.deepEqual(config.limit, { perMinute: 120, burst: 5 })
  assert.deepEqual([config.fingerprint, config.maxmind, config.google, config.meta, config.microsoft], [undefined, undefined, undefined, undefined, undefined])
  assert.equal(configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', RATE_LIMIT: 'off', COOKIE: 'true' }).limit, false)
  assert.equal(configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', COOKIE: 'true' }).cookie, true)
  assert.deepEqual(['true', 'false', '2', undefined].map((value) => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', TRUST_PROXY: value }).trustProxy), [1, 0, 2, 0])
    const calls = configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', EVENTS: 'inquiry, brochure', CALL_NUMBERS: '{"555-123-0001":{"source":"google"}}', TWILIO_AUTH_TOKEN: 't', TWILIO_WEBHOOK_URL: 'https://g.example/calls/twilio' })
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', CHANGE_SECRET: 's' }), /now WEBHOOK_URL and WEBHOOK_SECRET/)
  assert.equal(configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', WEBHOOK_SECRET: 's', WEBHOOK_URL: 'https://example.org/c' }).webhookSecret, 's')
  assert.equal(await signWebhook('s', 5, '{}'), `t=5,v1=${createHmac('sha256', 's').update('5.{}').digest('hex')}`)
  const dir = mkdtempSync(join(tmpdir(), 'numbers-'))
  t.after(() => rmSync(dir, { recursive: true }))
  const listed = join(dir, 'numbers.json')
  writeFileSync(listed, '{"555-123-0002":{"source":"meta"}}')
  const from = (more: object) => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', ...more })
  assert.deepEqual([from({}).textCodes, from({ TEXT_CODES: 'true' }).textCodes, from({ TWILIO_AUTH_TOKEN: 't', TWILIO_TEXT_WEBHOOK_URL: 'https://g.example/t' }).twilioTexts], [false, true, { authToken: 't', url: 'https://g.example/t' }])
  assert.deepEqual(from({ CALL_NUMBERS_FILE: listed }).callNumbers, { '555-123-0002': { source: 'meta' } })
  assert.throws(() => from({ CALL_NUMBERS_FILE: listed, CALL_NUMBERS: '{}' }), /must not both be set/)
  assert.throws(() => from({ CALL_NUMBERS_FILE: `${listed}.gone` }), /cannot be read/)
  for (const text of ['[]', '']) {
    writeFileSync(listed, text)
    assert.throws(() => from({ CALL_NUMBERS_FILE: listed }), /CALL_NUMBERS_FILE must be a JSON object/)
  }
  writeFileSync(listed, '{"x":{"source":"a"}}')
  assert.throws(() => from({ CALL_NUMBERS_FILE: listed }), /CALL_NUMBERS_FILE: "x" is not a phone number/)
  assert.deepEqual([calls.callTapSeconds, configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', CALL_TAP_SECONDS: '60' }).callTapSeconds], [180, 60])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', CALL_TAP_SECONDS: '3601' }), /CALL_TAP_SECONDS/)
  assert.deepEqual([calls.events, calls.callNumbers, calls.callMinimum, calls.twilio], [['inquiry', 'brochure'], { '555-123-0001': { source: 'google' } }, 30, { authToken: 't', url: 'https://g.example/calls/twilio' }])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', CALL_NUMBERS: '{"12":{}}', TWILIO_AUTH_TOKEN: 't', REPORT_TIME_ZONE: 'Mars/Olympus' }), (error: Error) =>
    ['"12" is not a phone number', '"12" requires a source', 'TWILIO_WEBHOOK_URL, TWILIO_TEXT_WEBHOOK_URL or TWILIO_ACCOUNT_SID must be set along with TWILIO_AUTH_TOKEN', 'REPORT_TIME_ZONE must be a time zone'].every((line) => error.message.includes(line)))
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', CALL_NUMBERS: '[1]' }), /CALL_NUMBERS must be a JSON object/)

  const full = configFrom({
    DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', REVIEW_TOKENS: '{"dana":"z","lee":["new","old"]}', FINGERPRINT_SECRET: 'f', FINGERPRINT_REGION: 'eu',
    MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'k', GOOGLE_ADS_CUSTOMER_ID: '123', GOOGLE_SERVICE_ACCOUNT_FILE: '/key.json',
    META_PIXEL_ID: 'p', META_ACCESS_TOKEN: 't', META_SITE_URL: 'https://a.example/',
  })
  assert.deepEqual(full.reviewers, { dana: 'z', lee: ['new', 'old'] })
  for (const [given, said] of [['[1]', 'must be a JSON object'], ['{"system:x":"a"}', 'cannot be a reviewer'], ['{"people":"a"}', 'cannot be a reviewer'], ['{" dana":"a"}', 'is not a name'], ['{"dana":""}', 'each token as a string'], ['{"dana":[]}', 'requires a token'], ['{"dana":"a","lee":"a"}', 'another reviewer']]) {
    assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', REVIEW_TOKENS: given! }), (error: Error) => error.message.includes(said!), given)
  }
  const tried = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'change-me-service-token', REVIEW_TOKENS: '{"reviewer":"change-me-review-token"}', LINK_SECRET: 'change-me-link-secret-change-me-now' }
  for (const ORIGINS of ['', 'http://localhost:3000,http://127.0.0.1:3000', 'http://app.localhost:3000', 'http://[::1]:3000']) configFrom({ ...tried, ORIGINS })
  for (const ORIGINS of ['https://example.org', 'https://site.test', 'http://localhost:3000,https://localhost.example.org']) {
    assert.throws(() => configFrom({ ...tried, ORIGINS }), (error: Error) => ['GRAPH_TOKEN', 'REVIEW_TOKENS', 'LINK_SECRET'].every((name) => error.message.includes(`${name} must be changed`)))
  }
  configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', REVIEW_TOKENS: '{"change-me-later":"real"}', ORIGINS: 'https://example.org' })
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', LINK_SECRET: 'x'.repeat(31) }), /at least 32/)
  assert.deepEqual(full.fingerprint, { secretKey: 'f', region: 'eu' })
  assert.equal(full.maxmind!.service, 'insights')
  assert.equal(full.google!.keyFile, '/key.json')
  assert.equal(full.meta!.pixelId, 'p')

  assert.throws(
    () => configFrom({ RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'same', REVIEW_TOKENS: '{"dana":"same"}', PORT: 'eighty', MAXMIND_ACCOUNT_ID: '1', META_PIXEL_ID: 'p', FINGERPRINT_SECRET: 'f', FINGERPRINT_REGION: 'mars' }),
    (error: Error) =>
      ['DATABASE_URL is required', 'PORT must be a number', 'MAXMIND_LICENSE_KEY must be set along with MAXMIND_ACCOUNT_ID', 'META_ACCESS_TOKEN, META_SITE_URL must be set along with META_PIXEL_ID', 'FINGERPRINT_REGION must be us, eu, or ap', 'REVIEW_TOKENS: "dana" has a token that is already the service\'s'].every((line) => error.message.includes(line)),
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
    '"review" must be a positive integer',
    'kind "phone" requires a weight from 0 to 1',
    'kind "Bad:kind" must be a name without a colon',
    'kind "Bad:kind" must be an object, such as {"weight":0.85}',
    'kind "badge" is new, so it requires its dilution',
    'kind "badge" is new, so it requires its cap',
    'kind "badge" is new, so it requires its halfLife',
    'kind "ip" has "colour", which is not part of a rule',
    'kind "ip" requires a dilution of zero or more',
    'kind "ip" requires a cap of zero or more, in whole subjects',
    'kind "ip" requires a halfLife in milliseconds, or "none"',
    'kind "dialed" is a note and links nothing, so its weight must stay 0',
  ])
  assert.deepEqual(policyProblems({ same: 0.4 }), ['"related" must not be above "same"'])
  assert.equal(policyProblems({ kinds: { review: { weight: 0.95 } } }).length, 1)

  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y' }
  assert.equal(configFrom(env).policy, undefined)
  assert.deepEqual(configFrom({ ...env, POLICY: '{"same":0.95}' }).policy, { same: 0.95 })
  assert.throws(() => configFrom({ ...env, POLICY: '{"same":9}' }), /POLICY: "same" must be a number from 0 to 1/)
  assert.throws(() => configFrom({ ...env, POLICY: 'nope' }), /POLICY must be JSON/)
  assert.throws(() => configFrom({ ...env, POLICY: '{}', POLICY_FILE: '/x' }), /must not both be set/)
  assert.throws(() => configFrom({ ...env, POLICY_FILE: '/no/such/file' }), /POLICY_FILE: "\/no\/such\/file" cannot be read/)
})

test('staff networks are read from a setting, and a range that is not one is named', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y' }
  assert.deepEqual(configFrom({ ...env, STAFF_NETWORKS: '192.0.2.10, 2001:db8::/32' }).staffNetworks, ['192.0.2.10', '2001:db8::/32'])
  assert.deepEqual(configFrom(env).staffNetworks, [])
  for (const bad of ['office', '192.0.2.0/33', '192.0.2.0/24/1', '2001:db8::/129', '192.0.2.0/', '/24']) assert.throws(() => configFrom({ ...env, STAFF_NETWORKS: bad }), /STAFF_NETWORKS: .* is not an address or a range/, bad)
})

test('call results are off until set, and read in minutes', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y' }
  assert.deepEqual([configFrom(env).callResults, configFrom(env).callResultWait], [undefined, 30])
  assert.deepEqual([configFrom({ ...env, CALL_RESULTS: 'expected', CALL_RESULT_WAIT: '10' }).callResults, configFrom({ ...env, CALL_RESULT_WAIT: '10' }).callResultWait], ['expected', 10])
  assert.throws(() => configFrom({ ...env, CALL_RESULTS: 'yes' }), /CALL_RESULTS must be expected/)
})

test('calls are counted by hour and weekday where they happened, and by what became of them', () => {
  const at = Date.parse('2026-03-02T05:30:00Z')
  const call = (id: string, more: Partial<KeptCall> = {}): KeptCall => ({ id, direction: 'inbound', subject: `caller:${id}`, at, to: '+15550100001', flags: [], recorded: at, ...more })
  const went = (answered: boolean, voicemail = false) => ({ answered, ...(voicemail && { voicemail }), recorded: at })
  const calls = [
    call('a', { result: went(true), visitor: 'visitor:1' }),
    call('b', { result: went(false) }),
    call('c', { result: went(false, true) }),
    call('d', { result: went(false) }),
    call('e', { at: at + 3_600_000 }),
    call('f', { at: at + 7_200_000, duration: 60 }),
    call('g', { subject: 'call:g', result: went(false) }),
    call('placed', { direction: 'outbound', result: went(true) }),
  ]
  const later = [...calls, call('r1', { subject: 'caller:b', direction: 'outbound', at: at + 60_000, result: went(true) }), call('r2', { subject: 'caller:c', at: at + 120_000, result: went(true) })]
  const summary = summarizeCalls(calls, later, new Set(['b', 'c']), at + 7_200_000 + 60_000 + 30 * 60_000 - 1, 'America/New_York', { results: 'expected' })
  assert.deepEqual(summary.total, { calls: 7, answered: 1, missed: 3, voicemail: 1, waiting: 1, unknown: 1, returned: 1, reported: 0, calledAgain: 1, notLeads: 0, hidden: 1 })
  // Half past five in the morning in London is half past midnight on Monday in New York.
  assert.deepEqual(summary.cells.map((cell) => [cell.weekday, cell.hour, cell.calls]), [[1, 0, 5], [1, 1, 1], [1, 2, 1]])
  assert.deepEqual(summarizeCalls(calls, later, new Set(), at, 'UTC').cells.map((cell) => [cell.weekday, cell.hour, cell.calls]), [[1, 5, 5], [1, 6, 1], [1, 7, 1]])
  assert.deepEqual(summary.coverage, { visitor: 1, channel: 2, neither: 4, noResult: 2 })
  assert.equal(summary.returnedWithin, 60_000)
  // An hour that happens twice when clocks go back is one hour of the day; nothing is lost.
  const fall = [0, 1].map((n) => call(`h${n}`, { at: Date.parse('2026-11-01T05:30:00Z') + n * 3_600_000 }))
  assert.deepEqual(summarizeCalls(fall, [], new Set(), at, 'America/New_York').cells.map((cell) => [cell.weekday, cell.hour, cell.calls]), [[7, 1, 2]])
  // How long a call lasted says nothing about who answered it, so one with no result has none, expected or not.
  assert.equal(summarizeCalls([call('long', { duration: 600 }), call('waited', { result: { waited: 5, recorded: at } })], [], new Set(), at).coverage.noResult, 2)
  // Already tomorrow in Tokyo.
  assert.deepEqual([dayIn(Date.parse('2026-03-02T16:00:00Z'), 'Asia/Tokyo'), dayIn(Date.parse('2026-03-02T16:00:00Z'))], ['2026-03-03', '2026-03-02'])
  assert.deepEqual(summarizeCalls([], [], new Set(), at), { total: { calls: 0, answered: 0, missed: 0, voicemail: 0, waiting: 0, unknown: 0, returned: 0, reported: 0, calledAgain: 0, notLeads: 0, hidden: 0 }, closed: null, cells: [], coverage: { visitor: 0, channel: 0, neither: 0, noResult: 0 }, returnedWithin: null })
})

test('quiet hours are off until set, and a call back is due after a day', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y' }
  assert.deepEqual([configFrom(env).quiet, configFrom(env).returnHours], [{ touches: 0, calls: 0, results: 0, costs: 0 }, 24])
  assert.deepEqual([configFrom({ ...env, QUIET_CALLS_HOURS: '6' }).quiet.calls, configFrom({ ...env, RETURN_HOURS: '0' }).returnHours], [6, 0])
  assert.throws(() => configFrom({ ...env, QUIET_COSTS_HOURS: 'often' }), /QUIET_COSTS_HOURS must be a number/)
  // An arrival is paid for when it carries an ad click, names its campaign by id, or says so.
  const touch = (more: object) => paid({ subject: 'visitor:1', at: 0, ...more })
  assert.deepEqual([{ gclid: 'G' }, { campaignId: '1' }, { medium: 'CPC' }, { medium: 'paid_social' }, { source: 'mailer', medium: 'call' }, { referrer: 'https://partner.example' }, { fbclid: 'F' }, { fbclid: 'F', campaignId: '9' }].map(touch), [true, true, true, true, false, false, false, true])
})

test('a tracking number may say what it stands for', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y' }
  const numbers = { '+15550100001': { source: 'google', tags: { office_advertised: 'north', language: 'es' } } }
  assert.deepEqual(configFrom({ ...env, CALL_NUMBERS: JSON.stringify(numbers) }).callNumbers, numbers)
  assert.throws(() => configFrom({ ...env, CALL_NUMBERS: '{"+15550100001":{"source":"x","tags":{"Office":"n"}}}' }), /CALL_NUMBERS: "\+15550100001" has a tag named "Office"/)
})

test('what followed a call starts the clock at a landmark, and leaves out whoever was already on the way', () => {
  const DAY = 86_400_000
  const T = Date.parse('2026-01-05T15:00:00Z')
  let n = 0
  const call = (at: number, answered: boolean | undefined, more: Partial<KeptCall> = {}): KeptCall => ({ id: `c${n++}`, direction: 'inbound', subject: 'caller:x', at, to: '+15550100001', flags: [], recorded: at, duration: 120, ...(answered !== undefined && { result: { answered, recorded: at } }), ...more })
  const back = (at: number, answered = true) => call(at, answered, { direction: 'outbound' })
  const person = (called: KeptCall[], later: KeptCall[] = [], reached: number[] = []): Caller => ({ called, calls: [...called, ...later], reached })
  const run = (callers: Caller[], more: object = {}) => followed(callers, { step: 'client', days: 30, at: T + 100 * DAY, least: 1, ...more })
  const group = (result: Followed, by: string) => result.groups.find((each) => each.by === by)!.rows.map((row) => [row.name, row.people, row.reached])

  // Missed and rung back the same day, who signed up later; missed and left alone, who did not; rung back too late for the landmark.
  const returned = person([call(T, false)], [back(T + 3_600_000)], [T + 5 * DAY])
  const left = person([call(T, false)])
  const late = person([call(T, false)], [back(T + 2 * DAY)], [T + 9 * DAY])
  assert.deepEqual(group(run([returned, left, late]), 'returned'), [['returned within a day', 1, 1], ['not returned within a day', 2, 1]])

  // Signing up already: they signed the same evening, and somebody rang them about it. The call looks like the cause and is not, so they are left out.
  const signing = person([call(T, false)], [back(T + 3_600_000)], [T + 2 * 3_600_000])
  // And one who rang again and got through: whether they were rung back says nothing.
  const through = person([call(T, false)], [call(T + 1_800_000, true)], [T + 4 * DAY])
  const biased = run([returned, left, signing, through])
  assert.deepEqual(group(biased, 'returned'), [['returned within a day', 1, 1], ['not returned within a day', 1, 0]])
  assert.deepEqual(biased.excluded, { first: { already: 0, running: 0 }, returned: { already: 1, running: 0, through: 1 } })
  // Rung back first and ringing in afterwards is getting through too.
  const both = person([call(T, false)], [back(T + 600_000), call(T + 7_200_000, true)], [T + 4 * DAY])
  assert.equal(run([both]).excluded.returned.through, 1)
  // Ringing just before the landmark and answered after the wait is getting through after it.
  const waiting = person([call(T, false)], [call(T + DAY - 60_000, true, { result: { answered: true, waited: 120, recorded: T } })], [T + 4 * DAY])
  assert.deepEqual(group(run([waiting]), 'returned'), [['not returned within a day', 1, 1]])
  // A report about a call that was not missed says nothing here either.
  assert.deepEqual(group(run([person([call(T, false)], [call(T + 1000, false, { direction: 'outbound', result: { answered: false, returned: T + 2000, recorded: T } })])]), 'returned'), [['not returned within a day', 1, 0]])
  // Reached as your own system says, within the day or after it.
  const reachedAt = (at: number) => person([call(T, false, { result: { answered: false, returned: at, recorded: T } })])
  assert.deepEqual(group(run([reachedAt(T + DAY), reachedAt(T + DAY + 1)]), 'returned'), [['returned within a day', 1, 0], ['not returned within a day', 1, 0]])
  // Getting through after the landmark was still to come when the clock started, so it stays.
  const afterwards = person([call(T, false)], [call(T + 2 * DAY, true)], [T + 4 * DAY])
  assert.deepEqual(group(run([afterwards]), 'returned'), [['not returned within a day', 1, 1]])

  // A step on the last day counts and one after it does not. Someone whose days are not over says nothing yet.
  const edge = (days: number) => person([call(T, true)], [], [T + 120_000 + days * DAY])
  assert.deepEqual(group(run([edge(30), edge(30.01)]), 'answer'), [['answered', 2, 1]])
  const running = run([edge(5)], { at: T + 10 * DAY })
  assert.deepEqual([group(running, 'answer'), running.excluded.first.running], [[], 1])
  // Reached before the call ended, whatever they do after.
  assert.equal(run([person([call(T, true)], [], [T + 60_000, T + DAY])]).excluded.first.already, 1)

  // How long they talked leaves out the wait, and is not known when the wait is not. A call nobody answered was not talked on. Only a person's first call counts.
  const talked = (seconds: number, waited = 0) => person([call(T, true, { duration: seconds, result: { answered: true, waited, recorded: T } }), call(T + DAY, true, { duration: 9999 })])
  assert.deepEqual(group(run([talked(59), talked(60), talked(400, 350), talked(301), talked(900), person([call(T, true, { duration: 500 })]), person([call(T, false, { duration: 500 })]), person([call(T, undefined)])]), 'talk'), [['under 1 minute', 2, 0], ['1 to 5 minutes', 1, 0], ['5 to 15 minutes', 1, 0], ['15 minutes or more', 1, 0], ['(not set)', 1, 0]])
  const answers = run([person([call(T, true, { tags: { language: 'es' } })]), person([call(T, undefined)]), person([call(T, false, { result: { answered: false, voicemail: true, recorded: T } })]), person([call(T, false)])])
  assert.deepEqual(group(answers, 'answer'), [['answered', 1, 0], ['missed', 1, 0], ['voicemail', 1, 0], ['(not set)', 1, 0]])
  assert.deepEqual(group(answers, 'language'), [['es', 1, 0], ['(not set)', 3, 0]])
  // A hidden number cannot be rung back, so it is in neither row.
  assert.deepEqual(group(run([person([call(T, false, { id: 'h', subject: 'call:h' })])]), 'returned'), [])

  // Thin rows are not shown, and how many people were in them is.
  const many = Array.from({ length: 25 }, (_, i) => person([call(T, i < 20)]))
  const thin = run(many, { least: 20 }).groups.find((each) => each.by === 'answer')!
  assert.deepEqual([thin.rows.map((row) => [row.name, row.people, row.share]), thin.suppressed], [[['answered', 20, 0]], 5])
  assert.deepEqual(run([...many].reverse(), { least: 20 }), run(many, { least: 20 }))
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
  // Broken down, the parts do not depend on the order either.
  const missed = touches.map((each, i) => ({ at: i, touch: each, ...(i % 2 && { tags: { office: `o${i % 3}` } }) }))
  const parts = (flip: boolean) => fold('2026-03-01', '2026-03-02', costs, touches, flip ? [...credited].reverse() : credited, { missed: flip ? [...missed].reverse() : missed, by: 'outcome.office' }).total.breakdown
  assert.deepEqual(parts(true), parts(false))
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
  assert.deepEqual(Object.entries(counts(expected.total.stages)).sort(), [['__proto__', { count: 1, value: 1 }], ['constructor', { count: 1, value: 2 }], ['enrolled', { count: 1, value: 200 }]])
  assert.equal(({} as any).count, undefined)
  // Every rotation and the reverse of each list gives the same report.
  const turn = <T>(list: T[], by: number) => [...list.slice(by), ...list.slice(0, by)]
  for (let by = 0; by < touches.length; by++) {
    assert.deepEqual(fold('2026-03-01', '2026-03-02', turn(costs, by % costs.length), turn(touches, by), turn(credited, by % credited.length)), expected)
    assert.deepEqual(fold('2026-03-01', '2026-03-02', turn(costs, by % costs.length).reverse(), turn(touches, by).reverse(), credited), expected)
  }
})

test('how recent is too recent is worked out from the days as they are, not as they are shown', () => {
  const history = Array.from({ length: 20 }, (_, n) => ({ outcome: { transactionId: `t${n}`, subject: 's', at: 10 * 86_400_000, stage: 'sale', value: 0, currency: '' }, touch: undefined, delay: 4.04 * 86_400_000, inside: true }))
  assert.deepEqual(fold('2026-03-01', '2026-03-10', [], [], [], { history }).incomplete, { after: '2026-03-05', days: 5 })
  const quick = history.map((each) => ({ ...each, delay: 60_000 }))
  assert.deepEqual(fold('2026-03-01', '2026-03-10', [], [], [], { history: quick }).incomplete, { after: '2026-03-09', days: 1 })
  assert.equal(fold('2026-03-01', '2026-03-10', [], [], [], { history: history.slice(1) }).incomplete, undefined)
  // What came too late to be credited is not waited for.
  assert.deepEqual(fold('2026-03-01', '2026-03-10', [], [], [], { history: [...history, ...history.map((each) => ({ ...each, delay: 100 * 86_400_000, inside: false }))] }).incomplete, { after: '2026-03-05', days: 5 })
})

test('what an outcome cost uses the outcomes of that campaign, on the days whose cost is known', () => {
  const cost = (day: string, campaignId: string, amount: number) => ({ day, source: 'google', campaignId, campaign: '', amount, currency: 'USD', clicks: 0, impressions: 0 })
  const days = (count: number) => Array.from({ length: count }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`)
  const touch = (campaignId: string) => ({ subject: 's', at: 0, gclid: 'G', campaignId })
  let n = 0
  const sale = (day: string, campaignId: string | undefined, value = 100) => ({ outcome: { transactionId: `t${n++}`, subject: 's', at: Date.parse(`${day}T12:00:00Z`), stage: 'sale', value, currency: 'USD' }, touch: campaignId ? touch(campaignId) : undefined })
  const credited = [
    // Full: ten days of cost at 10, four sales, one of them with nothing to say what it cost if it fell outside.
    ...['2026-03-02', '2026-03-05', '2026-03-05', '2026-03-09'].map((day) => sale(day, 'full')),
    // Gaps: six days of cost, two sales inside them and three on days with none.
    ...['2026-03-01', '2026-03-06', '2026-03-08', '2026-03-09', '2026-03-10'].map((day) => sale(day, 'gaps')),
    // Thin: four of ten days.
    sale('2026-03-01', 'thin'),
    // No cost at all, and nobody credited.
    sale('2026-03-01', 'free'),
    sale('2026-03-01', undefined, 5000),
  ]
  const costs = [...days(10).map((day) => cost(day, 'full', 10)), ...days(6).map((day) => cost(day, 'gaps', 5)), ...days(4).map((day) => cost(day, 'thin', 50)), cost('2026-03-01', 'idle', 7)]
  const report = fold('2026-03-01', '2026-03-10', costs, [], credited)
  const row = (id: string) => {
    const { costDays, missingDays, insufficientData, costPerOutcome, returnOnCost } = report.rows.find((each) => each.campaignId === id)!
    return [costDays, missingDays, insufficientData, costPerOutcome, returnOnCost]
  }
  assert.deepEqual(row('full'), [10, 0, false, 25, 4])
  // 30 over the two sales on those days, and not over all five.
  assert.deepEqual(row('gaps'), [6, 4, false, 15, 6.666667])
  assert.deepEqual(row('thin'), [4, 6, true, null, null])
  assert.deepEqual(row('free'), [0, 10, true, null, null])
  // The total covers the campaigns whose cost is known: 130 over six sales. Not the 337 spent over the twelve there were.
  assert.deepEqual([report.total.costPerOutcome, report.total.returnOnCost, report.excluded, report.days], [21.666667, 4.615385, 3, 10])
  assert.equal(report.total.cost, 337)
  // A campaign known only by its name may be a newsletter, and spend on no campaign is nobody's: neither is withheld for want of days.
  const unnumbered = fold('2026-03-01', '2026-03-10', [cost('2026-03-01', '', 5)], [{ subject: 's', at: 0, source: 'newsletter', campaign: 'march' }], [])
  assert.deepEqual(unnumbered.rows.map((each) => [each.source, each.insufficientData]), [['google', false], ['newsletter', false]])
  assert.equal(unnumbered.excluded, 0)
  // One known by its name whose arrivals were ad clicks was paid for, so its cost is missing.
  const clicked = fold('2026-03-01', '2026-03-10', [], [{ subject: 's', at: 0, gclid: 'G', campaign: 'spring' }], [])
  assert.deepEqual([clicked.rows[0]!.insufficientData, clicked.rows[0]!.missingDays, clicked.excluded], [true, 10, 1])
  // Days still to come are not missing.
  const early = fold('2026-03-01', '2026-03-31', costs, [], credited, { through: '2026-03-10' })
  assert.deepEqual([early.days, early.rows.find((each) => each.campaignId === 'full')!.missingDays], [10, 0])
  assert.equal(fold('2026-04-01', '2026-04-05', [], [], [], { through: '2026-03-10' }).days, 0)
  // A day belongs to the time zone: at noon in London it is already the next day in Kiritimati.
  const shifted = fold('2026-03-03', '2026-03-03', [cost('2026-03-03', 'full', 10)], [], [sale('2026-03-02', 'full')], { timeZone: 'Pacific/Kiritimati' })
  assert.equal(shifted.rows[0]!.costPerOutcome, 10)
  // A row for a day still to come is not cost data yet.
  const ahead = fold('2026-03-01', '2026-03-04', [cost('2026-03-03', 'full', 10), cost('2026-03-04', 'full', 10)], [], [sale('2026-03-03', 'full')], { through: '2026-03-02' })
  assert.deepEqual([ahead.days, ahead.rows[0]!.costDays, ahead.rows[0]!.costPerOutcome, ahead.total.cost], [2, 0, null, 20])
  // A campaign known to have cost nothing has outcomes that cost nothing, and they count in the total.
  const free = fold('2026-03-01', '2026-03-01', [cost('2026-03-01', 'gift', 0), cost('2026-03-01', 'paid', 30)], [], [sale('2026-03-01', 'gift'), sale('2026-03-01', 'paid')])
  assert.deepEqual(free.rows.map((each) => [each.campaignId, each.costPerOutcome, each.returnOnCost]), [['paid', 30, 3.333333], ['gift', 0, null]])
  assert.equal(free.total.costPerOutcome, 15)
  // Spend on no campaign in particular is in the total's cost, and is nobody's cost per outcome.
  const loose = fold('2026-03-01', '2026-03-01', [cost('2026-03-01', '', 500), cost('2026-03-01', 'paid', 30)], [], [{ ...sale('2026-03-01', undefined), touch: { subject: 's', at: 0, gclid: 'G' } }, sale('2026-03-01', 'paid')])
  assert.deepEqual([loose.rows.find((each) => each.campaignId === '')!.costPerOutcome, loose.total.costPerOutcome, loose.total.cost], [null, 30, 530])
  // Two campaigns each known on half the days they need: between them every day, and still nothing can be said.
  const halves = fold('2026-03-01', '2026-03-10', [...days(4).map((day) => cost(day, 'a', 10)), ...days(10).slice(6).map((day) => cost(day, 'b', 10))], [], [sale('2026-03-01', 'a'), sale('2026-03-08', 'b')])
  assert.deepEqual([halves.total.insufficientData, halves.total.costPerOutcome, halves.excluded, halves.total.costDays], [true, null, 2, 8])
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
  const handler = createHandler(graph, { token: 'secret', reviewers: { dana: 'reviewer' }, origins: ['https://site.example'], now: () => at, timeZone: 'UTC' })
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
      { source: 'google', campaignId: '111', campaign: 'Spring', cost: 50, clicks: 10, impressions: 0, visits: 1, missed: 0, notLeads: 0, stages: { enrolled: { count: 1, value: 120, people: 1, delay: { count: 1, median: 0, p95: 0, inside: 1 } } }, outcomes: 1, value: 120, people: 1, valueChange: { outcomes: 1, first: 200, now: 120, refunded: 0, writtenOff: 0, zeroed: 0, firstUnknown: 0 }, costDays: 1, missingDays: 1, insufficientData: false, costPerOutcome: 50, returnOnCost: 2.4 },
    ])
    // One outcome with every value it has had, for a reviewer.
    const asked = (await (await fetch(`${base}/outcome?id=enr-9`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    assert.deepEqual([asked.value, asked.values.map((each: any) => each.value)], [120, [200, 120]])
    assert.equal(await (await fetch(`${base}/outcome?id=nobody`, { headers: { authorization: 'Bearer reviewer' } })).json(), null)
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
  assert.deepEqual(ladderProblems({ a: { value: -1 }, b: 5, c: { action: 'x' }, d: { action: { tiktok: 'y' } }, e: { action: { google: '' } }, f: { currency: 7 }, g: { wait: -1 } }, ['google', 'meta']), [
    'step "a" requires a value of zero or more',
    'step "b" must be an object, such as {"value":5}',
    'step "c" must name its action per platform, such as {"google":"…"}',
    'step "d" names "tiktok", which is not set up',
    'step "e" requires its action as a string, or as one text per platform',
    'step "f" requires its currency as a string',
    'step "g" requires its wait as hours, zero or more',
  ])
  // With one platform a plain action is enough. With none, an action has nowhere to go, and saying so beats sending nothing quietly.
  assert.deepEqual(ladderProblems({ c: { action: 'x' } }, ['google']), [])
  assert.deepEqual(ladderProblems({ d: { action: { gogle: 'y' } }, e: { action: 'x' }, f: { value: 5 } }, []), [
    'step "d" has an action, but no ad platform is set up to send it to',
    'step "e" has an action, but no ad platform is set up to send it to',
  ])
  assert.deepEqual(ladderProblems({ g: { action: 5 }, h: { action: ['x'] }, i: { action: '' } }, ['google']).length, 3)
  assert.deepEqual(ladderProblems([1], []), ['must be an object of steps, such as {"inquiry":{"value":5}}'])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', STAGES: '{"inquiry":{"value":"5"}}' }), /STAGES: step "inquiry" requires a value of zero or more/)
  assert.deepEqual(configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', STAGES: '{"inquiry":{"value":5}}', ALERT_WEBHOOK: 'https://hooks.example/x' }).stages, { inquiry: { value: 5 } })
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
  assert.deepEqual(errors.map((error) => (error as Error).message), ['The alert webhook returned 500', 'network down'])
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
  const both = configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', TWILIO_AUTH_TOKEN: 't', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_WEBHOOK_URL: 'https://g.example/calls/twilio', SMARTY_AUTH_ID: 'id', SMARTY_AUTH_TOKEN: 'tok' })
  assert.deepEqual([both.twilio, both.lineType, both.smarty], [{ authToken: 't', url: 'https://g.example/calls/twilio' }, { accountSid: 'AC1', authToken: 't' }, { authId: 'id', authToken: 'tok' }])
  const lookupOnly = configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', TWILIO_AUTH_TOKEN: 't', TWILIO_ACCOUNT_SID: 'AC1' })
  assert.deepEqual([lookupOnly.twilio, lookupOnly.lineType], [undefined, { accountSid: 'AC1', authToken: 't' }])
  assert.throws(() => configFrom({ DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', TWILIO_ACCOUNT_SID: 'AC1', SMARTY_AUTH_ID: 'id' }), (error: Error) =>
    ['TWILIO_AUTH_TOKEN must be set along with TWILIO_ACCOUNT_SID', 'SMARTY_AUTH_TOKEN must be set along with SMARTY_AUTH_ID'].every((line) => error.message.includes(line)))
})

test('IDENTIFIER_SECRET is checked', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', ALERT_WEBHOOK: 'https://hooks.example/x' }
  assert.equal(configFrom(env).identifierSecret, undefined)
  assert.equal(configFrom({ ...env, IDENTIFIER_SECRET: 'x'.repeat(32) }).identifierSecret, 'x'.repeat(32))
  assert.throws(() => configFrom({ ...env, IDENTIFIER_SECRET: 'short' }), /IDENTIFIER_SECRET must be at least 32 characters/)
})

test('the number pool is off until numbers are given, and its settings are checked', () => {
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', ALERT_WEBHOOK: 'https://hooks.example/x' }
  assert.deepEqual(configFrom(env).poolNumbers, [])
  const { poolNumbers, poolMinutes, poolGrace } = configFrom({ ...env, POOL_NUMBERS: '+15550100001, (555) 010-0002', POOL_MINUTES: '20', POOL_GRACE_MINUTES: '0' })
  assert.deepEqual([poolNumbers, poolMinutes, poolGrace], [['+15550100001', '(555) 010-0002'], 20, 0])
  assert.deepEqual(configFrom({ ...env, CALL_EXCLUDE: '+15550100001, (555) 010-0002' }).callExclude, ['+15550100001', '(555) 010-0002'])
  assert.throws(() => configFrom({ ...env, CALL_EXCLUDE: 'office' }), /CALL_EXCLUDE: "office" is not a phone number/)
  assert.throws(() => configFrom({ ...env, POOL_NUMBERS: 'nonsense' }), /POOL_NUMBERS: "nonsense" is not a phone number/)
  assert.throws(() => configFrom({ ...env, POOL_NUMBERS: '+15550100001', POOL_MINUTES: '0' }), /POOL_MINUTES must be at least 1/)
})

test('Meta gets its browser id only as Meta writes it, and only beside its click', () => {
  const at = 1_700_000_000_000
  const target = meta({ pixelId: '1', accessToken: 't', url: 'https://site.example/' })
  const touch = (more: object) => ({ subject: 'visitor:v', at, confidence: 1, via: [], ...more })
  const sent = (touches: object[]) => {
    const click = target.click({ subject: 'visitor:v', at, touches: touches as never, credited: undefined, reason: 'credited' }, 0.9)
    return click && (metaEvent('Lead', { job: { transactionId: 't', subject: 'visitor:v', at, keys: {} }, touch: click } as never, 'https://site.example/').user_data as Record<string, unknown>)
  }
  const fbp = 'fb.1.1700000000000.1234567890'
  assert.deepEqual(sent([touch({ fbclid: 'F', fbp })]), { fbc: `fb.1.${at}.F`, fbp })
  assert.deepEqual(sent([touch({ fbclid: 'F' })]), { fbc: `fb.1.${at}.F` })
  // Anything a page could put there instead is left out.
  for (const made of ['x', 'fb.1.1700000000000.abc', 'fb.1.1700000000000.1&em=x', `${fbp}\n`]) assert.deepEqual(sent([touch({ fbclid: 'F', fbp: made })]), { fbc: `fb.1.${at}.F` }, made)
  // One that is not keeps nothing from a good one on another arrival of that browser.
  assert.deepEqual(sent([touch({ fbclid: 'F', fbp: 'x' }), touch({ fbp: 'y' }), touch({ fbp })]), { fbc: `fb.1.${at}.F`, fbp })
  assert.deepEqual((metaEvent('Lead', { job: { transactionId: 't', subject: 'v', at, keys: {} }, touch: touch({ fbp }) } as never, 'https://site.example/') as any).user_data, {})
  // No Meta click, no browser id: it is a key that goes along, and not one to send a conversion by.
  assert.equal(sent([touch({ source: 'newsletter', fbp })]), undefined)
})

test('opening hours count time while open, across nights, holidays, clock changes and midnight', () => {
  const week = { mon: ['09:00-12:00', '13:00-17:00'], tue: ['09:00-17:00'], wed: ['09:00-17:00'], thu: ['09:00-17:00'], fri: ['18:00-02:00'], holidays: ['2026-01-07'] }
  // Holidays by name fall on the day they are kept, in years past too.
  const named = createHours({ ...week, fri: ['09:00-17:00'], holidays: ['us', '2026-12-31'] }, 'America/Chicago')
  const noon = (day: string) => Date.parse(`${day}T18:00:00Z`)
  assert.deepEqual(hoursProblems({ ...week, holidays: ['us-tx', '2026-12-31'] }), [])
  assert.match(hoursProblems({ ...week, holidays: ['uk'] })[0]!, /"us" or "us-tx"/)
  assert.deepEqual(['2026-11-25', '2026-11-26', '2026-11-27', '2026-12-31', '2027-07-05', '2020-11-26'].map((day) => named.isOpen(noon(day))), [true, false, true, false, false, false])
  assert.deepEqual(hoursProblems(week), [])
  const hours = createHours(week, 'America/New_York')
  const at = (text: string) => Date.parse(`${text}:00-05:00`)
  const HOUR = 3_600_000
  // Monday 5 January to Sunday 11 January 2026.
  for (const [text, open] of [['2026-01-05T08:59', false], ['2026-01-05T09:00', true], ['2026-01-05T11:59', true], ['2026-01-05T12:00', false], ['2026-01-05T13:00', true], ['2026-01-05T17:00', false], ['2026-01-07T10:00', false], ['2026-01-09T17:59', false], ['2026-01-09T23:30', true], ['2026-01-10T01:59', true], ['2026-01-10T02:00', false], ['2026-01-11T10:00', false]] as const) assert.equal(hours.isOpen(at(text)), open, text)
  const before = (text: string, open: number) => new Date(hours.before(at(text), open * HOUR) - 5 * HOUR).toISOString().slice(0, 16)
  // Through lunch, the night, the holiday on Wednesday, and the weekend.
  assert.equal(before('2026-01-05T14:00', 2), '2026-01-05T11:00')
  assert.equal(before('2026-01-06T10:00', 3), '2026-01-05T15:00')
  assert.equal(before('2026-01-08T11:00', 4), '2026-01-06T15:00')
  assert.equal(before('2026-01-12T09:30', 8.5), '2026-01-09T18:00')
  assert.equal(before('2026-01-10T01:00', 7), '2026-01-09T18:00')
  // Asked while closed, the time since the last closing is nothing. Asked for none, it is now.
  assert.equal(before('2026-01-11T10:00', 1), '2026-01-10T01:00')
  assert.equal(hours.before(at('2026-01-11T10:00'), 0), at('2026-01-11T10:00'))
  // A span that runs into the next day's counts each moment once.
  const round = createHours({ mon: ['18:00-10:00'], tue: ['09:00-17:00'] })
  assert.equal(new Date(round.before(Date.parse('2026-01-06T12:00Z'), 5 * HOUR)).toISOString(), '2026-01-06T07:00:00.000Z')
  // One that holds another whole, from the day before, does too.
  const nested = createHours({ mon: ['18:00-10:00'], tue: ['06:00-07:00'] })
  assert.equal(new Date(nested.before(Date.parse('2026-01-06T12:00Z'), 2 * HOUR)).toISOString(), '2026-01-06T08:00:00.000Z')
  // A span that begins in the hour the clocks skip begins when they have, and one in the hour they repeat is open twice.
  const night = createHours({ sun: ['01:15-01:45', '02:30-04:00'] }, 'America/New_York')
  const opened = (text: string) => night.isOpen(Date.parse(text))
  assert.deepEqual(['2026-03-08T06:30Z', '2026-03-08T06:45Z', '2026-03-08T07:00Z', '2026-03-08T07:59Z', '2026-03-08T08:00Z'].map(opened), [true, false, true, true, false])
  assert.deepEqual(['2026-11-01T05:30Z', '2026-11-01T06:00Z', '2026-11-01T06:30Z', '2026-11-01T07:15Z', '2026-11-01T07:45Z'].map(opened), [true, false, true, false, true])
  assert.equal(night.before(Date.parse('2026-11-01T07:00Z'), HOUR), Date.parse('2026-11-01T05:15Z'))
  // Where the clocks change at midnight itself, the day still begins and ends once.
  const beirut = createHours({ sun: ['00:00-24:00'], sat: ['00:00-24:00'] }, 'Asia/Beirut')
  for (let hour = 0; hour < 47; hour++) assert.equal(beirut.isOpen(Date.parse('2026-03-27T23:00Z') + hour * HOUR), hour < 46, String(hour))
  // The clocks go forward on 8 March 2026: nine on that day is nine, and a night across it is an hour shorter.
  const sunday = createHours({ sat: ['22:00-06:00'], sun: ['09:00-10:00'] }, 'America/New_York')
  assert.deepEqual([sunday.isOpen(Date.parse('2026-03-08T13:00:00Z')), sunday.isOpen(Date.parse('2026-03-08T12:59:00Z')), sunday.isOpen(Date.parse('2026-03-08T14:00:00Z'))], [true, false, false])
  assert.equal(new Date(sunday.before(Date.parse('2026-03-08T12:00:00Z'), 7 * HOUR)).toISOString(), '2026-03-08T03:00:00.000Z')
  // Against counting minute by minute.
  for (let i = 0; i < 40; i++) {
    const now = at('2026-01-12T12:00') - i * 7_777_000
    const open = (1 + (i % 23)) * 1_800_000
    let left = open
    let minute = now
    while (left > 0) {
      minute -= 1000
      if (hours.isOpen(minute)) left -= 1000
    }
    assert.equal(hours.before(now, open), minute)
  }
  // Closed for good, nothing is long enough ago.
  assert.equal(createHours({ mon: ['09:00-09:30'], holidays: [] }).before(Date.parse('2026-01-12T00:00Z'), 1e12), -Infinity)

  for (const [given, problem] of [
    [[], 'must be an object, such as {"mon":["09:00-17:00"]}'], [{}, 'names no time you are open'], [{ mon: [] }, 'names no time you are open'], [{ monday: ['09:00-17:00'] }, '"monday" is not a day of the week, "holidays" or "timeZone"'],
    [{ mon: '09:00-17:00' }, '"mon" must be a list, such as ["09:00-17:00"]'], [{ mon: ['9-17'] }, '"mon" has "9-17", which is not written 09:00-17:00'], [{ mon: ['09:00-24:30'] }, '"mon" has "09:00-24:30", which is not written 09:00-17:00'],
    [{ mon: ['09:00-09:00'] }, '"mon" has "09:00-09:00", which is not written 09:00-17:00'], [{ mon: ['09:00-12:00', '11:00-13:00'] }, '"mon" has spans that overlap'], [{ mon: ['09:00-17:00'], holidays: ['2026-02-30'] }, '"holidays" has "2026-02-30", which is not a day written YYYY-MM-DD, "us" or "us-tx"'],
    [{ mon: ['09:00-17:00'], holidays: '2026-12-25' }, '"holidays" must be a list, such as ["2026-12-25"]'],
    [{ mon: ['09:00-17:00'], timeZone: 'Mars' }, '"timeZone" must be a time zone, such as America/New_York'],
  ] as const) assert.deepEqual(hoursProblems(given), [problem])
  const env = { DATABASE_URL: 'x', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', ALERT_WEBHOOK: 'https://hooks.example/x' }
  assert.equal(configFrom(env).openHours, undefined)
  assert.deepEqual(configFrom({ ...env, OPEN_HOURS: '{"mon":["09:00-24:00"]}' }).openHours, { mon: ['09:00-24:00'] })
  assert.throws(() => configFrom({ ...env, OPEN_HOURS: '{"mon":["9"]}' }), /OPEN_HOURS: "mon" has "9"/)
})

test('a code is found in a text only where the site wrote it', () => {
  const code = textCode()
  assert.match(code, /^[2-9A-HJKMNP-TV-Z]{6}$/)
  for (const said of [`I need a lawyer. Ref ${code}`, `ref: ${code.toLowerCase()} thanks`, `(Ref#${code})`, `Necesito un abogado\nREF ${code}.`]) assert.equal(codeIn(said), code, said)
  assert.equal(codeIn(`My order Ref ABCDEF. Ref ${code}`), code)
  for (const said of ['THANKS', `${code}`, `Ref ${code}X`, `href ${code}`, 'Ref ABC', 'prefer THANKS', '']) assert.equal(codeIn(said), undefined, said)
})

test('a date that systems write where none was given is nobody\'s birth', () => {
  const secret = 'a secret of more than thirty-two characters'
  for (const none of ['1899-12-30', '1900-01-01', '1901-01-01', '0001-01-01', '1970-01-01', '2099-01-01', '1980-13-01', '1980-02-30', '']) assert.deepEqual(birthKeys(secret, none), [], none)
  for (const some of ['1931-01-01', '1980-02-29', '2001-12-31']) assert.equal(birthKeys(secret, some).length, 3, some)
})
