import { createMemoryOutbox } from './outbox.ts'
import type { Store, Tx } from './store.ts'
import type { Consent, Decision, Edge, FlowEdge, Identifier, IdentifierState, Labels, Sighting, Subject, Touch } from './types.ts'

/**
 * Keeps the graph in process memory. Writes run one at a time; a write that
 * throws is not rolled back, so use it for tests, demos, and small graphs.
 */
export function createMemoryStore(): Store {
  const bySubject = new Map<Subject, Map<Identifier, Edge>>()
  const byIdentifier = new Map<Identifier, Map<Subject, Edge>>()
  const ignored = new Set<Identifier>()
  const labels = new Map<Subject, Labels>()
  const byComponent = new Map<Subject, Set<Subject>>()
  const byCluster = new Map<Subject, Set<Subject>>()
  const sightings = new Map<Subject, Sighting[]>()
  const touches = new Map<Subject, Touch[]>()
  const separated = new Map<Subject, Set<Subject>>()
  const flows = new Map<string, FlowEdge>()
  const flowsBy = new Map<Subject, Set<string>>()
  const consents = new Map<Subject, Consent>()
  const decisions: Decision[] = []

  const index = (groups: Map<Subject, Set<Subject>>, key: Subject, subject: Subject) => {
    const group = groups.get(key)
    if (group) group.add(subject)
    else groups.set(key, new Set([subject]))
  }
  const unindex = (groups: Map<Subject, Set<Subject>>, key: Subject, subject: Subject) => {
    const group = groups.get(key)
    if (!group) return
    group.delete(subject)
    if (group.size === 0) groups.delete(key)
  }
  const assign = (subject: Subject, next: Labels | undefined) => {
    const before = labels.get(subject)
    if (before) {
      unindex(byComponent, before.component, subject)
      unindex(byCluster, before.cluster, subject)
    }
    if (!next) return void labels.delete(subject)
    labels.set(subject, { ...next })
    index(byComponent, next.component, subject)
    index(byCluster, next.cluster, subject)
  }

  const tx: Tx = {
    async addSightings(rows) {
      const added = new Map<Identifier, number>()
      for (const sighting of rows) {
        const { subject, identifier, at } = sighting
        const log = sightings.get(subject)
        if (log) log.push(sighting)
        else sightings.set(subject, [sighting])
        if (!labels.has(subject)) assign(subject, { component: subject, cluster: subject })

        let edges = bySubject.get(subject)
        if (!edges) bySubject.set(subject, (edges = new Map()))
        const edge = edges.get(identifier)
        if (edge) {
          edge.first = Math.min(edge.first, at)
          edge.last = Math.max(edge.last, at)
          edge.count += 1
          continue
        }
        const fresh: Edge = { subject, identifier, first: at, last: at, count: 1 }
        edges.set(identifier, fresh)
        let holders = byIdentifier.get(identifier)
        if (!holders) byIdentifier.set(identifier, (holders = new Map()))
        holders.set(subject, fresh)
        added.set(identifier, (added.get(identifier) ?? 0) + 1)
      }
      return added
    },

    async removeSubject(subject) {
      for (const identifier of bySubject.get(subject)?.keys() ?? []) {
        const holders = byIdentifier.get(identifier)!
        holders.delete(subject)
        if (holders.size === 0) byIdentifier.delete(identifier)
      }
      bySubject.delete(subject)
      sightings.delete(subject)
      touches.delete(subject)
      assign(subject, undefined)
      for (const other of separated.get(subject) ?? []) unindex(separated, other, subject)
      separated.delete(subject)
      for (const key of flowsBy.get(subject) ?? []) {
        const flow = flows.get(key)!
        unindex(flowsBy, flow.from === subject ? flow.to : flow.from, key)
        flows.delete(key)
      }
      flowsBy.delete(subject)
      consents.delete(subject)
    },

    async edgesOf(subjects) {
      return subjects.flatMap((subject) => [...(bySubject.get(subject)?.values() ?? [])].map(copy))
    },

    async edgesOn(identifiers) {
      return identifiers.flatMap((identifier) => [...(byIdentifier.get(identifier)?.values() ?? [])].map(copy))
    },

    async allEdges() {
      return [...bySubject.values()].flatMap((edges) => [...edges.values()].map(copy))
    },

    async states(identifiers) {
      const out = new Map<Identifier, IdentifierState>()
      for (const identifier of identifiers) {
        const fanout = byIdentifier.get(identifier)?.size ?? 0
        if (fanout > 0 || ignored.has(identifier)) out.set(identifier, { fanout, ignored: ignored.has(identifier) })
      }
      return out
    },

    async setIgnored(identifier, flag) {
      if (flag) ignored.add(identifier)
      else ignored.delete(identifier)
    },

    async labelsOf(subjects) {
      const out = new Map<Subject, Labels>()
      for (const subject of subjects) {
        const found = labels.get(subject)
        if (found) out.set(subject, { ...found })
      }
      return out
    },

    async membersOf(components) {
      const out = new Map<Subject, Labels>()
      for (const id of components) for (const subject of byComponent.get(id) ?? []) out.set(subject, { ...labels.get(subject)! })
      return out
    },

    async clusterOf(cluster) {
      return [...(byCluster.get(cluster) ?? [])]
    },

    async largestClusters(limit) {
      return [...byCluster]
        .filter(([, group]) => group.size > 1)
        .map(([id, group]) => ({ id, size: group.size }))
        .sort((x, y) => y.size - x.size || (x.id < y.id ? -1 : 1))
        .slice(0, limit)
    },

    async allLabels() {
      return new Map([...labels].map(([subject, found]) => [subject, { ...found }]))
    },

    async setLabels(next) {
      for (const [subject, found] of next) assign(subject, found)
    },

    async setSeparated(a, b, flag) {
      if (flag) {
        index(separated, a, b)
        index(separated, b, a)
      } else {
        unindex(separated, a, b)
        unindex(separated, b, a)
      }
    },

    async separatedOf(subjects) {
      const out = new Map<string, [Subject, Subject]>()
      for (const subject of subjects) {
        for (const other of separated.get(subject) ?? []) {
          const pair: [Subject, Subject] = subject < other ? [subject, other] : [other, subject]
          out.set(pair.join('\u0000'), pair)
        }
      }
      return [...out.values()]
    },

    async addFlow({ from, to, amount, at, asset }) {
      const key = [from, to, asset].join('\u0000')
      const flow = flows.get(key)
      if (flow) {
        flow.count += 1
        flow.total += amount
        flow.first = Math.min(flow.first, at)
        flow.last = Math.max(flow.last, at)
        return
      }
      flows.set(key, { from, to, asset, count: 1, total: amount, first: at, last: at })
      index(flowsBy, from, key)
      index(flowsBy, to, key)
    },

    async flowsOf(subjects) {
      const keys = new Set<string>()
      for (const subject of subjects) for (const key of flowsBy.get(subject) ?? []) keys.add(key)
      return [...keys].map((key) => ({ ...flows.get(key)! }))
    },

    async setConsent(subject, consent) {
      consents.set(subject, { ...consent })
    },

    async consentOf(subjects) {
      const out = new Map<Subject, Consent>()
      for (const subject of subjects) {
        const consent = consents.get(subject)
        if (consent) out.set(subject, { ...consent })
      }
      return out
    },

    async addTouch(touch) {
      const list = touches.get(touch.subject)
      if (list) list.push({ ...touch })
      else touches.set(touch.subject, [{ ...touch }])
    },

    async touchesOf(subjects, from, to) {
      return subjects.flatMap((subject) =>
        (touches.get(subject) ?? []).filter((touch) => touch.at >= from && touch.at <= to).map((touch) => ({ ...touch })),
      )
    },

    async history(subject) {
      return [...(sightings.get(subject) ?? [])].sort((x, y) => x.at - y.at)
    },

    async sightingsUntil(at) {
      return [...sightings.values()].flatMap((log) => log.filter((sighting) => sighting.at <= at))
    },

    async addDecision(decision) {
      decisions.push({ ...decision, about: [...decision.about] })
    },

    async lastDecision() {
      return decisions.at(-1)
    },

    async decisions() {
      return decisions.map((decision) => ({ ...decision, about: [...decision.about] }))
    },
  }

  let tail: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    const run = tail.then(() => work(tx))
    tail = run.catch(() => undefined)
    return run
  }

  return { write: queue, read: queue, outbox: createMemoryOutbox() }
}

function copy(edge: Edge): Edge {
  return { ...edge }
}
