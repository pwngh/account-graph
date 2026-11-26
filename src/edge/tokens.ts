import { createHash, timingSafeEqual } from 'node:crypto'
import type { DecideRequest, LookupRequest, RecordEntry, RecordResponse, ReportRequest } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'
import { leadProblems } from '../contract/lead-settings.ts'
import { CALLS, checked } from '../contract/validate.ts'
import type { CallName } from '../contract/validate.ts'

export type Reviewers = Readonly<Record<string, string | readonly string[]>>

type Kinds = {
  record: RecordEntry['type']
  decide: DecideRequest['action']
  lookup: LookupRequest['kind']
  report: ReportRequest['kind']
}
const KINDS = {
  record: { profile: true, arrival: true, cost: true, conversion: true, restatement: true, payment: true, call: true, call_update: true, text: true, consent: true, link: true, transfer: true },
  decide: { merge: true, unmerge: true, split: true, unsplit: true, mute: true, unmute: true, withdraw: true },
  lookup: { person: true, journey: true, find: true, match: true, caller: true, party: true, conflicts: true, record: true, transfers: true },
  report: { campaigns: true, pipeline: true, calls: true, callbacks: true, texts: true, after_calls: true, deliveries: true },
} satisfies { [C in keyof Kinds]: Record<Kinds[C], true> }

type Calls = { readonly [C in CallName]?: C extends keyof Kinds ? true | readonly Kinds[C][] : true }
export interface ServiceToken {
  readonly name: string
  readonly token: string
  readonly calls: Calls
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `secrets` are the graph's own, such as the receipt, link and identifier secrets, which a lead secret must not repeat. */
export function edgeLeadProblems(options: { leads?: unknown, token: string, reviewers?: Reviewers | undefined, serviceTokens?: readonly ServiceToken[] | undefined, twilio?: { authToken?: string } | undefined, fingerprint?: { secretKey?: string } | undefined, maxmind?: { licenseKey?: string } | undefined }, secrets: readonly (string | undefined)[] = []): string[] {
  if (options.leads === undefined) return []
  const services = Array.isArray(options.serviceTokens) ? options.serviceTokens : []
  const held = [options.token, ...Object.values(options.reviewers ?? {}).flat(), ...services.map(entry => entry?.token), options.twilio?.authToken, options.fingerprint?.secretKey, options.maxmind?.licenseKey, ...secrets].filter((each): each is string => typeof each === 'string')
  return leadProblems(options.leads, held, [...Object.keys(options.reviewers ?? {}), ...services.map(entry => entry?.name)])
}

export function serviceTokenProblems(tokens: unknown, reviewers: Reviewers | undefined, service: string): string[] {
  if (tokens === undefined) return []
  if (!Array.isArray(tokens)) return ['serviceTokens must be a list']
  const names = new Set(['service', 'system', 'people', ...Object.keys(reviewers ?? {})])
  const secrets = new Set([service, ...Object.values(reviewers ?? {}).flat()])
  const wrong: string[] = []
  for (const [i, entry] of tokens.entries()) {
    const where = `serviceTokens[${i}]`
    if (!object(entry) || Object.keys(entry).some(key => !['name', 'token', 'calls'].includes(key))) {
      wrong.push(`${where} must have a name, token and calls`)
      continue
    }
    const { name, token, calls } = entry
    if (typeof name !== 'string' || !/^[\w.-]{1,93}$/.test(name) || names.has(name)) wrong.push(`${where} requires a unique service name of 1 to 93 letters, digits, dots, underscores or hyphens`)
    else names.add(name)
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token) || secrets.has(token)) wrong.push(`${where} requires a unique nonempty token in printable characters`)
    else secrets.add(token)
    if (!object(calls)) wrong.push(`${where}.calls must be an object`)
    else for (const [call, kinds] of Object.entries(calls)) {
      const listed = Object.hasOwn(KINDS, call) && Array.isArray(kinds) && kinds.every(kind => typeof kind === 'string' && Object.hasOwn(KINDS[call as keyof Kinds], kind))
      if (!CALLS.includes(call as CallName) || !(kinds === true || listed)) wrong.push(`${where}.calls has an unknown call, kind or grant`)
    }
  }
  // These names go into logs. A configuration mistake must never print a credential there.
  if ([...tokens.map(entry => entry?.name), ...Object.keys(reviewers ?? {})].some(name => secrets.has(name))) wrong.push('a logged name cannot be a token')
  return wrong
}

type Owner = { role: 'service' } | { role: 'reviewer'; name: string } | { role: 'limited'; name: string; calls: Calls }
const digest = (token: string) => createHash('sha256').update(token).digest()

export function credentials(service: string, reviewers: Reviewers | undefined, limited: readonly ServiceToken[] = []) {
  const rows: { hash: Buffer; owner: Owner }[] = [{ hash: digest(service), owner: { role: 'service' } }]
  for (const [name, tokens] of Object.entries(reviewers ?? {})) {
    for (const token of [tokens].flat()) rows.push({ hash: digest(token), owner: { role: 'reviewer', name } })
  }
  for (const { name, token, calls } of limited) rows.push({ hash: digest(token), owner: { role: 'limited', name, calls: structuredClone(calls) } })
  return (authorization: string | undefined): Owner | undefined => {
    const sent = digest(authorization?.replace(/^bearer[ \t]+/i, '') ?? '')
    let owner: Owner | undefined
    // Compare every fixed-size digest, including after a match and for an absent header.
    for (const row of rows) if (timingSafeEqual(sent, row.hash)) owner = row.owner
    return owner
  }
}

const forbidden = () => fault(FAULT_CODES.AUTH.FORBIDDEN, 'The token does not open this call')

/** Shape errors apply to the whole batch. Refused items never reach the receipt or write path, and keep their place in the answer. */
export async function filterRecord(body: unknown, allow: (entry: RecordEntry) => RecordEntry | undefined, dispatch: (input: unknown) => Promise<unknown>) {
  const { entries } = checked('record', body)
  const screened = entries.map(allow)
  const accepted = screened.filter((entry): entry is RecordEntry => entry !== undefined)
  const results = accepted.length ? (await dispatch({ entries: accepted }) as RecordResponse).results : []
  let index = 0
  return { results: entries.map(({ type, key }, i) => screened[i] ? results[index++] : { type, key, ok: false, reason: 'FORBIDDEN' }) }
}

export async function limitedCall(owner: Extract<Owner, { role: 'limited' }>, name: CallName, body: any, dispatch: (input: unknown) => Promise<unknown>) {
  const grant = owner.calls[name]
  if (grant === undefined) throw forbidden()
  const kinds: true | readonly string[] = grant
  const author = `system:${owner.name}`
  if (name === 'record') {
    return filterRecord(body, entry => {
      if (kinds !== true && !kinds.includes(entry.type)) return undefined
      if (entry.type === 'call_update' && entry.change.kind === 'party' && entry.change.by !== author) return undefined
      return entry
    }, dispatch)
  }
  if (kinds !== true && !kinds.includes(name === 'decide' ? body?.action : body?.kind)) throw forbidden()
  if ((name === 'decide' || name === 'forget') && body?.by !== author) throw fault(FAULT_CODES.AUTH.FORBIDDEN, '`by` must match the service token owner')
  return dispatch(body)
}
