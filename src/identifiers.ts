import { createHash } from 'node:crypto'
import type { Identifier } from './types.ts'

/** What no text may hold: a NUL, or half of a character. PostgreSQL refuses the first, and keeps every one of the second as the same replacement character, so two subjects would become one. */
export const UNSTORABLE = /[\0\p{Surrogate}]/u

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Normalizes an email the way Google matches it: trimmed and lowercased, and
 * for gmail.com and googlemail.com with dots and any `+suffix` removed.
 */
export function normalizeEmail(email: string): string {
  const clean = email.trim().toLowerCase()
  const at = clean.lastIndexOf('@')
  if (at <= 0 || at === clean.length - 1) throw new TypeError('Email must be written "name@domain"')
  const domain = clean.slice(at + 1)
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return clean
  return `${clean.slice(0, at).split('+')[0]!.replaceAll('.', '')}@${domain}`
}

/** Normalizes a phone number to E.164. A 10-digit number takes `country`, which defaults to 1. */
export function normalizePhone(phone: string, country = '1'): string {
  const digits = phone.replace(/\D/g, '')
  if (phone.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`
  if (digits.length === 10) return `+${country}${digits}`
  if (digits.length === 11 && digits.startsWith(country)) return `+${digits}`
  throw new TypeError('Phone must be a 10-digit number or start with "+" and a country code')
}

/** SHA-256 of the normalized email, in hex. The same value Google accepts as a match key. */
export function hashEmail(email: string): string {
  return sha256(normalizeEmail(email))
}

/** SHA-256 of the E.164 phone number, in hex. */
export function hashPhone(phone: string, country?: string): string {
  return sha256(normalizePhone(phone, country))
}

/** An email identifier. Only the hash is kept. */
export function email(value: string): Identifier {
  return `email:${hashEmail(value)}`
}

/** A phone identifier. Only the hash is kept. */
export function phone(value: string, country?: string): Identifier {
  return `phone:${hashPhone(value, country)}`
}

/** Lines that belong to no one person: a switchboard, a paid service, a pager. */
const NOBODY = new Set(['tollFree', 'premium', 'sharedCost', 'uan', 'voicemail', 'pager'])

/**
 * A phone identifier that takes the kind of line into account. A number
 * from an internet calling app that anyone can get in a minute is recorded
 * as the weaker `voip` kind, and a line that belongs to no one person ties
 * nobody, so it gets no identifier. `type` is what a carrier lookup says:
 * `mobile`, `landline`, `nonFixedVoip`, `tollFree`. Without one, it is a plain phone.
 */
export function phoneOfType(value: string, type?: string, country?: string): Identifier | undefined {
  if (type !== undefined && NOBODY.has(type)) return undefined
  return `${type === 'nonFixedVoip' ? 'voip' : 'phone'}:${hashPhone(value, country)}`
}

/**
 * An IP identifier. An IPv6 address keeps its /64 prefix, because one device
 * rotates through many addresses inside it.
 */
export function ip(address: string): Identifier {
  const clean = address.trim().toLowerCase().replace(/^::ffff:(?=\d+\.)/, '')
  if (!clean.includes(':')) return `ip:${clean}`
  const [head = '', tail = ''] = clean.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = clean.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  if (groups.length !== 8) throw new TypeError(`"${address}" is not an IP address`)
  return `ip:${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** An identifier of any other kind. Trims the value; lowercases nothing. */
export function identifier(kind: string, value: string): Identifier {
  const clean = value.trim()
  if (!kind || !clean) throw new TypeError('An identifier needs a kind and a value')
  return `${kind}:${clean}`
}
