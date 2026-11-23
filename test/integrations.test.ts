import assert from 'node:assert/strict'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createGraph, createMemoryStore } from '../src/index.ts'
import { createFingerprintVerifier, trusted } from '../src/integrations/fingerprint.ts'
import type { VerifiedFingerprint } from '../src/integrations/fingerprint.ts'
import { createGoogleTokens } from '../src/integrations/google-auth.ts'
import { hardwareId, machineId } from '../src/integrations/hardware.ts'
import { createDatabaseLookup, createMaxMindLookup, shared } from '../src/integrations/maxmind.ts'
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

    // Later the page has lost its id and made a new one. The cookie still names the same visitor.
    await visit({ device: 'page-id-2' }, { cookie: 'other=1; ag_device=page-id-1' })
    assert.equal((await graph.history('visitor:page-id-1')).filter((s) => s.identifier.startsWith('device:')).length, 2)
    assert.deepEqual(await graph.history('visitor:page-id-2'), [])

    // No id from the page and no cookie: the server makes one.
    const blank = await visit({})
    assert.match(blank.headers.get('set-cookie')!, /^ag_device=[0-9a-f-]{36}; /)

    // An opted-out browser is still seen, but its ad click and analytics id are not kept.
    await visit({ device: 'private-1', ga: '1.2', canvas: 'c9', touch: { gclid: 'G-PRIVATE' } }, { 'sec-gpc': '1' })
    assert.deepEqual((await graph.history('visitor:private-1')).map((s) => s.identifier.split(':')[0]).sort(), ['canvas', 'device', 'ip'])
    assert.equal((await graph.attribute('visitor:private-1', { at: T0 })).reason, 'no_touch')
    assert.deepEqual((await graph.consentOf(['visitor:private-1'])).get('visitor:private-1'), { adUserData: false, adPersonalization: false })

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
    assert.equal(profile.history.length, 2)
    assert.deepEqual(await (await fetch(`${base}/subject?subject=nobody`, { headers: auth })).json(), { subject: 'nobody', known: false })
    assert.deepEqual(await (await fetch(`${base}/clusters`, { headers: auth })).json(), [{ id: 'account:1', size: 3, oversized: false }])

    // A reviewer joins two accounts by hand; the decision is on the record.
    const joined = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ a: 'account:9', b: 'account:3', by: 'dana', reason: 'same caller' }) })
    // 1 and 9 are kept apart, and 3 is tied to 1 by an email. The reviewer's join outweighs the email, so 3 leaves 1 and goes with 9.
    assert.deepEqual(await joined.json(), [
      { subject: 'account:3', from: 'account:1', to: 'account:3' },
      { subject: 'account:9', from: 'account:9', to: 'account:3' },
    ])
    const decisions = (await (await fetch(`${base}/decisions`, { headers: auth })).json()) as any[]
    assert.deepEqual(decisions.map((d) => [d.action, d.about, d.by]), [
      ['separate', ['account:1', 'account:9'], undefined],
      ['join', ['account:3', 'account:9'], 'dana'],
    ])
    assert.deepEqual(await graph.separations('account:1'), ['account:9'])
    assert.deepEqual((await graph.cluster('account:9'))!.members, ['account:3', 'account:9'])
    assert.deepEqual((await graph.cluster('account:1'))!.members, ['account:1', 'account:2'])
  } finally {
    server.close()
  }
})
