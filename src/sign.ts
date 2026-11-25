import { malformed } from './contract/fault.ts'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { ip } from './identifiers.ts'
import type { Subject } from './types.ts'

const DAY = 86_400_000
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url')

/** The signature over one purpose, payload and expiry: 16 bytes, which is short enough for a text message and long enough not to guess. */
function signature(secret: string, purpose: string, payload: string, expires: number): string {
  return createHmac('sha256', secret).update(`${purpose}\n${payload}\n${expires}`).digest().subarray(0, 16).toString('base64url')
}

/** What the change webhook sends to say a body came from this server: `t=<epoch ms>,v1=<HMAC-SHA256 of "<t>.<body>" in hex>`. */
export function bodySignature(secret: string, at: number, body: string): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
}

/**
 * A short token that carries `payload` until `expires` and cannot be forged
 * or altered without the secret. The payload is readable by anyone who holds
 * the token; it is signed, not hidden. `purpose` keeps a token made for one
 * use from being accepted for another.
 */
export function signToken(secret: string, purpose: string, payload: string, expires: number): string {
  if (!secret) throw malformed('Signing requires a secret')
  return `${encode(payload)}.${Math.floor(expires / 1000).toString(36)}.${signature(secret, purpose, payload, Math.floor(expires / 1000))}`
}

/** The payload of a token made by `signToken` for the same purpose, or undefined when it is forged, altered, or past its expiry. */
export function readToken(secret: string, purpose: string, token: unknown, now: number): string | undefined {
  if (typeof token !== 'string' || token.length > 1024) return undefined
  const [body, until, signed, ...rest] = token.split('.')
  if (!body || !until || !signed || rest.length > 0 || !/^[0-9a-z]+$/.test(until)) return undefined
  const expires = Number.parseInt(until, 36)
  const payload = Buffer.from(body, 'base64url').toString('utf8')
  // One token, one spelling: a body that does not encode back to itself was not written by `signToken`.
  if (encode(payload) !== body) return undefined
  const expected = Buffer.from(signature(secret, purpose, payload, expires))
  const given = Buffer.from(signed)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
  return expires * 1000 > now ? payload : undefined
}

function addressOf(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw malformed('A link requires a complete address, such as https://example.org/offer')
  }
}

export interface KnownLinkOptions {
  /** The secret the server reads links with: `LINK_SECRET`. */
  secret: string
  /** How long the link names its person, in milliseconds. Defaults to 30 days; at most 366. */
  lasts?: number
  /** The id it is kept under, so its opening is noted. Without one, only the browser that opens it is. */
  id?: string
  now?: () => number
}

/**
 * An address that names the person it was sent to. Put it in an email or a
 * text message to one person; when they open it, the script tag tells the
 * server, and the browser that opened it is tied to that person.
 */
export function knownLink(url: string, subject: Subject, options: KnownLinkOptions): string {
  if (typeof subject !== 'string' || !subject || subject !== subject.trim() || Buffer.byteLength(subject) > 512) {
    throw malformed('A link requires the subject it is for, in 512 bytes or fewer, with no space around it')
  }
  const address = addressOf(url)
  if (address.protocol !== 'https:' && address.protocol !== 'http:') throw malformed('A link must use http or https')
  const lasts = options.lasts ?? 30 * DAY
  if (!(lasts > 0 && lasts <= 366 * DAY)) throw malformed('A link must last more than zero and at most 366 days')
  const now = (options.now ?? Date.now)()
  address.searchParams.set('ag', options.id === undefined ? signToken(options.secret, 'known', subject, now + lasts) : signToken(options.secret, 'sent', `${options.id}\n${subject}`, now + lasts))
  return address.href
}

export interface StaffLinkOptions {
  /** The secret the server reads marks with: `LINK_SECRET`. */
  secret: string
  /** How long it works, and how long a browser it marked stays marked, in milliseconds from now. Defaults to 90 days; at most 366. */
  lasts?: number
  now?: () => number
}

/**
 * An address that marks the browser that opens it as a member of staff, so
 * its visits are not recorded. `ag_staff=off` on any page of the site
 * removes the mark.
 */
export function staffLink(url: string, options: StaffLinkOptions): string {
  const address = addressOf(url)
  // The mark is kept in a Secure cookie, which a browser only takes over HTTPS, or from this machine.
  const local = address.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/.test(address.hostname)
  if (address.protocol !== 'https:' && !local) throw malformed('A staff link must use https')
  const lasts = options.lasts ?? 90 * DAY
  if (!(lasts > 0 && lasts <= 366 * DAY)) throw malformed('A mark must last more than zero and at most 366 days')
  address.searchParams.set('ag_staff', signToken(options.secret, 'staff', 'staff', (options.now ?? Date.now)() + lasts))
  return address.href
}

/** What ties a carry token to the browser it was made for: the same browser on the same network, without keeping either. */
export function browserMark(userAgent: string | undefined, address: string): string {
  let network = address
  try {
    network = ip(address)
  } catch {}
  return createHash('sha256').update(`${userAgent ?? ''}\n${network}`).digest('base64url').slice(0, 16)
}
