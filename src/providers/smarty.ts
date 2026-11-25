/**
 * Checks a United States postal address with Smarty and returns the one
 * delivery point it names, so two accounts that wrote the same address two
 * different ways are seen to share it.
 * https://www.smarty.com/docs/cloud/us-street-api
 */
import type { AddressVerifier, PostalAddress, VerifiedAddress } from '../core/ports.ts'
import { malformed } from '../contract/fault.ts'

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
    if (typeof address?.street !== 'string' || !address.street.trim()) throw malformed('An address requires a street')
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

export type { AddressVerifier, PostalAddress, VerifiedAddress }
export { addressIdentifier } from '../core/ports.ts'
