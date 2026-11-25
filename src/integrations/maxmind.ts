/**
 * Looks an address up with MaxMind, to learn whether it is one household's
 * or one that many people sit behind. A shared address is recorded but
 * never counts as evidence.
 * https://dev.maxmind.com/geoip/docs/web-services/
 */

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

export interface MaxMindOptions {
  accountId: string | number
  licenseKey: string
  /** `insights` returns the user type and anonymity flags. Defaults to `insights`. */
  service?: 'insights' | 'city' | 'country'
  /** `geolite.info` for a free GeoLite account, which has no Insights. Defaults to `geoip.maxmind.com`. */
  host?: 'geoip.maxmind.com' | 'geolite.info'
  /** How many answers to keep. Defaults to 10,000. Each is kept for a day. */
  cache?: number
  fetch?: typeof fetch
  now?: () => number
}

const DAY = 86_400_000
const FLAGS = ['is_anonymous', 'is_anonymous_vpn', 'is_public_proxy', 'is_residential_proxy', 'is_tor_exit_node']

function parse(body: any): IpInfo {
  // The flags moved from `traits` to `anonymizer`; older responses still carry them under `traits`.
  const flag = (name: string) => body?.anonymizer?.[name] === true || body?.traits?.[name] === true
  return {
    country: body?.country?.iso_code,
    asn: body?.traits?.autonomous_system_number,
    organization: body?.traits?.autonomous_system_organization,
    userType: body?.traits?.user_type,
    anonymous: FLAGS.some(flag),
    hosting: flag('is_hosting_provider'),
    ...(body?.subdivisions?.[0]?.iso_code && { region: body.subdivisions[0].iso_code }),
    ...(body?.city?.names?.en && { city: body.city.names.en }),
  }
}

/**
 * Returns a lookup backed by MaxMind's web service. It resolves to undefined
 * for a private or unknown address, and throws when the account is refused
 * or out of queries.
 */
export function createMaxMindLookup(options: MaxMindOptions): IpLookup {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const limit = options.cache ?? 10_000
  const base = `https://${options.host ?? 'geoip.maxmind.com'}/geoip/v2.1/${options.service ?? 'insights'}/`
  const authorization = `Basic ${Buffer.from(`${options.accountId}:${options.licenseKey}`).toString('base64')}`
  const cache = new Map<string, { info: IpInfo | undefined; until: number }>()

  return async (address) => {
    const hit = cache.get(address)
    if (hit && hit.until > now()) return hit.info

    const response = await fetcher(base + encodeURIComponent(address), { headers: { authorization, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    let info: IpInfo | undefined
    if (response.ok) info = parse(await response.json())
    else {
      const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string }
      const unknown = body.code === 'IP_ADDRESS_NOT_FOUND' || body.code === 'IP_ADDRESS_RESERVED'
      if (!unknown) throw new Error(`MaxMind rejected the lookup with ${response.status} ${body.code ?? ''}: ${body.error ?? ''}`)
    }

    if (cache.size >= limit) cache.delete(cache.keys().next().value!)
    cache.set(address, { info, until: now() + DAY })
    return info
  }
}

/** A MaxMind database opened with the `maxmind` package: anything with `get(address)`. */
export interface Reader {
  get(address: string): any
}

/**
 * Returns a lookup backed by local MaxMind databases, with no network call.
 * Pass the ASN database, the Anonymous IP database, or both.
 */
export function createDatabaseLookup(readers: { asn?: Reader; anonymous?: Reader }): IpLookup {
  return async (address) => {
    const asn = readers.asn?.get(address)
    const anonymous = readers.anonymous?.get(address)
    if (!asn && !anonymous) return undefined
    return { ...parse({ traits: { ...asn, ...anonymous } }), country: undefined }
  }
}

/**
 * Whether many unrelated people sit behind the address, so that sharing it
 * says nothing: a VPN, a proxy, a data center, a phone carrier, a campus,
 * an office. Only a residential or unclassified address counts as evidence.
 */
export function shared(info: IpInfo | undefined): boolean {
  if (!info) return false
  return info.anonymous || info.hosting || (info.userType !== undefined && info.userType !== 'residential')
}

/** Where an address places a visit, written `US/FL/Miami`, or undefined when not even the country is known. */
export function placeOf(info: IpInfo | undefined): string | undefined {
  if (!info?.country) return undefined
  return [info.country, info.region, info.city].filter(Boolean).join('/')
}
