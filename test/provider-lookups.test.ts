import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readEnvironment } from '../src/bin.ts'
import { checksOf } from '../src/client/providers.ts'
import { createFingerprintVerifier, trusted } from '../src/providers/fingerprint.ts'
import { createMaxMindLookup } from '../src/providers/maxmind.ts'
import { createAddressVerifier } from '../src/providers/smarty.ts'
import { createLineTypeLookup, twilioText } from '../src/providers/twilio.ts'

test('Smarty sends the selected license as one query value only when configured', async () => {
  const env = { DATABASE_URL: 'postgres://127.0.0.1/test', GRAPH_TOKEN: 'test', RECEIPT_SECRETS: 'a'.repeat(32), SMARTY_AUTH_ID: 'test', SMARTY_AUTH_TOKEN: 'test' }
  for (const license of [undefined, 'test & other=1']) {
    const smarty = readEnvironment({ ...env, SMARTY_LICENSE: license }).smarty
    assert.ok(smarty)
    const checks = checksOf({ memory: true, checks: { address: smarty }, fetch: async input => {
      const query = new URL(String(input)).searchParams
      assert.deepEqual([...query], [['street', 'Example'], ['candidates', '1'], ...(license ? [['license', license]] : [])])
      return Response.json([])
    } })
    await checks.address!({ street: 'Example' })
  }
})

test('Smarty sends each address field whole, or asks nothing', async () => {
  const lengths = { street: 50, street2: 50, secondary: 32, city: 64, state: 32, zipcode: 16 }
  const sent: URLSearchParams[] = []
  const verify = createAddressVerifier({ authId: 'test', authToken: 'test', fetch: async (input) => {
    sent.push(new URL(String(input)).searchParams)
    return Response.json([])
  } })
  const full = Object.fromEntries(Object.entries(lengths).map(([name, length]) => [name, 'X'.repeat(length)])) as { street: string }
  await verify(full)
  for (const [name, length] of Object.entries(lengths)) assert.equal(sent[0]!.get(name), 'X'.repeat(length), name)
  for (const [name, length] of Object.entries(lengths)) assert.equal(await verify({ ...full, [name]: 'X'.repeat(length + 1) }), undefined, name)
  await verify({ street: 'X'.repeat(100), city: ' ' })
  assert.equal(sent[1]!.get('street'), 'X'.repeat(100))
  assert.equal(await verify({ street: 'X'.repeat(101) }), undefined)
  assert.equal(sent.length, 2)
})

test('an empty Twilio line type is an answer and is kept', async () => {
  for (const type of [null, '']) {
    let calls = 0
    const lookup = createLineTypeLookup({ accountSid: 'test', authToken: 'test', fetch: async () => Response.json({ valid: true, line_type_intelligence: { type, error_code: null } }, { status: ++calls && 200 }) })
    for (let i = 0; i < 3; i++) assert.equal((await lookup('+12025550102'))?.type, 'unknown')
    assert.equal(calls, 1)
  }
})

test('a missing Twilio line type is looked up again and a settled answer is cached', async () => {
  for (const incomplete of [{}, { line_type_intelligence: null }, { valid: false, line_type_intelligence: { type: 'landline' } }]) {
    let calls = 0
    const lookup = createLineTypeLookup({ accountSid: 'test', authToken: 'test', fetch: async () =>
      Response.json(++calls === 1 ? incomplete : { line_type_intelligence: { type: 'mobile' } }) })
    assert.equal((await lookup('+12025550102'))?.type, 'unknown')
    assert.equal((await lookup('+12025550102'))?.type, 'mobile')
    await lookup('+12025550102')
    assert.equal(calls, 2)
  }
})

test('an outbound MessageStatus callback is never an incoming text', () => {
  const fields = { MessageSid: 'SM-test', From: '+12025550102', To: '+12025550103' }
  assert.equal(twilioText({ ...fields, MessageStatus: 'delivered' }, 1), undefined)
  assert.equal(twilioText({ ...fields, MessageStatus: 'sent', SmsStatus: 'received' }, 1), undefined)
  assert.equal(twilioText({ ...fields, MessageStatus: 'received' }, 1)?.id, fields.MessageSid)
})

test('MaxMind accepts its sandbox and refuses an unknown host or service before a request', async () => {
  const env = { DATABASE_URL: 'postgres://127.0.0.1/test', GRAPH_TOKEN: 'test', RECEIPT_SECRETS: 'a'.repeat(32), MAXMIND_ACCOUNT_ID: '1', MAXMIND_LICENSE_KEY: 'test' }
  const options = readEnvironment({ ...env, MAXMIND_HOST: 'sandbox.maxmind.com' }).maxmind!
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://sandbox.maxmind.com/geoip/v2.1/insights/192.0.2.1')
    assert.equal(init?.redirect, 'error')
    return Response.json({ code: 'IP_ADDRESS_RESERVED' }, { status: 400 })
  }
  assert.equal(await createMaxMindLookup({ ...options, fetch: fetcher })('192.0.2.1'), undefined)
  for (const bad of [{ host: 'outside.example.org' }, { service: '../other' }]) {
    assert.throws(() => createMaxMindLookup({ ...options, ...bad } as typeof options), /MaxMind/i)
  }
  assert.throws(() => readEnvironment({ ...env, MAXMIND_HOST: 'outside.example.org' }), /MAXMIND_HOST/)
  // Without keys nothing is asked of MaxMind, and its settings stop nothing.
  const { MAXMIND_ACCOUNT_ID: _, MAXMIND_LICENSE_KEY: __, ...none } = env as Record<string, string>
  assert.equal(readEnvironment({ ...none, MAXMIND_HOST: 'outside.example.org', MAXMIND_SERVICE: 'other' }).maxmind, undefined)
  assert.throws(() => readEnvironment({ ...env, MAXMIND_SERVICE: '../other' }), /MAXMIND_SERVICE/)
})

test('Fingerprint requires the requested event and distinguishes unavailable paid signals', async () => {
  const event = { event_id: 'example-id', timestamp: 100, identification: { visitor_id: 'example-visitor', confidence: { score: 0.97 } } }
  const verify = createFingerprintVerifier({ secretKey: 'test', fetch: async () => Response.json(event) })
  assert.equal(await verify('different-event'), undefined)
  const match = await verify('example-id')
  assert.ok(match)
  assert.equal(match.bot, undefined)
  assert.equal(match.tampering, undefined)
  assert.equal(match.vpn, undefined)
  assert.equal(match.proxy, undefined)
  assert.equal(match.incognito, undefined)
  assert.equal(trusted({ ...match, confidence: NaN }, { now: 100 }), false)
  assert.equal(trusted({ ...match, at: NaN }, { now: 100 }), false)
})
