import type {
  Arrival, At, DecideRefusal, DecideRequest, DecideValue, Delivery, EventPage, EventsRequest, ForgetRefusal, ForgetRequest, ForgetValue, JourneyEntry, LookupRequest, LookupValue, Match,
  Person, RecordEntry, RecordRefusal, RecordRequest, RecordResponse, RecordResult, RecordView, ReportRequest, ReportValue, Tied, Window,
} from '../contract/api.ts'
import { FAULT_CODES, fault, isRefused, malformed } from '../contract/fault.ts'
import { canonical } from '../contract/json.ts'
import { no, ok } from '../contract/outcome.ts'
import type { Decided, Outcome } from '../contract/outcome.ts'
import type { AttributedTouch, Candidate, Counterparty, Identifier, Reason, Subject, Touch } from '../contract/types.ts'
import { callState, followUp, recordCall, ringing, settleCall, settleLead } from './calls.ts'
import type { CallOptions, Call } from './calls.ts'
import type { Engine, Inside } from './engine.ts'
import { cursorOf, seqOf } from './events.ts'
import { Outdated } from './graph.ts'
import type { Hours } from './hours.ts'
import { email, hashPhone, identifier, ip, normalizeEmail, normalizePhone } from './identifiers.ts'
import { newest } from './said.ts'
import { sentOf } from './outbox.ts'
import type { Job } from './outbox.ts'
import type { PostalAddress, VerifiedAddress } from './ports.ts'
import type { Receipts } from './receipts.ts'
import { dayIn, dayStart, sourceOf } from './report.ts'
import { knownLink } from './sign.ts'
import { asks, beginnings, recordText, replyTo } from './texts.ts'
import { checkTags } from './tags.ts'
import { checkTouch } from './touch.ts'

/** Kinds of identifier the graph writes itself. One a caller wrote would join people with nobody having decided it. */
const RESERVED = new Set(['behalf', 'named', 'ward', 'given', 'dated', 'initial', 'review', 'link', 'carry', 'opened', 'lease', 'dial', 'text', 'place', 'birth', 'dialed'])
/** How many checks of addresses and lines are under way at once, and how long one may take. */
const TOGETHER = 8
const CHECK = 3_000
const MINUTE = 60_000

export interface SixOptions {
  receipts: Receipts
  linkSecret?: string
  hours?: Hours
  timeZone?: string
  returnHours?: number
}

/** What a call is asked with: until when it may take, and by whom, where that is known. */
export interface Asked {
  /** When it must be done. */
  until?: number
  signal?: AbortSignal | undefined
}

const kinds = (reasons: readonly Reason[]): string[] => [...new Set(reasons.map(({ identifier }) => identifier.slice(0, identifier.indexOf(':'))))]
const delivery = ({ transactionId, target, state, note }: Job): Delivery => ({ conversion: transactionId, platform: target, state, ...(note !== undefined && { note }) })
const ofKey = (type: 'conversion' | 'call' | 'text', key: string) => (type === 'conversion' ? key : `${type}:${key}`)

function arrival(touch: AttributedTouch | undefined, subject: Subject): Arrival | null {
  if (!touch) return null
  return { at: touch.at, source: sourceOf(touch), campaign: touch.campaign ?? null, campaignId: touch.campaignId ?? null, landing: touch.landing ?? null, custom: touch.custom ?? {}, confidence: touch.confidence, how: touch.subject === subject ? 'self' : touch.joined ? 'cluster' : 'linked' }
}
const match = ({ subject, members, score, level, reasons, conflict, unconfirmed }: Candidate): Match => ({ subject, members, score, level, kinds: kinds(reasons), ...(conflict && { conflict }), ...(unconfirmed && { unconfirmed }) })
const tied = ({ reasons, ...rest }: Counterparty): Tied => ({ ...rest, kinds: kinds(reasons) })

/** What was checked for one entry before its transaction, so that nothing is waited for inside it. */
interface Checked {
  line: { type: string; carrier: string | undefined } | undefined
  lineFailed: boolean
  /** Of whoever speaks, where they have a number of their own. */
  spoken?: { number: string; line: Checked['line']; failed: boolean }
  address: VerifiedAddress | undefined
  addressFailed: boolean
}

export function createSix(engine: Engine, options: SixOptions) {
  const { receipts } = options
  const { now, store, graph, outbox, service } = engine
  const country = engine.options.calls?.country
  const callOptions = (): CallOptions => service.calling()

  // ── record ────────────────────────────────────────────────────────────────

  /** Throws for what is of the right shape and still cannot be, so that nothing is written for it. */
  function preflight(entry: RecordEntry, path: string): void {
    const within = (field: string, work: () => unknown) => {
      try {
        work()
      } catch (error) {
        throw malformed(`${path}.${field}: ${(error as Error).message}`, { path: `${path}.${field}` })
      }
    }
    switch (entry.type) {
      case 'profile': {
        const { email: address, phone, ip: from, address: postal } = entry.facts
        if (address !== undefined) within('facts.email', () => normalizeEmail(address))
        if (phone !== undefined) within('facts.phone', () => normalizePhone(phone, country))
        if (from !== undefined) within('facts.ip', () => ip(from))
        if (postal !== undefined && !postal.street.trim()) throw malformed(`${path}.facts.address.street is empty`, { path: `${path}.facts.address.street` })
        if (entry.facts.device !== undefined) within('facts.device', () => identifier('device', entry.facts.device!))
        const { speaker } = entry
        if (speaker && /^(visitor|caller|call):/.test(entry.subject)) throw malformed(`${path}.speaker speaks for a record of yours, not for a browser or a caller`, { path: `${path}.speaker` })
        if (speaker?.email !== undefined) within('speaker.email', () => normalizeEmail(speaker.email!))
        if (speaker?.phone !== undefined) within('speaker.phone', () => normalizePhone(speaker.phone!, country))
        if (speaker?.device !== undefined) within('speaker.device', () => identifier('device', speaker.device!))
        break
      }
      case 'arrival':
        within('arrival', () => checkTouch(touchOf(entry)))
        break
      case 'conversion':
        if (entry.email !== undefined) within('email', () => normalizeEmail(entry.email!))
        if (entry.phone !== undefined) within('phone', () => normalizePhone(entry.phone!, country))
        within('tags', () => checkTags(entry.tags, 'The conversion'))
        for (const platform of Object.keys(entry.actions ?? {})) if (!engine.options.delivery?.targets.some((target) => target.name === platform)) throw malformed(`${path}.actions.${platform} is not a platform that is set up`, { path: `${path}.actions.${platform}` })
        break
      case 'cost':
        for (const [i, row] of entry.rows.entries()) {
          within(`rows[${i}].day`, () => dayStart(row.day))
          if (!row.source.trim()) throw malformed(`${path}.rows[${i}].source is empty`, { path: `${path}.rows[${i}].source` })
          if (row.conversionValue !== undefined && row.conversions === undefined) throw malformed(`${path}.rows[${i}].conversionValue requires conversions`, { path: `${path}.rows[${i}].conversionValue` })
        }
        break
      case 'consent':
        // Dated ahead, it would stand over every real answer until that day came.
        if (entry.at > now() + 86_400_000) throw malformed(`${path}.at is more than a day ahead`, { path: `${path}.at` })
        break
      case 'call':
        within('to', () => normalizePhone(entry.to, country))
        within('tags', () => checkTags(entry.tags, 'The call'))
        if (entry.direction === 'outbound') {
          if (entry.from === undefined) throw malformed(`${path}.from is required of a call you placed`, { path: `${path}.from` })
          within('from', () => normalizePhone(entry.from!, country))
        }
        break
      case 'text':
        within('tags', () => checkTags(entry.tags, 'The text'))
        within(entry.direction === 'outbound' ? 'from' : 'to', () => normalizePhone(entry.direction === 'outbound' ? entry.from : entry.to, country))
        break
      case 'link':
        if (!options.linkSecret) throw fault(FAULT_CODES.CONFIG.UNSUPPORTED, 'Links require `linkSecret`')
        within('url', () => {
          // A browser hands the token back in the address, and no longer one is read.
          if (new URL(linkOf(entry)).searchParams.get('ag')!.length > 1024) throw malformed('the key and the subject are too long together')
        })
        break
      case 'transfer':
        if (entry.from === entry.to) throw malformed(`${path} requires two different subjects`, { path })
        break
    }
  }

  function touchOf({ subject, at, clicks, type: _, key: __, ...rest }: Extract<RecordEntry, { type: 'arrival' }>): Touch {
    return { subject, at, ...rest, ...clicks }
  }
  const linkOf = (entry: Extract<RecordEntry, { type: 'link' }>) => knownLink(entry.url, entry.subject, { secret: options.linkSecret!, id: entry.key, now: () => entry.at, lasts: Math.floor(entry.expires / 1000) * 1000 - entry.at })

  /** The line of a number and the address, asked before anything is locked. */
  async function check(entry: RecordEntry, left: number): Promise<Checked> {
    const bounded = async <T>(work: Promise<T>): Promise<{ value?: T; failed: boolean }> => {
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<{ failed: boolean }>((resolve) => void (timer = setTimeout(() => resolve({ failed: true }), Math.min(CHECK, left))))
      const done = work.then((value) => ({ value, failed: false }), (error) => {
        console.error(`check: ${String((error as Error)?.message ?? error)}`)
        return { failed: true }
      })
      const result = await Promise.race([done, late])
      clearTimeout(timer)
      return result
    }
    const { address: verify, lineType } = engine.options
    let number: string | undefined
    let spoken: string | undefined
    try {
      if (entry.type === 'profile' && entry.speaker?.phone) spoken = normalizePhone(entry.speaker.phone, country)
      if (entry.type === 'profile' && entry.facts.phone) number = normalizePhone(entry.facts.phone, country)
      if ((entry.type === 'call' || entry.type === 'text') && entry.direction === 'inbound' && entry.from) number = normalizePhone(entry.from, country)
    } catch {}
    const postal = entry.type === 'profile' ? entry.facts.address : undefined
    const [line, theirs, address] = await Promise.all([
      lineType && number !== undefined ? bounded(lineType(number)) : { failed: false },
      lineType && spoken !== undefined && spoken !== number ? bounded(lineType(spoken)) : { failed: false },
      verify && postal ? bounded(verify(postal as PostalAddress)) : { failed: false },
    ])
    return { line: 'value' in line ? line.value : undefined, lineFailed: line.failed, address: 'value' in address ? address.value : undefined, addressFailed: address.failed, ...(spoken !== undefined && spoken !== number && { spoken: { number: spoken, line: 'value' in theirs ? theirs.value : undefined, failed: theirs.failed } }) }
  }

  /** Checks take a third of the time there is, all together. What was not checked by then is recorded unchecked. */
  async function checks(entries: readonly RecordEntry[], budget: number): Promise<Checked[]> {
    const out: Checked[] = []
    const began = performance.now()
    let next = 0
    await Promise.all(Array.from({ length: Math.min(TOGETHER, entries.length) }, async () => {
      while (next < entries.length) {
        const i = next++
        const left = budget - (performance.now() - began)
        out[i] = left > 0 ? await check(entries[i]!, left) : { line: undefined, lineFailed: true, address: undefined, addressFailed: true }
      }
    }))
    return out
  }

  /** What an entry is about, where that is another entry. */
  function refOf(entry: RecordEntry): { type: string; key: string } | undefined {
    if (entry.type === 'payment') return { type: 'conversion', key: entry.conversion }
    if (entry.type === 'call_update') return { type: 'call', key: entry.call }
    return entry.type === 'restatement' ? entry.of : undefined
  }

  type Values = { [T in RecordEntry['type']]: { value: Record<string, unknown>; subjects: readonly Subject[]; stands?: boolean; existed?: boolean } }

  const jobsOf = async (inside: Inside, transactionId: string): Promise<Delivery[]> => (inside.outbox ? (await inside.outbox.get(transactionId)).map(delivery) : [])

  /** Writes one entry, or where it was written before says how it stands. */
  async function write(inside: Inside, entry: RecordEntry, again: boolean): Promise<Values[RecordEntry['type']]> {
    const { graph, outbox, service } = inside
    switch (entry.type) {
      case 'profile': {
        for (const each of entry.facts.identifiers ?? []) {
          const kind = each.slice(0, each.indexOf(':'))
          if (RESERVED.has(kind)) throw Object.assign(malformed(`Kind "${kind}" is written by the graph itself`), { refusal: { reason: 'KIND_RESERVED', kind } })
        }
        if (again) return { value: { changes: [], notes: {} }, subjects: [] }
        const found = await service.factsIn({ ...entry.facts, at: entry.at }, true, true)
        if (found.identifiers.length === 0 && !entry.speaker) throw Object.assign(malformed('No fact could be used'), { refusal: { reason: 'NO_FACT_USED', notes: found.notes } })
        const { notes, speakers } = await service.identify({ subject: entry.subject, ...entry.facts, at: entry.at, ...(entry.event && { event: entry.event }), ...(entry.speaker && { speaker: entry.speaker }) })
        // Of whoever speaks too: once they are deleted, a late retry must not bring them back.
        return { value: { changes: inside.changes, notes }, subjects: [entry.subject, ...speakers] }
      }
      case 'arrival':
        if (!again) await graph.touch(touchOf(entry))
        return { value: { subject: entry.subject }, subjects: [entry.subject] }
      case 'cost': {
        const rows = entry.rows.map((row) => ({ ...row, currency: row.currency.toUpperCase() }))
        const written = again ? 0 : await graph.spend(rows, { at: entry.at, key: entry.key })
        const different = new Set(rows.map((row) => [row.day, row.source.trim().toLowerCase(), row.campaignId ?? ''].join('\0'))).size
        return { value: { written, older: again ? 0 : different - written }, subjects: [], stands: again || written > 0 }
      }
      case 'conversion': {
        const before = await graph.outcomeOf(entry.key)
        const { type: _, key, actions, channel, currency, phone, ...rest } = entry
        const outcome = { ...rest, ...(phone && { phone: normalizePhone(phone, country) }), transactionId: key, ...(currency && { currency: currency.toUpperCase() }), ...(actions && { action: actions }), ...(channel && { source: channel }) }
        if (before && !again && (before.subject !== entry.subject || before.at !== entry.at || before.stage !== entry.stage)) {
          const fields = [before.subject !== entry.subject && 'subject', before.at !== entry.at && 'at', before.stage !== entry.stage && 'stage'].filter((each) => typeof each === 'string')
          throw Object.assign(malformed(`Conversion "${key}" is another one`), { refusal: { reason: 'KEY_REUSED', fields } })
        }
        if (!before && !again) await service.convert(outcome)
        const counted = await graph.outcomeOf(key)
        return { value: { value: counted?.value ?? 0, currency: counted?.currency ?? '', deliveries: await jobsOf(inside, key) }, subjects: [entry.subject], existed: before !== undefined }
      }
      case 'restatement': {
        const id = ofKey(entry.of.type, entry.of.key)
        const { change } = entry
        let stands = true
        if (change.kind === 'not_lead' || change.kind === 'lead') {
          if (!again) {
            const said = await graph.sayLead({ id, key: entry.key, at: entry.at, ...(change.kind === 'not_lead' && { kind: change.why }) })
            stands = said.stands
            await settleLead(graph, id, said.lead, service.calling())
          }
        } else if (!again) {
          const given = 'currency' in change && change.currency ? { ...change, currency: change.currency.toUpperCase() } : change
          try {
            stands = (await graph.revise({ key: entry.key, at: entry.at, transactionId: id, change: given })).stands
          } catch (error) {
            if (isRefused(error) && error.refusal.reason === 'UNKNOWN_REFERENCE') throw Object.assign(error, { refusal: { reason: 'UNKNOWN_REFERENCE', of: 'restatement' in error.refusal ? { type: 'restatement', key: error.refusal.restatement } : entry.of } })
            throw error
          }
          await outbox?.revalue(id)
        }
        const counted = await graph.outcomeOf(id)
        const spurned = (await graph.notLeads([id])).has(id)
        return { value: { counts: counted !== undefined && !spurned, value: counted?.value ?? null, deliveries: await jobsOf(inside, id) }, subjects: [], stands }
      }
      case 'payment': {
        let existed = false
        if (!again) {
          const payment = { id: entry.key, transactionId: entry.conversion, amount: entry.amount, kind: entry.direction === 'refunded' ? ('refund' as const) : ('payment' as const), ...(entry.currency && { currency: entry.currency.toUpperCase() }) }
          existed = (await (outbox ? outbox.pay(payment) : graph.pay(payment))).duplicate
        }
        return { value: { value: (await graph.outcomeOf(entry.conversion))?.value ?? null, deliveries: await jobsOf(inside, entry.conversion) }, subjects: [], existed }
      }
      case 'call': {
        const { type: _, key, result, ...rest } = entry
        const call: Call = { id: key, ...rest, ...result }
        const recorded = await recordCall(graph, call, { ...service.calling(), said: { key: `call ${entry.at} ${canonical(result ?? null)}`, at: entry.at } })
        // Of two reports at one time, the same one stands whichever came first.
        const stands = !result || newest(await inside.tx.saidOf('result', key))?.key === `call ${entry.at} ${canonical(result)}`
        return { value: { subject: recorded.subject, state: recorded.state, counted: recorded.counted, flags: recorded.flags, ...(recorded.visitor && { visitor: recorded.visitor }) }, subjects: [recorded.subject], existed: recorded.duplicate, stands }
      }
      case 'call_update': {
        const { change } = entry
        let stands = true
        if (!again) {
          if (change.kind === 'result') {
            const { result } = change
            stands = (await graph.sayResult({ call: entry.call, key: entry.key, at: entry.at, result: { answered: result.answered, ...(result.voicemail !== undefined && { voicemail: result.voicemail }), ...(result.waited !== undefined && { waited: result.waited }) } })).stands
            await settleCall(graph, entry.call, service.calling())
          } else {
            // Said of a call you placed it is kept, and means nothing, as it would had it come first.
            const outbound = (await graph.keptCall(entry.call))?.direction === 'outbound'
            stands = (await graph.sayReturn({ call: entry.call, key: entry.key, at: entry.at, ...(change.kind === 'returned' && { reachedAt: change.reachedAt }) })).stands && !outbound
          }
        }
        const kept = await graph.keptCall(entry.call)
        return {
          value: {
            state: kept ? callState(kept, now(), service.calling()) : 'waiting',
            counted: (await graph.outcomeOf(`call:${entry.call}`)) !== undefined,
            followUp: kept?.direction === 'inbound' && kept.result?.answered === false ? followUp(kept, await graph.callsOf([kept.subject])) : null,
          },
          subjects: kept ? [kept.subject] : [],
          stands,
        }
      }
      case 'text': {
        const { type: _, key, ...rest } = entry
        const recorded = await recordText(graph, { id: key, ...rest }, service.textOptions())
        return { value: { subject: recorded.subject, flags: recorded.flags, counted: recorded.counted, ...(recorded.visitor && { visitor: recorded.visitor }) }, subjects: [recorded.subject], existed: recorded.duplicate }
      }
      case 'consent': {
        const stands = again || (await graph.consent(entry.subject, entry.consent, { at: entry.at, key: entry.key, ...(entry.source && { source: entry.source }) })).stands
        return { value: { ...((await graph.consentOf([entry.subject])).get(entry.subject) ?? entry.consent) }, subjects: [entry.subject], stands }
      }
      case 'link': {
        if (!again) await graph.keepLink({ id: entry.key, subject: entry.subject, ...(entry.purpose && { purpose: entry.purpose }), at: entry.at, expires: Math.floor(entry.expires / 1000) * 1000 })
        return { value: { url: linkOf(entry) }, subjects: [entry.subject] }
      }
      case 'transfer': {
        const { type: _, key, at, from, to, amount, asset } = entry
        const { relation, score, duplicate } = await graph.transfer({ id: key, at, from, to, amount, ...(asset && { asset }) })
        return { value: { relation, score }, subjects: [from, to], existed: duplicate }
      }
    }
  }

  async function one(entry: RecordEntry, checked: Checked): Promise<RecordResult> {
    const { type, key } = entry
    const about = refOf(entry)
    const answer = (decided: Decided<object, RecordRefusal>) => ({ type, key, ...decided }) as unknown as RecordResult
    const lookups = {
      ...(engine.options.lineType && { lineType: async (number: string) => {
        // Whoever speaks has a number of their own.
        const of = checked.spoken?.number === number ? checked.spoken : { line: checked.line, failed: checked.lineFailed }
        if (of.failed) throw new Error('The line check did not answer')
        return of.line
      } }),
      ...(engine.options.address && { address: async () => { if (checked.addressFailed) throw new Error('The address check did not answer'); return checked.address } }),
    }
    try {
      return await engine.unit(async (inside) => {
        const { tx } = inside
        // Read once the lock is held: of two that came at once, the second finds what the first left.
        const before = await tx.receiptOf(type, receipts.mac(type, key).all)
        const parent = about && (await tx.receiptOf(about.type, receipts.mac(about.type, about.key).all))
        if (before?.forgotten !== undefined || parent?.forgotten !== undefined) return answer(no({ reason: 'FORGOTTEN' as const }))
        const fields = before && receipts.differs(before, entry)
        if (fields && fields.length > 0) return answer(no({ reason: 'KEY_REUSED' as const, fields }))
        const { value, subjects, stands = true, existed = false } = await write(inside, entry, before !== undefined)
        if (!before) await tx.addReceipt(receipts.make(entry, now(), about), subjects)
        return answer(ok({ duplicate: before !== undefined || existed, stands, ...value }))
      }, lookups)
    } catch (error) {
      if (isRefused(error)) return answer(no(error.refusal as unknown as RecordRefusal))
      throw error
    }
  }

  async function record({ entries }: RecordRequest, asked: Asked = {}): Promise<RecordResponse> {
    entries.forEach((entry, i) => preflight(entry, `request.entries[${i}]`))
    const checked = await checks(entries, asked.until === undefined ? TOGETHER * CHECK : (asked.until - now()) / 3)
    const results: RecordResult[] = []
    for (const [i, entry] of entries.entries()) {
      asked.signal?.throwIfAborted()
      if (asked.until !== undefined && now() >= asked.until) results.push({ type: entry.type, key: entry.key, ...no({ reason: 'NOT_ATTEMPTED' as const }) } as unknown as RecordResult)
      else results.push(await one(entry, checked[i]!))
    }
    return { results }
  }

  // ── decide and forget ─────────────────────────────────────────────────────

  const why = ({ by, reason, seen }: { by: string; reason?: string; seen?: number }) => ({ by, ...(reason !== undefined && { reason }), ...(seen !== undefined && { seen }) })
  const stale = ({ decision }: Outdated) => no({ reason: 'STALE' as const, decision: decision.seq, by: decision.by ?? null, at: decision.at })

  const muted = (fact: Extract<DecideRequest, { fact: unknown }>['fact']): Identifier[] => {
    if ('email' in fact) return [email(fact.email)]
    if ('ip' in fact) return [ip(fact.ip)]
    if ('phone' in fact) return ['phone', 'voip'].map((kind) => `${kind}:${hashPhone(fact.phone, country)}`)
    return [fact.identifier]
  }

  async function decide(request: DecideRequest): Promise<Decided<DecideValue, DecideRefusal>> {
    const entry = { type: 'decide' as const, ...request }
    const identifiers = 'fact' in request ? muted(request.fact) : []
    if ('pairs' in request) for (const { a, b } of request.pairs) if (a === b) throw malformed(`"${a}" is the same as itself`)
    deciding += 1
    try {
      return await engine.unit(async ({ graph, tx, changes }) => {
        const before = await tx.receiptOf('decide', receipts.mac('decide', request.key).all)
        if (before?.forgotten !== undefined) return no({ reason: 'FORGOTTEN' as const })
        const fields = before && receipts.differs(before, entry)
        if (fields && fields.length > 0) return no({ reason: 'KEY_REUSED' as const, fields })
        let recorded = 0
        let already = 0
        let notAsAsked: DecideValue['notAsAsked'] = []
        if ('pairs' in request) {
          const { action, pairs } = request
          if (!before) {
            const told = pairs.map(({ a, b, reason }) => ({ a, b, ...(reason !== undefined && { reason }), ...(action === 'unsplit' && { separated: false }) }))
            const done = await (action === 'merge' ? graph.joinAll(told, why(request)) : action === 'unmerge' ? graph.unjoinAll(told, why(request)) : graph.separateAll(told, why(request)))
            ;({ recorded, already } = done)
          } else already = pairs.length
          const standing = await graph.standingOf(pairs.map(({ a, b }) => [a, b]))
          notAsAsked = pairs.flatMap(({ a, b }, i): DecideValue['notAsAsked'] => {
            const { together } = standing[i]!
            if (action === 'merge' && !together) return [{ a, b, because: 'split' }]
            if (action !== 'unmerge' || !together) return []
            return [{ a, b, because: 'other_merges' }]
          })
          if (action === 'unmerge') {
            const scores = await Promise.all(notAsAsked.map(({ a, b }) => graph.between(a, b)))
            notAsAsked = notAsAsked.map((each, i) => ({ ...each, because: scores[i]!.score >= engine.policy.same ? ('evidence' as const) : ('other_merges' as const) }))
          }
          if (!before) await tx.addReceipt(receipts.make(entry, now()), [...new Set(pairs.flatMap(({ a, b }) => [a, b]))])
        } else {
          for (const each of before ? [] : identifiers) {
            // A phone is one of two kinds, and a policy may name only one.
            if (identifiers.length > 1 && !Object.hasOwn(engine.policy.kinds, each.slice(0, each.indexOf(':')))) continue
            const decisions = (await tx.lastDecision())?.seq
            await graph.ignore(each, request.action === 'mute', why(request))
            if ((await tx.lastDecision())?.seq === decisions) already += 1
            else recorded += 1
          }
          if (before) already = identifiers.length
          else await tx.addReceipt(receipts.make(entry, now()), [])
        }
        return ok({ duplicate: before !== undefined, changes: before ? [] : changes, recorded, already, notAsAsked })
      })
    } catch (error) {
      if (error instanceof Outdated) return stale(error)
      if (isRefused(error)) return no(error.refusal as unknown as DecideRefusal)
      throw error
    } finally {
      settled()
    }
  }

  async function forget(request: ForgetRequest): Promise<Decided<ForgetValue, ForgetRefusal>> {
    if (request.platforms === 'retract' && !outbox?.retraction.targets.length) throw fault(FAULT_CODES.CONFIG.UNSUPPORTED, 'No configured ad platform accepts retractions')
    const entry = { type: 'forget' as const, ...request }
    const { all } = receipts.mac('forget', request.key)
    const subjects = [...new Set(request.subjects)]
    const retract = request.platforms === 'retract' || (outbox?.retraction.always ?? false)
    let gone: Job[] = []
    let answer: Decided<ForgetValue, ForgetRefusal>
    deciding += 1
    try {
      answer = await engine.unit(async ({ graph, tx, changes }) => {
        const before = await tx.receiptOf('forget', all)
        const fields = before && receipts.differs(before, entry)
        if (fields && fields.length > 0) return no({ reason: 'KEY_REUSED' as const, fields })
        if (before) return ok({ duplicate: true, changes: [], sent: (before.sent ?? []) as ForgetValue['sent'] })
        const keys = (await tx.keysOf(subjects)).map(({ type, key }) => ({ type, ...receipts.mac(type, key) }))
        await tx.forgetReceipts(subjects, keys, now())
        await graph.forget(subjects, why(request), (jobs) => void (gone = jobs))
        const sent = sentOf(gone).map(({ transactionId, target, action, at, state, note }) => ({ conversion: transactionId, platform: target, action, at, state: retract && outbox?.canRetract(target) && !note ? ('pending' as const) : state, ...(note !== undefined && { note }) }))
        await tx.addReceipt({ ...receipts.make(entry, now()), sent }, [])
        return ok({ duplicate: false, changes, sent })
      })
    } catch (error) {
      if (error instanceof Outdated) return stale(error)
      throw error
    } finally {
      settled()
    }
    if (!answer.ok || answer.value.duplicate || !answer.value.sent.some((each) => each.state === 'pending')) return answer
    // Asked once they are gone here, and never inside the transaction that did it.
    const told = await outbox!.retract(gone)
    const sent = answer.value.sent.map((each) => {
      const found = told.find(({ transactionId, target }) => transactionId === each.conversion && target === each.platform)
      return found ? { ...each, state: found.state, ...(found.note !== undefined && { note: found.note }) } : each
    })
    await store.write((tx) => tx.setReceiptSent('forget', all, sent))
    return ok({ ...answer.value, sent })
  }

  // ── lookup ────────────────────────────────────────────────────────────────

  async function person(subjects: readonly Subject[], at: At): Promise<Person[]> {
    const people = await graph.people(subjects, { at })
    const consents = await graph.consentOf(subjects)
    return Promise.all(people.map(async ({ subject, members, touch, optedOut }) => {
      const cluster = await graph.cluster(subject)
      const possible = touch ? undefined : (await graph.attribute(subject, { at })).touches.reduce<AttributedTouch | undefined>((best, each) => (best && best.confidence >= each.confidence ? best : each), undefined)
      return { subject, known: cluster !== undefined, members, oversized: cluster?.oversized ?? false, arrival: arrival(touch, subject), possible: arrival(possible, subject), consent: consents.get(subject) ?? null, textsOptedOut: optedOut }
    }))
  }

  async function journey(subject: Subject, before?: number): Promise<LookupValue['journey']> {
    const { subjects, entries, next, more } = await graph.journey(subject, before === undefined ? {} : { before })
    const options = callOptions()
    const shown = await Promise.all(entries.map(async (entry): Promise<JourneyEntry | undefined> => {
      const { at, subject: on } = entry
      switch (entry.kind) {
        case 'visit': {
          const tie = subjects[on]
          return { at, subject: on, kind: 'visit', arrival: { at, source: sourceOf(entry.touch), campaign: entry.touch.campaign ?? null, campaignId: entry.touch.campaignId ?? null, landing: entry.touch.landing ?? null, custom: entry.touch.custom ?? {}, confidence: tie?.score ?? 1, how: tie?.how ?? 'self' } }
        }
        case 'sighting':
          return { at, subject: on, kind: 'sighting', event: entry.event, kinds: [...new Set(entry.identifiers.map((each) => each.slice(0, each.indexOf(':'))))] }
        case 'call':
          return { at, subject: on, kind: 'call', call: entry.call.id, direction: entry.call.direction, state: callState(entry.call, now(), options), followUp: entry.followUp ?? null, notLead: entry.notLead ?? null }
        case 'text':
          return { at, subject: on, kind: 'text', text: entry.text.id, direction: entry.text.direction, reply: entry.reply ?? null, notLead: entry.notLead ?? null }
        case 'link':
          return { at, subject: on, kind: 'link', link: entry.link.id, purpose: entry.link.purpose ?? null, opened: entry.link.opened ?? null, openings: entry.link.openings }
        case 'outcome': {
          const { transactionId, stage, value, currency } = entry.outcome
          return { at, subject: on, kind: 'conversion', conversion: transactionId, stage, value, currency, deliveries: outbox ? (await outbox.get(transactionId)).map(delivery) : [], notLead: entry.notLead ?? null }
        }
        case 'value':
          return { at, subject: on, kind: 'value', conversion: entry.transactionId, from: entry.from.value, to: entry.to.value, why: entry.to.why ?? entry.to.kind ?? 'correct' }
        case 'consent':
          return { at, subject: on, kind: 'consent', consent: { adUserData: entry.answer.adUserData, adPersonalization: entry.answer.adPersonalization }, source: entry.answer.source ?? null }
        case 'decision':
          return { at, subject: on, kind: 'decision', decision: entry.decision.seq, action: entry.decision.action, by: entry.decision.by ?? null, reason: entry.decision.reason ?? null }
      }
    }))
    return { subjects, entries: shown.filter((each) => each !== undefined), next, more }
  }

  async function view(type: 'conversion' | 'call' | 'text', key: string, at: At): Promise<RecordView | null> {
    const id = ofKey(type, key)
    const notLead = (await graph.notLeads([id])).get(id)?.kind ?? null
    if (type === 'conversion') {
      const outcome = await graph.outcomeOf(id)
      if (!outcome) return null
      const values = (await graph.values(id)).map(({ value, currency, at, kind, why }) => {
        const loss = kind ?? (why === 'refund' || why === 'write_off' ? why : undefined)
        return { value, currency, at, ...(loss && { kind: loss }) }
      })
      return { type, subject: outcome.subject, at: outcome.at, stage: outcome.stage, values, notLead, deliveries: outbox ? (await outbox.get(id)).map(delivery) : [] }
    }
    if (type === 'call') {
      const call = await graph.keptCall(key)
      if (!call) return null
      return { type, subject: call.subject, at: call.at, direction: call.direction, state: callState(call, at, callOptions()), followUp: call.direction === 'inbound' && call.result?.answered === false ? followUp(call, await graph.callsOf([call.subject])) : null, notLead }
    }
    const text = await graph.keptText(key)
    if (!text) return null
    const own = await graph.textsOf([text.subject])
    const calls = await graph.callsOf([text.subject])
    const not = await graph.notLeads(calls.map((call) => `call:${call.id}`))
    return { type, subject: text.subject, at: text.at, direction: text.direction, flags: [...(beginnings(own).has(text.id) ? ['first'] : []), ...text.flags], reply: asks(text) ? replyTo(text, own, calls.filter((call) => !not.has(`call:${call.id}`))) : null, notLead }
  }

  async function lookup(request: LookupRequest): Promise<LookupValue[LookupRequest['kind']]> {
    switch (request.kind) {
      case 'person': {
        // Read before the people: a decision made meanwhile is then newer than what was seen, and refuses.
        const decisions = (await graph.decisionPage({ limit: 1 }))[0]?.seq ?? 0
        return { decisions, people: await person(request.subjects, request.at) }
      }
      case 'journey':
        return journey(request.subject, request.before)
      case 'find':
        return service.find(request.text)
      case 'match': {
        const { identifiers, notes } = await service.factsIn({ ...request.facts, at: request.at }, false)
        const named = async (kind?: 'ward') => service.named(request.facts, identifiers, kind)
        return { candidates: (await graph.match([...identifiers, ...(await named()), ...(await named('ward'))], { at: request.at })).map(match), notes }
      }
      case 'caller': {
        try {
          normalizePhone(request.to, country)
        } catch (error) {
          throw malformed(`request.to: ${(error as Error).message}`, { path: 'request.to' })
        }
        const { subject, area, known, people, visitor, touch, waiting } = await ringing(graph, { to: request.to, at: request.at, ...(request.from !== undefined && { from: request.from }) }, callOptions())
        return { subject: subject ?? null, area: area ?? null, known, people: people.map(match), visitor: visitor ?? null, waiting, arrival: arrival(touch, subject ?? '') }
      }
      case 'conflicts':
        return { conflicts: await graph.conflicts(request.subjects) }
      case 'record':
        return view(request.type, request.key, request.at)
      case 'transfers': {
        const counterparties = (request.tiedOnly ? await graph.collusion(request.subject) : await graph.flows(request.subject)).map(tied)
        return { counterparties, rings: await graph.rings(request.subject) }
      }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────

  const days = ({ from, to, timeZone }: Window) => {
    try {
      if (dayStart(from) > dayStart(to)) throw malformed('request.window.from must be on or before request.window.to', { path: 'request.window' })
    } catch (error) {
      throw malformed((error as Error).message, { path: 'request.window' })
    }
    return { from, to, timeZone }
  }
  const after = (given: string | undefined) => {
    if (given === undefined) return undefined
    const cut = given.indexOf(' ')
    if (!(cut > 0 && /^\d{1,16}$/.test(given.slice(0, cut)) && Number.isSafeInteger(Number(given.slice(0, cut))))) throw malformed('request.after must be a `next` of a page', { path: 'request.after' })
    return { at: Number(given.slice(0, cut)), id: given.slice(cut + 1) }
  }
  const page = <T, R>(found: readonly T[], of: (each: T) => { at: number; id: string }, row: (each: T) => R) => {
    const shown = found.slice(0, 50)
    const last = shown.at(-1)
    return { rows: shown.map(row), next: found.length > 50 && last !== undefined ? `${of(last).at} ${of(last).id}` : null }
  }

  async function work(request: ReportRequest): Promise<ReportValue[ReportRequest['kind']]> {
    const calls = engine.options.calls
    switch (request.kind) {
      case 'campaigns': {
        const report = await graph.report({ ...days(request.window), ...(request.by && { by: request.by }), ...(request.per && { per: request.per }) })
        const named = Object.keys(engine.options.stages ?? {})
        return { ...report, timeZone: request.window.timeZone, steps: [...named, ...Object.keys(report.total.stages).filter((step) => !named.includes(step)).sort()] }
      }
      case 'pipeline': {
        const steps = Object.entries(engine.options.stages ?? {}).map(([name, { wait }]) => ({ name, ...(wait && { wait }) }))
        const { columns, ...board } = await graph.board({ steps, days: request.days, at: request.at, ...(options.timeZone && { timeZone: options.timeZone }), ...(options.returnHours && { returnHours: options.returnHours }), ...(options.hours && { hours: options.hours }) })
        return {
          at: board.at, day: board.day, from: board.from, unplaced: board.unplaced,
          columns: columns.map(({ rows, ...column }) => ({
            ...column,
            rows: rows.map(({ subject, at, late, step, outcome, call, touch, language }) => ({ subject, at, late, step, value: outcome?.value ?? null, currency: outcome?.currency ?? null, language: language ?? null, call: call ? { state: callState(call, request.at, calls), direction: call.direction } : null, arrival: arrival(touch, subject) })),
          })),
        }
      }
      case 'calls':
        return graph.callSummary({ ...days(request.window), at: request.at, ...(calls?.results && { results: calls.results }), ...(calls?.resultWait !== undefined && { resultWait: calls.resultWait }), ...(options.hours && { hours: options.hours }) })
      case 'callbacks': {
        const from = after(request.after)
        return page(await graph.openCalls({ ...days(request.window), limit: 51, ...(from && { after: from }) }), ({ call }) => call, ({ call, followUp, touch }) => ({ call: call.id, subject: call.subject, at: call.at, state: callState(call, request.at, calls), attempts: followUp.attempts, arrival: arrival(touch, call.subject) }))
      }
      case 'texts': {
        const from = after(request.after)
        return page(await graph.openTexts({ ...days(request.window), limit: 51, ...(from && { after: from }) }), ({ text }) => text, ({ text, unanswered, touch }) => ({ text: text.id, subject: text.subject, at: text.at, unanswered, arrival: arrival(touch, text.subject) }))
      }
      case 'after_calls':
        return graph.followed({ ...days(request.window), at: request.at, step: request.step, days: request.days })
      case 'deliveries':
        return { deliveries: outbox ? (await outbox.list(request.state)).map(delivery) : [] }
    }
  }

  // What takes long to work out is worked out once for everybody who asks at the same time, and is good until something is
  // written, or while things are written all the time, for a few times as long as it took and a minute at most.
  const answers = new Map<string, { version: number; at: number; until: number; made: boolean; answer: Promise<ReportValue[ReportRequest['kind']]> }>()
  let decided = 0
  let deciding = 0
  /** A decision is done: what was being worked out meanwhile is worked out again. */
  const settled = () => {
    deciding -= 1
    decided += 1
    answers.clear()
  }

  async function report(request: ReportRequest): Promise<{ asOf: At; value: ReportValue[ReportRequest['kind']] }> {
    const asked = now()
    // An `at` of about now is now. Kept in the key it would be new each time, and nothing would ever be shared.
    const { at, ...rest } = request as ReportRequest & { at?: At }
    const lately = at !== undefined && Math.abs(asked - at) < MINUTE
    const key = canonical(lately ? rest : request)
    if (request.kind === 'deliveries' || request.kind === 'callbacks' || request.kind === 'texts') return { asOf: at ?? asked, value: await work(request) }
    for (;;) {
      const since = decided
      if (deciding > 0) {
        const value = await work(request)
        if (decided !== since) continue
        return { asOf: at ?? asked, value }
      }
      const version = await graph.version()
      let known = answers.get(key)
      if (known?.made && !(now() - known.at < MINUTE && (known.version === version || now() < known.until))) known = undefined
      if (!known) {
        const begun = now()
        const next = (known = { version, at: begun, until: Infinity, made: false, answer: work(request) })
        for (const [old, { made }] of answers) if (answers.size >= 200 && made) answers.delete(old)
        answers.set(key, next)
        next.answer.then(
          () => Object.assign(next, { made: true, until: now() + 4 * (now() - begun) }),
          () => answers.get(key) === next && answers.delete(key),
        )
      }
      const value = await known.answer
      if (decided !== since || deciding > 0) continue
      return { asOf: lately || at === undefined ? known.at : at, value }
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  function events({ after, limit }: EventsRequest): Promise<Outcome<EventPage, 'CURSOR_LOST'>> {
    return store.read(async (tx) => {
      const head = await tx.eventHead()
      const seq = seqOf(head, after)
      if (seq === undefined) return { ok: false as const, reason: 'CURSOR_LOST' as const }
      const found = await tx.eventsAfter(seq, limit + 1)
      const shown = found.slice(0, limit)
      return ok({ schemaVersion: 1 as const, events: shown, cursor: cursorOf(head, shown.at(-1)?.seq ?? Math.max(seq, found.length === 0 ? head.seq : seq)), more: found.length > limit })
    })
  }

  /** A decision was made by another way in: what was worked out before it is worked out again. */
  const heard = () => {
    decided += 1
    answers.clear()
  }

  return { record, decide, forget, lookup, report, events, decided: heard }
}

export type Six = ReturnType<typeof createSix>
