import { UNNAMED, evidence, joins, told, usable, weigh } from './policy.ts'
import type { Fact, Policy } from './policy.ts'
import type { Edge, Identifier, IdentifierState, Labels, Pair, Reason, Subject } from '../contract/types.ts'

/**
 * Scores every pair of subjects that share a usable identifier among `edges`.
 * With `from`, only pairs that touch one of those subjects are scored.
 * Pairs that score under `least`, by default the policy's `related`, are left out.
 * Pure: no I/O, no clock, and the result does not depend on the order of `edges`.
 */
export function scorePairs(
  policy: Policy,
  edges: readonly Edge[],
  states: ReadonlyMap<Identifier, IdentifierState>,
  from?: ReadonlySet<Subject>,
  least = policy.related,
): Pair[] {
  const byIdentifier = new Map<Identifier, Edge[]>()
  for (const edge of edges) {
    const group = byIdentifier.get(edge.identifier)
    if (group) group.push(edge)
    else byIdentifier.set(edge.identifier, [edge])
  }

  const found = new Map<Subject, Map<Subject, Reason[]>>()
  for (const [identifier, group] of byIdentifier) {
    const state = states.get(identifier)
    if (group.length < 2 || !usable(policy, identifier, state)) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const x = group[i]!
        const y = group[j]!
        if (x.subject === y.subject) continue
        if (from && !from.has(x.subject) && !from.has(y.subject)) continue
        const [a, b] = x.subject < y.subject ? [x, y] : [y, x]
        let row = found.get(a.subject)
        if (!row) found.set(a.subject, (row = new Map()))
        const reasons = row.get(b.subject)
        const reason = evidence(policy, a, b, state!.fanout)
        if (reasons) reasons.push(reason)
        else row.set(b.subject, [reason])
      }
    }
  }

  const pairs: Pair[] = []
  for (const [a, row] of found) {
    for (const [b, reasons] of row) {
      const score = weigh(policy, reasons)
      // That one speaks for the other is said, whatever it comes to.
      if (score < least && !told(policy, reasons)) continue
      pairs.push({ a, b, score, level: joins(policy, score, reasons) ? 'same' : 'related', reasons })
    }
  }
  return pairs.sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1))
}

/**
 * Connected components over `same` pairs, by union-find.
 * Each subject maps to the smallest member of its component.
 */
export function components(subjects: Iterable<Subject>, pairs: readonly Pair[]): Map<Subject, Subject> {
  const parent = new Map<Subject, Subject>()
  for (const subject of subjects) parent.set(subject, subject)

  const find = (subject: Subject): Subject => {
    let root = subject
    for (let next = parent.get(root)!; next !== root; next = parent.get(root)!) root = next
    for (let node = subject; node !== root; ) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }

  for (const pair of pairs) {
    if (pair.level !== 'same' || !parent.has(pair.a) || !parent.has(pair.b)) continue
    const a = find(pair.a)
    const b = find(pair.b)
    // The smaller id becomes the root, so a root is always its component's smallest member.
    if (a < b) parent.set(b, a)
    else if (b < a) parent.set(a, b)
  }

  const out = new Map<Subject, Subject>()
  for (const subject of parent.keys()) out.set(subject, find(subject))
  return out
}

/** The facts, and what is noted beside them to weigh them by. */
type Note = Fact | 'initial' | 'dated' | 'compound'

/** What is known of somebody that cannot be two people's, and the joins a reviewer or a system made of them. */
export interface Known {
  facts: Map<Note, Set<Identifier>>
  joins: Set<Identifier>
  /** What they gave under which name. */
  things: Set<Identifier>
}

const THINGS = new Set(['named', 'ward'])
/** Records of one component, past which nothing but a decision joins them where records have to be confirmed. */
const CROWD = 300
/** What one person has and no other: a name with a zip code or a date of birth, and a passkey. */
const OWN = new Set(['name', 'passkey'])

/** The facts of the subjects that have one, of the facts a policy keeps people apart by. An undone join is none. With `joins`, those are read whatever the policy. */
export function knownOf(policy: Policy, edges: readonly Edge[], undone: (identifier: Identifier) => boolean, joins = false): Map<Subject, Known> {
  const out = new Map<Subject, Known>()
  if (!policy.apart?.length && !joins) return out
  const confirming = policy.records === 'confirmed'
  for (const { subject, identifier } of edges) {
    const kind = identifier.slice(0, identifier.indexOf(':'))
    // Each fact is read for the other to be weighed against, whether or not it keeps anyone apart by itself.
    const thing = (THINGS.has(kind) && policy.apart?.includes('given') === true) || (confirming && OWN.has(kind))
    if (!policy.apart?.includes(kind as Fact) && !thing && kind !== 'birth' && kind !== 'given' && kind !== 'initial' && kind !== 'dated' && kind !== 'compound' && kind !== 'review') continue
    // A join that was undone is none, and a fact that was muted is none.
    if (undone(identifier)) continue
    const known = out.get(subject) ?? { facts: new Map(), joins: new Set(), things: new Set() }
    out.set(subject, known)
    if (kind === 'review') known.joins.add(identifier)
    else if (thing) known.things.add(identifier)
    else known.facts.set(kind as Note, (known.facts.get(kind as Note) ?? new Set()).add(identifier))
  }
  return out
}

/** The fact two subjects cannot both be one person by, if there is one. */
export function conflict(policy: Policy, a: Known | undefined, b: Known | undefined): Fact | undefined {
  if (!a || !b || !policy.apart?.length) return undefined
  if ([...a.joins].some((identifier) => b.joins.has(identifier))) return undefined
  /** Whether they agree on a fact, or undefined where one of them has none. */
  const agree = (fact: Fact | 'initial' | 'dated') => {
    const [own, others] = [a.facts.get(fact), b.facts.get(fact)]
    return own && others && [...own].some((value) => others.has(value))
  }
  const named = agree('given') === true || [...a.things].some((thing) => b.things.has(thing))
  // A name that agrees outranks two dates that one slip of the pen would make one. A father and a son of one name have two dates.
  if (policy.apart.includes('birth') && agree('birth') === false && !(named && agree('dated') === true)) return 'birth'
  if (!policy.apart.includes('given') || agree('given') !== false || agree('birth') === true || agree('initial') === true) return undefined
  return 'given'
}

/** Whether a decision joined two. */
const joinedBy = (a: Known | undefined, b: Known | undefined) => Boolean(a && b && [...a.joins].some((each) => b.joins.has(each)))

const meets = (one: ReadonlySet<Identifier> | undefined, other: ReadonlySet<Identifier> | undefined) => one && other && [...one].some((each) => other.has(each))

/**
 * Whether a fact of one is another than the other's. Two dates one slip of the pen apart are one date where a name agrees. A
 * Maria Elena and a Maria Guadalupe have a name in common, and each has one the other has not, so they are two. A Bob has
 * names a Robert has not, and they are ways to write one word.
 */
function disagree(a: Known | undefined, b: Known | undefined): boolean {
  if (!a || !b) return false
  const [ours, theirs] = [a.facts.get('given'), b.facts.get('given')]
  const within = (one: ReadonlySet<Identifier>, other: ReadonlySet<Identifier>) => [...one].every((each) => other.has(each))
  const several = a.facts.has('compound') && b.facts.has('compound')
  const given = ours && theirs && meets(ours, theirs) && (!several || within(ours, theirs) || within(theirs, ours))
  if (given === false) return true
  const named = given === true || [...a.things].some((each) => b.things.has(each))
  return meets(a.facts.get('birth'), b.facts.get('birth')) === false && !(named && meets(a.facts.get('dated'), b.facts.get('dated')) === true)
}

/** Whether something says that two records are one person, other than what they share: a decision, or a name, a date or a thing of one person's that agrees where nothing differs. */
export function confirmed(a: Known | undefined, b: Known | undefined): boolean {
  if (!a || !b) return false
  if (joinedBy(a, b)) return true
  if (disagree(a, b)) return false
  const dates = meets(a.facts.get('birth'), b.facts.get('birth')) === true
  const [ours, theirs] = [a.facts.get('given'), b.facts.get('given')]
  // Names that may be written for one another, and need not be: a Mary and a Marilyn, a Robert and a Bob. A date has to say
  // which. One name is itself, and half of a name of several words.
  const within = (one: ReadonlySet<Identifier>, other: ReadonlySet<Identifier>) => [...one].every((each) => other.has(each))
  const loosely = ours !== undefined && theirs !== undefined && !(within(ours, theirs) && (within(theirs, ours) || b.facts.has('compound'))) && !(within(theirs, ours) && a.facts.has('compound'))
  if (loosely ? [...a.things].some((each) => b.things.has(each) && !THINGS.has(each.slice(0, each.indexOf(':')))) : meets(a.things, b.things) || meets(ours, theirs)) return true
  // A name no table has is no fact, and is still a name: two who gave names under which nothing is the same are twins as likely as one.
  const names = (known: Known) => [...known.things].some((each) => THINGS.has(each.slice(0, each.indexOf(':'))) || each.startsWith('name:'))
  return dates && (meets(ours, theirs) === true || !(names(a) && names(b)))
}

type Adjacency = Map<Subject, Map<Subject, number>>

/**
 * Splits subjects into components and, inside each, clusters.
 *
 * A component is every subject reachable over `same` pairs. A cluster is what
 * is left of a component after three kinds of cut, applied in this order:
 *
 * 1. A pair a reviewer separated, or whose facts say it is two people, is
 *    never linked directly.
 * 2. If the two are still connected through others, the weakest set of links
 *    between them is removed.
 * 3. A single link below `policy.bridge` may add one subject to a group, but
 *    may not be the only thing joining two groups of two or more. The weakest
 *    such link is removed, then the next, until none is left. A group that
 *    names nobody then goes back to the one named group it was cut from, and
 *    stays apart where it was cut from two.
 *
 * Where the policy joins records only when that is confirmed, what is left is
 * cut once more: see `refined`.
 *
 * Pure, and the result does not depend on the order of its inputs.
 */
export function partition(
  subjects: Iterable<Subject>,
  pairs: readonly Pair[],
  separated: readonly (readonly [Subject, Subject])[],
  policy: Policy,
  known: ReadonlyMap<Subject, Known> = new Map(),
  /** Hears each link taken because two are kept apart, by a decision or by what is known of them. */
  onCut?: (a: Subject, b: Subject) => void,
  /** Pairs of whom it is said that they are two people, though nobody decided it. */
  two: readonly (readonly [Subject, Subject])[] = [],
  /** When each of two kept apart was first seen. What is tied to both as strongly goes with whoever was first. */
  since: ReadonlyMap<Subject, number> = new Map(),
): Map<Subject, Labels> {
  const component = components(subjects, pairs)
  const members = new Map<Subject, Subject[]>()
  for (const [subject, id] of component) {
    const group = members.get(id)
    if (group) group.push(subject)
    else members.set(id, [subject])
  }
  const links = new Map<Subject, Pair[]>()
  for (const pair of pairs) {
    const id = component.get(pair.a)
    if (pair.level !== 'same' || id === undefined || component.get(pair.b) !== id) continue
    const group = links.get(id)
    if (group) group.push(pair)
    else links.set(id, [pair])
  }
  const apart = new Map<Subject, [Subject, Subject][]>()
  for (const [x, y] of separated) {
    const id = component.get(x)
    if (id === undefined || component.get(y) !== id || x === y) continue
    const pair: [Subject, Subject] = x < y ? [x, y] : [y, x]
    const group = apart.get(id)
    if (group) group.push(pair)
    else apart.set(id, [pair])
  }

  const said = new Map<Subject, (readonly [Subject, Subject])[]>()
  for (const pair of two) {
    const id = component.get(pair[0])
    if (id !== undefined && component.get(pair[1]) === id) said.set(id, [...(said.get(id) ?? []), pair])
  }

  const out = new Map<Subject, Labels>()
  for (const [id, group] of members) {
    if (group.length === 1) {
      out.set(id, { component: id, cluster: id })
      continue
    }
    const told = group.filter((subject) => known.get(subject)?.facts.size).sort()
    const differ: (readonly [Subject, Subject])[] = []
    for (const [i, a] of told.entries()) for (const b of told.slice(i + 1)) if (conflict(policy, known.get(a), known.get(b))) differ.push([a, b])
    differ.push(...(said.get(id) ?? []))
    differ.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1))
    for (const piece of refined(split(group, links.get(id) ?? [], apart.get(id) ?? [], policy, differ, known, onCut, since), links.get(id) ?? [], policy, known, since)) {
      let cluster = piece[0]!
      for (const subject of piece) if (subject < cluster) cluster = subject
      for (const subject of piece) out.set(subject, { component: id, cluster })
    }
  }
  return out
}

/**
 * Groups of which each is one person by something that says so. Two groups of records are one where they are tied, directly
 * or through browsers and callers, some record of the one is confirmed to be some record of the other, and none differs from
 * any in a fact. One that could be either of two who differ is neither's. A decision joins the two it names whatever differs. Each browser and caller then goes with the group it is
 * tied to most strongly, by itself or through others that name nobody, and of two as strong, with the one first seen. No link
 * is taken for it: what they share is as it was.
 */
function refined(pieces: Subject[][], links: readonly Pair[], policy: Policy, known: ReadonlyMap<Subject, Known>, since: ReadonlyMap<Subject, number>): Subject[][] {
  if (policy.records !== 'confirmed') return pieces
  const unnamed = new Set(policy.unnamed ?? UNNAMED)
  const nobody = (subject: Subject) => unnamed.has(subject.slice(0, Math.max(0, subject.indexOf(':'))))
  const at = (subject: Subject) => since.get(subject) ?? 0
  const ties = new Map<Subject, [Subject, number][]>()
  const tie = (from: Subject, to: Subject, score: number) => void (ties.get(from)?.push([to, score]) ?? ties.set(from, [[to, score]]))
  for (const { a, b, score } of links) {
    tie(a, b, score)
    tie(b, a, score)
  }
  const everyone = pieces.flat().filter((subject) => !nobody(subject))
  if (everyone.length < 2) return pieces
  // So many come of something everybody shares, and what confirms them is then shared by chance: decisions alone join them.
  const crowd = everyone.length > CROWD
  // Who has anything in common that could confirm the two, in all of the component: whoever was cut off may be one's as well.
  const holders = new Map<Identifier, Subject[]>()
  const own = (subject: Subject) => {
    const each = known.get(subject)
    return each ? [...each.things, ...each.joins, ...(each.facts.get('birth') ?? []), ...(each.facts.get('given') ?? [])] : []
  }
  for (const subject of everyone) for (const identifier of own(subject)) void (holders.get(identifier)?.push(subject) ?? holders.set(identifier, [subject]))
  const asked = new Map<Subject, Map<Subject, 'yes' | 'no' | 'neither'>>()
  const between = (x: Subject, y: Subject) => {
    if (!asked.has(x)) asked.set(x, new Map())
    let found = asked.get(x)!.get(y)
    if (!found) {
      const [one, other] = [known.get(x), known.get(y)]
      asked.get(x)!.set(y, (found = disagree(one, other) && !joinedBy(one, other) ? 'no' : confirmed(one, other) ? 'yes' : 'neither'))
    }
    return found
  }
  const some = (ours: readonly Subject[], theirs: readonly Subject[], what: 'yes' | 'no') => ours.some((x) => theirs.some((y) => between(x, y) === what))
  return pieces.flatMap((piece) => {
    const inside = new Set(piece)
    const records = piece.filter((subject) => !nobody(subject)).sort((x, y) => at(x) - at(y) || (x < y ? -1 : 1))
    if (records.length < 2) return [piece]
    const groups = new Map<Subject, Subject[]>(records.map((record) => [record, [record]]))
    const home = new Map<Subject, Subject>(records.map((record) => [record, record]))
    // Who is tied to whom: directly, or by the same browsers and callers.
    const near: [Subject, Subject][] = []
    const among = new Set<Subject>()
    for (const start of piece) {
      if (!nobody(start) || among.has(start)) continue
      const around = new Set<Subject>()
      const todo = [start]
      among.add(start)
      for (let each = todo.pop(); each !== undefined; each = todo.pop()) {
        for (const [next] of ties.get(each) ?? []) {
          if (!inside.has(next) || among.has(next)) continue
          if (!nobody(next)) around.add(next)
          else {
            among.add(next)
            todo.push(next)
          }
        }
      }
      const held = records.filter((record) => around.has(record))
      for (const [i, a] of held.entries()) for (const b of held.slice(i + 1)) near.push([a, b])
    }
    for (const a of records) for (const [b] of ties.get(a) ?? []) if (a < b && inside.has(b) && !nobody(b)) near.push([a, b])
    const order = (x: Subject, y: Subject) => at(x) - at(y) || (x < y ? -1 : x > y ? 1 : 0)
    for (const pair of near) pair.sort(order)
    near.sort((x, y) => order(x[0], y[0]) || order(x[1], y[1]))
    const unite = (a: Subject, b: Subject) => {
      const [into, from] = [home.get(a)!, home.get(b)!]
      for (const each of groups.get(from)!) home.set(each, into)
      groups.get(into)!.push(...groups.get(from)!)
      groups.delete(from)
    }
    // Decisions first, because they stand whatever differs.
    for (const [a, b] of near) if (home.get(a) !== home.get(b) && joinedBy(known.get(a), known.get(b))) unite(a, b)
    // Whether one may be somebody else's as well, who differs from the other.
    const torn = (ours: readonly Subject[], theirs: readonly Subject[]) => {
      const met = new Set([...ours, ...theirs])
      for (const x of ours) for (const identifier of own(x)) for (const y of holders.get(identifier)!) {
        if (met.has(y)) continue
        met.add(y)
        if (some(ours, [y], 'yes') && some(theirs, groups.get(home.get(y) ?? y) ?? [y], 'no')) return true
      }
      return false
    }
    for (let changed = !crowd; changed; ) {
      changed = false
      for (const [a, b] of near) {
        if (home.get(a) === home.get(b)) continue
        const [ours, theirs] = [groups.get(home.get(a)!)!, groups.get(home.get(b)!)!]
        if (!some(ours, theirs, 'yes') || some(ours, theirs, 'no')) continue
        if (torn(ours, theirs) || torn(theirs, ours)) continue
        unite(a, b)
        changed = true
      }
    }
    if (groups.size < 2) return [piece]
    const first = new Map([...groups].map(([id, own]) => [id, Math.min(...own.map(at))]))
    type Way = { subject: Subject; score: number; id: Subject }
    const better = (one: Way, other: Way) => one.score > other.score || (one.score === other.score && (first.get(one.id)! < first.get(other.id)! || (first.get(one.id)! === first.get(other.id)! && one.id < other.id)))
    const best = new Map<Subject, Way>(records.map((subject) => [subject, { subject, score: 1, id: home.get(subject)! }]))
    // The strongest way first. One that was reached is settled, because no way gets stronger by a link.
    const heap: Way[] = []
    const push = (way: Way) => {
      let i = heap.push(way) - 1
      for (let up = (i - 1) >> 1; i > 0 && better(heap[i]!, heap[up]!); i = up, up = (i - 1) >> 1) [heap[i], heap[up]] = [heap[up]!, heap[i]!]
    }
    const pop = (): Way | undefined => {
      const top = heap[0]
      const last = heap.pop()
      if (heap.length === 0 || last === undefined) return top
      heap[0] = last
      for (let i = 0; ; ) {
        let down = i
        for (const child of [2 * i + 1, 2 * i + 2]) if (child < heap.length && better(heap[child]!, heap[down]!)) down = child
        if (down === i) return top
        ;[heap[i], heap[down]] = [heap[down]!, heap[i]!]
        i = down
      }
    }
    for (const way of best.values()) push(way)
    for (let way = pop(); way; way = pop()) {
      if (best.get(way.subject) !== way) continue
      for (const [next, score] of ties.get(way.subject) ?? []) {
        if (!inside.has(next) || !nobody(next)) continue
        const found: Way = { subject: next, score: way.score * score, id: way.id }
        const before = best.get(next)
        if (before && !better(found, before)) continue
        best.set(next, found)
        push(found)
      }
    }
    for (const subject of piece) if (nobody(subject)) {
      const way = best.get(subject)
      if (way) groups.get(way.id)!.push(subject)
      else groups.set(subject, [subject])
    }
    return [...groups.values()].map((own) => own.sort())
  })
}

function split(members: Subject[], links: readonly Pair[], apart: [Subject, Subject][], policy: Policy, differ: readonly (readonly [Subject, Subject])[] = [], known: ReadonlyMap<Subject, Known> = new Map(), onCut?: (a: Subject, b: Subject) => void, since: ReadonlyMap<Subject, number> = new Map()): Subject[][] {
  const adjacency: Adjacency = new Map(members.map((member) => [member, new Map()]))
  for (const { a, b, score } of links) {
    adjacency.get(a)!.set(b, score)
    adjacency.get(b)!.set(a, score)
  }
  const cut = (a: Subject, b: Subject) => {
    adjacency.get(a)!.delete(b)
    adjacency.get(b)!.delete(a)
  }

  apart.sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1))
  const cutApart = (a: Subject, b: Subject) => {
    if (adjacency.get(a)!.has(b)) onCut?.(a, b)
    cut(a, b)
  }
  for (const [a, b] of apart) cutApart(a, b)
  // A cut that could be made in two places is made beside whoever came later, so a shared browser stays with the first.
  const later = (a: Subject, b: Subject): [Subject, Subject] => ((since.get(a) ?? 0) < (since.get(b) ?? 0) ? [b, a] : [a, b])
  for (const pair of apart) for (const [x, y] of minimumCut(adjacency, ...later(...pair))) cutApart(x, y)
  // Facts come after decisions, and cut no link a decision made: two held together by those alone stay together.
  // Kept by pair, because the cuts ask of the same links over and over.
  const answered = new Map<Subject, Map<Subject, boolean>>()
  const decided = (a: Subject, b: Subject) => {
    if (!answered.has(a)) answered.set(a, new Map())
    let found = answered.get(a)!.get(b)
    if (found === undefined) answered.get(a)!.set(b, (found = [...(known.get(a)?.joins ?? [])].some((identifier) => known.get(b)?.joins.has(identifier))))
    return found
  }
  // That a call was about one, and another call about the other, does not say the two are one: a telephone is many people's.
  // So two births part a telephone or a browser from one of them, and never two records somebody said are one.
  const unnamed = new Set(policy.unnamed ?? UNNAMED)
  const nobody = (subject: Subject) => unnamed.has(subject.slice(0, Math.max(0, subject.indexOf(':'))))
  const loose = (a: Subject, b: Subject) => nobody(a) || nobody(b)
  const firm = (a: Subject, b: Subject) => (decided(a, b) ? FIRM : 0)
  for (const [a, b] of differ) cutApart(a, b)
  const byBirth = ([a, b]: readonly [Subject, Subject]) => conflict(policy, known.get(a), known.get(b)) === 'birth'
  // Where somebody joined a telephone or a browser, all the records of a birth are looked at together, before any is cut off by itself or by a name.
  const inOrder = differ.some(byBirth) && joinedLoosely(members) ? [...differ.filter(byBirth), ...differ.filter((pair) => !byBirth(pair))] : differ
  for (const [a, b] of inOrder) {
    const births = byBirth([a, b]) && joinedLoosely(reach(adjacency, a))
    const found = births ? leastUndone(a, b) : minimumCut(adjacency, ...later(a, b), firm)
    if (births || !found.some(([x, y]) => decided(x, y))) for (const [x, y] of found) cutApart(x, y)
  }

  function joinedLoosely(among: Iterable<Subject>): boolean {
    for (const x of among) for (const y of adjacency.get(x)!.keys()) if (loose(x, y) && decided(x, y)) return true
    return false
  }

  /**
   * The cut between two births that leaves out the fewest joins, and of as few, those of whoever was seen later. The joins are chosen by
   * themselves, so nothing else shared chooses between them, and what else is shared is cut after. None where two records are joined across.
   */
  function leastUndone(a: Subject, b: Subject): [Subject, Subject][] {
    const births = (subject: Subject) => known.get(subject)?.facts.get('birth') ?? new Set<Identifier>()
    const piece = [...reach(adjacency, a)]
    if (!piece.includes(b)) return []
    const alike = (one: Subject, other: Subject) => piece.filter((each) => each !== one && conflict(policy, known.get(each), known.get(other)) === 'birth' && [...births(each)].some((birth) => births(one).has(birth)))
    const seen = (each: Subject) => since.get(each) ?? 0
    // All the records of a birth are on one side, so what is left out is counted once for a person and not for each of their records.
    // A join of two records comes before that: whoever one ties to a birth of the other side is held to neither.
    const joined = new Map<Subject, Set<Subject>>()
    const over = (from: Subject) => {
      const before = joined.get(from)
      if (before) return before
      const out = new Set([from])
      for (const each of out) for (const next of adjacency.get(each)!.keys()) if (decided(each, next) && !loose(each, next)) out.add(next)
      // Whoever one is joined to this way is joined to the same.
      for (const each of out) joined.set(each, out)
      return out
    }
    const [ours, theirs] = [[a, ...alike(a, b)], [b, ...alike(b, a)]]
    const free = (side: Subject[], other: Subject[]) => side.filter((each, i) => i === 0 || !other.some((one) => over(each).has(one)))
    const [as, bs] = [free(ours, theirs), free(theirs, ours)]
    const [first, last] = Math.min(...as.map(seen)) <= Math.min(...bs.map(seen)) ? [as, bs] : [bs, as]
    const pairs = [first, last].flatMap((side) => side.slice(1).map((each) => [side[0]!, each] as const))
    // Each of a side to the first of it.
    const heads = new Map(pairs.map(([head, each]) => [each, head]))
    const tied = (x: Subject, y: Subject) => heads.get(x) === y || heads.get(y) === x
    const held = (links: Adjacency) => {
      for (const [x, y] of pairs) {
        links.get(x)!.set(y, 1)
        links.get(y)!.set(x, 1)
      }
      return links
    }
    const joins = held(new Map(piece.map((subject) => [subject, new Map([...adjacency.get(subject)!].filter(([next]) => decided(subject, next)))])))
    const left = minimumCut(joins, last[0]!, first[0]!, (x, y) => (tied(x, y) ? FIRM * 10 : loose(x, y) ? 1 : FIRM))
    if (left.some(([x, y]) => !loose(x, y))) return []
    const rest = held(new Map(piece.map((subject) => [subject, new Map(adjacency.get(subject)!)])))
    for (const [x, y] of left) {
      rest.get(x)!.delete(y)
      rest.get(y)!.delete(x)
    }
    return [...left, ...minimumCut(rest, last[0]!, first[0]!, (x, y) => (tied(x, y) ? FIRM * 10 : decided(x, y) ? FIRM : 0))]
  }

  if (policy.bridge > policy.same) {
    const removed: [Subject, Subject][] = []
    for (let weak = weakestBridge(adjacency, policy.bridge); weak; weak = weakestBridge(adjacency, policy.bridge)) {
      cut(weak[0], weak[1])
      removed.push(weak)
    }
    return regroup(pieces(adjacency), removed, policy)
  }
  return pieces(adjacency)
}

/** Puts pieces that name nobody back on the one named piece the removed links lead to, whether at once or through others like them. */
function regroup(cut: Subject[][], removed: readonly [Subject, Subject][], policy: Policy): Subject[][] {
  if (removed.length === 0) return cut
  const unnamed = new Set(policy.unnamed ?? UNNAMED)
  const named = cut.map((piece) => piece.some((subject) => !unnamed.has(subject.slice(0, Math.max(0, subject.indexOf(':'))))))
  const at = new Map(cut.flatMap((piece, i) => piece.map((subject) => [subject, i] as const)))
  const beside: number[][] = cut.map(() => [])
  for (const [a, b] of removed) {
    beside[at.get(a)!]!.push(at.get(b)!)
    beside[at.get(b)!]!.push(at.get(a)!)
  }
  const out = cut.map((piece) => [...piece])
  const seen = new Set<number>()
  for (const start of cut.keys()) {
    if (named[start] || seen.has(start)) continue
    const group = [start]
    const homes = new Set<number>()
    seen.add(start)
    for (let i = 0; i < group.length; i++) {
      for (const next of beside[group[i]!]!) {
        if (named[next]) homes.add(next)
        else if (!seen.has(next)) {
          seen.add(next)
          group.push(next)
        }
      }
    }
    const [home] = homes
    if (homes.size !== 1) continue
    for (const each of group) out[home!]!.push(...out[each]!.splice(0))
  }
  return out.filter((piece) => piece.length > 0)
}

function reach(adjacency: Adjacency, start: Subject): Set<Subject> {
  const seen = new Set([start])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]!)!.keys()) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

function pieces(adjacency: Adjacency): Subject[][] {
  const seen = new Set<Subject>()
  const out: Subject[][] = []
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue
    const piece = [...reach(adjacency, start)]
    for (const subject of piece) seen.add(subject)
    out.push(piece)
  }
  return out
}

/** A link's strength as a whole number. Noisy-OR evidence adds on this scale, so cuts compare sums of it. */
const strength = (score: number) => Math.max(1, Math.round(-Math.log(1 - Math.min(score, 1 - 1e-9)) * 1e6))

/** Stronger than any links together, of a link no cut may take unless there is no other way. */
const FIRM = 1e13

/**
 * The cheapest set of links whose removal disconnects `source` from `target`,
 * by maximum flow. Of all cheapest cuts it returns the one nearest `source`,
 * which is unique, so the answer does not depend on search order.
 */
function minimumCut(adjacency: Adjacency, source: Subject, target: Subject, firm: (a: Subject, b: Subject) => number = () => 0): [Subject, Subject][] {
  const piece = reach(adjacency, source)
  if (!piece.has(target)) return []
  const residual = new Map<Subject, Map<Subject, number>>()
  for (const node of piece) {
    residual.set(node, new Map([...adjacency.get(node)!].map(([next, score]) => [next, firm(node, next) || strength(score)])))
  }

  for (;;) {
    const from = new Map<Subject, Subject>()
    const queue = [source]
    for (let i = 0; i < queue.length && !from.has(target); i++) {
      for (const [next, room] of residual.get(queue[i]!)!) {
        if (room <= 0 || next === source || from.has(next)) continue
        from.set(next, queue[i]!)
        queue.push(next)
      }
    }
    if (!from.has(target)) break
    let room = Infinity
    for (let node = target; node !== source; node = from.get(node)!) room = Math.min(room, residual.get(from.get(node)!)!.get(node)!)
    for (let node = target; node !== source; node = from.get(node)!) {
      const before = from.get(node)!
      residual.get(before)!.set(node, residual.get(before)!.get(node)! - room)
      residual.get(node)!.set(before, residual.get(node)!.get(before)! + room)
    }
  }

  const near = new Set([source])
  const queue = [source]
  for (let i = 0; i < queue.length; i++) {
    for (const [next, room] of residual.get(queue[i]!)!) {
      if (room <= 0 || near.has(next)) continue
      near.add(next)
      queue.push(next)
    }
  }
  const out: [Subject, Subject][] = []
  for (const node of near) for (const next of adjacency.get(node)!.keys()) if (!near.has(next)) out.push([node, next])
  return out
}

/**
 * The weakest link below `threshold` that alone joins two groups of two or
 * more subjects. A link is alone when removing it disconnects its ends.
 */
function weakestBridge(adjacency: Adjacency, threshold: number): [Subject, Subject] | undefined {
  const found = new Map<Subject, number>()
  const low = new Map<Subject, number>()
  const size = new Map<Subject, number>()
  let clock = 0
  let best: { score: number; a: Subject; b: Subject } | undefined

  for (const root of adjacency.keys()) {
    if (found.has(root)) continue
    const bridges: { child: Subject; a: Subject; b: Subject; score: number }[] = []
    const visit = (node: Subject, parent: Subject | undefined) => {
      found.set(node, clock)
      low.set(node, clock++)
      size.set(node, 1)
      return { node, parent, links: adjacency.get(node)!.entries() }
    }
    const stack = [visit(root, undefined)]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const step = frame.links.next()
      if (!step.done) {
        const [next] = step.value
        if (next === frame.parent) continue
        if (found.has(next)) low.set(frame.node, Math.min(low.get(frame.node)!, found.get(next)!))
        else stack.push(visit(next, frame.node))
        continue
      }
      stack.pop()
      const above = stack[stack.length - 1]
      if (!above) continue
      const { node: child } = frame
      const parent = above.node
      low.set(parent, Math.min(low.get(parent)!, low.get(child)!))
      size.set(parent, size.get(parent)! + size.get(child)!)
      if (low.get(child)! > found.get(parent)!) {
        const [a, b] = parent < child ? [parent, child] : [child, parent]
        bridges.push({ child, a, b, score: adjacency.get(parent)!.get(child)! })
      }
    }
    const total = size.get(root)!
    for (const bridge of bridges) {
      const below = size.get(bridge.child)!
      if (bridge.score >= threshold || below < 2 || total - below < 2) continue
      const better =
        !best || bridge.score < best.score || (bridge.score === best.score && (bridge.a < best.a || (bridge.a === best.a && bridge.b < best.b)))
      if (better) best = bridge
    }
  }
  return best && [best.a, best.b]
}
