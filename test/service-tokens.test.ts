import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configFrom } from '../src/bin.ts'
import { credentials, limitedCall } from '../src/edge/tokens.ts'
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
  const env = { DATABASE_URL: 'unused', IDENTIFIER_SECRET: 'i'.repeat(32), RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: 'root' }
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

test('forbidden keyed requests never dispatch a receipt lookup', async () => {
  const owner = { role: 'limited', name: 'intake', calls: { record: ['profile', 'call_update'], decide: ['split'], forget: true } } as const
  const at = 1_790_000_000_000
  const dispatch = async () => assert.fail('the request reached the graph')
  for (const key of ['previously-used', 'fresh']) {
    const split = { at, key, action: 'split', by: 'system:intake', pairs: [{ a: 'contact:one', b: 'contact:two' }] }
    await assert.rejects(limitedCall(owner, 'decide', { ...split, action: 'merge' }, dispatch), { code: 'AUTH.FORBIDDEN' })
    await assert.rejects(limitedCall(owner, 'decide', { ...split, by: 'dana' }, dispatch), { code: 'AUTH.FORBIDDEN' })
    const forget = { at, key, by: 'dana', subjects: ['contact:one'], platforms: 'report' }
    await assert.rejects(limitedCall(owner, 'forget', forget, dispatch), { code: 'AUTH.FORBIDDEN' })
    const entries = [{ type: 'conversion', at, key, subject: 'contact:one', stage: 'sale' },
      { type: 'call_update', at, key, call: 'ring', change: { kind: 'party', role: 'unknown', by: 'dana' } }]
    assert.deepEqual(await limitedCall(owner, 'record', { entries }, dispatch), { results: entries.map(({ type }) => ({ type, key, ok: false, reason: 'FORBIDDEN' })) })
  }
})

test('a named service signs a return with its own name or none, never with another', async () => {
  const owner = { role: 'limited', name: 'intake', calls: { record: ['call_update', 'restatement'] } } as const
  const at = 1_790_000_000_000
  const reached = (key: string, by?: string) => ({ type: 'call_update', at, key, call: 'ring', change: { kind: 'returned', reachedAt: at, ...(by && { by }) } })
  const spam = (key: string, by?: string) => ({ type: 'restatement', at, key, of: { type: 'call', key: 'ring' }, change: { kind: 'not_lead', why: 'spam', ...(by && { by }) } })
  // A statement about a sale is signed by the same rule as one about a call.
  const sale = (key: string, by?: string) => ({ ...spam(key, by), of: { type: 'conversion', key: 'sale-1' } })
  const entries = [reached('own', 'system:intake'), reached('none'), reached('other', 'dana'), spam('own-spam', 'system:intake'), spam('other-spam', 'system:billing'), sale('own-sale', 'system:intake'), sale('other-sale', 'dana')]
  const sent: any[] = []
  const answer = await limitedCall(owner, 'record', { entries }, async (input: any) => {
    sent.push(...input.entries)
    return { results: input.entries.map(({ type, key }: any) => ({ type, key, ok: true })) }
  }) as any
  assert.deepEqual(sent.map((entry) => entry.key), ['own', 'none', 'own-spam', 'own-sale'])
  assert.deepEqual(answer.results.map((each: any) => [each.key, each.ok, each.reason]), [['own', true, undefined], ['none', true, undefined], ['other', false, 'FORBIDDEN'], ['own-spam', true, undefined], ['other-spam', false, 'FORBIDDEN'], ['own-sale', true, undefined], ['other-sale', false, 'FORBIDDEN']])
})

test('a named service that may find is not answered a search by name', async () => {
  const owner = { role: 'limited', name: 'intake', calls: { lookup: ['find'] } } as const
  const asked = (answer: object) => limitedCall(owner, 'lookup', { kind: 'find', text: 'casey' }, async () => answer)
  assert.deepEqual(await asked({ by: 'name', subjects: ['contact:one'] }), { by: 'subject', subjects: [] })
  for (const exact of [{ by: 'email', subjects: ['contact:one'] }, { by: 'subject', subjects: ['contact:one'] }]) assert.deepEqual(await asked(exact), exact)
})

test('a named service reads what people wrote only where it lists messages', async () => {
  const ask = (lookup: true | string[]) => limitedCall({ role: 'limited', name: 'intake', calls: { lookup } } as any, 'lookup', { kind: 'messages', subject: 'contact:one' }, async () => ({ messages: [] }))
  assert.deepEqual(await ask(['messages']), { messages: [] })
  // A grant of every lookup was made before there were messages to read, and does not reach them.
  for (const lookup of [true, ['find', 'journey']] as const) await assert.rejects(ask(lookup as true | string[]), { code: 'AUTH.FORBIDDEN' })
})

test('the bearer scheme is read in any case and with any spacing, as HTTP allows', () => {
  const owner = credentials('s'.repeat(32), { ann: 'r'.repeat(32) })
  for (const header of [`Bearer ${'s'.repeat(32)}`, `bearer ${'s'.repeat(32)}`, `BEARER ${'s'.repeat(32)}`, `Bearer  ${'s'.repeat(32)}`, `Bearer\t${'s'.repeat(32)}`]) assert.deepEqual(owner(header), { role: 'service' }, header)
  assert.deepEqual(owner(`bearer ${'r'.repeat(32)}`), { role: 'reviewer', name: 'ann' })
  for (const header of [`Basic ${'s'.repeat(32)}`, `Bearer${'s'.repeat(32)}`, `Bearer ${'s'.repeat(31)}`, '', undefined]) assert.equal(owner(header), undefined, String(header))
})
