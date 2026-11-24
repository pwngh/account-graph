import { createMemoryOps } from './ops.ts'
import { createMemoryOutbox } from './outbox.ts'
import { standingFirst } from './store.ts'
import type { Store, Tx } from './store.ts'
import { CLICK_IDS } from './touch.ts'
import type { CallResult, Consent, ConsentAnswer, CostRow, Counted, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, KeptCall, Labels, Lease, Moved, NotLead, NumberedChange, OutcomeValue, Sighting, Subject, Touch } from './types.ts'

/**
 * Keeps the graph in process memory. Writes run one at a time; a write that
 * throws is not rolled back, so use it for tests, demos, and small graphs.
 */
export function createMemoryStore(): Store {
  const outbox = createMemoryOutbox()
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
  const flowIds = new Map<string, Required<Flow>>()
  const consents = new Map<Subject, ConsentAnswer[]>()
  const decisions: Decision[] = []
  const outcomes = new Map<string, Counted>()
  const values = new Map<Subject, Map<string, OutcomeValue[]>>()
  const calls = new Map<string, Omit<KeptCall, 'result'>>()
  const results = new Map<string, CallResult>()
  const spurned = new Map<string, NotLead>()
  /** By number, the one that began first, first. */
  const leases = new Map<string, Lease[]>()
  const costs = new Map<string, CostRow>()
  const moves: NumberedChange[] = []
  let lastMove = 0
  let writes = 0
  const ops = createMemoryOps()
  let built: string | undefined

  const withResult = (call: Omit<KeptCall, 'result'>): KeptCall => structuredClone({ ...call, ...(results.has(call.id) && { result: results.get(call.id)! }) })

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
      const jobs = await outbox.remove(subject)
      for (const identifier of bySubject.get(subject)?.keys() ?? []) {
        const holders = byIdentifier.get(identifier)!
        holders.delete(subject)
        if (holders.size === 0) byIdentifier.delete(identifier)
      }
      bySubject.delete(subject)
      sightings.delete(subject)
      touches.delete(subject)
      for (const [id, outcome] of outcomes) {
        if (outcome.subject !== subject) continue
        outcomes.delete(id)
        spurned.delete(id)
      }
      values.delete(subject)
      for (const [id, call] of calls) {
        if (call.subject === subject) {
          calls.delete(id)
          results.delete(id)
          spurned.delete(`call:${id}`)
        } else if (call.visitor === subject) delete call.visitor
      }
      assign(subject, undefined)
      for (const other of separated.get(subject) ?? []) unindex(separated, other, subject)
      separated.delete(subject)
      for (const key of flowsBy.get(subject) ?? []) {
        const flow = flows.get(key)!
        unindex(flowsBy, flow.from === subject ? flow.to : flow.from, key)
        flows.delete(key)
      }
      flowsBy.delete(subject)
      for (const [id, flow] of flowIds) if (flow.from === subject || flow.to === subject) flowIds.delete(id)
      // Who held a number is forgotten. That somebody did stays, or a call in that time would go to whoever held it before.
      for (const held of leases.values()) for (const lease of held) if (lease.subject === subject) lease.subject = ''
      consents.delete(subject)
      ops.forget(subject)
      for (let i = moves.length - 1; i >= 0; i--) if (moves[i]!.subject === subject) moves.splice(i, 1)
      return jobs
    },

    async edgesOf(subjects) {
      return subjects.flatMap((subject) => [...(bySubject.get(subject)?.values() ?? [])].map(copy))
    },

    async edgesOn(identifiers) {
      return identifiers.flatMap((identifier) => [...(byIdentifier.get(identifier)?.values() ?? [])].map(copy))
    },

    async *sharing(caps) {
      const pairs = new Map<string, { a: Edge; b: Edge; fanout: number }[]>()
      for (const [identifier, holders] of byIdentifier) {
        const kind = identifier.slice(0, identifier.indexOf(':'))
        if (ignored.has(identifier) || holders.size < 2) continue
        if (!Object.hasOwn(caps, kind)) throw new TypeError(`Identifier "${identifier}" has a kind that is missing from the policy`)
        if (holders.size > caps[kind]!) continue
        const edges = [...holders.values()]
        for (const [i, x] of edges.entries()) {
          for (const y of edges.slice(i + 1)) {
            const [a, b] = x.subject < y.subject ? [x, y] : [y, x]
            const key = `${a.subject}\u0000${b.subject}`
            const shared = pairs.get(key)
            if (shared) shared.push({ a: copy(a), b: copy(b), fanout: holders.size })
            else pairs.set(key, [{ a: copy(a), b: copy(b), fanout: holders.size }])
          }
        }
      }
      yield [...pairs.values()]
    },

    async *everyone() {
      yield [...new Set([...labels.keys(), ...bySubject.keys()])].map((subject) => ({ subject, labels: labels.get(subject), held: (bySubject.get(subject)?.size ?? 0) > 0 }))
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
      for (const change of changes) moves.push({ ...change, at, seq: ++lastMove })
    },

    async recentChanges(limit) {
      return moves.slice(Math.max(0, moves.length - limit)).reverse().map(({ seq: _, ...move }) => move)
    },

    async changesAfter(seq, limit) {
      return moves.filter((move) => move.seq > seq).slice(0, limit).map((move) => ({ ...move }))
    },

    async fed(feed, at) {
      ops.fed(feed, at)
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

    async flowOf(id) {
      const flow = flowIds.get(id)
      return flow && { ...flow }
    },

    async addFlow({ id, from, to, amount, at, asset }) {
      flowIds.set(id, { id, from, to, amount, at, asset })
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

    async consentHistory(subject, limit) {
      return (consents.get(subject) ?? []).map((answer) => ({ ...answer })).sort(standingFirst).slice(0, limit)
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

    async clicked(id, limit) {
      return [...touches].filter(([, list]) => list.some((touch) => CLICK_IDS.some((name) => touch[name] === id))).map(([subject]) => subject).sort().slice(0, limit)
    },

    async touchesBetween(from, to) {
      const found = [...touches.values()].flatMap((list) => list.filter((touch) => touch.at >= from && touch.at < to).map((touch) => structuredClone(touch)))
      return found.sort((x, y) => x.at - y.at)
    },

    async setOutcome(outcome) {
      outcomes.set(outcome.transactionId, structuredClone(outcome))
    },

    async outcomeOf(transactionId) {
      const found = outcomes.get(transactionId)
      return found && structuredClone(found)
    },

    async addValue(transactionId, subject, value) {
      let own = values.get(subject)
      if (!own) values.set(subject, (own = new Map()))
      own.set(transactionId, [...(own.get(transactionId) ?? []), { ...value }])
    },

    async valuesOf(transactionId, subject) {
      return (values.get(subject)?.get(transactionId) ?? []).map((value) => ({ ...value }))
    },

    async firstValues(given) {
      return new Map(
        given.flatMap(({ transactionId, subject }) => {
          const [first, ...rest] = values.get(subject)?.get(transactionId) ?? []
          if (!first) return []
          const lost = { refund: 0, write_off: 0 }
          const lostIn: string[] = []
          let before = first
          for (const each of rest) {
            if (each.kind) {
              lost[each.kind] += before.value - each.value
              lostIn.push(each.currency)
            }
            before = each
          }
          return [[transactionId, { ...first, most: rest.reduce((most, each) => Math.max(most, each.value), first.value), refunded: lost.refund, writtenOff: lost.write_off, lostIn }]]
        }),
      )
    },

    async removeOutcome(transactionId) {
      outcomes.delete(transactionId)
    },

    async setCall(call) {
      calls.set(call.id, structuredClone(call))
    },

    async setCallResult(id, result) {
      results.set(id, { ...result })
    },

    async notLeads(ids) {
      return new Map(ids.flatMap((id) => (spurned.has(id) ? [[id, { ...spurned.get(id)! }] as const] : [])))
    },

    async setNotLead(id, said) {
      if (said) spurned.set(id, { ...said })
      else spurned.delete(id)
    },

    async pruneNotLeads(before) {
      let gone = 0
      for (const [id, { at }] of spurned) if (at < before && !outcomes.has(id) && !(id.startsWith('call:') && calls.has(id.slice(5)))) gone += Number(spurned.delete(id))
      return gone
    },

    async removeCallResult(id) {
      results.delete(id)
    },

    async callOf(id) {
      const call = calls.get(id)
      return call && withResult(call)
    },

    async callResultOf(id) {
      const result = results.get(id)
      return result && { ...result }
    },

    async callsOf(subjects) {
      const wanted = new Set(subjects)
      return [...calls.values()].filter((call) => wanted.has(call.subject)).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map(withResult)
    },

    async openCalls(from, to, limit, after) {
      const answered = new Map<Subject, number>()
      // When each was last spoken to, by a call answered or by a return reported for one of theirs.
      for (const call of calls.values()) {
        // What was no lead is no conversation with them either.
        if (spurned.has(`call:${call.id}`)) continue
        const { answered: spoke, returned = -Infinity } = results.get(call.id) ?? {}
        // A return reported for a call that was not missed, or that began after it, says nothing.
        const told = call.direction === 'inbound' && spoke === false && returned > call.at ? returned : -Infinity
        answered.set(call.subject, Math.max(spoke ? call.at : -Infinity, told, answered.get(call.subject) ?? -Infinity))
      }
      const open = [...calls.values()].filter((call) => {
        if (call.direction !== 'inbound' || call.at < from || call.at >= to || results.get(call.id)?.answered !== false || call.subject === `call:${call.id}` || spurned.has(`call:${call.id}`)) return false
        if (after && !(call.at > after.at || (call.at === after.at && call.id > after.id))) return false
        return (answered.get(call.subject) ?? -Infinity) <= call.at
      })
      return open.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).slice(0, limit).map(withResult)
    },

    async callsBetween(from, to) {
      const found = [...calls.values()].filter((call) => call.at >= from && call.at < to)
      return found.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map(withResult)
    },

    async newestLeases(numbers, by) {
      return numbers.flatMap((number) => leases.get(number)?.filter((lease) => lease.start <= by).slice(-1) ?? []).map((lease) => ({ ...lease }))
    },

    async setLease(lease) {
      const others = (leases.get(lease.number) ?? []).filter((each) => each.start !== lease.start)
      leases.set(lease.number, [...others, { ...lease }].sort((x, y) => x.start - y.start))
    },

    async pruneLeases(before) {
      let gone = 0
      for (const [number, held] of leases) {
        const kept = held.filter((lease) => lease.until >= before)
        gone += held.length - kept.length
        leases.set(number, kept)
      }
      return gone
    },

    async pruneCallResults(before) {
      let gone = 0
      for (const [id, result] of results) if (!calls.has(id) && result.recorded < before) gone += Number(results.delete(id))
      return gone
    },

    async outcomesBetween(from, to) {
      return [...outcomes.values()]
        .filter((outcome) => outcome.at >= from && outcome.at < to)
        .sort((x, y) => x.at - y.at || (x.transactionId < y.transactionId ? -1 : 1))
        .map((outcome) => structuredClone(outcome))
    },

    async outcomesOf(subjects) {
      const wanted = new Set(subjects)
      return [...outcomes.values()].filter((outcome) => wanted.has(outcome.subject)).sort((x, y) => x.at - y.at || (x.transactionId < y.transactionId ? -1 : 1)).map((outcome) => structuredClone(outcome))
    },

    async newestOutcomes(from, to, each) {
      const counts = new Map<string, number>()
      const newest = [...outcomes.values()].filter((outcome) => outcome.at >= from && outcome.at < to).sort((x, y) => y.at - x.at || (x.transactionId < y.transactionId ? 1 : -1))
      return newest
        .filter(({ stage }) => {
          counts.set(stage, (counts.get(stage) ?? 0) + 1)
          return counts.get(stage)! <= each
        })
        .map((outcome) => structuredClone(outcome))
    },

    async addCosts(rows) {
      for (const cost of rows) costs.set([cost.day, cost.source, cost.campaignId].join('\u0000'), { ...cost })
    },

    async costsBetween(from, to) {
      const key = (cost: CostRow) => [cost.day, cost.source, cost.campaignId].join('\u0000')
      return [...costs.values()].filter((cost) => cost.day >= from && cost.day <= to).sort((x, y) => (key(x) < key(y) ? -1 : 1)).map((cost) => ({ ...cost }))
    },

    async history(subject, limit) {
      const all = [...(sightings.get(subject) ?? [])].sort((x, y) => x.at - y.at)
      return limit === undefined ? all : all.slice(Math.max(0, all.length - limit))
    },

    async latelySeen(newest) {
      const all = [...sightings.values()].flat().sort((x, y) => (y.recorded ?? y.at) - (x.recorded ?? x.at) || (x.subject < y.subject ? -1 : 1))
      return [...new Set(all.slice(0, newest).map((sighting) => sighting.subject))]
    },

    async *sightingsUntil(recorded) {
      yield [...sightings.values()].flatMap((log) => log.filter((sighting) => (sighting.recorded ?? sighting.at) <= recorded))
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

    async decisionsNaming(subjects) {
      const wanted = new Set(subjects)
      return decisions.filter((decision) => decision.action !== 'ignore' && decision.action !== 'restore' && decision.action !== 'prune' && decision.about.some((each) => wanted.has(each))).map(copied)
    },

    async newestNaming(names, after, among) {
      const found = decisions.findLast((decision) => decision.seq > after && decision.action !== 'prune' && (!among || among.includes(decision.action)) && decision.about.some((each) => names.includes(each)))
      return found && copied(found)
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

  return { write: (work) => queue((bound) => (writes += 1, work(bound))), read: queue, outbox, ops }
}

const copied = (decision: Decision): Decision => ({ ...decision, about: [...decision.about] })
const bySystem = (decision: Decision) => decision.by?.startsWith('system:') ?? false
const ofPair = (decision: Decision) => decision.action === 'join' || decision.action === 'separate' || decision.action === 'rejoin'

function copy(edge: Edge): Edge {
  return { ...edge }
}
