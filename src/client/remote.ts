import type { AccountGraph, CallOptions, RemoteOptions } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'
import type { FaultCode } from '../contract/fault.ts'
import { checked } from '../contract/validate.ts'
import type { CallName } from '../contract/validate.ts'
import { readEvent } from '../contract/webhook.ts'
import { createGate } from './closing.ts'

const CODES = new Set<string>(Object.values(FAULT_CODES).flatMap((group) => Object.values(group)))
const READS = new Set<CallName>(['lookup', 'report', 'events'])

export function remoteGraph(options: RemoteOptions): AccountGraph {
  let base: URL
  try {
    base = new URL(options.url)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error()
  } catch {
    throw fault(FAULT_CODES.CONFIG.INVALID, '`url` must be an http or https address')
  }
  if (typeof options.token !== 'string' || !options.token) throw fault(FAULT_CODES.CONFIG.INVALID, '`token` is required')
  const fetcher = options.fetch ?? fetch
  const ending = new AbortController()
  const gate = createGate()
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`
  const lost = (cause?: unknown) => fault(FAULT_CODES.TRANSPORT.INDETERMINATE, 'No answer was received', { retryable: true, ...(cause !== undefined && { cause }) })

  const call = (name: CallName, request: unknown, how: CallOptions = {}): Promise<any> => gate.run(() => ask(name, request, how))
  async function ask(name: CallName, request: unknown, { signal, correlationId }: CallOptions): Promise<any> {
    const body = JSON.stringify(checked(name, request))
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
    let response: Response
    let text: string
    try {
      response = await fetcher(new URL(`v1/${name}`, root), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}`, ...(correlationId !== undefined && { 'x-request-id': correlationId }) },
        body,
        redirect: 'manual',
        signal: AbortSignal.any([timeout, ending.signal, ...(signal ? [signal] : [])]),
      })
      text = await response.text()
    } catch (error) {
      if (ending.signal.aborted || signal?.aborted) throw fault(FAULT_CODES.TRANSPORT.ABORTED, 'The call was aborted', { cause: error })
      throw lost(error)
    }
    let answer: any
    try {
      answer = JSON.parse(text)
    } catch {}
    if (response.ok && answer !== undefined) return answer
    const given = answer?.fault
    if (given && CODES.has(given.code)) throw fault(given.code as FaultCode, String(given.message), { retryable: given.retryable === true, detail: typeof given.detail === 'object' && given.detail !== null ? given.detail : {} })
    const { status } = response
    if (status === 401) throw fault(FAULT_CODES.AUTH.REJECTED, 'The token was not accepted')
    if (status === 403) throw fault(FAULT_CODES.AUTH.FORBIDDEN, 'The token does not open this call')
    if (status === 413) throw fault(FAULT_CODES.INPUT.TOO_LARGE, 'The request is too large')
    if (status === 429 || status === 503) throw fault(FAULT_CODES.GRAPH.UNAVAILABLE, 'The server is not available', { retryable: true, detail: { status, ...(response.headers.get('retry-after') && { retryAfter: response.headers.get('retry-after') }) } })
    if (status === 404 || status === 405 || response.type === 'opaqueredirect' || (status >= 300 && status < 400)) throw fault(FAULT_CODES.CONFIG.INVALID, '`url` is not an account-graph server', { detail: { status } })
    if (status === 502 || status === 504 || (response.ok && !READS.has(name))) throw lost()
    throw fault(FAULT_CODES.GRAPH.INTERNAL, 'The server failed', { detail: { status } })
  }

  return {
    record: (request, how) => call('record', request, how),
    decide: (request, how) => call('decide', request, how),
    forget: (request, how) => call('forget', request, how),
    lookup: (request, how) => call('lookup', request, how),
    report: (request, how) => call('report', request, how),
    async events(request, how) {
      const answer = await call('events', request, how)
      // A newer server may send what this one does not know.
      return answer?.ok && Array.isArray(answer.value?.events) ? { ...answer, value: { ...answer.value, events: answer.value.events.map(readEvent) } } : answer
    },
    async close() {
      await gate.end()
      ending.abort()
    },
  }
}
