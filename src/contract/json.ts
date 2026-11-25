import { FAULT_CODES, fault, malformed } from './fault.ts'

/** Text a database cannot keep: a NUL, or half of a character. */
const UNSTORABLE = /[\0\p{Surrogate}]/u
const LEVELS = 32
export const LARGEST = 1_000_000

/**
 * A copy of a value, if it is the same value once written as JSON and read
 * again. `NaN`, a `Date`, a `bigint` and the like would each come out as
 * something else, so they are refused. Both sides of a call go through this,
 * and so get the same answer. Fields that are undefined are left out.
 */
export function plain<T>(value: T, path = 'request', level = 0): T {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (UNSTORABLE.test(value)) throw malformed(`${path} contains unsupported characters`, { path })
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw malformed(`${path} must be a finite number`, { path })
    return (value === 0 ? 0 : value) as T
  }
  if (typeof value !== 'object') throw malformed(`${path} cannot be written as JSON`, { path })
  if (level >= LEVELS) throw malformed(`${path} exceeds ${LEVELS} levels of nesting`, { path })
  if (Array.isArray(value)) return Array.from(value, (each, i) => plain(each, `${path}[${i}]`, level + 1)) as T
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) throw malformed(`${path} must be a plain object`, { path })
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, each]) => {
      if (each === undefined) return []
      if (UNSTORABLE.test(key) || key === '__proto__') throw malformed(`${path} has an unsupported field`, { path })
      return [[key, plain(each, `${path}.${key}`, level + 1)]]
    }),
  ) as T
}

/** As plain, and no larger than a request may be. */
export function sized<T>(value: T): T {
  const copy = plain(value)
  if (new TextEncoder().encode(JSON.stringify(copy)).length > LARGEST) throw fault(FAULT_CODES.INPUT.TOO_LARGE, 'Request exceeds 1 MB')
  return copy
}

/** One text for one value: keys in order, and no others ways to write it. Takes what `plain` gives. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, each]) => each !== undefined).sort(([x], [y]) => (x < y ? -1 : 1))
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
