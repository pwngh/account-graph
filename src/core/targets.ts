/** The numbers you set yourself to meet. The reviewer screen shows each beside what was reached, as set by you, and nothing else rests on them. */
export interface Targets {
  /** The share of calls to you that a person should answer, from 0 to 1. */
  readonly answered?: number
  /** The share of missed calls whose caller should be reached, from 0 to 1. */
  readonly returned?: number
  /** How many hours by the clock a missed caller may wait to be reached. */
  readonly callbackHours?: number
  /** What an outcome may cost, in the currency of your costs. */
  readonly costPerOutcome?: number
  /** What should come back of each unit spent: 3 is three times the cost. */
  readonly roas?: number
}

const SHARES = new Set(['answered', 'returned'])
const NAMES = [...SHARES, 'callbackHours', 'costPerOutcome', 'roas']

/** What is wrong with targets read from a setting, one line each. */
export function targetProblems(given: unknown): string[] {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return ['must be an object, such as {"answered":0.9}']
  return Object.entries(given).flatMap(([name, value]) => {
    if (!NAMES.includes(name)) return [`"${name}" is not one of ${NAMES.join(', ')}`]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return [`"${name}" must be a number above 0`]
    // Nine tenths is 0.9. Somebody who writes 90 means that, and would never be told they had met it.
    if (SHARES.has(name) && value > 1) return [`"${name}" must be a share from 0 to 1, such as 0.9`]
    return []
  })
}
