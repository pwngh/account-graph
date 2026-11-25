import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configFrom } from '../src/bin.ts'
import { credentials } from '../src/edge/tokens.ts'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'

test('invalid service credentials fail before the first request and errors omit secrets', async () => {
  const local = accountGraph({ memory: true })
  const entry = { name: 'intake', token: 'private-value', calls: {} }
  const options = { token: 'root-secret', reviewers: { dana: ['old-secret', 'new-secret'] } }
  try {
    for (const serviceTokens of [
      {}, [null], [{ ...entry, access: true }], [entry, { ...entry, name: 'other' }], [entry, { ...entry, token: 'second' }],
      ...['', ' ', 'root-secret', 'old-secret', 'new-secret', 'trailing '].map(token => [{ ...entry, token }]),
      ...['service', 'people', 'system:intake', 'dana', 'private-value', 'log\nline'].map(name => [{ ...entry, name }]),
      ...[undefined, null, [], { record: false }, { erase: true }, { forget: [] }, { decide: ['unknown'] }, { record: ['toString'] }, { lookup: 'find' }, { report: [false] }].map(calls => [{ ...entry, calls }]),
    ]) assert.throws(() => createEdge(local, { ...options, serviceTokens } as any), (error: Error) => !/private-value|root-secret|old-secret|new-secret/.test(error.message) && /token|serviceTokens/i.test(error.message))
    assert.throws(() => createEdge(local, { token: '' }), /token/)
    createEdge(local, { ...options, serviceTokens: [{ ...entry, calls: { record: [], report: [] } }] })
  } finally {
    await local.close()
  }
})

test('the CLI reads named tokens from JSON or their file and catches a repeated reviewer name', () => {
  const env = { DATABASE_URL: 'unused', RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'root' }
  const list = [{ name: 'intake', token: 'intake-secret', calls: { record: ['profile'] } }]
  const dir = mkdtempSync(join(tmpdir(), 'service-tokens-'))
  try {
    const file = join(dir, 'tokens.json')
    writeFileSync(file, JSON.stringify(list))
    for (const source of [{ SERVICE_TOKENS: JSON.stringify(list) }, { SERVICE_TOKENS_FILE: file }]) assert.deepEqual(configFrom({ ...env, ...source }).edge.serviceTokens, list)
    for (const source of [{ SERVICE_TOKENS: '' }, { SERVICE_TOKENS: '{}' }, { SERVICE_TOKENS_FILE: file + '.missing' }, { SERVICE_TOKENS: '[]', SERVICE_TOKENS_FILE: file }]) assert.throws(() => configFrom({ ...env, ...source }), /SERVICE_TOKENS/)
    assert.throws(() => configFrom({ ...env, REVIEW_TOKENS: '{"name":"x","nam\\u0065":"y"}' }), /unique names/)
    assert.throws(() => configFrom({ ...env, SERVICE_TOKENS: JSON.stringify(list), REVIEW_TOKENS: '{"name":"intake-secret"}' }), /unique nonempty token/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('each request compares every fixed-size token digest regardless of which credential matched', t => {
  const compare = t.mock.method(crypto, 'timingSafeEqual')
  syncBuiltinESMExports()
  try {
    const owner = credentials('root', { dana: ['old', 'current'] }, [{ name: 'input', token: 'service-secret', calls: {} }])
    for (const key of ['root', 'old', 'current', 'service-secret', 'unknown', '']) {
      compare.mock.resetCalls()
      owner(key ? 'Bearer ' + key : undefined)
      assert.deepEqual(compare.mock.calls.map(call => call.arguments.map(arg => arg.byteLength)), Array(4).fill([32, 32]))
    }
  } finally {
    compare.mock.restore()
    syncBuiltinESMExports()
  }
})
