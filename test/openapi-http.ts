import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { STATUS, faultBody } from '../src/client/faults.ts'
import { FAULT_CODES, fault } from '../src/contract/fault.ts'
import { CALLS } from '../src/contract/validate.ts'
import type { Collected, EventDetail } from '../src/edge/collect.ts'

function interfaceFields(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest)
  const declaration = source.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === name)
  assert.ok(declaration && ts.isInterfaceDeclaration(declaration), name)
  return declaration.members.map(member => {
    assert.ok(ts.isPropertySignature(member) && ts.isIdentifier(member.name), name + ' has an unsupported member')
    return { name: member.name.text, required: !member.questionToken }
  })
}

export function checkHttp(spec: any, accepts: (schema: object, value: unknown) => boolean) {
  const { paths, components } = spec
  const resolveResponse = (description: any) => description.$ref ? components.responses[description.$ref.split('/').at(-1)] : description
  const body = (operation: any, status: number) => resolveResponse(operation.responses[status]).content['application/json'].schema
  const guide = readFileSync(new URL('../docs/http.md', import.meta.url), 'utf8')
  const documented = [...guide.matchAll(/^\| `([A-Z]+\.[A-Z_]+)` \| (\d+) \| (yes|no) \|/gm)].map(([, code, status, retry]) => ({ code: code!, status: Number(status), retryable: retry === 'yes' }))
  const codes = Object.values(FAULT_CODES).flatMap(group => Object.values(group))
  assert.deepEqual(documented.map(row => row.code).sort(), [...codes].sort(), 'fault table in docs/http.md')
  assert.deepEqual([...components.schemas.FaultCode.enum].sort(), [...codes].sort())
  const fields = interfaceFields('../src/contract/fault.ts', 'Fault')
  const requiredFaultFields = new Set(['message', ...fields.filter(field => field.required).map(field => field.name)])
  const wireFault = faultBody(fault(FAULT_CODES.INPUT.MALFORMED, 'Example')).fault
  // Error supplies message. The fault interface adds the other fields that travel over HTTP.
  assert.deepEqual(Object.keys(wireFault).sort(), [...fields.map(field => field.name), 'message'].sort())
  for (const invalid of [{ code: 'FUTURE.FAULT' }, { message: 1 }, { retryable: 'false' }, { detail: null }, { detail: [] }]) assert.ok(!accepts(components.schemas.FaultResponse, { fault: { ...wireFault, ...invalid } }))
  assert.equal(components.securitySchemes.bearerAuth.type, 'http')
  assert.equal(components.securitySchemes.bearerAuth.scheme, 'bearer')

  for (const call of CALLS) {
    const operation = paths['/v1/' + call].post
    assert.deepEqual(operation.security ?? spec.security, [{ bearerAuth: [] }], call)
    const parameter = operation.parameters.find((item: any) => item.name === 'x-request-id' && item.in === 'header')
    assert.ok(parameter)
    assert.ok(accepts(parameter.schema, 'form-42'))
    assert.ok(!accepts(parameter.schema, 'a'.repeat(201)))
    assert.ok(!accepts(parameter.schema, 'two words'))
    const statuses = [...new Set(Object.values(STATUS))]
    for (const code of codes) {
      const { status, retryable } = documented.find(row => row.code === code)!
      assert.equal(STATUS[code], status, code)
      const reply = faultBody(fault(code, 'Example', { retryable, detail: { path: 'request' } }))
      assert.ok(accepts(components.schemas.FaultResponse, reply), code)
      for (const candidate of statuses) assert.equal(accepts(body(operation, candidate), reply), candidate === status, call + ' ' + code + ' ' + candidate)
      assert.ok(!accepts(body(operation, status), { fault: { ...reply.fault, retryable: !retryable } }), code + ' retryability')
      for (const field of Object.keys(reply.fault)) {
        const missing = Object.fromEntries(Object.entries(reply.fault).filter(([name]) => name !== field))
        assert.equal(accepts(body(operation, status), { fault: missing }), !requiredFaultFields.has(field), code + ' missing ' + field)
      }
      assert.ok(resolveResponse(operation.responses[status]).headers['x-request-id'])
    }
    for (const status of [404, 405]) {
      assert.ok(accepts(body(operation, status), { error: 'No such route' }))
      assert.ok(!accepts(body(operation, status), { fault: {} }))
    }
  }

  const device = 'web-42'
  const origin = 'https://example.org'
  const visit = { device, url: origin, ga: '111.222', fingerprintEvent: 'event-42', canvas: 'canvas-42', known: 'link-42', carried: 'carry-42', staff: 'staff-42', gpc: false, consent: { adUserData: true, adPersonalization: false }, touch: { gclid: 'click-42', custom: { placement: 'form' } } } satisfies Required<Collected>
  const detail = { id: 'submit-42', number: '+12025550142' } satisfies Required<EventDetail>
  const visitFields = interfaceFields('../src/edge/collect.ts', 'Collected')
  const eventFields = interfaceFields('../src/edge/collect.ts', 'EventDetail')
  const { BrowserVisit, BrowserEvent } = components.schemas
  // The tag always knows the URL. A POST with only a device is also a visit. The server accepts link as an alias for known.
  assert.deepEqual(Object.keys(BrowserVisit.properties).sort(), [...visitFields.map(field => field.name), 'link'].sort())
  assert.deepEqual([...BrowserVisit.required].sort(), visitFields.filter(field => field.required && field.name !== 'url').map(field => field.name).sort())
  assert.deepEqual(Object.keys(BrowserEvent.properties).sort(), ['device', 'staff', 'gpc', 'consent', 'event', 'url', ...eventFields.map(field => field.name)].sort())
  assert.deepEqual([...BrowserEvent.required].sort(), ['device', 'event', ...eventFields.filter(field => field.required).map(field => field.name)].sort())
  const collector = paths['/collect'].post
  const content = collector.requestBody.content
  const decoded = content['application/json'].schema
  const plain = content['text/plain'].schema
  assert.deepEqual(collector.security, [])
  assert.equal(collector.requestBody.required, true)
  assert.ok(collector.parameters.some((item: any) => item.name === 'Origin' && item.in === 'header' && item.required))
  assert.equal(plain.type, 'string')
  assert.equal(plain.contentMediaType, 'application/json')
  assert.deepEqual(plain.contentSchema, decoded)
  assert.ok(accepts(decoded, { device }))
  assert.ok(accepts(decoded, visit))
  assert.ok(accepts(decoded, { ...visit, kind: 'visit' }))
  for (const field of Object.keys(visit)) assert.ok(!accepts(decoded, { ...visit, [field]: null }), 'invalid visit ' + field)
  for (const invalid of [{ ...visit, kind: 'other' }, { kind: 'event', device }, { device: 'invalid id' }, { device, touch: { gclid: 17 } }]) assert.ok(!accepts(decoded, invalid))
  assert.equal(collector.responses[204].content, undefined)
  const compatibility = [
    { kind: 'event', path: '/event', fields: { device, event: 'inquiry', ...detail } },
    { kind: 'carry', path: '/carry', fields: { device }, answer: { token: 'token-42' } },
    { kind: 'number', path: '/number', fields: { device, gpc: false }, answer: { number: '+12025550142', until: 1795460001000, lasts: 1000 } },
    { kind: 'text_code', path: '/text-code', fields: { device }, answer: { code: 'ABCD' } },
  ]
  for (const { kind, path, fields, answer } of compatibility) {
    assert.ok(accepts(decoded, { ...fields, kind }), kind)
    assert.ok(!accepts(decoded, { kind }), kind)
    const legacy = paths[path].post
    assert.equal(legacy.deprecated, true)
    assert.deepEqual(legacy.security, [])
    assert.ok(accepts(legacy.requestBody.content['application/json'].schema, fields))
    if (kind !== 'carry') {
      const common = { ...fields, staff: 'staff-42', gpc: false, consent: visit.consent }
      assert.ok(accepts(decoded, { ...common, kind }))
      for (const field of Object.keys(common)) assert.ok(!accepts(decoded, { ...common, kind, [field]: null }), kind + ' invalid ' + field)
    }
    if (answer) {
      assert.ok(accepts(body(collector, 200), answer))
      assert.ok(accepts(body(legacy, 200), answer))
      assert.ok(!accepts(body(collector, 200), {}))
    } else assert.equal(legacy.responses[200], undefined)
  }
  for (const status of [400, 403, 404, 405, 413, 429]) {
    assert.ok(accepts(body(collector, status), { error: 'Example' }))
    assert.ok(!accepts(body(collector, status), { fault: {} }))
  }
  assert.ok(resolveResponse(collector.responses[429]).headers['Retry-After'])
  for (const path of ['/collect.js', '/fingerprint.js']) {
    const script = paths[path].get
    assert.deepEqual(script.security, [])
    assert.ok(accepts(script.responses[200].content['text/javascript'].schema, 'export {}'))
  }
  assert.ok(!Object.keys(paths).some(path => path.startsWith('/review')))
}
