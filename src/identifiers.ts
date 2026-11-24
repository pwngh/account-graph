import { createHash, createHmac } from 'node:crypto'
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
  if (at <= 0 || at === clean.length - 1) throw new TypeError('Email must have the form "name@domain"')
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
  if (!kind || !clean) throw new TypeError('An identifier requires a kind and a value')
  return `${kind}:${clean}`
}

/** Letters that are one letter with a mark to their readers, and letters of their own to Unicode. */
const FOLDED: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' }
/** What is written where a name is not known. */
const NOBODYS = new Set(['unknown', 'unk', 'none', 'null', 'undefined', 'na', 'n a', 'noname', 'no name', 'nobody', 'not given', 'not provided', 'not available', 'placeholder', 'test', 'tester', 'testing', 'dummy', 'firstname', 'first name', 'lastname', 'last name', 'caller', 'wireless caller', 'customer', 'client'])
const SAMPLES = new Set(['john doe', 'jane doe'])

/** A name as it is compared: without case, accents or punctuation. */
function normalizeName(name: string): string {
  const letters = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[ßæœøđðłþı]/g, (letter) => FOLDED[letter]!)
  return letters.replace(/['’ʼ.]/g, '').replace(/[^\p{L}]+/gu, ' ').trim()
}

/**
 * Name identifiers: one for the name with a zip code, one for the name with a
 * date of birth, whichever are known. A name alone is nobody's, so with
 * neither there is none, and none for a placeholder such as "Unknown". The
 * keys are made with a secret, because names are few enough to guess: a plain
 * hash could be reversed by hashing them all. Give the policy a `name` kind
 * that only corroborates, as `examples/household.json` does.
 */
export function nameKeys(secret: string, first: string, last: string, known: { zip5?: string | undefined; dob?: string | undefined }): Identifier[] {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('A name key requires a secret of at least 32 characters')
  if (typeof first !== 'string' || typeof last !== 'string') throw new TypeError('A name requires `first` and `last` as strings')
  const name = [normalizeName(first), normalizeName(last)]
  // A single letter is an initial, except where a letter is a word of its own.
  if (name.some((part) => !part || /^[a-z]$/.test(part) || NOBODYS.has(part)) || NOBODYS.has(name.join(' ')) || SAMPLES.has(name.join(' '))) return []
  const key = (by: string, value: string): Identifier => `name:${createHmac('sha256', secret).update(JSON.stringify([...name, by, value])).digest('hex')}`
  const keys: Identifier[] = []
  const zip = /^(\d{5})(-?\d{4})?$/.exec(known.zip5?.trim() ?? '')?.[1]
  if (zip && zip !== '00000' && zip !== '99999') keys.push(key('zip', zip))
  const born = birthday(known.dob)
  if (born) keys.push(key('born', born))
  return keys
}

/** The key of a date of birth, by which two people are told apart. It links nothing, and is made with a secret because dates are few enough to guess. */
export function birthKey(secret: string, dob: string | undefined): Identifier | undefined {
  if (typeof secret !== 'string' || secret.length < 32) throw new TypeError('A birth key requires a secret of at least 32 characters')
  const born = birthday(dob)
  return born && `birth:${createHmac('sha256', secret).update(JSON.stringify(['birth', born])).digest('hex')}`
}

/** A date of birth that is one, or undefined: a date that systems write where none was given is nobody's birthday. */
function birthday(dob: string | undefined): string | undefined {
  const born = dob?.trim() ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(born) ? Date.parse(`${born}T00:00:00Z`) : NaN
  return !Number.isNaN(day) && new Date(day).toISOString().slice(0, 10) === born && !['1900-01-01', '1970-01-01'].includes(born) ? born : undefined
}
