import { malformed } from '../contract/fault.ts'
import type { Change, Identifier, Outcome, Subject } from '../contract/types.ts'
import type { CallOptions } from './calls.ts'
import type { Graph } from './graph.ts'
import { birthKey, email, hashPhone, identifier, ip, nameKeys, normalizePhone, phoneOfType } from './identifiers.ts'
import { withStage } from './ladder.ts'
import type { Ladder } from './ladder.ts'
import type { Job, Outbox } from './outbox.ts'
import { addressIdentifier } from './ports.ts'
import type { AddressVerifier, LineTypeLookup } from './ports.ts'
import type { TextOptions } from './texts.ts'

const ID = /^[\w.-]{1,128}$/

export interface ServiceOptions {
  outbox?: Outbox
  stages?: Ladder
  calls?: CallOptions
  texts?: TextOptions
  pool?: { numbers: readonly string[]; minutes: number; grace: number }
  identifierSecret?: string
  address?: AddressVerifier
  lineType?: LineTypeLookup
  now: () => number
}

/** What every way in does with what it is given: steps filled in, facts checked and hashed, calls and texts recorded and sent. */
export function createService(graph: Graph, options: ServiceOptions) {
  const { now } = options
  const pool = [...new Set((options.pool?.numbers ?? []).map((number) => normalizePhone(number, options.calls?.country)))]

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
      release: options.calls?.release ?? convert,
      ...(outbox && {
        hold: async (outcome: Outcome) => (sends(outcome) ? outbox.hold(staged(outcome)) : []),
        release: async (outcome: Outcome) => (sends(outcome) ? outbox.release(staged(outcome)) : convert(outcome)),
        withdraw: (transactionId: string) => outbox.withdraw(transactionId),
        takeBack: (transactionId: string) => outbox.takeBack(transactionId),
        giveBack: (transactionId: string) => outbox.giveBack(transactionId),
      }),
      ...(lineOf && { lineType: lineOf }),
    }
  }

  /** How texts are recorded: with the steps' values, on the tracking numbers calls are recorded on. */
  const textOptions = (): TextOptions => {
    const { exclude, clickWindow, country, numbers } = options.calls ?? {}
    return { ...(exclude && { exclude }), ...(clickWindow !== undefined && { clickWindow }), ...(country && { country }), ...(numbers && { numbers }), ...options.texts, convert, ...(options.outbox && { withdraw: (transactionId: string) => options.outbox!.withdraw(transactionId) }), ...(lineOf && { lineType: lineOf }) }
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
    if (typeof body?.subject !== 'string' || !body.subject) throw malformed('Body requires a subject')
    const { identifiers, notes, at } = await factsIn(body, true)
    const changes = await graph.observe({ subject: body.subject, identifiers, at, ...(typeof body.event === 'string' && body.event && { event: body.event }) })
    return { changes, identifiers, notes }
  }

  /** The identifiers in plain facts about somebody, normalized, checked and hashed, and what came of the checks. Only where they are to be saved is the line of a number looked up, because that can mute it. */
  async function factsIn(body: any, saving: boolean) {
    const identifiers: Identifier[] = (Array.isArray(body.identifiers) ? body.identifiers : []).map(String)
    const notes: Record<string, string> = {}
    let zip: string | undefined
    if (body.device !== undefined) {
      if (typeof body.device !== 'string' || !ID.test(body.device)) throw malformed('The device id is malformed')
      identifiers.push(identifier('device', body.device))
    }
    if (typeof body.email === 'string' && body.email) identifiers.push(email(body.email))
    if (typeof body.ip === 'string' && body.ip) identifiers.push(ip(body.ip))
    if (typeof body.phone === 'string' && body.phone) {
      const number = normalizePhone(body.phone, options.calls?.country)
      // A lookup that is down must not lose the sighting: the number is kept as a plain phone.
      const line = lineOf && saving ? ((await lineOf(number).catch((error) => void console.error(error))) ?? undefined) : undefined
      const found = phoneOfType(number, line?.type)
      if (found) identifiers.push(found)
      // Unlooked at, it is whichever of the two kinds it was saved as.
      if (found && !saving) identifiers.push(identifier('voip', hashPhone(number)))
      if (line) notes.phone = found ? line.type : `${line.type}: not used`
    }
    if (body.address && typeof body.address === 'object') {
      if (typeof body.address.street !== 'string' || !body.address.street.trim()) throw malformed('An address requires a street')
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
    if (body.name !== undefined) {
      const { first, last } = body.name ?? {}
      if (typeof first !== 'string' || typeof last !== 'string' || first.length > 200 || last.length > 200) throw malformed('A name requires `first` and `last` as strings')
      if (body.dob !== undefined && typeof body.dob !== 'string') throw malformed('A date of birth is written YYYY-MM-DD')
      if (!options.identifierSecret) notes.name = 'not used: IDENTIFIER_SECRET is not set'
      else if (!(await graph.policy()).rules.kinds.name?.corroborates) notes.name = 'not used: the policy has no "name" kind that only corroborates'
      else {
        // The zip code is the one the postal service confirmed, or there is none.
        const keys = nameKeys(options.identifierSecret, first, last, { zip5: zip, dob: body.dob })
        identifiers.push(...keys)
        notes.name = keys.length > 0 ? 'used' : 'not used: a placeholder, or neither a confirmed address nor a date of birth'
      }
    }
    if (body.at !== undefined && !Number.isSafeInteger(body.at)) throw malformed('`at` must be an integer in epoch milliseconds')
    // Kept only under a policy that keeps people apart by it. It says who somebody is not, and not who they are, so by itself it finds nobody.
    const born = options.identifierSecret && typeof body.dob === 'string' && (await graph.policy()).rules.apart?.includes('birth') ? birthKey(options.identifierSecret, body.dob) : undefined
    if (identifiers.length === 0 && !(saving && born)) throw malformed('At least one identifying field is required')
    if (born) identifiers.push(born)
    return { identifiers, notes, at: (body.at ?? now()) as number }
  }

  /**
   * Who a text may mean: an email address or a phone number, hashed here and looked up whole, or how a subject's id begins.
   * Neither is kept, and neither is ever part of an address, which servers and browsers write down.
   */
  async function find(given: unknown): Promise<{ by: 'email' | 'phone' | 'click' | 'subject'; subjects: Subject[] }> {
    if (typeof given !== 'string' || !given.trim() || given.length > 512) throw malformed('`text` is required, up to 512 characters')
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
    const subjects = await graph.search(text)
    // An ad click id is looked up whole, once no subject's id begins like it.
    const clicked = subjects.length === 0 ? await graph.clicked(text) : []
    return clicked.length > 0 ? { by: 'click', subjects: clicked } : { by: 'subject', subjects }
  }

  return { pool, convert, calling, textOptions, identify, factsIn, find, lineOf }
}

export type Service = ReturnType<typeof createService>
