import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Graph } from './graph.ts'
import { identifier, ip } from './identifiers.ts'
import { trusted } from './integrations/fingerprint.ts'
import type { FingerprintVerifier } from './integrations/fingerprint.ts'
import { shared } from './integrations/maxmind.ts'
import type { IpLookup } from './integrations/maxmind.ts'
import type { Outbox } from './outbox.ts'
import { reviewPage } from './review.ts'
import { browserScripts, scriptHeaders } from './tag.ts'
import type { Identifier, Level, Subject, Touch } from './types.ts'

export interface HandlerOptions {
  /**
   * The bearer token your own services send. It opens every route. Visitors'
   * browsers never hold it. Give reviewers `reviewToken` instead: the
   * reviewer screen keeps whichever token is typed for that browser tab.
   */
  token: string
  /**
   * A second token, for people who review accounts. It opens the reviewer
   * screen's routes: reading subjects, clusters, flows and decisions, and
   * keeping apart, joining, muting and forgetting. It does not open the
   * routes your services write through, so a reviewer cannot record
   * observations, transfers, consent, or conversions.
   */
  reviewToken?: string
  /** Site origins allowed to post to `/collect`, such as `https://example.org`. */
  origins: readonly string[]
  /** Read the visitor's address from `x-forwarded-for`. Turn on only behind a proxy you run. */
  trustProxy?: boolean
  /** Confirms a Fingerprint event id. Without it, `fingerprintEvent` in a visit is dropped. */
  fingerprint?: FingerprintVerifier
  /** Classifies the visitor's address. A shared address is recorded but links nothing. */
  ipInfo?: IpLookup
  /**
   * Have `/collect` keep the device id in a cookie the server sets. Safari
   * deletes a cookie set by script after seven days; one set by the server
   * lasts. It only works when `/collect` is served from the site's own
   * domain or a subdomain of it. `domain` shares the cookie across subdomains.
   */
  cookie?: boolean | { domain?: string }
  /**
   * How many visits one address may post to `/collect`. The origin check
   * only stops browsers; a script can claim any origin, so this is what
   * keeps one sender from flooding the graph. Each address may send `burst`
   * at once and `perMinute` over time. Defaults to 120 a minute with a burst
   * of 60. Pass `false` to turn it off, when a proxy in front already limits.
   */
  limit?: false | { perMinute?: number; burst?: number }
  /** Sends outcomes posted to `/convert` to ad platforms. Without it, they are only counted for the report. */
  outbox?: Outbox
  /** The time zone `/report` reads its days in when the request names none. Use the ad account's. Defaults to UTC. */
  timeZone?: string
  /** The clock, for tests. */
  now?: () => number
}

const ID = /^[\w.-]{1,128}$/
const TOUCH_FIELDS = [
  'source', 'medium', 'campaign', 'campaignId', 'adGroupId', 'adId', 'term', 'content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'landing', 'referrer',
] as const
const NAME = /^[\w.-]{1,64}$/

/** What the reviewer token opens: what the reviewer screen reads, and the decisions a reviewer makes. */
const REVIEW_ROUTES = new Set([
  'GET /subject', 'GET /clusters', 'GET /search', 'GET /recent', 'GET /links', 'GET /cluster', 'GET /history', 'GET /flows', 'GET /collusion', 'GET /rings',
  'GET /decisions', 'GET /audit', 'GET /report', 'POST /separate', 'POST /join', 'POST /ignore', 'POST /forget',
])

/** A route that wrote its own answer. */
const SENT = Symbol('sent')

class Refusal extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * An HTTP handler for `node:http`. `/collect` is open to the listed origins,
 * `/collect.js` is the script tag that posts to it, `/review` serves the
 * reviewer screen, `/health` says the database answers, and every other
 * route needs a bearer token.
 */
export function createHandler(graph: Graph, options: HandlerOptions) {
  const now = options.now ?? Date.now
  const token = Buffer.from(options.token)

  const reviewToken = options.reviewToken ? Buffer.from(options.reviewToken) : undefined
  if (reviewToken && reviewToken.equals(token)) throw new TypeError('The reviewer token must differ from the service token')
  const matches = (sent: Buffer, expected: Buffer) => sent.length === expected.length && timingSafeEqual(sent, expected)

  /** Refuses the request unless it carries the service token, or the reviewer token on a route reviewers may use. */
  const authorize = (request: IncomingMessage, path: string) => {
    const sent = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
    if (matches(sent, token)) return
    if (!reviewToken || !matches(sent, reviewToken)) throw new Refusal(401, 'Missing or wrong token')
    if (!REVIEW_ROUTES.has(path)) throw new Refusal(403, 'The reviewer token does not open this route')
  }

  const ignoredAddresses = new Set<Identifier>()

  /** What this process has done since it started, for `/stats`. */
  const tally = { since: now(), collected: 0, limited: 0, errors: 0 }

  // A token bucket per address: it refills steadily and a visit spends one token.
  const perMinute = options.limit === false ? Infinity : (options.limit?.perMinute ?? 120)
  const burst = options.limit === false ? Infinity : (options.limit?.burst ?? 60)
  const buckets = new Map<string, { tokens: number; at: number }>()
  const allowed = (address: string): boolean => {
    if (perMinute === Infinity) return true
    const at = now()
    const bucket = buckets.get(address) ?? { tokens: burst, at }
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 60_000) * perMinute)
    bucket.at = at
    if (buckets.size >= 50_000 && !buckets.has(address)) buckets.clear()
    buckets.set(address, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }
  const addressOf = (request: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(request.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : ''
    return forwarded || request.socket.remoteAddress || ''
  }

  const cookieDomain = typeof options.cookie === 'object' && options.cookie.domain ? `; Domain=${options.cookie.domain}` : ''

  /** Records one browser visit. The subject is the visitor; nothing here names an account. */
  async function collect(request: IncomingMessage, response: ServerResponse) {
    const body = await json(request)
    const at = now()
    let device = typeof body.device === 'string' && ID.test(body.device) ? body.device : undefined
    if (options.cookie) {
      // The cookie outlives what the page remembers, so it wins. A first visit adopts the page's id.
      const kept = /(?:^|; )ag_device=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
      device = kept && ID.test(kept) ? kept : (device ?? randomUUID())
      response.setHeader('set-cookie', `ag_device=${device}; Max-Age=${400 * 86_400}; Path=/; HttpOnly; Secure; SameSite=Lax${cookieDomain}`)
    }
    if (!device) throw new Refusal(400, 'Body needs a device id')
    const subject = `visitor:${device}`
    const identifiers: Identifier[] = [identifier('device', device)]

    // The browser's opt-out signal, or an answer from your consent banner, covers advertising only.
    const optedOut = request.headers['sec-gpc'] === '1' || body.gpc === true
    const answered = typeof body.consent?.adUserData === 'boolean' && typeof body.consent?.adPersonalization === 'boolean'
    const consent = optedOut ? { adUserData: false, adPersonalization: false } : answered ? body.consent : undefined
    const advertising = consent?.adUserData !== false

    // Reported by the page and not confirmed by anyone.
    for (const kind of advertising ? ['ga', 'canvas'] : ['canvas']) {
      const value = body[kind]
      if (typeof value === 'string' && ID.test(value)) identifiers.push(identifier(kind, value))
    }

    if (options.fingerprint && typeof body.fingerprintEvent === 'string') {
      // A vendor outage must not lose the visit: record it without the fingerprint.
      const verified = await options.fingerprint(body.fingerprintEvent).catch((error) => void console.error(error))
      if (verified?.bot === 'bad') return
      if (verified && trusted(verified, { now: at })) identifiers.push(identifier('fingerprint', verified.visitorId))
    }

    const address = addressOf(request)
    if (address) {
      const seen = ip(address)
      identifiers.push(seen)
      if (options.ipInfo && !ignoredAddresses.has(seen)) {
        const info = await options.ipInfo(address.replace(/^::ffff:/, '')).catch((error) => void console.error(error))
        if (shared(info ?? undefined)) {
          await graph.ignore(seen)
          if (ignoredAddresses.size >= 100_000) ignoredAddresses.clear()
          ignoredAddresses.add(seen)
        }
      }
    }
    await graph.observe({ subject, identifiers, at, event: 'visit' })
    if (consent) await graph.consent(subject, consent)

    if (advertising && body.touch && typeof body.touch === 'object') {
      const touch: Touch = { subject, at }
      for (const field of TOUCH_FIELDS) {
        const value = body.touch[field]
        if (typeof value === 'string' && value.length <= 2048) touch[field] = value
      }
      // Parameters of the site's own: a few short ones, so a page cannot fill the table.
      const custom = Object.entries(body.touch.custom && typeof body.touch.custom === 'object' ? body.touch.custom : {})
        .filter(([name, value]) => NAME.test(name) && typeof value === 'string' && value.length <= 256)
        .slice(0, 10)
      if (custom.length > 0) touch.custom = Object.fromEntries(custom) as Record<string, string>
      await graph.touch(touch)
    }
  }

  /** Everything the reviewer screen shows about one subject, in one answer. */
  async function profile(subject: Subject) {
    const cluster = await graph.cluster(subject)
    if (!cluster) return { subject, known: false }
    const links = await graph.links(subject)
    const ties = new Map<string, { a: Subject; b: Subject; score: number; level: Level }>()
    const add = (from: Subject, to: Subject, score: number, level: Level) => {
      const [a, b] = from < to ? [from, to] : [to, from]
      ties.set(`${a}\u0000${b}`, { a, b, score, level })
    }
    for (const link of links) add(subject, link.subject, link.score, link.level)
    // The ties among the cluster's other members, so the picture shows how the cluster holds together.
    // Walk them in the order the picture places them: the subject's own ties first, then the rest, up to 24.
    const members = new Set(cluster.members)
    const placed = [...new Set([...links.map((link) => link.subject).filter((other) => members.has(other)), ...cluster.members])]
    for (const member of placed.filter((other) => other !== subject).slice(0, 24)) {
      for (const link of await graph.links(member)) if (members.has(link.subject)) add(member, link.subject, link.score, link.level)
    }
    return {
      subject,
      known: true,
      cluster,
      links,
      ties: [...ties.values()],
      separated: await graph.separations(subject),
      flows: await graph.flows(subject),
      rings: await graph.rings(subject),
      history: (await graph.history(subject, 100)).reverse(),
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = `${request.method} ${url.pathname}`
    const origin = request.headers.origin

    if (url.pathname === '/collect') {
      if (!origin || !options.origins.includes(origin)) throw new Refusal(403, 'Origin is not allowed')
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'origin')
      if (options.cookie) response.setHeader('access-control-allow-credentials', 'true')
      if (request.method !== 'POST') throw new Refusal(405, 'Use POST')
      if (!allowed(addressOf(request))) {
        tally.limited += 1
        response.setHeader('retry-after', String(Math.ceil(60 / perMinute)))
        throw new Refusal(429, 'Too many visits from this address')
      }
      await collect(request, response)
      tally.collected += 1
      return undefined
    }

    if (path === 'GET /health') {
      // Reads one row, so it answers only when the database does.
      await graph.separations('health')
      return { ok: true }
    }

    if (path === 'GET /collect.js' || path === 'GET /fingerprint.js') {
      // The script tag for your sites. Public, like the pages that load it.
      const scripts = browserScripts()
      response.writeHead(200, scriptHeaders).end(path === 'GET /collect.js' ? scripts.collect : scripts.fingerprint)
      return SENT
    }

    if (path === 'GET /review') {
      // The page is only a shell. Nothing it shows arrives without the token.
      const page = reviewPage()
      response.writeHead(200, page.headers).end(page.html)
      return SENT
    }

    authorize(request, path)
    const subject = url.searchParams.get('subject') ?? ''
    switch (path) {
      case 'POST /observe':
        return graph.observe(await json(request))
      case 'POST /touch':
        return graph.touch(await json(request))
      case 'POST /ignore': {
        const body = await json(request)
        return graph.ignore(body.identifier, body.ignored ?? true, why(body))
      }
      case 'POST /forget': {
        const body = await json(request)
        return graph.forget(body.subject, why(body))
      }
      case 'POST /consent': {
        const body = await json(request)
        return graph.consent(body.subject, body.consent)
      }
      case 'POST /join': {
        const body = await json(request)
        return graph.join(body.a, body.b, why(body))
      }
      case 'GET /subject':
        return profile(subject)
      case 'GET /clusters':
        return graph.clusters(50, Math.max(0, Number(url.searchParams.get('offset')) || 0))
      case 'GET /search':
        return graph.search(url.searchParams.get('q') ?? '')
      case 'GET /recent':
        return graph.recent()
      case 'POST /separate': {
        const body = await json(request)
        return graph.separate(body.a, body.b, body.separated ?? true, why(body))
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
      case 'GET /attribute':
        return graph.attribute(subject, { at: Number(url.searchParams.get('at') ?? now()) })
      case 'GET /verify':
        return graph.verify()
      case 'GET /stats':
        return { ...tally, graph: await graph.counts(), ...(options.outbox && { outbox: await options.outbox.counts() }) }
      case 'POST /prune': {
        const body = await json(request)
        return { pruned: await graph.prune(body.before, why(body)) }
      }
      case 'GET /decisions':
        return graph.decisions()
      case 'GET /audit':
        return graph.audit()
      case 'POST /convert': {
        // Counted for the report either way. Sent to ad platforms when one is set up and the outcome names an action.
        const body = await json(request)
        if (options.outbox && body.action) return options.outbox.record(body)
        await graph.outcome(body)
        return []
      }
      case 'POST /restate': {
        const body = await json(request)
        if (options.outbox) return options.outbox.restate(body.transactionId, body.value, body.currency)
        await graph.restate(body.transactionId, body.value, body.currency)
        return []
      }
      case 'POST /costs': {
        const body = await json(request)
        const costs = Array.isArray(body) ? body : body.costs
        if (!Array.isArray(costs)) throw new Refusal(400, 'Body needs a list of costs')
        await graph.spend(costs)
        return { recorded: costs.length }
      }
      case 'GET /report': {
        const today = new Date(now()).toISOString().slice(0, 10)
        const to = url.searchParams.get('to') || today
        const from = url.searchParams.get('from') || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000 || now()).toISOString().slice(0, 10)
        return graph.report({ from, to, timeZone: url.searchParams.get('tz') || options.timeZone || 'UTC' })
      }
      case 'GET /conversions': {
        if (!options.outbox) break
        const state = url.searchParams.get('state') ?? 'failed'
        if (!['pending', 'sent', 'skipped', 'failed'].includes(state)) throw new Refusal(400, 'state must be pending, sent, skipped, or failed')
        return options.outbox.list(state as 'pending' | 'sent' | 'skipped' | 'failed')
      }
      case 'POST /retry': {
        if (!options.outbox) break
        return options.outbox.retry((await json(request)).transactionId)
      }
      case 'GET /conversion':
        if (!options.outbox) break
        return options.outbox.get(url.searchParams.get('id') ?? '')
    }
    throw new Refusal(404, 'No such route')
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const result = await route(request, response)
      if (result === SENT) return
      if (result === undefined) return void response.writeHead(204).end()
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      const refused = error instanceof Refusal || error instanceof TypeError || error instanceof SyntaxError
      const status = error instanceof Refusal ? error.status : refused ? 400 : 500
      const message = refused ? (error as Error).message : 'Internal error'
      if (!refused) {
        tally.errors += 1
        console.error(error)
      }
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }))
    }
  }
}

/** Who is deciding and why, from a request body, for the record of decisions. */
function why(body: any): { by?: string; reason?: string } {
  return {
    ...(typeof body.by === 'string' && body.by && { by: body.by.slice(0, 200) }),
    ...(typeof body.reason === 'string' && body.reason && { reason: body.reason.slice(0, 1000) }),
  }
}

async function json(request: IncomingMessage): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Refusal(413, 'Body is over 1 MB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
