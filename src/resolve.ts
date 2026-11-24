import { evidence, usable, weigh } from './policy.ts'
import type { Policy } from './policy.ts'
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
      if (score < least) continue
      pairs.push({ a, b, score, level: score >= policy.same ? 'same' : 'related', reasons })
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

type Adjacency = Map<Subject, Map<Subject, number>>

/**
 * Splits subjects into components and, inside each, clusters.
 *
 * A component is every subject reachable over `same` pairs. A cluster is what
 * is left of a component after three kinds of cut, applied in this order:
 *
 * 1. A pair a reviewer separated is never linked directly.
 * 2. If the two are still connected through others, the weakest set of links
 *    between them is removed.
 * 3. A single link below `policy.bridge` may add one subject to a group, but
 *    may not be the only thing joining two groups of two or more. The weakest
 *    such link is removed, then the next, until none is left.
 *
 * Pure, and the result does not depend on the order of its inputs.
 */
export function partition(
  subjects: Iterable<Subject>,
  pairs: readonly Pair[],
  separated: readonly (readonly [Subject, Subject])[],
  policy: Policy,
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

  const out = new Map<Subject, Labels>()
  for (const [id, group] of members) {
    if (group.length === 1) {
      out.set(id, { component: id, cluster: id })
      continue
    }
    for (const piece of split(group, links.get(id) ?? [], apart.get(id) ?? [], policy)) {
      let cluster = piece[0]!
      for (const subject of piece) if (subject < cluster) cluster = subject
      for (const subject of piece) out.set(subject, { component: id, cluster })
    }
  }
  return out
}

function split(members: Subject[], links: readonly Pair[], apart: [Subject, Subject][], policy: Policy): Subject[][] {
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
  for (const [a, b] of apart) cut(a, b)
  for (const [a, b] of apart) for (const [x, y] of minimumCut(adjacency, a, b)) cut(x, y)

  if (policy.bridge > policy.same) {
    for (let weak = weakestBridge(adjacency, policy.bridge); weak; weak = weakestBridge(adjacency, policy.bridge)) cut(weak[0], weak[1])
  }
  return pieces(adjacency)
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

/**
 * The cheapest set of links whose removal disconnects `source` from `target`,
 * by maximum flow. Of all cheapest cuts it returns the one nearest `source`,
 * which is unique, so the answer does not depend on search order.
 */
function minimumCut(adjacency: Adjacency, source: Subject, target: Subject): [Subject, Subject][] {
  const piece = reach(adjacency, source)
  if (!piece.has(target)) return []
  const residual = new Map<Subject, Map<Subject, number>>()
  for (const node of piece) {
    residual.set(node, new Map([...adjacency.get(node)!].map(([next, score]) => [next, strength(score)])))
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
