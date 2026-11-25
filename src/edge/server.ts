import { FAULT_CODES, fault, malformed } from '../contract/fault.ts'
import { CALLS } from '../contract/validate.ts'
import type { CallName } from '../contract/validate.ts'
import { STATUS, asFault, faultBody } from '../client/faults.ts'
import type { Service } from '../core/service.ts'
import type { Call } from '../core/calls.ts'
import type { Text } from '../core/texts.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { callState, dialed, followUp, numberOrSelf } from '../core/calls.ts'
import type { CallOptions } from '../core/calls.ts'
import { Outdated } from '../core/graph.ts'
import type { Graph } from '../core/graph.ts'
import type { Hours } from '../core/hours.ts'
import { identifier, ip, UNSTORABLE } from '../core/identifiers.ts'
import { trusted } from '../providers/fingerprint.ts'
import type { FingerprintVerifier } from '../providers/fingerprint.ts'
import { placeOf, shared } from '../providers/maxmind.ts'
import { fromTwilio, twilioCall, twilioText } from '../providers/twilio.ts'
import { asks, codeNote, textCode, texted } from '../core/texts.ts'
import type { TextOptions } from '../core/texts.ts'
import type { IpLookup } from '../providers/maxmind.ts'
import type { Ops } from '../core/ops.ts'
import type { Job, JobState, Outbox } from '../core/outbox.ts'
import { dayIn, dayStart, sourceOf } from '../core/report.ts'
import type { Ladder } from '../core/ladder.ts'
import { defaultPolicy, plainPolicy, REBUILD_NOTICE } from '../core/policy.ts'
import { reviewPage } from './review.ts'
import { browserMark, readToken, signToken } from '../core/sign.ts'
import { browserScripts, scriptHeaders } from './tag.ts'
import { TOUCH_FIELDS } from '../core/touch.ts'
import type { Change, Deciding, Identifier, Level, Observation, Subject, Touch } from '../contract/types.ts'

/** Each reviewer's name, and the token or tokens that are theirs. */
export type Reviewers = Readonly<Record<string, string | readonly string[]>>

/** What the edge is made on: the graph behind it, and what it is told of calls, texts and deletions. */
export interface Core {
  graph: Graph
  service: Service
  outbox?: Outbox | undefined
  ops?: Ops | undefined
  called(call: Call): Promise<unknown>
  texted(text: Text): Promise<unknown>
  forget(subjects: readonly Subject[], why: Deciding, retract: boolean): Promise<{ changes: Change[]; sent: unknown[] }>
  /** Hears of a decision made here, so answers kept elsewhere are worked out again. */
  decided?(): void
  /** The six calls. Without it, `/v1` is not served. */
  v1?(name: CallName, request: unknown, signal: AbortSignal): Promise<unknown>
}

/** What a page may ask for, and the routes each had before there was one. */
const BROWSER = new Map([['/collect', 'visit'], ['/event', 'event'], ['/carry', 'carry'], ['/number', 'number'], ['/text-code', 'text_code']])
const KINDS = new Set(BROWSER.values())

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
  /**
   * The events a page may report to `/event`, by name: `inquiry`,
   * `phone_click`. Each is counted as an outcome of that name, once a day
   * per browser unless the page gives it an id. A name not listed is refused.
   */
  events?: readonly string[]
  /**
   * How phone calls are read. With `twilio`, the
   * server also takes Twilio's status callbacks at `/calls/twilio`: `url` is
   * that route's public address exactly as entered in Twilio, which the
   * signature is checked against.
   */
  calls?: Pick<CallOptions, 'numbers' | 'country' | 'results' | 'resultWait'> & { twilio?: { authToken: string; url: string } }
  /**
   * How text messages are read. With `codes`, the script tag asks for the code it puts in
   * text links. With `twilio`, the server also takes Twilio's incoming messages at `/texts/twilio`.
   */
  texts?: TextOptions & { codes?: boolean; twilio?: { authToken: string; url: string } }
  /**
   * The secret that signs links. With it, a `link` entry makes an address that
   * names the person it is sent to, a visit that arrives through one ties
   * the browser to that person, and `/carry` lets the script tag keep a
   * visitor the same visitor across your sites. Long and random.
   */
  linkSecret?: string
  /**
   * Your steps, in order, with what each is worth and what it counts as on
   * each ad platform. An outcome that names a step takes from it whatever
   * the outcome leaves out, so a page event or a call needs only its name.
   * A report lists the steps in this order.
   */
  stages?: Ladder
  /**
   * Numbers shown to one visitor at a time, and for how many minutes after
   * they last asked. `grace` is how many minutes after that a call still counts
   * as theirs when nobody has had the number since. Off by default.
   */
  pool?: { numbers: readonly string[]; minutes: number; grace: number }
  /** How many hours a missed call may wait before the board says it has waited too long. Left out or 0, it never does. */
  returnHours?: number
    /** When you are open. With it, the board counts waiting, and the call summary calls that came while you were closed. */
  hours?: Hours
  /** The time zone the screen's reports read their days in when none is named. Use the ad account's. Defaults to UTC. */
  timeZone?: string
  /** The clock, for tests. */
  now?: () => number
}

const ID = /^[\w.-]{1,128}$/
const NAME = /^[\w.-]{1,64}$/

/** What takes long to work out, and changes little in a few seconds. */
const SLOW_ROUTES = new Set(['GET /board', 'GET /report', 'GET /followed', 'GET /calls/summary'])

/** What changes who is who, or takes someone out, and is seen in every answer from then on. */
const DECISIONS = new Set(['POST /forget', 'POST /separate', 'POST /join', 'POST /ignore'])

/** Answers hold people's data, so nothing keeps a copy of one. */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/** A job as an answer shows it: the hashed email and phone are for its platform only. */
const shownJob = ({ keys, metaUserAgent, ...job }: Job) => {
  if (job.note !== 'call_party') return job
  // The click and consent used for the original send belonged to the line.
  const { click, confidence, consent, ...delivery } = job
  return delivery
}

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
export function createHandler(core: Core, options: HandlerOptions) {
  const { graph, service } = core
  const now = options.now ?? Date.now
  const token = Buffer.from(options.token)

  const [problem] = reviewerProblems(options.reviewers, options.token)
  if (problem) throw malformed(problem)
  const reviewers = Object.entries(options.reviewers ?? {}).flatMap(([name, tokens]) => [tokens].flat().map((each) => ({ name, token: Buffer.from(each) })))
  const matches = (sent: Buffer, expected: Buffer) => sent.length === expected.length && timingSafeEqual(sent, expected)

  const sentToken = (request: IncomingMessage) => Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '')
  /** The reviewer a request's token belongs to. Every token is compared, so how long it takes says nothing of which. */
  const reviewerOf = (request: IncomingMessage): string | undefined => {
    const sent = sentToken(request)
    return reviewers.filter((each) => matches(sent, each.token))[0]?.name
  }

  const isService = (request: IncomingMessage) => matches(sentToken(request), token)
  /** Refuses the request unless it carries the service token or a reviewer's. */
  const authorize = (request: IncomingMessage) => {
    if (!isService(request) && reviewerOf(request) === undefined) throw new Refusal(401, 'Missing or invalid token')
  }

  /** Who one decision is by, why, and what they had seen. A reviewer's name is the one their token belongs to, whatever the body says. */
  const signed = (request: IncomingMessage, body: any): Deciding => {
    const name = reviewerOf(request)
    if (name !== undefined && body.by !== undefined && body.by !== name) throw new Refusal(400, '`by` must match the owner of the token')
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

  const { pool, convert, find } = service

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
    if (!device) throw new Refusal(400, 'Body requires a device id')
    return device
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
  async function happened(request: IncomingMessage, response: ServerResponse, body: any) {
    if (typeof body.event !== 'string' || !events.has(body.event)) throw new Refusal(400, 'Event is not listed in EVENTS')
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
    if (body.event === 'text_click' && typeof body.number === 'string' && body.number.length <= 40) {
      try {
        const note = texted(body.number, at, options.calls?.country)
        const to = note.slice('dialed:text-'.length, note.lastIndexOf('@'))
        if ((!trackingNumbers || trackingNumbers.has(to)) && tapsFrom(addressOf(request), device, at)) identifiers.push(note)
      } catch {}
    }
    await graph.observe({ subject, identifiers, at, event: body.event })
    // A page may number its own occurrences, but not of a step that is worth something or is sent to an ad platform:
    // those count once a day per browser whatever the page says, because a page can be made to say anything.
    const step = options.stages && Object.hasOwn(options.stages, body.event) ? options.stages[body.event] : undefined
    const weighty = Boolean(step?.value || step?.action)
    const occurrence = !weighty && typeof body.id === 'string' && ID.test(body.id) ? body.id : new Date(at).toISOString().slice(0, 10)
    // Filed where no backend's own id can be, so a page cannot take one before the backend uses it.
    const transactionId = `page:${body.event}:${device}:${occurrence}`
    // The same occurrence reported again is already on its way; recording it twice with a new time would be refused.
    if (core.outbox && (await core.outbox.get(transactionId)).length > 0) return
    const userAgent = request.headers['user-agent']
    const allowed = request.headers['sec-gpc'] !== '1' && body.gpc !== true && body.consent?.adUserData !== false
    await convert({ transactionId, subject, at, stage: body.event, ...(allowed && userAgent && { userAgent }) })
  }

  /**
   * A number of their own for a visitor an arrival is on record for, or nothing: then the page keeps the number it has.
   * A visitor who opted out of advertising is not followed to the phone either.
   */
  async function number(request: IncomingMessage, response: ServerResponse, body: any) {
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

  /** The code this visitor's text links carry: the one they were given in the last week, or a new one. */
  async function textCodeFor(request: IncomingMessage, response: ServerResponse, body: any) {
    if (fromStaff(request, body)) return void (tally.staff += 1)
    const device = deviceOf(request, response, body)
    const subject = `visitor:${device}`
    const at = now()
    if (request.headers['sec-gpc'] === '1' || body.gpc === true || body.consent?.adUserData === false) return undefined
    if ((await graph.consentOf([subject])).get(subject)?.adUserData === false) return undefined
    const given = (await graph.history(subject, 200)).filter((each) => each.identifier.startsWith('dialed:code-') && each.at > at - 7 * 86_400_000).at(-1)
    if (given) return { code: given.identifier.slice('dialed:code-'.length) }
    let code = textCode()
    while ((await graph.holders([codeNote(code)])).length > 0) code = textCode()
    await graph.observe({ subject, identifiers: [identifier('device', device), codeNote(code)], at, event: 'text_code' })
    return { code }
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
      const token = body.link ?? body.known
      // A link that is kept names its person while it is: one whose person was forgotten is nobody's.
      const [id, ...rest] = readToken(options.linkSecret, 'sent', token, at)?.split('\n') ?? []
      const opened = id !== undefined && (await graph.linkOpened(id, rest.join('\n'), at))
      const named = opened ? rest.join('\n') : readToken(options.linkSecret, 'known', token, at)
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
        const members = (await graph.cluster(subject))?.members ?? []
        const others = members.filter((member) => member !== named && kind && member.startsWith(kind))
        const contested = others.length > 0 && (await graph.holders([tie])).some((edge) => edge.subject !== subject && edge.subject !== named)
        // Nor one of whoever speaks for them: a mother who opens her son's link is not her son.
        if (room && (others.length === 0 || contested) && !(await graph.spokenForBy(named, new Set([subject, ...members])))) {
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
        if (typeof value === 'string' && value && Buffer.byteLength(value) <= 2048) touch[field] = value
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
      // Somebody who said no before stays at no until they say otherwise, so Meta's id for their browser is not kept.
      if (touch.fbp && (await graph.consentOf([subject])).get(subject)?.adUserData === false) delete touch.fbp
      const arrived = Object.keys(touch).some((field) => !['subject', 'at', 'landing', 'fbp'].includes(field))
      if (arrived) await graph.touch(touch)
    }
  }

    /** Names the policy this server runs, the flagging size included, so a screen left open over a restart reads it again. */
  const runningPolicy = async () => {
    const { hash, rules } = await graph.policy()
    return `${hash.slice(0, 12)}-${rules.review}`
  }
  let running: string | undefined

  /** Everything the reviewer screen shows about one subject, in one answer. */
  /** Dates of records only. A call that staff moved away from everybody is in no journey, and its time is not told here either. */
  const datesOf = (subjects: readonly Subject[]) => graph.subjectDates(subjects.filter((each) => !/^(visitor|caller|call):/.test(each)))
  async function profile(subject: Subject) {
    const cluster = await graph.cluster(subject, true)
    if (!cluster) {
      const dates = (await datesOf([subject])).get(subject)
      return { subject, known: false, ...(dates && { dates: { [subject]: dates } }) }
    }
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
    const others = [...new Set([...separated, ...links.map(link => link.subject)])]
    // What was decided about this subject and each one it is tied to or kept from, and which of the others shown are kept apart.
    const shown = [...new Set([...others, ...placed])].filter((other) => other !== subject).slice(0, 24)
    const among: [Subject, Subject][] = []
    for (const other of shown) for (const from of await graph.separations(other)) if (other < from && shown.includes(from)) among.push([other, from])
    const subjects = [subject, ...others]
    const dates = await datesOf(subjects)
    return {
      subject,
      known: true,
      dates: Object.fromEntries(subjects.map(id => [id, dates.get(id) ?? {}])),
      cluster,
      links,
      edges: [...ties.values()],
      separated,
      verdicts: await graph.verdicts([...others.map((other): [Subject, Subject] => [subject, other]), ...among]),
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

  /** Where a page of a list begins, from the `next` of the page before. */
  const afterOf = (url: URL) => {
    const after = url.searchParams.get('after') ?? ''
    const cut = after.indexOf(' ')
    if (after && !(cut > 0 && Number.isSafeInteger(Number(after.slice(0, cut))))) throw new Refusal(400, '`after` must be a `next` value from a page')
    return after ? { at: Number(after.slice(0, cut)), id: after.slice(cut + 1) } : undefined
  }

  // What takes long to work out is worked out once for everybody who asks at the same time, and is good until something is
  // written. While things are being written all the time, it is good for a few times as long as it took, so a screen left
  // open costs a small share of the server however many are.
  const answers = new Map<string, { party: string | undefined; version: number; at: number; until: number; made: boolean; answer: Promise<unknown> }>()
  // Goes up with each decision and deletion: an answer that was being worked out meanwhile is worked out again.
  let decided = 0
  // While one is under way nothing is shared: it can be done already, and waiting for what follows it.
  let deciding = 0
  const remembered = async (url: URL, response: ServerResponse, work: () => Promise<unknown>): Promise<unknown> => {
    const key = url.pathname + url.search
    for (;;) {
      const since = decided
      const party = await graph.partyRevision()
      if (deciding > 0) {
        const answer = await work()
        if (party !== await graph.partyRevision() || decided !== since) continue
        return answer
      }
      const version = await graph.version()
      let known = answers.get(key)
      if (known?.party !== party) known = undefined
      // Who has waited too long changes with the clock, so nothing is good for more than a minute.
      if (known?.made && !(now() - known.at < 60_000 && (known.version === version || now() < known.until))) known = undefined
      if (!known) {
        const at = now()
        const next = (known = { party, version, at, until: Infinity, made: false, answer: work() })
        for (const [old, { made }] of answers) if (answers.size >= 200 && made) answers.delete(old)
        answers.set(key, next)
        next.answer.then(
          () => Object.assign(next, { made: true, until: now() + 4 * (now() - at) }),
          () => answers.get(key) === next && answers.delete(key),
        )
      }
      const waited = !known.made
      const answer = await known.answer
      const newest = waited ? await graph.version() : version
      // Nothing is awaited between this and the answer being given.
      if (party !== await graph.partyRevision() || decided !== since || deciding > 0) continue
      // Made before the newest write: the screen that gets it asks again.
      if (known.version !== newest) response.setHeader('age', String(Math.max(1, Math.ceil((now() - known.at) / 1000))))
      return answer
    }
  }

  const available = (kind: string): boolean => (kind === 'carry' ? Boolean(options.linkSecret) : kind === 'number' ? pool.length > 0 : kind === 'text_code' ? Boolean(options.texts?.codes) : true)

  /** One of the six calls. The service token opens each; a reviewer's opens the decisions it may sign, and what the screen reads. */
  async function six(request: IncomingMessage, response: ServerResponse, name: string): Promise<unknown> {
    const answer = (status: number, body: unknown) => {
      response.writeHead(status, { ...JSON_HEADERS, ...(request.headers['x-request-id'] && /^[\x21-\x7e]{1,200}$/.test(String(request.headers['x-request-id'])) && { 'x-request-id': String(request.headers['x-request-id']) }) }).end(JSON.stringify(body))
      return SENT
    }
    const gone = new AbortController()
    response.once('close', () => response.writableFinished || gone.abort())
    try {
      if (!core.v1 || !(CALLS as string[]).includes(name)) throw new Refusal(404, 'No such call')
      if (request.method !== 'POST') throw new Refusal(405, 'Use POST')
      const reviewer = reviewerOf(request)
      if (!isService(request) && reviewer === undefined) throw fault(FAULT_CODES.AUTH.REJECTED, 'Missing or invalid token')
      const given = await text(request)
      let body: any
      try {
        body = JSON.parse(given)
      } catch (error) {
        throw malformed((error as Error).message)
      }
      if (!isService(request)) {
        const party = name === 'record' && Array.isArray(body?.entries) && body.entries.length > 0 && body.entries.every((entry: any) => entry?.type === 'call_update' && entry.change?.kind === 'party' && entry.change.by === reviewer)
        const opens = party || name === 'report' || ((name === 'decide' || name === 'forget') && body?.by === reviewer) || (name === 'lookup' && (body?.kind === 'journey' || body?.kind === 'find' || body?.kind === 'party'))
        if (!opens) throw fault(FAULT_CODES.AUTH.FORBIDDEN, name === 'decide' || name === 'forget' ? '`by` must match the owner of the token' : 'The token does not open this call')
      }
      const said = await core.v1(name as CallName, body, gone.signal)
      // No journey says whom a call was not with, so a reviewer is not told it here.
      if (!isService(request) && name === 'lookup' && body?.kind === 'party' && (said as any)?.role === 'excluded') {
        const { subject: _, ...shown } = said as any
        return answer(200, shown)
      }
      return answer(200, said)
    } catch (error) {
      if (error instanceof Refusal && error.status === 413) return answer(413, faultBody(fault(FAULT_CODES.INPUT.TOO_LARGE, error.message)))
      if (error instanceof Refusal && error.status >= 404) throw error
      const known = asFault(error)
      if (known.code === FAULT_CODES.GRAPH.INTERNAL) {
        tally.errors += 1
        console.error(known.cause ?? error)
      }
      return answer(STATUS[known.code] ?? 500, faultBody(known))
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse, remember = true): Promise<unknown> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let path = `${request.method} ${url.pathname}`
    const origin = request.headers.origin

    const asked = BROWSER.get(url.pathname)
    if (asked && available(asked)) {
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
      const body = await json(request)
      // Each was a route of its own, and a page that keeps an old script still asks there.
      const kind = asked === 'visit' && body.kind !== undefined ? body.kind : asked
      if (typeof kind !== 'string' || !KINDS.has(kind)) throw new Refusal(400, '`kind` must be visit, event, carry, number or text_code')
      if (!available(kind)) throw new Refusal(404, `Nothing is set up for "${kind}"`)
      // The page reads these answers, and may send the server's own cookie with the request.
      if (kind === 'carry' || kind === 'number' || kind === 'text_code') response.setHeader('access-control-allow-credentials', 'true')
      if (kind === 'carry') {
        const device = deviceOf(request, response, body)
        const made = `${device}\n${browserMark(request.headers['user-agent'], addressOf(request))}`
        return { token: signToken(options.linkSecret!, 'carry', made, now() + 3_600_000) }
      }
      if (BOT.test(String(request.headers['user-agent'] ?? ''))) {
        tally.bots += 1
        return undefined
      }
      if (kind === 'number') return number(request, response, body)
      if (kind === 'text_code') return textCodeFor(request, response, body)
      if (kind === 'event') await happened(request, response, body)
      else if (fromStaff(request, body)) tally.staff += 1
      else {
        await collect(request, response, body)
        tally.collected += 1
      }
      return undefined
    }

    if (path === 'POST /calls/twilio' && options.calls?.twilio) {
      // Twilio cannot hold a token, so the request proves itself with a signature made from the account's secret.
      const fields = Object.fromEntries(new URLSearchParams(await text(request)))
      const { authToken, url: address } = options.calls.twilio
      if (!fromTwilio(authToken, address, fields, String(request.headers['x-twilio-signature'] ?? ''))) throw new Refusal(403, 'Invalid signature')
      storable(fields)
      const call = twilioCall(fields, now())
      if (call) await core.called(call)
      return undefined
    }

    if (path === 'POST /texts/twilio' && options.texts?.twilio) {
      const fields = Object.fromEntries(new URLSearchParams(await text(request)))
      const { authToken, url: address } = options.texts.twilio
      if (!fromTwilio(authToken, address, fields, String(request.headers['x-twilio-signature'] ?? ''))) throw new Refusal(403, 'Invalid signature')
      const { Body: _, ...rest } = fields
      storable(rest)
      const message = twilioText(fields, now())
      if (message) await core.texted(message)
      // Twilio sends the sender whatever the answer says, so it says nothing.
      response.writeHead(200, { 'content-type': 'text/xml' }).end('<Response/>')
      return SENT
    }

    if (path === 'GET /health') {
      const { due } = await graph.policy()
      return { ok: true, ...(due && { warning: REBUILD_NOTICE }) }
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

    if (url.pathname.startsWith('/v1/')) return six(request, response, url.pathname.slice('/v1/'.length))

    if (!url.pathname.startsWith('/review/api/')) throw new Refusal(404, 'No such route')
    path = `${request.method} ${url.pathname.slice('/review/api'.length)}`
    authorize(request)
    storable([...url.searchParams.values()])
    const subject = url.searchParams.get('subject') ?? ''
    if (remember && SLOW_ROUTES.has(path)) return remembered(url, response, () => route(request, response, false))
    if (remember && DECISIONS.has(path)) {
      // Whoever decides something is shown what came of it, and what is deleted is in no answer any more.
      deciding += 1
      try {
        return await route(request, response, false)
      } finally {
        deciding -= 1
        decided += 1
        answers.clear()
        core.decided?.()
      }
    }
    switch (path) {
      case 'POST /ignore': {
        const body = await json(request)
        return graph.ignore(body.identifier, body.ignored ?? true, signed(request, body))
      }
      case 'POST /forget': {
        const body = await json(request)
        for (const name of ['ads', 'retract']) if (body[name] !== undefined && typeof body[name] !== 'boolean') throw new Refusal(400, `\`${name}\` must be true or false`)
        // Before anything is deleted: what is sent to nobody must not look asked for.
        if (body.retract && !core.outbox?.retraction.targets.length) throw new Refusal(400, 'No configured ad platform accepts retractions')
        // A person's ids are named one by one, so nobody is deleted for being in a cluster.
        if (body.subjects !== undefined && (body.subject !== undefined || !Array.isArray(body.subjects) || body.subjects.length === 0 || body.subjects.length > 50 || !body.subjects.every((each: unknown) => typeof each === 'string' && each))) throw new Refusal(400, '`subjects` must be a list of 1 to 50 ids, without `subject`')
        if (body.subjects === undefined && typeof body.subject !== 'string') throw new Refusal(400, 'forget requires a subject')
        const whom: Subject | Subject[] = body.subjects ?? body.subject
        const { changes, sent } = await core.forget(typeof whom === 'string' ? [whom] : whom, signed(request, body), body.retract ?? false)
        return body.ads || body.retract ? { changes, sent } : changes
      }
      case 'POST /join': {
        const body = await json(request)
        if (body.mark !== true) return graph.join(body.a, body.b, signed(request, body))
        let mark: Identifier | undefined
        const moved = await graph.join(body.a, body.b, signed(request, body), (left) => (mark = left))
        return { moved, mark }
      }
      case 'GET /me':
        return { reviewer: reviewerOf(request) ?? null, retraction: core.outbox?.retraction ?? { targets: [], always: false } }
      case 'GET /subject':
        return profile(subject)
      case 'GET /ops':
        if (!core.ops) break
        return { ...(await core.ops.state()), visits: tally, pool: pool.length > 0 ? { numbers: pool.length, held: await graph.leasesAt(pool, now()), since: tally.since, leased: tally.leased, exhausted: tally.exhausted, minutes: options.pool!.minutes } : null, outbox: core.outbox ? await core.outbox.counts() : null }
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
      case 'POST /find':
        return find((await json(request)).text)
      case 'POST /foresee':
        return graph.foresee(await json(request))
      case 'GET /recent':
        return graph.recent()
      case 'POST /separate': {
        const body = await json(request)
        return graph.separate(body.a, body.b, body.separated ?? true, signed(request, body))
      }
      case 'GET /journey': {
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
        if (before !== undefined && !Number.isSafeInteger(before)) throw new Refusal(400, '`before` must be a `next` value from a page')
        const journey = await graph.journey(subject, { ...(before !== undefined && { before }), deliveries: Boolean(core.outbox) })
        return {
          ...journey,
          entries: journey.entries.map((entry) => {
            if (entry.kind === 'visit') return { ...entry, source: sourceOf(entry.touch) }
            if (entry.kind === 'outcome') return { ...entry, sent: entry.sent ?? [] }
            if (entry.kind === 'text') {
              const { to: _, ...kept } = entry.text
              return { ...entry, text: kept }
            }
            if (entry.kind !== 'call') return entry
            const { to: _, ...call } = entry.call
            return { ...entry, call, state: callState(entry.call, now(), options.calls) }
          }),
        }
      }
      case 'GET /policy': {
        const { builtWith, ...state } = await graph.policy()
        const standard = plainPolicy(defaultPolicy)
        return { ...state, ...(state.due && { warning: REBUILD_NOTICE }), builtWith: builtWith ?? null, changed: Object.keys(state.rules.kinds).filter((kind) => JSON.stringify(state.rules.kinds[kind]) !== JSON.stringify(standard.kinds[kind])) }
      }
      case 'GET /decisions': {
        const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 50)))
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined
        if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) throw new Refusal(400, '`before` must be a decision number')
        const author = url.searchParams.get('author') || undefined
        // One more than asked for says whether there is another page.
        const found = await graph.decisionPage({ limit: limit + 1, ...(before !== undefined && { before }), ...(author !== undefined && { author }) })
        const decisions = found.slice(0, limit)
        return { decisions, next: found.length > limit ? decisions.at(-1)!.seq : null, total: (await graph.decisionPage({ limit: 1 }))[0]?.seq ?? 0 }
      }
      case 'GET /disputes':
        return graph.disputes()
      case 'GET /audit':
        return graph.audit()
      case 'GET /texts': {
        const days = period(url)
        const after = afterOf(url)
        const open = await graph.openTexts({ ...days, limit: 51, ...(after && { after }) })
        const page = open.slice(0, 50)
        const last = page.at(-1)
        return {
          ...days,
          at: now(),
          texts: page.map(({ text: { to: _, ...kept }, unanswered, touch }) => ({ ...kept, unanswered, ...(touch && { source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null }) })),
          next: open.length > 50 && last ? `${last.text.at} ${last.text.id}` : null,
        }
      }
      case 'GET /calls': {
        const days = period(url)
        const after = afterOf(url)
        const limit = 50
        const open = await graph.openCalls({ ...days, limit: limit + 1, ...(after && { after }) })
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
        return { ...days, expected: options.calls?.results === 'expected', ...(await graph.callSummary({ ...days, at: now(), ...(options.calls?.results && { results: options.calls.results }), ...(options.calls?.resultWait !== undefined && { resultWait: options.calls.resultWait }), ...(options.hours && { hours: options.hours }) })) }
      }
      case 'GET /between':
        return graph.between(url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? '')
      case 'GET /undecided': {
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Refusal(400, '`limit` must be an integer from 1 to 500')
        return graph.undecided({ limit })
      }
      case 'GET /board': {
        const steps = Object.entries(options.stages ?? {}).map(([name, { wait }]) => ({ name, ...(wait && { wait }) }))
        const days = url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 90
        const { columns, ...board } = await graph.board({ steps, days, at: now(), ...(options.timeZone && { timeZone: options.timeZone }), ...(options.returnHours && { returnHours: options.returnHours }), ...(options.hours && { hours: options.hours }) })
        return {
          ...board, days, openHours: options.hours !== undefined, timeZone: options.timeZone ?? 'UTC',
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
        if (!core.outbox) break
        const state = url.searchParams.get('state') ?? 'failed'
        if (!['held', 'pending', 'sent', 'skipped', 'failed'].includes(state)) throw new Refusal(400, 'state must be held, pending, sent, skipped, or failed')
        return (await core.outbox.list(state as JobState)).map(shownJob)
      }
      case 'POST /retry': {
        if (!core.outbox) break
        const { transactionId, target } = await json(request)
        if (typeof transactionId !== 'string' || (target !== undefined && typeof target !== 'string')) throw new Refusal(400, 'transactionId and target must be a string')
        return (await core.outbox.retry(transactionId, target)).map(shownJob)
      }
    }
    throw new Refusal(404, 'No such route')
  }

  return Object.assign(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
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
      if (error instanceof Refusal) return void response.writeHead(error.status, JSON_HEADERS).end(JSON.stringify({ error: error.message }))
      const known = asFault(error)
      if (known.code === FAULT_CODES.GRAPH.INTERNAL) {
        tally.errors += 1
        console.error(known.cause ?? error)
      }
      // What may pass is asked for again by whoever sent it: a provider sends a webhook again for a 503, and not for a 400.
      response.writeHead(STATUS[known.code] ?? 500, { ...JSON_HEADERS, ...(known.retryable && { 'retry-after': '5' }) }).end(JSON.stringify({ error: known.message }))
    }
  }, { tally, /** What was worked out before a decision made elsewhere is worked out again. */ forgetAnswers: () => void ((decided += 1), answers.clear()) })
}

/** A list of addresses and ranges, to ask whether an address is in it. Throws for one that is neither. */
export function networks(list: readonly string[]): BlockList {
  const found = new BlockList()
  for (const each of list) {
    const [address = '', prefix, ...rest] = each.trim().split('/')
    const family = isIP(address)
    const bits = prefix === undefined ? (family === 6 ? 128 : 32) : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN
    if (family === 0 || rest.length > 0 || !(bits >= 0 && bits <= (family === 6 ? 128 : 32))) throw malformed(`"${each}" is not an address or a range, such as 198.51.100.0/24`)
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
    if (tokens.length === 0) wrong.push(`"${name}" requires a token`)
    for (const token of tokens) {
      if (typeof token !== 'string' || !token || token !== token.trim()) wrong.push(`"${name}" requires each token as a string with no space around it`)
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

/** How many levels a body may have. The deepest a route takes has four. */
const LEVELS = 32

/** Refuses a value that holds text the database cannot keep, or that is nested so deep that reading it as text would fail. */
function storable(value: unknown): void {
  // A list and not recursion: a body can be nested deeper than the stack.
  const left: [unknown, number][] = [[value, 0]]
  while (left.length > 0) {
    const [each, level] = left.pop()!
    if (typeof each === 'string' && UNSTORABLE.test(each)) throw new Refusal(400, 'Text contains unsupported characters')
    if (typeof each !== 'object' || each === null) continue
    if (level >= LEVELS) throw new Refusal(400, `Body exceeds ${LEVELS} levels of nesting`)
    for (const [key, inner] of Object.entries(each)) left.push([key, level + 1], [inner, level + 1])
  }
}

async function text(request: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Refusal(413, 'Body exceeds 1 MB')
    chunks.push(chunk)
  }
  // Bytes that are not UTF-8 are refused: read leniently, different ones would all become the same text.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw malformed('Body must be UTF-8')
  }
}
