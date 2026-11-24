import { createMemoryOutbox } from './outbox.ts'
import { standingFirst } from './store.ts'
import type { Store, Tx } from './store.ts'
import type { Consent, ConsentAnswer, Cost, Counted, Decision, Edge, FlowEdge, Identifier, IdentifierState, Labels, Moved, Sighting, Subject, Touch } from './types.ts'

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
  const consents = new Map<Subject, ConsentAnswer[]>()
  const decisions: Decision[] = []
  const outcomes = new Map<string, Counted>()
  const costs = new Map<string, Required<Cost>>()
  const moves: Moved[] = []
  let writes = 0
  let built: string | undefined

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
      for (const [id, outcome] of outcomes) if (outcome.subject === subject) outcomes.delete(id)
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
      for (let i = moves.length - 1; i >= 0; i--) if (moves[i]!.subject === subject) moves.splice(i, 1)
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

    async counts() {
      const count = (groups: Map<unknown, { length: number }>) => [...groups.values()].reduce((sum, group) => sum + group.length, 0)
      return {
        subjects: labels.size,
        clusters: byCluster.size,
        identifiers: byIdentifier.size,
        edges: [...bySubject.values()].reduce((sum, edges) => sum + edges.size, 0),
        sightings: count(sightings),
        touches: count(touches),
        decisions: decisions.length,
        outcomes: outcomes.size,
      }
    },

    async version() {
      return writes
    },

    async largestClusters(limit, offset = 0) {
      return [...byCluster]
        .filter(([, group]) => group.size > 1)
        .map(([id, group]) => ({ id, size: group.size }))
        .sort((x, y) => y.size - x.size || (x.id < y.id ? -1 : 1))
        .slice(offset, offset + limit)
    },

    async subjectsStarting(text, limit) {
      return [...labels.keys()].filter((subject) => subject.startsWith(text)).sort().slice(0, limit)
    },

    async addChanges(at, changes) {
      for (const change of changes) moves.push({ ...change, at })
    },

    async recentChanges(limit) {
      return moves.slice(Math.max(0, moves.length - limit)).reverse().map((move) => ({ ...move }))
    },

    async empty() {
      return labels.size === 0
    },

    async builtWith() {
      return built
    },

    async setBuiltWith(hash) {
      built = hash
    },

    async kinds() {
      return [...new Set([...byIdentifier.keys()].map((identifier) => identifier.slice(0, identifier.indexOf(':'))))].sort()
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

    async addConsent(subject, answer) {
      const answers = consents.get(subject)
      if (answers) answers.push({ ...answer })
      else consents.set(subject, [{ ...answer }])
    },

    async consentOf(subjects) {
      const out = new Map<Subject, Consent>()
      for (const subject of subjects) {
        const [standing] = [...(consents.get(subject) ?? [])].sort(standingFirst)
        if (standing) out.set(subject, { adUserData: standing.adUserData, adPersonalization: standing.adPersonalization })
      }
      return out
    },

    async consentHistory(subject) {
      return (consents.get(subject) ?? []).map((answer) => ({ ...answer })).sort(standingFirst)
    },

    async pruneConsent(before) {
      let gone = 0
      for (const [subject, answers] of consents) {
        const [standing, ...rest] = [...answers].sort(standingFirst)
        const kept = [standing!, ...rest.filter((answer) => answer.recorded >= before)]
        gone += answers.length - kept.length
        consents.set(subject, kept)
      }
      return gone
    },

    async addTouch(touch) {
      const list = touches.get(touch.subject)
      if (list) list.push(structuredClone(touch))
      else touches.set(touch.subject, [structuredClone(touch)])
    },

    async touchesOf(subjects, from, to) {
      return subjects.flatMap((subject) =>
        (touches.get(subject) ?? []).filter((touch) => touch.at >= from && touch.at <= to).map((touch) => structuredClone(touch)),
      )
    },

    async touchesBetween(from, to) {
      const found = [...touches.values()].flatMap((list) => list.filter((touch) => touch.at >= from && touch.at < to).map((touch) => structuredClone(touch)))
      return found.sort((x, y) => x.at - y.at)
    },

    async setOutcome(outcome) {
      outcomes.set(outcome.transactionId, { ...outcome })
    },

    async outcomeOf(transactionId) {
      const found = outcomes.get(transactionId)
      return found && { ...found }
    },

    async outcomesBetween(from, to) {
      return [...outcomes.values()]
        .filter((outcome) => outcome.at >= from && outcome.at < to)
        .sort((x, y) => x.at - y.at || (x.transactionId < y.transactionId ? -1 : 1))
        .map((outcome) => ({ ...outcome }))
    },

    async addCosts(rows) {
      for (const cost of rows) costs.set([cost.day, cost.source, cost.campaignId].join('\u0000'), { ...cost })
    },

    async costsBetween(from, to) {
      const key = (cost: Required<Cost>) => [cost.day, cost.source, cost.campaignId].join('\u0000')
      return [...costs.values()].filter((cost) => cost.day >= from && cost.day <= to).sort((x, y) => (key(x) < key(y) ? -1 : 1)).map((cost) => ({ ...cost }))
    },

    async history(subject, limit) {
      const all = [...(sightings.get(subject) ?? [])].sort((x, y) => x.at - y.at)
      return limit === undefined ? all : all.slice(Math.max(0, all.length - limit))
    },

    async sightingsUntil(recorded) {
      return [...sightings.values()].flatMap((log) => log.filter((sighting) => (sighting.recorded ?? sighting.at) <= recorded))
    },

    async pruneSightings(before) {
      let gone = 0
      for (const [subject, log] of sightings) {
        const kept = log.filter((sighting) => (sighting.recorded ?? sighting.at) >= before)
        gone += log.length - kept.length
        if (kept.length > 0) sightings.set(subject, kept)
        else sightings.delete(subject)
      }
      return gone
    },

    async addDecision(decision) {
      decisions.push({ ...decision, about: [...decision.about] })
    },

    async lastDecision() {
      return decisions.at(-1)
    },

    async decisions() {
      return decisions.map(copied)
    },

    async decisionPage({ before = Infinity, limit, author }) {
      const wanted = (decision: Decision) =>
        decision.seq < before && (author === undefined || (author === 'people' ? !bySystem(decision) : author === 'system' ? bySystem(decision) : decision.by === author))
      return decisions.filter(wanted).slice(-limit).reverse().map(copied)
    },

    async decisionsAbout(pairs) {
      const wanted = new Set(pairs.map((pair) => pair.join('\u0000')))
      return decisions.filter((decision) => ofPair(decision) && wanted.has(decision.about.join('\u0000'))).map(copied)
    },

    async pairsDecidedBySystems(times) {
      const found = new Map<string, number>()
      for (const decision of decisions) {
        if (!ofPair(decision) || !bySystem(decision)) continue
        const key = decision.about.join('\u0000')
        found.set(key, (found.get(key) ?? 0) + 1)
      }
      return [...found].filter(([, count]) => count >= times).map(([key]) => key.split('\u0000') as [Subject, Subject])
    },
  }

  let tail: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    const run = tail.then(() => work(tx))
    tail = run.catch(() => undefined)
    return run
  }

  return { write: (work) => queue((bound) => (writes += 1, work(bound))), read: queue, outbox: createMemoryOutbox() }
}

const copied = (decision: Decision): Decision => ({ ...decision, about: [...decision.about] })
const bySystem = (decision: Decision) => decision.by?.startsWith('system:') ?? false
const ofPair = (decision: Decision) => decision.action === 'join' || decision.action === 'separate' || decision.action === 'rejoin'

function copy(edge: Edge): Edge {
  return { ...edge }
}
