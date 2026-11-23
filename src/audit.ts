import { createHash } from 'node:crypto'
import type { Decision } from './types.ts'

/** The hash that seals a decision to the one before it. Changing or removing an earlier entry changes every later hash. */
export function seal(previous: string, decision: Omit<Decision, 'hash'>): string {
  const { seq, at, action, about, by, reason } = decision
  return createHash('sha256')
    .update(`${previous}\n${JSON.stringify([seq, at, action, about, by ?? null, reason ?? null])}`)
    .digest('hex')
}

/**
 * Checks that a list of decisions is whole and unaltered. Returns the
 * sequence number of the first entry that does not fit, or undefined when
 * every entry does.
 */
export function brokenAt(decisions: readonly Decision[]): number | undefined {
  let previous = ''
  let expected = 1
  for (const decision of decisions) {
    if (decision.seq !== expected || decision.hash !== seal(previous, decision)) return decision.seq
    previous = decision.hash
    expected += 1
  }
  return undefined
}
