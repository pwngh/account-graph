import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { signed, toCall } from '../examples/call-tracking.ts'
import type { Item } from '../src/core/outbox.ts'
import { ingest, ingestRequest } from '../src/providers/conversions.ts'
import { googleCosts, metaCosts } from '../src/providers/costs.ts'
import { createFingerprintVerifier, trusted } from '../src/providers/fingerprint.ts'
import { createMaxMindLookup, placeOf, shared } from '../src/providers/maxmind.ts'
import { addressIdentifier, createAddressVerifier } from '../src/providers/smarty.ts'
import { meta, microsoftAds, tiktok } from '../src/providers/targets.ts'
import { fromTwilio } from '../src/providers/twilio.ts'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/providers/signed.json', import.meta.url), 'utf8'))
const responses = JSON.parse(readFileSync(new URL('./fixtures/providers/responses.json', import.meta.url), 'utf8'))
const reply = (body: unknown): typeof fetch => async () => Response.json(body)
const day = '2026-11-24'

function item(target: string): Item {
  return {
    job: { target, transactionId: 'example', subject: 'account:example', at: Date.parse(day), action: 'Lead', keys: {}, state: 'pending', attempts: 1, due: 0 },
    touch: undefined,
    consent: undefined,
  }
}

test('Twilio verifies its published form and rejects a different URL or field', () => {
  const { key, url, fields, signature } = vectors.twilio
  assert.equal(fromTwilio(key, url, fields, signature), true)
  assert.equal(fromTwilio(key, url + '/', fields, signature), false)
  assert.equal(fromTwilio(key, url, { ...fields, Digits: '1230' }, signature), false)
})

test('CallRail signs the raw body, and a voicemail is mapped from it', () => {
  const body = JSON.stringify({ id: 900100, answered: false, voicemail: true, direction: 'inbound', duration: 13, customer_phone_number: '+12025550142', tracking_phone_number: '+12025550101', start_time: '2026-11-24T12:41:00.236-06:00' })
  const signature = createHmac('sha1', 'example').update(body).digest('base64')
  assert.equal(signed(Buffer.from(body), signature, 'example'), true)
  assert.equal(signed(Buffer.from(body + '\n'), signature, 'example'), false)
  const result = toCall(JSON.parse(body))
  assert.ok('call' in result && result.call.type === 'call')
  assert.equal(result.call.key, 'callrail-900100')
  assert.equal(result.call.at, Date.parse('2026-11-24T18:41:00.236Z'))
  assert.equal(result.call.duration, 13)
  assert.deepEqual(result.call.result, { answered: false, voicemail: true })
})

test('Google returns the request ID and field warning from its published ingest response', async () => {
  const request = ingestRequest({ customerId: '1234567890', conversionActionId: '7' }, [
    { transactionId: 'example', at: Date.parse(day), email: 'sample@example.org' },
  ])
  const receipt = await ingest(request, 'example', reply(responses.google))
  assert.equal(receipt.requestId, '126365e1-16d0-4c81-9de9-f362711e250a')
  assert.equal(receipt.fieldWarnings?.length, 1)
  assert.deepEqual(receipt.fieldWarnings?.[0], responses.google.fieldWarnings[0])
})

test('Meta reads the trace ID from its documented receipt shape', async () => {
  const target = meta({ pixelId: '7', accessToken: 'example', url: 'https://example.org/', fetch: reply(responses.meta) })
  assert.deepEqual(await target.deliver('Lead', [item('meta')]), { requestId: 'example-meta-receipt' })
})

test('Microsoft treats an indexed partial refusal in a 200 response as an error', async () => {
  const target = microsoftAds({ customerId: '7', customerAccountId: '8', accessToken: 'example', developerToken: 'example', sandbox: true, fetch: reply(responses.microsoft) })
  await assert.rejects(target.deliver('Lead', [item('microsoft')]), /ExampleError/)
})

test('TikTok reads the request ID from its published success response', async () => {
  const target = tiktok({ pixelCode: '7', accessToken: 'example', url: 'https://example.org/', fetch: reply(responses.tiktok) })
  assert.deepEqual(await target.deliver('CompleteRegistration', [item('tiktok')]), { requestId: '{{request_id}}' })
})

test('the reporting readers turn their documented envelopes into daily costs', async () => {
  const google = googleCosts({ customerId: '7', developerToken: 'example', accessToken: async () => 'example', fetch: reply(responses.googleCosts) })
  const meta = metaCosts({ adAccountId: '7', accessToken: 'example', fetch: reply(responses.metaCosts) })
  const cost = { day, campaignId: '7', campaign: 'Example', amount: 1.25, currency: 'USD', clicks: 3, impressions: 20 }
  assert.deepEqual(await google(day, day), [{ source: 'google', ...cost }])
  assert.deepEqual(await meta(day, day), [{ source: 'meta', ...cost }])
})

test('MaxMind reads the place and network type from its published sandbox example', async () => {
  const lookup = createMaxMindLookup({ accountId: '7', licenseKey: 'example', fetch: reply(responses.maxmind) })
  const info = await lookup('65.116.3.80')
  assert.equal(placeOf(info), 'US/TX/Houston')
  assert.equal(info?.asn, 209)
  assert.equal(info?.userType, 'residential')
  assert.equal(shared(info), false)
})

test('Smarty reads the commercial delivery point in its published example', async () => {
  const lookup = createAddressVerifier({ authId: 'example', authToken: 'example', fetch: reply(responses.smarty) })
  const address = await lookup({ street: '1 Santa Claus Ln', city: 'North Pole', state: 'AK' })
  assert.deepEqual(address, { barcode: '997059901010', line1: '1 Santa Claus Ln', lastLine: 'North Pole AK 99705-9901', match: 'Y', residential: false, mailDrop: false, vacant: false })
  assert.ok(addressIdentifier(address!))
})

test('Fingerprint reads and dates the identification in the published device event shape', async () => {
  const verify = createFingerprintVerifier({ secretKey: 'example', fetch: reply(responses.fingerprint) })
  const event = await verify('1708102555327.NLOjmg')
  assert.ok(event)
  assert.equal(event.eventId, '1708102555327.NLOjmg')
  assert.equal(event.visitorId, 'example-visitor')
  assert.equal(event.confidence, 0.97)
  assert.equal(trusted(event, { now: 1708102555327 }), true)
  assert.equal(trusted(event, { now: 1708102555327 + 300_001 }), false)
})
