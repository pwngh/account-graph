import { UNNAMED, evidence, joins, told, usable, weigh } from './policy.ts'
import type { Fact, Policy } from './policy.ts'
import type { Edge, Identifier, IdentifierState, Labels, Pair, Reason, Subject } from './types.ts'

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

/** What is known of somebody that cannot be two people's, and the joins a reviewer or a system made of them. */
export interface Known {
  facts: Map<Fact | 'initial' | 'dated', Set<Identifier>>
  joins: Set<Identifier>
  /** Their browsers, their numbers, and what they gave under which name. */
  things: Set<Identifier>
}

const THINGS = new Set(['device', 'phone', 'voip', 'named'])

/** The facts of the subjects that have one, of the facts a policy keeps people apart by. An undone join is none. With `joins`, those are read whatever the policy. */
export function knownOf(policy: Policy, edges: readonly Edge[], undone: (identifier: Identifier) => boolean, joins = false): Map<Subject, Known> {
  const out = new Map<Subject, Known>()
  if (!policy.apart?.length && !joins) return out
  for (const { subject, identifier } of edges) {
    const kind = identifier.slice(0, identifier.indexOf(':'))
    // Each fact is read for the other to be weighed against, whether or not it keeps anyone apart by itself.
    const thing = THINGS.has(kind) && policy.apart?.includes('given') === true
    if (!policy.apart?.includes(kind as Fact) && !thing && kind !== 'birth' && kind !== 'given' && kind !== 'initial' && kind !== 'dated' && kind !== 'review') continue
    // A join that was undone is none, and a fact that was muted is none.
    if (undone(identifier)) continue
    const known = out.get(subject) ?? { facts: new Map(), joins: new Set(), things: new Set() }
    out.set(subject, known)
    if (kind === 'review') known.joins.add(identifier)
    else if (thing) known.things.add(identifier)
    else known.facts.set(kind as Fact | 'initial' | 'dated', (known.facts.get(kind as Fact | 'initial' | 'dated') ?? new Set()).add(identifier))
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
  const shared = [...a.things].filter((thing) => b.things.has(thing))
  // A name that agrees outranks two dates that one slip of the pen would make one. A father and a son of one name have two dates.
  if (policy.apart.includes('birth') && agree('birth') === false && !((agree('given') === true || shared.some((thing) => thing.startsWith('named:'))) && agree('dated') === true)) return 'birth'
  if (!policy.apart.includes('given') || agree('given') !== false || agree('birth') === true || agree('initial') === true) return undefined
  // Given again from one browser with one number, it is one person by another name.
  return shared.some((thing) => thing.startsWith('device:')) && shared.some((thing) => /^(phone|voip):/.test(thing)) ? undefined : 'given'
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
    for (const piece of split(group, links.get(id) ?? [], apart.get(id) ?? [], policy, differ, known, onCut)) {
      let cluster = piece[0]!
      for (const subject of piece) if (subject < cluster) cluster = subject
      for (const subject of piece) out.set(subject, { component: id, cluster })
    }
  }
  return out
}

function split(members: Subject[], links: readonly Pair[], apart: [Subject, Subject][], policy: Policy, differ: readonly (readonly [Subject, Subject])[] = [], known: ReadonlyMap<Subject, Known> = new Map(), onCut?: (a: Subject, b: Subject) => void): Subject[][] {
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
  for (const [a, b] of apart) for (const [x, y] of minimumCut(adjacency, a, b)) cutApart(x, y)
  // Facts come after decisions, and cut no link a decision made: two held together by those alone stay together.
  const decided = (a: Subject, b: Subject) => [...(known.get(a)?.joins ?? [])].some((identifier) => known.get(b)?.joins.has(identifier))
  for (const [a, b] of differ) cutApart(a, b)
  for (const [a, b] of differ) {
    const found = minimumCut(adjacency, a, b, decided)
    if (!found.some(([x, y]) => decided(x, y))) for (const [x, y] of found) cutApart(x, y)
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
function minimumCut(adjacency: Adjacency, source: Subject, target: Subject, firm: (a: Subject, b: Subject) => boolean = () => false): [Subject, Subject][] {
  const piece = reach(adjacency, source)
  if (!piece.has(target)) return []
  const residual = new Map<Subject, Map<Subject, number>>()
  for (const node of piece) {
    residual.set(node, new Map([...adjacency.get(node)!].map(([next, score]) => [next, firm(node, next) ? FIRM : strength(score)])))
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
