import type { Edge, Identifier, IdentifierState, Reason } from './types.ts'

export interface Rule {
  /** Probability two subjects are one person when they alone share one identifier of this kind. */
  weight: number
  /** How fast evidence thins as more subjects share it: `weight * (2 / fanout) ** dilution`. */
  dilution: number
  /** Past this many subjects the identifier is public and links nothing. */
  cap: number
  /** Evidence halves for each half-life between the two subjects' sightings. */
  halfLife: number
}

export interface Policy {
  /** At or above this score two subjects join one cluster. */
  same: number
  /** At or above this score two subjects are reported as linked. */
  related: number
  /** A single link below this score cannot be the only thing joining two groups. At or below `same`, the rule is off. */
  bridge: number
  /** A cluster with more members than this is flagged for review. */
  review: number
  kinds: Readonly<Record<string, Rule>>
}

const DAY = 86_400_000

/**
 * Default weights. The fingerprint, canvas, and address rows are set from how
 * these identifiers behave in production, where the person behind each
 * sighting was known:
 *
 * - A verified vendor fingerprint belongs to one person about 98% of the
 *   time. The next sighting is the same person 98% of the time within 30
 *   days, 95% at 31 to 90 days, and 86% past 90.
 * - A home-made canvas and user-agent hash belongs to one person about half
 *   the time: 55% within a week, 23% at 31 to 90 days, 7% past 90.
 * - An address shared by exactly two people points at the same one about 42%
 *   of the time, and by three to five people about 9%. It holds for a day
 *   (89%) and is mostly gone in a month (37%).
 * - A handful of fingerprints are each shared by more than twenty people,
 *   and under 2% of the pairs they produce are one person. Hence the caps.
 *
 * Other rows are priors. Measure your own traffic with `measure` or `fit`,
 * set the weights, and call `rebuild`.
 */
export const defaultPolicy: Policy = {
  same: 0.9,
  related: 0.5,
  bridge: 0.97,
  review: 50,
  kinds: {
    // A reviewer's decision that two subjects are one person. `join` writes it.
    review: { weight: 1, dilution: 0, cap: 100, halfLife: Infinity },
    // A passkey's credential id, after your server verified the sign-in. Bound to one device or one person's keychain.
    passkey: { weight: 0.99, dilution: 0, cap: 5, halfLife: Infinity },
    email: { weight: 0.99, dilution: 0, cap: 25, halfLife: Infinity },
    phone: { weight: 0.9, dilution: 0, cap: 25, halfLife: Infinity },
    payment: { weight: 0.97, dilution: 0, cap: 10, halfLife: Infinity },
    // A first-party cookie or install id your own code set.
    device: { weight: 0.98, dilution: 0, cap: 10, halfLife: Infinity },
    ga: { weight: 0.9, dilution: 0, cap: 10, halfLife: Infinity },
    // A machine id reported by your desktop client. The client can lie, so it stays below a verified id.
    hardware: { weight: 0.95, dilution: 0.5, cap: 10, halfLife: Infinity },
    // A vendor visitor id your server confirmed with the vendor.
    fingerprint: { weight: 0.97, dilution: 1, cap: 20, halfLife: 720 * DAY },
    // Any hash computed in the browser and reported unverified, open-source FingerprintJS included.
    canvas: { weight: 0.5, dilution: 1, cap: 20, halfLife: 45 * DAY },
    ip: { weight: 0.3, dilution: 2, cap: 10, halfLife: 14 * DAY },
    // A link sent to one person and opened in this browser. Two people's links opened in one browser thin each other out.
    link: { weight: 0.92, dilution: 1, cap: 5, halfLife: Infinity },
    // A phone call that began moments after exactly one visitor tapped its number on your site. `recordCall` writes it.
    dial: { weight: 0.92, dilution: 0, cap: 2, halfLife: Infinity },
    // A note, not evidence: the number a visitor tapped, or a call that was recorded. It links nothing.
    dialed: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
  },
}

export function ruleFor(policy: Policy, identifier: Identifier): Rule {
  const colon = identifier.indexOf(':')
  if (colon <= 0 || colon === identifier.length - 1) {
    throw new TypeError(`Identifier "${identifier}" must be written "kind:value"`)
  }
  const rule = policy.kinds[identifier.slice(0, colon)]
  if (!rule) throw new TypeError(`Identifier "${identifier}" has a kind the policy does not name`)
  return rule
}

/** Whether an identifier can link subjects at all. */
export function usable(policy: Policy, identifier: Identifier, state: IdentifierState | undefined): boolean {
  return state !== undefined && !state.ignored && state.fanout <= ruleFor(policy, identifier).cap
}

/** The evidence one shared identifier gives that the subjects of `a` and `b` are one person. */
export function evidence(policy: Policy, a: Edge, b: Edge, fanout: number): Reason {
  const rule = ruleFor(policy, a.identifier)
  const gap = Math.max(0, Math.max(a.first, b.first) - Math.min(a.last, b.last))
  const thinned = rule.weight * (2 / Math.max(2, fanout)) ** rule.dilution
  return { identifier: a.identifier, evidence: thinned * 0.5 ** (gap / rule.halfLife), fanout, gap }
}

/** Strongest reason first. The order is total, so the same reasons always combine to the same score. */
export function sortReasons(reasons: Reason[]): Reason[] {
  return reasons.sort((x, y) => y.evidence - x.evidence || (x.identifier < y.identifier ? -1 : 1))
}

/** Noisy-OR: the pair is one person unless every reason is a coincidence. */
export function combine(sorted: readonly Reason[]): number {
  let coincidence = 1
  for (const reason of sorted) coincidence *= 1 - reason.evidence
  return 1 - coincidence
}
