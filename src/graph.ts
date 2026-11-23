import { brokenAt, seal } from './audit.ts'
import { createMemoryStore } from './memory.ts'
import { defaultPolicy, ruleFor, usable } from './policy.ts'
import type { Policy } from './policy.ts'
import { partition, scorePairs } from './resolve.ts'
import type { Store, Tx } from './store.ts'
import type {
  Attribution,
  AttributedTouch,
  Change,
  Cluster,
  Consent,
  Counterparty,
  Decision,
  Flow,
  Identifier,
  Labels,
  Link,
  Observation,
  Sighting,
  Subject,
  Touch,
  Why,
} from './types.ts'

export interface AttributeOptions {
  /** When the conversion happened, in epoch milliseconds. */
  at: number
  /** How far back a touch may be. Defaults to 90 days. */
  window?: number
  /** How many links a touch may be from the converting subject. Defaults to 2. */
  hops?: number
}

export interface GraphOptions {
  /**
   * Called after a write commits, with the subjects whose cluster moved.
   * Use it to alert a reviewer or hold a payout. A throw here is logged and
   * never undoes the write.
   */
  onChange?: (changes: Change[]) => void | Promise<void>
  /** The clock that stamps decisions. */
  now?: () => number
}

export interface Graph {
  /** Records observations and returns every subject whose cluster moved. */
  observe(input: Observation | readonly Observation[]): Promise<Change[]>
  /** Every subject linked to this one, strongest first, with the reasons. Computed from edges on each call. */
  links(subject: Subject): Promise<Link[]>
  /** The cluster a subject belongs to, or undefined for a subject never observed. */
  cluster(subject: Subject): Promise<Cluster | undefined>
  /** Records a marketing touchpoint. */
  touch(touch: Touch): Promise<void>
  /** Finds the touches that led to a conversion by this subject. */
  attribute(subject: Subject, options: AttributeOptions): Promise<Attribution>
  /** Stops, or with `false` resumes, linking through one identifier. */
  ignore(identifier: Identifier, ignored?: boolean, why?: Why): Promise<Change[]>
  /**
   * Records a reviewer's decision that two subjects are different people, or
   * with `false` withdraws it. The two never share a cluster while it stands,
   * whatever they share later.
   */
  separate(a: Subject, b: Subject, separated?: boolean, why?: Why): Promise<Change[]>
  /** Records the advertising consent a subject gave. The outbox honours it. */
  consent(subject: Subject, consent: Consent): Promise<void>
  /** The latest consent of each given subject. A subject that never answered is absent. */
  consentOf(subjects: readonly Subject[]): Promise<Map<Subject, Consent>>
  /** Records a reviewer's decision that two subjects are one person. They join one cluster unless separated. */
  join(a: Subject, b: Subject, why?: Why): Promise<Change[]>
  /** The subjects a reviewer has separated from this one. */
  separations(subject: Subject): Promise<Subject[]>
  /** The clusters with two or more members, largest first: where a reviewer should look. */
  clusters(limit?: number): Promise<{ id: Subject; size: number; oversized: boolean }[]>
  /** Records value moving between two subjects, and says how the two are tied by identity. */
  transfer(flow: Flow): Promise<Counterparty>
  /** Everyone a subject has exchanged value with, largest volume first. */
  flows(subject: Subject): Promise<Counterparty[]>
  /** The counterparties tied to this subject by identity, with at least `count` flows between them. */
  collusion(subject: Subject, count?: number): Promise<Counterparty[]>
  /** Deletes a subject and everything recorded about it, unsent conversions included. */
  forget(subject: Subject, why?: Why): Promise<Change[]>
  /** Every sighting of a subject, oldest first. */
  history(subject: Subject): Promise<Sighting[]>
  /** Recomputes every cluster from edges. Run it after changing the policy. */
  rebuild(why?: Why): Promise<Change[]>
  /** Every decision people made about the graph, oldest first: what was ignored, separated, forgotten, and by whom. */
  decisions(): Promise<Decision[]>
  /** Checks that the record of decisions is whole and unaltered. `brokenAt` names the first entry that does not fit. */
  audit(): Promise<{ sound: boolean; brokenAt?: number }>
  /**
   * The graph as it stood at a time: a copy in memory, built from the
   * sightings and decisions up to then. Each sighting counts from its own
   * time, and a forgotten subject is gone from every past.
   */
  asOf(at: number): Promise<Graph>
  /** Compares stored clusters with a full recompute. Empty when they agree. */
  verify(): Promise<Change[]>
}

const DAY = 86_400_000
const pairKey = (a: Subject, b: Subject) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

export function createGraph(store: Store, policy: Policy = defaultPolicy, options: GraphOptions = {}): Graph {
  /** Components and clusters of the given subjects, from their edges and the reviewer's separations. */
  async function compute(tx: Tx, subjects: readonly Subject[]): Promise<Map<Subject, Labels>> {
    const edges = await tx.edgesOf(subjects)
    const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
    const among = new Set(subjects)
    const separated = (await tx.separatedOf(subjects)).filter(([a, b]) => among.has(a) && among.has(b))
    return partition(subjects, scorePairs(policy, edges, states), separated, policy)
  }

  /**
   * Recomputes the components of `affected` subjects. Sound when `affected`
   * holds both ends of every pair whose score the current write changed: any
   * other `same` pair that reaches into this set was already `same`, so its
   * far end is in one of these components. Clusters are cut from whole
   * components, which is why components, not clusters, bound the work.
   */
  async function settle(tx: Tx, affected: ReadonlySet<Subject>): Promise<Change[]> {
    const own = await tx.labelsOf([...affected])
    const stored = await tx.membersOf(unique([...own.values()].map((labels) => labels.component)))
    return apply(tx, stored, await compute(tx, [...stored.keys()]))
  }

  async function apply(tx: Tx, stored: ReadonlyMap<Subject, Labels>, next: ReadonlyMap<Subject, Labels>): Promise<Change[]> {
    const moved = new Map<Subject, Labels>()
    for (const [subject, labels] of next) {
      const before = stored.get(subject)
      if (!before || before.component !== labels.component || before.cluster !== labels.cluster) moved.set(subject, labels)
    }
    if (moved.size > 0) await tx.setLabels(moved)
    return diff(stored, next).filter((change) => change.from !== change.to)
  }

  async function recompute(tx: Tx): Promise<Map<Subject, Labels>> {
    const edges = await tx.allEdges()
    return compute(tx, unique(edges.map((edge) => edge.subject)))
  }

  /** Links of each given subject, scored from edges. A pair a reviewer separated is not a link. */
  async function neighbors(tx: Tx, subjects: readonly Subject[]): Promise<Map<Subject, Link[]>> {
    const own = await tx.edgesOf(subjects)
    const identifiers = unique(own.map((edge) => edge.identifier))
    const states = await tx.states(identifiers)
    const open = identifiers.filter((identifier) => usable(policy, identifier, states.get(identifier)))
    const apart = new Set((await tx.separatedOf(subjects)).map(([a, b]) => pairKey(a, b)))
    const from = new Set(subjects)
    const out = new Map<Subject, Link[]>()
    const add = (subject: Subject, link: Link) => {
      if (!from.has(subject)) return
      const links = out.get(subject)
      if (links) links.push(link)
      else out.set(subject, [link])
    }
    for (const { a, b, score, level, reasons } of scorePairs(policy, await tx.edgesOn(open), states, from)) {
      if (apart.has(pairKey(a, b))) continue
      add(a, { subject: b, score, level, reasons })
      add(b, { subject: a, score, level, reasons })
    }
    for (const links of out.values()) {
      links.sort((x, y) => y.score - x.score || (x.subject < y.subject ? -1 : 1))
    }
    return out
  }

  /** A subject's flows folded per counterparty and asset, with the identity tie to each. */
  async function counterparties(tx: Tx, subject: Subject): Promise<Counterparty[]> {
    const folded = new Map<string, Counterparty>()
    for (const flow of await tx.flowsOf([subject])) {
      const other = flow.from === subject ? flow.to : flow.from
      const key = `${other}\u0000${flow.asset}`
      let row = folded.get(key)
      if (!row) {
        row = { subject: other, asset: flow.asset, relation: 'none', score: 0, reasons: [], sent: 0, received: 0, count: 0, imbalance: 0, first: flow.first, last: flow.last }
        folded.set(key, row)
      }
      if (flow.from === subject) row.sent += flow.total
      else row.received += flow.total
      row.count += flow.count
      row.first = Math.min(row.first, flow.first)
      row.last = Math.max(row.last, flow.last)
    }
    const rows = [...folded.values()]
    const labels = await tx.labelsOf([subject, ...rows.map((row) => row.subject)])
    const links = new Map(((await neighbors(tx, [subject])).get(subject) ?? []).map((link) => [link.subject, link]))
    const home = labels.get(subject)?.cluster
    for (const row of rows) {
      const link = links.get(row.subject)
      if (link) Object.assign(row, { score: link.score, reasons: link.reasons, relation: 'related' })
      if (home !== undefined && labels.get(row.subject)?.cluster === home) row.relation = 'same'
      row.imbalance = Math.abs(row.sent - row.received) / (row.sent + row.received)
    }
    const volume = (row: Counterparty) => row.sent + row.received
    return rows.sort((x, y) => volume(y) - volume(x) || (x.subject < y.subject ? -1 : x.subject > y.subject ? 1 : x.asset < y.asset ? -1 : 1))
  }

  const now = options.now ?? Date.now

  /** Appends a decision to the record, sealed to the one before it. */
  async function decide(tx: Tx, action: Decision['action'], about: string[], why: Why | undefined): Promise<void> {
    const last = await tx.lastDecision()
    const entry = { seq: (last?.seq ?? 0) + 1, at: now(), action, about, ...(why?.by && { by: why.by }), ...(why?.reason && { reason: why.reason }) }
    await tx.addDecision({ ...entry, hash: seal(last?.hash ?? '', entry) })
  }

  /** Runs a write, then tells the listener what moved. */
  async function changing(work: (tx: Tx) => Promise<Change[]>): Promise<Change[]> {
    const changes = await store.write(work)
    if (changes.length > 0 && options.onChange) {
      try {
        await options.onChange(changes)
      } catch (error) {
        console.error(error)
      }
    }
    return changes
  }

  /** Writes sightings and recomputes the clusters they can affect. */
  async function record(tx: Tx, sightings: readonly Sighting[]): Promise<Change[]> {
    const added = await tx.addSightings(sightings)
    const touched = unique(sightings.map((sighting) => sighting.identifier))
    const states = await tx.states(touched)
    // An identifier that was public before this write linked nothing then and links nothing now.
    const open = touched.filter((identifier) => {
      const state = states.get(identifier)!
      const before = state.fanout - (added.get(identifier) ?? 0)
      return !state.ignored && before <= ruleFor(policy, identifier).cap
    })
    const affected = new Set(sightings.map((sighting) => sighting.subject))
    for (const edge of await tx.edgesOn(open)) affected.add(edge.subject)
    return settle(tx, affected)
  }

  const graph: Graph = {
    async observe(input) {
      const observations = Array.isArray(input) ? (input as readonly Observation[]) : [input as Observation]
      const sightings: Sighting[] = []
      for (const { subject, identifiers, at, event } of observations) {
        if (!subject) throw new TypeError('An observation needs a subject')
        if (!Number.isFinite(at)) throw new TypeError(`Observation of "${subject}" needs a time in epoch milliseconds`)
        for (const identifier of new Set(identifiers)) {
          ruleFor(policy, identifier)
          sightings.push(event === undefined ? { subject, identifier, at } : { subject, identifier, at, event })
        }
      }
      if (sightings.length === 0) return []

      return changing((tx) => record(tx, sightings))
    },

    links(subject) {
      return store.read(async (tx) => (await neighbors(tx, [subject])).get(subject) ?? [])
    },

    cluster(subject) {
      return store.read(async (tx) => {
        const id = (await tx.labelsOf([subject])).get(subject)?.cluster
        if (id === undefined) return undefined
        const members = (await tx.clusterOf(id)).sort()
        return { id, members, oversized: members.length > policy.review }
      })
    },

    async touch(touch) {
      if (!touch.subject) throw new TypeError('A touch needs a subject')
      if (!Number.isFinite(touch.at)) throw new TypeError('A touch needs a time in epoch milliseconds')
      await store.write((tx) => tx.addTouch(touch))
    },

    attribute(subject, { at, window = 90 * DAY, hops = 2 }) {
      return store.read(async (tx) => {
        const reached = new Map<Subject, { confidence: number; via: Subject[] }>([[subject, { confidence: 1, via: [] }]])
        let frontier = [subject]
        for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
          const links = await neighbors(tx, frontier)
          const improved = new Set<Subject>()
          for (const near of [...frontier].sort()) {
            const start = reached.get(near)!
            for (const link of links.get(near) ?? []) {
              const confidence = start.confidence * link.score
              const known = reached.get(link.subject)
              if (known && known.confidence >= confidence) continue
              reached.set(link.subject, { confidence, via: [...start.via, near] })
              improved.add(link.subject)
            }
          }
          frontier = [...improved]
        }

        const touches: AttributedTouch[] = (await tx.touchesOf([...reached.keys()], at - window, at))
          .map((touch) => ({ ...touch, ...reached.get(touch.subject)! }))
          .sort((x, y) => y.at - x.at || y.confidence - x.confidence || (x.subject < y.subject ? -1 : 1))
        const credited = touches.find((touch) => touch.confidence >= policy.same)
        const reason = credited ? 'credited' : touches.length > 0 ? 'low_confidence' : 'no_touch'
        return { subject, at, touches, credited, reason } satisfies Attribution
      })
    },

    ignore(identifier, ignored = true, why) {
      const { cap } = ruleFor(policy, identifier)
      return changing(async (tx) => {
        await decide(tx, ignored ? 'ignore' : 'restore', [identifier], why)
        const before = (await tx.states([identifier])).get(identifier)
        await tx.setIgnored(identifier, ignored)
        if (!before || before.ignored === ignored || before.fanout > cap) return []
        return settle(tx, new Set((await tx.edgesOn([identifier])).map((edge) => edge.subject)))
      })
    },

    async separate(a, b, separated = true, why) {
      if (!a || !b || a === b) throw new TypeError('separate needs two different subjects')
      return changing(async (tx) => {
        await decide(tx, separated ? 'separate' : 'rejoin', a < b ? [a, b] : [b, a], why)
        await tx.setSeparated(a, b, separated)
        return settle(tx, new Set([a, b]))
      })
    },

    async join(a, b, why) {
      if (!a || !b || a === b) throw new TypeError('join needs two different subjects')
      const pair = a < b ? [a, b] : [b, a]
      return changing(async (tx) => {
        await decide(tx, 'join', pair, why)
        const at = now()
        return record(tx, pair.map((subject) => ({ subject, identifier: `review:${pair.join('+')}`, at, event: 'review' })))
      })
    },

    separations(subject) {
      return store.read(async (tx) => (await tx.separatedOf([subject])).map(([a, b]) => (a === subject ? b : a)).sort())
    },

    clusters(limit = 50) {
      return store.read(async (tx) => (await tx.largestClusters(limit)).map((each) => ({ ...each, oversized: each.size > policy.review })))
    },

    async consent(subject, consent) {
      if (!subject) throw new TypeError('Consent needs a subject')
      if (typeof consent?.adUserData !== 'boolean' || typeof consent.adPersonalization !== 'boolean') {
        throw new TypeError('Consent needs adUserData and adPersonalization, each true or false')
      }
      await store.write((tx) => tx.setConsent(subject, { adUserData: consent.adUserData, adPersonalization: consent.adPersonalization }))
    },

    consentOf(subjects) {
      return store.read((tx) => tx.consentOf(subjects))
    },

    async transfer(flow) {
      const { from, to, amount, at } = flow
      if (!from || !to || from === to) throw new TypeError('A flow needs two different subjects')
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('A flow needs a whole, positive amount in the smallest unit')
      if (!Number.isFinite(at)) throw new TypeError('A flow needs a time in epoch milliseconds')
      const asset = flow.asset ?? ''
      return store.write(async (tx) => {
        await tx.addFlow({ from, to, amount, at, asset })
        return (await counterparties(tx, from)).find((row) => row.subject === to && row.asset === asset)!
      })
    },

    flows(subject) {
      return store.read((tx) => counterparties(tx, subject))
    },

    async collusion(subject, count = 3) {
      return (await graph.flows(subject)).filter((row) => row.relation !== 'none' && row.count >= count)
    },

    async forget(subject, why) {
      await store.outbox.remove(subject)
      return changing(async (tx) => {
        await decide(tx, 'forget', [subject], why)
        const edges = await tx.edgesOf([subject])
        const component = (await tx.labelsOf([subject])).get(subject)?.component
        const affected = new Set(component === undefined ? [] : (await tx.membersOf([component])).keys())
        await tx.removeSubject(subject)
        affected.delete(subject)
        // Losing a subject can bring an identifier back under its cap, which links the rest again.
        const identifiers = edges.map((edge) => edge.identifier)
        const states = await tx.states(identifiers)
        const open = identifiers.filter((identifier) => usable(policy, identifier, states.get(identifier)))
        for (const edge of await tx.edgesOn(open)) affected.add(edge.subject)
        return settle(tx, affected)
      })
    },

    history(subject) {
      return store.read((tx) => tx.history(subject))
    },

    rebuild(why) {
      return changing(async (tx) => {
        await decide(tx, 'rebuild', [], why)
        return apply(tx, await tx.allLabels(), await recompute(tx))
      })
    },

    decisions() {
      return store.read((tx) => tx.decisions())
    },

    async audit() {
      const broken = brokenAt(await graph.decisions())
      return broken === undefined ? { sound: true } : { sound: false, brokenAt: broken }
    },

    async asOf(at) {
      const { sightings, decisions } = await store.read(async (tx) => ({
        sightings: await tx.sightingsUntil(at),
        decisions: (await tx.decisions()).filter((decision) => decision.at <= at),
      }))
      const past = createGraph(createMemoryStore(), policy)
      for (let i = 0; i < sightings.length; i += 1000) {
        await past.observe(sightings.slice(i, i + 1000).map(({ subject, identifier, at: seen, event }) => ({ subject, identifiers: [identifier], at: seen, ...(event !== undefined && { event }) })))
      }
      for (const { action, about } of decisions) {
        if (action === 'ignore' || action === 'restore') await past.ignore(about[0]!, action === 'ignore')
        if (action === 'separate' || action === 'rejoin') await past.separate(about[0]!, about[1]!, action === 'separate')
      }
      return past
    },

    verify() {
      return store.read(async (tx) => {
        const stored = await tx.allLabels()
        const next = await recompute(tx)
        const wrong = (subject: Subject) =>
          stored.get(subject)?.component !== next.get(subject)?.component || stored.get(subject)?.cluster !== next.get(subject)?.cluster
        return diff(stored, next).filter((change) => wrong(change.subject))
      })
    },
  }
  return graph
}

/** One entry per subject in either map, with the cluster it had and the cluster it has. */
function diff(stored: ReadonlyMap<Subject, Labels>, next: ReadonlyMap<Subject, Labels>): Change[] {
  const changes: Change[] = []
  for (const [subject, labels] of next) changes.push({ subject, from: stored.get(subject)?.cluster, to: labels.cluster })
  for (const [subject, labels] of stored) {
    if (!next.has(subject)) changes.push({ subject, from: labels.cluster, to: undefined })
  }
  return changes.sort((x, y) => (x.subject < y.subject ? -1 : 1))
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)]
}
