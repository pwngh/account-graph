import assert from 'node:assert/strict'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createGraph, createMemoryStore, createOutbox, googleAds, hashPhone } from '../src/index.ts'
import type { IngestRequest } from '../src/index.ts'
import { CostError, costsFromCsv, googleCosts, metaCosts } from '../src/integrations/costs.ts'
import { createFingerprintVerifier, trusted } from '../src/integrations/fingerprint.ts'
import type { VerifiedFingerprint } from '../src/integrations/fingerprint.ts'
import { createGoogleTokens } from '../src/integrations/google-auth.ts'
import { createMicrosoftTokens } from '../src/integrations/microsoft-auth.ts'
import { hardwareId, machineId } from '../src/integrations/hardware.ts'
import { createDatabaseLookup, createMaxMindLookup, shared } from '../src/integrations/maxmind.ts'
import { fromTwilio, twilioCall, twilioSignature } from '../src/integrations/twilio.ts'
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

    // A reviewer joins two accounts by hand; the decision is on the record.
    const joined = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ a: 'account:9', b: 'account:3', by: 'dana', reason: 'same caller' }) })
    // 1 and 9 are kept apart, and 3 is tied to 1 by an email. The reviewer's join outweighs the email, so 3 leaves 1 and goes with 9.
    assert.deepEqual(await joined.json(), [
      { subject: 'account:3', from: 'account:1', to: 'account:3' },
      { subject: 'account:9', from: 'account:9', to: 'account:3' },
    ])
    const bad = await fetch(`${base}/join`, { method: 'POST', headers: auth, body: JSON.stringify({ a: 1, b: 2 }) })
    assert.equal(bad.status, 400)
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
    for (const path of ['/subject?subject=account:1', '/clusters', '/clusters?offset=50', '/search?q=account', '/recent', '/links?subject=account:1', '/flows?subject=account:1', '/decisions', '/audit']) {
      assert.equal(await call('reviewer', 'GET', path), 200, path)
    }
    assert.equal(await call('reviewer', 'POST', '/separate', { a: 'account:1', b: 'account:2', by: 'dana' }), 200)
    assert.equal(await call('reviewer', 'POST', '/join', { a: 'account:1', b: 'account:3' }), 200)
    assert.equal(await call('reviewer', 'POST', '/ignore', { identifier: 'email:e' }), 200)

    const before = await graph.history('account:1')
    assert.equal(await call('reviewer', 'POST', '/observe', { subject: 'account:1', identifiers: ['email:x'], at: T0 }), 403)
    assert.equal(await call('reviewer', 'POST', '/transfer', { from: 'account:1', to: 'account:2', amount: 5, at: T0 }), 403)
    assert.equal(await call('reviewer', 'POST', '/touch', { subject: 'account:1', at: T0, gclid: 'G' }), 403)
    assert.equal(await call('reviewer', 'POST', '/consent', { subject: 'account:1', consent: { adUserData: true, adPersonalization: true } }), 403)
    assert.equal(await call('reviewer', 'POST', '/convert', {}), 403)
    assert.equal(await call('reviewer', 'GET', '/verify'), 403)
    assert.deepEqual(await graph.history('account:1'), before)

    assert.equal(await call('service', 'POST', '/observe', { subject: 'account:1', identifiers: ['email:x'], at: T0 }), 200)
    assert.equal(await call('service', 'GET', '/clusters'), 200)
    assert.equal(await call('wrong', 'GET', '/clusters'), 401)
    assert.equal(await call('', 'GET', '/clusters'), 401)
    assert.throws(() => createHandler(graph, { token: 'same', reviewToken: 'same', origins: [] }), TypeError)
  } finally {
    server.close()
  }
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
