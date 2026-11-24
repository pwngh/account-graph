import type { Touch } from './types.ts'

/** Facts about an outcome or a call, by name: `{ office_served: 'north', language: 'es' }`. */
export type Tags = Record<string, string>

/** Where nothing was recorded. Always a line of its own, never folded into another and never left out. */
export const NOT_RECORDED = '(not recorded)'

/** How a dimension's own name may be written. */
export const DIMENSION = /^[\w.-]{1,64}$/

/** Tags checked and copied, or undefined for none. Throws when they are not a few short codes. */
export function checkTags(given: unknown, what: string): Tags | undefined {
  if (given === undefined || given === null) return undefined
  if (typeof given !== 'object' || Array.isArray(given)) throw new TypeError(`${what} needs its tags as an object, such as {"language":"es"}`)
  const entries = Object.entries(given)
  if (entries.length > 8) throw new TypeError(`${what} has more than 8 tags`)
  for (const [name, value] of entries) {
    if (!/^[a-z_]{1,32}$/.test(name)) throw new TypeError(`${what} has a tag named "${name}"; a name is lowercase letters and underscores, at most 32`)
    if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new TypeError(`${what} needs its tag "${name}" as text of at most 64 characters`)
    // It would read as a value that was never recorded.
    if (value.trim() === NOT_RECORDED) throw new TypeError(`${what} cannot have "${NOT_RECORDED}" as its tag "${name}"; leave the tag out`)
  }
  return entries.length > 0 ? Object.fromEntries(entries.map(([name, value]) => [name, value.trim()])) : undefined
}

/** Names an arrival may carry a documented code under, the first one present winning: what fits in an ad's address is shorter. */
const WRITTEN: Record<string, readonly string[]> = { office_advertised: ['office_advertised', 'office'], language: ['language', 'lang'] }
const READ = new Map(Object.entries(WRITTEN).flatMap(([name, written]) => written.map((each) => [each, name])))

/** What an arrival says of a dimension, from the parameters of your own that it carried. */
export function touchTag(touch: Touch | undefined, name: string): string | undefined {
  const custom = touch?.custom
  for (const written of Object.hasOwn(WRITTEN, name) ? WRITTEN[name]! : [name]) if (custom && Object.hasOwn(custom, written) && custom[written]) return custom[written]
  return undefined
}

/** The dimensions an arrival has something to say of, of those that can be asked for. */
export const touchTags = (touch: Touch | undefined): string[] => [...new Set(Object.keys(touch?.custom ?? {}).filter((name) => DIMENSION.test(name)).map((name) => READ.get(name) ?? name))]
