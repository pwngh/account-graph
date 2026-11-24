/**
 * Checks a United States postal address with Smarty and returns the one
 * delivery point it names, so two accounts that wrote the same address two
 * different ways are seen to share it.
 * https://www.smarty.com/docs/cloud/us-street-api
 */
import { createHash } from 'node:crypto'
import type { Identifier } from '../types.ts'

export interface PostalAddress {
  /** The street line, or the whole address on one line. */
  street: string
  street2?: string
  /** Apartment, suite or unit. */
  secondary?: string
  city?: string
  state?: string
  zipcode?: string
}

export interface VerifiedAddress {
  /** The postal service's code for this one delivery point. */
  barcode: string
  line1: string
  lastLine: string
  /**
   * How well the postal service knows it: `Y` the whole address is confirmed;
   * `S` the building is, but not the apartment given; `D` the building is, and
   * an apartment is missing; `N` or empty, not confirmed.
   */
  match: string
  /** A home rather than a business, when the postal service says. */
  residential: boolean | undefined
  /** A mail-receiving business: a rented box that many strangers share. */
  mailDrop: boolean
  vacant: boolean
}

export type AddressVerifier = (address: PostalAddress) => Promise<VerifiedAddress | undefined>

export interface SmartyOptions {
  /** A secret key's id and token, from the API keys page of your Smarty account. Never ship them to a browser. */
  authId: string
  authToken: string
  fetch?: typeof fetch
}

/**
 * Returns a function that checks an address. It resolves to undefined when
 * the postal service does not know the address, and throws when the key is
 * refused, the subscription has run out, or the service fails.
 */
export function createAddressVerifier(options: SmartyOptions): AddressVerifier {
  const fetcher = options.fetch ?? fetch
  const authorization = `Basic ${Buffer.from(`${options.authId}:${options.authToken}`).toString('base64')}`
  return async (address) => {
    if (typeof address?.street !== 'string' || !address.street.trim()) throw new TypeError('An address requires a street')
    const url = new URL('https://us-street.api.smarty.com/street-address')
    for (const name of ['street', 'street2', 'secondary', 'city', 'state', 'zipcode'] as const) {
      const value = address[name]
      if (typeof value === 'string' && value.trim()) url.searchParams.set(name, value.trim().slice(0, 100))
    }
    url.searchParams.set('candidates', '1')
    const response = await fetcher(url.href, { headers: { authorization, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Smarty rejected the address check with ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const answer = (await response.json()) as unknown
    const found = Array.isArray(answer) ? answer[0] : undefined
    if (!found?.delivery_point_barcode) return undefined
    const rdi = found.metadata?.rdi
    return {
      barcode: String(found.delivery_point_barcode),
      line1: found.delivery_line_1 ?? '',
      lastLine: found.last_line ?? '',
      match: found.analysis?.dpv_match_code ?? '',
      residential: rdi === 'Residential' ? true : rdi === 'Commercial' ? false : undefined,
      mailDrop: found.analysis?.dpv_cmra === 'Y',
      vacant: found.analysis?.dpv_vacant === 'Y',
    }
  }
}

/**
 * The identifier for a checked address, or undefined when the address
 * should tie nobody: one the postal service has not confirmed down to the
 * apartment, a rented mail box, or a vacant one. Only a hash is kept.
 */
export function addressIdentifier(address: VerifiedAddress): Identifier | undefined {
  if (address.match !== 'Y' || address.mailDrop || address.vacant) return undefined
  return `address:${createHash('sha256').update(address.barcode).digest('hex')}`
}
