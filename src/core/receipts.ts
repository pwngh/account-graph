import { createHash, createHmac } from 'node:crypto'
import type { DecideRequest, ForgetRequest, RecordEntry } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'
import { canonical } from '../contract/json.ts'
import { callerNumber, numberOrSelf } from './calls.ts'
import { normalizeEmail } from './identifiers.ts'

/** What is written of a key that was used. Neither the key nor what came with it is in here: each is a hash only the secret can make. */
export interface Receipt {
  type: string
  mac: string
  secretId: string
  /** A hash of each field that must be the same when the key comes again. Null once its subject was forgotten. */
  digest: Record<string, string> | null
  version: number
  /** What it is about, where that is another entry. */
  ref?: { type: string; mac: string }
  /** What a deletion found had reached a platform. It names no person. */
  sent?: unknown
  at: number
  recorded: number
  forgotten?: number
}

/** The country is in it: with another, the same digits are another number, and the two are not compared. */
const versionOf = (country: string) => 10_000 + Number(country)
const secretId = (secret: string) => createHmac('sha256', secret).update('receipt secret id').digest('hex').slice(0, 12)

const phoneOf = (country: string) => (value: string) => numberOrSelf(value, country)
const email = (value: string) => {
  try {
    return normalizeEmail(value)
  } catch {
    return value.trim().toLowerCase()
  }
}
const sorted = <T>(list: readonly T[]) => [...list].map(canonical).sort()
const facts = (value: any, phone: (value: string) => string) => ({ ...value, ...(value.email && { email: email(value.email) }), ...(value.phone && { phone: phone(value.phone) }), ...(value.identifiers && { identifiers: [...new Set(value.identifiers)].sort() }) })
const pair = ({ a, b }: any) => (a < b ? { a, b } : { a: b, b: a })

/** The fields of an entry that make it the same one, each written one way. What a second reporter may know better, or a provider makes up on each try, is not among them. */
export function compared(entry: RecordEntry | ({ type: 'decide' } & DecideRequest) | ({ type: 'forget' } & ForgetRequest), country = '1'): Record<string, unknown> {
  const phone = phoneOf(country)
  const { type, key: _, ...fields } = entry as any
  if (type === 'call') {
    const from = fields.direction === 'outbound' ? fields.from && phone(fields.from) : callerNumber(fields.from, country)
    return { direction: fields.direction, to: phone(fields.to), ...(from && { from }) }
  }
  if (type === 'text') return { direction: fields.direction, from: phone(fields.from), to: phone(fields.to) }
  if (type === 'cost') return { at: fields.at, rows: sorted(fields.rows.map((row: any) => ({ ...row, currency: row.currency.toUpperCase() }))) }
  if (type === 'decide') return { at: fields.at, by: fields.by, action: fields.action, ...(fields.pairs ? { pairs: sorted(fields.pairs.map(pair)) } : { fact: facts(fields.fact, phone) }) }
  if (type === 'forget') return { at: fields.at, by: fields.by, subjects: [...new Set(fields.subjects)].sort(), platforms: fields.platforms }
  return {
    ...fields,
    ...(fields.facts && { facts: facts(fields.facts, phone) }),
    ...(fields.email && { email: email(fields.email) }),
    ...(type === 'conversion' && fields.phone && { phone: phone(fields.phone) }),
    ...(fields.currency && { currency: fields.currency.toUpperCase() }),
    ...(fields.change?.currency && { change: { ...fields.change, currency: fields.change.currency.toUpperCase() } }),
  }
}

export interface Receipts {
  /** The hash of a key, and every hash it may have been written under. */
  mac(type: string, key: string): { mac: string; secretId: string; all: string[] }
  make(entry: Parameters<typeof compared>[0], recorded: number, ref?: { type: string; key: string }): Receipt
  /** The fields that differ from those the key was used with, or undefined where they cannot be compared. */
  differs(receipt: Receipt, entry: Parameters<typeof compared>[0]): string[] | undefined
  /** Throws where something is stored that none of these secrets made. */
  covers(ids: readonly string[]): void
}

export function createReceipts(secrets: readonly string[], country = '1'): Receipts {
  const VERSION = versionOf(country)
  if (secrets.length === 0 || secrets.some((secret) => typeof secret !== 'string' || secret.length < 32)) throw fault(FAULT_CODES.CONFIG.INVALID, '`receiptSecrets` requires at least one secret of 32 characters or more')
  const known = secrets.map((secret) => ({ id: secretId(secret), secret }))
  const macBy = (secret: string, type: string, key: string) => createHmac('sha256', secret).update(`${type}\0${key}`).digest('hex')
  const digest = (secret: string, entry: Parameters<typeof compared>[0]) =>
    Object.fromEntries(Object.entries(compared(entry, country)).filter(([, value]) => value !== undefined).map(([name, value]) => [name, createHmac('sha256', secret).update(`${name}\0${canonical(value)}`).digest('base64url').slice(0, 22)]))
  const mac: Receipts['mac'] = (type, key) => ({ mac: macBy(known[0]!.secret, type, key), secretId: known[0]!.id, all: known.map(({ secret }) => macBy(secret, type, key)) })
  return {
    mac,
    make(entry, recorded, ref) {
      const own = mac(entry.type, entry.key)
      return { type: entry.type, mac: own.mac, secretId: own.secretId, digest: digest(known[0]!.secret, entry), version: VERSION, at: entry.at, recorded, ...(ref && { ref: { type: ref.type, mac: mac(ref.type, ref.key).mac } }) }
    },
    differs(receipt, entry) {
      const by = known.find(({ id }) => id === receipt.secretId)
      if (!by || !receipt.digest || receipt.version !== VERSION) return undefined
      const now = digest(by.secret, entry)
      const names = [...new Set([...Object.keys(now), ...Object.keys(receipt.digest)])]
      // A caller who hid their number to one reporter may be known to another.
      return names.filter((name) => now[name] !== receipt.digest![name] && !(entry.type === 'call' && name === 'from' && (now.from === undefined || receipt.digest!.from === undefined))).sort()
    },
    covers(ids) {
      const missing = ids.filter((id) => !known.some((each) => each.id === id))
      if (missing.length > 0) throw fault(FAULT_CODES.CONFIG.MISMATCH, 'A receipt secret that stored receipts were made with is missing from `receiptSecrets`')
    },
  }
}

/** A mark that two processes hold the same secret, which says nothing of it. */
export const secretMark = (secret: string | undefined): string => (secret === undefined ? 'none' : createHash('sha256').update(createHmac('sha256', secret).update('account-graph setting').digest()).digest('hex').slice(0, 24))
