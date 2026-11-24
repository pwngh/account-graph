import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { callState, dialed, followUp, numberOrSelf, recordCall, recordCallResult } from './calls.ts'
import type { CallOptions } from './calls.ts'
import { Outdated } from './graph.ts'
import type { Graph, PolicyState } from './graph.ts'
import { email, hashPhone, identifier, ip, nameKeys, normalizePhone, phoneOfType, UNSTORABLE } from './identifiers.ts'
import { trusted } from './integrations/fingerprint.ts'
import type { FingerprintVerifier } from './integrations/fingerprint.ts'
import { placeOf, shared } from './integrations/maxmind.ts'
import { addressIdentifier } from './integrations/smarty.ts'
import type { AddressVerifier } from './integrations/smarty.ts'
import { fromTwilio, twilioCall } from './integrations/twilio.ts'
import type { LineTypeLookup } from './integrations/twilio.ts'
import type { IpLookup } from './integrations/maxmind.ts'
import type { Ops } from './ops.ts'
import type { JobState, Outbox } from './outbox.ts'
import { withStage } from './ladder.ts'
import { dayIn, dayStart, sourceOf } from './report.ts'
import type { Ladder } from './ladder.ts'
import { defaultPolicy, plainPolicy } from './policy.ts'
import { reviewPage } from './review.ts'
import { browserMark, knownLink, readToken, signToken, staffLink } from './sign.ts'
import { browserScripts, scriptHeaders } from './tag.ts'
import { TOUCH_FIELDS } from './touch.ts'
import type { Deciding, Identifier, Level, Observation, Outcome, Subject, Told, Touch, Why } from './types.ts'

/** Each reviewer's name, and the token or tokens that are theirs. */
export type Reviewers = Readonly<Record<string, string | readonly string[]>>

export interface HandlerOptions {
  /**
   * The bearer token your own services send. It opens every route. Visitors'
   * browsers never hold it. Give people who review a token in `reviewers`.
   * The reviewer screen keeps whichever token is typed for that browser tab.
   */
  token: string
  /**
   * The people who review accounts, each with a token of their own, or
   * several while one is being replaced. A decision is signed with the name
   * its token belongs to. Such a token opens the reviewer screen's routes:
   * reading subjects, clusters, flows and decisions, and keeping apart,
   * joining, muting and forgetting. It does not open the routes your services
   * write through, so a reviewer cannot record observations, transfers,
   * consent, or conversions.
   */
  reviewers?: Reviewers
  /** Site origins allowed to post to `/collect`, such as `https://example.org`. */
  origins: readonly string[]
  /**
   * Read the visitor's address from `x-forwarded-for`. Turn on only behind a
   * proxy you run. `true` trusts one proxy; a number says how many stand in
   * front. Each proxy adds the address it heard from to the end of the
   * header, so the visitor's is that many entries from the end. Anything
   * earlier was written by the sender and is not believed.
   */
  trustProxy?: boolean | number
  /** Confirms a Fingerprint event id. Without it, `fingerprintEvent` in a visit is dropped. */
  fingerprint?: FingerprintVerifier
  /** Classifies the visitor's address. A shared address is recorded but links nothing. When it gives a place, the visit is noted with it. */
  ipInfo?: IpLookup
  /** Checks a postal address posted to `/identify`. Without it, addresses are not used. */
  address?: AddressVerifier
  /** Says what kind of line a phone number posted to `/identify` is, so a throwaway number counts for less. */
  lineType?: LineTypeLookup
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
  /**
   * Networks your own staff browse from, as addresses or ranges:
   * `192.0.2.10`, `198.51.100.0/24`, `2001:db8::/32`. Visits and page events
   * from them are dropped and counted.
   */
  staffNetworks?: readonly string[]
  /** Sends outcomes posted to `/convert` to ad platforms. Without it, they are only counted for the report. */
  outbox?: Outbox
  /**
   * The events a page may report to `/event`, by name: `inquiry`,
   * `phone_click`. Each is counted as an outcome of that name, once a day
   * per browser unless the page gives it an id. A name not listed is refused.
   */
  events?: readonly string[]
  /**
   * How phone calls posted to `/call` are recorded. With `twilio`, the
   * server also takes Twilio's status callbacks at `/calls/twilio`: `url` is
   * that route's public address exactly as entered in Twilio, which the
   * signature is checked against.
   */
  calls?: CallOptions & { twilio?: { authToken: string; url: string } }
  /**
   * The secret that signs links. With it, `/link` makes an address that
   * names the person it is sent to, a visit that arrives through one ties
   * the browser to that person, and `/carry` lets the script tag keep a
   * visitor the same visitor across your sites. Long and random.
   */
  linkSecret?: string
  /**
   * Your steps, in order, with what each is worth and what it counts as on
   * each ad platform. An outcome that names a step takes from it whatever
   * the outcome leaves out, so a page event or a call needs only its name.
   * `/report` lists the steps in this order.
   */
  stages?: Ladder
  /**
   * Numbers shown to one visitor at a time, and for how many minutes after
   * they last asked. `grace` is how many minutes after that a call still counts
   * as theirs when nobody has had the number since. Off by default.
   */
  pool?: { numbers: readonly string[]; minutes: number; grace: number }
  /** Makes the keys of names sent to `/identify`. Without it, names are not used. At least 32 characters; changing it makes every key new. */
  identifierSecret?: string
  /** How many hours a missed call may wait before `/board` says it has waited too long. Left out or 0, it never does. */
  returnHours?: number
    /** The time zone `/report` reads its days in when the request names none. Use the ad account's. Defaults to UTC. */
  timeZone?: string
  /** What runs by itself and who is told about it, for `/ops` and `/alerts/test`. */
  ops?: Ops
  /** The clock, for tests. */
  now?: () => number
}

const ID = /^[\w.-]{1,128}$/
const NAME = /^[\w.-]{1,64}$/

/** What a reviewer's token opens: what the reviewer screen reads, and the decisions a reviewer makes. */
const REVIEW_ROUTES = new Set([
  'GET /me', 'GET /subject', 'GET /clusters', 'GET /search', 'GET /recent', 'GET /links', 'GET /cluster', 'GET /history', 'GET /journey', 'GET /board', 'GET /flows', 'GET /collusion', 'GET /rings',
  'GET /decisions', 'GET /disputes', 'GET /consent', 'GET /outcome', 'GET /followed', 'GET /call', 'GET /calls', 'GET /calls/summary', 'GET /audit', 'GET /report', 'GET /pulse', 'GET /policy', 'GET /ops', 'POST /find', 'POST /separate', 'POST /join', 'POST /ignore', 'POST /forget',
  'GET /undecided', 'GET /between',
])

/** Answers hold people's data, so nothing keeps a copy of one. */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

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
 * An HTTP handler for `node:http`. `/collect` and `/event` are open to the listed origins,
 * `/collect.js` is the script tag that posts to it, `/review` serves the
 * reviewer screen, `/health` says the database answers, and every other
 * route needs a bearer token.
 */
export function createHandler(graph: Graph, options: HandlerOptions) {
  const now = options.now ?? Date.now
  const token = Buffer.from(options.token)

  const [problem] = reviewerProblems(options.reviewers, options.token)
  if (problem) throw new TypeError(problem)
  const reviewers = Object.entries(options.reviewers ?? {}).flatMap(([name, tokens]) => [tokens].flat().map((each) => ({ name, token: Buffer.from(each) })))
  const matches = (sent: Buffer, expected: Buffer) => sent.length === expected.length && timingSafeEqual(sent, expected)

  const sentToken = (request: IncomingMessage) => Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
  /** The reviewer a request's token belongs to. Every token is compared, so how long it takes says nothing of which. */
  const reviewerOf = (request: IncomingMessage): string | undefined => {
    const sent = sentToken(request)
    return reviewers.filter((each) => matches(sent, each.token))[0]?.name
  }

  /** Refuses the request unless it carries the service token, or a reviewer's on a route reviewers may use. */
  const authorize = (request: IncomingMessage, path: string) => {
    if (matches(sentToken(request), token)) return
    if (reviewerOf(request) === undefined) throw new Refusal(401, 'Missing or wrong token')
    if (!REVIEW_ROUTES.has(path)) throw new Refusal(403, 'A reviewer\'s token does not open this route')
  }

  /** A list of pairs from one of your systems, and who it is from. Only a service may speak for a system. */
  const listed = (request: IncomingMessage, body: any, withdrawals: boolean): [Told[], Why] => {
    if (reviewerOf(request) !== undefined) throw new Refusal(403, 'A reviewer\'s token does not open the list form of this route')
    if (!Array.isArray(body.pairs) || body.pairs.length > 1000) throw new Refusal(400, '`pairs` must be a list of at most 1000')
    if (typeof body.source !== 'string' || !NAME.test(body.source)) throw new Refusal(400, 'A list needs its `source`: the name of the system it is from')
    for (const each of body.pairs) {
      if (!each || typeof each !== 'object') throw new Refusal(400, 'Each pair must be written { a, b }')
      if (withdrawals && each.separated !== undefined && typeof each.separated !== 'boolean') throw new Refusal(400, '`separated` must be true or false')
    }
    return [body.pairs.map(({ a, b, separated, reason }: any) => ({ a, b, ...(withdrawals && separated !== undefined && { separated }), ...(typeof reason === 'string' && reason && { reason: reason.slice(0, 1000) }) })), why({ ...body, by: `system:${body.source}` })]
  }

  /** Who one decision is by, why, and what they had seen. A reviewer's name is the one their token belongs to, whatever the body says. */
  const signed = (request: IncomingMessage, body: any): Deciding => {
    const name = reviewerOf(request)
    if (name !== undefined && body.by !== undefined && body.by !== name) throw new Refusal(400, 'A decision is signed with the name its token belongs to')
    return { ...why(body), ...(name !== undefined && { by: name }), ...(body.seen !== undefined && { seen: body.seen }) }
  }

  const ignoredAddresses = new Set<Identifier>()

  const staffed = networks(options.staffNetworks ?? [])
  /** Whether a request comes from one of your own people: their network, or a browser marked by a staff link. A mark nobody signed is nothing. */
  const fromStaff = (request: IncomingMessage, body: any): boolean => {
    const address = addressOf(request).replace(/^::ffff:(?=\d+\.)/i, '')
    const family = isIP(address)
    if (family > 0 && staffed.check(address, family === 6 ? 'ipv6' : 'ipv4')) return true
    return Boolean(options.linkSecret && readToken(options.linkSecret, 'staff', body?.staff, now()))
  }

  const pool = [...new Set((options.pool?.numbers ?? []).map((number) => normalizePhone(number, options.calls?.country)))]

  /** What this process has done since it started, for `/stats`. */
  const tally = { since: now(), leased: 0, exhausted: 0, collected: 0, limited: 0, bots: 0, staff: 0, errors: 0 }

  /** A program that says what it is: a search crawler, a link previewer, an uptime check. Its visits are nobody's. */
  // "bot/" and not just "bot": phones are sold under names like Cubot, and their browsers are people.
  const BOT = /bot\/|adsbot|googlebot|storebot|petalbot|duckduckbot|telegrambot|slackbot|seznambot|spider|crawl|slurp|facebookexternalhit|whatsapp\/|bingpreview|google-inspectiontool|headlesschrome|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|datadogsynthetics|^curl\/|^wget\/|python-requests/i

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
    const hops = options.trustProxy === true ? 1 : Number(options.trustProxy) || 0
    const entries = hops > 0 ? String(request.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean) : []
    const forwarded = entries[Math.max(0, entries.length - hops)] ?? ''
    return forwarded || request.socket.remoteAddress || ''
  }

  const cookieDomain = typeof options.cookie === 'object' && options.cookie.domain ? `; Domain=${options.cookie.domain}` : ''

  /** The device id of a browser's request. With the server's cookie on, the cookie decides and is renewed. */
  function deviceOf(request: IncomingMessage, response: ServerResponse, body: any): string {
    let device = typeof body.device === 'string' && ID.test(body.device) ? body.device : undefined
    if (options.cookie) {
      // The cookie outlives what the page remembers, so it wins. A first visit adopts the page's id.
      const kept = /(?:^|; )ag_device=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
      device = kept && ID.test(kept) ? kept : (device ?? randomUUID())
      response.setHeader('set-cookie', `ag_device=${device}; Max-Age=${400 * 86_400}; Path=/; HttpOnly; Secure; SameSite=Lax${cookieDomain}`)
    }
    if (!device) throw new Refusal(400, 'Body needs a device id')
    return device
  }

  /** Counts an outcome for the report, and sends it to the ad platforms when one is set up and the outcome names an action. */
  const convert = async (given: Outcome) => {
    const outcome = withStage(options.stages, given)
    if (options.outbox && outcome.action) return options.outbox.record(outcome)
    await graph.outcome(outcome)
    return []
  }

  /** How calls are recorded: with the steps' values and, where an ad platform is set up, held and taken back through the outbox. */
  const calling = (): CallOptions => {
    const { outbox } = options
    const staged = (outcome: Outcome) => withStage(options.stages, outcome)
    const sends = (outcome: Outcome) => Boolean(outbox && staged(outcome).action)
    return {
      ...options.calls,
      ...(pool.length > 0 && { pool: { numbers: pool, grace: options.pool!.grace * 60_000 } }),
      now,
      convert,
      ...(outbox && {
        hold: async (outcome: Outcome) => (sends(outcome) ? outbox.hold(staged(outcome)) : []),
        release: async (outcome: Outcome) => (sends(outcome) ? outbox.release(staged(outcome)) : convert(outcome)),
        withdraw: (transactionId: string) => outbox.withdraw(transactionId),
      }),
      ...(lineOf && { lineType: lineOf }),
    }
  }

  const events = new Set(options.events ?? [])
  const trackingNumbers = options.calls?.numbers && new Set(Object.keys(options.calls.numbers).map((number) => numberOrSelf(number, options.calls?.country)))

  // A tap ties a call to a browser, so one address tapping from many browsers in a few minutes is not believed.
  // A household has a few devices; a program inventing visitors has as many as it likes.
  const tappers = new Map<string, { devices: Set<string>; since: number }>()
  const tapsFrom = (address: string, device: string, at: number): boolean => {
    // One network, not one address: a single machine holds a whole range of IPv6 addresses.
    let network = address
    try {
      network = ip(address)
    } catch {}
    let seen = tappers.get(network)
    if (!seen || at - seen.since > 10 * 60_000) {
      if (tappers.size >= 50_000) tappers.clear()
      tappers.set(network, (seen = { devices: new Set(), since: at }))
    }
    // The first three browsers stay believed; a fourth is turned away without costing them their place.
    if (!seen.devices.has(device) && seen.devices.size >= 3) return false
    seen.devices.add(device)
    return true
  }

  /** Records something a visitor did on a page. Only names the server was told to accept are kept. */
  async function happened(request: IncomingMessage, response: ServerResponse) {
    const body = await json(request)
    if (typeof body.event !== 'string' || !events.has(body.event)) throw new Refusal(400, 'This server does not take that event')
    if (fromStaff(request, body)) return void (tally.staff += 1)
    const device = deviceOf(request, response, body)
    const subject = `visitor:${device}`
    const at = now()
    const identifiers: Identifier[] = [identifier('device', device)]
    // A tapped phone number is noted, so a call that follows can be tied to this visitor.
    if (body.event === 'phone_click' && typeof body.number === 'string' && body.number.length <= 40) {
      try {
        const note = dialed(body.number, at, options.calls?.country)
        // When the tracking numbers are known, a tap on any other number is not worth a note.
        const rung = note.slice('dialed:'.length, note.lastIndexOf('@'))
        const tracked = !trackingNumbers || trackingNumbers.has(rung) || pool.includes(rung)
        if (tracked && tapsFrom(addressOf(request), device, at)) identifiers.push(note)
      } catch {}
    }
    await graph.observe({ subject, identifiers, at, event: body.event })
    // A page may number its own occurrences, but not of a step that is worth something or is sent to an ad platform:
    // those count once a day per browser whatever the page says, because a page can be made to say anything.
    const step = options.stages && Object.hasOwn(options.stages, body.event) ? options.stages[body.event] : undefined
    const weighty = Boolean(step?.value || step?.action)
    const occurrence = !weighty && typeof body.id === 'string' && ID.test(body.id) ? body.id : new Date(at).toISOString().slice(0, 10)
    const transactionId = `${body.event}:${device}:${occurrence}`
    // The same occurrence reported again is already on its way; recording it twice with a new time would be refused.
    if (options.outbox && (await options.outbox.get(transactionId)).length > 0) return
    await convert({ transactionId, subject, at, stage: body.event })
  }

  /**
   * A number of their own for a visitor an arrival is on record for, or nothing: then the page keeps the number it has.
   * A visitor who opted out of advertising is not followed to the phone either.
   */
  async function number(request: IncomingMessage, response: ServerResponse) {
    const body = await json(request)
    if (fromStaff(request, body)) return void (tally.staff += 1)
    const device = deviceOf(request, response, body)
    const subject = `visitor:${device}`
    const at = now()
    if (request.headers['sec-gpc'] === '1' || body.gpc === true || body.consent?.adUserData === false) return undefined
    const since = at - 90 * 86_400_000
    if (!(await graph.followable(subject, since))) return undefined
    // A program inventing visitors would take every number, so one network gets few.
    if (!tapsFrom(addressOf(request), device, at)) return undefined
    const lease = await graph.lease(subject, { numbers: pool, minutes: options.pool!.minutes, at, arrivedSince: since })
    if (lease === null) return undefined
    tally[lease ? 'leased' : 'exhausted'] += 1
    return lease && { number: lease.number, until: lease.until, lasts: lease.until - at }
  }

  /** Records one browser visit. The subject is the visitor; nothing here names an account. */
  async function collect(request: IncomingMessage, response: ServerResponse, body: any) {
    const at = now()
    const device = deviceOf(request, response, body)
    const subject = `visitor:${device}`
    const identifiers: Identifier[] = [identifier('device', device)]
    // With the server's cookie on, the page may hold a different id: storage was cleared and the cookie was not.
    // The page's id is what forms and your backend will quote, so it is kept on the same visitor.
    if (typeof body.device === 'string' && ID.test(body.device) && body.device !== device) identifiers.push(identifier('device', body.device))

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
        // The lookup keeps its own answers for a day, so asking on every visit costs one query a day per address.
        // An address already found to be shared is not asked about again: it has no place worth noting.
        const info = (await options.ipInfo(address.replace(/^::ffff:/, '')).catch((error) => void console.error(error))) ?? undefined
        const place = shared(info) ? undefined : placeOf(info)
        if (place) identifiers.push(identifier('place', place.slice(0, 120)))
        if (shared(info)) {
          await graph.ignore(seen, true, { by: 'address check', reason: 'an address many people share', automatic: true })
          if (ignoredAddresses.size >= 100_000) ignoredAddresses.clear()
          ignoredAddresses.add(seen)
        }
      }
    }
    // A link sent to one person names them; a link from another of your sites names the visitor they were there.
    const also: Observation[] = []
    if (options.linkSecret) {
      const named = readToken(options.linkSecret, 'known', body.known, at)
      if (named) {
        // Every opening is noted. It ties the browser to the person only while that is believable.
        const tie = identifier('link', device)
        const tied = identifier('opened', named)
        // Few browsers: a person has a phone, a laptop, a tablet. Only openings that tied count toward the three.
        const openers = new Set((await graph.holders([tied])).map((edge) => edge.subject))
        const room = openers.has(subject) || openers.size < 3
        // Not someone else's browser: one that already holds another person of the same kind, by anything but a link,
        // belongs to them. Where the other person is there by a link too, both are written and thin each other out,
        // so whoever's link was opened first does not win.
        const kind = named.slice(0, named.indexOf(':') + 1)
        const others = (await graph.cluster(subject))?.members.filter((member) => member !== named && kind && member.startsWith(kind)) ?? []
        const contested = others.length > 0 && (await graph.holders([tie])).some((edge) => edge.subject !== subject && edge.subject !== named)
        if (room && (others.length === 0 || contested)) {
          identifiers.push(tie, tied)
          also.push({ subject: named, identifiers: [tie], at, event: 'link' })
        } else identifiers.push(identifier('opened', `${named} (not tied)`))
      }
      const [from, mark] = readToken(options.linkSecret, 'carry', body.carried, at)?.split('\n') ?? []
      // The token only counts in the browser it was made for, and the tie is filed per site, so one passed around thins to nothing.
      if (from && from !== device && mark === browserMark(request.headers['user-agent'], address)) {
        const tie = identifier('carry', `${from}@${new URL(request.headers.origin!).host}`)
        identifiers.push(tie)
        also.push({ subject: `visitor:${from}`, identifiers: [tie], at, event: 'visit' })
      }
    }
    const visit = { subject, identifiers, at, event: 'visit' }
    await graph.observe(also.length > 0 ? [visit, ...also] : visit)
    if (consent) await graph.consent(subject, consent, { at, source: optedOut ? 'browser signal' : 'banner' })

    if (advertising && body.touch && typeof body.touch === 'object') {
      const touch: Touch = { subject, at }
      for (const field of TOUCH_FIELDS) {
        const value = body.touch[field]
        if (typeof value === 'string' && value && value.length <= 2048) touch[field] = value
      }
      // Parameters of the site's own: a few short ones, so a page cannot fill the table.
      const custom = Object.entries(body.touch.custom && typeof body.touch.custom === 'object' ? body.touch.custom : {})
        .filter(([name, value]) => NAME.test(name) && typeof value === 'string' && value && value.length <= 256)
        .slice(0, 10)
      if (custom.length > 0) touch.custom = Object.fromEntries(custom) as Record<string, string>
      // A visitor walking from one of your sites to another has not arrived from anywhere new.
      // Without this, that walk would be the newest arrival and take the credit from the ad click that began it.
      let ownSite = false
      try {
        ownSite = touch.referrer !== undefined && options.origins.includes(new URL(touch.referrer).origin)
      } catch {}
      if (ownSite) delete touch.referrer
      const arrived = Object.keys(touch).some((field) => !['subject', 'at', 'landing'].includes(field))
      if (arrived) await graph.touch(touch)
    }
  }

  // A number found to come from an internet calling app stops counting as a phone everywhere it was already written,
  // and counts as the weaker kind from here on.
  const mutedPhones = new Set<Identifier>()
  const lineOf =
    options.lineType &&
    (async (number: string) => {
      const line = await options.lineType!(number)
      const plain = `phone:${hashPhone(number)}`
      if (line?.type === 'nonFixedVoip' && !mutedPhones.has(plain)) {
        await graph.ignore(plain, true, { by: 'line check', reason: 'a number from an internet calling app', automatic: true })
        if (mutedPhones.size >= 100_000) mutedPhones.clear()
        mutedPhones.add(plain)
      }
      return line
    })

    /**
   * Records who a subject is from plain facts, so a backend does not have
   * to hash or normalize anything: the device cookie, an email, a phone
   * number, a postal address, the address the request came from.
   */
  async function identify(body: any) {
    if (typeof body?.subject !== 'string' || !body.subject) throw new Refusal(400, 'Body needs a subject')
    const identifiers: Identifier[] = (Array.isArray(body.identifiers) ? body.identifiers : []).map(String)
    const notes: Record<string, string> = {}
    let zip: string | undefined
    if (body.device !== undefined) {
      if (typeof body.device !== 'string' || !ID.test(body.device)) throw new Refusal(400, 'The device id is malformed')
      identifiers.push(identifier('device', body.device))
    }
    if (typeof body.email === 'string' && body.email) identifiers.push(email(body.email))
    if (typeof body.ip === 'string' && body.ip) identifiers.push(ip(body.ip))
    if (typeof body.phone === 'string' && body.phone) {
      const number = normalizePhone(body.phone, options.calls?.country)
      // A lookup that is down must not lose the sighting: the number is kept as a plain phone.
      const line = lineOf ? ((await lineOf(number).catch((error) => void console.error(error))) ?? undefined) : undefined
      const found = phoneOfType(number, line?.type)
      if (found) identifiers.push(found)
      if (line) notes.phone = found ? line.type : `${line.type}: not used`
    }
    if (body.address && typeof body.address === 'object') {
      if (typeof body.address.street !== 'string' || !body.address.street.trim()) throw new Refusal(400, 'An address needs a street')
      if (!options.address) notes.address = 'not checked: no address service is set up'
      else {
        // Whatever goes wrong with the check, the rest of the sighting is still recorded.
        let checked: Awaited<ReturnType<AddressVerifier>>
        let failed = false
        try {
          checked = await options.address(body.address)
        } catch (error) {
          console.error(error)
          failed = true
        }
        const found = checked && addressIdentifier(checked)
        if (found) identifiers.push(found)
        // The postal service's code for a delivery point begins with its zip code.
        if (found && /^\d{12}$/.test(checked!.barcode)) zip = checked!.barcode.slice(0, 5)
        notes.address = failed ? 'not checked: the address service did not answer' : !checked ? 'not found' : found ? 'confirmed' : checked.mailDrop ? 'a rented mail box: not used' : checked.vacant ? 'vacant: not used' : 'not confirmed to the apartment: not used'
      }
    }
    if (body.name !== undefined || body.dob !== undefined) {
      const { first, last } = body.name ?? {}
      if (typeof first !== 'string' || typeof last !== 'string' || first.length > 200 || last.length > 200) throw new Refusal(400, 'A name needs its first and last as text')
      if (body.dob !== undefined && typeof body.dob !== 'string') throw new Refusal(400, 'A date of birth is written YYYY-MM-DD')
      if (!options.identifierSecret) notes.name = 'not used: IDENTIFIER_SECRET is not set'
      else if (!(await graph.policy()).rules.kinds.name) notes.name = 'not used: the policy has no "name" kind'
      else {
        // The zip code is the one the postal service confirmed, or there is none.
        const keys = nameKeys(options.identifierSecret, first, last, { zip5: zip, dob: body.dob })
        identifiers.push(...keys)
        notes.name = keys.length > 0 ? 'used' : 'not used: a placeholder, or neither a confirmed address nor a date of birth'
      }
    }
    if (body.at !== undefined && !Number.isSafeInteger(body.at)) throw new Refusal(400, '`at` must be a time in whole epoch milliseconds')
    if (identifiers.length === 0) throw new Refusal(400, 'Nothing here identifies the subject')
    const at = body.at ?? now()
    const changes = await graph.observe({ subject: body.subject, identifiers, at, ...(typeof body.event === 'string' && body.event && { event: body.event }) })
    return { changes, identifiers, notes }
  }

    /** Names the policy this server runs, the flagging size included, so a screen left open over a restart reads it again. */
  const runningPolicy = async () => {
    const { hash, rules } = await graph.policy()
    return `${hash.slice(0, 12)}-${rules.review}`
  }
  let running: string | undefined

  /** Which policy runs, which one the stored clusters were built with, and whether a rebuild is due. */
  const brief = ({ hash, builtWith, due }: PolicyState) => ({ hash, builtWith: builtWith ?? null, due })

  /**
   * Who a text may mean: an email address or a phone number, hashed here and looked up whole, or how a subject's id begins.
   * Neither is kept, and neither is ever part of an address, which servers and browsers write down.
   */
  async function find(given: unknown): Promise<{ by: 'email' | 'phone' | 'subject'; subjects: Subject[] }> {
    if (typeof given !== 'string' || !given.trim() || given.length > 512) throw new Refusal(400, 'Body needs the text to find, at most 512 characters')
    const text = given.trim()
    const holding = async (identifiers: Identifier[]) => [...new Set((await graph.holders(identifiers)).map((edge) => edge.subject))].sort().slice(0, 20)
    if (/^[^\s:@]+@[^\s:@]+$/.test(text)) return { by: 'email', subjects: await holding([email(text)]) }
    if (/^\+?[\d\s().-]+$/.test(text)) {
      let hash: string | undefined
      try {
        hash = hashPhone(text, options.calls?.country)
      } catch {}
      if (hash) return { by: 'phone', subjects: await holding([`phone:${hash}`, `voip:${hash}`]) }
    }
    return { by: 'subject', subjects: await graph.search(text) }
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
    const separated = await graph.separations(subject)
    // What was decided about this subject and each one it is tied to or kept from, and which of the others shown are kept apart.
    const shown = [...new Set([...separated, ...links.map((link) => link.subject), ...placed])].filter((other) => other !== subject).slice(0, 24)
    const among: [Subject, Subject][] = []
    for (const other of shown) for (const from of await graph.separations(other)) if (other < from && shown.includes(from)) among.push([other, from])
    return {
      subject,
      known: true,
      cluster,
      links,
      ties: [...ties.values()],
      separated,
      verdicts: await graph.verdicts([...[...new Set([...separated, ...links.map((link) => link.subject)])].map((other): [Subject, Subject] => [subject, other]), ...among]),
      apart: among,
      flows: await graph.flows(subject),
      rings: await graph.rings(subject),
      consent: await graph.consentHistory(subject, 50),
      history: (await graph.history(subject, 100)).reverse(),
    }
  }

  /** The days a request asks about: the last thirty unless it says, in the time zone it names or the server's own. */
  const period = (url: URL) => {
    const timeZone = url.searchParams.get('tz') || options.timeZone || 'UTC'
    const to = url.searchParams.get('to') || dayIn(now(), timeZone)
    const from = url.searchParams.get('from') || new Date(dayStart(to) - 29 * 86_400_000).toISOString().slice(0, 10)
    return { from, to, timeZone }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = `${request.method} ${url.pathname}`
    const origin = request.headers.origin

    if (url.pathname === '/collect' || url.pathname === '/event' || (url.pathname === '/carry' && options.linkSecret) || (url.pathname === '/number' && pool.length > 0)) {
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
      if (url.pathname === '/carry') {
        // The page reads this answer, and may send the server's own cookie with the request.
        response.setHeader('access-control-allow-credentials', 'true')
        const device = deviceOf(request, response, await json(request))
        const made = `${device}\n${browserMark(request.headers['user-agent'], addressOf(request))}`
        return { token: signToken(options.linkSecret!, 'carry', made, now() + 3_600_000) }
      }
      if (BOT.test(String(request.headers['user-agent'] ?? ''))) {
        tally.bots += 1
        return undefined
      }
      if (url.pathname === '/number') {
        // The page reads this answer, and may send the server's own cookie with the request.
        response.setHeader('access-control-allow-credentials', 'true')
        return number(request, response)
      }
      if (url.pathname === '/event') await happened(request, response)
      else {
        const body = await json(request)
        if (fromStaff(request, body)) tally.staff += 1
        else {
          await collect(request, response, body)
          tally.collected += 1
        }
      }
      return undefined
    }

    if (path === 'POST /calls/twilio' && options.calls?.twilio) {
      // Twilio cannot hold a token, so the request proves itself with a signature made from the account's secret.
      const fields = Object.fromEntries(new URLSearchParams(await text(request)))
      const { authToken, url: address } = options.calls.twilio
      if (!fromTwilio(authToken, address, fields, String(request.headers['x-twilio-signature'] ?? ''))) throw new Refusal(403, 'The signature does not match')
      storable(fields)
      const call = twilioCall(fields, now())
      if (call) await recordCall(graph, call, calling())
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
    storable([...url.searchParams.values()])
    const subject = url.searchParams.get('subject') ?? ''
    switch (path) {
      case 'POST /observe':
        return graph.observe(await json(request))
      case 'POST /identify':
        return identify(await json(request))
            case 'POST /touch':
        return graph.touch(await json(request))
      case 'POST /ignore': {
        const body = await json(request)
        return graph.ignore(body.identifier, body.ignored ?? true, signed(request, body))
      }
      case 'POST /forget': {
        const body = await json(request)
        return graph.forget(body.subject, signed(request, body))
      }
      case 'POST /consent': {
        const body = await json(request)
        return graph.consent(body.subject, body.consent, { ...(body.at !== undefined && { at: body.at }), ...(body.source !== undefined && { source: body.source }) })
      }
      case 'POST /join': {
        const body = await json(request)
        if (body.pairs !== undefined) return graph.joinAll(...listed(request, body, false))
        if (body.mark !== true) return graph.join(body.a, body.b, signed(request, body))
        let mark: Identifier | undefined
        const moved = await graph.join(body.a, body.b, signed(request, body), (left) => (mark = left))
        return { moved, mark }
      }
      case 'GET /me':
        return { reviewer: reviewerOf(request) ?? null }
      case 'GET /subject':
        return profile(subject)
      case 'GET /ops':
        if (!options.ops) break
        return { ...(await options.ops.state()), pool: pool.length > 0 ? { numbers: pool.length, held: await graph.leasesAt(pool, now()), since: tally.since, leased: tally.leased, exhausted: tally.exhausted, minutes: options.pool!.minutes } : null, outbox: options.outbox ? await options.outbox.counts() : null }
      case 'POST /alerts/test':
        if (!options.ops) break
        return options.ops.test()
      case 'GET /pulse': {
        // One small row: a screen asks this often, and reads the rest only when the answer differs.
        const version = await graph.version()
        const tag = `"${version}-${(running ??= await runningPolicy())}"`
        response.setHeader('etag', tag)
        if (request.headers['if-none-match'] === tag) {
          response.writeHead(304, { 'cache-control': 'no-store' }).end()
          return SENT
        }
        return { version }
      }
      case 'GET /clusters':
        return graph.clusters(50, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))))
      case 'GET /search':
        return graph.search(url.searchParams.get('q') ?? '')
      case 'POST /find':
        return find((await json(request)).text)
      case 'GET /recent':
        return graph.recent()
      case 'POST /separate': {
        const body = await json(request)
        if (body.pairs !== undefined) return graph.separateAll(...listed(request, body, true))
        return graph.separate(body.a, body.b, body.separated ?? true, signed(request, body))
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
      case 'GET /journey': {
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
        if (before !== undefined && !Number.isSafeInteger(before)) throw new Refusal(400, '`before` must be the `next` of a later page')
        const journey = await graph.journey(subject, before === undefined ? {} : { before })
        // What became of each step at the ad platforms. A job keeps how it stands, and not when it got there.
        const jobs = new Map<string, { target: string; state: JobState; note?: string; value?: number }[]>()
        if (options.outbox) {
          for (const entry of journey.entries) {
            if (entry.kind !== 'step') continue
            const { transactionId } = entry.outcome
            jobs.set(transactionId, (await options.outbox.get(transactionId)).map(({ target, state, note, value }) => ({ target, state, ...(note && { note }), ...(value !== undefined && { value }) })))
          }
        }
        return {
          ...journey,
          entries: journey.entries.map((entry) => {
            if (entry.kind === 'arrival') return { ...entry, source: sourceOf(entry.touch) }
            if (entry.kind === 'step') return { ...entry, sent: jobs.get(entry.outcome.transactionId) ?? [] }
            if (entry.kind !== 'call') return entry
            const { to: _, ...call } = entry.call
            return { ...entry, call, state: callState(entry.call, now(), options.calls) }
          }),
        }
      }
      case 'GET /history':
        return graph.history(subject)
      case 'GET /attribute': {
        const at = Number(url.searchParams.get('at') ?? now())
        if (!Number.isSafeInteger(at)) throw new Refusal(400, '`at` must be a time in whole epoch milliseconds')
        return graph.attribute(subject, { at })
      }
      case 'GET /policy': {
        const { builtWith, ...state } = await graph.policy()
        const standard = plainPolicy(defaultPolicy)
        return { ...state, builtWith: builtWith ?? null, changed: Object.keys(state.rules.kinds).filter((kind) => JSON.stringify(state.rules.kinds[kind]) !== JSON.stringify(standard.kinds[kind])) }
      }
      case 'POST /rebuild': {
        // Nothing in the body is needed, so none has to be sent.
        const sent = await text(request)
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
      case 'GET /decisions': {
        const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 50)))
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
        if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) throw new Refusal(400, '`before` must be a decision\'s number')
        const author = url.searchParams.get('author') || undefined
        // One more than asked for says whether there is another page.
        const found = await graph.decisionPage({ limit: limit + 1, ...(before !== undefined && { before }), ...(author !== undefined && { author }) })
        const decisions = found.slice(0, limit)
        return { decisions, next: found.length > limit ? decisions.at(-1)!.seq : null, total: (await graph.decisionPage({ limit: 1 }))[0]?.seq ?? 0 }
      }
      case 'GET /consent':
        return graph.consentHistory(subject)
      case 'GET /disputes':
        return graph.disputes()
      case 'GET /audit':
        return graph.audit()
      case 'POST /convert':
        return convert(await json(request))
      case 'POST /link': {
        if (!options.linkSecret) break
        const body = await json(request)
        if (body.days !== undefined && typeof body.days !== 'number') throw new Refusal(400, '`days` must be a number')
        return { url: knownLink(String(body.url), body.subject, { secret: options.linkSecret, now, ...(body.days !== undefined && { lasts: body.days * 86_400_000 }) }) }
      }
      case 'POST /staff-link': {
        if (!options.linkSecret) break
        const body = await json(request)
        if (body.days !== undefined && typeof body.days !== 'number') throw new Refusal(400, '`days` must be a number')
        return { url: staffLink(String(body.url), { secret: options.linkSecret, now, ...(body.days !== undefined && { lasts: body.days * 86_400_000 }) }) }
      }
      case 'POST /call':
        return recordCall(graph, await json(request), calling())
      case 'GET /calls': {
        const days = period(url)
        const after = url.searchParams.get('after') ?? ''
        const cut = after.indexOf(' ')
        if (after && !(cut > 0 && Number.isSafeInteger(Number(after.slice(0, cut))))) throw new Refusal(400, '`after` must be the `next` of an earlier page')
        const limit = 50
        const open = await graph.openCalls({ ...days, limit: limit + 1, ...(after && { after: { at: Number(after.slice(0, cut)), id: after.slice(cut + 1) } }) })
        const page = open.slice(0, limit)
        const last = page.at(-1)
        return {
          ...days,
          at: now(),
          // Your own number is of no use here, and nobody else's is kept.
          calls: page.map(({ call: { to: ours, ...call }, followUp, touch }) => ({ ...call, state: callState({ ...call, to: ours }, now(), options.calls), attempts: followUp.attempts, ...(touch && { source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null }) })),
          next: open.length > limit && last ? `${last.call.at} ${last.call.id}` : null,
        }
      }
      case 'GET /calls/summary': {
        const days = period(url)
        return { ...days, expected: options.calls?.results === 'expected', ...(await graph.callSummary({ ...days, at: now(), ...(options.calls?.results && { results: options.calls.results }), ...(options.calls?.resultWait !== undefined && { resultWait: options.calls.resultWait }) })) }
      }
      case 'GET /outcome': {
        const id = url.searchParams.get('id') ?? ''
        const outcome = await graph.outcomeOf(id)
        return outcome ? { ...outcome, values: await graph.values(id) } : null
      }
      case 'GET /between':
        return graph.between(url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? '')
      case 'GET /undecided': {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Refusal(400, '`limit` must be a whole number from 1 to 500')
        return graph.undecided({ limit })
      }
      case 'GET /board': {
        const steps = Object.entries(options.stages ?? {}).map(([name, { wait }]) => ({ name, ...(wait && { wait }) }))
        const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 90
        const { columns, ...board } = await graph.board({ steps, days, at: now(), ...(options.timeZone && { timeZone: options.timeZone }), ...(options.returnHours && { returnHours: options.returnHours }) })
        return {
          ...board, days, timeZone: options.timeZone ?? 'UTC',
          columns: columns.map((column) => ({
            ...column,
            rows: column.rows.map(({ outcome, call, touch, language, ...row }) => ({
              ...row,
              value: outcome?.value ?? null,
              currency: outcome?.currency ?? null,
              language: language ?? null,
              call: call ? { state: callState(call, now(), options.calls), direction: call.direction } : null,
              ...(touch && { source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null }),
            })),
          })),
        }
      }
      case 'GET /followed': {
        const days = period(url)
        const within = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30
        return { ...days, ...(await graph.followed({ ...days, at: now(), step: url.searchParams.get('step') ?? '', days: within })) }
      }
      case 'GET /call': {
        const call = await graph.keptCall(url.searchParams.get('id') ?? '')
        if (!call) return null
        const missed = call.direction === 'inbound' && call.result?.answered === false
        return { ...call, state: callState(call, now(), options.calls), ...(missed && { followUp: followUp(call, await graph.callsOf([call.subject])) }) }
      }
      case 'POST /call/result':
        return (await recordCallResult(graph, await json(request), calling())) ?? { state: 'waiting', counted: false }
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
        const days = period(url)
        const { timeZone } = days
        const by = url.searchParams.get('by') || undefined
        const per = url.searchParams.get('per') || undefined
        const report = await graph.report({ ...days, ...(by && { by }), ...(per && { per }) })
        // The steps in your order first, then any others that turned up, by name.
        const named = Object.keys(options.stages ?? {})
        const others = Object.keys(report.total.stages).filter((step) => !named.includes(step)).sort()
        return { ...report, timeZone, steps: [...named, ...others] }
      }
      case 'GET /conversions': {
        if (!options.outbox) break
        const state = url.searchParams.get('state') ?? 'failed'
        if (!['held', 'pending', 'sent', 'skipped', 'failed'].includes(state)) throw new Refusal(400, 'state must be held, pending, sent, skipped, or failed')
        return options.outbox.list(state as JobState)
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
      response.writeHead(200, JSON_HEADERS).end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof Outdated) {
        const { seq, at, action, about, by, reason } = error.decision
        return void response.writeHead(409, JSON_HEADERS).end(JSON.stringify({ error: error.message, decision: { seq, at, action, about, by, reason } }))
      }
      const refused = error instanceof Refusal || error instanceof TypeError || error instanceof SyntaxError
      const status = error instanceof Refusal ? error.status : refused ? 400 : 500
      const message = refused ? (error as Error).message : 'Internal error'
      if (!refused) {
        tally.errors += 1
        console.error(error)
      }
      response.writeHead(status, JSON_HEADERS).end(JSON.stringify({ error: message }))
    }
  }
}

/** A list of addresses and ranges, to ask whether an address is in it. Throws for one that is neither. */
export function networks(list: readonly string[]): BlockList {
  const found = new BlockList()
  for (const each of list) {
    const [address = '', prefix, ...rest] = each.trim().split('/')
    const family = isIP(address)
    const bits = prefix === undefined ? (family === 6 ? 128 : 32) : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN
    if (family === 0 || rest.length > 0 || !(bits >= 0 && bits <= (family === 6 ? 128 : 32))) throw new TypeError(`"${each}" is not an address or a range, such as 198.51.100.0/24`)
    found.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4')
  }
  return found
}

/** What is wrong with a list of reviewers, one line each. `service` is the service token, which none of them may hold. */
export function reviewerProblems(reviewers: unknown, service: string): string[] {
  if (reviewers === undefined) return []
  if (!reviewers || typeof reviewers !== 'object' || Array.isArray(reviewers)) return ['reviewers must be an object of names, such as {"dana":"a-long-random-string"}']
  const wrong: string[] = []
  const taken = new Set([service])
  for (const [name, given] of Object.entries(reviewers as Record<string, unknown>)) {
    if (!name.trim() || name !== name.trim() || name.length > 100 || UNSTORABLE.test(name)) wrong.push(`"${name}" is not a name: use 1 to 100 characters with no space around them`)
    // "people" and "system" are what the record is filtered by, and a name that starts with "system:" is a system's.
    if (name.startsWith('system:') || name === 'system' || name === 'people') wrong.push(`"${name}" cannot be a reviewer's name`)
    const tokens: unknown[] = [given].flat()
    if (tokens.length === 0) wrong.push(`"${name}" needs a token`)
    for (const token of tokens) {
      if (typeof token !== 'string' || !token || token !== token.trim()) wrong.push(`"${name}" needs each token as text with no space around it`)
      else if (taken.has(token)) wrong.push(`"${name}" has a token that is already the service's or another reviewer's`)
      else taken.add(token)
    }
  }
  return wrong
}

/** Who is deciding and why, from a request body, for the record of decisions. */
function why(body: any): { by?: string; reason?: string } {
  return {
    ...(typeof body.by === 'string' && body.by && { by: body.by.slice(0, 200) }),
    ...(typeof body.reason === 'string' && body.reason && { reason: body.reason.slice(0, 1000) }),
  }
}

async function json(request: IncomingMessage): Promise<any> {
  return parsed(await text(request))
}

function parsed(sent: string): any {
  const body = JSON.parse(sent)
  storable(body)
  return body
}

/** How many levels a body may have. The deepest a route takes has four. */
const LEVELS = 32

/** Refuses a value that holds text the database cannot keep, or that is nested so deep that reading it as text would fail. */
function storable(value: unknown): void {
  // A list and not recursion: a body can be nested deeper than the stack.
  const left: [unknown, number][] = [[value, 0]]
  while (left.length > 0) {
    const [each, level] = left.pop()!
    if (typeof each === 'string' && UNSTORABLE.test(each)) throw new Refusal(400, 'Text may not hold a NUL or half of a character')
    if (typeof each !== 'object' || each === null) continue
    if (level >= LEVELS) throw new Refusal(400, `A body may have ${LEVELS} levels at most`)
    for (const [key, inner] of Object.entries(each)) left.push([key, level + 1], [inner, level + 1])
  }
}

async function text(request: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Refusal(413, 'Body is over 1 MB')
    chunks.push(chunk)
  }
  // Bytes that are not UTF-8 are refused: read leniently, different ones would all become the same text.
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
