import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { CallName } from '../src/contract/validate.ts'
import { contractSchemas } from './openapi-contract.ts'
import { browserPaths, callAccess, faultResponses, httpResponses, httpSchemas, requestIdHeaders, requestIdParameter, securitySchemes } from './openapi-http.ts'

const summaries: Record<CallName, string> = {
  record: 'Record up to 100 entries in order',
  decide: 'Merge, split or mute, or take back a decision',
  forget: 'Delete the named subjects',
  lookup: 'Read the answer for one lookup kind',
  report: 'Read a report and the time it describes',
  events: 'Read a page of events after a cursor',
}

export function openapi() {
  const { calls, schemas } = contractSchemas()
  const guide = readFileSync(new URL('../docs/http.md', import.meta.url), 'utf8')
  const examples = new Map<string, { request: unknown, response: unknown }>()
  for (const [, call, request, response] of guide.matchAll(/^```http\nPOST \/v1\/(\w+)\n\n([\s\S]*?)\n```\n\n```json\n([\s\S]*?)\n```/gm)) {
    if (examples.has(call!)) throw new Error('Duplicate main HTTP example for ' + call)
    examples.set(call!, { request: JSON.parse(request!), response: JSON.parse(response!) })
  }
  const paths = Object.fromEntries(Object.entries(calls).map(([call, { request, response }]) => {
    const example = examples.get(call)
    if (!example || !Object.hasOwn(summaries, call)) throw new Error('Document the HTTP operation ' + call)
    const operation = {
      operationId: call,
      summary: summaries[call as CallName],
      description: callAccess[call as CallName],
      parameters: [requestIdParameter],
      requestBody: { required: true, content: { 'application/json': { schema: request, example: example.request } } },
      responses: {
        200: { description: 'The call’s answer, including any domain refusal.', headers: requestIdHeaders, content: { 'application/json': { schema: response, example: example.response } } },
        ...faultResponses,
      },
    }
    return ['/v1/' + call, { post: operation }]
  }))
  return {
    openapi: '3.1.0',
    info: {
      title: 'Account Graph HTTP API',
      version: '1',
      description: 'Supply your graph’s HTTPS address. Each /v1 call takes one JSON object. Requests may contain up to 1,000,000 bytes and 32 levels of nesting. A domain refusal is part of the HTTP 200 answer. The unversioned reviewer routes serve the bundled screen.',
    },
    servers: [{ url: '/', description: 'The origin of your graph server.' }],
    security: [{ bearerAuth: [] }],
    paths: { ...paths, ...browserPaths },
    components: { securitySchemes, schemas: { ...schemas, ...httpSchemas }, responses: httpResponses },
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  writeFileSync(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(openapi(), null, 2) + '\n')
}
