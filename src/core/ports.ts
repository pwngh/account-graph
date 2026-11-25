/** What the graph asks of the services that check things for it. Each is optional, and none is imported from here. */
import { createHash } from 'node:crypto'
import type { Identifier } from '../contract/types.ts'

export interface IpInfo {
  /** ISO 3166-1 country code. */
  country: string | undefined
  /** Autonomous system number. */
  asn: number | undefined
  organization: string | undefined
  /** MaxMind's guess at who uses the address: `residential`, `cellular`, `hosting`, `business`. Insights only. */
  userType: string | undefined
  /** A VPN, proxy, or Tor exit. */
  anonymous: boolean
  /** A data center. */
  hosting: boolean
  /** The state or province's ISO code, and the city, when the service gives them. */
  region?: string
  city?: string
}

export type IpLookup = (address: string) => Promise<IpInfo | undefined>

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

/** What kind of line a phone number is, from Twilio Lookup. */
export interface LineType {
  /** `mobile`, `landline`, `fixedVoip`, `nonFixedVoip`, `tollFree`, `personal`, `premium`, `sharedCost`, `uan`, `voicemail`, `pager`, or `unknown`. */
  type: string
  carrier: string | undefined
}

export type LineTypeLookup = (number: string) => Promise<LineType | undefined>

export interface VerifiedFingerprint {
  visitorId: string
  eventId: string
  /** Fingerprint's own confidence in the visitor id, 0 to 1. */
  confidence: number
  /** When the identification happened, in epoch milliseconds. */
  at: number
  /** The address Fingerprint saw the browser at. */
  ip: string | undefined
  incognito?: boolean
  bot?: 'not_detected' | 'good' | 'bad'
  vpn?: boolean
  proxy?: boolean
  /** The browser was altered to change its fingerprint. */
  tampering?: boolean
}

export type FingerprintVerifier = (eventId: string) => Promise<VerifiedFingerprint | undefined>

/**
 * The identifier for a checked address, or undefined when the address
 * should tie nobody: one the postal service has not confirmed down to the
 * apartment, a rented mail box, or a vacant one. Only a hash is kept.
 */
export function addressIdentifier(address: VerifiedAddress): Identifier | undefined {
  if (address.match !== 'Y' || address.mailDrop || address.vacant) return undefined
  return `address:${createHash('sha256').update(address.barcode).digest('hex')}`
}
