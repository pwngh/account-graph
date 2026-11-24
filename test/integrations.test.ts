import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createGraph, createMemoryStore, createOutbox, googleAds, hashPhone, knownLink, staffLink } from '../src/index.ts'
import type { IngestRequest } from '../src/index.ts'
import { CostError, costsFromCsv, googleCosts, metaCosts } from '../src/integrations/costs.ts'
import { createFingerprintVerifier, trusted } from '../src/integrations/fingerprint.ts'
import type { VerifiedFingerprint } from '../src/integrations/fingerprint.ts'
import { createGoogleTokens } from '../src/integrations/google-auth.ts'
import { createMicrosoftTokens } from '../src/integrations/microsoft-auth.ts'
import { hardwareId, machineId } from '../src/integrations/hardware.ts'
import { createDatabaseLookup, createMaxMindLookup, placeOf, shared } from '../src/integrations/maxmind.ts'
import { addressIdentifier, createAddressVerifier } from '../src/integrations/smarty.ts'
import { createLineTypeLookup, fromTwilio, twilioCall, twilioSignature } from '../src/integrations/twilio.ts'
import { createHandler } from '../src/server.ts'

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
  await graph.transfer({ from: 'account:2', to: 'account:1', amount: 500, at: T0 })
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
    assert.equal(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(html), false, 'the page loads nothing from outside')
    assert.equal(html.includes('innerHTML'), false)

    assert.equal((await fetch(`${base}/subject?subject=account:1`)).status, 401)
    const profile = (await (await fetch(`${base}/subject?subject=account:1`, { headers: auth })).json()) as any
    assert.equal(profile.known, true)
    assert.deepEqual(profile.cluster, { id: 'account:1', members: ['account:1', 'account:2', 'account:3'], oversized: false })
    assert.deepEqual(profile.links.map((link: any) => link.subject), ['account:3', 'account:2'])
    assert.deepEqual(profile.ties.map((tie: any) => `${tie.a}-${tie.b}`).sort(), ['account:1-account:2', 'account:1-account:3'])
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

test('the reviewer token opens the review routes and nothing a service writes through', async () => {
  const graph = createGraph(createMemoryStore())
  await graph.observe([
    { subject: 'account:1', identifiers: ['email:e'], at: T0 },
    { subject: 'account:2', identifiers: ['email:e'], at: T0 },
  ])
  const server = createServer(createHandler(graph, { token: 'service', reviewToken: 'reviewer', origins: [], now: () => T0 })).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (token: string, method: string, path: string, body?: object) =>
    fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body && { body: JSON.stringify(body) }) }).then((r) => r.status)
  try {
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
    assert.equal(await call('reviewer', 'POST', '/transfer', { from: 'account:1', to: 'account:2', amount: 5, at: T0 }), 403)
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
    assert.throws(() => createHandler(graph, { token: 'same', reviewToken: 'same', origins: [] }), TypeError)
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
    // A browser marked by a staff link, from anywhere.
    const { url } = (await (await ask('/staff-link', { url: 'https://site.example/team', label: 'intake desk', days: 10 })).json()) as any
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
    assert.equal((await ask('/staff-link', { url: 'https://site.example/', label: 5 })).status, 400)
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

test('one address cannot flood collect, and health and stats answer', async () => {
  const graph = createGraph(createMemoryStore())
  const clock = { now: T0 }
  const handler = createHandler(graph, { token: 'service', reviewToken: 'reviewer', origins: ['https://site.example'], now: () => clock.now, limit: { perMinute: 60, burst: 2 } })
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
    assert.match(helpers, /export async function fingerprintEvent\(options\s*\)/)
    assert.match(helpers, /export async function openFingerprint\(\)/)
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

test('a spreadsheet of costs is read from CSV', () => {
  const csv = 'Day,Source,Campaign ID,Campaign,Amount,Currency,Clicks,Impressions\r\n2026-03-01,microsoft,55,"Spring, ""big"" sale","$1,250.50",USD,40,"2,000"\n\n2026-03-02,mailer,,,300,,,\n'
  assert.deepEqual(costsFromCsv(csv), [
    { day: '2026-03-01', source: 'microsoft', amount: 1250.5, campaignId: '55', campaign: 'Spring, "big" sale', currency: 'USD', clicks: 40, impressions: 2000 },
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
  assert.deepEqual(twilioCall({ ...ended, CallStatus: 'no-answer', Timestamp: '' }, 5000), { id: 'CA9', from: '+15558675309', to: '+15551230001', at: 5000, duration: 0 })
  assert.equal(twilioCall({ ...ended, CallStatus: 'ringing' }, 0), undefined)
  assert.equal(twilioCall({ ...ended, Direction: 'outbound-api' }, 0), undefined)
})

test('the server takes page events and phone calls, and ties a call to the visitor who tapped', async () => {
  const graph = createGraph(createMemoryStore())
  let clock = Date.parse('2026-03-02T12:00:00Z')
  const twilio = { authToken: 'twilio-secret', url: 'https://graph.example.org/calls/twilio' }
  const handler = createHandler(graph, {
    token: 'service',
    reviewToken: 'reviewer',
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

    // Two inquiries (one a day, plus the one with its own id), one tap, one counted call, all on the campaign of the ad click.
    const report = await graph.report({ from: '2026-03-02', to: '2026-03-02' })
    assert.deepEqual(report.rows.map((row) => [row.source, row.campaignId, row.stages]), [
      ['google', '111', { inquiry: { count: 2, value: 0 }, phone_click: { count: 1, value: 0 }, call: { count: 1, value: 0 } }],
      // The visitors made up above arrived from no campaign, so their events are credited to nobody.
      ['(none)', '', { phone_click: { count: 4, value: 0 }, inquiry: { count: 1, value: 0 } }],
    ])
    assert.deepEqual((await graph.history('visitor:d-1')).map((sighting) => sighting.event), ['visit', 'visit', 'inquiry', 'inquiry', 'inquiry', 'phone_click', 'phone_click', 'call'])

    // Being turned away cost the first three nothing: d-1 taps again and is still believed.
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
    assert.equal((await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/calls/twilio`, { method: 'POST', body: 'CallSid=CA1' })).status, 401)
  } finally {
    plain.close()
  }
})

test('a link sent to one person ties the browser that opens it, and a visitor is carried between sites', async () => {
  const graph = createGraph(createMemoryStore())
  let clock = 1_800_000_000_000
  const handler = createHandler(graph, { token: 'service', reviewToken: 'reviewer', origins: ['https://site.example', 'https://shop.example'], now: () => clock, linkSecret: 'a-long-secret-value', limit: false })
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

    // They open it: the browser is tied to them. A forged token ties nobody.
    assert.equal((await page('/collect', { device: 'phone-1', known })).status, 204)
    assert.equal((await page('/collect', { device: 'phone-2', known: known.slice(0, -2) + 'xx' })).status, 204)
    assert.deepEqual(await members('contact:1'), ['contact:1', 'visitor:phone-1'])
    assert.deepEqual(await members('visitor:phone-2'), ['visitor:phone-2'])
    assert.deepEqual((await graph.links('contact:1')).map((link) => [link.subject, link.level, link.reasons[0]!.identifier]), [['visitor:phone-1', 'same', 'link:phone-1']])

    // A second person's link opened in the same browser. Both are there by a link alone, so neither wins: each thins, and the browser is joined to nobody.
    const linkFor = async (subject: string) => new URL(((await (await service('/link', { url: 'https://site.example/offer', subject })).json()) as { url: string }).url).searchParams.get('ag')!
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
    // Openings that did not tie do not use up the person's three browsers: her own phone still ties.
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
    // Walking between your own sites is not an arrival: the first site as referrer leaves no touch, though a campaign tag still does.
    await page('/collect', { device: 'shop-device', touch: { referrer: 'https://site.example/pricing', landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 1)
    await page('/collect', { device: 'elsewhere', touch: { referrer: 'https://news.example/story', landing: 'https://shop.example/' } }, 'https://shop.example')
    await page('/collect', { device: 'elsewhere', touch: { referrer: 'https://site.example/pricing', source: 'newsletter', landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 3)
    // Fields sent empty say nothing about where the visitor came from, so they leave no touch either.
    await page('/collect', { device: 'elsewhere', touch: { referrer: '', source: '', custom: { mailing: '' }, landing: 'https://shop.example/' } }, 'https://shop.example')
    assert.equal((await graph.counts()).touches, 3)
    // So a sign-up on the second site is credited to the ad click that landed on the first.
    await graph.observe({ subject: 'account:7', identifiers: ['device:shop-device'], at: clock + 1000 })
    assert.equal((await graph.attribute('account:7', { at: clock + 1000 })).credited?.gclid, 'G-site')
    assert.deepEqual((await graph.links('visitor:shop-device')).map((link) => [link.subject, link.reasons[0]!.identifier]), [['account:7', 'device:shop-device'], ['visitor:site-device', 'carry:site-device@shop.example']])
    // Passed to another browser, or used after an hour, the same token ties nobody.
    await page('/collect', { device: 'stranger', carried: token }, 'https://shop.example', 'Other/2.0')
    assert.deepEqual(await members('visitor:stranger'), ['visitor:stranger'])
    // Handed around a shared network, where the browsers look alike, it thins: a third holder ends the join, a fifth ends the tie.
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

  // With no secret set, there is nothing to sign with: the routes do not exist and tokens are ignored.
  const plain = createServer(createHandler(graph, { token: 'service', origins: ['https://site.example'] })).listen(0, '127.0.0.1')
  await new Promise((resolve) => plain.once('listening', resolve))
  try {
    const address = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`
    assert.equal((await fetch(`${address}/link`, { method: 'POST', headers: { authorization: 'Bearer service' }, body: '{}' })).status, 404)
    assert.equal((await fetch(`${address}/carry`, { method: 'POST', headers: { origin: 'https://site.example' }, body: '{}' })).status, 401)
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

test('steps give page events, calls and outcomes their value and their ad platform action', async () => {
  const store = createMemoryStore()
  const graph = createGraph(store)
  const at = Date.parse('2026-03-02T12:00:00Z')
  const sent: IngestRequest[] = []
  const outbox = createOutbox(graph, store.outbox, { targets: [googleAds({ customerId: '1234567890', send: async (request) => (sent.push(request), { requestId: 'r' }) })], now: () => at + 60_000 })
  const handler = createHandler(graph, {
    token: 'service',
    reviewToken: 'reviewer',
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
    // A page event needs only its name: the step says what it is worth and where it goes.
    assert.equal((await post('/event', { device: 'd-1', event: 'inquiry' }, { origin: 'https://site.example' })).status, 204)
    assert.deepEqual((await outbox.get(`inquiry:d-1:2026-03-02`)).map((job) => [job.target, job.action, job.value, job.currency]), [['google', '111', 5, 'USD']])
    // A step worth something counts once a day per browser, whatever id the page gives and however often it reports.
    assert.equal((await post('/event', { device: 'd-1', event: 'inquiry' }, { origin: 'https://site.example' })).status, 204)
    for (const id of ['a', 'b', 'c']) assert.equal((await post('/event', { device: 'd-1', event: 'inquiry', id }, { origin: 'https://site.example' })).status, 204)
    assert.deepEqual(await outbox.get('inquiry:d-1:a'), [])
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
    assert.deepEqual(sent.flatMap((request) => request.events.map((event) => [event.transactionId, event.conversionValue])).sort(), [['call:CA1', 10], ['inquiry:d-1:2026-03-02', 5]])

    // The report lists the steps in the order they were given, then any others by name.
    await post('/convert', { transactionId: 'other-1', subject: 'account:1', at, stage: 'brochure' })
    const report = (await (await fetch(`${base}/report?from=2026-03-02&to=2026-03-02`, { headers: { authorization: 'Bearer reviewer' } })).json()) as any
    assert.deepEqual(report.steps, ['inquiry', 'call', 'client', 'brochure'])
    assert.deepEqual(report.total.stages, { inquiry: { count: 1, value: 5 }, call: { count: 1, value: 10 }, client: { count: 2, value: 1450 }, brochure: { count: 1, value: 0 } })
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
  await assert.rejects(verify({ street: 'broke' }), /Smarty refused the address check with 402/)
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
  await assert.rejects(lookup('+15550000500'), /Twilio refused the lookup with 401/)
})

test('the server identifies a subject from plain facts, drops declared bots, and notes where a visit came from', async () => {
  const graph = createGraph(createMemoryStore())
  const at = 1_800_000_000_000
  const lines: Record<string, string> = { '+15550001111': 'mobile', '+15550002222': 'nonFixedVoip', '+18005550100': 'tollFree' }
  const handler = createHandler(graph, {
    token: 'service',
    reviewToken: 'reviewer',
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

    // The same address written another way is the same delivery point: a household, so related and not joined.
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
    // A lookup that is down does not lose the sighting: the number is kept as a plain phone.
    const sixth = await identify({ subject: 'account:6', phone: '+15550009999' })
    assert.deepEqual([kinds(sixth.identifiers), sixth.notes], [['phone'], {}])
    // The address service cannot be reached: the rest of the sighting is recorded and the note says why the address is not.
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
