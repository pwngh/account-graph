import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewListener } from '../server.mjs'

test('the session secret from compose.yaml is refused at an address outside this machine, and an empty origin is no origin', async () => {
  const secret = 'change-me-review-session-secret-now'
  for (const origin of ['https://review.example.org', 'http://192.0.2.10:3100']) await assert.rejects(reviewListener({ secret, origin }), /Change REVIEW_SESSION_SECRET before serving reviewers at/, origin)
  // On this machine it is for trying the app out. Compose passes a setting that is not set as an empty one.
  for (const origin of ['http://localhost:3100', 'http://127.0.0.1:3100', '']) (await reviewListener({ secret, origin })).stop()
  // A secret of the firm's own is taken at any address.
  ;(await reviewListener({ secret: 'a'.repeat(40), origin: 'https://review.example.org' })).stop()
})

test('behind a proxy the sender is whoever the outermost proxy took the request from, and without one it is the connection', async () => {
  const secret = 'a'.repeat(40)
  // The setting of whoever runs the tests is not the one under test.
  delete process.env.REVIEW_TRUST_PROXY
  const made = async (trustProxy) => {
    const listener = await reviewListener({ secret, trustProxy })
    listener.stop()
    return listener.config.addressOf
  }
  // No proxy is trusted unless the setting says so. What the sender wrote is then only words.
  for (const none of [undefined, false, 'false', '', 0]) assert.equal((await made(none))('198.51.100.7', '10.0.0.1'), '10.0.0.1', String(none))
  // One proxy appends the address it took the request from. Anything before it, the sender wrote.
  for (const one of [true, 'true', 1, '1']) assert.equal((await made(one))('203.0.113.9, 198.51.100.7', '10.0.0.1'), '198.51.100.7', String(one))
  assert.equal((await made(2))('203.0.113.9, 198.51.100.7, 10.0.0.2', '10.0.0.1'), '198.51.100.7')
  assert.equal((await made(2))(['203.0.113.9', '198.51.100.7, 10.0.0.2'], '10.0.0.1'), '198.51.100.7')
  // A proxy that wrote nothing leaves the connection's address.
  assert.equal((await made(1))(undefined, '10.0.0.1'), '10.0.0.1')
  assert.equal((await made(3))('198.51.100.7', '10.0.0.1'), '10.0.0.1')
  // One sender is one sender however the proxy writes them: with a port, in brackets, or as an IPv4 address inside an IPv6 one.
  const one = await made(1)
  assert.deepEqual(['198.51.100.7:4411', ' 198.51.100.7 ', '::ffff:198.51.100.7', '[::FFFF:198.51.100.7]:4411'].map((written) => one(written, '10.0.0.1')), Array(4).fill('198.51.100.7'))
  assert.deepEqual(['2001:DB8::1', '[2001:db8:0:0:0:0:0:1]:443', '2001:0db8::0001'].map((written) => one(written, '10.0.0.1')), Array(3).fill('2001:db8::1'))
  // What is in a proxy's place and is no address, or nothing, leaves the connection's. It does not pull an earlier entry forward.
  for (const written of ['203.0.113.9, unknown', '203.0.113.9,', '203.0.113.9, ', 'not an address']) assert.equal(one(written, '10.0.0.1'), '10.0.0.1', written)
  for (const wrong of ['yes', -1, 11, 1.5]) await assert.rejects(reviewListener({ secret, trustProxy: wrong }), /REVIEW_TRUST_PROXY/, String(wrong))
})
