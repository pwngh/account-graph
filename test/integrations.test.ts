import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { createGraph, createMemoryStore, createOps, createOutbox, googleAds, hashPhone, knownLink, policyFrom, staffLink, email, phone, phoneOfType, recordCall } from '../tools/internals.ts'
import type { IngestRequest } from '../tools/internals.ts'
import { readEnvironment as configFrom } from '../src/bin.ts'
import { CostError, costsFromCsv, googleCosts, metaCosts } from '../src/providers/costs.ts'
import { createFingerprintVerifier, trusted } from '../src/providers/fingerprint.ts'
import type { VerifiedFingerprint } from '../src/providers/fingerprint.ts'
import { createGoogleTokens } from '../src/providers/google-auth.ts'
import { createMicrosoftTokens } from '../src/providers/microsoft-auth.ts'
import { hardwareId } from '../src/edge/hardware.ts'
import { machineId } from '../src/edge/machine.ts'
import { createDatabaseLookup, createMaxMindLookup, placeOf, shared } from '../src/providers/maxmind.ts'
import { addressIdentifier, createAddressVerifier } from '../src/providers/smarty.ts'
import { createLineTypeLookup, fromTwilio, twilioCall, twilioSignature, twilioRecording } from '../src/providers/twilio.ts'
import { createHandler } from './harness.ts'
import { counts } from './suite.ts'

const T0 = 1_708_102_555_327

/** A stand-in for `fetch` that records each call and answers from `reply`. */
function fake(reply: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (input: any, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    const { status = 200, body } = reply(String(input), init)
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetcher, calls }
}

/** The 200 example from Fingerprint's Server API reference, trimmed to the fields read here. */
const event = {
  event_id: '1708102555327.NLOjmg',
  timestamp: T0,
  ip_address: '203.0.113.9',
  incognito: false,
  bot: 'not_detected',
  vpn: false,
  proxy: false,
  tampering: false,
  identification: { visitor_id: 'Ibk1527CUFmcnjLwIs4A9', confidence: { score: 0.97, version: '1.1' } },
}

test('a Fingerprint event is confirmed with the v4 Server API', async () => {
  const { fetcher, calls } = fake((url) =>
    url.endsWith('/missing') ? { status: 404, body: { error: { code: 'event_not_found' } } } : { body: event },
  )
  const verify = createFingerprintVerifier({ secretKey: 'secret', region: 'eu', fetch: fetcher })

  const verified = await verify('1708102555327.NLOjmg')
  assert.equal(calls[0]!.url, 'https://eu.api.fpjs.io/v4/events/1708102555327.NLOjmg')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer secret')
  assert.deepEqual(verified, {
    visitorId: 'Ibk1527CUFmcnjLwIs4A9',
    eventId: '1708102555327.NLOjmg',
    confidence: 0.97,
    at: T0,
    ip: '203.0.113.9',
    incognito: false,
    bot: 'not_detected',
    vpn: false,
    proxy: false,
    tampering: false,
  })
  assert.equal(await verify('missing'), undefined)
  assert.equal(await verify('../etc/passwd'), undefined)
  assert.equal(calls.length, 2)

  const refused = createFingerprintVerifier({ secretKey: 'bad', fetch: fake(() => ({ status: 403, body: {} })).fetcher })
  await assert.rejects(refused('x'), /403/)
})

test('a fingerprint counts only when fresh, confident, and untampered', () => {
  const good = { ...(event as unknown as object), visitorId: 'v', eventId: 'e', confidence: 0.97, at: T0, ip: '203.0.113.9', incognito: false, bot: 'not_detected', vpn: false, proxy: false, tampering: false } as VerifiedFingerprint
  assert.equal(trusted(good, { now: T0 + 1000 }), true)
  assert.equal(trusted(good, { now: T0 + 6 * 60_000 }), false)
  assert.equal(trusted({ ...good, tampering: true }, { now: T0 }), false)
  assert.equal(trusted({ ...good, bot: 'bad' }, { now: T0 }), false)
  assert.equal(trusted({ ...good, confidence: 0.5 }, { now: T0 }), false)
  assert.equal(trusted(good, { now: T0, ip: '198.51.100.1' }), false)
})

test('this machine has a stable hardware id that differs per app', async () => {
  const raw = await machineId()
  assert.ok(raw.length >= 16)
  const first = await hardwareId('app-one')
  assert.match(first, /^hardware:[0-9a-f]{64}$/)
  assert.equal(await hardwareId('app-one'), first)
  assert.notEqual(await hardwareId('app-two'), first)
  assert.ok(!first.includes(raw))
  await assert.rejects(hardwareId(''), TypeError)
})

test('MaxMind classifies an address and the answer is cached', async () => {
  const answers: Record<string, { status?: number; body: unknown }> = {
    '203.0.113.1': { body: { country: { iso_code: 'US' }, traits: { autonomous_system_number: 7018, autonomous_system_organization: 'ISP', user_type: 'residential' } } },
    '203.0.113.2': { body: { country: { iso_code: 'US' }, traits: { user_type: 'cellular' } } },
    '203.0.113.3': { body: { anonymizer: { is_anonymous: true, is_anonymous_vpn: true }, traits: { user_type: 'hosting' } } },
    '203.0.113.4': { body: { traits: { is_hosting_provider: true } } },
    '10.0.0.1': { status: 400, body: { code: 'IP_ADDRESS_RESERVED', error: 'reserved' } },
    '203.0.113.5': { status: 401, body: { code: 'AUTHORIZATION_INVALID', error: 'bad key' } },
  }
  const { fetcher, calls } = fake((url) => answers[url.split('/').pop()!]!)
  const lookup = createMaxMindLookup({ accountId: 42, licenseKey: 'key', fetch: fetcher })

  const home = await lookup('203.0.113.1')
  assert.equal(calls[0]!.url, 'https://geoip.maxmind.com/geoip/v2.1/insights/203.0.113.1')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('42:key').toString('base64')}`)
  assert.deepEqual(home, { country: 'US', asn: 7018, organization: 'ISP', userType: 'residential', anonymous: false, hosting: false })
  assert.equal(shared(home), false)
  assert.equal(shared(await lookup('203.0.113.2')), true)
  assert.equal(shared(await lookup('203.0.113.3')), true)
  assert.equal(shared(await lookup('203.0.113.4')), true)
  assert.equal(await lookup('10.0.0.1'), undefined)
  assert.equal(shared(undefined), false)
  await assert.rejects(lookup('203.0.113.5'), /AUTHORIZATION_INVALID/)

  const before = calls.length
  await lookup('203.0.113.1')
  assert.equal(calls.length, before)

  const local = createDatabaseLookup({
    asn: { get: () => ({ autonomous_system_number: 16509, autonomous_system_organization: 'Cloud' }) },
    anonymous: { get: () => ({ is_hosting_provider: true }) },
  })
  assert.deepEqual(await local('203.0.113.9'), { country: undefined, asn: 16509, organization: 'Cloud', userType: undefined, anonymous: false, hosting: true })
})

test('a service account gets a signed token and reuses it until it expires', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = { client_email: 'robot@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
  let clock = 1_800_000_000_000
  let issued = 0
  const { fetcher, calls } = fake((url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token')
    const form = init.body as URLSearchParams
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')
    const [header, claims, signature] = form.get('assertion')!.split('.')
    assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature!, 'base64url'))
    assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
    assert.deepEqual(JSON.parse(Buffer.from(claims!, 'base64url').toString()), {
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/datamanager',
      aud: 'https://oauth2.googleapis.com/token',
      iat: clock / 1000,
      exp: clock / 1000 + 3600,
    })
    return { body: { access_token: `token-${++issued}`, expires_in: 3600, token_type: 'Bearer' } }
  })
  const token = createGoogleTokens(account, { fetch: fetcher, now: () => clock })

  assert.deepEqual(await Promise.all([token(), token()]), ['token-1', 'token-1'])
  clock += 3000 * 1000
  assert.equal(await token(), 'token-1')
  clock += 600 * 1000
  assert.equal(await token(), 'token-2')
  assert.equal(calls.length, 2)

  const refused = createGoogleTokens(account, { fetch: fake(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } })).fetcher })
  await assert.rejects(refused(), /invalid_grant/)
})

test('the server confirms fingerprints, drops bad bots, and mutes shared addresses', async () => {
  const graph = createGraph(createMemoryStore())
  const events: Record<string, VerifiedFingerprint> = {
    'ev-good': { visitorId: 'V1', eventId: 'ev-good', confidence: 0.99, at: T0, ip: undefined, incognito: false, bot: 'not_detected', vpn: false, proxy: false, tampering: false },
    'ev-bot': { visitorId: 'V2', eventId: 'ev-bot', confidence: 0.99, at: T0, ip: undefined, incognito: false, bot: 'bad', vpn: false, proxy: false, tampering: false },
    'ev-old': { visitorId: 'V3', eventId: 'ev-old', confidence: 0.99, at: T0 - 3_600_000, ip: undefined, incognito: false, bot: 'not_detected', vpn: false, proxy: false, tampering: false },
  }
  const handler = createHandler(graph, {
    token: 'secret',
    origins: ['https://site.example'],
    now: () => T0,
    fingerprint: async (id) => events[id],
    // Every visit in this test comes from the loopback address; call it a data center.
    ipInfo: async () => ({ country: 'US', asn: 1, organization: 'Cloud', userType: 'hosting', anonymous: false, hosting: true }),
  })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const visit = (body: object) =>
    fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example' }, body: JSON.stringify(body) })
  try {
    for (const body of [
      { device: 'a', fingerprintEvent: 'ev-good' },
      { device: 'b', fingerprintEvent: 'ev-good' },
      { device: 'bot', fingerprintEvent: 'ev-bot' },
      { device: 'c', fingerprintEvent: 'ev-old' },
      { device: 'd', fingerprintEvent: 'ev-unknown' },
      { device: 'e', fingerprint: 'V1' },
    ]) {
      assert.equal((await visit(body)).status, 204)
    }
    const kinds = async (subject: string) => (await graph.history(subject)).map((s) => s.identifier.split(':')[0]).sort()

    assert.deepEqual(await kinds('visitor:a'), ['device', 'fingerprint', 'ip'])
    assert.deepEqual(await kinds('visitor:bot'), [])
    assert.deepEqual(await kinds('visitor:c'), ['device', 'ip'])
    assert.deepEqual(await kinds('visitor:d'), ['device', 'ip'])
    // A page cannot claim a fingerprint by sending the visitor id itself.
    assert.deepEqual(await kinds('visitor:e'), ['device', 'ip'])

    // a and b share the confirmed fingerprint. Everyone shares the address, and it links nobody.
    assert.deepEqual((await graph.links('visitor:a')).map((l) => [l.subject, l.reasons.map((r) => r.identifier)]), [
      ['visitor:b', ['fingerprint:V1']],
    ])
    assert.deepEqual(await graph.links('visitor:c'), [])
  } finally {
    server.close()
  }
})

test('the server keeps the device id in its own cookie and honours an opt-out', async () => {
  const graph = createGraph(createMemoryStore())
  const handler = createHandler(graph, { token: 'secret', origins: ['https://site.example'], now: () => T0, cookie: { domain: 'site.example' } })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const visit = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example', ...headers }, body: JSON.stringify(body) })
  try {
    // First visit: the page's own id is adopted and set as a lasting, script-proof cookie.
    const first = await visit({ device: 'page-id-1', touch: { gclid: 'G1' } })
    const cookie = first.headers.get('set-cookie')!
    assert.equal(cookie, `ag_device=page-id-1; Max-Age=${400 * 86_400}; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=site.example`)
    assert.equal(first.headers.get('access-control-allow-credentials'), 'true')

    // Later the page has lost its id and made a new one. The cookie still names the same visitor, who now carries both ids.
    await visit({ device: 'page-id-2' }, { cookie: 'other=1; ag_device=page-id-1' })
    assert.deepEqual((await graph.history('visitor:page-id-1')).map((s) => s.identifier).filter((identifier) => identifier.startsWith('device:')), ['device:page-id-1', 'device:page-id-1', 'device:page-id-2'])
    assert.deepEqual(await graph.history('visitor:page-id-2'), [])

    // No id from the page and no cookie: the server makes one.
    const blank = await visit({})
    assert.match(blank.headers.get('set-cookie')!, /^ag_device=[0-9a-f-]{36}; /)

    // An opted-out browser is still seen, but its ad click and analytics id are not kept.
    await visit({ device: 'private-1', ga: '1.2', canvas: 'c9', touch: { gclid: 'G-PRIVATE' } }, { 'sec-gpc': '1' })
    assert.deepEqual((await graph.history('visitor:private-1')).map((s) => s.identifier.split(':')[0]).sort(), ['canvas', 'device', 'ip'])
    assert.equal((await graph.attribute('visitor:private-1', { at: T0 })).reason, 'no_touch')
    assert.deepEqual((await graph.consentOf(['visitor:private-1'])).get('visitor:private-1'), { adUserData: false, adPersonalization: false })
    assert.ok((await graph.consentHistory('visitor:private-1')).every((answer) => answer.source === 'browser signal'))

    // A banner answer is stored as given.
    await visit({ device: 'agreed-1', consent: { adUserData: true, adPersonalization: false }, touch: { gclid: 'G-OK' } })
    assert.deepEqual((await graph.consentOf(['visitor:agreed-1'])).get('visitor:agreed-1'), { adUserData: true, adPersonalization: false })
    assert.equal((await graph.attribute('visitor:agreed-1', { at: T0 })).credited!.gclid, 'G-OK')
  } finally {
    server.close()
  }
})

test('the reviewer screen is a locked-down shell, and its data needs the token', async () => {
  const graph = createGraph(createMemoryStore())
  await graph.observe([
    { subject: 'account:1', identifiers: ['hardware:h', 'email:e1'], at: T0, event: 'login' },
    { subject: 'account:2', identifiers: ['hardware:h'], at: T0 },
    { subject: 'account:3', identifiers: ['email:e1'], at: T0 },
    { subject: 'account:9', identifiers: ['email:e9'], at: T0 },
  ])
  await graph.transfer({ id: 't1', from: 'account:2', to: 'account:1', amount: 500, at: T0 })
  await graph.separate('account:1', 'account:9')
  const server = createServer(createHandler(graph, { token: 'secret', origins: [], now: () => T0 })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const auth = { authorization: 'Bearer secret' }
  try {
    const page = await fetch(`${base}/review`)
    const html = await page.text()
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type')!, /^text\/html/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    // The policy names the exact script and style the page ships, and nothing else may run or load.
    const policy = page.headers.get('content-security-policy')!
    for (const tag of ['script', 'style']) {
      const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)![1]!
      assert.ok(policy.includes(`${tag}-src 'sha256-${createHash('sha256').update(body).digest('base64')}'`), `${tag} hash`)
    }
    assert.match(policy, /^default-src 'none';/)
    assert.match(policy, /connect-src 'self'/)
    assert.match(policy, /form-action 'none'/)
    assert.equal(html.includes('\r'), false)
    // The one address outside is the project's own docs, which a card links to, and which nothing on the page loads.
    const outside = 'https://github.com/pwngh/account-graph/blob/main/docs/'
    assert.equal(html.split(outside).length, 2)
    assert.equal(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html.replace(outside, '')), false, 'the page loads nothing from outside')
    assert.equal(html.includes('innerHTML'), false)

    assert.equal((await fetch(`${base}/subject?subject=account:1`)).status, 401)
    const profile = (await (await fetch(`${base}/subject?subject=account:1`, { headers: auth })).json()) as any
    assert.equal(profile.known, true)
    assert.deepEqual(profile.cluster, { id: 'account:1', members: ['account:1', 'account:2', 'account:3'], oversized: false })
    assert.deepEqual(profile.links.map((link: any) => link.subject), ['account:3', 'account:2'])
    assert.deepEqual(profile.edges.map((tie: any) => `${tie.a}-${tie.b}`).sort(), ['account:1-account:2', 'account:1-account:3'])
    assert.deepEqual(profile.separated, ['account:9'])
    assert.equal(profile.flows[0].relation, 'same')
    assert.deepEqual(profile.rings, [])
    assert.equal(profile.history.length, 2)
    assert.deepEqual(await (await fetch(`${base}/subject?subject=nobody`, { headers: auth })).json(), { subject: 'nobody', known: false })
    assert.deepEqual(await (await fetch(`${base}/clusters`, { headers: auth })).json(), [{ id: 'account:1', size: 3, oversized: false }])

    // The page asks whether anything changed with one conditional request, and is told only when something has.
    const beat = async (tag?: string) => fetch(`${base}/pulse`, { headers: { ...auth, ...(tag && { 'if-none-match': tag }) } })
    const tag = (await beat()).headers.get('etag')!
    const still = await beat(tag)
    assert.deepEqual([still.status, await still.text()], [304, ''])
    assert.equal((await fetch(`${base}/pulse`)).status, 401)
    await graph.consent('account:1', { adUserData: true, adPersonalization: true })
    const changed = await beat(tag)
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.get('etag'), tag)
    // The scripts are put together from several files; together they must parse.
    assert.doesNotThrow(() => new Script(new RegExp('<script>([\\s\\S]*?)</script>').exec(html)![1]!))

    // A reviewer joins two accounts by hand; the decision is on the record.
    const joined = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ a: 'account:9', b: 'account:3', by: 'dana', reason: 'same caller' }) })
    // 1 and 9 are kept apart, and 3 is tied to 1 by an email. The reviewer's join outweighs the email, so 3 leaves 1 and goes with 9.
    assert.deepEqual(await joined.json(), [
      { subject: 'account:3', from: 'account:1', to: 'account:3' },
      { subject: 'account:9', from: 'account:9', to: 'account:3' },
    ])
    const bad = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ a: 1, b: 2 }) })
    assert.equal(bad.status, 400)
    const recorded = (await (await fetch(`${base}/decisions`, { headers: auth })).json()) as any
    assert.deepEqual(recorded.decisions.map((d: any) => [d.action, d.about, d.by]), [
      ['join', ['account:3', 'account:9'], 'dana'],
      ['separate', ['account:1', 'account:9'], undefined],
    ])
    assert.deepEqual([recorded.total, recorded.next], [2, null])
    const newest = (await (await fetch(`${base}/decisions?limit=1&author=people`, { headers: auth })).json()) as any
    assert.deepEqual([newest.decisions.length, newest.next], [1, 2])
    assert.equal(((await (await fetch(`${base}/decisions?limit=1&before=${newest.next}`, { headers: auth })).json()) as any).decisions[0].seq, 1)
    const kept = (await (await fetch(`${base}/subject?subject=account:1`, { headers: auth })).json()) as any
    assert.deepEqual(kept.verdicts.map((each: any) => [each.a, each.b, each.last.action, each.reversals]), [['account:1', 'account:9', 'separate', 0]])
    assert.deepEqual(await graph.separations('account:1'), ['account:9'])
    assert.deepEqual((await graph.cluster('account:9'))!.members, ['account:3', 'account:9'])
    assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1', 'account:2'])
  } finally {
    server.close()
  }
})

test('someone is found by phone or email without either being in an address', async () => {
  const graph = createGraph(createMemoryStore())
  await graph.observe([
    { subject: 'account:1', identifiers: [email('Pat.Doe+x@gmail.com'), phone('(713) 555-0194')], at: T0 },
    { subject: 'contact:2', identifiers: [phoneOfType('713-555-0194', 'nonFixedVoip')!], at: T0 },
    { subject: 'account:30', identifiers: ['device:d'], at: T0 },
  ])
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'dana' }, origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const find = async (text: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/find`, { method: 'POST', headers: { authorization: 'Bearer dana' }, body: JSON.stringify({ text }) })
    return response.ok ? ((await response.json()) as any) : response.status
  }
  try {
    for (const text of ['patdoe@gmail.com', ' PAT.DOE@googlemail.com ', 'Pat.Doe@gmail.com']) assert.deepEqual(await find(text), { by: 'email', subjects: text.includes('googlemail') ? [] : ['account:1'] }, text)
    for (const text of ['7135550194', '(713) 555-0194', '+1 713.555.0194', '1-713-555-0194']) assert.deepEqual(await find(text), { by: 'phone', subjects: ['account:1', 'contact:2'] }, text)
    assert.deepEqual(await find('nobody@example.com'), { by: 'email', subjects: [] })
    assert.deepEqual(await find('account:'), { by: 'subject', subjects: ['account:1', 'account:30'] })
    // An ad click id, whole. How an id begins comes first.
    for (const gclid of ['EAIaIQobChMI-x_Y', 'account:3']) await graph.touch({ subject: 'contact:2', at: T0, gclid })
    assert.deepEqual(await find('EAIaIQobChMI-x_Y'), { by: 'click', subjects: ['contact:2'] })
    assert.deepEqual([(await find('EAIaIQobChMI')).subjects, (await find('account:3')).subjects], [[], ['account:30']])
    // Digits that are not a whole number are how an id begins, and an id may hold an @.
    assert.deepEqual([(await find('713')).by, (await find('email:a@b')).by], ['subject', 'subject'])
    for (const wrong of ['', ' ', 5, null, 'x'.repeat(513)]) assert.equal(await find(wrong), 400)
  } finally {
    server.close()
  }
})

test('a decision is signed with the name its token belongs to, and one made on an outdated view is refused', async () => {
  const graph = createGraph(createMemoryStore())
  await graph.observe([1, 2, 3].map((n) => ({ subject: `account:${n}`, identifiers: ['email:e'], at: T0 })))
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: ['dana-new', 'dana-old'], lee: 'lee-token' }, origins: [], now: () => T0 })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = async (token: string, path: string, body?: object) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, ...(body && { body: JSON.stringify(body) }) })
    return { status: response.status, answer: (await response.json()) as any }
  }
  const last = async () => (await graph.decisionPage({ limit: 1 }))[0]!
  try {
    assert.deepEqual((await call('dana-new', '/me')).answer, { reviewer: 'dana', retraction: { targets: [], always: false }, targets: {}, limits: { returnHours: null, openHours: false } })
    assert.deepEqual((await call('service', '/me')).answer.reviewer, null)
    // With no ad platform that takes one, a retraction is refused before anything is deleted.
    assert.equal((await call('dana-new', '/forget', { subject: 'account:3', retract: true })).status, 400)
    assert.equal((await graph.cluster('account:3'))?.members.length, 3)
    for (const path of ['/me', '/nowhere']) {
      const { headers } = await fetch(base + path, { headers: { authorization: 'Bearer service' } })
      assert.deepEqual([headers.get('cache-control'), headers.get('x-content-type-options')], ['no-store', 'nosniff'])
    }
    assert.equal((await call('dana', '/me')).status, 401)

    // The name is the token's, whichever of hers she used, and cannot be another's.
    for (const token of ['dana-new', 'dana-old']) {
      assert.equal((await call(token, '/separate', { a: 'account:1', b: 'account:9', reason: 'brothers' })).status, 200)
      assert.deepEqual([(await last()).by, (await last()).reason], ['dana', 'brothers'])
    }
    for (const by of ['lee', 'system:cases', '', 7]) assert.equal((await call('dana-new', '/join', { a: 'account:1', b: 'account:8', by })).status, 400)
    assert.equal((await call('lee-token', '/ignore', { identifier: 'email:x', by: 'lee' })).status, 200)
    assert.equal((await last()).by, 'lee')
    assert.equal((await call('service', '/ignore', { identifier: 'email:y' })).status, 200)
    assert.equal((await last()).by, undefined)

    // Both look. Lee decides first, so what Dana decides about either of the same two is refused, and says why.
    const seen = (await call('dana-new', '/audit')).answer.head.seq
    assert.equal((await call('lee-token', '/separate', { a: 'account:2', b: 'account:1', reason: 'father and son', seen })).status, 200)
    const count = (await graph.decisions()).length
    for (const [path, body] of [['/join', { a: 'account:1', b: 'account:2' }], ['/separate', { a: 'account:1', b: 'account:3' }], ['/forget', { subject: 'account:2' }]] as const) {
      const refused = await call('dana-new', path, { ...body, seen })
      assert.equal(refused.status, 409, path)
      assert.deepEqual([refused.answer.decision.by, refused.answer.decision.reason, refused.answer.decision.about], ['lee', 'father and son', ['account:1', 'account:2']])
    }
    assert.equal((await graph.decisions()).length, count)
    // What it was not about is not refused, nor is someone who does not say what they saw, nor a list from a system.
    assert.equal((await call('dana-new', '/join', { a: 'account:3', b: 'account:4', seen })).status, 200)
    assert.equal((await call('dana-new', '/separate', { a: 'account:1', b: 'account:2', separated: false })).status, 200)
    assert.equal((await call('service', '/separate', { source: 'cases', pairs: [{ a: 'account:1', b: 'account:2' }], seen: 0 })).status, 200)
    // Having looked again, she may.
    assert.equal((await call('dana-new', '/forget', { subject: 'account:2', seen: (await last()).seq })).status, 200)
    for (const wrong of [-1, 1.5, 'x', null]) assert.equal((await call('dana-new', '/join', { a: 'account:5', b: 'account:6', seen: wrong })).status, 400)
    assert.throws(() => createHandler(graph, { token: 'same', reviewers: { dana: 'same' }, origins: [] }), TypeError)
    assert.throws(() => createHandler(graph, { token: 'x', reviewers: { dana: 'y', lee: 'y' }, origins: [] }), TypeError)
  } finally {
    server.close()
  }
})

test('a reviewer\'s token opens the review routes and nothing a service writes through', async () => {
  const graph = createGraph(createMemoryStore())
  await graph.observe([
    { subject: 'account:1', identifiers: ['email:e'], at: T0 },
    { subject: 'account:2', identifiers: ['email:e'], at: T0 },
  ])
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: [], now: () => T0 })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (token: string, method: string, path: string, body?: object) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body && { body: JSON.stringify(body) }) }).then((r) => r.status)
  try {
    assert.equal(await call('reviewer', 'GET', '/changes'), 403)
    const page = async (query: string) => (await fetch(`${base}/changes${query}`, { headers: { authorization: 'Bearer service' } })).json()
    const { changes, ...rest } = await page('')
    assert.deepEqual([changes.map(({ at: _, ...change }: { at: number }) => change), rest], [[{ seq: 1, subject: 'account:2', from: 'account:2', to: 'account:1' }], { next: 1, more: false }])
    assert.deepEqual(await page('?after=1'), { changes: [], next: 1, more: false })
    for (const query of ['?after=x', '?after=now', '?after=-1', '?after=', '?limit=0']) assert.equal(await call('service', 'GET', `/changes${query}`), 400, query)
    for (const path of ['/subject?subject=account:1', '/clusters', '/clusters?offset=50', '/search?q=account', '/recent', '/links?subject=account:1', '/flows?subject=account:1', '/decisions', '/decisions?author=system&limit=5', '/disputes', '/consent?subject=account:1', '/policy', '/pulse', '/audit']) {
      assert.equal(await call('reviewer', 'GET', path), 200, path)
    }
    assert.equal(await call('reviewer', 'POST', '/separate', { a: 'account:1', b: 'account:2', by: 'dana' }), 200)
    assert.equal(await call('reviewer', 'POST', '/join', { a: 'account:1', b: 'account:3' }), 200)
    assert.equal(await call('reviewer', 'POST', '/ignore', { identifier: 'email:e' }), 200)

    // Only a service speaks for a system, and it says which.
    const pairs = [{ a: 'account:1', b: 'account:7', reason: 'sides of one matter' }]
    for (const path of ['/separate', '/join']) {
      assert.equal(await call('reviewer', 'POST', path, { source: 'cases', pairs }), 403)
      assert.equal(await call('reviewer', 'POST', path, { a: 'account:1', b: 'account:8', by: 'system:cases' }), 400)
      assert.equal(await call('service', 'POST', path, { pairs }), 400)
      assert.equal(await call('service', 'POST', path, { source: 'cases', pairs: Array(1001).fill(pairs[0]) }), 400)
      assert.equal(await call('service', 'POST', path, { source: 'cases', pairs: [null] }), 400)
    }
    assert.equal(await call('service', 'POST', '/separate', { source: 'cases', pairs: [{ ...pairs[0], separated: 'no' }] }), 400)
    assert.equal(await call('service', 'POST', '/separate', { source: 'cases', pairs }), 200)
    assert.equal(await call('service', 'POST', '/join', { source: 'crm', pairs: [{ a: 'account:5', b: 'account:6' }] }), 200)
    assert.deepEqual((await graph.decisionPage({ limit: 2 })).map((d) => [d.action, d.by, d.reason]), [['join', 'system:crm', undefined], ['separate', 'system:cases', 'sides of one matter']])

    const before = await graph.history('account:1')
    assert.equal(await call('reviewer', 'POST', '/observe', { subject: 'account:1', identifiers: ['email:x'], at: T0 }), 403)
    assert.equal(await call('reviewer', 'POST', '/transfer', { id: 't1', from: 'account:1', to: 'account:2', amount: 5, at: T0 }), 403)
    assert.equal(await call('reviewer', 'POST', '/touch', { subject: 'account:1', at: T0, gclid: 'G' }), 403)
    assert.equal(await call('reviewer', 'POST', '/consent', { subject: 'account:1', consent: { adUserData: true, adPersonalization: true } }), 403)
    assert.equal(await call('reviewer', 'POST', '/convert', {}), 403)
    assert.equal(await call('reviewer', 'GET', '/verify'), 403)
    assert.deepEqual(await graph.history('account:1'), before)

    assert.equal(await call('service', 'POST', '/consent', { subject: 'account:1', consent: { adUserData: true, adPersonalization: true }, at: T0 - 5, source: 'import' }), 204)
    assert.equal(await call('service', 'POST', '/consent', { subject: 'account:1', consent: { adUserData: true, adPersonalization: true }, at: 'noon' }), 400)
    assert.deepEqual((await graph.consentHistory('account:1')).map((answer) => [answer.at, answer.source]), [[T0 - 5, 'import']])
    assert.equal(await call('service', 'POST', '/observe', { subject: 'account:1', identifiers: ['email:x'], at: T0 }), 200)
    assert.equal(await call('service', 'GET', '/clusters'), 200)
    assert.equal(await call('wrong', 'GET', '/clusters'), 401)
    assert.equal(await call('', 'GET', '/clusters'), 401)
    assert.throws(() => createHandler(graph, { token: 'same', reviewers: { dana: 'same' }, origins: [] }), TypeError)
  } finally {
    server.close()
  }
})

test('staff visits are dropped and counted, and no browser can make itself staff', async () => {
  const graph = createGraph(createMemoryStore())
  const clock = { now: T0 }
  const secret = 'a-link-secret-for-tests'
  const start = async (more: object) => {
    const server = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'], events: ['inquiry'], trustProxy: true, now: () => clock.now, ...more })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const page = async (device: string, address: string, body: object = {}, path = '/collect') =>
      assert.equal((await fetch(`${base}${path}`, { method: 'POST', headers: { origin: 'https://site.example', 'x-forwarded-for': address }, body: JSON.stringify({ device, event: 'inquiry', ...body }) })).status, 204)
    const ask = (path: string, body?: object) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer service' }, ...(body && { body: JSON.stringify(body) }) })
    return { server, page, ask, stats: async () => (await (await ask('/stats')).json()) as any }
  }
  const { server, page, ask, stats } = await start({ staffNetworks: ['192.0.2.10', '198.51.100.0/24', '2001:db8::/32'], linkSecret: secret })
  try {
    // Their networks, however the address is written; the address next door is a visitor.
    for (const address of ['192.0.2.10', '198.51.100.77', '::ffff:198.51.100.78', '2001:db8:1::5']) {
      await page('desk', address)
      await page('desk', address, {}, '/event')
    }
    await page('client', '192.0.2.11')
    // An event the server does not take is refused as ever, and counted as nothing.
    const untaken = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/event`, { method: 'POST', headers: { origin: 'https://site.example', 'x-forwarded-for': '192.0.2.10' }, body: JSON.stringify({ device: 'desk', event: 'nap' }) })
    assert.equal(untaken.status, 400)
    // A browser marked by a staff link, from anywhere.
    const { url } = (await (await ask('/staff-link', { url: 'https://site.example/team', days: 10 })).json()) as any
    const mark = new URL(url).searchParams.get('ag_staff')!
    await page('laptop', '203.0.113.5', { staff: mark })
    await page('laptop', '203.0.113.5', { staff: mark }, '/event')
    assert.equal(await graph.cluster('visitor:laptop'), undefined)
    assert.equal(await graph.cluster('visitor:desk'), undefined)
    assert.deepEqual([(await stats()).staff, (await stats()).collected], [10, 1])

    // A claim nobody signed, one signed for something else, and one past its time are all visitors.
    const known = new URL(knownLink('https://site.example/', 'contact:1', { secret, now: () => clock.now })).searchParams.get('ag')!
    const forged = new URL(staffLink('https://site.example/', { secret: 'another-secret-entirely', now: () => clock.now })).searchParams.get('ag_staff')!
    for (const [n, staff] of [true, 'staff', known, forged, `${mark}x`, mark.replace('.', '..')].entries()) await page(`claims-${n}`, '203.0.113.6', { staff })
    clock.now += 11 * 24 * 3_600_000
    await page('laptop', '203.0.113.5', { staff: mark })
    assert.deepEqual([(await stats()).staff, (await stats()).collected], [10, 8])
    assert.equal((await ask('/staff-link', { url: 'https://site.example/', days: 400 })).status, 400)
    // The mark is kept in a cookie browsers only take over HTTPS.
    assert.equal((await ask('/staff-link', { url: 'http://site.example/' })).status, 400)
    assert.equal((await ask('/staff-link', { url: 'http://localhost:3000/' })).status, 200)
  } finally {
    server.close()
  }
  // Off until set: no network is staff, no link can be made, and a mark means nothing.
  const off = await start({})
  try {
    await off.page('office', '192.0.2.10', { staff: 'x' })
    assert.deepEqual([(await off.stats()).staff, (await off.stats()).collected], [0, 1])
    assert.equal((await off.ask('/staff-link', { url: 'https://site.example/' })).status, 404)
  } finally {
    off.server.close()
  }
  assert.throws(() => createHandler(graph, { token: 'x', origins: [], staffNetworks: ['198.51.100.0/33'] }), TypeError)
})

test('what cannot be kept is refused, and nothing else answers 500', async () => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'], now: () => T0, linkSecret: 'x'.repeat(32) })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { authorization: 'Bearer service' }
  const post = async (path: string, body: string | Uint8Array<ArrayBuffer>) => (await fetch(base + path, { method: 'POST', headers, body })).status
  const get = async (path: string) => (await fetch(base + path, { headers })).status
  const seen = (subject: string, more = '') => `{"subject":"${subject}","identifiers":["device:d"],"at":${T0}${more}}`
  try {
    for (const bad of ['\\u0000', '\\ud800', '\\udfff', '\\udc00\\ud800']) {
      assert.equal(await post('/observe', seen(`account:${bad}`)), 400)
      assert.equal(await post('/observe', seen('account:1', `,"event":"${bad}"`)), 400)
      assert.equal(await post('/touch', `{"subject":"account:1","at":${T0},"gclid":"${bad}"}`), 400)
      assert.equal(await post('/separate', `{"source":"crm","pairs":[{"a":"account:1","b":"account:${bad}"}]}`), 400)
      assert.equal(await post('/rebuild', `{"reason":"${bad}"}`), 400)
      assert.equal(await post('/touch', `{"subject":"account:1","at":${T0},"${bad}":1}`), 400)
    }
    assert.equal(await post('/observe', new Uint8Array([...Buffer.from(seen('account:'))].flatMap((byte, i) => (i === 20 ? [0xff, byte] : [byte])))), 400)
    for (const path of ['/search?q=%00', '/subject?subject=a%00', '/history?subject=%00', '/decisions?author=%00', '/call?id=%00', '/attribute?subject=account:1&at=x', '/attribute?subject=account:1&at=1.5']) assert.equal(await get(path), 400, path)
    for (const path of ['/clusters?offset=1.5', '/clusters?offset=1e308', '/clusters?offset=-1']) assert.equal(await get(path), 200, path)
    for (const at of ['1.5', '1e308', '"x"', 'null']) assert.equal(await post('/observe', `{"subject":"account:1","identifiers":["device:d"],"at":${at}}`), 400)
    assert.equal(await post('/ignore', '{"identifier":"device:d","ignored":"yes"}'), 400)
    assert.deepEqual([(await graph.counts()).subjects, await graph.decisions()], [0, []])

    // A whole character written as two escapes is text like any other, and so is a backslash before a u.
    assert.equal(await post('/observe', seen('account:\\ud83d\\ude00')), 200)
    assert.equal(await post('/observe', seen('account:\\\\u0000')), 200)
    // Nested as deep as a body may be, and deeper than the stack.
    const nested = (levels: number) => seen('account:1', `,"x":${'['.repeat(levels)}${']'.repeat(levels)}`)
    assert.deepEqual([await post('/observe', nested(31)), await post('/observe', nested(32)), await post('/observe', nested(20_000))], [200, 400, 400])
    assert.equal(((await (await fetch(`${base}/stats`, { headers })).json()) as any).errors, 0)
  } finally {
    server.close()
  }
})

test('how the server runs is read by a reviewer, and a test alert is sent by a service', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store, undefined, { now: () => T0 })
  const posted: string[] = []
  const ops = createOps(graph, store.ops, { url: 'https://hooks.example/x', quiet: { touches: 5 }, now: () => T0, fetch: (async (_url: string, init: { body: string }) => (posted.push(init.body), new Response('ok'))) as unknown as typeof fetch })
  const start = async (more: object) => {
    const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'review' }, origins: [], now: () => T0, ...more })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const ask = (method: string, path: string, token: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method, headers: { authorization: `Bearer ${token}` } })
    return { server, ask }
  }
  const { server, ask } = await start({ ops })
  try {
    const state = (await (await ask('GET', '/ops', 'review')).json()) as any
    assert.deepEqual([state.feeds.length, state.jobs, state.undelivered, state.alerts, state.outbox, state.paused, state.at], [4, [], [], true, null, null, T0])
    assert.equal((await ask('POST', '/alerts/test', 'review')).status, 403)
    assert.deepEqual(await (await ask('POST', '/alerts/test', 'service')).json(), { delivered: true })
    assert.deepEqual(posted.map((body) => JSON.parse(body).text), ['account-graph: test alert.'])
  } finally {
    server.close()
  }
  // A stop on sends is read with the rest.
  const stopped = await start({ ops, sendsPaused: async () => ({ at: T0 - 60_000, reason: 'checking a wrong tie' }) })
  try {
    assert.deepEqual(((await (await stopped.ask('GET', '/ops', 'review')).json()) as any).paused, { at: T0 - 60_000, reason: 'checking a wrong tie' })
  } finally {
    stopped.server.close()
  }
  const bare = await start({})
  try {
    assert.deepEqual([(await bare.ask('GET', '/ops', 'review')).status, (await bare.ask('POST', '/alerts/test', 'service')).status], [404, 404])
  } finally {
    bare.server.close()
  }
})

test('one address cannot flood collect, and health and stats answer', async () => {
  const graph = createGraph(createMemoryStore())
  const clock = { now: T0 }
  const handler = createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: ['https://site.example'], now: () => clock.now, limit: { perMinute: 60, burst: 2 } })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const visit = (device: string) => fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example' }, body: JSON.stringify({ device }) })
  try {
    assert.equal((await visit('a')).status, 204)
    assert.equal((await visit('b')).status, 204)
    const refused = await visit('c')
    assert.equal(refused.status, 429)
    assert.equal(refused.headers.get('retry-after'), '1')
    assert.deepEqual(await graph.history('visitor:c'), [])
    // One a second comes back.
    clock.now += 1000
    assert.equal((await visit('c')).status, 204)
    assert.equal((await visit('d')).status, 429)

    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true })
    assert.equal((await fetch(`${base}/stats`)).status, 401)
    assert.equal((await fetch(`${base}/stats`, { headers: { authorization: 'Bearer reviewer' } })).status, 403)
    const stats = (await (await fetch(`${base}/stats`, { headers: { authorization: 'Bearer service' } })).json()) as any
    assert.deepEqual([stats.collected, stats.limited, stats.errors, stats.since], [3, 2, 0, T0])
    assert.equal(stats.graph.subjects, 3)
  } finally {
    server.close()
  }
})

test('the script tag is served as plain JavaScript that runs itself', async () => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const script = await fetch(`${base}/collect.js`)
    const body = await script.text()
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type')!, /^text\/javascript/)
    // Any site may load it, as a module, from another origin.
    assert.equal(script.headers.get('access-control-allow-origin'), '*')
    assert.match(body, /export async function collect\(options\s*\)/)
    assert.match(body, /new URL\('collect', self\)/)
    assert.match(body, /globalThis\.accountGraph = \{ event:/)
    assert.match(body, /export function watch\(options\s*\)/)
    // No TypeScript is left for a browser to choke on.
    assert.equal(/\binterface\b|: string|: Promise<| as const/.test(body), false)
    const helpers = await (await fetch(`${base}/fingerprint.js`)).text()
    const vendor = await import('data:text/javascript;base64,' + Buffer.from(helpers).toString('base64'))
    assert.equal(await vendor.fingerprintEvent({ apiKey: 'test' }, () => false), undefined)
    assert.equal(await vendor.openFingerprint(() => false), undefined)
  } finally {
    server.close()
  }
})

test('a Microsoft refresh token is exchanged, rotated, and reused until it expires', async () => {
  let clock = 1_800_000_000_000
  const sent: URLSearchParams[] = []
  const { fetcher } = fake((url, init) => {
    assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token')
    const form = init.body as URLSearchParams
    sent.push(form)
    return { body: { access_token: `access-${sent.length}`, refresh_token: `refresh-${sent.length}`, expires_in: 3600 } }
  })
  const token = createMicrosoftTokens({ clientId: 'app', refreshToken: 'refresh-0', fetch: fetcher, now: () => clock })
  assert.deepEqual(await Promise.all([token(), token()]), ['access-1', 'access-1'])
  assert.deepEqual(Object.fromEntries(sent[0]!), { client_id: 'app', grant_type: 'refresh_token', refresh_token: 'refresh-0', scope: 'https://ads.microsoft.com/msads.manage offline_access' })
  clock += 3600 * 1000
  assert.equal(await token(), 'access-2')
  // Microsoft handed back a newer refresh token, and that is the one used next.
  assert.equal(sent[1]!.get('refresh_token'), 'refresh-1')
  const refused = createMicrosoftTokens({ clientId: 'app', refreshToken: 'bad', clientSecret: 's', fetch: fake(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70000: bad token.\nTrace ID: x' } })).fetcher })
  await assert.rejects(refused(), /400 invalid_grant: AADSTS70000: bad token\.$/)
})

test('daily campaign cost is read from the Google Ads API', async () => {
  const { fetcher, calls } = fake((_url, init) =>
    String(init.body).includes('2026-03-09')
      ? { status: 403, body: [{ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED', details: [{ errors: [{ message: 'The developer token is not approved.' }], requestId: 'req-7' }] } }] }
      : {
          body: [
            { results: [{ campaign: { id: '111', name: 'Spring sale' }, segments: { date: '2026-03-01' }, metrics: { costMicros: '40100000', clicks: '30', impressions: '900' }, customer: { currencyCode: 'USD' } }] },
            { results: [{ campaign: { id: '222', name: 'Brand' }, segments: { date: '2026-03-02' }, metrics: { costMicros: '5000000', clicks: '2', impressions: '40' }, customer: { currencyCode: 'USD' } }] },
          ],
        },
  )
  const read = googleCosts({ customerId: '123-456-7890', loginCustomerId: '999-000-1111', developerToken: 'dev', accessToken: async () => 'token', fetch: fetcher })
  assert.deepEqual(await read('2026-03-01', '2026-03-02'), [
    { day: '2026-03-01', source: 'google', campaignId: '111', campaign: 'Spring sale', amount: 40.1, currency: 'USD', clicks: 30, impressions: 900 },
    { day: '2026-03-02', source: 'google', campaignId: '222', campaign: 'Brand', amount: 5, currency: 'USD', clicks: 2, impressions: 40 },
  ])
  assert.equal(calls[0]!.url, 'https://googleads.googleapis.com/v26/customers/1234567890/googleAds:searchStream')
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.deepEqual([headers.authorization, headers['developer-token'], headers['login-customer-id']], ['Bearer token', 'dev', '9990001111'])
  assert.match(JSON.parse(String(calls[0]!.init.body)).query, /FROM campaign WHERE segments\.date BETWEEN '2026-03-01' AND '2026-03-02'/)

  await assert.rejects(read('2026-03-09', '2026-03-09'), (error: CostError) => error.status === 403 && error.requestId === 'req-7' && /developer token is not approved/.test(error.message))
  await assert.rejects(read("2026-03-01' OR 1=1", '2026-03-02'), TypeError)
})

test('daily campaign spend is read from Meta, page after page', async () => {
  const { fetcher, calls } = fake((url) => {
    if (url.includes('act_13')) return { status: 400, body: { error: { message: 'Invalid OAuth access token.', code: 190, fbtrace_id: 'trace-1' } } }
    return url.includes('after=next')
      ? { body: { data: [{ campaign_id: '778', campaign_name: 'Lookalike', spend: '3', clicks: '1', impressions: '50', account_currency: 'USD', date_start: '2026-03-02', date_stop: '2026-03-02' }], paging: { cursors: { after: 'end' } } } }
      : { body: { data: [{ campaign_id: '777', campaign_name: 'Retarget', spend: '15.25', clicks: '9', impressions: '300', account_currency: 'USD', date_start: '2026-03-01', date_stop: '2026-03-01' }], paging: { next: 'https://graph.facebook.com/v27.0/act_12/insights?after=next' } } }
  })
  const read = metaCosts({ adAccountId: 'act_12', accessToken: 'token', fetch: fetcher })
  assert.deepEqual(await read('2026-03-01', '2026-03-02'), [
    { day: '2026-03-01', source: 'meta', campaignId: '777', campaign: 'Retarget', amount: 15.25, currency: 'USD', clicks: 9, impressions: 300 },
    { day: '2026-03-02', source: 'meta', campaignId: '778', campaign: 'Lookalike', amount: 3, currency: 'USD', clicks: 1, impressions: 50 },
  ])
  const first = new URL(calls[0]!.url)
  assert.equal(first.origin + first.pathname, 'https://graph.facebook.com/v27.0/act_12/insights')
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    level: 'campaign',
    fields: 'campaign_id,campaign_name,spend,clicks,impressions,account_currency',
    time_range: '{"since":"2026-03-01","until":"2026-03-02"}',
    time_increment: '1',
    limit: '500',
  })
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer token')
  assert.equal(calls.length, 2)

  await assert.rejects(metaCosts({ adAccountId: '13', accessToken: 'bad', fetch: fetcher })('2026-03-01', '2026-03-02'), (error: CostError) => error.status === 400 && error.requestId === 'trace-1' && /Invalid OAuth/.test(error.message))
})

test('what a platform says it brought is read only when it is asked for', async () => {
  const google = fake(() => ({ body: [{ results: [
    { campaign: { id: '111', name: 'Spring' }, segments: { date: '2026-03-01' }, metrics: { costMicros: '1000000', clicks: '1', impressions: '9', conversions: 1.5, conversionsValue: 60.25 }, customer: { currencyCode: 'USD' } },
    { campaign: { id: '222', name: 'Brand' }, segments: { date: '2026-03-01' }, metrics: { costMicros: '1000000', clicks: '1', impressions: '9' } },
  ] }] }))
  const account = { customerId: '1', developerToken: 'dev', accessToken: async () => 'token', fetch: google.fetcher }
  assert.deepEqual((await googleCosts({ ...account, conversions: true })('2026-03-01', '2026-03-01')).map((row) => [row.conversions, row.conversionValue]), [[1.5, 60.25], [0, 0]])
  assert.equal('conversions' in (await googleCosts(account)('2026-03-01', '2026-03-01'))[0]!, false)
  assert.deepEqual(google.calls.map((call) => JSON.parse(String(call.init.body)).query.includes('metrics.conversions, metrics.conversions_value, customer.currency_code')), [true, false])

  const row = { campaign_id: '777', campaign_name: 'Retarget', spend: '15', clicks: '9', impressions: '300', date_start: '2026-03-01' }
  const meta = fake(() => ({ body: { data: [
    { ...row, actions: [{ action_type: 'link_click', value: '9' }, { action_type: 'lead', value: '3' }], action_values: [{ action_type: 'lead', value: '15.5' }] },
    { ...row, campaign_id: '778', actions: [{ action_type: 'link_click', value: '9' }] },
    { ...row, campaign_id: '779' },
    { ...row, campaign_id: '780', actions: [{ action_type: 'lead', value: '4' }], action_values: [{ action_type: 'other', value: '1' }] },
    { ...row, campaign_id: '781', actions: [{ action_type: 'lead', value: '4' }], action_values: [{ action_type: 'lead', value: '0' }] },
    { ...row, campaign_id: '782', actions: [{ action_type: 'lead', value: null }], action_values: [{ action_type: 'lead', value: '9' }] },
    { ...row, campaign_id: '783', actions: [{ action_type: 'lead', value: '4' }], action_values: [{ action_type: 'lead', value: null }] },
  ] } }))
  const ads = { adAccountId: '12', accessToken: 'token', fetch: meta.fetcher }
  assert.deepEqual((await metaCosts({ ...ads, conversions: 'lead' })('2026-03-01', '2026-03-01')).map((each) => [each.conversions, each.conversionValue]), [[3, 15.5], [0, undefined], [0, undefined], [4, undefined], [4, 0], [undefined, undefined], [4, undefined]])
  assert.equal('conversions' in (await metaCosts(ads)('2026-03-01', '2026-03-01'))[0]!, false)
  assert.deepEqual(meta.calls.map((call) => new URL(call.url).searchParams.get('fields')!.endsWith(',account_currency,actions,action_values')), [true, false])

  const env = { DATABASE_URL: 'x', IDENTIFIER_SECRET: 'i'.repeat(32), RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'y', GOOGLE_ADS_DEVELOPER_TOKEN: 'd', GOOGLE_ADS_CUSTOMER_ID: '1', GOOGLE_SERVICE_ACCOUNT_FILE: 'f', META_AD_ACCOUNT_ID: '2', META_ADS_TOKEN: 't' }
  assert.deepEqual([configFrom(env).googleCosts!.conversions, configFrom(env).metaCosts!.conversions], [false, undefined])
  const asked = configFrom({ ...env, GOOGLE_ADS_CONVERSIONS: 'true', META_ADS_CONVERSIONS: 'lead' })
  assert.deepEqual([asked.googleCosts!.conversions, asked.metaCosts!.conversions], [true, 'lead'])
})

test('a spreadsheet of costs is read from CSV', () => {
  const csv = 'Day,Source,Campaign ID,Campaign,Amount,Currency,Clicks,Impressions,Conversions,Conversion value\r\n2026-03-01,microsoft,55,"Spring, ""big"" sale","$1,250.50",USD,40,"2,000",2.5,"$1,000"\n\n2026-03-02,mailer,,,300,,,,,\n'
  assert.deepEqual(costsFromCsv(csv), [
    { day: '2026-03-01', source: 'microsoft', amount: 1250.5, campaignId: '55', campaign: 'Spring, "big" sale', currency: 'USD', clicks: 40, impressions: 2000, conversions: 2.5, conversionValue: 1000 },
    { day: '2026-03-02', source: 'mailer', amount: 300 },
  ])
  assert.throws(() => costsFromCsv('day,source\n2026-03-01,x'), /"amount" column/)
  assert.throws(() => costsFromCsv('day,source,amount\n2026-03-01,x,'), /Line 2/)
})

test('a Twilio request is checked against its signature and read as a call', () => {
  // The example from Twilio's webhook security page.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
  const fields = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }
  assert.equal(twilioSignature('12345', url, fields), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')
  assert.equal(fromTwilio('12345', url, fields, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), true)
  assert.equal(fromTwilio('12345', url, { ...fields, From: '+10000000000' }, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false)
  assert.equal(fromTwilio('wrong', url, fields, '0/KCTR6DLpKmkAf8muzZqo1nDgQ='), false)
  assert.equal(fromTwilio('12345', url, fields, undefined), false)

  const ended = { CallSid: 'CA9', From: '+15558675309', To: '+15551230001', CallStatus: 'completed', CallDuration: '95', Direction: 'inbound', Timestamp: 'Fri, 20 Aug 2010 01:13:42 +0000' }
  assert.deepEqual(twilioCall(ended, 0), { id: 'CA9', from: '+15558675309', to: '+15551230001', at: Date.parse('2010-08-20T01:13:42Z') - 95_000, duration: 95 })
  // Nobody answered: recorded as a call of no length. Still ringing, or placed by the account: not a call to record.
  assert.deepEqual(twilioCall({ ...ended, CallStatus: 'no-answer', Timestamp: '' }, 5000), { id: 'CA9', from: '+15558675309', to: '+15551230001', at: 5000, duration: 0, answered: false })
  // What Twilio says of the caller comes along where it says it: the name on the caller ID, and the city and state of the number.
  assert.deepEqual(twilioCall({ ...ended, CallerName: 'WIRELESS CALLER', FromCity: 'SPRINGFIELD', FromState: 'IL' }, 0)?.caller, { name: 'WIRELESS CALLER', place: 'SPRINGFIELD, IL' })
  assert.deepEqual(twilioCall({ ...ended, FromState: 'IL' }, 0)?.caller, { place: 'IL' })
  assert.equal(twilioCall({ ...ended, CallStatus: 'ringing' }, 0), undefined)
  // A recording status callback is of the recording, and says nothing of how the call went.
  assert.deepEqual(twilioRecording({ CallSid: 'CA9', RecordingSid: 'RE1', RecordingStatus: 'completed', RecordingUrl: 'https://api.twilio.com/x', Timestamp: 'Fri, 20 Aug 2010 01:13:42 +0000' }, 0), { call: 'CA9', id: 'RE1', state: 'completed', at: Date.parse('2010-08-20T01:13:42Z') })
  assert.deepEqual([twilioRecording({ CallSid: 'CA9', RecordingSid: 'RE1', RecordingStatus: 'in-progress' }, 7)?.state, twilioRecording(ended, 0), twilioRecording({ CallSid: 'CA9', RecordingSid: 'RE1', RecordingStatus: 'odd' }, 0)], ['in_progress', undefined, undefined])
  assert.equal(twilioCall({ ...ended, Direction: 'outbound-api' }, 0), undefined)
})

test('the server takes page events and phone calls, and ties a call to the visitor who tapped', async () => {
  const graph = createGraph(createMemoryStore())
  let clock = Date.parse('2026-03-02T12:00:00Z')
  const twilio = { authToken: 'twilio-secret', url: 'https://graph.example.org/calls/twilio' }
  const handler = createHandler(graph, {
    token: 'service',
    reviewers: { dana: 'reviewer' },
    origins: ['https://site.example'],
    now: () => clock,
    events: ['inquiry', 'phone_click'],
    calls: { numbers: { '+15551230001': { source: 'google', campaignId: '111' } }, twilio },
  })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const page = (path: string, body: object, origin = 'https://site.example') => fetch(`${base}${path}`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) }).then((r) => r.status)
  const post = (path: string, body: object, token = 'service') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const callback = (fields: Record<string, string>, signature = twilioSignature(twilio.authToken, twilio.url, fields)) =>
    fetch(`${base}/calls/twilio`, { method: 'POST', headers: { 'x-twilio-signature': signature, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }).then((r) => r.status)
  try {
    assert.equal(await page('/collect', { device: 'd-1', touch: { gclid: 'G1', campaignId: '111' } }), 204)
    // An event the server was told to accept is counted; one it was not is refused, and so is another site.
    assert.equal(await page('/event', { device: 'd-1', event: 'inquiry' }), 204)
    assert.equal(await page('/event', { device: 'd-1', event: 'inquiry' }), 204)
    assert.equal(await page('/event', { device: 'd-1', event: 'inquiry', id: 'form-7' }), 204)
    assert.equal(await page('/event', { device: 'd-1', event: 'purchase' }), 400)
    assert.equal(await page('/event', { event: 'inquiry' }), 400)
    assert.equal(await page('/event', { device: 'd-1', event: 'inquiry' }, 'https://evil.example'), 403)

    // The visitor taps the number, and Twilio reports the call that followed.
    assert.equal(await page('/event', { device: 'd-1', event: 'phone_click', number: '+1 (555) 123-0001' }), 204)
    clock += 15_000
    const fields = { CallSid: 'CA100', From: '+15558675309', To: '+15551230001', CallStatus: 'completed', CallDuration: '120', Direction: 'inbound', Timestamp: new Date(clock + 120_000).toUTCString() }
    assert.equal(await callback(fields, 'forged'), 403)
    assert.equal(await callback({ ...fields, CallStatus: 'ringing' }), 204)
    assert.equal(await callback(fields), 204)
    assert.equal(await callback(fields), 204)
    const caller = `caller:${hashPhone('+15558675309')}`
    assert.deepEqual((await graph.cluster('visitor:d-1'))!.members, [caller, 'visitor:d-1'].sort())

    // Any other provider posts the same facts with the service token.
    const other = (await (await post('/call', { id: 'X-1', from: '+15550001111', to: '555-123-0001', at: clock + 3_600_000, duration: 10 })).json()) as any
    assert.deepEqual([other.flags, other.counted], [['short'], false])
    assert.equal((await post('/call', { id: 'X-2', to: '+15551230001', at: clock }, 'reviewer')).status, 403)
    assert.equal((await post('/call', { to: '+15551230001', at: clock })).status, 400)

    // A number that is not one of the tracking numbers is not noted, and neither is a number on any other event.
    await page('/event', { device: 'd-5', event: 'phone_click', number: '+15559998888' })
    await page('/event', { device: 'd-5', event: 'inquiry', number: '+15551230001' })
    assert.deepEqual((await graph.history('visitor:d-5')).map((sighting) => sighting.identifier), ['device:d-5', 'device:d-5'])
    // One address has tapped a tracking number from one browser. A second and third are believed; a fourth inside ten minutes is not.
    for (const device of ['d-2', 'd-3', 'd-4']) await page('/event', { device, event: 'phone_click', number: '+15551230001' })
    const noted = async (device: string) => (await graph.history(`visitor:${device}`)).some((sighting) => sighting.identifier.startsWith('dialed:'))
    assert.deepEqual([await noted('d-2'), await noted('d-3'), await noted('d-4')], [true, true, false])

    // Two inquiries, one tap and one counted call, all on the campaign of the ad click. The inquiries are one a day, plus the one with its own id.
    const report = await graph.report({ from: '2026-03-02', to: '2026-03-02' })
    assert.deepEqual(report.rows.map((row) => [row.source, row.campaignId, counts(row.stages)]), [
      ['google', '111', { inquiry: { count: 2, value: 0 }, phone_click: { count: 1, value: 0 }, call: { count: 1, value: 0 } }],
      // The visitors made up above arrived from no campaign, so their events are credited to nobody.
      ['(none)', '', { phone_click: { count: 4, value: 0 }, inquiry: { count: 1, value: 0 } }],
    ])
    assert.deepEqual((await graph.history('visitor:d-1')).map((sighting) => sighting.event), ['visit', 'visit', 'inquiry', 'inquiry', 'inquiry', 'phone_click', 'phone_click', 'call'])

    // Being turned away cost the first three nothing, so d-1 taps again and is still believed.
    clock += 6 * 60_000
    await page('/event', { device: 'd-1', event: 'phone_click', number: '+15551230001' })
    assert.equal((await graph.history('visitor:d-1')).filter((sighting) => sighting.identifier.startsWith('dialed:')).length, 2)
  } finally {
    server.close()
  }

  // Without Twilio set up, its route does not exist.
  const plain = createServer(createHandler(graph, { token: 'service', origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => plain.once('listening', resolve))
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/calls/twilio`, { method: 'POST', body: 'CallSid=CA1' })).status, 404)
  } finally {
    plain.close()
  }
})

test('a personal link checks the whole recipient group in one read', async () => {
  const store = createMemoryStore()
  const clusters: string[] = []
  const groups: string[][] = []
  const graph = createGraph({ ...store, read: (work) => store.read((tx) => work({
    ...tx,
    clusterOf: (cluster) => {
      clusters.push(cluster)
      return tx.clusterOf(cluster)
    },
    shared: (subjects) => {
      groups.push([...subjects].sort())
      return tx.shared(subjects)
    },
  })) })
  const records = Array.from({ length: 24 }, (_, n) => `contact:${String(n).padStart(2, '0')}`)
  const recipient = records[0]!
  await graph.joinAll(records.slice(1).map((other) => ({ a: recipient, b: other })), { by: 'desk' })
  await graph.speak({ subject: records.at(-1)!, identifiers: [] }, [{ subject: 'visitor:desk', identifiers: ['device:desk'] }], T0)
  const origin = 'https://site.example.org'
  const secret = 'a secret for a signed personal link'
  const known = new URL(knownLink(origin, recipient, { secret, now: () => T0 })).searchParams.get('ag')
  const server = createServer(createHandler(graph, { token: 'service', origins: [origin], linkSecret: secret, now: () => T0 })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    const opened = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/collect`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ device: 'desk', known }) })
    assert.equal(opened.status, 204)
    assert.ok((await graph.history('visitor:desk')).some(({ identifier }) => identifier === `opened:${recipient} (not tied)`))
    assert.deepEqual(groups, [records])
    assert.equal(clusters.filter((cluster) => cluster === 'visitor:desk').length, 1)
  } finally {
    server.close()
  }
})

test('a link sent to one person ties the browser that opens it, and a visitor is carried between sites', async () => {
  const graph = createGraph(createMemoryStore())
  let clock = 1_800_000_000_000
  const handler = createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: ['https://site.example', 'https://shop.example'], now: () => clock, linkSecret: 'a-long-secret-value', limit: false })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const service = (path: string, body: object, token = 'service') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const page = (path: string, body: object, origin = 'https://site.example', agent = 'Browser/1.0') => fetch(`${base}${path}`, { method: 'POST', headers: { origin, 'user-agent': agent }, body: JSON.stringify(body) })
  const members = async (subject: string) => (await graph.cluster(subject))?.members
  try {
    // Your backend asks for a link for one contact and sends it to them.
    const made = (await (await service('/link', { url: 'https://site.example/offer', subject: 'contact:1', days: 7 })).json()) as { url: string }
    const known = new URL(made.url).searchParams.get('ag')!
    assert.equal((await service('/link', { url: 'https://site.example/', subject: 'contact:1' }, 'reviewer')).status, 403)
    assert.equal((await service('/link', { url: 'nope', subject: 'contact:1' })).status, 400)
    for (const bad of [{ url: 'https://site.example/', subject: ' ' }, { url: 'javascript:alert(1)', subject: 'contact:1' }, { url: 'https://site.example/', subject: 'contact:1', days: 1e300 }, { url: 'https://site.example/', subject: 'contact:1', days: -1 }, { url: 'https://site.example/', subject: 'contact:1', days: '7' }, { url: 'https://site.example/', subject: '中'.repeat(256) }]) {
      assert.equal((await service('/link', bad)).status, 400, JSON.stringify(bad).slice(0, 60))
    }

    // They open it, and the browser is tied to them. A forged token ties nobody.
    assert.equal((await page('/collect', { device: 'phone-1', known })).status, 204)
    assert.equal((await page('/collect', { device: 'phone-2', known: known.slice(0, -2) + 'xx' })).status, 204)
    assert.deepEqual(await members('contact:1'), ['contact:1', 'visitor:phone-1'])
    assert.deepEqual(await members('visitor:phone-2'), ['visitor:phone-2'])
    assert.deepEqual((await graph.links('contact:1')).map((link) => [link.subject, link.level, link.reasons[0]!.identifier]), [['visitor:phone-1', 'same', 'link:phone-1']])

    // Opened by whoever speaks for them, in whichever browser of hers, it is not theirs.
    await graph.observe([{ subject: 'visitor:hers', identifiers: ['device:hers', 'dial:hers'], at: T0 }, { subject: 'caller:hers', identifiers: ['phone:hers', 'dial:hers'], at: T0 }])
    await graph.speak({ subject: 'contact:son', identifiers: ['email:son'] }, [{ subject: 'caller:hers', identifiers: ['phone:hers'] }], T0)
    const his = new URL(((await (await service('/link', { url: 'https://site.example/offer', subject: 'contact:son' })).json()) as { url: string }).url).searchParams.get('ag')!
    assert.equal((await page('/collect', { device: 'hers', known: his })).status, 204)
    assert.deepEqual([await members('contact:son'), await members('visitor:hers')], [['contact:son'], ['caller:hers', 'visitor:hers']])
    assert.ok((await graph.history('visitor:hers')).some((each) => each.identifier === 'opened:contact:son (not tied)'))
    // Nor one sent to another record of his.
    await graph.observe({ subject: 'contact:son-again', identifiers: ['email:son'], at: T0 })
    const twin = new URL(((await (await service('/link', { url: 'https://site.example/offer', subject: 'contact:son-again' })).json()) as { url: string }).url).searchParams.get('ag')!
    assert.equal((await page('/collect', { device: 'hers', known: twin })).status, 204)
    assert.deepEqual(await members('visitor:hers'), ['caller:hers', 'visitor:hers'])
    // In a browser of his own it is his.
    assert.equal((await page('/collect', { device: 'his', known: his })).status, 204)
    assert.deepEqual(await members('contact:son'), ['contact:son', 'contact:son-again', 'visitor:his'])

    // A second person's link opened in the same browser. Both are there by a link alone, so neither wins. Each thins, and the browser is joined to nobody.
    const linkFor = async (subject: string) => new URL(((await (await service('/link', { url: 'https://site.example/offer', subject })).json()) as { url: string }).url).searchParams.get('ag')!
    // The opening is noted on the link, whichever of its two names the token comes under.
    assert.equal((await page('/collect', { device: 'phone-1', link: known })).status, 204)
    const sentTo = async (subject: string, token = 'service') => fetch(`${base}/sent?subject=${subject}`, { headers: { authorization: `Bearer ${token}` } })
    const [first] = (await (await sentTo('contact:1')).json()) as any[]
    assert.deepEqual([first.openings, first.purpose, typeof first.opened, first.expires % 1000, (await sentTo('contact:1', 'reviewer')).status], [2, undefined, 'number', 0, 403])
    for (const purpose of ['two words', '', 5]) assert.equal((await service('/link', { url: 'https://site.example/', subject: 'contact:1', purpose })).status, 400)
    const gone = new URL(((await (await service('/link', { url: 'https://site.example/pay', subject: 'contact:gone', days: 0.3, purpose: 'payment' })).json()) as { url: string }).url)
    assert.ok(gone.searchParams.get('ag'))
    assert.ok(Number.isInteger(((await (await sentTo('contact:gone')).json()) as any[])[0].expires))
    // Opened once its person is forgotten, a link brings nobody back.
    const late = new URL(((await (await service('/link', { url: 'https://site.example/pay', subject: 'contact:late' })).json()) as { url: string }).url).searchParams.get('ag')
    await graph.forget('contact:late')
    await page('/collect', { device: 'phone-late', known: late })
    assert.equal(await members('contact:late'), undefined)
    // One made by the library alone is kept nowhere, and names its person as it did.
    await page('/collect', { device: 'phone-lib', known: new URL(knownLink('https://site.example/', 'contact:lib', { secret: 'a-long-secret-value', now: () => clock })).searchParams.get('ag') })
    assert.deepEqual(await members('contact:lib'), ['contact:lib', 'visitor:phone-lib'])
    await page('/collect', { device: 'phone-1', known: await linkFor('contact:2') })
    assert.deepEqual(await members('contact:1'), ['contact:1'])
    assert.deepEqual((await graph.links('visitor:phone-1')).map((link) => [link.subject, link.level]), [['contact:1', 'related'], ['contact:2', 'related']])

    // A browser that belongs to someone by more than a link, here a sign-in, is not handed to another person of the same kind.
    await graph.observe({ subject: 'contact:bob', identifiers: ['device:bob-phone'], at: clock })
    await page('/collect', { device: 'bob-phone' })
    await page('/collect', { device: 'bob-phone', known: await linkFor('contact:alice') })
    assert.deepEqual(await members('contact:bob'), ['contact:bob', 'visitor:bob-phone'])
    assert.equal(await members('contact:alice'), undefined)
    assert.ok((await graph.history('visitor:bob-phone')).some((sighting) => sighting.identifier === 'opened:contact:alice (not tied)'))
    // Openings that did not tie do not use up the person's three browsers, so her own phone still ties.
    for (const device of ['x-1', 'x-2', 'x-3']) {
      await graph.observe({ subject: `contact:${device}`, identifiers: [`device:${device}`], at: clock })
      await page('/collect', { device })
      await page('/collect', { device, known: await linkFor('contact:alice') })
    }
    await page('/collect', { device: 'alice-phone', known: await linkFor('contact:alice') })
    assert.deepEqual(await members('contact:alice'), ['contact:alice', 'visitor:alice-phone'])

    // One person opens their link on a phone, a laptop and a tablet. A fourth browser is one too many to be the same person.
    const third = await linkFor('contact:3')
    for (const device of ['c3-phone', 'c3-laptop', 'c3-tablet', 'c3-fourth']) await page('/collect', { device, known: third })
    assert.deepEqual(await members('contact:3'), ['contact:3', 'visitor:c3-laptop', 'visitor:c3-phone', 'visitor:c3-tablet'])
    assert.deepEqual(await members('visitor:c3-fourth'), ['visitor:c3-fourth'])
    // Opening it again in one of the three changes nothing.
    await page('/collect', { device: 'c3-phone', known: third })
    assert.equal((await members('contact:3'))!.length, 4)

    // A week later the first link has run out.
    clock += 8 * 86_400_000
    await page('/collect', { device: 'phone-3', known })
    assert.deepEqual(await members('visitor:phone-3'), ['visitor:phone-3'])

    // One site asks for a token for its visitor; the next site hands it over with its own visit.
    await page('/collect', { device: 'site-device', touch: { gclid: 'G-site' } })
    const asked = await page('/carry', { device: 'site-device' })
    assert.equal(asked.headers.get('access-control-allow-credentials'), 'true')
    const { token } = (await asked.json()) as { token: string }
    assert.equal((await page('/collect', { device: 'shop-device', carried: token }, 'https://shop.example')).status, 204)
    assert.deepEqual(await members('visitor:shop-device'), ['visitor:shop-device', 'visitor:site-device'])
    // Walking between your own sites is not an arrival. The first site as referrer leaves no touch, though a campaign tag still does.
    await page('/collect', { device: 'shop-device', touch: { referrer: 'https://site.example/pricing', landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 1)
    await page('/collect', { device: 'elsewhere', touch: { referrer: 'https://news.example/story', landing: 'https://shop.example/' } }, 'https://shop.example')
    await page('/collect', { device: 'elsewhere', touch: { referrer: 'https://site.example/pricing', source: 'newsletter', landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 3)
    // Fields sent empty say nothing about where the visitor came from, so they leave no touch either.
    await page('/collect', { device: 'elsewhere', touch: { referrer: '', source: '', custom: { mailing: '' }, landing: 'https://shop.example/' } }, 'https://shop.example')
    // It is kept with an arrival, unless the visitor has said no to measuring ads, whether or not this visit says so again.
    await page('/collect', { device: 'fb-yes', touch: { fbclid: 'F', fbp: 'fb.1.1700000000000.1' } })
    await graph.consent('visitor:fb-no', { adUserData: false, adPersonalization: false }, { at: 1_700_000_000_000 })
    await page('/collect', { device: 'fb-no', touch: { fbclid: 'F', fbp: 'fb.1.1700000000000.2' } })
    const kept = async (device: string) => (await graph.attribute(`visitor:${device}`, { at: clock + 1 })).touches.map((touch) => touch.fbp)
    assert.deepEqual([await kept('fb-yes'), await kept('fb-no')], [['fb.1.1700000000000.1'], [undefined]])
    for (const device of ['fb-yes', 'fb-no']) await graph.forget(`visitor:${device}`)
    // Nor does Meta's browser id by itself, because it says which browser, and not from where.
    await page('/collect', { device: 'elsewhere', touch: { fbp: 'fb.1.1700000000000.1', landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 3)
    // So a sign-up on the second site is credited to the ad click that landed on the first.
    await graph.observe({ subject: 'account:7', identifiers: ['device:shop-device'], at: clock + 1000 })
    assert.equal((await graph.attribute('account:7', { at: clock + 1000 })).credited?.gclid, 'G-site')
    assert.deepEqual((await graph.links('visitor:shop-device')).map((link) => [link.subject, link.reasons[0]!.identifier]), [['account:7', 'device:shop-device'], ['visitor:site-device', 'carry:site-device@shop.example']])
    // Passed to another browser, or used after an hour, the same token ties nobody.
    await page('/collect', { device: 'stranger', carried: token }, 'https://shop.example', 'Other/2.0')
    assert.deepEqual(await members('visitor:stranger'), ['visitor:stranger'])
    // Handed around a shared network, where the browsers look alike, it thins. A third holder ends the join, and a fifth ends the tie.
    await page('/collect', { device: 'lookalike-1', carried: token }, 'https://shop.example')
    assert.deepEqual(await members('visitor:shop-device'), ['account:7', 'visitor:shop-device'])
    assert.deepEqual((await graph.links('visitor:lookalike-1')).map((link) => link.level), ['related', 'related'])
    for (const device of ['lookalike-2', 'lookalike-3']) await page('/collect', { device, carried: token }, 'https://shop.example')
    assert.deepEqual(await graph.links('visitor:lookalike-1'), [])
    clock += 3_600_001
    await page('/collect', { device: 'late', carried: token }, 'https://shop.example')
    assert.deepEqual(await members('visitor:late'), ['visitor:late'])
    assert.equal((await page('/carry', { device: 'x' }, 'https://evil.example')).status, 403)
    assert.deepEqual(await graph.verify(), [])
  } finally {
    server.close()
  }

  // With no secret set, there is nothing to sign with, so the routes do not exist and tokens are ignored.
  const plain = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => plain.once('listening', resolve))
  try {
    const address = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`
    assert.equal((await fetch(`${address}/link`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: '{}' })).status, 404)
    assert.equal((await fetch(`${address}/carry`, { method: 'POST', headers: { origin: 'https://site.example' }, body: '{}' })).status, 404)
  } finally {
    plain.close()
  }
})

test('behind a proxy the visitor is the address the proxy added, not one the sender wrote', async () => {
  const seen = async (trustProxy: boolean | number, forwarded: string) => {
    const graph = createGraph(createMemoryStore())
    const server = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'], trustProxy })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/collect`, { method: 'POST', headers: { origin: 'https://site.example', 'x-forwarded-for': forwarded }, body: JSON.stringify({ device: 'd' }) })
      return (await graph.history('visitor:d')).map((sighting) => sighting.identifier).find((identifier) => identifier.startsWith('ip:'))
    } finally {
      server.close()
    }
  }
  assert.equal(await seen(true, '203.0.113.9'), 'ip:203.0.113.9')
  // The sender put an address in front; the one proxy in between added the real one at the end.
  assert.equal(await seen(true, '198.51.100.1, 203.0.113.9'), 'ip:203.0.113.9')
  // Two proxies: the visitor is two from the end.
  assert.equal(await seen(2, '198.51.100.1, 203.0.113.9, 10.0.0.2'), 'ip:203.0.113.9')
  assert.equal(await seen(2, '203.0.113.9'), 'ip:203.0.113.9')
  assert.equal(await seen(false, '203.0.113.9'), 'ip:127.0.0.1')
})

test('a call whose result is awaited is held, and nothing is sent until a person answered', async () => {
  const clock = { now: T0 }
  const store = createMemoryStore()
  const graph = createGraph(store, undefined, { now: () => clock.now })
  const requests: IngestRequest[] = []
  const outbox = createOutbox(graph, store.outbox, { targets: [googleAds({ customerId: '1234567890', send: async (request) => (requests.push(request), {}) })], now: () => clock.now })
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'review' }, origins: [], outbox, stages: { call: { value: 10, currency: 'USD', action: '111' } }, calls: { results: 'expected' }, now: () => clock.now })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: object, token = 'service') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as any }
  }
  const call = (id: string) => ({ id, from: '+15550100021', to: '+15550100001', at: T0, duration: 90 })
  try {
    const first = await post('/call', call('CA1'))
    assert.deepEqual([first.body.state, first.body.counted], ['waiting', false])
    await outbox.run()
    assert.deepEqual([requests.length, (await outbox.counts()).held], [0, 1])
    assert.equal((await post('/call/result', { id: 'CA1', answered: true }, 'review')).status, 403)
    assert.equal((await post('/call/result', { id: 'CA1' })).status, 400)
    assert.deepEqual((await post('/call/result', { id: 'CA1', answered: true, waited: 12 })).body, { state: 'answered', counted: true })
    await outbox.run()
    // Sent once, worth its step, with the caller's number as a match key though the number itself was never kept.
    const [event] = requests.flatMap((request) => request.events) as any[]
    assert.deepEqual([requests.length, event.transactionId, event.conversionValue, event.userData.userIdentifiers], [1, 'call:CA1', 10, [{ phoneNumber: hashPhone('+15550100021') }]])
    await post('/call/result', { id: 'CA1', answered: true, waited: 12 })
    await outbox.run()
    assert.equal(requests.length, 1)

    // Answered by nobody: held for good, and never sent.
    await post('/call', call('CA2'))
    assert.deepEqual((await post('/call/result', { id: 'CA2', answered: false })).body, { state: 'missed', counted: false })
    // The miss and what became of it, for a reviewer too.
    const asked = async () => (await (await fetch(`${base}/call?id=CA2`, { headers: { authorization: 'Bearer review' } })).json()) as any
    assert.deepEqual([(await asked()).state, (await asked()).followUp], ['missed', { state: 'open', attempts: 0 }])
    await post('/call', { id: 'CB1', direction: 'outbound', from: '+15550100001', to: '+15550100021', at: T0 + 60_000, duration: 80, answered: true })
    assert.deepEqual((await asked()).followUp, { state: 'returned', by: 'CB1', delay: 60_000, attempts: 0 })
    assert.equal(await (await fetch(`${base}/call?id=none`, { headers: { authorization: 'Bearer review' } })).json(), null)
    // The list of open misses and the summary, for a reviewer, with a period and a zone.
    const read = async (path: string) => (await fetch(`${base}${path}`, { headers: { authorization: 'Bearer review' } }))
    const days = 'from=2024-02-16&to=2024-02-16&tz=America/New_York'
    await post('/call', { ...call('CA9'), from: '+15550100029', at: T0 + 1, answered: false })
    const list = (await (await read(`/calls?${days}`)).json()) as any
    assert.deepEqual([list.timeZone, list.calls.map((each: any) => [each.id, each.state, each.attempts]), list.next], ['America/New_York', [['CA9', 'missed', 0]], null])
    const whole = (await (await read(`/calls/summary?${days}`)).json()) as any
    assert.deepEqual([whole.expected, whole.total.calls, whole.total.missed, whole.total.returned], [true, 3, 2, 1])
    assert.equal('to' in list.calls[0], false)
    const broken = (await (await read(`/report?${days}&by=outcome.language`)).json()) as any
    assert.deepEqual([broken.by, broken.total.breakdown.map((part: any) => part.name)], ['outcome.language', ['(not set)']])
    assert.equal((await read('/report?by=nonsense')).status, 400)
    const after = (await (await read(`/followed?${days}&step=client&days=10`)).json()) as any
    assert.deepEqual([after.step, after.days, after.least, after.groups.length, after.timeZone], ['client', 10, 20, 4, 'America/New_York'])
    // The caller's journey, with what became of each step at the ad platforms.
    const story = (await (await read(`/journey?subject=${first.body.subject}`)).json()) as any
    const told = story.entries.filter((entry: any) => entry.kind === 'outcome').map((entry: any) => [entry.outcome.transactionId, entry.sent.map((job: any) => [job.target, job.state])])
    assert.deepEqual(told, [['call:CA1', [['google', 'sent']]]])
    assert.ok(story.entries.filter((entry: any) => entry.kind === 'call').every((entry: any) => entry.state && !('to' in entry.call)))
    assert.equal((await read('/journey?subject=a&before=soon')).status, 400)
    await graph.observe(['review:a', 'review:b', 'review:c'].map((subject, i) => ({ subject, identifiers: i === 0 ? ['canvas:ab', 'canvas:ac'] : [i === 1 ? 'canvas:ab' : 'canvas:ac'], at: T0 })))
    const matchPage = async (query: string) => await (await read(`/undecided?${query}`)).json() as any
    for (const full of [false, true]) {
      const first = await matchPage(`full=${full}&limit=1`)
      assert.deepEqual([first.window.kind, first.more, first.pairs[0].b], [full ? 'full' : 'recent', true, 'review:b'])
      const last = await matchPage(`cursor=${first.next}&limit=1`)
      assert.deepEqual([last.window.kind, last.next, last.pairs[0].b], [first.window.kind, null, 'review:c'])
    }
    for (const query of ['cursor=x', 'cursor=', 'full=x']) assert.equal((await read(`/undecided?${query}`)).status, 400, query)
    const joined = (await post('/join', { a: 'm:1', b: 'm:2', mark: true })).body
    assert.ok(joined.moved.length > 0 && /^review:join-\d+$/.test(joined.mark))
    assert.ok(Array.isArray((await post('/join', { a: 'm:1', b: 'm:3' })).body))
    const board = await (await read('/board')).json() as any
    assert.deepEqual([board.days, board.timeZone, board.columns[0].step], [90, 'UTC', null])
    assert.ok(board.columns.every((column: any) => column.rows.every((row: any) => !('outcome' in row) && !('to' in (row.call ?? {})))))
    for (const bad of ['/undecided?limit=0', '/undecided?limit=x', '/board?days=0', '/board?days=x', '/followed?days=10', '/followed?step=client&days=x', '/calls?after=x', '/calls?from=2026-13-01', '/calls/summary?tz=Mars']) assert.equal((await read(bad)).status, 400, bad)
    // A return your own system reports: for the service alone, and checked.
    const marked = await post('/call/returned', { id: 'CA-nobody', at: 1_700_000_000_000 })
    assert.deepEqual([marked.status, marked.body], [200, { followUp: null }])
    assert.equal((await post('/call/returned', { id: 'CA-nobody', at: 'then' })).status, 400)
    assert.equal((await fetch(`${base}/call/returned`, { method: 'POST', headers: { authorization: 'Bearer review' }, body: '{"id":"CA-nobody"}' })).status, 403)
    // What was no lead, for the service alone. A call and an outcome say so when they are read.
    assert.deepEqual((await post('/not-lead', { call: 'CA1', kind: 'spam' })).body, { id: 'call:CA1', lead: false })
    assert.equal(((await (await read('/call?id=CA1')).json()) as any).notLead, 'spam')
    assert.equal(((await (await read('/outcome?id=call:CA1')).json()) as any).notLead, 'spam')
    assert.deepEqual((await post('/not-lead', { call: 'CA1', lead: true })).body, { id: 'call:CA1', lead: true })
    assert.equal('notLead' in ((await (await read('/call?id=CA1')).json()) as any), false)
    assert.equal((await post('/not-lead', { call: 'CA1', kind: 'junk' })).status, 400)
    assert.equal((await fetch(`${base}/not-lead`, { method: 'POST', headers: { authorization: 'Bearer review' }, body: '{"call":"CA1"}' })).status, 403)
    // Given back, what had been sent is told its value once more.
    // A result that comes first waits for its call.
    assert.deepEqual((await post('/call/result', { id: 'CA3', answered: true })).body, { state: 'waiting', counted: false })
    assert.equal((await post('/call', call('CA3'))).body.state, 'answered')
    await outbox.run()
    assert.deepEqual(requests.flatMap((request) => request.events.map((each: any) => each.transactionId)), ['call:CA1', 'call:CA1', 'call:CA3'])
    // Missed as it was reported, and answered after all: it goes out with the number's hash it was reported with.
    await post('/call', { ...call('CA4'), answered: false })
    assert.equal((await post('/call/result', { id: 'CA4', answered: true })).body.counted, true)
    await outbox.run()
    const corrected = requests.at(-1)!.events[0] as any
    assert.deepEqual([corrected.transactionId, corrected.userData.userIdentifiers], ['call:CA4', [{ phoneNumber: hashPhone('+15550100021') }]])
    const held = (await (await fetch(`${base}/conversions?state=held`, { headers: { authorization: 'Bearer service' } })).json()) as any[]
    assert.deepEqual(held.map((job) => job.transactionId).sort(), ['call:CA2', 'call:CA9'])
  } finally {
    server.close()
  }
})

test('a sent delivery shown with a confirmed record does not disclose the original click or consent', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = 1790000000000
  const original = { click: { msclkid: 'first-visitor-click' }, confidence: 0.93, consent: { adUserData: true, adPersonalization: false } }
  await store.write(async tx => {
    await tx.setCall({ id: 'confirmed', subject: 'caller:line', direction: 'inbound', at, recorded: at, to: '+12025550102', flags: [] })
    await tx.outbox.add({ transactionId: 'call:confirmed', subject: 'caller:line', target: 'test', action: 'call', at, due: at, state: 'sent', attempts: 1, keys: {}, ...original })
    await tx.outbox.add({ transactionId: 'unrelated', subject: 'record:other', target: 'test', action: 'call', at, due: at, state: 'sent', attempts: 1, keys: {}, ...original })
  })
  const outbox = createOutbox(graph, store.outbox, { targets: [{ name: 'test', batch: 10, keys: () => ({}), click: () => undefined, deliver: async () => ({}), retryable: () => false }] })
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { desk: 'staff' }, outbox, origins: [] })).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    await graph.sayParty({ call: 'confirmed', key: 'owner', at: at + 1, party: { role: 'self', subject: 'record:a', by: 'desk' } })
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/conversions?state=sent`, { headers: { authorization: 'Bearer staff' } })
    assert.equal(response.status, 200)
    const rows = await response.json() as Record<string, unknown>[]
    const row = rows.find(each => each.transactionId === 'call:confirmed')!
    const other = rows.find(each => each.transactionId === 'unrelated')!
    assert.deepEqual([other.click, other.confidence, other.consent], [original.click, original.confidence, original.consent])
    assert.equal(row.subject, 'record:a')
    assert.deepEqual([row.click, row.confidence, row.consent], [undefined, undefined, undefined])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('a reviewer sees refused conversions without keys and puts them back in line', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = Date.now() - 60_000
  let refuse = true
  // Refused as a whole request, with everything it held repeated in the answer.
  const target = (name: string) => ({ name, restates: false, batch: 10, keys: (outcome: { email?: string }) => ({ email: `Key+of:${outcome.email}` }), click: () => undefined, retryable: () => true, deliver: async (_action: string, items: readonly { job: { keys: Record<string, string> } }[]) => {
    if (refuse) throw new Error(`action_111 was not found for ${items.map(({ job }) => job.keys.email!.toUpperCase()).join(' and ')}`)
    return {}
  } })
  const outbox = createOutbox(graph, store.outbox, { maxAttempts: 1, targets: [target('ads'), target('more')] })
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, outbox, origins: [] })).listen(0)
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) })
      return { status: response.status, body: (await response.json()) as any }
    }
    for (const n of [1, 2]) await call('service', 'POST', '/convert', { transactionId: `t${n}`, subject: `a${n}`, at, stage: 'enrolled', action: { ads: '111', more: '111' }, value: 5, currency: 'USD', email: `a${n}@example.com` })
    await outbox.run()
    const { body: failed } = await call('reviewer', 'GET', '/conversions?state=failed')
    assert.deepEqual(failed.map((job: any) => `${job.transactionId} ${job.target} ${'keys' in job}`).sort(), ['t1 ads false', 't1 more false', 't2 ads false', 't2 more false'])
    assert.ok(failed.every((job: any) => job.note === 'action_111 was not found for (left out) and (left out)'))
    assert.deepEqual((await call('service', 'GET', '/conversions?state=failed')).body, failed)
    // Kept for the platform, and shown to nobody.
    assert.equal((await outbox.get('t1'))[0]!.keys.email, 'Key+of:a1@example.com')
    assert.deepEqual((await call('service', 'GET', '/conversion?id=t1')).body.map((job: any) => `${job.target} ${'keys' in job}`).sort(), ['ads false', 'more false'])
    for (const bad of [{}, { transactionId: 5 }, { transactionId: ['t1'] }, { transactionId: 't1', target: 5 }]) assert.equal((await call('reviewer', 'POST', '/retry', bad)).status, 400)
    refuse = false
    // Only the platform named, and then the rest.
    const again = async (token: string, body: object) => (await call(token, 'POST', '/retry', body)).body.map((job: any) => `${job.transactionId} ${job.target} ${job.state} ${'keys' in job}`)
    assert.deepEqual(await again('reviewer', { transactionId: 't1', target: 'ads' }), ['t1 ads pending false'])
    assert.deepEqual(await again('service', { transactionId: 't1' }), ['t1 more pending false'])
    await outbox.run()
    assert.deepEqual(await outbox.counts().then((counts) => [counts.sent, counts.failed]), [2, 2])
    assert.deepEqual(await again('reviewer', { transactionId: 't1' }), [])
    assert.equal((await call('reviewer', 'GET', '/conversion?id=t1')).status, 403)
  } finally {
    server.close()
  }
})

test('a page event cannot take the id of a conversion a backend has yet to record', async () => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: ['https://s.example'], events: ['signup'] })).listen(0)
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`
    const visit = await fetch(`${base}/event`, { method: 'POST', headers: { origin: 'https://s.example', 'content-type': 'text/plain' }, body: JSON.stringify({ device: '1001', event: 'signup', id: '1' }) })
    assert.equal(visit.status, 204)
    const convert = (transactionId: string) => fetch(`${base}/convert`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ transactionId, subject: 'account:1001', at: 1, stage: 'signup', value: 250 }) })
    assert.equal((await convert('signup:1001:1')).status, 200)
    assert.deepEqual([(await graph.outcomeOf('signup:1001:1'))!.value, (await graph.outcomeOf('page:signup:1001:1'))!.subject], [250, 'visitor:1001'])
    for (const taken of ['page:signup:1001:1', 'call:CA1', 'text:SM1']) assert.equal((await convert(taken)).status, 400)
  } finally {
    server.close()
  }
})

test('no route answers with the hashed email and phone of a conversion', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = Date.now() - 60_000
  const target = { name: 'ads', restates: true, batch: 10, keys: () => ({ email: 'hashed-email', phone: 'hashed-phone' }), click: () => undefined, retryable: () => true, deliver: async () => ({}) }
  const outbox = createOutbox(graph, store.outbox, { targets: [target] })
  const server = createServer(createHandler(graph, { token: 'service', outbox, origins: [] })).listen(0)
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { authorization: 'Bearer service' }, ...(body !== undefined && { body: JSON.stringify(body) }) })
      return { status: response.status, text: await response.text() }
    }
    const answers = {
      convert: await call('POST', '/convert', { transactionId: 't1', subject: 'a1', at, action: 'Lead', value: 5, currency: 'USD', email: 'a1@example.com', phone: '+15558675309' }),
      payment: await call('POST', '/payment', { id: 'p1', transactionId: 't1', amount: 3 }),
      restate: await call('POST', '/restate', { transactionId: 't1', value: 2 }),
      conversion: await call('GET', '/conversion?id=t1'),
      conversions: await call('GET', '/conversions?state=pending'),
    }
    for (const [name, { status, text }] of Object.entries(answers)) {
      assert.equal(status, 200, name)
      // The job is in the answer, so there was something to leave out.
      assert.match(text, /"transactionId":"t1","target":"ads"/, name)
      assert.doesNotMatch(text, /"keys"|hashed-/, name)
    }
    assert.deepEqual((await outbox.get('t1'))[0]!.keys, { email: 'hashed-email', phone: 'hashed-phone' })
  } finally {
    server.close()
  }
})

test('steps give page events, calls and outcomes their value and their ad platform action', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = Date.parse('2026-03-02T12:00:00Z')
  const sent: IngestRequest[] = []
  const outbox = createOutbox(graph, store.outbox, { targets: [googleAds({ customerId: '1234567890', send: async (request) => (sent.push(request), { requestId: 'r' }) })], now: () => at + 60_000 })
  const handler = createHandler(graph, {
    token: 'service',
    reviewers: { dana: 'reviewer' },
    origins: ['https://site.example'],
    now: () => at,
    outbox,
    events: ['inquiry'],
    stages: { inquiry: { value: 5, currency: 'USD', action: { google: '111' } }, call: { value: 10, currency: 'USD', action: { google: '222' } }, client: { value: 200, currency: 'USD' } },
  })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: object, headers: Record<string, string> = { authorization: 'Bearer service' }) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  try {
    await post('/collect', { device: 'd-1', touch: { gclid: 'G1', campaignId: '111' } }, { origin: 'https://site.example' })
    // A page event needs only its name, because the step says what it is worth and where it goes.
    assert.equal((await post('/event', { device: 'd-1', event: 'inquiry' }, { origin: 'https://site.example' })).status, 204)
    assert.deepEqual((await outbox.get(`page:inquiry:d-1:2026-03-02`)).map((job) => [job.target, job.action, job.value, job.currency]), [['google', '111', 5, 'USD']])
    // A step worth something counts once a day per browser, whatever id the page gives and however often it reports.
    assert.equal((await post('/event', { device: 'd-1', event: 'inquiry' }, { origin: 'https://site.example' })).status, 204)
    for (const id of ['a', 'b', 'c']) assert.equal((await post('/event', { device: 'd-1', event: 'inquiry', id }, { origin: 'https://site.example' })).status, 204)
    assert.deepEqual(await outbox.get('page:inquiry:d-1:a'), [])
    assert.equal((await outbox.counts()).pending, 1)

    // A call takes its step the same way, with the caller's number as a match key.
    const call = (await (await post('/call', { id: 'CA1', from: '+15558675309', to: '+15551230001', at, duration: 90 })).json()) as any
    assert.equal(call.counted, true)
    const [job] = await outbox.get('call:CA1')
    assert.deepEqual([job!.action, job!.value, job!.source, Object.keys(job!.keys)], ['222', 10, 'PHONE', ['phone']])

    // A step with no action is counted and not sent; what an outcome states for itself stands.
    await post('/observe', { subject: 'account:1', identifiers: ['device:d-1'], at })
    assert.deepEqual(await (await post('/convert', { transactionId: 'client-1', subject: 'account:1', at, stage: 'client' })).json(), [])
    await post('/convert', { transactionId: 'client-2', subject: 'account:1', at, stage: 'client', value: 1250 })
    assert.deepEqual((await outbox.run()).sent, 2)
    assert.deepEqual(sent.flatMap((request) => request.events.map((event) => [event.transactionId, event.conversionValue])).sort(), [['call:CA1', 10], ['page:inquiry:d-1:2026-03-02', 5]])

    // The report lists the steps in the order they were given, then any others by name.
    await post('/convert', { transactionId: 'other-1', subject: 'account:1', at, stage: 'brochure' })
    const report = (await (await fetch(`${base}/report?from=2026-03-02&to=2026-03-02`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    assert.deepEqual(report.steps, ['inquiry', 'call', 'client', 'brochure'])
    assert.deepEqual(counts(report.total.stages), { inquiry: { count: 1, value: 5 }, call: { count: 1, value: 10 }, client: { count: 2, value: 1450 }, brochure: { count: 1, value: 0 } })

    // A refund says why the value fell, here and to the platform that can restate. A refused one changes neither.
    assert.deepEqual(((await (await post('/restate', { transactionId: 'call:CA1', value: 4, kind: 'refund' })).json()) as any[]).map((each) => each.value), [4])
    for (const bad of [{ value: 11, kind: 'refund' }, { value: 1, kind: 'gift' }, { value: 1, kind: 'write_off', currency: 'EUR' }]) assert.equal((await post('/restate', { transactionId: 'call:CA1', ...bad })).status, 400)
    assert.equal((await outbox.get('call:CA1'))[0]!.value, 4)
    const { total } = (await (await fetch(`${base}/report?from=2026-03-02&to=2026-03-02`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    assert.deepEqual([total.valueChange.refunded, total.valueChange.writtenOff], [6, 0])

    // Forgetting says what had reached a platform where it is asked to, and is refused when it is asked in words.
    const caller = (await outbox.get('call:CA1'))[0]!.subject
    assert.equal((await post('/forget', { subject: caller, ads: 'yes' })).status, 400)
    assert.equal((await outbox.get('call:CA1')).length, 1)
    // Nor is a retraction asked for in words, before anything is deleted.
    for (const retract of ['yes', 1]) assert.equal((await post('/forget', { subject: caller, retract })).status, 400)
    assert.equal((await outbox.get('call:CA1')).length, 1)
    const forgotten = (await (await post('/forget', { subject: caller, ads: true })).json()) as any
    assert.deepEqual(forgotten.sent, [{ transactionId: 'call:CA1', target: 'google', action: '222', at, state: 'not_requested' }])
    assert.deepEqual([Array.isArray(forgotten.changes), await outbox.get('call:CA1')], [true, []])
    assert.ok(Array.isArray(await (await post('/forget', { subject: 'nobody' })).json()))
  } finally {
    server.close()
  }
})

/** The fields this reads from Smarty's documented answer for one address. */
const candidate = (more: { analysis?: object; metadata?: object } = {}) => ({
  delivery_line_1: '1 Main St Apt 2',
  last_line: 'Springfield IL 62701-1234',
  delivery_point_barcode: '627011234025',
  metadata: { rdi: 'Residential', record_type: 'H', ...more.metadata },
  analysis: { dpv_match_code: 'Y', dpv_cmra: 'N', dpv_vacant: 'N', ...more.analysis },
})

test('a postal address is checked with Smarty and counts only when confirmed to the door', async () => {
  const { fetcher, calls } = fake((url) => {
    if (url.includes('street=nowhere')) return { body: [] }
    if (url.includes('street=broke')) return { status: 402, body: { errors: [{ message: 'Payment required' }] } }
    return { body: [candidate()] }
  })
  const verify = createAddressVerifier({ authId: 'id', authToken: 'token', fetch: fetcher })
  const found = await verify({ street: ' 1 main street #2 ', city: 'Springfield', state: 'IL', zipcode: '62701' })
  assert.deepEqual(found, { barcode: '627011234025', line1: '1 Main St Apt 2', lastLine: 'Springfield IL 62701-1234', match: 'Y', residential: true, mailDrop: false, vacant: false })
  const asked = new URL(calls[0]!.url)
  assert.equal(asked.origin + asked.pathname, 'https://us-street.api.smarty.com/street-address')
  assert.deepEqual(Object.fromEntries(asked.searchParams), { street: '1 main street #2', city: 'Springfield', state: 'IL', zipcode: '62701', candidates: '1' })
  // The secret goes in a header, never in the address.
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('id:token').toString('base64')}`)

  assert.equal(await verify({ street: 'nowhere' }), undefined)
  // An answer that is not a list of candidates is read as no match, not as a crash.
  const odd = createAddressVerifier({ authId: 'id', authToken: 'token', fetch: (async () => new Response('{"unexpected":true}')) as typeof fetch })
  assert.equal(await odd({ street: '1 Main St' }), undefined)
  await assert.rejects(verify({ street: 'broke' }), /Smarty rejected the address check with 402/)
  await assert.rejects(verify({ street: '  ' }), TypeError)

  // Only the hash of the delivery point is kept, and only for an address that can belong to a household.
  assert.match(addressIdentifier(found!)!, /^address:[0-9a-f]{64}$/)
  assert.equal(addressIdentifier(found!), addressIdentifier({ ...found!, line1: 'written another way' }))
  for (const not of [{ match: 'S' }, { match: 'D' }, { match: 'N' }, { match: '' }, { mailDrop: true }, { vacant: true }]) assert.equal(addressIdentifier({ ...found!, ...not }), undefined)
})

test('Twilio says what kind of line a number is, once per number', async () => {
  let clock = 1_800_000_000_000
  const { fetcher, calls } = fake((url) => {
    if (url.includes('%2B15550000404')) return { status: 404, body: { code: 20404 } }
    if (url.includes('%2B15550000500')) return { status: 401, body: { message: 'Authenticate' } }
    if (url.includes('%2B15550000606')) return { body: { line_type_intelligence: { error_code: 60601, type: null } } }
    return { body: { line_type_intelligence: { error_code: null, mobile_country_code: '240', mobile_network_code: '38', carrier_name: 'Twilio - SMS/MMS-SVR', type: 'nonFixedVoip' } } }
  })
  const lookup = createLineTypeLookup({ accountSid: 'AC1', authToken: 'secret', fetch: fetcher, now: () => clock })
  assert.deepEqual(await lookup('+14159929960'), { type: 'nonFixedVoip', carrier: 'Twilio - SMS/MMS-SVR' })
  assert.equal(calls[0]!.url, 'https://lookups.twilio.com/v2/PhoneNumbers/%2B14159929960?Fields=line_type_intelligence')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from('AC1:secret').toString('base64')}`)
  // A second question about the same number is answered from memory for thirty days.
  await lookup('+14159929960')
  assert.equal(calls.length, 1)
  clock += 31 * 86_400_000
  await lookup('+14159929960')
  assert.equal(calls.length, 2)

  assert.equal(await lookup('+15550000404'), undefined)
  assert.deepEqual(await lookup('+15550000606'), { type: 'unknown', carrier: undefined })
  // An error inside the answer may clear up, so it is asked again next time; a number Twilio does not know is remembered.
  const before = calls.length
  await lookup('+15550000606')
  await lookup('+15550000404')
  assert.equal(calls.length, before + 1)
  await assert.rejects(lookup('+15550000500'), /Twilio rejected the lookup with 401/)
})

test('the server identifies a subject from plain facts, drops declared bots, and notes where a visit came from', async () => {
  const graph = createGraph(createMemoryStore())
  const at = 1_800_000_000_000
  const lines: Record<string, string> = { '+15550001111': 'mobile', '+15550002222': 'nonFixedVoip', '+18005550100': 'tollFree' }
  const handler = createHandler(graph, {
    token: 'service',
    reviewers: { dana: 'reviewer' },
    origins: ['https://site.example'],
    now: () => at,
    limit: false,
    ipInfo: async () => ({ country: 'US', region: 'FL', city: 'Miami', asn: 1, organization: 'Home ISP', userType: 'residential', anonymous: false, hosting: false }),
    lineType: async (number) => (number === '+15550009999' ? Promise.reject(new Error('lookup down')) : lines[number] ? { type: lines[number]!, carrier: undefined } : undefined),
    address: async ({ street }) => (street === 'offline' ? Promise.reject(new TypeError('fetch failed')) : street === 'unknown' ? undefined : { barcode: street.startsWith('1 Main') ? '627011234025' : '999', line1: street, lastLine: '', match: street.includes('Box') ? 'Y' : street.includes('Tower') ? 'D' : 'Y', residential: true, mailDrop: street.includes('Box'), vacant: false }),
  })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })
  const identify = async (body: object, token = 'service') => {
    const response = await fetch(`${base}/identify`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: response.status, ...((await response.json()) as { identifiers?: string[]; notes?: Record<string, string>; changes?: unknown[]; error?: string }) }
  }
  const kinds = (identifiers: string[] = []) => identifiers.map((identifier) => identifier.slice(0, identifier.indexOf(':')))
  const errors = console.error
  console.error = () => {}
  try {
    // Everything arrives as the backend has it; the server hashes, normalizes and checks.
    const first = await identify({ subject: 'account:1', event: 'signup', device: 'd-1', email: ' Pat.Lee@Gmail.com ', phone: '(555) 000-1111', ip: '203.0.113.9', address: { street: '1 Main Street #2', city: 'Springfield', state: 'IL' } })
    assert.deepEqual([first.status, kinds(first.identifiers), first.notes], [200, ['device', 'email', 'ip', 'phone', 'address'], { phone: 'mobile', address: 'confirmed' }])
    assert.equal(first.identifiers![1], `email:${createHash('sha256').update('patlee@gmail.com').digest('hex')}`)
    assert.deepEqual((await graph.history('account:1')).map((sighting) => [sighting.event, sighting.at]), Array(5).fill(['signup', at]))

    // The same address written another way is the same delivery point. It is a household, so related and not joined.
    const second = await identify({ subject: 'account:2', address: { street: '1 Main St Apt 2' } })
    assert.deepEqual(second.identifiers, [first.identifiers![4]])
    assert.deepEqual((await graph.links('account:2')).map((link) => [link.subject, link.level, Math.round(link.score * 100)]), [['account:1', 'related', 60]])

    // A throwaway number is kept as the weaker kind; a switchboard, a rented box and a building with no apartment tie nobody.
    const third = await identify({ subject: 'account:3', phone: '+15550002222', address: { street: 'PO Box 9' } })
    assert.deepEqual([kinds(third.identifiers), third.notes], [['voip'], { phone: 'nonFixedVoip', address: 'a rented mail box: not used' }])
    const fourth = await identify({ subject: 'account:4', device: 'd-4', phone: '1-800-555-0100', address: { street: '9 Tower Rd' } })
    assert.deepEqual([kinds(fourth.identifiers), fourth.notes], [['device'], { phone: 'tollFree: not used', address: 'not confirmed to the apartment: not used' }])
    const fifth = await identify({ subject: 'account:5', device: 'd-5', address: { street: 'unknown' } })
    assert.deepEqual(fifth.notes, { address: 'not found' })
    // A lookup that is down does not lose the sighting. The number is kept as a plain phone.
    const sixth = await identify({ subject: 'account:6', phone: '+15550009999' })
    assert.deepEqual([kinds(sixth.identifiers), sixth.notes], [['phone'], {}])
    // The address service cannot be reached. The rest of the sighting is recorded and the note says why the address is not.
    const offline = await identify({ subject: 'account:6b', device: 'd-6b', address: { street: 'offline' } })
    assert.deepEqual([offline.status, kinds(offline.identifiers), offline.notes], [200, ['device'], { address: 'not checked: the address service did not answer' }])
    // A number found to be a throwaway stops counting as a phone wherever it was written before, calls included,
    // and ties at the weaker strength from then on.
    await post('/call', { id: 'V1', from: '+15550002222', to: '+15551230001', at, duration: 60 })
    const caller = `caller:${hashPhone('+15550002222')}`
    assert.deepEqual((await graph.links('account:3')).map((link) => [link.subject, link.level, link.reasons[0]!.identifier.split(':')[0]]), [[caller, 'related', 'voip']])
    await graph.observe({ subject: 'account:old', identifiers: [`phone:${hashPhone('+15550002222')}`], at })
    assert.deepEqual(await graph.links('account:old'), [])
    // Muting is decided once, however often the number comes up and however often anyone asks for it again.
    await graph.ignore(`phone:${hashPhone('+15550002222')}`)
    assert.deepEqual((await graph.decisions()).map((decision) => [decision.action, decision.by]), [['ignore', 'line check']])
    // Identifiers the backend already has can ride along, and a time of its own.
    const seventh = await identify({ subject: 'account:7', at: at - 5000, identifiers: ['payment:tok_1'] })
    assert.deepEqual([seventh.identifiers, (await graph.history('account:7'))[0]!.at], [['payment:tok_1'], at - 5000])

    assert.equal((await identify({ subject: 'account:8' })).status, 400)
    assert.equal((await identify({ device: 'd-1' })).status, 400)
    assert.equal((await identify({ subject: 'account:8', phone: '12' })).status, 400)
    assert.equal((await identify({ subject: 'account:8', email: 'nope' })).status, 400)
    assert.equal((await identify({ subject: 'account:8', device: 'has space' })).status, 400)
    assert.equal((await identify({ subject: 'account:8', address: {} })).status, 400)
    assert.equal((await identify({ subject: 'account:8', device: 'd-8', at: 1.5 })).status, 400)
    assert.equal((await identify({ subject: 'account:8', device: 'd-8', at: '1700000000000' })).status, 400)
    assert.equal((await identify({ subject: 'account:8', device: 'd-8' }, 'reviewer')).status, 403)

    // A program that says what it is leaves no visit; a browser's visit is noted with where its address places it.
    const visit = (device: string, agent: string, path = '/collect', body: object = {}) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { origin: 'https://site.example', 'user-agent': agent }, body: JSON.stringify({ device, ...body }) }).then((r) => r.status)
    const declared = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'facebookexternalhit/1.1', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'TelegramBot (like TwitterBot)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'Baiduspider+(+http://www.baidu.com/search/spider.htm)', 'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)', 'Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)',
      'WhatsApp/2.23.20.0 A', 'curl/8.4.0', 'python-requests/2.31.0', 'Chrome-Lighthouse',
      // The crawlers that load ad landing pages, and others whose names carry a dash and no slash.
      'AdsBot-Google (+http://www.google.com/adsbot.html)', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
      'Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', 'Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)', 'DuckDuckBot-Https/1.1; (+https://duckduckgo.com/duckduckbot)', 'Googlebot-Image/1.0',
    ]
    for (const agent of declared) assert.equal(await visit('crawler', agent), 204)
    assert.equal(await graph.cluster('visitor:crawler'), undefined)
    // A phone sold under a name with "bot" in it, and an app's built-in browser, are people.
    const people = [
      'Mozilla/5.0 (Linux; Android 12; CUBOT-X70 Build/SP1A) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 13; CUBOT_NOTE_50) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 12; Robot-Vacuum-Tab) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/489.0.0.61.109;FBDV/iPhone15,3]',
      'Mozilla/5.0 (Linux; Android 14; SM-S918B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 Instagram 355.0.0.38.103 Android',
    ]
    for (const [n, agent] of people.entries()) assert.equal(await visit(`someone-${n}`, agent), 204)
    assert.equal((await graph.search('visitor:someone-')).length, people.length)
    assert.equal(await visit('person', 'Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), 204)
    assert.deepEqual((await graph.history('visitor:person')).map((sighting) => sighting.identifier).sort(), ['device:person', 'ip:127.0.0.1', 'place:US/FL/Miami'])
    assert.deepEqual(await graph.links('visitor:person'), [])
    const stats = (await (await fetch(`${base}/stats`, { headers: { authorization: 'Bearer service' } })).json()) as { bots: number; collected: number }
    assert.deepEqual([stats.bots, stats.collected], [declared.length, people.length + 1])
    assert.deepEqual(await graph.verify(), [])
  } finally {
    console.error = errors
    server.close()
  }

  assert.equal(placeOf({ country: 'CA', asn: undefined, organization: undefined, userType: undefined, anonymous: false, hosting: false }), 'CA')
  assert.equal(placeOf(undefined), undefined)
  // With no address service, an address is left alone and the note says so.
  const plain = createServer(createHandler(graph, { token: 'service', origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => plain.once('listening', resolve))
  try {
    const answer = (await (await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/identify`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ subject: 'account:9', phone: '+15550001111', address: { street: '1 Main St' } }) })).json()) as { identifiers: string[]; notes: object }
    assert.deepEqual([kinds(answer.identifiers), answer.notes], [['phone'], { address: 'not checked: no address service is set up' }])
  } finally {
    plain.close()
  }
})

test('with the server cookie on, the id a page quotes still names the visitor', async () => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'], cookie: true })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    // The page's storage was cleared and it made a new id; the server's cookie still holds the old one.
    await fetch(`${base}/collect`, { method: 'POST', headers: { origin: 'https://site.example', cookie: 'ag_device=old-id' }, body: JSON.stringify({ device: 'new-id' }) })
    assert.deepEqual((await graph.cluster('visitor:old-id'))!.members, ['visitor:old-id'])
    assert.equal(await graph.cluster('visitor:new-id'), undefined)
    // A form filled by the page carries the new id, and it still finds the visitor.
    await fetch(`${base}/identify`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify({ subject: 'account:1', device: 'new-id' }) })
    assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1', 'visitor:old-id'])
  } finally {
    server.close()
  }
})

test('a name sent to /identify confirms, where a secret and a policy for it are set', async (t) => {
  const household = policyFrom(JSON.parse(readFileSync(new URL('../examples/household.json', import.meta.url), 'utf8')))
  const address = async ({ street }: { street: string }) => ({ barcode: '627011234025', line1: street, lastLine: '', match: street === 'nowhere' ? 'N' : 'Y', residential: true, mailDrop: false, vacant: false })
  const serve = async (policy: typeof household | undefined, identifierSecret?: string) => {
    const graph = createGraph(createMemoryStore(), policy)
    const server = createServer(createHandler(graph, { token: 'service', origins: [], address, ...(identifierSecret && { identifierSecret }) })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    t.after(() => void server.close())
    const identify = async (body: object) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/identify`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })
      const answer = (await response.json()) as any
      return { status: response.status, kinds: (answer.identifiers ?? []).map((each: string) => each.split(':')[0]), ...answer }
    }
    return { graph, identify }
  }
  const secret = 'a-secret-of-thirty-two-characters!'
  const { graph, identify } = await serve(household, secret)
  const one = await identify({ subject: 'contact:1', phone: '+15550100051', name: { first: 'Ana', last: 'Lima' }, dob: '1990-02-03' })
  assert.deepEqual([one.kinds, one.notes], [['phone', 'name', 'called'], { name: 'used' }])
  assert.ok(!JSON.stringify(one).includes('Lima') && !JSON.stringify(await graph.history('contact:1')).includes('Lima'))
  // The same phone and another name is a household. The same phone and name is one person.
  await identify({ subject: 'contact:2', phone: '+15550100052', name: { first: 'Rui', last: 'Lima' }, dob: '1960-01-02' })
  await identify({ subject: 'contact:2b', phone: '+15550100052', name: { first: 'Eva', last: 'Lima' }, dob: '1960-01-02' })
  assert.deepEqual((await graph.links('contact:2')).map((link) => link.level), ['related'])
  await identify({ subject: 'contact:3', phone: '+15550100051', name: { first: 'ANA', last: 'lima' }, dob: '1990-02-03' })
  assert.deepEqual((await graph.cluster('contact:3'))!.members, ['contact:1', 'contact:3'])
  // A confirmed address gives the zip code, and one that is not confirmed gives none.
  assert.deepEqual((await identify({ subject: 'contact:4', name: { first: 'Eva', last: 'Reis' }, address: { street: '1 Main St' } })).kinds, ['address', 'name', 'called'])
  assert.deepEqual((await identify({ subject: 'contact:5', email: 'eva@example.org', name: { first: 'Eva', last: 'Reis' }, address: { street: 'nowhere' } })).notes.name, 'not used: a placeholder, or neither a confirmed address nor a date of birth')
  assert.equal((await identify({ subject: 'contact:6', email: 'x@example.org', name: { first: 'Unknown', last: 'Unknown' }, dob: '1990-02-03' })).notes.name, 'not used: a placeholder, or neither a confirmed address nor a date of birth')
  for (const bad of [{ name: 'Ana Lima' }, { name: { first: 'Ana' } }, { name: { first: 'Ana', last: 'Lima' }, dob: 19900203 }]) assert.equal((await identify({ subject: 'contact:7', email: 'y@example.org', ...bad })).status, 400, JSON.stringify(bad))
  // Off where the policy has no such kind: the rest is still recorded.
  const named = { subject: 'contact:1', email: 'z@example.org', name: { first: 'Ana', last: 'Lima' }, dob: '1990-02-03' }
  const plain = await (await serve(undefined, secret)).identify(named)
  // The whole name is still kept, as a note that links nothing.
  assert.deepEqual([plain.kinds, plain.notes], [['email', 'called'], { name: 'not used: the policy has no "name" kind that only corroborates' }])
  const loud = await (await serve(policyFrom({ kinds: { name: { weight: 0.95, dilution: 0, cap: 5, halfLife: 'none' } } }), secret)).identify(named)
  assert.deepEqual([loud.kinds, loud.notes.name], [['email', 'called'], 'not used: the policy has no "name" kind that only corroborates'])
  // A date of birth with no name is nobody's, and the rest is recorded.
  assert.deepEqual((await identify({ subject: 'contact:8', email: 'w@example.org', dob: '1990-02-03' })).kinds, ['email'])
})

test('/identify keeps whoever speaks for a subject apart from them', async (t) => {
  const graph = createGraph(createMemoryStore())
  const lineType = async (number: string) => ({ type: number.endsWith('99') ? 'tollFree' : 'mobile' })
  const server = createServer(createHandler(graph, { token: 'service', origins: [], lineType: lineType as any })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => void server.close())
  const identify = async (body: object) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/identify`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })
    return { status: response.status, ...((await response.json()) as any) }
  }
  const [device, phone, mother] = ['9f3c1c1e-0000-4000-8000-000000000001', '+15550100181', `caller:${hashPhone('+15550100181')}`]
  // The browser is known by another id, and holds this one.
  await graph.observe({ subject: 'visitor:cookie', identifiers: [`device:${device}`, 'device:cookie'], at: T0 })
  const speaker = { device, phone, email: 'mother@example.org' }
  const first = await identify({ subject: 'contact:child', phone, email: 'mother@example.org', device, at: T0, speaker })
  assert.deepEqual([first.status, first.identifiers.map((each: string) => each.split(':')[0]), first.notes], [200, ['behalf', 'behalf'], { phone: 'mobile', speaker: 'what is the speaker\'s is not used for who they speak for' }])
  assert.deepEqual((await graph.cluster('contact:child'))!.members, ['contact:child'])
  assert.deepEqual((await graph.links('contact:child')).map((link) => [link.subject, link.level]).sort(), [[mother, 'related'], ['visitor:cookie', 'related']])
  // Said again it is the same mark, muted or not. What is the child's own is theirs.
  const again = await identify({ subject: 'contact:child', email: 'child@example.org', at: T0, speaker })
  assert.deepEqual(again.identifiers.filter((each: string) => each.startsWith('behalf:')), first.identifiers)
  assert.deepEqual(again.identifiers.map((each: string) => each.split(':')[0]).sort(), ['behalf', 'behalf', 'email'])
  for (const mark of first.identifiers) await graph.ignore(mark, true)
  assert.deepEqual((await identify({ subject: 'contact:child', at: T0, speaker })).identifiers, first.identifiers)
  // Her browser is the one by that id where there is one, whoever else holds it.
  await graph.observe([{ subject: 'visitor:aa', identifiers: ['device:zz-0000-4000'], at: T0 }, { subject: 'visitor:zz-0000-4000', identifiers: ['device:zz-0000-4000'], at: T0 }])
  await identify({ subject: 'contact:nephew', at: T0, speaker: { device: 'zz-0000-4000' } })
  assert.deepEqual((await graph.links('contact:nephew')).map((link) => link.subject), ['visitor:zz-0000-4000'])
  // It is hers though an alias was said to speak before there was one, and what was muted of that one stays muted.
  await graph.observe({ subject: 'visitor:old', identifiers: ['device:yy-0000-4000'], at: T0 })
  const [stale] = (await identify({ subject: 'contact:niece', at: T0, speaker: { device: 'yy-0000-4000' } })).identifiers.filter((each: string) => each.startsWith('behalf:'))
  await graph.ignore(stale, true)
  await graph.observe({ subject: 'visitor:yy-0000-4000', identifiers: ['device:yy-0000-4000'], at: T0 })
  const exact = await identify({ subject: 'contact:niece', at: T0, speaker: { device: 'yy-0000-4000' } })
  assert.deepEqual(exact.identifiers, [stale])
  assert.deepEqual(await graph.links('contact:niece'), [])
  assert.deepEqual((await graph.holders([stale])).map((edge) => edge.subject).sort(), ['contact:niece', 'visitor:old'])
  await graph.ignore(stale, false)
  assert.deepEqual((await graph.links('contact:niece')).map((link) => link.subject), ['visitor:old'])
  // Another that holds the id is taken while the id is evidence, and not once it is muted.
  await graph.observe({ subject: 'visitor:mm', identifiers: ['device:ww-0000-4000'], at: T0 })
  await graph.ignore('device:ww-0000-4000', true)
  await identify({ subject: 'contact:aunt', at: T0, speaker: { device: 'ww-0000-4000' } })
  assert.deepEqual((await graph.links('contact:aunt')).map((link) => link.subject), ['visitor:ww-0000-4000'])
  // A browser that is there is hers, though it holds the id no longer or not yet.
  await graph.observe([{ subject: 'visitor:vv-0000-4000', identifiers: ['device:other-vv'], at: T0 }, { subject: 'visitor:vv-alias', identifiers: ['device:vv-0000-4000'], at: T0 }])
  await identify({ subject: 'contact:uncle', at: T0, speaker: { device: 'vv-0000-4000' } })
  assert.deepEqual((await graph.links('contact:uncle')).map((link) => link.subject), ['visitor:vv-0000-4000'])
  // Her own record is hers.
  await identify({ subject: 'contact:mother', phone, at: T0 })
  assert.ok((await graph.cluster('contact:mother'))!.members.includes(mother))
  assert.deepEqual((await graph.cluster('contact:child'))!.members, ['contact:child'])
  assert.equal((await identify({ subject: mother, speaker })).status, 400)
  for (const bad of [{ device: '?' }, { phone: 'x' }]) assert.equal((await identify({ subject: 'contact:other', speaker: bad })).status, 400, JSON.stringify(bad))
  // One that names nobody loses nothing of the subject's.
  for (const [n, none] of ['mother', null, {}, { email: 'mother@example.org' }, { phone: '' }].entries()) {
    const answer = await identify({ subject: `contact:none${n}`, email: 'mine@example.org', speaker: none })
    assert.deepEqual([answer.status, answer.identifiers.length, answer.notes.speaker], [200, 1, 'not used: a speaker requires a device or a phone'], JSON.stringify(none))
  }
  // Told late, what is on the record already is said and left.
  await identify({ subject: 'contact:late', phone: '+15550100187', at: T0 })
  assert.match((await identify({ subject: 'contact:late', at: T0, speaker: { phone: '+15550100187' } })).notes.speaker, /on this record already/)
  // A number that names nobody is not kept, and neither is what they say it is theirs.
  const kept = await identify({ subject: 'contact:other', email: 'o@example.org', speaker: { phone: '+18005550199', email: 'o@example.org' } })
  assert.deepEqual([kept.identifiers, kept.notes.speaker], [[], 'what is the speaker\'s is not used for who they speak for'])
  assert.equal((await identify({ subject: 'contact:other', email: 'p@example.org', speaker: { phone: '+18005550199' } })).notes.speaker, 'tollFree: not used')
})

test('/match finds whoever gave the same number under the same name, though it is not on their record', async (t) => {
  const graph = createGraph(createMemoryStore(), policyFrom({ apart: ['birth', 'given'] }))
  const server = createServer(createHandler(graph, { token: 'service', origins: [], identifierSecret: 'a-secret-of-thirty-two-characters!' })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => void server.close())
  const post = async (path: string, body: object) => (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })).json()) as any
  const phone = '+15550100181'
  await post('/identify', { subject: 'contact:son', name: { first: 'Robert', last: 'Lima' }, speaker: { phone } })
  const found = await post('/match', { phone, name: { first: 'Bob', last: 'Lima' } })
  assert.ok(found.candidates.some((each: any) => each.subject === 'contact:son' && each.level === 'same'))
  const other = await post('/match', { phone, name: { first: 'Luis', last: 'Lima' } })
  assert.ok(!other.candidates.some((each: any) => each.subject === 'contact:son' && each.level === 'same'))
})

test('a visitor with an arrival is shown a number of their own, and nobody else is', async (t) => {
  let clock = T0
  const graph = createGraph(createMemoryStore(), undefined, { now: () => clock })
  const ops = createOps(graph, createMemoryStore().ops, { onError: () => {} })
  const options = { token: 'service', reviewers: { dana: 'dana-token' }, origins: ['https://site.example'], events: ['phone_click'], trustProxy: 1, now: () => clock, staffNetworks: ['198.51.100.0/24'], ops }
  const listen = async (more: object) => {
    const server = createServer(createHandler(graph, { ...options, ...more })).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    t.after(() => void server.close())
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const base = await listen({ pool: { numbers: ['(555) 010-0001', '+15550100002'], minutes: 15, grace: 120 } })
  let visit = 0
  const page = (path: string, body: object, { origin = 'https://site.example', headers = {}, from = `203.0.113.${++visit}` }: { origin?: string; headers?: Record<string, string>; from?: string } = {}) => fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { origin, 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': from, ...headers } })
  const ask = async (device: string, more: object = {}, how: object = {}) => {
    const response = await page('/number', { device, ...more }, how)
    return response.status === 200 ? ((await response.json()) as { number: string; until: number; lasts: number }) : response.status
  }
  for (const device of ['a', 'b', 'c']) await page('/collect', { device, touch: { gclid: `G-${device}` } })
  await page('/collect', { device: 'plain' })
  await page('/collect', { device: 'shy', touch: { gclid: 'G-shy' } })

  // No arrival, an opt-out by signal, by banner or on record, staff, and a program: nothing, and no number is spent.
  assert.equal(await ask('plain'), 204)
  assert.equal(await ask('never-seen'), 204)
  assert.equal(await ask('shy', { gpc: true }), 204)
  assert.equal(await ask('shy', {}, { headers: { 'sec-gpc': '1' } }), 204)
  assert.equal(await ask('shy', { consent: { adUserData: false, adPersonalization: false } }), 204)
  await graph.consent('visitor:shy', { adUserData: false, adPersonalization: false }, { at: clock })
  assert.equal(await ask('shy'), 204)
  assert.equal(await ask('a', {}, { from: '198.51.100.7' }), 204)
  assert.equal(await ask('a', {}, { headers: { 'user-agent': 'curl/8.0' } }), 204)
  assert.equal((await page('/number', { device: 'a' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal(await graph.leasesAt(['+15550100001', '+15550100002'], clock), 0)

  const got = await ask('a')
  assert.deepEqual(got, { number: '+15550100001', until: clock + 900_000, lasts: 900_000 })
  clock += 300_000
  assert.deepEqual(await ask('a'), { number: '+15550100001', until: clock + 900_000, lasts: 900_000 })
  assert.equal(((await ask('b')) as any).number, '+15550100002')
  // Exhausted, the page keeps its own number, and it is counted.
  assert.equal(await ask('c'), 204)
  const authorized = { headers: { authorization: 'Bearer service' } }
  const stats = (await (await fetch(`${base}/stats`, authorized)).json()) as any
  assert.deepEqual([stats.leased, stats.exhausted], [3, 1])
  const shown = (await (await fetch(`${base}/ops`, { headers: { authorization: 'Bearer dana-token' } })).json()) as any
  assert.deepEqual({ ...shown.pool, since: 0 }, { numbers: 2, held: 2, since: 0, leased: 3, exhausted: 1, minutes: 15 })

  // A call to the number is the visitor's, and so the ad click's, with no tap.
  const reported = (await (await fetch(`${base}/call`, { method: 'POST', body: JSON.stringify({ id: 'C1', from: '+15550100091', to: '+15550100001', at: clock + 1000, duration: 60 }), ...authorized })).json()) as any
  assert.deepEqual([reported.visitor, reported.flags], ['visitor:a', ['pool']])
  assert.equal((await graph.attribute(reported.subject, { at: clock + 1000 })).credited?.gclid, 'G-a')

  // A network of invented visitors gets three browsers' worth, whatever it asks for.
  clock += 3_600_000
  for (const n of [1, 2, 3, 4]) await page('/collect', { device: `bot-${n}`, touch: { gclid: `B${n}` } }, { from: '203.0.113.200' })
  const before = ((await (await fetch(`${base}/stats`, authorized)).json()) as any).exhausted
  for (const n of [1, 2, 3, 4]) await ask(`bot-${n}`, {}, { from: '203.0.113.200' })
  assert.equal(((await (await fetch(`${base}/stats`, authorized)).json()) as any).exhausted, before + 1)

  // Off, there is no such route.
  const off = await listen({})
  assert.equal((await fetch(`${off}/number`, { method: 'POST', body: '{"device":"a"}', headers: { origin: 'https://site.example' } })).status, 404)
  assert.throws(() => createHandler(graph, { ...options, pool: { numbers: ['nonsense'], minutes: 15, grace: 0 } }), TypeError)
})

test('a call marked before it counted takes its step when that is taken back, with no ad platform', async (t) => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: [], calls: { results: 'expected' }, stages: { call: { value: 10, currency: 'USD' } } })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => void server.close())
  const post = async (path: string, body: object) => (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })).json()) as any
  await post('/not-lead', { call: 'N1' })
  await post('/call', { id: 'N1', from: '+15550100091', to: '+15550100001', at: T0, duration: 60, answered: true })
  assert.equal(await graph.outcomeOf('call:N1'), undefined)
  await post('/not-lead', { call: 'N1', lead: true })
  const { stage, value, currency } = (await graph.outcomeOf('call:N1'))!
  assert.deepEqual([stage, value, currency], ['call', 10, 'USD'])
})

test('the labels tool resolves a file of checked pairs against a running server, and counts what it could not use', async (t) => {
  const graph = createGraph(createMemoryStore())
  const see = (subject: string, ...identifiers: string[]) => graph.observe({ subject, identifiers, at: T0, event: 'login' })
  // Four of one person by phone, one pair of two people by phone, and an address shared by one pair of each.
  for (const n of [1, 2, 3, 4]) for (const side of ['a', 'b']) await see(`s${n}${side}`, `phone:s${n}`)
  for (const side of ['a', 'b']) await see(`d1${side}`, 'phone:d1')
  for (const side of ['a', 'b']) await see(`s5${side}`, 'address:s5', `email:s5${side}`)
  for (const side of ['a', 'b']) await see(`d2${side}`, 'address:d2')
  for (const side of ['a', 'b']) await see(`s6${side}`, `email:s6${side}`)
  // Muted, a phone links nobody, and the pair that shares it is counted apart.
  for (const side of ['a', 'b']) await see(`s7${side}`, 'phone:muted')
  await graph.ignore('phone:muted')
  // A reviewer joined the two who share nothing. The decision is the answer, and not evidence for it.
  await graph.join('s6a', 's6b')
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'dana-token' }, origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const home = mkdtempSync(join(tmpdir(), 'ag-labels-'))
  t.after(() => (server.close(), rmSync(home, { recursive: true, force: true })))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const run = async (csv: string, token = 'dana-token') => {
    writeFileSync(join(home, 'pairs.csv'), csv)
    const at = new URL('../tools/labels.ts', import.meta.url).pathname
    return promisify(execFile)(process.execPath, [decodeURIComponent(at), join(home, 'pairs.csv')], { env: { PATH: process.env.PATH, GRAPH_URL: url, GRAPH_TOKEN: token } })
  }
  const same = ['s1a,s1b', 's2a,s2b', 's3b,s3a', 's4a,s4b', 's5a,s5b', 's6a,s6b', 's7a,s7b', 's1a,merged-away'].map((pair) => `${pair},same`)
  // One pair is in the file twice, the other way round, and one is labelled both ways.
  const { stdout } = await run(['a,b,label', ...same, 's1b,s1a,same', 'd1a,d1b,different', 'd2a,d2b,different', 'd1a,d2a,same', 'd1a,d2a,different', ''].join('\n'))
  assert.match(stdout, /13 rows, 11 pairs\. 1 labelled both ways were left out\./)
  assert.match(stdout, /1 could not be used, because nothing recorded about one of the two is left: 1 same, 0 different\./)
  assert.match(stdout, /9 used: 7 same, 2 different\./)
  const find = (name: string) => stdout.split('\n').find((line) => line.startsWith(name))!.trim().split(/\s{2,}/).slice(1)
  assert.deepEqual(find('phone'), ['6', '5', '1', '83.3%', '71.4%'])
  assert.deepEqual(find('  muted or over its cap'), ['1', '1', '0', '100.0%', '14.3%'])
  assert.deepEqual(find('address'), ['2', '1', '1', '50.0%', '14.3%'])
  assert.deepEqual(find('nothing'), ['1', '1', '0', '100.0%', '14.3%'])
  assert.deepEqual(find('a score of 0.9 or more'), ['5', '4', '1', '80.0%', '57.1%'])
  assert.deepEqual(find('in one cluster now'), ['6', '5', '1', '83.3%', '71.4%'])
  assert.ok(stdout.includes('Labels from staff are biased') && stdout.includes('merged away'))
  assert.ok(!stdout.includes('s1a'))
  await assert.rejects(run('a,b,label\ns1a,s1b,maybe'), /Line 2 needs its label as "same" or "different"/)
  await assert.rejects(run('a,b\ns1a,s1b'), /needs a "label" column/)
  await assert.rejects(run('a,b,label\ns1a,s1b,same', 'wrong'), /The server answered 401/)
})

test('texts are taken from the page, your own systems and Twilio, and what they say is nowhere in the answers', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = Date.parse('2026-03-02T12:00:00Z')
  const url = 'https://graph.example/texts/twilio'
  const handler = createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: ['https://site.example'], now: () => at, events: ['text_click'], texts: { codes: true, twilio: { authToken: 'secret', url } } })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const open = (path: string, body: object, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { origin: 'https://site.example', ...headers }, body: JSON.stringify(body) })
  const get = async (path: string, token = 'reviewer') => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  try {
    await open('/collect', { device: 'd-1', touch: { gclid: 'G1' } })
    const { code } = (await (await open('/text-code', { device: 'd-1' })).json()) as { code: string }
    // The same browser keeps its code, another has its own, and one that refuses ad measurement has none.
    assert.equal(((await (await open('/text-code', { device: 'd-1' })).json()) as { code: string }).code, code)
    assert.notEqual(((await (await open('/text-code', { device: 'd-2' })).json()) as { code: string }).code, code)
    for (const body of [{ device: 'd-3', gpc: true }, { device: 'd-3', consent: { adUserData: false, adPersonalization: false } }]) assert.equal((await open('/text-code', body)).status, 204)
    assert.equal((await open('/text-code', { device: 'd-3' }, { origin: 'https://other.example' })).status, 403)
    assert.equal((await open('/event', { device: 'd-2', event: 'text_click', number: '+15550100101' })).status, 204)

    const twilio = (fields: Record<string, string>, signature = twilioSignature('secret', url, fields)) => fetch(`${base}/texts/twilio`, { method: 'POST', headers: { 'x-twilio-signature': signature }, body: new URLSearchParams(fields).toString() })
    const fields = { MessageSid: 'SM1', From: '+15550100141', To: '+15550100101', Body: `A private matter. Ref ${code}`, SmsStatus: 'received' }
    assert.equal((await twilio(fields, 'wrong')).status, 403)
    const answered = await twilio(fields)
    assert.deepEqual([answered.status, await answered.text()], [200, '<Response/>'])
    assert.equal((await twilio({ ...fields, MessageSid: 'SM2', SmsStatus: 'delivered' })).status, 200)
    assert.equal(await graph.keptText('SM2'), undefined)

    // The same code read out on the phone is the same browser's, and nobody else's.
    const spoken = async (id: string, from: string) => (await recordCall(graph, { id, from, to: '+15550100101', at, duration: 60, code })).flags
    assert.deepEqual([await spoken('CA1', '+15550100141'), await spoken('CA2', '+15550100149')], [['repeat', 'code'], ['taken']])

    const post = async (body: object, token = 'service') => fetch(`${base}/text`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    assert.equal((await post({}, 'reviewer')).status, 403)
    assert.equal((await post({ id: 'M1' })).status, 400)
    const tapped: any = await (await post({ id: 'M1', from: '+15550100142', to: '+15550100101', at, text: 'hello' })).json()
    assert.deepEqual([tapped.visitor, tapped.flags], ['visitor:d-2', ['first', 'tap']])
    const kept: any = await (await get('/text?id=SM1')).json()
    assert.deepEqual([kept.visitor, kept.reply, await (await get('/text?id=none')).json()], ['visitor:d-1', { state: 'open' }, null])
    const list: any = await (await get('/texts?from=2026-03-02&to=2026-03-02')).json()
    assert.deepEqual(list.texts.map((each: any) => [each.id, each.unanswered, each.source, each.to]).sort(), [['M1', 1, undefined, undefined], ['SM1', 1, 'google', undefined]])
    assert.equal((await get('/texts?after=x')).status, 400)
    assert.equal(await (await get('/texting?subject=visitor:d-1')).json(), null)
    const journey: any = await (await get('/journey?subject=visitor:d-1')).json()
    assert.deepEqual(journey.entries.filter((entry: any) => entry.kind === 'text').map((entry: any) => [entry.text.id, entry.text.to, entry.reply.state]), [['SM1', undefined, 'open']])
    assert.doesNotMatch(JSON.stringify([kept, list, journey, await graph.history('visitor:d-1')]), /private matter/)
  } finally {
    server.close()
  }
})

test('a slow answer is worked out once for everybody, shared for a moment while things are written, and never outlives a decision', async () => {
  const inner = createGraph(createMemoryStore())
  let worked = 0
  const clock = { now: Date.parse('2026-03-02T12:00:00Z') }
  let held: Promise<void> | undefined
  let release: (() => void) | undefined
  let reached = false
  let after: Promise<void> | undefined
  const graph = { ...inner, forget: async (...given: Parameters<typeof inner.forget>) => {
    const changes = await inner.forget(...given)
    await after
    return changes
  }, board: async (...given: Parameters<typeof inner.board>) => {
    worked += 1
    const board = await inner.board(...given)
    if (held) reached = true
    await held
    // It takes two seconds.
    clock.now += 2_000
    return board
  } }
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: [], now: () => clock.now, stages: { signup: {} } })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const read = async (query = '') => {
    const response = await fetch(`${base}/board${query}`, { headers: { authorization: 'Bearer reviewer' } })
    return { age: response.headers.get('age'), people: ((await response.json()) as any).columns?.[1]?.people, status: response.status }
  }
  const post = (path: string, body: object, token = 'service') => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const sign = (n: number) => post('/convert', { transactionId: `o${n}`, subject: `account:${n}`, at: clock.now, stage: 'signup' })
  try {
    await sign(1)
    assert.deepEqual((await Promise.all([read(), read(), read()])).map(({ age, people }) => [age, people]), Array(3).fill([null, 1]))
    assert.equal(worked, 1)
    // Asked differently, it is another answer. A mistake is worked out again.
    assert.equal((await read('?days=7')).people, 1)
    for (const _ of [1, 2]) assert.equal((await read('?days=0')).status, 400)
    assert.equal(worked, 4)
    // Something is written. The answer stands for four times as long as it took, and says it is from before.
    await sign(2)
    assert.deepEqual(await read(), { age: '4', people: 1, status: 200 })
    clock.now += 8_000
    assert.deepEqual(await read(), { age: null, people: 2, status: 200 })
    // With nothing written it is good for a minute, because lateness goes by the clock.
    const before = worked
    clock.now += 50_000
    await read()
    assert.equal(worked, before)
    clock.now += 20_000
    await read()
    assert.equal(worked, before + 1)
    // Whoever decides something sees it at once, and so it is for a deletion.
    await post('/separate', { a: 'account:1', b: 'account:2' })
    assert.equal((await read()).age, null)
    const reads = worked
    await post('/find', { text: 'account:1' }, 'reviewer')
    await read()
    assert.equal(worked, reads, 'looking decides nothing')
    await post('/forget?', { subject: 'account:1' })
    assert.deepEqual(await read(), { age: null, people: 1, status: 200 })
    // One being worked out when somebody is deleted is worked out again before anyone gets it.
    await sign(3)
    clock.now += 70_000
    held = new Promise((resolve) => (release = resolve))
    const waiting = Promise.all([read(), read()])
    while (!reached) await new Promise((resolve) => setImmediate(resolve))
    await post('/forget', { subject: 'account:3' })
    held = undefined
    release!()
    assert.deepEqual((await waiting).map(({ people }) => people), [1, 1])
    // And one during which something else was written says it is from before.
    clock.now += 70_000
    reached = false
    held = new Promise((resolve) => (release = resolve))
    const during = read()
    while (!reached) await new Promise((resolve) => setImmediate(resolve))
    await sign(4)
    held = undefined
    release!()
    assert.deepEqual([(await during).people, (await during).age !== null], [1, true])
    // A deletion that is done and waits for what it set off is already in no answer.
    await sign(5)
    clock.now += 70_000
    assert.equal((await read()).people, 3)
    let finish: (() => void) | undefined
    after = new Promise((resolve) => (finish = resolve))
    const deleting = post('/forget', { subject: 'account:5' })
    while ((await inner.cluster('account:5')) || (await inner.outcomeOf('o5'))) await new Promise((resolve) => setImmediate(resolve))
    const seen = (await read()).people
    // One that began before it was over is read again when it is.
    reached = false
    held = new Promise((resolve) => (release = resolve))
    const begun = worked
    const overlapping = read()
    while (!reached) await new Promise((resolve) => setImmediate(resolve))
    finish!()
    await deleting
    held = undefined
    release!()
    assert.deepEqual([seen, (await overlapping).people, worked - begun], [2, 2, 2])
    // A deletion may finish during the last database read before the reviewer receives the cached board.
    const revision = graph.partyRevision
    let checked = 0
    graph.partyRevision = async () => {
      const read = await revision()
      if (++checked === 2) await post('/forget', { subject: 'account:4' })
      return read
    }
    assert.equal((await read()).people, 1)
    // The first of two values is the one that counts, so the order of them is another question.
    await read('?days=7&days=30')
    const first = worked
    await read('?days=30&days=7')
    assert.equal(worked, first + 1)
    assert.equal((await fetch(`${base}/board`)).status, 401)
  } finally {
    server.close()
  }
})

test('a screen can ask who somebody may be, who is ringing, and who is kept apart, and nothing is written', async () => {
  const graph = createGraph(createMemoryStore())
  const at = Date.parse('2026-03-02T12:00:00Z')
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: [], now: () => at })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ask = async (path: string, body: object, token = 'reviewer') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as any }
  }
  try {
    for (const [subject, email, phone] of [['contact:1', 'pat@example.org', '+15550100181'], ['contact:2', 'lee@example.org', '+15550100182']]) await ask('/identify', { subject, email, phone }, 'service')
    await ask('/separate', { a: 'contact:1', b: 'contact:2' })
    await graph.touch({ subject: 'contact:2', at: at - 1000, gclid: 'G', landing: 'https://site.example/' })
    const version = await graph.version()
    const found = await ask('/match', { email: 'Pat@Example.org', phone: '(555) 010-0181' })
    assert.deepEqual(found.body.candidates.map((each: any) => [each.subject, each.level]), [['contact:1', 'same']])
    assert.equal((await ask('/match', {})).status, 400)
    assert.equal((await ask('/call/ringing', { from: '+17138120142', to: '+15550100101' })).body.area, 'Houston')
    const ring = await ask('/call/ringing', { from: '+15550100182', to: '+15550100101' })
    assert.deepEqual([ring.body.known, ring.body.people[0].subject, ring.body.source, ring.body.waiting, ring.body.touch], [false, 'contact:2', undefined, { calls: 0, texts: 0 }, undefined])
    assert.equal((await ask('/call/ringing', { from: 'x' })).status, 400)
    const against = await ask('/conflicts', { subjects: ['contact:1'] })
    assert.deepEqual(against.body.conflicts, [{ a: 'contact:1', b: 'contact:2', how: 'recorded', rests: ['contact:1', 'contact:2'] }])
    for (const subjects of [undefined, [], [''], Array(51).fill('x')]) assert.equal((await ask('/conflicts', { subjects })).status, 400)
    assert.equal(await graph.version(), version)
  } finally {
    server.close()
  }
})

test('payments, several people and a whole person to delete are taken in one request each', async () => {
  const graph = createGraph(createMemoryStore())
  const at = Date.parse('2026-03-02T12:00:00Z')
  const server = createServer(createHandler(graph, { token: 'service', reviewers: { dana: 'reviewer' }, origins: [], now: () => at })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: object, token = 'service') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as any }
  }
  try {
    for (const subject of ['contact:1', 'contact:2', 'contact:3']) await post('/identify', { subject, email: 'pat@example.org' })
    await post('/convert', { transactionId: 'o1', subject: 'contact:1', at, stage: 'client', value: 1250, currency: 'USD' })
    assert.deepEqual((await post('/payment', { id: 'p1', transactionId: 'o1', amount: 300 })).body, { duplicate: false, value: 300, jobs: [] })
    assert.equal((await post('/payment', { id: 'p1', transactionId: 'o1', amount: 300 }, 'reviewer')).status, 403)
    assert.equal((await post('/payment', { id: 'p2', transactionId: 'o1', amount: -1 })).status, 400)
    const { body } = await post('/people', { subjects: ['contact:1', 'contact:9'] }, 'reviewer')
    assert.deepEqual(body.people.map((each: any) => [each.subject, each.members.length]), [['contact:1', 3], ['contact:9', 1]])
    assert.equal((await post('/people', { subjects: Array(101).fill('x') })).status, 400)
    for (const bad of [{ subjects: [] }, { subjects: ['contact:1'], subject: 'contact:2' }, { subjects: [5] }]) assert.equal((await post('/forget', bad)).status, 400)
    const { body: gone } = await post('/forget', { subjects: ['contact:1', 'contact:2'], ads: true })
    assert.deepEqual(gone.sent, [])
    assert.deepEqual([await graph.cluster('contact:1'), await graph.cluster('contact:2'), (await graph.cluster('contact:3'))!.members], [undefined, undefined, ['contact:3']])
    assert.deepEqual((await graph.decisions()).filter((each) => each.action === 'forget').map((each) => each.about), [['contact:1'], ['contact:2']])
  } finally {
    server.close()
  }
})

test('what a form was filled in with for want of anything is nobody\'s, and nothing is refused for it', async () => {
  const graph = createGraph(createMemoryStore())
  const server = createServer(createHandler(graph, { token: 'service', origins: [] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: object) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: JSON.stringify(body) })
    return { status: response.status, body: (await response.json()) as any }
  }
  try {
    for (const [i, told] of [{ phone: '555-555-5555' }, { phone: '(123) 456-7890', email: 'none@example.org' }, { email: 'info@firm.example.org', phone: '+15550100142' }].entries()) {
      for (const n of [1, 2]) {
        const { status, body } = await post('/identify', { subject: `contact:${i}${n}`, ...told, ...(told.phone === '+15550100142' && { phone: `+1555010014${n}` }) })
        assert.equal(status, 200)
        assert.match(Object.values(body.notes).join(' '), /not used/)
      }
      assert.deepEqual((await graph.cluster(`contact:${i}1`))?.members, i === 2 ? ['contact:21'] : undefined, JSON.stringify(told))
    }
    // An office's name at a public mail domain is a person's, and a number near a placeholder is one.
    for (const told of [{ email: 'info@gmail.com' }, { phone: '+15550100143' }]) assert.deepEqual((await post('/identify', { subject: 'contact:9', ...told })).body.notes, {})
    assert.equal((await post('/identify', { subject: 'contact:9' })).status, 400)
    // Asked of nothing but a placeholder, who they may be is nobody.
    const asked = await post('/match', { phone: '555-555-5555' })
    assert.deepEqual([asked.status, asked.body.candidates], [200, []])
  } finally {
    server.close()
  }
})
