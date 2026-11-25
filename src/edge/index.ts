import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { internalsOf } from '../client/internals.ts'
import type { Internals } from '../client/internals.ts'
import { FAULT_CODES, fault, isFault } from '../contract/fault.ts'
import type { AccountGraph, ForgetValue, RecordEntry, RecordResponse } from '../contract/api.ts'
import { createBatcher } from '../core/batch.ts'
import { Outdated } from '../core/graph.ts'
import type { Graph } from '../core/graph.ts'
import { createRangeLookup } from '../core/lookups.ts'
import type { IpLookup } from '../core/ports.ts'
import { createFingerprintVerifier } from '../providers/fingerprint.ts'
import type { FingerprintOptions } from '../providers/fingerprint.ts'
import { createMaxMindLookup } from '../providers/maxmind.ts'
import type { MaxMindOptions } from '../providers/maxmind.ts'
import { createHandler, networks, reviewerProblems } from './server.ts'
import type { Core, HandlerOptions, Reviewers } from './server.ts'

export interface EdgeOptions {
  /** The bearer token your own services send. It opens the six calls. */
  token: string
  reviewers?: Reviewers
  /** Site origins a browser may post from, such as `https://example.org`. */
  origins?: readonly string[]
  trustProxy?: boolean | number
  cookie?: boolean | { domain?: string }
  limit?: false | { perMinute?: number; burst?: number }
  staffNetworks?: readonly string[]
  /** The events a page may report, by name. */
  events?: readonly string[]
  /** Twilio's account token, and the address each webhook was entered as. */
  twilio?: { authToken: string; calls?: string; texts?: string }
  /** Puts a code in text links, so a text says which visitor sent it. */
  textCodes?: boolean
  fingerprint?: Pick<FingerprintOptions, 'secretKey' | 'region'>
  maxmind?: Pick<MaxMindOptions, 'accountId' | 'licenseKey' | 'service' | 'host'>
  /** Ranges of servers, as text: an address or a range on each line. */
  serverRanges?: string
}

export type Edge = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & { /** Writes the visits that wait to be written. */ drain(): Promise<void> }

function problems(options: EdgeOptions): string[] {
  const wrong: string[] = []
  if (typeof options?.token !== 'string' || !options.token) wrong.push('`token` is required')
  else wrong.push(...reviewerProblems(options.reviewers, options.token))
  try {
    networks(options?.staffNetworks ?? [])
  } catch (error) {
    wrong.push(`staffNetworks: ${(error as Error).message}`)
  }
  if (options?.serverRanges !== undefined) {
    try {
      createRangeLookup(options.serverRanges)
    } catch (error) {
      wrong.push(`serverRanges: ${(error as Error).message}`)
    }
  }
  return wrong
}

/**
 * Serves a local instance over HTTP: the six calls at `/v1`, what browsers
 * and Twilio send, the reviewer screen, and a health check.
 */
export function createEdge(graph: AccountGraph, options: EdgeOptions): Edge {
  const open = internalsOf(graph)
  if (!open) throw fault(FAULT_CODES.CONFIG.UNSUPPORTED, 'The edge requires a local instance')
  const wrong = problems(options)
  if (wrong.length > 0) throw fault(FAULT_CODES.CONFIG.INVALID, wrong.join('\n'), { detail: { problems: wrong } })
  let made: { handler: ReturnType<typeof createHandler>; drain(): Promise<void> } | undefined

  function make(internals: Internals) {
    const { engine, ops, hours, options: local } = internals
    // Visits that arrive together are written together.
    const batcher = createBatcher(engine.graph)
    const queued: Graph = { ...engine.graph, observe: (input) => (Array.isArray(input) ? engine.graph.observe(input) : batcher.observe(input as Parameters<typeof batcher.observe>[0])) }
    const { now } = engine
    const reported = async (entry: RecordEntry): Promise<void> => {
      const { results } = (await internals.call('record', { entries: [entry] })) as RecordResponse
      const [result] = results
      // A provider has no use for a refusal, and would only send the same again.
      if (result && !result.ok && result.reason !== 'FORGOTTEN' && result.reason !== 'KEY_REUSED') throw fault(FAULT_CODES.GRAPH.UNAVAILABLE, `Not recorded: ${result.reason}`, { retryable: true })
    }
    const core: Core = {
      graph: queued,
      service: engine.service,
      outbox: engine.outbox,
      ops,
      called: ({ id, at, from, to, duration, direction = 'inbound', answered, voicemail, waited, tags }) =>
        reported({ type: 'call', key: id, at, direction, to, ...(from && { from }), ...(duration !== undefined && { duration }), ...(answered !== undefined && { result: { answered, ...(voicemail !== undefined && { voicemail }), ...(waited !== undefined && { waited }) } }), ...(tags && { tags }) }),
      texted: ({ id, at, from, to, direction = 'inbound', text, code, tags }) => reported({ type: 'text', key: id, at, direction, from, to, ...(text !== undefined && { text: text.slice(0, 20_000) }), ...(code && { code }), ...(tags && { tags }) }),
      async forget(subjects, { by, reason, seen }, retract) {
        const answer = (await internals.call('forget', { key: `review ${randomUUID()}`, at: now(), by: by ?? 'service', ...(reason && { reason }), ...(seen !== undefined && { seen }), subjects, platforms: retract ? 'retract' : 'report' })) as { ok: true; value: ForgetValue } | { ok: false; reason: string; decision?: number }
        if (!answer.ok) {
          const [decision] = answer.decision === undefined ? [] : await engine.graph.decisionPage({ before: answer.decision + 1, limit: 1 })
          if (decision) throw new Outdated(decision)
          throw fault(FAULT_CODES.GRAPH.INTERNAL, `Not deleted: ${answer.reason}`)
        }
        return { changes: [...answer.value.changes], sent: answer.value.sent.map(({ conversion, platform, ...rest }) => ({ transactionId: conversion, target: platform, ...rest })) }
      },
      v1: (name, request, signal) => internals.call(name, request, { signal }),
    }
    const maxmind = options.maxmind && createMaxMindLookup(options.maxmind)
    const ranges = options.serverRanges === undefined ? undefined : createRangeLookup(options.serverRanges)
    const ipInfo: IpLookup | undefined = ranges && maxmind ? async (address) => {
      const [known, info] = [await ranges(address), await maxmind(address)]
      return known && info ? { ...info, hosting: true } : (known ?? info)
    } : (ranges ?? maxmind)
    const { twilio } = options
    const { pool, calls } = engine.options
    const handler: HandlerOptions = {
      token: options.token,
      origins: (options.origins ?? []).map((origin) => origin.replace(/\/$/, '')),
      ...(options.reviewers && { reviewers: options.reviewers }),
      ...(options.trustProxy !== undefined && { trustProxy: options.trustProxy }),
      ...(options.cookie && { cookie: options.cookie }),
      ...(options.limit !== undefined && { limit: options.limit }),
      ...(options.staffNetworks && { staffNetworks: options.staffNetworks }),
      ...(options.fingerprint && { fingerprint: createFingerprintVerifier(options.fingerprint) }),
      ...(ipInfo && { ipInfo }),
      ...(local.linkSecret && { linkSecret: local.linkSecret }),
      ...(local.stages && { stages: local.stages }),
      ...(hours && { hours }),
      ...(pool && { pool }),
      ...(local.timeZone && { timeZone: local.timeZone }),
      returnHours: local.phones?.returnHours ?? 24,
      // A tap on a phone link is what ties a call to a visitor, so taking calls means taking that event.
      events: [...new Set([...(options.events ?? []), ...(calls?.numbers || twilio?.calls || pool ? ['phone_click'] : []), ...(options.textCodes || twilio?.texts ? ['text_click'] : [])])],
      calls: { ...calls, ...(twilio?.calls && { twilio: { authToken: twilio.authToken, url: twilio.calls } }) },
      texts: { codes: options.textCodes ?? false, ...(twilio?.texts && { twilio: { authToken: twilio.authToken, url: twilio.texts } }) },
      now,
    }
    return { handler: createHandler(core, handler), drain: () => batcher.drain() }
  }

  const edge = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      made ??= make(await open())
    } catch (error) {
      // The database is away, or this process may not write to it. Asked again, it is tried again.
      console.error(isFault(error) ? `${error.code}: ${error.message}` : error)
      return void response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' }).end(JSON.stringify(isFault(error) ? { fault: { code: error.code, message: error.message, retryable: error.retryable, detail: error.detail } } : { fault: { code: FAULT_CODES.GRAPH.UNAVAILABLE, message: 'The database is not available', retryable: true, detail: {} } }))
    }
    await made.handler(request, response)
  }
  return Object.assign(edge, { drain: async () => made?.drain() })
}
