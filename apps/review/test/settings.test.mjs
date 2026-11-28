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
