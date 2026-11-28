import { malformed, refused } from '../contract/fault.ts'
import { createHash } from 'node:crypto'
import { checkedNameKey, foldedNameKey } from './identifiers.ts'
import type { Edge, Identifier, IdentifierState, Reason } from '../contract/types.ts'

export interface Rule {
  /** Probability two subjects are one person when they alone share one identifier of this kind. */
  weight: number
  /** How fast evidence thins as more subjects share it: `weight * (2 / fanout) ** dilution`. */
  dilution: number
  /** Past this many subjects the identifier is public and links nothing. */
  cap: number
  /** Evidence halves for each half-life between the two subjects' sightings. */
  halfLife: number
  /**
   * Kinds that come together count once. Among the reasons of one group a
   * pair has, only the strongest adds to its score: a household shares its
   * phone, its address and its internet connection, and that is one fact.
   */
  group?: string
  /**
   * This kind never makes a link, and only confirms one. It counts where the
   * pair's other kinds already reach `related` without it.
   */
  corroborates?: true
  /**
   * This kind says two subjects are two people who have to do with each
   * other. A pair that shares one is related, and kept apart in one cluster as
   * a reviewer's separation would keep it, unless a reviewer or a system joins the two.
   */
  relates?: true
}

/** A fact about somebody that links nothing: the date of birth, and the names their first name may stand for. */
export type Fact = 'birth' | 'given'
export const FACTS: readonly Fact[] = ['birth', 'given']

export interface Policy {
  /** At or above this score two subjects join one cluster. */
  same: number
  /** At or above this score two subjects are reported as linked. */
  related: number
  /**
   * At or above this confidence a visit is credited in the report and in what brought somebody, `same` when left out. Joining two
   * people and crediting an ad are two questions. An ad credited wrongly now and then shows nobody's record. It joins nobody,
   * shows nothing of one in the journey of another, crosses no split, and is not what is sent to an ad platform.
   */
  credit?: number
  /** A single link below this score cannot be the only thing joining two groups. At or below `same`, the rule is off. */
  bridge: number
  /**
   * Subjects that name nobody, by what their ids start with: a browser, a phone number that called. A weak link may join
   * a group of these alone to one named group, because it makes no two records one. `UNNAMED` when left out, and not in a
   * settings file.
   */
  unnamed?: readonly string[]
  /**
   * Facts that no two values of are one person's: `birth`, and `given`. Two subjects of one group that both have such a
   * fact and share no value of it are kept apart, whatever joins them, unless a reviewer or a system joined the two. A
   * fact that agrees outranks one that differs, and names that begin with one letter say nothing. Left out, nobody is kept apart.
   */
  apart?: readonly Fact[]
  /**
   * `confirmed`: two records are one person only where somebody said so, a name or a date of birth agrees, or they have an
   * identifier only one person has. What else they share, such as an email or a number, shows them as possibly one. A
   * browser or a caller goes with the records it is tied to most strongly. Needs `apart`, because it goes by those facts.
   * It says nothing about credit, which follows a link whichever records it ends at. Left out, whatever joins, joins.
   */
  records?: 'confirmed'
  /** A cluster with more members than this is flagged for review. */
  review: number
  kinds: Readonly<Record<string, Rule>>
}

const DAY = 86_400_000

/**
 * Default weights. The fingerprint, canvas, and ip rows are set from these
 * figures:
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
    // Alone it joins two subjects, relates three, and says nothing of four or more, because a household or a front desk is as likely.
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
    // A note, not evidence. A browser opened the link sent to this person. It links nothing.
    opened: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // A phone call that began moments after exactly one visitor tapped its number on your site. `recordCall` writes it.
    lease: { weight: 0.9, dilution: 0, cap: 2, halfLife: Infinity },
    dial: { weight: 0.92, dilution: 0, cap: 2, halfLife: Infinity },
    // A text that carried the code one visitor was given. Better than a tap's time, and still a prior, because a text can be forwarded.
    text: { weight: 0.95, dilution: 0, cap: 2, halfLife: Infinity },
    // Somebody who speaks for somebody else: a parent for a child, a wife for a husband. The credit for what brought the one is the other's, and they are two people.
    behalf: { weight: 0.92, dilution: 0, cap: 2, halfLife: Infinity, relates: true },
    // A note, not evidence. It says where an address places a visit. It links nothing.
    place: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // Notes, not evidence. They are what is known of a person that cannot be two people's. They link nothing.
    birth: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // The whole name a record was given, kept under every policy. A name alone is nobody's, so it links nothing.
    called: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    given: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    initial: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    dated: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // One full name and date of birth, kept where records have to be confirmed, and then it is evidence. See PERSON. Elsewhere it says nothing.
    person: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    perhaps: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // That a first name has several words, so a half of it is not all of it. Kept where records have to be confirmed.
    compound: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
    // One number or email given under one name. It confirms what the number or email says, and says nothing once that is muted or too many hold it.
    named: { weight: 0.999, dilution: 0, cap: 10, halfLife: Infinity, corroborates: true },
    // The same of two who were spoken for by one number or email, which is on neither's record.
    ward: { weight: 0.97, dilution: 0, cap: 5, halfLife: Infinity },
    // A note, not evidence. It is the number a visitor tapped, or a call that was recorded. It links nothing.
    dialed: { weight: 0, dilution: 0, cap: 0, halfLife: Infinity },
  },
}

/** The subjects this server makes for a browser, a phone number that called, and a call with no number. */
export const UNNAMED: readonly string[] = ['visitor', 'caller', 'call']

/** The kinds that are notes. The graph counts on them linking nothing, so a setting may not give them weight. */
const NOTES = new Set(['opened', 'place', 'dialed', 'initial', 'dated', 'compound', 'person', 'perhaps', 'called', ...FACTS])
const LEVELS = ['same', 'related', 'bridge'] as const
const FIELDS = ['weight', 'dilution', 'cap', 'halfLife'] as const
const OPTIONAL = ['group', 'corroborates', 'relates'] as const

/** What is wrong with a policy read from a setting, one line each. The setting only needs what differs from the default. */
export function policyProblems(given: unknown): string[] {
  const plain = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  if (!plain(given)) return ['must be an object, such as {"kinds":{"phone":{"weight":0.85}}}']
  const wrong: string[] = []
  const number = (value: unknown, least: number, most: number) => typeof value === 'number' && value >= least && value <= most
  for (const name of Object.keys(given)) if (name !== 'kinds' && name !== 'review' && name !== 'apart' && name !== 'records' && name !== 'credit' && !(LEVELS as readonly string[]).includes(name)) wrong.push(`"${name}" is not a setting`)
  for (const name of LEVELS) if (given[name] !== undefined && !number(given[name], 0, 1)) wrong.push(`"${name}" must be a number from 0 to 1`)
  if (given.review !== undefined && !(Number.isSafeInteger(given.review) && given.review > 0)) wrong.push('"review" must be a positive integer')
  if (given.apart !== undefined && !(Array.isArray(given.apart) && given.apart.every((fact: unknown) => FACTS.includes(fact as Fact)))) wrong.push('"apart" must be a list of facts, such as ["birth"]')
  if (given.credit !== undefined && !number(given.credit, 0.5, 1)) wrong.push('"credit" must be a number from 0.5 to 1')
  if (given.records !== undefined && given.records !== 'confirmed') wrong.push('"records" must be "confirmed", or left out')
  else if (given.records && !(Array.isArray(given.apart) && given.apart.length > 0)) wrong.push('"records" requires "apart", such as ["birth", "given"], because it goes by those facts')
  if (given.kinds !== undefined && !plain(given.kinds)) wrong.push('"kinds" must be an object of rules')
  else {
    for (const [kind, rule] of Object.entries(given.kinds ?? {})) {
      const base = Object.hasOwn(defaultPolicy.kinds, kind)
      if (!base && (!kind || kind.includes(':'))) wrong.push(`kind "${kind}" must be a name without a colon`)
      if (!plain(rule)) {
        wrong.push(`kind "${kind}" must be an object, such as {"weight":0.85}`)
        continue
      }
      for (const name of Object.keys(rule)) if (![...FIELDS, ...OPTIONAL].includes(name as never)) wrong.push(`kind "${kind}" has "${name}", which is not part of a rule`)
      if (!base) for (const name of FIELDS) if (rule[name] === undefined) wrong.push(`kind "${kind}" is new, so it requires its ${name}`)
      if (rule.weight !== undefined && !number(rule.weight, 0, 1)) wrong.push(`kind "${kind}" requires a weight from 0 to 1`)
      if (rule.dilution !== undefined && !number(rule.dilution, 0, Number.MAX_VALUE)) wrong.push(`kind "${kind}" requires a dilution of zero or more`)
      if (rule.cap !== undefined && !(Number.isSafeInteger(rule.cap) && rule.cap >= 0)) wrong.push(`kind "${kind}" requires a cap of zero or more, in whole subjects`)
      if (rule.halfLife !== undefined && rule.halfLife !== 'none' && !(number(rule.halfLife, 0, Number.MAX_VALUE) && rule.halfLife > 0)) wrong.push(`kind "${kind}" requires a halfLife in milliseconds, or "none"`)
      if (rule.group !== undefined && !(typeof rule.group === 'string' && rule.group)) wrong.push(`kind "${kind}" requires its group as a string`)
      if (rule.corroborates !== undefined && rule.corroborates !== true) wrong.push(`kind "${kind}" requires its corroborates as true, or left out`)
      if (rule.relates !== undefined && rule.relates !== true) wrong.push(`kind "${kind}" requires its relates as true, or left out`)
      if (NOTES.has(kind) && rule.weight && !(given.records && (kind === 'person' || kind === 'perhaps'))) wrong.push(`kind "${kind}" is a note and links nothing, so its weight must stay 0`)
      // The whole name is held by everybody of that name. Nothing a setting says may make two of them count for each other.
      if (kind === 'called' && (rule.cap || rule.group !== undefined || rule.corroborates !== undefined || rule.relates !== undefined)) wrong.push('kind "called" is the note of a whole name and links nothing, so its cap stays 0 and it takes no group, corroborates or relates')
    }
  }
  if (wrong.length > 0) return wrong
  const policy = policyFrom(given)
  if (policy.related > policy.same) wrong.push('"related" must not be above "same"')
  for (const [kind, rule] of Object.entries(policy.kinds)) if (rule.relates && rule.corroborates) wrong.push(`kind "${kind}" cannot both relate and corroborate`)
  const { review } = policy.kinds
  if (review!.corroborates) wrong.push('kind "review" is a reviewer\'s join, so it cannot only corroborate')
  if (review!.relates) wrong.push('kind "review" is a reviewer\'s join, so it cannot only relate')
  if (review!.weight < Math.max(policy.same, policy.bridge) || review!.cap < 2) wrong.push('kind "review" is a reviewer\'s join, so it must join on its own: a weight of at least "same" and "bridge", a cap of at least 2')
  return wrong
}

/** Two of one full name and date of birth in one firm are rare, and not so rare that nothing else has to agree. */
// In one group with the name a preset may keep as well, because it says the same thing.
const PERSON: Rule = { weight: 0.85, dilution: 0, cap: 10, halfLife: Infinity, group: 'name' }
/** And two whose names may be one. It is shown, and is no evidence that joins with a little more. */
const PERHAPS: Rule = { weight: 0.55, dilution: 0, cap: 10, halfLife: Infinity, group: 'name' }

/** The default policy with what a setting names laid over it, kind by kind. Check the setting with `policyProblems` first. */
export function policyFrom(given: any): Policy {
  const kinds = new Map(Object.entries(defaultPolicy.kinds))
  for (const [kind, { halfLife, ...rule }] of Object.entries<any>(given.kinds ?? {})) {
    kinds.set(kind, { ...kinds.get(kind), ...rule, ...(halfLife !== undefined && { halfLife: halfLife === 'none' ? Infinity : halfLife }) })
  }
  // Whatever a kept policy says of the two, they are evidence where records have to be confirmed and nowhere else.
  for (const [kind, rule] of [['person', PERSON], ['perhaps', PERHAPS]] as const) kinds.set(kind, given.records ? rule : defaultPolicy.kinds[kind]!)
  const levels = Object.fromEntries([...LEVELS, 'review'].filter((name) => given[name] !== undefined).map((name) => [name, given[name]]))
  return { ...defaultPolicy, ...levels, ...(given.apart?.length > 0 && { apart: FACTS.filter((fact) => given.apart.includes(fact)) }), ...(given.records && { records: given.records }), ...(given.credit !== undefined && { credit: given.credit }), kinds: Object.fromEntries(kinds) }
}

/** A policy as plain JSON: kinds in name order, and a half-life that never ends written `none`. */
export function plainPolicy(policy: Policy) {
  const kinds = Object.entries(policy.kinds).sort(([x], [y]) => (x < y ? -1 : 1))
  return {
    same: policy.same,
    related: policy.related,
    bridge: policy.bridge,
    ...(policy.apart?.length && { apart: FACTS.filter((fact) => policy.apart!.includes(fact)) }),
    ...(policy.records && { records: policy.records }),
    ...(policy.credit !== undefined && { credit: policy.credit }),
    review: policy.review,
    kinds: Object.fromEntries(
      kinds.map(([kind, { weight, dilution, cap, halfLife, group, corroborates, relates }]) => [kind, { weight, dilution, cap, halfLife: Number.isFinite(halfLife) ? halfLife : ('none' as const), ...(group !== undefined && { group }), ...(corroborates && { corroborates }), ...(relates && { relates }) }]),
    ),
  }
}

/** Raised when the code decides differently under one policy, so that what was stored before is known to be due a rebuild. */
const RULES = 8

export const REBUILD_NOTICE = 'Groups are due a rebuild. Run account-graph rebuild.'

/** The same for two policies exactly when they score and cluster alike. What only flags, `review`, and what only credits, `credit`, are not part of it. */
export function policyHash(policy: Policy): string {
  const { review: _, credit: __, ...rest } = plainPolicy(policy)
  // A note that links nothing and says nothing but where records have to be confirmed. A policy without it is what it was.
  if (!policy.records) for (const kind of ['compound', 'person', 'perhaps']) delete (rest.kinds as Record<string, unknown>)[kind]
  return createHash('sha256').update(JSON.stringify({ ...rest, rules: RULES, unnamed: [...new Set(policy.unnamed ?? UNNAMED)].sort() })).digest('hex')
}

export function ruleFor(policy: Policy, identifier: Identifier): Rule {
  const colon = identifier.indexOf(':')
  if (colon <= 0 || colon === identifier.length - 1) {
    throw malformed(`Identifier "${identifier}" must have the form "kind:value"`)
  }
  const kind = identifier.slice(0, colon)
  // Own rules only, because every object has things like a constructor, and none of them is a rule.
  const rule = Object.hasOwn(policy.kinds, kind) ? policy.kinds[kind] : undefined
  if (!rule) throw refused(`Identifier "${identifier}" has a kind that is missing from the policy`, { reason: 'KIND_NOT_IN_POLICY', kind })
  return rule
}

/** Whether the holders of an identifier are counted as people: a phone number, whatever kind of line it is. */
export const countedAsPeople = (identifier: Identifier) => identifier.startsWith('phone:') || identifier.startsWith('voip:')

/**
 * How many people these holders of one number may be: the most of one type. A `caller:`, a `lead:` and a `contact:` record
 * are one person met three ways, and two `contact:` records may be two people.
 */
export function mostOfOneType(subjects: Iterable<string>): number {
  const counts = new Map<string, number>()
  for (const subject of new Set(subjects)) {
    const type = subject.split(':', 1)[0]!
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return Math.max(0, ...counts.values())
}

/** Whether an identifier can link subjects at all. */
export function usable(policy: Policy, identifier: Identifier, state: IdentifierState | undefined): boolean {
  return state !== undefined && !state.ignored && state.fanout <= ruleFor(policy, identifier).cap
}

/** The evidence one shared identifier gives that the subjects of `a` and `b` are one person. */
export function evidence(policy: Policy, a: Edge, b: Edge, fanout: number, people = fanout): Reason {
  const rule = ruleFor(policy, a.identifier)
  const gap = Math.max(0, Math.max(a.first, b.first) - Math.min(a.last, b.last))
  const thinned = rule.weight * (2 / Math.max(2, Math.min(fanout, people))) ** rule.dilution
  return { identifier: a.identifier, evidence: thinned * 0.5 ** (gap / rule.halfLife), fanout, gap }
}

/** Whether a pair with these reasons is joined by them. */
export function joins(policy: Policy, score: number, reasons: readonly Reason[]): boolean {
  return score >= policy.same && !told(policy, reasons)
}

/** Whether these reasons say that two subjects are two people, and nobody has joined the two in spite of it. */
export function told(policy: Policy, reasons: readonly Reason[]): boolean {
  return reasons.some((reason) => ruleFor(policy, reason.identifier).relates) && !reasons.some((reason) => reason.identifier.startsWith('review:'))
}

/** A shared spelling permits its original hash to count once, with the original fanout, strength and mute. An old hash alone permits nothing. */
export function checkedReasons(reasons: Reason[], missing?: () => void): Reason[] {
  if (!reasons.some(({ identifier }) => foldedNameKey(identifier))) return reasons
  const checked = new Set<Identifier>()
  for (const { identifier } of reasons) {
    const base = foldedNameKey(identifier)
    if (base && checkedNameKey(identifier)) checked.add(base)
  }
  return reasons.filter(({ identifier }) => {
    const base = foldedNameKey(identifier)
    if (base === identifier && !checked.has(base)) missing?.()
    return !base || checked.has(identifier)
  })
}

/** The evidence that would have been available before spellings were checked. */
export function earlierReasons(reasons: Reason[]): Reason[] {
  return reasons.filter(({ identifier }) => (foldedNameKey(identifier) ?? identifier) === identifier)
}

/**
 * Sorts the reasons of a pair, strongest first, and scores it by noisy-OR:
 * the pair is one person unless every reason that counts is a coincidence.
 * Of the reasons in one group only the strongest counts, and the rest are
 * marked. A kind that only corroborates counts where the others reach
 * `related` without it. The order is total, so the same reasons always give
 * the same score.
 */
export function weigh(policy: Policy, reasons: Reason[]): number {
  reasons.sort((x, y) => y.evidence - x.evidence || (x.identifier < y.identifier ? -1 : 1))
  const ruled = reasons.map((reason) => ({ reason, ...ruleFor(policy, reason.identifier) }))
  /** The reasons that count of those given, and what they come to. */
  const combine = (given: typeof ruled) => {
    const seen = new Set<string>()
    const counted = given.filter(({ group }) => group === undefined || (!seen.has(group) && seen.add(group)))
    return { counted: new Set(counted.map((each) => each.reason)), coincidence: counted.reduce((rest, { reason }) => rest * (1 - reason.evidence), 1) }
  }
  const alone = combine(ruled.filter((each) => !each.corroborates))
  // What only may be one name shows two, and is nothing for what only confirms to confirm.
  const firm = combine(ruled.filter((each) => !each.corroborates && !each.reason.identifier.startsWith('perhaps:')))
  const confirmed = firm.counted.size > 0 && 1 - firm.coincidence >= policy.related
  const { counted, coincidence } = confirmed ? combine(ruled) : alone
  for (const { reason, group } of ruled) {
    if (group !== undefined) reason.group = group
    if (!counted.has(reason)) reason.counted = false
  }
  return 1 - coincidence
}
