import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import type { RecordRequest } from '../src/contract/api.ts'
import { accountGraph } from '../src/index.ts'
import { createEdge } from '../src/edge/index.ts'
import { CALLS, checked } from '../src/contract/validate.ts'
import type { CallName } from '../src/contract/validate.ts'
import { openapi } from '../tools/openapi.ts'
import { checkHttp } from './openapi-http.ts'
import { libraryRequests } from './openapi-library.ts'

const docs = new URL('../docs/', import.meta.url)
const spec = JSON.parse(readFileSync(new URL('openapi.json', docs), 'utf8'))
const components = spec.components.schemas
const operation = (call: string) => spec.paths['/v1/' + call].post
const input = (call: string) => operation(call).requestBody.content['application/json'].schema
const output = (call: string) => operation(call).responses['200'].content['application/json'].schema

function resolve(ref: string) {
  assert.match(ref, /^#\/components\/(schemas|responses)\/[\w.-]+$/)
  const [, , section, name] = ref.split('/')
  assert.ok(Object.hasOwn(spec.components[section!], name!), ref)
  return spec.components[section!][name!]
}

// Check only the JSON Schema vocabulary the description uses. A new assertion needs a test implementation before examples can rely on it.
function accepts(schema: Record<string, any>, value: unknown): boolean {
  if (schema.$ref && !accepts(resolve(schema.$ref), value)) return false
  if (schema.anyOf && !schema.anyOf.some((s: object) => accepts(s, value))) return false
  if (schema.oneOf && schema.oneOf.filter((s: object) => accepts(s, value)).length !== 1) return false
  if (schema.allOf && !schema.allOf.every((s: object) => accepts(s, value))) return false
  if (schema.if && accepts(schema.if, value) && schema.then && !accepts(schema.then, value)) return false
  if (schema.not && accepts(schema.not, value)) return false
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type && schema.type !== type) return false
  if (typeof value === 'number') return !(value < schema.minimum || value > schema.maximum)
  if (typeof value === 'string') {
    if (schema.format) {
      assert.equal(schema.format, 'date')
      const day = new Date(value + 'T00:00:00Z')
      if (!Number.isFinite(day.getTime()) || !day.toISOString().startsWith(value + 'T')) return false
    }
    const length = [...value].length
    return !(length < schema.minLength || length > schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value))
  }
  if (Array.isArray(value)) {
    if (value.length < schema.minItems || value.length > schema.maxItems) return false
    return value.every((item, index) => accepts(schema.prefixItems?.[index] ?? schema.items ?? {}, item))
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value)
    if (fields.length < schema.minProperties || fields.length > schema.maxProperties || schema.required?.some((name: string) => !Object.hasOwn(value, name))) return false
    return fields.every(([key, item]) => {
      if (schema.propertyNames && !accepts(schema.propertyNames, key)) return false
      const field = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : schema.additionalProperties
      return typeof field === 'object' ? accepts(field, item) : field !== false
    })
  }
  return true
}

test('OpenAPI has the current wire types, fields, literal values, required flags and method signatures', () => {
  const expected = openapi()
  assert.equal(spec.openapi, '3.1.0')
  assert.deepEqual(Object.keys(spec.paths).filter(path => path.startsWith('/v1/')).sort(), CALLS.map(name => '/v1/' + name).sort())
  // Compare components separately so a stale field reports its owning type.
  assert.deepEqual(Object.keys(components).sort(), Object.keys(expected.components.schemas).sort())
  for (const [name, schema] of Object.entries(expected.components.schemas)) assert.deepEqual(components[name], schema, 'Regenerate ' + name + ' with node tools/openapi.ts')
  assert.deepEqual({ ...spec, components: { ...spec.components, schemas: {} } }, { ...expected, components: { ...expected.components, schemas: {} } })
})

test('every reference is local and every schema assertion is understood by the example checker', () => {
  const keywords = new Set('type title description $ref const enum properties additionalProperties required items prefixItems minItems maxItems minimum maximum minLength maxLength format pattern anyOf oneOf allOf not if then minProperties maxProperties propertyNames contentMediaType contentSchema'.split(' '))
  const inspect = (schema: Record<string, any>) => {
    for (const key of Object.keys(schema)) assert.ok(keywords.has(key), 'Implement the schema keyword ' + key)
    for (const child of [...Object.values(schema.properties ?? {}), ...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? [], ...schema.prefixItems ?? [], schema.items, schema.additionalProperties, schema.not, schema.if, schema.then, schema.propertyNames, schema.contentSchema]) {
      if (child && typeof child === 'object') inspect(child)
    }
  }
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return
    if (value.$ref) resolve(value.$ref)
    if (value.schema) inspect(value.schema)
    Object.values(value).forEach(visit)
  }
  Object.values<Record<string, any>>(components).forEach(inspect)
  visit(spec)
})

test('bearer access, fault statuses and the browser tag agree with the published routes', () => checkHttp(spec, accepts))

test('the schema distinguishes success values, refusal details, omission, null, tuples and dictionaries', () => {
  const subject = 'intake:42'
  const key = 'form-42'
  const at = 1795460000000
  const profile = { type: 'profile', key, at, subject, facts: { email: 'pat@example.org' } }
  const entry = components.RecordEntry
  assert.ok(accepts(entry, profile))
  for (const invalid of [{ ...profile, subject: ' ' + subject }, { ...profile, facts: {} }, { ...profile, speaker: {} }, { ...profile, at: at + 0.5 }, { ...profile, at: undefined }, { ...profile, createdAt: 0 }, { ...profile, createdAt: null }, { ...profile, facts: { name: { first: 'Pat' } } }, { ...profile, facts: { typo: 'Pat' } }]) assert.ok(!accepts(entry, invalid))
  assert.ok(accepts(entry, { type: 'arrival', at, key, subject, custom: { office: 'north' } }))
  assert.ok(!accepts(entry, { type: 'arrival', at, key, subject, custom: { office: 7 } }))
  assert.ok(accepts(entry, { ...profile, facts: {}, speaker: { email: 'pat@example.org' } }))
  const call = { type: 'call', key, at, direction: 'outbound', to: '+12025550142' }
  assert.ok(!accepts(entry, call))
  assert.ok(accepts(entry, { ...call, from: '+12025550143' }))
  const conversion = { type: 'conversion', key, at, subject, stage: 'inquiry' }
  for (const tags of [{ Region: 'north' }, { region: '(not set)' }, { region: ' ' }, { region: 'x'.repeat(65) }]) assert.ok(!accepts(entry, { ...conversion, tags }))
  assert.ok(accepts(entry, { ...conversion, tags: { region: 'north' } }))
  assert.ok(!accepts(components.Window, { from: '2026-02-30', to: '2026-03-01', timeZone: 'UTC' }))
  assert.ok(!accepts(input('events'), { after: null, limit: 1001 }))
  const result = components.RecordResult
  const accepted = { type: 'link', key, ok: true, value: { duplicate: false, stands: true, url: 'https://example.org' } }
  assert.ok(accepts(result, accepted))
  assert.ok(!accepts(result, { ...accepted, type: 'payment' }))
  const stale = { ok: false, reason: 'STALE', decision: null, by: null, at: null }
  assert.ok(accepts(result, { type: 'call_update', key, ...stale }))
  assert.ok(!accepts(output('decide'), stale))
  assert.ok(!accepts(result, { type: 'profile', key, ok: false, reason: 'KEY_REUSED' }))
  const conflict = { a: subject, b: 'intake:43', how: 'recorded', rests: [subject, 'intake:43'] }
  assert.ok(accepts(components.Conflict, conflict))
  for (const rests of [[subject], [subject, subject, subject], [subject, 42]]) assert.ok(!accepts(components.Conflict, { ...conflict, rests }))
})

function responseSchema(call: CallName, request: any) {
  const schema = output(call)
  if (call !== 'lookup' && call !== 'report') return schema
  const variant = schema.anyOf.find((option: { title: string }) => option.title === request.kind)
  assert.ok(variant, call + ' reply for ' + request.kind)
  return variant
}

test('the documented requests reach their routes and their wire answers match the schemas', async t => {
  const graph = accountGraph({ memory: true })
  const origin = 'https://example.org'
  const handler = createEdge(graph, { token: 'example-service', origins: [origin] })
  const server = createServer(handler).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  t.after(async () => {
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()))
    await handler.drain()
    await graph.close()
  })
  for (const call of CALLS) {
    const payload = operation(call).requestBody.content['application/json'].example
    const response = await fetch(base + '/v1/' + call, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer example-service', 'content-type': 'application/json', 'x-request-id': 'form-42' }, body: JSON.stringify(payload) })
    assert.equal(response.status, 200, call)
    assert.equal(response.headers.get('x-request-id'), 'form-42')
    assert.ok(accepts(responseSchema(call, payload), await response.json()), call)
  }
  for (const path of ['/collect.js', '/fingerprint.js']) {
    const response = await fetch(base + path, { redirect: 'error' })
    assert.equal(response.status, 200)
    const media = response.headers.get('content-type')!.split(';')[0]!
    assert.ok(accepts(spec.paths[path].get.responses[200].content[media].schema, await response.text()))
  }
  const payload = { device: 'form-42', url: origin }
  const media = spec.paths['/collect'].post.requestBody.content['text/plain'].schema
  assert.ok(accepts(media.contentSchema, payload))
  const visit = await fetch(base + '/collect', { method: 'POST', redirect: 'error', headers: { origin, 'content-type': 'text/plain' }, body: JSON.stringify(payload) })
  assert.equal(visit.status, 204)
  assert.equal(await visit.text(), '')
})

const guides = ['../README.md', ...readdirSync(docs).filter(name => name.endsWith('.md'))]
assert.ok(guides.includes('no-code.md'), 'Missing the intake form guide')
for (const file of guides) test('HTTP examples in ' + (file === '../README.md' ? 'README.md' : 'docs/' + file), async () => {
  const markdown = readFileSync(new URL(file, docs), 'utf8')
  for (const [, json, target] of markdown.matchAll(/`([^`\n]+)`<!-- schema ([\w/]+) -->/g)) {
    const [component, field] = target!.split('/')
    const schema = target!.startsWith('/v1/') ? output(target!.slice(4)) : field ? components[component!].properties[field] : components[component!]
    assert.ok(schema && accepts(schema, JSON.parse(json!)), file + ' inline example for ' + target)
  }
  const forms = new Map<string, RecordRequest>()
  const published = new Set<string>()
  let previous: { call: CallName, payload: unknown, end: number, canonical: boolean } | undefined
  for (const fence of markdown.matchAll(/^(?:<!-- schema ([\w/ ]+) -->\n)?```([^\n]*)\n([\s\S]*?)\n```$/gm)) {
    const label = fence[1]?.split(' ') ?? []
    const language = fence[2]!.trim()
    const body = fence[3]!
    const where = file + ':' + (markdown.slice(0, fence.index).split('\n').length + 1)
    const request = (path: string, payload: unknown) => {
      assert.ok(path.startsWith('/v1/'), where)
      const call = path.slice(4) as CallName
      assert.ok(CALLS.includes(call), where + ' unknown call ' + call)
      assert.ok(accepts(input(call), payload), where + ' request for ' + path)
      checked(call, payload)
      const canonical = file === 'http.md' && language === 'http'
      if (canonical) {
        const post = operation(call)
        assert.equal(post.operationId, call)
        assert.equal(post.requestBody.required, true)
        assert.deepEqual(post.requestBody.content['application/json'].example, payload, where)
      }
      previous = { call, payload, end: fence.index + fence[0].length, canonical }
      if (file === 'no-code.md') {
        assert.equal(call, 'record')
        const heading = markdown.slice(0, fence.index).split(/^## /m).at(-1)!.split('\n')[0]!
        assert.ok(!forms.has(heading), 'Duplicate form example for ' + heading)
        forms.set(heading, checked('record', payload))
      }
    }
    if (language === 'ts') {
      for (const { call, payload } of libraryRequests(body)) request('/v1/' + call, payload)
    } else if (language === 'http') {
      const [headers, ...payload] = body.split('\n\n')
      const match = /^POST (\S+)(?:\n|$)/.exec(headers!)
      assert.ok(match, where)
      const data = JSON.parse(payload.join('\n\n'))
      if (match[1] === '<WEBHOOK_URL>') assert.ok(accepts(components.EventPage, data), where)
      else request(match[1]!, data)
    } else if (language === 'bash' || language === 'sh') {
      for (const command of body.split(/^curl\s+/m).slice(1)) {
        const url = /https?:\/\/[^\s'"\\]+/.exec(command)?.[0]
        if (!url || !new URL(url).pathname.startsWith('/v1/')) continue
        const path = new URL(url).pathname
        const method = /(?:-X\s*|--request\s+)(\w+)/.exec(command)?.[1]
        assert.equal(method ?? 'POST', 'POST', where)
        const json = /(?:-d|--data(?:-raw)?)\s+'([^']+)'/.exec(command)
        assert.ok(json, where + ' expected a JSON request body')
        request(path, JSON.parse(json[1]!))
      }
    } else if (language === 'json') {
      const data = JSON.parse(body)
      if (['cli', 'reviewer', 'config'].includes(label[0]!)) continue
      let schema
      if (label[0]?.startsWith('/v1/')) {
        assert.equal(label[1], '200', where)
        schema = output(label[0].slice(4))
      } else if (label.length) schema = components[label.join(' ')]
      else {
        assert.ok(previous && markdown.slice(previous.end, fence.index).trim() === '', where + ' needs a request or a schema name')
        schema = responseSchema(previous.call, previous.payload)
        if (previous.canonical) {
          assert.deepEqual(operation(previous.call).responses['200'].content['application/json'].example, data, where)
          published.add(previous.call)
        }
      }
      assert.ok(schema && accepts(schema, data), where + ' ' + (label.join(' ') || previous?.call))
    }
  }

  if (file === 'http.md') assert.deepEqual([...published].sort(), [...CALLS].sort())
  if (file === 'no-code.md') {
    const graph = accountGraph({ memory: true })
    try {
      assert.deepEqual([...forms.keys()].sort(), ['Make', 'Power Automate', 'Zapier'])
      for (const form of forms.values()) {
        const [profile, inquiry] = form.entries
        assert.equal(form.entries.length, 2)
        assert.ok(profile?.type === 'profile' && inquiry?.type === 'conversion' && inquiry.stage === 'inquiry')
        assert.equal(profile.subject, inquiry.subject)
        assert.equal(profile.at, inquiry.at)
        const id = profile.subject.split(':')[1]
        assert.ok(id && [profile.key, inquiry.key].every(key => key.split('-').includes(id)), 'Both keys carry the submission id')
        for (const duplicate of [false, true]) {
          const reply = await graph.record(form)
          assert.ok(accepts(output('record'), reply))
          assert.ok(reply.results.every(result => result.ok && result.value.duplicate === duplicate))
        }
      }
    } finally {
      await graph.close()
    }
  }
})
