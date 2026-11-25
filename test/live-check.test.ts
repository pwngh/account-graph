import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { liveCheck } from '../tools/live-check.ts'

type Env = Record<string, string>
const names = ['fingerprint', 'maxmind', 'google-token', 'google', 'meta', 'microsoft', 'tiktok', 'google-costs', 'meta-costs', 'smarty', 'twilio']

async function probe(args: string[], env: Env = {}, reply: Response = Response.json({})) {
  const calls: { url: URL; init: RequestInit | undefined }[] = []
  const lines: string[] = []
  const code = await liveCheck(args, env, async (url, init) => {
    calls.push({ url: new URL(String(url)), init })
    return reply.clone()
  }, (line) => lines.push(line))
  return { code, calls, output: lines.join('\n') }
}

test('live-check lists fixed disclosures and sends nothing for unknown, missing or incomplete choices', async () => {
  const list = await probe(['--list'])
  assert.equal(list.code, 0)
  assert.equal(list.calls.length, 0)
  for (const name of names) {
    assert.ok(list.output.includes(name + ': '))
    const run = await probe([name], { UNRELATED_TOKEN: 'private-value' })
    assert.notEqual(run.code, 0)
    assert.equal(run.calls.length, 0, name)
    assert.doesNotMatch(run.output, /private-value/)
  }
  for (const args of [[], ['all'], ['__proto__'], ['meta', 'smarty'], ['--invalid-key'], ['meta', '--typo']]) {
    const run = await probe(args)
    assert.notEqual(run.code, 0)
    assert.equal(run.calls.length, 0)
  }
})

test('live-check invalid-key mode uses only dummy values for only the named service', async () => {
  const run = await probe(['smarty', '--invalid-key'], { SMARTY_AUTH_ID: 'private-id', SMARTY_AUTH_TOKEN: 'private-token' }, new Response('private@example.org', { status: 401 }))
  assert.equal(run.code, 0)
  assert.equal(run.calls.length, 1)
  const { url, init } = run.calls[0]!
  assert.equal(url.hostname, 'us-street.api.smarty.com')
  assert.equal(init?.redirect, 'error')
  assert.ok(!Buffer.from(new Headers(init?.headers).get('authorization')!.slice(6), 'base64').toString().includes('private'))
  assert.doesNotMatch(run.output, /private|accepted key/)
  for (const reply of [Response.json([]), new Response('private@example.org', { status: 503 })]) {
    assert.notEqual((await probe(['smarty', '--invalid-key'], {}, reply)).code, 0)
  }
})

test('live-check returns a failure without printing service errors, arguments, paths or lookup results', async () => {
  const env = { SMARTY_AUTH_ID: 'private-id', SMARTY_AUTH_TOKEN: 'private-token' }
  const ok = await probe(['smarty'], env, Response.json([]))
  assert.equal(ok.calls.length, 1)
  assert.equal(ok.code, 0)
  for (const run of [
    await probe(['smarty'], env, new Response('private@example.org private-token', { status: 402 })),
    await probe(['google-token'], { GOOGLE_SERVICE_ACCOUNT_FILE: 'private-missing-filename' }),
    await probe(['private-user-argument']),
  ]) {
    assert.notEqual(run.code, 0)
    assert.doesNotMatch(run.output, /private/)
  }
})

test('the Smarty check discloses an optional license and sends only its configured value', async () => {
  const env = { SMARTY_AUTH_ID: 'private-id', SMARTY_AUTH_TOKEN: 'private-token', SMARTY_LICENSE: 'private & other=1' }
  const run = await probe(['smarty'], env, Response.json([]))
  assert.equal(run.code, 0)
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0]!.url.searchParams.get('license'), env.SMARTY_LICENSE)
  assert.equal(run.calls[0]!.url.searchParams.has('other'), false)
  assert.match(run.output, /optional license/)
  assert.doesNotMatch(run.output, /private/)
  const dummy = await probe(['smarty', '--invalid-key'], env, new Response('', { status: 401 }))
  assert.equal(dummy.calls[0]!.url.searchParams.has('license'), false)
})

test('live-check only confirms a matching Fingerprint event with an identification', async () => {
  const env = { FINGERPRINT_SECRET: 'private-token', FINGERPRINT_EVENT_ID: 'private-event' }
  for (const response of [new Response('', { status: 400 }), new Response('', { status: 404 }), Response.json({}), Response.json({ identification: { visitor_id: 'private-visitor' } }), Response.json({ event_id: 'some-other-id', identification: { visitor_id: 'private-visitor' } })]) {
    const run = await probe(['fingerprint'], env, response)
    assert.notEqual(run.code, 0)
    assert.doesNotMatch(run.output, /private|key accepted/)
  }
  const event = { event_id: 'private-event', timestamp: Date.now(), identification: { visitor_id: 'private-visitor', confidence: { score: 0.97 } } }
  for (const invalid of [
    { ...event, timestamp: Date.now() - 301_000 },
    { ...event, timestamp: Date.now() + 301_000 },
    { ...event, timestamp: undefined },
    ...[undefined, 'unavailable', 0.4, 1.3].map(score => ({ ...event, identification: { visitor_id: 'private-visitor', confidence: { score } } })),
  ]) {
    assert.notEqual((await probe(['fingerprint'], env, Response.json(invalid))).code, 0)
  }
  const run = await probe(['fingerprint'], env, Response.json(event))
  assert.equal(run.code, 0)
  assert.doesNotMatch(run.output, /private/)
})

test('live-check event uploads require a test code and send one synthetic event', async () => {
  for (const [name, key, env] of [
    ['meta', 'META_TEST_EVENT_CODE', { META_PIXEL_ID: '123456', META_ACCESS_TOKEN: 'private-token' }],
    ['tiktok', 'TIKTOK_TEST_EVENT_CODE', { TIKTOK_PIXEL_CODE: 'PIXEL', TIKTOK_ACCESS_TOKEN: 'private-token' }],
  ] as const) {
    assert.equal((await probe([name], env)).calls.length, 0)
    const run = await probe([name], { ...env, [key]: 'private-code' }, Response.json({ code: 0, events_received: 1, request_id: 'private-id' }))
    assert.equal(run.code, 0)
    assert.equal(run.calls.length, 1)
    const body = JSON.parse(String(run.calls[0]!.init?.body))
    assert.equal(body.test_event_code, 'private-code')
    assert.equal(body.data.length, 1)
    if (name === 'meta') assert.equal(body.data[0].action_source, 'other')
    assert.doesNotMatch(run.output, /private/)
  }
})

test('live-check stops at a second reporting page and checks lookup inputs before sending', async () => {
  const costs = await probe(['meta-costs'], { META_AD_ACCOUNT_ID: '1234', META_ADS_TOKEN: 'private-token' }, Response.json({ data: [], paging: { next: 'https://graph.facebook.com/second' } }))
  assert.equal(costs.calls.length, 1)
  assert.notEqual(costs.code, 0)
  for (const env of [{ MAXMIND_HOST: 'someone.example.org' }, { MAXMIND_SERVICE: '../outside' }]) {
    const run = await probe(['maxmind'], { MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'private-token', ...env })
    assert.notEqual(run.code, 0)
    assert.equal(run.calls.length, 0)
  }
  const twilio = await probe(['twilio'], { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'private-token' })
  assert.notEqual(twilio.code, 0)
  assert.equal(twilio.calls.length, 0)
})

test('live-check CLI exits nonzero on a failed check, and listing needs no credentials', () => {
  // Block the real fetch even if the CLI regresses to its old no-key sweep.
  const preload = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = () => { throw Error('private-network-error') }")
  const cmd = ['--import', preload, 'tools/live-check.ts']
  const failed = spawnSync(process.execPath, [...cmd, 'smarty'], { env: {}, encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  assert.doesNotMatch(failed.stdout + failed.stderr, /private-network-error/)
  assert.match(execFileSync(process.execPath, [...cmd, '--list'], { env: {}, encoding: 'utf8' }), /fingerprint: /)
})

test('live-check sends one validate-only Google event and can read an Ads report without a developer token', async () => {
  const dir = mkdtempSync('.live-check-test-')
  try {
    const file = join(dir, 'service-account.json')
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    writeFileSync(file, JSON.stringify({ private_key: key, client_email: 'proof@example.org' }), { mode: 0o600 })
    const env = { GOOGLE_SERVICE_ACCOUNT_FILE: file, GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CONVERSION_ACTION_ID: '1' }
    for (const name of ['google', 'google-costs']) {
      const calls: { url: string; init: RequestInit | undefined }[] = []
      const code = await liveCheck([name], env, async (input, init) => {
        calls.push({ url: String(input), init })
        if (calls.length === 1) return Response.json({ access_token: 'private-token' })
        return Response.json(name === 'google' ? { requestId: 'private-id' } : [])
      }, line => assert.doesNotMatch(line, /private-token|private-id/))
      assert.equal(code, 0)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]!.url, 'https://oauth2.googleapis.com/token')
      const request = calls[1]!
      if (name === 'google') {
        const body = JSON.parse(String(request.init?.body))
        assert.equal(body.validateOnly, true)
        assert.equal(body.events.length, 1)
      } else {
        assert.equal(new URL(request.url).hostname, 'googleads.googleapis.com')
        assert.equal(new Headers(request.init?.headers).has('developer-token'), false)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('live-check recognizes the MaxMind reserved-IP result and confines the published address to the sandbox', async () => {
  const env = { MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'private-key' }
  const reserved = await probe(['maxmind'], env, Response.json({ code: 'IP_ADDRESS_RESERVED' }, { status: 400 }))
  assert.equal(reserved.code, 0)
  assert.equal(reserved.calls.length, 1)
  assert.equal(reserved.calls[0]!.url.pathname, '/geoip/v2.1/insights/192.0.2.1')
  const sandbox = await probe(['maxmind'], { ...env, MAXMIND_HOST: 'sandbox.maxmind.com' }, Response.json({ country: { iso_code: 'US' } }))
  assert.equal(sandbox.code, 0)
  assert.equal(sandbox.calls[0]!.url.href, 'https://sandbox.maxmind.com/geoip/v2.1/insights/65.116.3.80')
})

test('live-check requires the expected Smarty and Twilio response shapes', async () => {
  assert.notEqual((await probe(['smarty'], { SMARTY_AUTH_ID: '1', SMARTY_AUTH_TOKEN: 'private-key' }, Response.json({}))).code, 0)
  const env = { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'private-key', TWILIO_LOOKUP_NUMBER: '+12025550104' }
  for (const reply of [{ valid: false, line_type_intelligence: { type: 'mobile' } }, { valid: true }, { valid: true, line_type_intelligence: { error_code: 60601 } }]) {
    assert.notEqual((await probe(['twilio'], env, Response.json(reply))).code, 0)
  }
  const ok = await probe(['twilio'], env, Response.json({ valid: true, line_type_intelligence: { type: 'mobile' } }))
  assert.equal(ok.code, 0)
  assert.doesNotMatch(ok.output, /5550104|mobile|private-key/)
})

test('live-check refuses malformed Ads and dataset IDs before reading a key or requesting a token', async () => {
  for (const [name, env] of [
    ['google', { GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CONVERSION_ACTION_ID: '1/2' }],
    ['google-costs', { GOOGLE_ADS_CUSTOMER_ID: '12345a67890' }],
    ['google-costs', { GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '12-3456-7890' }],
    ['meta', { META_PIXEL_ID: '../123', META_ACCESS_TOKEN: 'token', META_TEST_EVENT_CODE: 'code' }],
    ['meta-costs', { META_AD_ACCOUNT_ID: 'act_0', META_ADS_TOKEN: 'token' }],
  ] as const) {
    const run = await probe([name], { GOOGLE_SERVICE_ACCOUNT_FILE: 'unused', ...env }, Response.json({ events_received: 1, data: [] }))
    assert.equal(run.code, 2, name)
    assert.equal(run.calls.length, 0)
  }
})

test('the final Google transport blocks a different method, destination, event, value, count or validation mode', async () => {
  const { probeTransport } = await import('../tools/live-check.ts')
  const fixture = { transactionId: 'unit', at: 0, email: 'proof@example.org' }
  const env = { GOOGLE_ADS_CUSTOMER_ID: '123-456-7890', GOOGLE_ADS_LOGIN_CUSTOMER_ID: '555-123-4567', GOOGLE_ADS_CONVERSION_ACTION_ID: '123' }
  const { ingestRequest } = await import('../src/providers/conversions.ts')
  const valid = ingestRequest({ customerId: '1234567890', loginCustomerId: '5551234567', conversionActionId: '123' }, [fixture], true)
  const url = 'https://datamanager.googleapis.com/v1/events:ingest'
  const event = valid.events[0]!
  const destination = valid.destinations[0]!
  const account = { accountType: 'GOOGLE_ADS', accountId: '5551234567' }
  for (const [endpoint, method, body] of [
    [url, 'GET', valid],
    [url + '?validateOnly=false', 'POST', valid],
    [url.replace('datamanager', 'googleads'), 'POST', valid],
    [url, 'POST', { ...valid, validateOnly: false }],
    [url, 'POST', { ...valid, destinations: [{ ...destination, productDestinationId: '456' }] }],
    [url, 'POST', { ...valid, destinations: [{ ...destination, operatingAccount: account }] }],
    [url, 'POST', { ...valid, destinations: [destination, destination] }],
    [url, 'POST', { ...valid, events: [event, event] }],
    [url, 'POST', { ...valid, events: [{ ...event, transactionId: 'different' }] }],
    [url, 'POST', { ...valid, events: [{ ...event, eventTimestamp: '2001-01-01T00:00:00.000Z' }] }],
    [url, 'POST', { ...valid, events: [{ ...event, conversionValue: 3 }] }],
    [url, 'POST', { ...valid, events: [{ ...event, userData: { userIdentifiers: [{ emailAddress: 'other' }] } }] }],
  ] as const) {
    let calls = 0
    const transport = probeTransport('google', env, true, fixture, async () => { calls++; return Response.json({}) })
    await assert.rejects(transport.send(endpoint, { method, body: JSON.stringify(body) }))
    assert.equal(calls, 0)
  }
})

test('every named check confines dummy credentials to its declared first endpoint', async () => {
  const { probeTransport } = await import('../tools/live-check.ts')
  for (const name of names) {
    let calls = 0
    const env = { GOOGLE_ADS_CUSTOMER_ID: '1234567890', GOOGLE_ADS_CONVERSION_ACTION_ID: '123', META_AD_ACCOUNT_ID: '123', META_PIXEL_ID: '456', FINGERPRINT_EVENT_ID: 'test', TWILIO_LOOKUP_NUMBER: '+12025550104' }
    const transport = probeTransport(name as Parameters<typeof probeTransport>[0], env, true, { transactionId: 'test', at: 0, email: 'proof@example.org' }, async () => { calls++; return Response.json({}) })
    for (const url of ['https://example.org/x', 'https://user@oauth2.googleapis.com/token', 'http://oauth2.googleapis.com/token']) {
      await assert.rejects(transport.send(url, { method: 'POST' }))
    }
    assert.equal(calls, 0, name)
  }
})

test('a flagged Fingerprint event or Meta diagnostic does not pass the probe', async () => {
  const id = 'qa-event'
  for (const flags of [{ bot: 'bad' }, { tampering: true }]) {
    const run = await probe(['fingerprint'], { FINGERPRINT_SECRET: 'private-key', FINGERPRINT_EVENT_ID: id }, Response.json({ event_id: id, timestamp: Date.now(), identification: { visitor_id: 'private-visitor', confidence: { score: 0.97 } }, ...flags }))
    assert.notEqual(run.code, 0)
    assert.doesNotMatch(run.output, /private/)
  }
  const env = { META_PIXEL_ID: '123', META_ACCESS_TOKEN: 'private-token', META_TEST_EVENT_CODE: 'private-code' }
  for (const messages of [['private diagnostic'], {}]) {
    const run = await probe(['meta'], env, Response.json({ events_received: 1, messages }))
    assert.notEqual(run.code, 0)
    assert.doesNotMatch(run.output, /private/)
  }
})
