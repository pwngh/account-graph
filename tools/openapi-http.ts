import { STATUS } from '../src/client/faults.ts'
import { FAULT_CODES } from '../src/contract/fault.ts'
import type { CallName } from '../src/contract/validate.ts'
import { TOUCH_FIELDS } from '../src/core/touch.ts'
import type { Collected, EventDetail } from '../src/edge/collect.ts'

const string = { type: 'string' }
const integer = { type: 'integer' }
const schema = (name: string) => ({ $ref: '#/components/schemas/' + name })
const response = (name: string) => ({ $ref: '#/components/responses/' + name })
const json = (body: object) => ({ 'application/json': { schema: body } })
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
const closed = (properties: Record<string, object>) => ({ ...object(properties), additionalProperties: false })
const requestId = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[!-~]+$' }
export const requestIdParameter = { name: 'x-request-id', in: 'header', required: false, description: 'A request identifier to echo in the answer.', schema: requestId }
export const requestIdHeaders = { 'x-request-id': { description: 'The request identifier when the caller supplied one in the accepted form.', schema: requestId } }
export const securitySchemes = { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Use the service token or a reviewer token with access to the call.' } }
export const callAccess = {
  record: 'A service token can record any entry. A reviewer can record only call party statements signed with the token owner’s name.',
  decide: 'A reviewer must sign by the token owner’s name. A service token can sign for any author.',
  forget: 'A reviewer must sign by the token owner’s name. A service token can sign for any author.',
  lookup: 'A service token can read every kind. A reviewer can read journey, find and party. An excluded party omits the subject for a reviewer.',
  report: 'Service and reviewer tokens can read every report.',
  events: 'Requires a service token.',
} satisfies Record<CallName, string>

const codes = Object.values(FAULT_CODES).flatMap(group => Object.values(group))
const statuses = [...new Set(codes.map(code => STATUS[code]!))]
const retryableCodes: Set<string> = new Set([FAULT_CODES.GRAPH.UNAVAILABLE, FAULT_CODES.TRANSPORT.INDETERMINATE])
const faultSchemas: Record<string, object> = {
  FaultCode: { type: 'string', enum: codes },
  FaultResponse: { anyOf: statuses.map(status => schema('Fault' + status)) },
}
const serverResponses: Record<string, object> = {}
for (const status of statuses) {
  const atStatus = codes.filter(code => STATUS[code] === status)
  // A 503 covers both a temporary outage and conditions that a retry cannot fix.
  const variants = []
  for (const retryable of [false, true]) {
    const matching = atStatus.filter(code => retryableCodes.has(code) === retryable)
    if (matching.length) variants.push(closed({ fault: closed({ code: { type: 'string', enum: matching }, message: string, retryable: { type: 'boolean', const: retryable }, detail: { type: 'object', additionalProperties: true } }) }))
  }
  faultSchemas['Fault' + status] = variants.length === 1 ? variants[0]! : { anyOf: variants }
  serverResponses['CallFault' + status] = { description: atStatus.join(' or ') + '.', headers: requestIdHeaders, content: json(schema('Fault' + status)) }
}

const routeError = (description: string) => ({ description, content: json(schema('RouteError')) })
export const httpResponses = {
  ...serverResponses,
  NoSuchCall: routeError('The call does not exist on this server.'),
  WrongMethod: routeError('The route requires POST.'),
  BadCollectorRequest: routeError('Malformed body, unknown kind or an event outside EVENTS.'),
  OriginForbidden: routeError('The Origin header is missing or its site is outside ORIGINS.'),
  CollectorUnavailable: routeError('This collector feature is disabled.'),
  BodyTooLarge: routeError('The request body exceeds 1,000,000 bytes.'),
  RateLimited: { ...routeError('Too many requests from this address.'), headers: { 'Retry-After': { description: 'Seconds to wait.', schema: integer } } },
  CollectorError: routeError('The server could not complete the request.'),
}
export const faultResponses = {
  ...Object.fromEntries(statuses.map(status => [status, response('CallFault' + status)])),
  404: response('NoSuchCall'),
  405: response('WrongMethod'),
}

const device = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$', description: 'The first-party device id supplied by the tag. When enabled, the server cookie takes precedence.' }
const privacy = { device, staff: string, gpc: { type: 'boolean' }, consent: schema('Consent') }
const visitFields = { ...privacy, url: string, ga: string, fingerprintEvent: string, canvas: string, known: string, carried: string, touch: schema('BrowserTouch') } satisfies Record<keyof Collected, object>
const eventDetail = { id: string, number: string } satisfies Record<keyof EventDetail, object>
const inputs = {
  visit: 'BrowserVisit', event: 'BrowserEvent', carry: 'BrowserCarry', number: 'BrowserNumber', text_code: 'BrowserTextCode',
} as const
type Kind = keyof typeof inputs
const kinds = Object.keys(inputs) as Kind[]
const replies = { carry: 'CarryToken', number: 'NumberLease', text_code: 'TextCode' } as const

export const httpSchemas = {
  ...faultSchemas,
  RouteError: closed({ error: string }),
  BrowserTouch: object({ ...Object.fromEntries(TOUCH_FIELDS.map(field => [field, string])), custom: { type: 'object', additionalProperties: string } }, []),
  BrowserVisit: object({ ...visitFields, link: { ...string, description: 'Alias for the signed known token.' } }, ['device']),
  BrowserEvent: object({ ...privacy, ...eventDetail, event: { ...string, description: 'A page event name in EVENTS.' }, url: string }, ['device', 'event']),
  BrowserNumber: object(privacy, ['device']),
  BrowserTextCode: object(privacy, ['device']),
  BrowserCarry: object({ device }),
  CollectRequest: {
    oneOf: kinds.map(kind => ({ allOf: [schema(inputs[kind]), object({ kind: { const: kind } }, kind === 'visit' ? [] : ['kind'])] })),
  },
  CarryToken: closed({ token: string }),
  NumberLease: closed({ number: string, until: { ...integer, description: 'Lease end in epoch milliseconds.' }, lasts: { ...integer, description: 'Remaining lease time in milliseconds.' } }),
  TextCode: closed({ code: string }),
  CollectReply: { oneOf: Object.values(replies).map(schema) },
}

function collectOperation(operationId: string, kind?: Exclude<Kind, 'visit'>) {
  const body = schema(kind ? inputs[kind] : 'CollectRequest')
  const answer = kind === 'event' ? undefined : schema(kind ? replies[kind] : 'CollectReply')
  return {
    operationId,
    summary: kind ? 'Legacy collector route for ' + kind : 'Report a visit or event, or request a token, number or code',
    description: kind ? 'Kept for one release for pages using an older tag. The route selects the kind.' : 'Omit kind for a visit. carry needs LINK_SECRET, number needs POOL_NUMBERS and text_code needs TEXT_CODES. The tag supplies a device on every request. When configured, the server can also supply a device from its cookie. Across origins, send JSON as text/plain, including when sending cookies. An OPTIONS preflight from an allowed origin receives 405.',
    ...(kind && { deprecated: true }),
    security: [],
    parameters: [{ name: 'Origin', in: 'header', required: true, description: 'The site origin must appear in ORIGINS.', schema: string }],
    requestBody: { required: true, content: { 'text/plain': { schema: { type: 'string', contentMediaType: 'application/json', contentSchema: body } }, ...json(body) } },
    responses: {
      ...(answer && { 200: { description: 'The requested token, leased number or text code.', content: json(answer) } }),
      ...(kind !== 'carry' && { 204: { description: 'No response body. Visits and events answer here, as do number and code requests with nothing to give.' } }),
      400: response('BadCollectorRequest'), 403: response('OriginForbidden'), 404: response('CollectorUnavailable'), 405: response('WrongMethod'),
      413: response('BodyTooLarge'), 429: response('RateLimited'), default: response('CollectorError'),
    },
  }
}

const scriptParameters = {
  fingerprint: 'Public Fingerprint API key.', region: 'Fingerprint region (eu or ap outside the US).', endpoints: 'Address of the Fingerprint proxy.',
  canvas: 'Use open to include the open-source fingerprint.', params: 'Comma-separated query parameter names to keep with an arrival.',
  domains: 'Comma-separated hosts to carry the visitor to.', forms: 'Use all to fill every form that posts.',
  pool: 'Use 1 to show the visitor’s leased number.', text: 'Use 1 to show or add the visitor’s code to text links.',
}
const scriptResponse = { 200: { description: 'A JavaScript module.', content: { 'text/javascript': { schema: string } } } }
export const browserPaths = {
  '/collect': { post: collectOperation('collect') },
  '/collect.js': { get: { operationId: 'collectorScript', summary: 'Load the browser tag', security: [], parameters: Object.entries(scriptParameters).map(([name, description]) => ({ name, description, in: 'query', schema: string })), responses: scriptResponse } },
  '/fingerprint.js': { get: { operationId: 'fingerprintScript', summary: 'Load the optional fingerprint helpers', security: [], responses: scriptResponse } },
  '/event': { post: collectOperation('legacyEvent', 'event') },
  '/carry': { post: collectOperation('legacyCarry', 'carry') },
  '/number': { post: collectOperation('legacyNumber', 'number') },
  '/text-code': { post: collectOperation('legacyTextCode', 'text_code') },
}
