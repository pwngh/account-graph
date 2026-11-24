import { createHash } from 'node:crypto'
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
 * Default weights. The fingerprint, canvas, and ip rows are set from how
 * these identifiers behave in production, where the person behind each
 * sighting was known:
 *
 * - A verified vendor fingerprint belongs to one person about 98% of the
 *   time. The next sighting is the same person 98% of the time within 30
 *   days, 95% at 31 to 90 days, and 86% past 90.
 * - A home-made canvas and user-agent hash belongs to one person about half
 *   the time: 55% within a week, 23% at 31 to 90 days, 7% past 90.
 * - An IP address shared by exactly two people points at the same one about 42%
 *   of the time, and by three to five people about 9%. It holds for a day
 *   (89%) and is mostly gone in a month (37%).
 * - A handful of fingerprints are each shared by more than twenty people,
 *   and under 2% of the pairs they produce are one person. Hence the caps.
 *
 * Other rows are priors, the postal address among them. Measure your own traffic with `measure` or `fit`,
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
    email: { weight: 0.99, dilution: 0, cap: 10, halfLife: Infinity },
    // Alone it joins two subjects, relates three, and says nothing of four or more: a household or a front desk is as likely.
    phone: { weight: 0.9, dilution: 1, cap: 10, halfLife: Infinity },
    // A number from an internet calling app, which anyone can get and drop in a minute. A carrier lookup tells it from a real line.
    voip: { weight: 0.5, dilution: 1, cap: 10, halfLife: Infinity },
    // A postal address the postal service confirmed down to the apartment. It names a household, not a person.
    address: { weight: 0.6, dilution: 1, cap: 10, halfLife: Infinity },
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
    // A visitor who followed a link from another of your sites, proven by a token made for that browser. Passed around, it thins.
    carry: { weight: 0.95, dilution: 1, cap: 4, halfLife: Infinity },
    // A note, not evidence: a browser opened the link sent to this person. It links nothing.
    opened: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // A phone call that began moments after exactly one visitor tapped its number on your site. `recordCall` writes it.
    dial: { weight: 0.92, dilution: 0, cap: 2, halfLife: Infinity },
    // A note, not evidence: where an address places a visit. It links nothing.
    place: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // A note, not evidence: the number a visitor tapped, or a call that was recorded. It links nothing.
    dialed: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
  },
}

/** The kinds that are notes. The graph counts on them linking nothing, so a setting may not give them weight. */
const NOTES = new Set(['opened', 'place', 'dialed'])
const LEVELS = ['same', 'related', 'bridge'] as const
const FIELDS = ['weight', 'dilution', 'cap', 'halfLife'] as const

/** What is wrong with a policy read from a setting, one line each. The setting only needs what differs from the default. */
export function policyProblems(given: unknown): string[] {
  const plain = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (!plain(given)) return ['must be an object, such as {"kinds":{"phone":{"weight":0.85}}}']
  const wrong: string[] = []
  const number = (value: unknown, least: number, most: number) => typeof value === 'number' && value >= least && value <= most
  for (const name of Object.keys(given)) if (name !== 'kinds' && name !== 'review' && !(LEVELS as readonly string[]).includes(name)) wrong.push(`"${name}" is not a setting`)
  for (const name of LEVELS) if (given[name] !== undefined && !number(given[name], 0, 1)) wrong.push(`"${name}" must be a number from 0 to 1`)
  if (given.review !== undefined && !(Number.isSafeInteger(given.review) && given.review > 0)) wrong.push('"review" must be a whole number above 0')
  if (given.kinds !== undefined && !plain(given.kinds)) wrong.push('"kinds" must be an object of rules')
  else {
    for (const [kind, rule] of Object.entries(given.kinds ?? {})) {
      const base = Object.hasOwn(defaultPolicy.kinds, kind)
      if (!base && (!kind || kind.includes(':'))) wrong.push(`kind "${kind}" must be a name without a colon`)
      if (!plain(rule)) {
        wrong.push(`kind "${kind}" must be an object, such as {"weight":0.85}`)
        continue
      }
      for (const name of Object.keys(rule)) if (!(FIELDS as readonly string[]).includes(name)) wrong.push(`kind "${kind}" has "${name}", which is not part of a rule`)
      if (!base) for (const name of FIELDS) if (rule[name] === undefined) wrong.push(`kind "${kind}" is new, so it needs its ${name}`)
      if (rule.weight !== undefined && !number(rule.weight, 0, 1)) wrong.push(`kind "${kind}" needs a weight from 0 to 1`)
      if (rule.dilution !== undefined && !number(rule.dilution, 0, Number.MAX_VALUE)) wrong.push(`kind "${kind}" needs a dilution of zero or more`)
      if (rule.cap !== undefined && !(Number.isSafeInteger(rule.cap) && rule.cap >= 0)) wrong.push(`kind "${kind}" needs a cap of zero or more, in whole subjects`)
      if (rule.halfLife !== undefined && rule.halfLife !== 'none' && !(number(rule.halfLife, 0, Number.MAX_VALUE) && rule.halfLife > 0)) wrong.push(`kind "${kind}" needs a halfLife in milliseconds, or "none"`)
      if (NOTES.has(kind) && rule.weight) wrong.push(`kind "${kind}" is a note and links nothing, so its weight must stay 0`)
    }
  }
  if (wrong.length > 0) return wrong
  const policy = policyFrom(given)
  if (policy.related > policy.same) wrong.push('"related" must not be above "same"')
  const { review } = policy.kinds
  if (review!.weight < Math.max(policy.same, policy.bridge) || review!.cap < 2) wrong.push('kind "review" is a reviewer\'s join, so it must join on its own: a weight of at least "same" and "bridge", a cap of at least 2')
  return wrong
}

/** The default policy with what a setting names laid over it, kind by kind. Check the setting with `policyProblems` first. */
export function policyFrom(given: any): Policy {
  const kinds = new Map(Object.entries(defaultPolicy.kinds))
  for (const [kind, { halfLife, ...rule }] of Object.entries<any>(given.kinds ?? {})) {
    kinds.set(kind, { ...kinds.get(kind), ...rule, ...(halfLife !== undefined && { halfLife: halfLife === 'none' ? Infinity : halfLife }) })
  }
  const levels = Object.fromEntries([...LEVELS, 'review'].filter((name) => given[name] !== undefined).map((name) => [name, given[name]]))
  return { ...defaultPolicy, ...levels, kinds: Object.fromEntries(kinds) }
}

/** A policy as plain JSON: kinds in name order, and a half-life that never ends written `none`. */
export function plainPolicy(policy: Policy) {
  const kinds = Object.entries(policy.kinds).sort(([x], [y]) => (x < y ? -1 : 1))
  return {
    same: policy.same,
    related: policy.related,
    bridge: policy.bridge,
    review: policy.review,
    kinds: Object.fromEntries(
      kinds.map(([kind, { weight, dilution, cap, halfLife }]) => [kind, { weight, dilution, cap, halfLife: Number.isFinite(halfLife) ? halfLife : ('none' as const) }]),
    ),
  }
}

/** The same for two policies exactly when they score and cluster alike. What only flags, `review`, is not part of it. */
export function policyHash(policy: Policy): string {
  const { review: _, ...rest } = plainPolicy(policy)
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

export function ruleFor(policy: Policy, identifier: Identifier): Rule {
  const colon = identifier.indexOf(':')
  if (colon <= 0 || colon === identifier.length - 1) {
    throw new TypeError(`Identifier "${identifier}" must be written "kind:value"`)
  }
  const kind = identifier.slice(0, colon)
  // Own rules only: every object has things like a constructor, and none of them is a rule.
  const rule = Object.hasOwn(policy.kinds, kind) ? policy.kinds[kind] : undefined
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
