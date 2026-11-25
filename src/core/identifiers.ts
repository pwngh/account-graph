import { malformed } from '../contract/fault.ts'
import { createHash, createHmac } from 'node:crypto'
import type { Identifier } from '../contract/types.ts'

/** What no text may hold: a NUL, or half of a character. PostgreSQL refuses the first, and keeps every one of the second as the same replacement character, so two subjects would become one. */
export const UNSTORABLE = /[\0\p{Surrogate}]/u

/** Text somebody else made, with what cannot be kept left out, and no longer than that: a cut can leave half of a character. */
export const keepableText = (text: string, most: number): string => text.slice(0, most).replace(/[\0\p{Surrogate}]/gu, '')

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Normalizes an email the way Google matches it: trimmed and lowercased, and
 * for gmail.com and googlemail.com with dots and any `+suffix` removed.
 */
export function normalizeEmail(email: string): string {
  const clean = email.trim().toLowerCase()
  const at = clean.lastIndexOf('@')
  if (at <= 0 || at === clean.length - 1) throw malformed('Email must have the form "name@domain"')
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
  throw malformed('Phone must be a 10-digit number or start with "+" and a country code')
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
  if (groups.length !== 8) throw malformed(`"${address}" is not an IP address`)
  return `ip:${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** An identifier of any other kind. Trims the value; lowercases nothing. */
export function identifier(kind: string, value: string): Identifier {
  const clean = value.trim()
  if (!kind || !clean) throw malformed('An identifier requires a kind and a value')
  return `${kind}:${clean}`
}

/** Letters that are one letter with a mark to their readers, and letters of their own to Unicode. */
/** Letters that are Latin and have no simpler form of their own. */
export const FOLDED: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' }
/** The original name hash counts everyone who held that spelling and carries its mutes. A suffix says exactly which spelling passed the newer check. */
export const foldedNameKey = (id: Identifier): Identifier | undefined => /^(?:name|given|initial|named|ward|person|perhaps):[0-9a-f]{64}(?=$|~)/.exec(id)?.[0]
/** Only a spelling checked against the current missing-name list may give positive evidence. Older hashes still cap the evidence. */
export const CHECKED_NAME = '~3'
export const checkedNameKey = (id: Identifier) => id.includes(CHECKED_NAME + '.') || id.endsWith(CHECKED_NAME)

/** A fresh exact name has one spelling. Keep its older hash beside it for its fanout, mutes and comparison with old records. */
export function nameEvidence(identifiers: readonly Identifier[]): Identifier[] {
  const out = new Set<Identifier>()
  for (const id of identifiers) {
    if (/^birth:[0-9a-f]{64}(~placeholder|~missing)?$/.test(id)) {
      const birth = id.split('~')[0]!
      out.add(birth)
      if (id === birth) out.add(birth + '~2')
      else if (id.endsWith('~missing')) out.add(id)
      continue
    }
    const base = id.startsWith('name:') && foldedNameKey(id)
    if (base) out.add(base)
    out.add(base === id ? id + CHECKED_NAME : id)
  }
  return [...out]
}
/** What is written where a name is not known. */
const NOBODYS = new Set(['unknown', 'unk', 'none', 'null', 'undefined', 'na', 'n a', 'noname', 'no name', 'nobody', 'not given', 'not provided', 'not available', 'placeholder', 'test', 'tester', 'testing', 'dummy', 'firstname', 'first name', 'lastname', 'last name', 'caller', 'wireless caller', 'customer', 'client'])
// Spanish intake labels from lookups.ts and the Spanish and French missing-name forms reported by reviewers.
const MISSING = new Set(['desconocido', 'desconocida', 'sin nombre', 'no proporcionado', 'no proporcionada', 'no dio', 'no tiene', 'inconnu', 'inconnue', 'inconnu e'])
// Whole intake labels meaning unknown or name unknown. Compare the script's letters, including its vowel signs.
const UNKNOWN_NAME = new Set(['неизвестно', 'غير معروف', 'अज्ञात', '姓名不详', '氏名不詳'].map(label => normalizeName(label, true)))
const NEWBORN = new Set(['baby', 'baby boy', 'baby girl'])
const SAMPLES = new Set(['john doe', 'jane doe'])

/** The old folded spelling still sets the cap. An exact spelling also keeps marks that change the letters of a name. */
function normalizeName(name: string, exact = false): string {
  const decomposed = name.normalize('NFKD')
  const letters = (exact ? decomposed.replace(/(\p{L})(\p{M}+)/gu, (_, letter: string, marks: string) => {
    // Greek writes an iota under some vowels, and diaeresis distinguishes two adjacent vowels from a diphthong.
    if (/\p{Script=Greek}/u.test(letter)) return letter + marks.replace(/[^\u0345\u0308]/gu, '')
    // Latin accents and optional Arabic and Hebrew points keep their established comparison.
    if (/[\p{Script=Latin}\p{Script=Arabic}\p{Script=Hebrew}]/u.test(letter)) return letter + [...marks].filter(mark => /\p{Alphabetic}/u.test(mark) && !/\p{Diacritic}/u.test(mark)).join('')
    return letter + marks
  }) : decomposed.replace(/\p{M}/gu, '')).toLowerCase().replace(/[ßæœøđðłþı]/g, (letter) => FOLDED[letter]!)
  return letters.replace(/['’ʼ.]/g, '').replace(/[^\p{L}\p{M}]+/gu, ' ').trim()
}

/** The two parts of a name, or nothing for something written in place of a name. */
export function nameParts(first: string, last: string, previous = false): string[] | undefined {
  const name = [normalizeName(first), normalizeName(last)]
  if ([...name, name.join(' ')].some((part) => NOBODYS.has(part) || (!previous && MISSING.has(part))) || SAMPLES.has(name.join(' '))) return undefined
  if (!previous && (NEWBORN.has(name[0]!) || [first, last].some(field => /[^\u0000-\u007f]/u.test(field) && UNKNOWN_NAME.has(normalizeName(field, true))))) return undefined
  return name
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
  if (typeof secret !== 'string' || secret.length < 32) throw malformed('A name key requires a secret of at least 32 characters')
  if (typeof first !== 'string' || typeof last !== 'string') throw malformed('A name requires `first` and `last` as strings')
  const name = nameParts(first, last)
  // A single letter is an initial, except where a letter is a word of its own.
  if (!name || name.some((part) => !part || /^[a-z]$/.test(part))) return []
  const whole = [normalizeName(first, true), normalizeName(last, true)]
  const mac = (parts: string[]) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex')
  const key = (by: string, value: string): Identifier => {
    const base = 'name:' + mac([...name, by, value])
    return whole.some((part, i) => part !== name[i]) ? base + CHECKED_NAME + '.' + mac([...whole, by, value]) : base
  }
  const keys: Identifier[] = []
  const zip = /^(\d{5})(-?\d{4})?$/.exec(known.zip5?.trim() ?? '')?.[1]
  if (zip && zip !== '00000' && zip !== '99999') keys.push(key('zip', zip))
  const born = birthday(known.dob)
  if (born) keys.push(key('born', born))
  return keys
}

/** The key of a date of birth, by which two people are told apart. It links nothing, and is made with a secret because dates are few enough to guess. */
export function birthKey(secret: string, dob: string | undefined): Identifier | undefined {
  return birthKeys(secret, dob)[0]
}

/** That key, and those of its year and of its month and day. Two dates that share either are one slip of the pen apart. */
export function birthKeys(secret: string, dob: string | undefined): Identifier[] {
  if (typeof secret !== 'string' || secret.length < 32) throw malformed('A birth key requires a secret of at least 32 characters')
  const born = birthday(dob)
  if (!born) return []
  const key = (kind: string, value: string): Identifier => `${kind}:${createHmac('sha256', secret).update(JSON.stringify([kind, value])).digest('hex')}`
  return [key('birth', born), key('dated', born.slice(0, 4)), key('dated', born.slice(5))]
}

/** A date of birth that is one, or undefined: a date that systems write where none was given is nobody's birthday. */
function birthday(dob: string | undefined): string | undefined {
  const born = dob?.trim() ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(born) ? Date.parse(`${born}T00:00:00Z`) : NaN
  // Nobody living was born before 1905 or after today, and a system that has no date writes one of those, or one of these.
  return !Number.isNaN(day) && new Date(day).toISOString().slice(0, 10) === born && born > '1905' && day <= Date.now() && born !== '1970-01-01' ? born : undefined
}
