import { malformed } from '../contract/fault.ts'
import type { Change, Identifier, Outcome, Subject } from '../contract/types.ts'
import type { CallOptions } from './calls.ts'
import type { Graph } from './graph.ts'
import { birthKeys, email, hashPhone, identifier, ip, nameKeys, nameParts, normalizePhone, phoneOfType } from './identifiers.ts'
import { withStage } from './ladder.ts'
import type { Ladder } from './ladder.ts'
import { fakePhone, placeholderEmail, sharedMailbox } from './lookups.ts'
import { givenKeys, namedKeys, personKeys } from './names.ts'
import type { Job, Outbox } from './outbox.ts'
import { addressIdentifier } from './ports.ts'
import type { AddressVerifier, LineTypeLookup } from './ports.ts'
import type { TextOptions } from './texts.ts'

const ID = /^[\w.-]{1,128}$/
const PLACEHOLDER = 'a placeholder: not used'
/** Why an email is nobody's, or undefined where it may be somebody's. */
const nobodysEmail = (text: string) => (placeholderEmail(text) ? PLACEHOLDER : sharedMailbox(text) ? 'read by several: not used' : undefined)

export interface ServiceOptions {
  outbox?: Outbox
  stages?: Ladder
  calls?: CallOptions
  texts?: TextOptions
  pool?: { numbers: readonly string[]; minutes: number; grace: number; requireTapAfterReassignment?: boolean }
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
      ...(options.texts?.codeLife !== undefined && { codeLife: options.texts.codeLife }),
      ...(pool.length > 0 && { pool: { numbers: pool, grace: options.pool!.grace * 60_000, requireTapAfterReassignment: options.pool!.requireTapAfterReassignment === true } }),
      now,
      convert,
      count: (outcome) => graph.outcome(staged(outcome)),
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
    const { identifiers: all, notes, at } = await factsIn(body, true)
    const speaker = body.speaker === undefined ? undefined : await speakerIn(body)
    if (speaker?.note) notes.speaker = speaker.note
    // What is the speaker's says who the speaker is, so it is not written on whoever they speak for.
    const theirs = new Set(speaker?.theirs.flatMap((each) => [each, each.replace(/^phone:/, 'voip:'), each.replace(/^voip:/, 'phone:')]))
    const own = all.filter((each) => !theirs.has(each))
    const identifiers = [...own, ...(await named(body, own)), ...(speaker && speaker.subjects.length > 0 ? await named(body, speaker.used, 'ward') : [])]
    if (own.length < all.length) notes.speaker = 'what is the speaker\'s is not used for who they speak for'
    // What was written before anybody said so stays written, and only a person can say whose it is.
    if (theirs.size > 0 && (await graph.holders([...theirs])).some((edge) => edge.subject === body.subject)) notes.speaker = 'on this record already, from before: mute or forget it if it is the speaker\'s'
    const event = typeof body.event === 'string' && body.event ? (body.event as string) : undefined
    const who = { subject: body.subject as Subject, identifiers }
    if (speaker && speaker.subjects.length > 0) {
      const said = await graph.speak(who, speaker.subjects, at, event)
      return { changes: said.changes, identifiers: said.identifiers, notes, speakers: speaker.subjects.map((each) => each.subject) }
    }
    const changes = identifiers.length > 0 ? await graph.observe({ ...who, at, ...(event && { event }) }) : []
    return { changes, identifiers, notes, speakers: [] as Subject[] }
  }

  /** The keys of these numbers and emails under the name in a body, where the policy uses names. */
  async function named(body: any, contact: readonly Identifier[], kind: 'named' | 'ward' = 'named'): Promise<Identifier[]> {
    if (!options.identifierSecret || typeof body.name?.first !== 'string' || typeof body.name?.last !== 'string') return []
    return (await graph.policy()).rules.apart?.includes('given') ? namedKeys(options.identifierSecret, contact, body.name.first, body.name.last, kind) : []
  }

  /** Somebody who speaks for the subject: what is theirs, and the browser and the caller it is to be written on. */
  async function speakerIn(body: any): Promise<{ theirs: Identifier[]; subjects: { subject: Subject; identifiers: Identifier[] }[]; used: Identifier[]; note?: string }> {
    const { device, phone, email: address } = typeof body.speaker === 'object' && body.speaker !== null ? body.speaker : {}
    if (/^(visitor|caller|call):/.test(body.subject)) throw malformed('A speaker speaks for a record of yours, not for a browser or a caller')
    // Nobody is named by it, and what is told of the subject is kept.
    if (device === undefined && !(typeof phone === 'string' && phone)) return { theirs: typeof address === 'string' && address ? [email(address)] : [], subjects: [], used: [], note: 'not used: a speaker requires a device or a phone' }
    const { identifiers: theirs, notes } = await factsIn({ device, phone }, true, true)
    const ofDevice = theirs.find((each) => each.startsWith('device:'))
    // A number that names nobody is the speaker's all the same, and nothing more is made of it.
    const used = [...theirs]
    if (typeof phone === 'string' && phone) theirs.push(`phone:${hashPhone(phone, options.calls?.country)}`)
    const ofPhone = !notes.phone?.endsWith(': not used') && theirs.find((each) => /^(phone|voip):/.test(each))
    const subjects: { subject: Subject; identifiers: Identifier[] }[] = []
    if (ofDevice) {
      // Its own visitor, where there is one. Another that holds the id is taken only while the id is evidence and it is the one that may be it.
      const exact: Subject = `visitor:${device}`
      let who = exact
      if (!(await graph.cluster(exact))) {
        const apart = new Set(await graph.separations(body.subject))
        const others = (await graph.match([ofDevice], { limit: 100 })).map((each) => each.subject).filter((each) => each.startsWith('visitor:') && !apart.has(each))
        if (others.length === 1) who = others[0]!
      }
      subjects.push({ subject: who, identifiers: [ofDevice] })
    }
    if (ofPhone) subjects.push({ subject: `caller:${hashPhone(phone, options.calls?.country)}`, identifiers: [ofPhone] })
    if (typeof address === 'string' && address && !nobodysEmail(address)) {
      theirs.push(email(address))
      used.push(email(address))
      subjects.at(-1)?.identifiers.push(email(address))
    }
    return { theirs, subjects, used, ...(subjects.length === 0 && { note: notes.phone ?? 'not used' }) }
  }

  /** The identifiers in plain facts about somebody, normalized, checked and hashed, and what came of the checks. Only where they are to be saved is the line of a number looked up, because that can mute it. */
  async function factsIn(body: any, saving: boolean, none = body.speaker !== undefined) {
    const identifiers: Identifier[] = (Array.isArray(body.identifiers) ? body.identifiers : []).map(String)
    const notes: Record<string, string> = {}
    let zip: string | undefined
    if (body.device !== undefined) {
      if (typeof body.device !== 'string' || !ID.test(body.device)) throw malformed('The device id is malformed')
      identifiers.push(identifier('device', body.device))
    }
    // What a form was filled in with for want of anything, and what an office reads together, is nobody's.
    const nobodys = typeof body.email === 'string' ? nobodysEmail(body.email) : undefined
    if (nobodys) notes.email = nobodys
    else if (typeof body.email === 'string' && body.email) identifiers.push(email(body.email))
    if (typeof body.ip === 'string' && body.ip) identifiers.push(ip(body.ip))
    if (typeof body.phone === 'string' && body.phone) {
      const number = normalizePhone(body.phone, options.calls?.country)
      const made = fakePhone(number)
      if (made === 'repeated' || made === 'counted') notes.phone = PLACEHOLDER
      // A lookup that is down must not lose the sighting: the number is kept as a plain phone.
      const line = lineOf && saving && !notes.phone ? ((await lineOf(number).catch((error) => void console.error(error))) ?? undefined) : undefined
      const found = notes.phone ? undefined : phoneOfType(number, line?.type)
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
    // Where records have to be confirmed, a full name and a date of birth are somebody.
    if (options.identifierSecret && typeof body.dob === 'string' && typeof body.name?.first === 'string' && typeof body.name?.last === 'string' && (await graph.policy()).rules.records) identifiers.push(...personKeys(options.identifierSecret, body.name.first, body.name.last, body.dob))
    // Kept only under a policy that keeps people apart by them. They say who somebody is not, and not who they are, so by themselves they find nobody.
    const apart = options.identifierSecret && (typeof body.dob === 'string' || typeof body.name?.first === 'string') ? ((await graph.policy()).rules.apart ?? []) : []
    const born = apart.length > 0 && typeof body.dob === 'string' ? birthKeys(options.identifierSecret!, body.dob) : []
    const placeholder = apart.includes('given') && typeof body.name?.first === 'string' && typeof body.name.last === 'string' && !nameParts(body.name.first, body.name.last)
    const facts = [...born, ...(apart.includes('given') && typeof body.name?.first === 'string' ? givenKeys(options.identifierSecret!, body.name.first, placeholder ? body.subject ?? '' : undefined) : []),
      // Whether a name has several words is kept only where it can tell two records apart, and says no more than that.
      ...((await graph.policy()).rules.records && typeof body.name?.first === 'string' && body.name.first.trim().split(/\s+/).length > 1 ? (['compound:yes'] as Identifier[]) : [])]
    if (identifiers.length === 0 && !(saving && (facts.length > 0 || none)) && notes.phone !== PLACEHOLDER && notes.email === undefined) throw malformed('At least one identifying field is required')
    identifiers.push(...facts)
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

  return { pool, convert, calling, textOptions, identify, factsIn, named, find, lineOf }
}

export type Service = ReturnType<typeof createService>
