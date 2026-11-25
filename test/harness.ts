/**
 * The graph over plain routes, for tests. What was a route for backends
 * before there were six calls is served here from the same functions the
 * calls use, so what those do is tested through HTTP. Browsers, Twilio and
 * the reviewer screen go to the edge the package ships.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { isFault, malformed } from '../src/contract/fault.ts'
import type { Deciding, Identifier, Subject, Told, Why } from '../src/contract/types.ts'
import { callState, followUp, recordCall, recordCallResult, recordNotLead, recordReturn, ringing } from '../src/core/calls.ts'
import type { CallOptions } from '../src/core/calls.ts'
import type { Graph, PolicyState } from '../src/core/graph.ts'
import type { Ops } from '../src/core/ops.ts'
import { sentOf } from '../src/core/outbox.ts'
import type { Job, Outbox } from '../src/core/outbox.ts'
import type { AddressVerifier, LineTypeLookup } from '../src/core/ports.ts'
import { dayIn, dayStart, sourceOf } from '../src/core/report.ts'
import { createService } from '../src/core/service.ts'
import { knownLink, staffLink } from '../src/core/sign.ts'
import { asks, beginnings, recordText, replyTo } from '../src/core/texts.ts'
import { createHandler as createEdgeHandler } from '../src/edge/server.ts'
import type { Core, HandlerOptions as EdgeHandlerOptions } from '../src/edge/server.ts'

export interface HandlerOptions extends Omit<EdgeHandlerOptions, 'calls'> {
  address?: AddressVerifier
  lineType?: LineTypeLookup
  outbox?: Outbox
  identifierSecret?: string
  ops?: Ops
  calls?: CallOptions & { twilio?: { authToken: string; url: string } }
  v1?: Core['v1']
}

const NAME = /^[\w.-]{1,64}$/
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
const shownJob = ({ keys, ...job }: Job) => job
/** Routes of the reviewer screen, which the edge serves under a prefix of their own. */
const SCREEN = new Set(['GET /me', 'GET /subject', 'GET /ops', 'GET /pulse', 'GET /clusters', 'POST /find', 'POST /foresee', 'GET /recent', 'POST /separate', 'POST /join', 'POST /ignore', 'POST /forget', 'GET /journey', 'GET /board', 'GET /decisions', 'GET /disputes', 'GET /audit', 'GET /report', 'GET /followed', 'GET /texts', 'GET /calls', 'GET /calls/summary', 'GET /policy', 'GET /undecided', 'GET /between', 'GET /conversions', 'POST /retry'])
/** What a reviewer could read before, besides the screen. */
const READS = new Set(['GET /search', 'GET /links', 'GET /cluster', 'GET /history', 'GET /flows', 'GET /collusion', 'GET /rings', 'GET /consent', 'GET /outcome', 'GET /call', 'POST /match', 'POST /people', 'POST /conflicts', 'POST /call/ringing', 'GET /text', 'GET /texting'])

class Refusal extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function createHandler(graph: Graph, options: HandlerOptions) {
  const now = options.now ?? Date.now
  const service = createService(graph, { ...options, now })
  const { convert, calling, textOptions, identify, factsIn, named } = service
  const pool = service.pool
  const core: Core = {
    graph,
    service,
    outbox: options.outbox,
    ops: options.ops,
    called: (call) => recordCall(graph, call, calling()),
    texted: (text) => recordText(graph, text, textOptions()),
    async forget(subjects, why, retract) {
      if (options.outbox) return options.outbox.forget(subjects, why, { retract })
      let jobs: Job[] = []
      return { changes: await graph.forget(subjects, why, (gone) => void (jobs = gone)), sent: sentOf(jobs) }
    },
    ...(options.v1 && { v1: options.v1 }),
  }
  const edge = createEdgeHandler(core, options as EdgeHandlerOptions)
  const { tally } = edge
  const same = (sent: string, token: string) => sent.length === token.length && timingSafeEqual(Buffer.from(sent), Buffer.from(token))
  const sentBy = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const reviewerOf = (request: IncomingMessage) => Object.entries(options.reviewers ?? {}).find(([, tokens]) => [tokens].flat().some((token) => same(sentBy(request), token)))?.[0]
  const why = (body: any): { by?: string; reason?: string } => ({ ...(typeof body.by === 'string' && body.by && { by: body.by.slice(0, 200) }), ...(typeof body.reason === 'string' && body.reason && { reason: body.reason.slice(0, 1000) }) })
  const listed = (request: IncomingMessage, body: any, withdrawals: boolean): [Told[], Why] => {
    if (reviewerOf(request) !== undefined) throw new Refusal(403, 'The list form of this route requires a service token')
    if (!Array.isArray(body.pairs) || body.pairs.length > 1000) throw new Refusal(400, '`pairs` must be a list of at most 1000')
    if (typeof body.source !== 'string' || !NAME.test(body.source)) throw new Refusal(400, 'A list requires its `source`: the name of the system it is from')
    for (const each of body.pairs) {
      if (!each || typeof each !== 'object') throw new Refusal(400, 'Each pair must be written { a, b }')
      if (withdrawals && each.separated !== undefined && typeof each.separated !== 'boolean') throw new Refusal(400, '`separated` must be true or false')
    }
    return [body.pairs.map(({ a, b, separated, reason }: any) => ({ a, b, ...(withdrawals && separated !== undefined && { separated }), ...(typeof reason === 'string' && reason && { reason: reason.slice(0, 1000) }) })), why({ ...body, by: `system:${body.source}` })]
  }
  const period = (url: URL) => {
    const timeZone = url.searchParams.get('tz') || options.timeZone || 'UTC'
    const to = url.searchParams.get('to') || dayIn(now(), timeZone)
    const from = url.searchParams.get('from') || new Date(dayStart(to) - 29 * 86_400_000).toISOString().slice(0, 10)
    return { from, to, timeZone }
  }
  const spokenWith = async (of: Subject) => {
    const calls = await graph.callsOf([of])
    const not = await graph.notLeads(calls.map((call) => `call:${call.id}`))
    return calls.filter((call) => !not.has(`call:${call.id}`))
  }
  const afterOf = (url: URL) => {
    const after = url.searchParams.get('after') ?? ''
    const cut = after.indexOf(' ')
    if (after && !(cut > 0 && Number.isSafeInteger(Number(after.slice(0, cut))))) throw new Refusal(400, '`after` must be a `next` value from a page')
    return after ? { at: Number(after.slice(0, cut)), id: after.slice(cut + 1) } : undefined
  }
  const brief = ({ hash, builtWith, due }: PolicyState) => ({ hash, builtWith: builtWith ?? null, due })

  async function route(request: IncomingMessage, url: URL, path: string, text: () => Promise<string>): Promise<unknown> {
    const parsed = (sent: string): any => {
      let body: unknown
      try {
        body = JSON.parse(sent)
      } catch (error) {
        throw malformed((error as Error).message)
      }
      if (typeof body !== 'object' || body === null) throw malformed('Body must be a JSON object')
      storable(body)
      return body
    }
    const json = async (_: IncomingMessage) => parsed(await text())
    const subject = url.searchParams.get('subject') ?? ''
    storable([...url.searchParams.values()])
    switch (path) {
      case 'POST /join':
        return graph.joinAll(...listed(request, await json(request), false))
      case 'POST /separate':
        return graph.separateAll(...listed(request, await json(request), true))
      case 'POST /observe':
        return graph.observe(await json(request))
      case 'POST /identify':
        return identify(await json(request))
      case 'POST /match': {
        const body = await json(request)
        const { identifiers, notes, at } = await factsIn(body, false)
        return { candidates: await graph.match([...identifiers, ...(await named(body, identifiers)), ...(await named(body, identifiers, 'ward'))], { at }), notes }
      }
      case 'POST /conflicts': {
        const { subjects } = await json(request)
        if (!Array.isArray(subjects) || subjects.length === 0 || subjects.length > 50 || !subjects.every((each) => typeof each === 'string' && each)) throw new Refusal(400, '`subjects` must be a list of 1 to 50 ids')
        return { conflicts: await graph.conflicts(subjects) }
      }
      case 'POST /call/ringing': {
        const body = await json(request)
        const { touch, ...rest } = await ringing(graph, { ...body, at: body.at ?? now() }, calling())
        return { ...rest, ...(touch && { source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null, landing: touch.landing ?? null }) }
      }
      case 'POST /touch':
        return graph.touch(await json(request))
      case 'POST /consent': {
        const body = await json(request)
        await graph.consent(body.subject, body.consent, { ...(body.at !== undefined && { at: body.at }), ...(body.source !== undefined && { source: body.source }) })
        return undefined
      }
      case 'POST /alerts/test':
        if (!options.ops) break
        return options.ops.test()
      case 'GET /search':
        return graph.search(url.searchParams.get('q') ?? '')
      case 'GET /changes': {
        const [after, limit] = [url.searchParams.get('after') ?? '0', url.searchParams.get('limit') ?? '500']
        return graph.changes({ after: /^\d+$/.test(after) ? Number(after) : NaN, limit: /^\d+$/.test(limit) ? Math.min(Number(limit), 1_000) : NaN })
      }
      case 'POST /transfer':
        return graph.transfer(await json(request))
      case 'GET /flows':
        return graph.flows(subject)
      case 'GET /collusion':
        return graph.collusion(subject)
      case 'GET /rings':
        return graph.rings(subject)
      case 'GET /links':
        return graph.links(subject)
      case 'GET /cluster':
        return (await graph.cluster(subject)) ?? null
      case 'GET /history':
        return graph.history(subject)
      case 'GET /attribute': {
        const at = Number(url.searchParams.get('at') ?? now())
        if (!Number.isSafeInteger(at)) throw new Refusal(400, '`at` must be an integer in epoch milliseconds')
        return graph.attribute(subject, { at })
      }
      case 'POST /rebuild': {
        // Nothing in the body is needed, so none has to be sent.
        const sent = await text()
        return graph.rebuild(why(sent.trim() ? parsed(sent) : {}))
      }
      case 'GET /verify': {
        const { changes, policy } = await graph.check()
        return { changes, policy: brief(policy) }
      }
      case 'GET /stats':
        return { ...tally, policy: brief(await graph.policy()), graph: await graph.counts(), ...(options.outbox && { outbox: await options.outbox.counts() }) }
      case 'POST /prune': {
        const body = await json(request)
        return { pruned: await graph.prune(body.before, why(body)) }
      }
      case 'GET /consent':
        return graph.consentHistory(subject)
      case 'POST /convert': {
        const body = await json(request)
        if (/^(call|text|page):/.test(String(body?.transactionId ?? ''))) throw new Refusal(400, 'A `transactionId` cannot begin with call:, text: or page:')
        return (await convert(body)).map(shownJob)
      }
      case 'POST /link': {
        if (!options.linkSecret) break
        const body = await json(request)
        if (body.days !== undefined && typeof body.days !== 'number') throw new Refusal(400, '`days` must be a number')
        const { url, purpose, days = 30 } = body
        if (purpose !== undefined && !(typeof purpose === 'string' && NAME.test(purpose))) throw new Refusal(400, '`purpose` must be a short word, such as "form"')
        const id = randomUUID()
        const made = now()
        // A token ends on a whole second, and so does what is kept of it.
        const expires = Math.floor((made + days * 86_400_000) / 1000) * 1000
        const address = knownLink(String(url), body.subject, { secret: options.linkSecret, id, now: () => made, lasts: expires - made })
        await graph.keepLink({ id, subject: body.subject, ...(purpose !== undefined && { purpose }), at: made, expires })
        return { url: address, id }
      }
      case 'GET /sent':
        return graph.linksSent(subject)
      case 'POST /staff-link': {
        if (!options.linkSecret) break
        const body = await json(request)
        if (body.days !== undefined && typeof body.days !== 'number') throw new Refusal(400, '`days` must be a number')
        return { url: staffLink(String(body.url), { secret: options.linkSecret, now, ...(body.days !== undefined && { lasts: body.days * 86_400_000 }) }) }
      }
      case 'POST /call':
        return recordCall(graph, await json(request), calling())
      case 'POST /text':
        return recordText(graph, await json(request), textOptions())
      case 'GET /text': {
        const kept = await graph.keptText(url.searchParams.get('id') ?? '')
        if (!kept) return null
        const said = (await graph.notLeads([`text:${kept.id}`])).get(`text:${kept.id}`)
        const own = await graph.textsOf([kept.subject])
        return { ...kept, flags: [...(beginnings(own).has(kept.id) ? ['first'] : []), ...kept.flags], ...(said && { notLead: said.kind }), ...(asks(kept) && { reply: replyTo(kept, own, await spokenWith(kept.subject)) }) }
      }
      case 'GET /texting':
        return (await graph.texting(subject)) ?? null
      case 'GET /outcome': {
        const id = url.searchParams.get('id') ?? ''
        const outcome = await graph.outcomeOf(id)
        const said = (await graph.notLeads([id])).get(id)
        return outcome ? { ...outcome, values: await graph.values(id), ...(said && { notLead: said.kind }) } : null
      }
      case 'GET /call': {
        const call = await graph.keptCall(url.searchParams.get('id') ?? '')
        if (!call) return null
        const missed = call.direction === 'inbound' && call.result?.answered === false
        const said = (await graph.notLeads([`call:${call.id}`])).get(`call:${call.id}`)
        return { ...call, ...(said && { notLead: said.kind }), state: callState(call, now(), options.calls), ...(missed && { followUp: followUp(call, await graph.callsOf([call.subject])) }) }
      }
      case 'POST /call/result':
        return (await recordCallResult(graph, await json(request), calling())) ?? { state: 'waiting', counted: false }
      case 'POST /not-lead':
        return recordNotLead(graph, await json(request), calling())
      case 'POST /call/returned':
        return { followUp: (await recordReturn(graph, await json(request), calling())) ?? null }
      case 'POST /restate': {
        const body = await json(request)
        if (options.outbox) return (await options.outbox.restate(body.transactionId, body.value, body.currency, body.kind)).map(shownJob)
        await graph.restate(body.transactionId, body.value, body.currency, body.kind)
        return []
      }
      case 'POST /payment': {
        const body = await json(request)
        if (options.outbox) {
          const paid = await options.outbox.pay(body)
          return { ...paid, jobs: paid.jobs.map(shownJob) }
        }
        return { ...(await graph.pay(body)), jobs: [] }
      }
      case 'POST /people': {
        const { subjects } = await json(request)
        if (!Array.isArray(subjects) || subjects.length === 0 || subjects.length > 100 || !subjects.every((each) => typeof each === 'string' && each)) throw new Refusal(400, '`subjects` must be a list of 1 to 100 ids')
        return { people: (await graph.people(subjects)).map(({ touch, ...person }) => ({ ...person, ...(touch && { source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null }) })) }
      }
      case 'POST /costs': {
        const body = await json(request)
        const costs = Array.isArray(body) ? body : body.costs
        if (!Array.isArray(costs)) throw new Refusal(400, 'Body requires a list of costs')
        await graph.spend(costs)
        return { recorded: costs.length }
      }
      case 'GET /conversion':
        if (!options.outbox) break
        return (await options.outbox.get(url.searchParams.get('id') ?? '')).map(shownJob)
    }
    throw new Refusal(404, 'No such route')
  }

  const ROUTES = new Set(['POST /observe', 'POST /identify', 'POST /match', 'POST /conflicts', 'POST /call/ringing', 'POST /touch', 'POST /consent', 'POST /alerts/test', 'GET /search', 'GET /changes', 'POST /transfer', 'GET /flows', 'GET /collusion', 'GET /rings', 'GET /links', 'GET /cluster', 'GET /history', 'GET /attribute', 'POST /rebuild', 'GET /verify', 'GET /stats', 'POST /prune', 'GET /consent', 'POST /convert', 'POST /link', 'GET /sent', 'POST /staff-link', 'POST /call', 'POST /text', 'GET /text', 'GET /texting', 'GET /outcome', 'GET /call', 'POST /call/result', 'POST /not-lead', 'POST /call/returned', 'POST /restate', 'POST /payment', 'POST /people', 'POST /costs', 'GET /conversion'])
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = `${request.method} ${url.pathname}`
    const pass = () => {
      if (SCREEN.has(path)) request.url = `/review/api${request.url}`
      return edge(request, response)
    }
    if (path !== 'POST /join' && path !== 'POST /separate' && !ROUTES.has(path)) return pass()
    const answer = (status: number, body?: unknown) => void (body === undefined ? response.writeHead(status).end() : response.writeHead(status, JSON_HEADERS).end(JSON.stringify(body)))
    try {
      if (!same(sentBy(request), options.token)) {
        const reviewer = reviewerOf(request)
        if (reviewer === undefined) return answer(401, { error: 'Missing or invalid token' })
        if (!READS.has(path) && path !== 'POST /join' && path !== 'POST /separate') return answer(403, { error: 'This route requires a service token' })
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 1_000_000) throw new Refusal(413, 'Body exceeds 1 MB')
        chunks.push(chunk)
      }
      const body = Buffer.concat(chunks)
      if (path === 'POST /join' || path === 'POST /separate') {
        // The list form was the backends' own. The other is the screen's.
        let list = false
        try {
          list = JSON.parse(body.toString('utf8'))?.pairs !== undefined
        } catch {}
        if (!list) {
          const { Readable } = await import('node:stream')
          const again = Object.assign(Readable.from(body.length > 0 ? [body] : []), { method: request.method, url: `/review/api${request.url}`, headers: request.headers, socket: request.socket }) as unknown as IncomingMessage
          return await edge(again, response)
        }
      }
      const result = await route(request, url, path, async () => {
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(body)
        } catch {
          throw malformed('Body must be UTF-8')
        }
      })
      if (DECIDES.has(path)) edge.forgetAnswers()
      answer(result === undefined ? 204 : 200, result)
    } catch (error) {
      const refused = error instanceof Refusal || isFault(error)
      if (!refused) {
        tally.errors += 1
        console.error(error)
      }
      answer(error instanceof Refusal ? error.status : refused ? 400 : 500, { error: refused ? (error as Error).message : 'Internal error' })
    }
  }
}
const DECIDES = new Set(['POST /rebuild', 'POST /not-lead', 'POST /call/returned', 'POST /join', 'POST /separate'])

const UNSTORABLE = /[\0\p{Surrogate}]/u
function storable(value: unknown): void {
  const left: [unknown, number][] = [[value, 0]]
  while (left.length > 0) {
    const [each, level] = left.pop()!
    if (typeof each === 'string' && UNSTORABLE.test(each)) throw new Refusal(400, 'Text contains unsupported characters')
    if (typeof each !== 'object' || each === null) continue
    if (level >= 32) throw new Refusal(400, 'Body exceeds 32 levels of nesting')
    for (const [key, inner] of Object.entries(each)) left.push([key, level + 1], [inner, level + 1])
  }
}
