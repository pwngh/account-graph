import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dialed, numberOrSelf, recordCall } from './calls.ts'
import type { CallOptions } from './calls.ts'
import type { Graph, PolicyState } from './graph.ts'
import { email, hashPhone, identifier, ip, normalizePhone, phoneOfType } from './identifiers.ts'
import { trusted } from './integrations/fingerprint.ts'
import type { FingerprintVerifier } from './integrations/fingerprint.ts'
import { placeOf, shared } from './integrations/maxmind.ts'
import { addressIdentifier } from './integrations/smarty.ts'
import type { AddressVerifier } from './integrations/smarty.ts'
import { fromTwilio, twilioCall } from './integrations/twilio.ts'
import type { LineTypeLookup } from './integrations/twilio.ts'
import type { IpLookup } from './integrations/maxmind.ts'
import type { Outbox } from './outbox.ts'
import { withStage } from './ladder.ts'
import type { Ladder } from './ladder.ts'
import { defaultPolicy, plainPolicy } from './policy.ts'
import { reviewPage } from './review.ts'
import { browserMark, knownLink, readToken, signToken } from './sign.ts'
import { browserScripts, scriptHeaders } from './tag.ts'
import type { Identifier, Level, Observation, Outcome, Subject, Told, Touch, Why } from './types.ts'

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
  'GET /decisions', 'GET /disputes', 'GET /consent', 'GET /audit', 'GET /report', 'GET /pulse', 'GET /policy', 'POST /separate', 'POST /join', 'POST /ignore', 'POST /forget',
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
 * An HTTP handler for `node:http`. `/collect` and `/event` are open to the listed origins,
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

  const reviewing = (request: IncomingMessage) => !matches(Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? ''), token)

  /** A list of pairs from one of your systems, and who it is from. Only a service may speak for a system. */
  const listed = (request: IncomingMessage, body: any, withdrawals: boolean): [Told[], Why] => {
    if (reviewing(request)) throw new Refusal(403, 'The reviewer token does not open the list form of this route')
    if (!Array.isArray(body.pairs) || body.pairs.length > 1000) throw new Refusal(400, '`pairs` must be a list of at most 1000')
    if (typeof body.source !== 'string' || !NAME.test(body.source)) throw new Refusal(400, 'A list needs its `source`: the name of the system it is from')
    for (const each of body.pairs) {
      if (!each || typeof each !== 'object') throw new Refusal(400, 'Each pair must be written { a, b }')
      if (withdrawals && each.separated !== undefined && typeof each.separated !== 'boolean') throw new Refusal(400, '`separated` must be true or false')
    }
    return [body.pairs.map(({ a, b, separated, reason }: any) => ({ a, b, ...(withdrawals && separated !== undefined && { separated }), ...(typeof reason === 'string' && reason && { reason: reason.slice(0, 1000) }) })), why({ ...body, by: `system:${body.source}` })]
  }

  /** A reviewer signs with their own name, never as a system. */
  const signed = (request: IncomingMessage, body: any) => {
    if (reviewing(request) && typeof body.by === 'string' && body.by.startsWith('system:')) throw new Refusal(400, 'A name that starts with "system:" belongs to a service')
  }

  const ignoredAddresses = new Set<Identifier>()

  /** What this process has done since it started, for `/stats`. */
  const tally = { since: now(), collected: 0, limited: 0, bots: 0, errors: 0 }

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
    const device = deviceOf(request, response, body)
    const subject = `visitor:${device}`
    const at = now()
    const identifiers: Identifier[] = [identifier('device', device)]
    // A tapped phone number is noted, so a call that follows can be tied to this visitor.
    if (body.event === 'phone_click' && typeof body.number === 'string' && body.number.length <= 40) {
      try {
        const note = dialed(body.number, at, options.calls?.country)
        // When the tracking numbers are known, a tap on any other number is not worth a note.
        const tracked = !trackingNumbers || trackingNumbers.has(note.slice('dialed:'.length, note.lastIndexOf('@')))
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

  /** Records one browser visit. The subject is the visitor; nothing here names an account. */
  async function collect(request: IncomingMessage, response: ServerResponse) {
    const body = await json(request)
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
          await graph.ignore(seen)
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
        await graph.ignore(plain, true, { by: 'line check', reason: 'a number from an internet calling app' })
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
        notes.address = failed ? 'not checked: the address service did not answer' : !checked ? 'not found' : found ? 'confirmed' : checked.mailDrop ? 'a rented mail box: not used' : checked.vacant ? 'vacant: not used' : 'not confirmed to the apartment: not used'
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

  async function route(request: IncomingMessage, response: ServerResponse): Promise<unknown> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = `${request.method} ${url.pathname}`
    const origin = request.headers.origin

    if (url.pathname === '/collect' || url.pathname === '/event' || (url.pathname === '/carry' && options.linkSecret)) {
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
      if (url.pathname === '/event') await happened(request, response)
      else {
        await collect(request, response)
        tally.collected += 1
      }
      return undefined
    }

    if (path === 'POST /calls/twilio' && options.calls?.twilio) {
      // Twilio cannot hold a token, so the request proves itself with a signature made from the account's secret.
      const fields = Object.fromEntries(new URLSearchParams(await text(request)))
      const { authToken, url: address } = options.calls.twilio
      if (!fromTwilio(authToken, address, fields, String(request.headers['x-twilio-signature'] ?? ''))) throw new Refusal(403, 'The signature does not match')
      const call = twilioCall(fields, now())
      if (call) await recordCall(graph, call, { ...options.calls, convert, ...(lineOf && { lineType: lineOf }) })
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
      case 'POST /identify':
        return identify(await json(request))
            case 'POST /touch':
        return graph.touch(await json(request))
      case 'POST /ignore': {
        const body = await json(request)
        signed(request, body)
        return graph.ignore(body.identifier, body.ignored ?? true, why(body))
      }
      case 'POST /forget': {
        const body = await json(request)
        signed(request, body)
        return graph.forget(body.subject, why(body))
      }
      case 'POST /consent': {
        const body = await json(request)
        return graph.consent(body.subject, body.consent, { ...(body.at !== undefined && { at: body.at }), ...(body.source !== undefined && { source: body.source }) })
      }
      case 'POST /join': {
        const body = await json(request)
        if (body.pairs !== undefined) return graph.joinAll(...listed(request, body, false))
        signed(request, body)
        return graph.join(body.a, body.b, why(body))
      }
      case 'GET /subject':
        return profile(subject)
      case 'GET /pulse': {
        // One small row: a screen asks this often, and reads the rest only when the answer differs.
        const version = await graph.version()
        const tag = `"${version}-${(running ??= await runningPolicy())}"`
        response.setHeader('etag', tag)
        if (request.headers['if-none-match'] === tag) {
          response.writeHead(304).end()
          return SENT
        }
        return { version }
      }
      case 'GET /clusters':
        return graph.clusters(50, Math.max(0, Number(url.searchParams.get('offset')) || 0))
      case 'GET /search':
        return graph.search(url.searchParams.get('q') ?? '')
      case 'GET /recent':
        return graph.recent()
      case 'POST /separate': {
        const body = await json(request)
        if (body.pairs !== undefined) return graph.separateAll(...listed(request, body, true))
        signed(request, body)
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
      case 'GET /policy': {
        const { builtWith, ...state } = await graph.policy()
        const standard = plainPolicy(defaultPolicy)
        return { ...state, builtWith: builtWith ?? null, changed: Object.keys(state.rules.kinds).filter((kind) => JSON.stringify(state.rules.kinds[kind]) !== JSON.stringify(standard.kinds[kind])) }
      }
      case 'POST /rebuild': {
        // Nothing in the body is needed, so none has to be sent.
        const sent = await text(request)
        return graph.rebuild(why(sent.trim() ? JSON.parse(sent) : {}))
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
      case 'POST /call':
        return recordCall(graph, await json(request), { ...options.calls, convert, ...(lineOf && { lineType: lineOf }) })
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
        const timeZone = url.searchParams.get('tz') || options.timeZone || 'UTC'
        const report = await graph.report({ from, to, timeZone })
        // The steps in your order first, then any others that turned up, by name.
        const named = Object.keys(options.stages ?? {})
        const others = Object.keys(report.total.stages).filter((step) => !named.includes(step)).sort()
        return { ...report, timeZone, steps: [...named, ...others] }
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
  return JSON.parse(await text(request))
}

async function text(request: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_000_000) throw new Refusal(413, 'Body is over 1 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
