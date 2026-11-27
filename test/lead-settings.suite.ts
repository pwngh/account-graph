import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFrom } from '../src/bin.ts'
import { createEdge } from '../src/edge/index.ts'
import { accountGraph } from '../src/index.ts'
import type { AccountGraph, LeadSource, LeadSources } from '../src/index.ts'

export function leadSettings(graph: AccountGraph) {
  const source: LeadSource = { kind: 'lead', secret: 'source-secret-for-settings-checks', auth: { header: 'X-Lead-Signature', encoding: 'hex' }, mapping: { id: 'submission.id', email: 'contacts[0].mail' } }
  const leads = { intake: source }
  const options = { token: 'service-token', reviewers: { desk: ['review-token'] }, serviceTokens: [{ name: 'loader', token: 'loader-token', calls: {} }] }
  const fails = (test: () => void) => assert.throws(test, (error: Error) => /leads/i.test(error.message) && !/source-secret|service-token|loader-token|review-token|graph-secret/.test(error.message))

  for (const invalid of [
    null, [], { intake: null }, { 'bad/path': source }, { intake: { ...source, kind: 'note' } }, { intake: { ...source, extra: 'drop' } },
    ...['', '\ud800', 'intake'].map(secret => ({ intake: { ...source, secret } })), { intake: { ...source, auth: 'bearer', secret: 'two words' } }, { intake: source, form: { ...source, auth: 'bearer' } },
    ...[{ header: 'bad header', encoding: 'hex' }, { header: 'signed', encoding: 'plain' }, { header: 'signed', encoding: 'hex', extra: true }, 'query'].map(auth => ({ intake: { ...source, auth } })),
    ...[0, 1.5, '20'].map(perMinute => ({ intake: { ...source, perMinute } })),
    ...['', 'spaces here', 'intake:'].map(prefix => ({ intake: { ...source, prefix } })),
    ...['', null].map(stage => ({ intake: { ...source, stage } })),
    { intake: { ...source, secret: 'x'.repeat(31) } }, { intake: { ...source, secret: ' '.repeat(40) } },
    // A placeholder of one character, or of a few repeated, is not a random secret.
    ...['a'.repeat(32), 'abcdefg'.repeat(5), '0123456'.repeat(6)].map(secret => ({ intake: { ...source, secret } })),
    ...['lead', 'lead:chat', 'visitor', 'caller:x', 'call', 'text:in', 'page', 'contact', 'account:x', 'record', 'Lead', 'LEAD:x', 'Contact'].map(prefix => ({ intake: { ...source, prefix } })),
    ...[['p', 'p'], ['p', 'p:q'], ['p:q:r', 'p:q']].map(([one, other]) => ({ intake: { ...source, prefix: one }, chat: { ...source, secret: source.secret + '-chat', prefix: other } })),
    ...[1, 'true', null].map(trustSubjects => ({ intake: { ...source, trustSubjects } })), ...[1, 'true', null].map(updates => ({ intake: { ...source, updates } })),
    { intake: { ...source, kind: 'payment', updates: true, conversions: ['lead:form'], maxAmount: 100, mapping: { id: 'id', amount: 'total', conversion: 'reference' } } }, { intake: { ...source, kind: 'payment', trustSubjects: true, conversions: ['lead:form'], maxAmount: 100, mapping: { id: 'id', amount: 'total', conversion: 'reference' } } },
    ...[[], { email: 'mail' }, { id: 'id', note: 'text' }, { id: 'id', amount: 'sum' }].map(mapping => ({ intake: { ...source, mapping } })),
    ...['field..id', 'body[0]extra', 'posts[*].id', 'f(x)', 'a.__proto__.id', 'x.constructor.name', 'a.prototype'].map(id => ({ intake: { ...source, mapping: { id } } })),
    ...[{ id: 'id', conversion: 'reference' }, { id: 'id', amount: 'total' }, { id: 'id', amount: 'total', conversion: 'reference', email: 'mail' }].map(mapping => ({ intake: { ...source, kind: 'payment', conversions: ['lead:form'], maxAmount: 100, mapping } })),
    ...[{}, { conversions: ['lead:form'] }, { maxAmount: 100 }, { conversions: [], maxAmount: 100 }, { conversions: ['lead:'], maxAmount: 100 }, { conversions: 'lead:form', maxAmount: 100 }, ...[0, -1, 1e11, '100'].map(maxAmount => ({ conversions: ['lead:form'], maxAmount }))]
      .map(payment => ({ intake: { ...source, kind: 'payment', mapping: { id: 'id', amount: 'total', conversion: 'reference' }, ...payment } })),
    ...[{ conversions: ['lead:form'] }, { maxAmount: 100 }].map(payment => ({ intake: { ...source, ...payment } })),
    // A payment source cannot pay the graph's own call, text or page conversions, or every lead source's at once.
    ...[['call'], ['call:abc'], ['text'], ['page:signup'], ['lead'], ['Call'], ['lead:form', 'text']].map(conversions => ({ intake: { ...source, kind: 'payment', conversions, maxAmount: 100, mapping: { id: 'id', amount: 'total', conversion: 'reference' } } })),
  ]) {
    fails(() => accountGraph({ memory: true, leads: invalid as LeadSources }))
    fails(() => createEdge(graph, { ...options, leads: invalid as LeadSources }))
  }
  for (const auth of ['bearer', { header: 'signature', encoding: 'base64' }] as const) {
    for (const secret of ['service-token', 'loader-token', 'review-token', 'desk', 'loader']) fails(() => createEdge(graph, { ...options, leads: { intake: { ...source, auth, secret } } }))
  }
  fails(() => createEdge(graph, { ...options, leads: { 'service-token': source } }))
  const local = accountGraph({ memory: true, leads })
  fails(() => createEdge(local, { token: source.secret }))
  createEdge(local, { token: source.secret, leads: {} })
  void local.close()

  // Sources whose prefixes only share leading characters write to different subjects.
  void accountGraph({ memory: true, leads: { intake: { ...source, prefix: 'p' }, chat: { ...source, secret: source.secret + '-chat', prefix: 'pq:p' }, form: { ...source, secret: source.secret + '-form' } } }).close()
  // Nor may a lead secret repeat one of the graph's own.
  const graphSecret = 'graph-secret-'.repeat(3)
  for (const held of [{ linkSecret: graphSecret }, { identifierSecret: graphSecret }]) {
    fails(() => accountGraph({ memory: true, ...held, leads: { intake: { ...source, secret: graphSecret } } }))
    const holding = accountGraph({ memory: true, ...held })
    fails(() => createEdge(holding, { ...options, leads: { intake: { ...source, secret: graphSecret } } }))
    void holding.close()
  }
  fails(() => accountGraph({ databaseUrl: 'postgres://unused@127.0.0.1:1/unused', workers: false, receiptSecrets: [graphSecret], identifierSecret: 'i'.repeat(32), leads: { intake: { ...source, secret: graphSecret } } }))
  fails(() => createEdge(graph, { ...options, twilio: { authToken: graphSecret, calls: 'https://graph.example.org/calls/twilio' }, leads: { intake: { ...source, secret: graphSecret } } }))
  fails(() => createEdge(graph, { ...options, fingerprint: { secretKey: graphSecret }, leads: { intake: { ...source, secret: graphSecret } } }))
  fails(() => accountGraph({ memory: true, webhook: { url: 'https://hooks.example.org/graph', secret: graphSecret }, leads: { intake: { ...source, secret: graphSecret } } }))
  fails(() => accountGraph({ memory: true, checks: { lineType: { accountSid: 'AC1', authToken: graphSecret } }, leads: { intake: { ...source, secret: graphSecret } } }))

  const env = { DATABASE_URL: 'unused', IDENTIFIER_SECRET: 'i'.repeat(32), RECEIPT_SECRETS: 'r'.repeat(32), GRAPH_TOKEN: options.token }
  const dir = mkdtempSync(join(process.cwd(), '.lead-settings-'))
  try {
    const file = join(dir, 'sources.json')
    writeFileSync(file, JSON.stringify(leads))
    for (const settings of [{ LEADS: JSON.stringify(leads) }, { LEADS_FILE: file }]) assert.deepEqual(configFrom({ ...env, ...settings }).graph.leads, leads)
    for (const settings of [{ LEADS: '' }, { LEADS_FILE: '' }, { LEADS: '', LEADS_FILE: '' }]) assert.equal(configFrom({ ...env, ...settings }).graph.leads, undefined)
    assert.deepEqual(configFrom({ ...env, LEADS: '', LEADS_FILE: file }).graph.leads, leads)
    for (const settings of [{ LEADS: '[]' }, { LEADS: 'source-secret' }, { LEADS_FILE: file + '.missing' }, { LEADS_FILE: file, LEADS: '{}' }]) fails(() => configFrom({ ...env, ...settings }))
    fails(() => configFrom({ ...env, LEADS: JSON.stringify({ intake: { ...source, secret: options.token } }) }))
    fails(() => configFrom({ ...env, LEADS: JSON.stringify({ intake: { ...source, secret: env.RECEIPT_SECRETS } }) }))
    fails(() => configFrom({ ...env, LINK_SECRET: graphSecret, LEADS: JSON.stringify({ intake: { ...source, secret: graphSecret } }) }))
    // Nor any other secret setting, whether or not the feature it belongs to is complete.
    for (const held of [
      { WEBHOOK_URL: 'https://hooks.example.org/graph', WEBHOOK_SECRET: graphSecret }, { FINGERPRINT_SECRET: graphSecret }, { TWILIO_AUTH_TOKEN: graphSecret, TWILIO_WEBHOOK_URL: 'https://graph.example.org/calls/twilio' },
      { TWILIO_AUTH_TOKEN: graphSecret, TWILIO_ACCOUNT_SID: 'AC1' }, { IDENTIFIER_SECRET: graphSecret }, { MICROSOFT_CLIENT_SECRET: graphSecret }, { META_ACCESS_TOKEN: graphSecret }, { MAXMIND_LICENSE_KEY: graphSecret },
      { RECEIPT_SECRETS: `${env.RECEIPT_SECRETS},${graphSecret}` }, { DATABASE_URL: `postgres://graph:${graphSecret}@127.0.0.1:1/graph` },
    ]) fails(() => configFrom({ ...env, ...held, LEADS: JSON.stringify({ intake: { ...source, secret: graphSecret } }) }))
    // JSON.parse would keep only the second of two sources with one name.
    const twice = `{"intake":${JSON.stringify(source)},"intake":${JSON.stringify({ ...source, secret: source.secret + '-again', mapping: { id: 'intake', email: 'x' } })}}`
    fails(() => configFrom({ ...env, LEADS: twice }))
    const nested = JSON.stringify({ intake: source, form: { ...source, secret: source.secret + '-form' } })
    assert.deepEqual(Object.keys(configFrom({ ...env, LEADS: nested }).graph.leads!), ['intake', 'form'])
  } finally {
    rmSync(dir, { recursive: true })
  }
}
