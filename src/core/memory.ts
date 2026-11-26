import { affectedMisses, callTraces, creditSubject, ownerOf, partyOf, reopenWaits, stopCallJob, withoutGuesses } from './call-party.ts'
import { randomUUID } from 'node:crypto'
import { malformed } from '../contract/fault.ts'
import { createMemoryOps } from './ops.ts'
import { createMemoryOutbox } from './outbox.ts'
import type { OutboxStore } from './outbox.ts'
import { standingFirst } from './store.ts'
import type { GraphEvent } from '../contract/api.ts'
import { contactFact, factActive } from './fact-fold.ts'
import type { FactProfile, FactStamp } from './fact-fold.ts'
import type { Delivery } from './events.ts'
import type { Receipt } from './receipts.ts'
import type { Said, SaidOf, Topic } from './said.ts'
import { byKey, later, newest } from './said.ts'
import type { AddedSightings, CallEvidence, CallLineKind, Store, SubjectDates, TextNumber, Tx } from './store.ts'
import { CLICK_IDS } from './touch.ts'
import type { CallResult, Consent, ConsentAnswer, CostRow, Counted, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, KeptCall, KeptText, Labels, Lease, Moved, NotLead, NumberedChange, OutcomeValue, Payment, SentLink, Sighting, Subject, Touch } from '../contract/types.ts'

/**
 * Keeps the graph in process memory, for tests, demos, and small graphs.
 * Writes run one at a time. A write that throws is undone only where it was
 * asked to be whole, by a copy of everything made before it.
 */
export function createMemoryStore(): Store & { snapshot(): unknown } {
  const outbox = createMemoryOutbox((job) => outcomes.get(job.transactionId)?.subject === job.subject, () => settings.get('callParty'), (subjects) => {
    const refusals = new Map<Subject, number>()
    for (const subject of subjects) {
      const answer = latestConsent(subject)
      if (answer?.adUserData === false) refusals.set(subject, answer.at)
    }
    return refusals
  })
  const bySubject = new Map<Subject, Map<Identifier, Edge>>()
  const byIdentifier = new Map<Identifier, Map<Subject, Edge>>()
  const profiles = new Map<Subject, Map<Identifier, FactProfile>>()
  const hidden = new Map<Subject, Map<Identifier, Edge>>()
  const withdrawals = new Map<Subject, Map<Identifier, FactStamp>>()
  const factStatements = new Map<Subject, { identifiers: Identifier[]; at: number; key: string; recorded: number; decision?: number }[]>()
  const ignored = new Set<Identifier>()
  const labels = new Map<Subject, Labels>()
  const byComponent = new Map<Subject, Set<Subject>>()
  const byCluster = new Map<Subject, Set<Subject>>()
  const sightings = new Map<Subject, Sighting[]>()
  const created = new Map<Subject, { createdAt: number; at: number; key: string }>()
  const touches = new Map<Subject, { touch: Touch; call: string | undefined }[]>()
  const separated = new Map<Subject, Set<Subject>>()
  const flows = new Map<string, FlowEdge>()
  const flowsBy = new Map<Subject, Set<string>>()
  const flowIds = new Map<string, Required<Flow>>()
  const consents = new Map<Subject, ConsentAnswer[]>()
  const latestConsent = (subject: Subject) => [...(consents.get(subject) ?? [])].sort(standingFirst)[0]
  const decisions: Decision[] = []
  const outcomes = new Map<string, Counted>()
  const values = new Map<Subject, Map<string, OutcomeValue[]>>()
  const calls = new Map<string, Omit<KeptCall, 'result'>>()
  const withheld = new Map<string, CallEvidence>()
  const reservedBySubject = new Map<Subject, Set<string>>()
  const reservedByIdentifier = new Map<Identifier, Set<string>>()
  const callLines = new Map<string, Subject>()
  const lineKinds = new Map<string, CallLineKind>()
  const texts = new Map<string, KeptText>()
  const textStops = new Map<Subject, Map<Subject, FactStamp & { through?: FactStamp }>>()
  const phoneProfiles = new Map<Subject, Map<Identifier, Map<string, FactStamp>>>()
  const sent = new Map<string, SentLink>()
  const payments = new Map<string, Required<Payment>>()
  const results = new Map<string, CallResult>()
  const spurned = new Map<string, NotLead>()
  /** By number, the one that began first, first. */
  const leases = new Map<string, Lease[]>()
  const costs = new Map<string, CostRow>()
  const reads = new Map<string, { at: number; key: string }>()
  const said = new Map<string, (Said & { deletion?: number })[]>()
  const receipts = new Map<string, Receipt>()
  const receiptSubjects = new Map<string, Set<Subject>>()
  const settings = new Map<string, string>()
  const events: (GraphEvent & { subject?: Subject; notice?: string; calls?: readonly string[] })[] = []
  const once = new Map<string, Subject | undefined>()
  const deliveries = new Map<string, Delivery & { lease: number }>()
  const pruned = { seq: 0 }
  let lastEvent = 0
  let epoch = randomUUID().slice(0, 8)
  let writes = 0
  const ops = createMemoryOps()
  let built: string | undefined

  const withResult = ({ visitor, ...call }: Omit<KeptCall, 'result'>): KeptCall => structuredClone({ ...call, ...(call.party && { flags: withoutGuesses(call.flags) }), ...(!call.party && visitor && { visitor }), ...(results.has(call.id) && { result: results.get(call.id)! }) })

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

  const unsay = (about: string, ...topics: Topic[]) => (topics.length > 0 ? topics : (['worth', 'lead'] as Topic[])).forEach((topic) => said.delete(`${topic}\u0000${about}`))

  const erasedRecord = (subject: Subject) => decisions.findLast(d => d.action === 'forget' && d.about[0] === subject)
  const partyReturn = (subject: Subject, call: string) => {
    const erased = erasedRecord(subject)
    if (!erased) return undefined
    const held = calls.get(call)
    // A staff link alone does not put somebody’s profile back on record.
    const observed = [bySubject.get(subject), hidden.get(subject)].some(edges => edges && [...edges.keys()].some(id => !id.startsWith('review:')))
    return held && held.at > erased.at && observed ? erased.seq : 'forgotten'
  }
  const partyCallsOf = (subjects: readonly Subject[], only?: readonly string[]) => {
    const found = new Set<string>()
    for (const [id, line] of callLines) if ((!only || only.includes(id)) && (subjects.includes(line) || subjects.includes(calls.get(id)!.subject))) found.add(id)
    const retained: string[] = []
    for (const list of said.values()) {
      if ((only && !only.includes(list[0]!.about)) || !list.some(each => each.topic === 'party' && 'subject' in each.data && subjects.includes(each.data.subject))) continue
      const last = newest(list)!
      if (last.topic === 'party' && (last.data.role === 'self' || last.data.role === 'representative') && !subjects.includes(last.data.subject) && !found.has(last.about)) retained.push(last.about)
      else found.add(last.about)
    }
    return { found, retained }
  }
  const dropCallNotices = (ids: ReadonlySet<string>, subjects: Subject[], misses = new Set<string>(), evidence: readonly string[] = [], knownAt?: number, owner?: Subject) => {
    const sources = new Set([...ids, ...evidence])
    const conversions = new Set([...ids].map(id => `call:${id}`))
    if (ids.size) ops.dropFailureAlerts(ids)
    const notices = new Set(ops.dropCallbackAlerts(subjects, sources, misses, knownAt, misses.size ? owner : undefined))
    for (const key of notices) once.delete(key)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if ((event.type === 'callback.overdue' && (ids.has(event.data.call) || event.calls?.some(id => sources.has(id)) || (event.notice && notices.has(event.notice)))) || (event.type === 'conversion.failed' && conversions.has(event.data.conversion))) {
        if (event.notice) once.delete(event.notice)
        events.splice(i, 1)
      }
    }
    for (const subject of subjects) for (const id of ids) once.delete(`unreturned:${subject}:${id}`)
  }

  function valuesFor<T>(map: Map<Subject, Map<Identifier, T>>, subject: Subject) {
    const before = map.get(subject)
    if (before) return before
    const values = new Map<Identifier, T>()
    map.set(subject, values)
    return values
  }

  // Edges and their holder counts have one active index for every consumer, including rebuild.
  function show(edge: Edge, active: boolean) {
    const { subject, identifier } = edge
    if (active) {
      hidden.get(subject)?.delete(identifier)
      valuesFor(bySubject, subject).set(identifier, edge)
      valuesFor(byIdentifier, identifier).set(subject, edge)
    } else {
      valuesFor(hidden, subject).set(identifier, edge)
      bySubject.get(subject)?.delete(identifier)
      const holders = byIdentifier.get(identifier)
      holders?.delete(subject)
      if (!holders?.size) byIdentifier.delete(identifier)
    }
  }

  const tx: Tx = {
    addAlert: ops.addAlert,
    pendingAlert: ops.pendingAlert,
    outbox,
    nested: (work) => work(),
    async addSightings(rows) {
      const added: AddedSightings = new Map()
      for (const sighting of rows) {
        const { subject, identifier, at } = sighting
        const log = sightings.get(subject)
        if (log) log.push(sighting)
        else sightings.set(subject, [sighting])
        if (!labels.has(subject)) assign(subject, { component: subject, cluster: subject })

        const before = bySubject.get(subject)?.get(identifier)
        const edge = before ?? hidden.get(subject)?.get(identifier) ?? { subject, identifier, first: at, last: at, count: 0 }
        const cuts = withdrawals.get(subject)
        const profile = profiles.get(subject)?.get(identifier)
        if (sighting.profileKey !== undefined) {
          const next = { at, key: sighting.profileKey, ...(sighting.fact && { fact: sighting.fact }) }
          if (!profile || later(next, profile) > 0) valuesFor(profiles, subject).set(identifier, next)
        }
        edge.first = Math.min(edge.first, at)
        edge.last = Math.max(edge.last, at)
        edge.count += 1
        const active = !cuts || factActive(identifier, profiles.get(subject)?.get(identifier), cuts)
        if (active && !before) {
          if (cuts && !factActive(identifier, { at: -Infinity, key: '', ...(sighting.fact && { fact: sighting.fact }) }, cuts)) {
            settings.set('callParty', randomUUID())
            if (!added.restored) added.restored = new Set()
            added.restored.add(subject)
          }
          added.set(identifier, (added.get(identifier) ?? 0) + 1)
        }
        if (!before || !active) show(edge, active)
      }
      return added
    },

    async withdrawFact(subject, identifiers, at, key, recorded, decision) {
      const statements = factStatements.get(subject) ?? []
      statements.push({ at, key, recorded, identifiers: [...identifiers], ...(decision !== undefined && { decision }) })
      factStatements.set(subject, statements)
      const cuts = valuesFor(withdrawals, subject)
      for (const identifier of identifiers) {
        const fact = contactFact(identifier)
        const before = cuts.get(fact)
        if (!before || later({ at, key }, before) > 0) cuts.set(fact, { at, key })
      }
      const changed = []
      for (const edge of bySubject.get(subject)?.values() ?? []) {
        const profile = profiles.get(subject)?.get(edge.identifier)
        if (factActive(edge.identifier, profile, cuts)) continue
        changed.push(edge.identifier)
        show(edge, false)
      }
      return changed
    },

    async factWithdrawn(subject, identifiers, at, key) {
      return identifiers.every(identifier => {
        const cut = withdrawals.get(subject)?.get(contactFact(identifier))
        return cut?.at === at && cut.key === key && !bySubject.get(subject)?.has(identifier)
      })
    },

    async factHistory(before) {
      return [...factStatements].flatMap(([subject, rows]) => rows.filter(row => row.recorded <= before).map(({ recorded, ...row }) => ({ ...row, subject, identifiers: [...row.identifiers].sort(byKey) })))
    },

    async removeSubject(subject, only) {
      const { found: ids, retained } = partyCallsOf([subject], only)
      for (const call of retained) {
        const key = `party\u0000${call}`
        said.set(key, said.get(key)!.filter(each => each.topic === 'party' && !('subject' in each.data && each.data.subject === subject)))
      }
      if (!only) for (const call of calls.values()) if (call.subject === subject) ids.add(call.id)
      for (const [key, row] of withheld) if (ids.has(row.call) || (!only && row.subject === subject)) {
        withheld.delete(key)
        unindex(reservedBySubject, row.subject, key)
        unindex(reservedByIdentifier, row.identifier, key)
      }
      if (ids.size) await reopenWaits(this, await this.callsWith([...ids]))
      const gone = []
      const owners = new Set([subject])
      for (const id of ids) {
        const call = calls.get(id)
        if (call) owners.add(call.subject)
        const line = callLines.get(id)
        if (line) owners.add(line)
        const outcome = `call:${id}`
        calls.delete(id)
        callLines.delete(id)
        lineKinds.delete(id)
        results.delete(id)
        outcomes.delete(outcome)
        spurned.delete(outcome)
        for (const list of values.values()) list.delete(outcome)
        for (const [key, payment] of payments) if (payment.transactionId === outcome) payments.delete(key)
        for (const [key, job] of outbox.jobs) if (job.transactionId === outcome && outbox.jobs.delete(key)) gone.push(job)
        unsay(outcome)
        unsay(id, 'party', 'return', 'result')
      }
      if (ids.size || !only) dropCallNotices(ids, [...owners], new Set(), only ? [] : [creditSubject(subject)])
      if (only) return gone
      for (const identifier of bySubject.get(subject)?.keys() ?? []) {
        const holders = byIdentifier.get(identifier)!
        holders.delete(subject)
        if (holders.size === 0) byIdentifier.delete(identifier)
      }
      bySubject.delete(subject)
      textStops.delete(subject)
      for (const lines of textStops.values()) lines.delete(subject)
      phoneProfiles.delete(subject)
      profiles.delete(subject)
      hidden.delete(subject)
      withdrawals.delete(subject)
      factStatements.delete(subject)
      sightings.delete(subject)
      created.delete(subject)
      touches.delete(subject)
      for (const [id, outcome] of outcomes) {
        if (outcome.subject !== subject) continue
        outcomes.delete(id)
        spurned.delete(id)
        unsay(id)
      }
      // Its outcomes, and those taken back, unless they are somebody else's since.
      const own = values.get(subject)
      for (const [id, { transactionId }] of payments) if (own?.has(transactionId) && !outcomes.has(transactionId)) payments.delete(id)
      for (const id of own?.keys() ?? []) if (!outcomes.has(id)) unsay(id)
      values.delete(subject)
      for (const [id, call] of calls) {
        if (call.subject === subject) {
          calls.delete(id)
          lineKinds.delete(id)
          results.delete(id)
          spurned.delete(`call:${id}`)
          unsay(id, 'result', 'return')
          unsay(`call:${id}`)
        } else if (call.visitor === subject) delete call.visitor
      }
      for (const [id, link] of sent) if (link.subject === subject) sent.delete(id)
      for (const [id, text] of texts) {
        if (text.subject === subject) {
          texts.delete(id)
          spurned.delete(`text:${id}`)
          unsay(`text:${id}`)
        } else if (text.visitor === subject) delete text.visitor
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
      for (const [name, about] of once) if (about === subject) once.delete(name)
      for (let i = events.length - 1; i >= 0; i--) if (events[i]!.subject === subject) events.splice(i, 1)
      // Last, so a job added meanwhile has no outcome to be added for.
      return [...gone, ...await outbox.remove(subject)]
    },

    async hasCallEvidence() { return withheld.size > 0 },

    async callEvidence(filter = {}) {
      if (!withheld.size) return []
      const subjects = new Set(filter.subjects)
      const identifiers = new Set(filter.identifiers)
      const ids = new Set(filter.calls)
      const keys = filter.subjects ? filter.subjects.flatMap(subject => [...(reservedBySubject.get(subject) ?? [])])
        : filter.identifiers ? filter.identifiers.flatMap(id => [...(reservedByIdentifier.get(id) ?? [])]) : undefined
      const rows = keys ? [...new Set(keys)].map(key => withheld.get(key)!) : [...withheld.values()]
      return rows.filter(row => (!filter.subjects || subjects.has(row.subject)) && (!filter.identifiers || identifiers.has(row.identifier)) &&
        (!filter.calls || ids.has(row.call)) && (filter.before === undefined || row.recorded <= filter.before)).map(row => ({ ...row }))
    },

    async reserveCall(rows) {
      for (const row of rows) {
        const key = [row.call, row.subject, row.identifier].join('\u0000')
        if (withheld.has(key)) continue
        withheld.set(key, { ...row })
        index(reservedBySubject, row.subject, key)
        index(reservedByIdentifier, row.identifier, key)
      }
    },

    async rivalCalls(number, first, last, line) {
      return [...calls.values()].filter(call => call.direction === 'inbound' && call.to === number && call.at >= first && call.at < last && (!line || (callLines.get(call.id) ?? call.subject) === line))
        .map(call => ({ ...withResult(call), subject: callLines.get(call.id) ?? call.subject, flags: [...call.flags], ...(call.visitor && { visitor: call.visitor }) }))
    },

    async markPartyCode(id, visitor) {
      const call = calls.get(id)
      if (!call?.party) return
      call.flags = [...withoutGuesses(call.flags), visitor ? 'code' : 'taken']
      if (visitor) call.visitor = visitor
      else delete call.visitor
    },

    async callVisitors(ids) {
      const found = new Map<string, Subject>()
      for (const id of ids) {
        const call = calls.get(id)
        if (call?.party && call.visitor && [`dial:${id}`, `lease:${id}`, `text:call:${id}`].some(identifier => !ignored.has(identifier) && withheld.has([id, call.visitor, identifier].join('\u0000')))) found.set(id, call.visitor)
      }
      return found
    },

    async matchingEdges(subjects) {
      const active = await this.edgesOf(subjects)
      return { active, reserved: withheld.size > 0 && (subjects.some(s => reservedBySubject.has(s)) || active.some(e => reservedByIdentifier.has(e.identifier))) }
    },

    async setCreatedAt(subject, createdAt, at, key) {
      const before = created.get(subject)
      if (before) {
        const order = later(before, { at, key })
        if (order >= 0) return order === 0 && before.createdAt === createdAt
      }
      created.set(subject, { createdAt, at, key })
      return true
    },

    async createdAtStands(subject, createdAt, at, key) {
      const row = created.get(subject)
      return row?.at === at && row.key === key && row.createdAt === createdAt
    },

    async subjectDates(subjects) {
      const wanted = new Set(subjects)
      const dates = new Map<Subject, SubjectDates>()
      const seen = (subject: Subject, at: number) => {
        const row = dates.get(subject)
        if (row) row.firstSeen = Math.min(row.firstSeen ?? at, at)
        else dates.set(subject, { firstSeen: at })
      }
      for (const subject of wanted) {
        const said = created.get(subject)
        if (said) dates.set(subject, { createdAt: said.createdAt })
        // Edges keep the first sighting even after its individual log row has been pruned.
        for (const edge of bySubject.get(subject)?.values() ?? []) if (!edge.identifier.startsWith('review:')) seen(subject, edge.first)
        for (const row of hidden.get(subject)?.values() ?? []) seen(subject, row.first)
        for (const row of sightings.get(subject) ?? []) if (!row.identifier.startsWith('review:')) seen(subject, row.at)
        for (const { touch } of touches.get(subject) ?? []) seen(subject, touch.at)
        for (const row of consents.get(subject) ?? []) if (row.at !== 0 || row.source !== 'before history' || row.key !== undefined) seen(subject, row.at)
        for (const key of flowsBy.get(subject) ?? []) seen(subject, flows.get(key)!.first)
      }
      for (const collection of [outcomes, calls, texts, sent]) {
        for (const row of collection.values()) if (wanted.has(row.subject)) seen(row.subject, row.at)
      }
      return dates
    },

    async textNumbers(subjects) {
      const rows: TextNumber[] = []
      for (const subject of new Set(subjects)) {
        const numbers = new Map<Subject, TextNumber>()
        const numberOf = (line: Subject) => {
          const row = numbers.get(line) ?? { subject, line, active: false }
          numbers.set(line, row)
          return row
        }
        const times = new Map<Subject, { first: number; last: number; count: number }>()
        for (const edges of [bySubject.get(subject), hidden.get(subject)]) for (const edge of edges?.values() ?? []) {
          if (!/^(phone|voip):/.test(edge.identifier)) continue
          const line = 'caller:' + edge.identifier.slice(edge.identifier.indexOf(':') + 1)
          if (edges === bySubject.get(subject)) numberOf(line).active = true
          else numberOf(line)
          const prior = times.get(line)
          times.set(line, { first: Math.min(prior?.first ?? Infinity, edge.first), last: Math.max(prior?.last ?? -Infinity, edge.last), count: (prior?.count ?? 0) + edge.count })
        }
        for (const [line, stop] of textStops.get(subject) ?? []) Object.assign(numberOf(line), { stop: stop.at, stopKey: stop.key, ...(stop.through && { through: stop.through }) })
        const statements = factStatements.get(subject)
        for (const row of numbers.values()) {
          const fact = 'phone:' + row.line.slice(7)
          const cuts = (statements ?? []).filter(s => s.identifiers.some(id => contactFact(id) === fact)).map(({ at, key }) => ({ at, key, held: false }))
          const dates = times.get(row.line)
          const at = dates?.first
          if (!cuts.length) {
            if (row.stop !== undefined && at !== undefined) row.held = [{ at, key: '', held: true }]
            continue
          }
          const archived = [...(phoneProfiles.get(subject)?.get(fact)?.values() ?? [])]
          const seen = (sightings.get(subject) ?? []).filter(s => contactFact(s.identifier) === fact)
          const claims = [...archived, ...seen.flatMap(s => s.profileKey === undefined ? [] : [{ at: s.at, key: s.profileKey }])]
          if (dates && dates.count > seen.length + archived.length) row.uncertain = { first: dates.first, last: dates.last }
          for (const id of [fact, 'voip:' + fact.slice(6)]) {
            const last = profiles.get(subject)?.get(id)
            if (last) claims.push(last)
          }
          if (at !== undefined && cuts.every(c => at <= c.at)) claims.push({ at, key: '' })
          row.held = [...cuts, ...claims.map(({ at, key }) => ({ at, key, held: true }))]
        }
        rows.push(...numbers.values())
      }
      return rows
    },

    async keepTextStops(rows) {
      for (const { subject, line, at, key, through } of rows) {
        const lines = valuesFor(textStops, subject)
        const prior = lines.get(line)
        const stop = prior && later(prior, { at, key }) > 0 ? prior : { at, key }
        const lastStart = prior?.through && (!through || later(prior.through, through) > 0) ? prior.through : through
        lines.set(line, { at: stop.at, key: stop.key, ...(lastStart && { through: lastStart }) })
      }
    },

    async edgesOf(subjects) {
      const edges: Edge[] = []
      for (const subject of subjects) {
        const held = bySubject.get(subject)
        if (held) for (const edge of held.values()) edges.push(copy(edge))
      }
      return edges
    },

    async edgesOn(identifiers) {
      const edges: Edge[] = []
      for (const identifier of identifiers) {
        const held = byIdentifier.get(identifier)
        if (held) for (const edge of held.values()) edges.push(copy(edge))
      }
      return edges
    },

    async *sharing(caps) {
      const pairs = new Map<string, { a: Edge; b: Edge; fanout: number }[]>()
      const states = await this.states([...byIdentifier.keys()])
      for (const [identifier, holders] of byIdentifier) {
        const fanout = states.get(identifier)!.fanout
        const kind = identifier.slice(0, identifier.indexOf(':'))
        if (ignored.has(identifier) || holders.size < 2) continue
        if (!Object.hasOwn(caps, kind)) throw malformed(`Identifier "${identifier}" has a kind that is missing from the policy`)
        if (fanout > caps[kind]!) continue
        const edges = [...holders.values()]
        for (const [i, x] of edges.entries()) {
          for (const y of edges.slice(i + 1)) {
            const [a, b] = x.subject < y.subject ? [x, y] : [y, x]
            const key = `${a.subject}\u0000${b.subject}`
            const shared = pairs.get(key)
            if (shared) shared.push({ a: copy(a), b: copy(b), fanout })
            else pairs.set(key, [{ a: copy(a), b: copy(b), fanout }])
          }
        }
      }
      yield [...pairs.values()]
    },

    async *everyone() {
      yield [...new Set([...labels.keys(), ...bySubject.keys()])].map((subject) => ({ subject, labels: labels.get(subject), held: Boolean(bySubject.get(subject)?.size || hidden.get(subject)?.size) }))
    },

    async states(identifiers) {
      const out = new Map<Identifier, IdentifierState>()
      for (const identifier of identifiers) {
        const active = byIdentifier.get(identifier)
        let fanout = active?.size ?? 0
        const rows = withheld.size ? reservedByIdentifier.get(identifier) : undefined
        if (rows) {
          const former = new Set<Subject>()
          for (const key of rows) {
            const subject = withheld.get(key)!.subject
            if (!active?.has(subject)) former.add(subject)
          }
          fanout += former.size
        }
        if (fanout > 0 || ignored.has(identifier)) out.set(identifier, { fanout, ignored: ignored.has(identifier) })
      }
      return out
    },

    async shared(subjects) {
      const own = [...new Set(subjects.flatMap((subject) => [...(bySubject.get(subject)?.keys() ?? [])]))]
      return new Map([...(await this.states(own))].filter(([, state]) => state.fanout > 1 && !state.ignored))
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
      await tx.emit(changes.map(({ subject, from, to }) => ({ type: 'cluster.changed', at, subject, data: { subject, from: from ?? null, to: to ?? null } })))
    },

    async emit(given) {
      let made = 0
      for (const { once: name, subject, ...event } of given) {
        if (name !== undefined && once.has(name)) continue
        if (name !== undefined) once.set(name, subject)
        events.push({ schemaVersion: 1, seq: ++lastEvent, ...structuredClone(event), ...(subject && { subject }), ...(name && event.type === 'callback.overdue' && { notice: name }) } as GraphEvent)
        made += 1
      }
      return made
    },

    async callbacksThrough(sources) {
      const paths = new Set(sources)
      const notices = ops.callbacksThrough(paths)
      for (const event of events) if (event.notice && event.calls?.some(id => paths.has(id))) notices.set(event.notice, event.calls)
      return notices
    },

    async dropCallbacks(keys) {
      const gone = new Set(keys)
      ops.dropCallbacks(keys)
      for (const key of gone) once.delete(key)
      for (let i = events.length - 1; i >= 0; i--) if (gone.has(events[i]!.notice ?? '')) events.splice(i, 1)
    },

    async eventHead() {
      return { seq: lastEvent, epoch, oldest: pruned.seq + 1 }
    },

    async eventsAfter(seq, limit) {
      return events.filter((each) => each.seq > seq).slice(0, limit).map(({ subject: _, notice: __, calls: ___, ...event }) => structuredClone(event) as GraphEvent)
    },

    async newEpoch() {
      return (epoch = randomUUID().slice(0, 8))
    },

    async pruneEvents(before) {
      const keep = events.findIndex((each) => each.at >= before)
      const gone = events.splice(0, keep < 0 ? events.length : keep)
      if (gone.length > 0) pruned.seq = Math.max(pruned.seq, gone.at(-1)!.seq)
      return gone.length
    },

    async pruneReceipts(before) {
      let gone = 0
      for (const [id, receipt] of receipts) {
        if (receipt.forgotten !== undefined || receipt.ref?.type === 'withdraw' || receipt.recorded >= before) continue
        receiptSubjects.delete(id)
        gone += Number(receipts.delete(id))
      }
      return gone
    },

    async claimDelivery(sink, now, lease) {
      const held = deliveries.get(sink) ?? { sink, seq: lastEvent, due: 0, attempts: 0, lease: 0 }
      if (held.lease > now || held.due > now) return undefined
      deliveries.set(sink, { ...held, lease: now + lease })
      const { lease: _, ...delivery } = held
      return delivery
    },

    async setDelivery(delivery) {
      deliveries.set(delivery.sink, { ...delivery, lease: 0 })
    },

    async recentChanges(limit) {
      return changed(events).slice(-limit).reverse().map(({ seq: _, ...move }) => move)
    },

    async changesAfter(seq, limit) {
      return changed(events.filter((each) => each.seq > seq)).slice(0, limit)
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
        const standing = latestConsent(subject)
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

    async addTouch(touch, call) {
      const row = { touch: structuredClone(touch), call }
      const list = touches.get(touch.subject)
      if (list) list.push(row)
      else touches.set(touch.subject, [row])
    },

    async dropTouch(subject, at, landing, call, confirmed) {
      const list = touches.get(subject) ?? []
      const matches = list.filter(row => row.touch.at === at && row.touch.landing === landing)
      const own = matches.filter(row => row.call === call)
      const older = matches.filter(row => row.call === undefined)
      const gone = new Set(own.length ? own : confirmed ? older : older.slice(0, 1))
      if (gone.size) touches.set(subject, list.filter(row => !gone.has(row)))
    },

    async callsBehind(touch) {
      const matches = (touches.get(touch.subject) ?? []).filter(({ touch: other }) => other.at === touch.at && other.landing === touch.landing && other.source === touch.source && other.campaign === touch.campaign && other.campaignId === touch.campaignId)
      const older = matches.some(({ call }) => call === undefined) ? [...calls.values()].filter(call => !call.party && !call.visitor && call.direction === 'inbound' && call.subject === touch.subject && call.at === touch.at && 'tel:' + call.to === touch.landing).map(call => call.id) : []
      return [...new Set([...older, ...matches.flatMap(({ call }) => call ?? [])])]
    },

    async touchesOf(subjects, from, to) {
      return subjects.flatMap((subject) =>
        (touches.get(subject) ?? []).filter(({ touch }) => touch.at >= from && touch.at <= to).map(({ touch }) => structuredClone(touch)),
      )
    },

    async clicked(id, limit) {
      return [...touches].filter(([, list]) => list.some(({ touch }) => CLICK_IDS.some((name) => touch[name] === id))).map(([subject]) => subject).sort().slice(0, limit)
    },

    async touchesBetween(from, to) {
      const found = [...touches.values()].flatMap((list) => list.filter(({ touch }) => touch.at >= from && touch.at < to).map(({ touch }) => structuredClone(touch)))
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
          for (const { transactionId: of, kind, amount, currency } of payments.values()) {
            if (of !== transactionId || kind !== 'refund') continue
            lost.refund += amount
            lostIn.push(currency)
          }
          const paid = [...payments.values()].some((each) => each.transactionId === transactionId)
          // Once there are payments it is worth what was paid, and what was said of it before is in no count.
          for (const each of paid ? [] : (said.get(`worth\u0000${transactionId}`) ?? [])) {
            if (each.topic !== 'worth' || (each.data.kind !== 'refund' && each.data.kind !== 'write_off')) continue
            const { kind, amount } = each.data
            if ((said.get(`worth\u0000${transactionId}`) ?? []).some((other) => other.topic === 'worth' && other.data.kind === 'reverse' && other.data.restatement === each.key)) continue
            lost[kind] += amount
            lostIn.push(first.currency)
          }
          return [[transactionId, { ...first, most: rest.reduce((most, each) => Math.max(most, each.value), first.value), refunded: lost.refund, writtenOff: lost.write_off, lostIn }]]
        }),
      )
    },

    async removeOutcome(transactionId) {
      outcomes.delete(transactionId)
    },

    async setCall(call, lineKind) {
      const kept = calls.get(call.id)
      if (kept?.party) return
      if (!kept && lineKind) lineKinds.set(call.id, lineKind)
      calls.set(call.id, structuredClone(call))
    },

    async callLine(id) {
      return callLines.get(id) ?? calls.get(id)?.subject
    },

    async overwrittenCalls(limit) {
      const ids: string[] = []
      for (const call of calls.values()) {
        const replayed = call.party && call.direction === 'inbound' && call.subject === 'call:' + call.id &&
          sightings.get(call.subject)?.some(row => row.at === call.at && row.event === 'call' && row.identifier === 'dialed:call-' + call.id)
        if (call.party ? replayed || ownerOf(call.id, call.party) !== call.subject : said.has('party\u0000' + call.id)) ids.push(call.id)
        if (ids.length === limit) break
      }
      return ids
    },

    async applyCallParty(id, arriving = false, overwritten = false) {
      const call = calls.get(id)
      const party = await partyOf(this, id) ?? (overwritten ? call?.party : undefined)
      if (!call || !party) return []
      const owner = ownerOf(id, party)
      const line = callLines.get(id) ?? call.subject
      const first = overwritten || (!call.party && !arriving)
      const reported = overwritten ? call.subject : line
      if (overwritten) {
        delete call.visitor
        delete call.tags
        call.flags = withoutGuesses(call.flags)
      }
      const { changes, affected } = first ? await callTraces(this, call, reported, lineKinds.get(id)) : { changes: [], affected: [] }
      await this.reserveCall(changes.map(({ edge, recorded }) => ({ call: id, subject: edge.subject, identifier: edge.identifier, at: call.at, recorded })))
      for (const { edge, remove, next } of changes) {
        const { subject, identifier } = edge
        const seen = sightings.get(subject)
        if (seen) {
          let left = remove
          sightings.set(subject, seen.filter(row => {
            if (left === 0 || row.at !== call.at || row.identifier !== identifier || row.event !== 'call') return true
            left -= 1
            return false
          }))
        }
        if (next) Object.assign(bySubject.get(subject)!.get(identifier)!, next)
        else {
          const own = bySubject.get(subject)!
          const holders = byIdentifier.get(identifier)!
          own.delete(identifier)
          holders.delete(subject)
          if (!holders.size) byIdentifier.delete(identifier)
          if (!own.size) {
            bySubject.delete(subject)
            assign(subject, undefined)
          }
        }
      }
      if (first && !call.visitor && call.direction === 'inbound') await this.dropTouch(reported, call.at, `tel:${call.to}`, id, true)
      const before = call.subject
      if (owner !== before) await reopenWaits(this, [withResult(call)])
      const misses = new Set(await affectedMisses(this, withResult(call), owner))
      lineKinds.delete(id)
      callLines.set(id, line)
      Object.assign(call, { subject: owner, party })
      const transactionId = `call:${id}`
      const outcome = outcomes.get(transactionId)
      if (outcome) outcome.subject = owner
      if (owner !== before) {
        const previous = values.get(before)
        const history = previous?.get(transactionId)
        if (history) {
          previous!.delete(transactionId)
          if (!values.has(owner)) values.set(owner, new Map())
          values.get(owner)!.set(transactionId, history)
        }
      }
      for (const [key, job] of outbox.jobs) if (job.transactionId === transactionId && (job.note !== 'call_party' || job.subject !== owner)) outbox.jobs.set(key, { ...stopCallJob(job, owner), rev: (job.rev ?? 0) + 1 })
      if (first || before !== owner) dropCallNotices(new Set([id]), [line, before, owner], misses, first && call.direction === 'inbound' ? ['legacy:credit'] : [], Math.max(call.at, call.recorded), owner)
      return affected
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
      for (const [id, { at }] of spurned) if (at < before && !outcomes.has(id) && !(id.startsWith('call:') && calls.has(id.slice(5))) && !(id.startsWith('text:') && texts.has(id.slice(5)))) gone += Number(spurned.delete(id))
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

    async callsWith(ids) {
      return ids.flatMap((id) => calls.get(id) ?? []).map(withResult)
    },

    async callTimes(subjects) {
      const wanted = new Set(subjects)
      const found = [...calls.values()].filter((call) => wanted.has(call.subject) && !spurned.has(`call:${call.id}`))
      return found.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map(({ id, direction, subject, at, party }) => {
        const result = results.get(id)
        return { id, direction, subject, at, ...(party && { party: structuredClone(party) }), ...(result && { result: { ...(result.answered !== undefined && { answered: result.answered }), ...(result.returned !== undefined && { returned: result.returned }), ...(result.waited !== undefined && { waited: result.waited }) } }) }
      })
    },

    async aroundOf(subjects) {
      const components = new Set<Subject>()
      for (const subject of subjects) {
        const own = labels.get(subject)
        if (own) components.add(own.component)
      }
      return this.membersOf([...components])
    },

    async calledBetween(from, to) {
      return [...new Set([...calls.values()].filter((call) => call.at >= from && call.at < to && !spurned.has(`call:${call.id}`)).map((call) => call.subject))]
    },

    async missesBetween(from, to) {
      const found = [...calls.values()].filter((call) => call.direction === 'inbound' && call.at >= from && call.at < to && (results.get(call.id)?.answered === false || spurned.has(`call:${call.id}`)))
      return found.sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map(withResult)
    },

    async addPayment(payment) {
      payments.set(payment.id, { ...payment })
    },

    async paymentOf(id) {
      const payment = payments.get(id)
      return payment && { ...payment }
    },

    async paymentsOf(transactionId) {
      return [...payments.values()].filter((payment) => payment.transactionId === transactionId).map((payment) => ({ ...payment }))
    },

    async setLink(link) {
      sent.set(link.id, { ...link })
    },

    async linkOf(id) {
      const link = sent.get(id)
      return link && { ...link }
    },

    async linksSent(subjects) {
      const wanted = new Set(subjects)
      return [...sent.values()].filter((link) => wanted.has(link.subject)).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map((link) => ({ ...link }))
    },

    async pruneLinks(before) {
      let gone = 0
      for (const [id, link] of sent) if (link.expires < before) gone += Number(sent.delete(id))
      return gone
    },

    async setText(text) {
      texts.set(text.id, structuredClone(text))
    },

    async textOf(id) {
      const text = texts.get(id)
      return text && structuredClone(text)
    },

    async textsOf(subjects) {
      const wanted = new Set(subjects)
      return [...texts.values()].filter((text) => wanted.has(text.subject)).sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map((text) => structuredClone(text))
    },

    async openTexts(from, to, limit, after) {
      const spoken = new Map<Subject, number>()
      const last = (subject: Subject, at: number) => spoken.set(subject, Math.max(at, spoken.get(subject) ?? -Infinity))
      const spam = new Set<Subject>()
      for (const text of texts.values()) {
        if (text.direction === 'outbound' || text.flags.includes('opt_out')) last(text.subject, text.at)
        if (spurned.has(`text:${text.id}`)) spam.add(text.subject)
      }
      for (const call of calls.values()) if (results.get(call.id)?.answered && !spurned.has(`call:${call.id}`)) last(call.subject, call.at)
      const oldest = new Map<Subject, KeptText>()
      for (const text of texts.values()) {
        if (text.direction !== 'inbound' || text.at < from || text.at >= to || spam.has(text.subject) || text.flags.includes('opt_out') || text.flags.includes('opt_in')) continue
        if ((spoken.get(text.subject) ?? -Infinity) > text.at) continue
        const known = oldest.get(text.subject)
        if (!known || text.at < known.at || (text.at === known.at && text.id < known.id)) oldest.set(text.subject, text)
      }
      return [...oldest.values()]
        .filter((text) => !after || text.at > after.at || (text.at === after.at && text.id > after.id))
        .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
        .slice(0, limit)
        .map((text) => structuredClone(text))
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
      for (const list of said.values()) for (const { topic, about, at } of [...list]) if ((topic === 'result' || topic === 'return') && at < before && !calls.has(about)) unsay(about, topic)
      for (const [id, result] of results) if (!calls.has(id) && result.recorded < before) {
        gone += Number(results.delete(id))
        unsay(id, 'result', 'return')
      }
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

    async addCosts(rows, read) {
      let written = 0
      for (const row of rows) {
        const key = [row.day, row.source, row.campaignId].join('\u0000')
        const before = reads.get(key)
        if (read && before && (before.at - read.at || byKey(before.key, read.key)) > 0) continue
        costs.set(key, { ...row })
        if (read) reads.set(key, { ...read })
        else reads.delete(key)
        written += 1
      }
      return written
    },

    async receiptOf(type, macs) {
      for (const mac of macs) {
        const found = receipts.get(`${type}\u0000${mac}`)
        if (found) return structuredClone(found)
      }
      return undefined
    },

    async addReceipt(receipt, subjects) {
      const id = `${receipt.type}\u0000${receipt.mac}`
      receipts.set(id, structuredClone(receipt))
      receiptSubjects.set(id, new Set(subjects))
    },

    async setReceiptSent(type, macs, given) {
      for (const mac of macs) {
        const found = receipts.get(`${type}\u0000${mac}`)
        if (found) found.sent = structuredClone(given)
      }
    },

    async unname(subjects, keys) {
      const gone = new Set(subjects)
      for (const event of events) {
        if (event.type !== 'cluster.changed') continue
        const { subject, from, to } = event.data
        Object.assign(event, { data: { subject, from: from !== null && gone.has(from) ? null : from, to: to !== null && gone.has(to) ? null : to } })
      }
      ops.unname(keys)
    },

    async keysOf(subjects, only) {
      const of = new Set(subjects)
      const { found: ids, retained } = partyCallsOf(subjects, only)
      const own = [...outcomes.values()].filter((each) => of.has(each.subject)).map((each) => each.transactionId)
      const theirs = only ? new Set([...ids].map(id => `call:${id}`)) : new Set([...own, ...[...ids].map(id => `call:${id}`), ...subjects.flatMap((each) => [...(values.get(each)?.keys() ?? [])].filter((id) => !outcomes.has(id)))])
      return [
        ...[...theirs].map((key) => ({ type: 'conversion', key })),
        ...[...new Set([...ids, ...(!only ? [...calls.values()].filter(each => of.has(each.subject)).map(call => call.id) : [])])].map(key => ({ type: 'call', key })),
        ...[...ids, ...retained].flatMap(id => (said.get(`party\u0000${id}`) ?? [])
          .filter(each => ids.has(id) || (each.topic === 'party' && 'subject' in each.data && of.has(each.data.subject)))
          .map(({ key }) => ({ type: 'call_update', key }))),
        ...[...payments.values()].filter((each) => theirs.has(each.transactionId)).map(({ id }) => ({ type: 'payment', key: id })),
        ...(only ? [] : [...texts.values()].filter((each) => of.has(each.subject)).map(({ id }) => ({ type: 'text', key: id }))),
        ...(only ? [] : [...flowIds.values()].filter((each) => of.has(each.from) || of.has(each.to)).map(({ id }) => ({ type: 'transfer', key: id }))),
        ...(only ? [] : [...sent.values()].filter((each) => of.has(each.subject)).map(({ id }) => ({ type: 'link', key: id }))),
      ]
    },

    async retainedPartyCalls(subjects, only) {
      return partyCallsOf(subjects, only).retained
    },

    async forgetReceipts(subjects, keys, at, retainedCalls = [], only) {
      const kept = new Set(retainedCalls)
      // Older call and result receipts also named whichever record stood when the entry arrived.
      if (kept.size) for (const [id, of] of receiptSubjects) {
        const row = receipts.get(id)!
        if ((row.type === 'call' && kept.has(row.mac)) || (row.ref?.type === 'call' && kept.has(row.ref.mac))) {
          for (const subject of subjects) of.delete(subject)
          if (!of.size) receiptSubjects.delete(id)
        }
      }
      const gone = new Set<string>()
      for (const { type, mac, secretId, all } of keys) {
        const id = all.map((each) => `${type}\u0000${each}`).find((each) => receipts.has(each)) ?? `${type}\u0000${mac}`
        if (!receipts.has(id)) receipts.set(id, { type, mac, secretId, digest: null, version: 0, at, recorded: at })
        gone.add(id)
      }
      if (!only) for (const [id, of] of receiptSubjects) if (subjects.some((each) => of.has(each))) gone.add(id)
      const about = new Set(keys.flatMap(({ type, all }) => all.map((each) => `${type}\u0000${each}`)))
      for (const [id, { ref }] of receipts) if (ref && (about.has(`${ref.type}\u0000${ref.mac}`) || gone.has(`${ref.type}\u0000${ref.mac}`))) gone.add(id)
      for (const id of gone) {
        const { ref: _, sent: __, ...kept } = receipts.get(id)!
        receipts.set(id, { ...kept, digest: null, forgotten: at })
        receiptSubjects.delete(id)
      }
    },

    async receiptSecrets() {
      return [...new Set([...receipts.values()].map((each) => each.secretId))]
    },

    async settingOf(name) {
      return settings.get(name)
    },

    async setSetting(name, value) {
      settings.set(name, value)
    },

    async addSaid(each) {
      const key = `${each.topic}\u0000${each.about}`
      const list = said.get(key) ?? []
      if (list.some((other) => other.key === each.key)) return false
      said.set(key, [...list, structuredClone(each)])
      return true
    },

    async saidOf<T extends Topic>(topic: T, about: string) {
      return structuredClone((said.get(`${topic}\u0000${about}`) ?? []).map(({ deletion: _, ...entry }) => entry)) as SaidOf<T>[]
    },

    async costsBetween(from, to) {
      const key = (cost: CostRow) => [cost.day, cost.source, cost.campaignId].join('\u0000')
      return [...costs.values()].filter((cost) => cost.day >= from && cost.day <= to).sort((x, y) => (key(x) < key(y) ? -1 : 1)).map((cost) => ({ ...cost }))
    },

    async history(subject, limit) {
      const all = [...(sightings.get(subject) ?? [])].sort((x, y) => x.at - y.at)
      return (limit === undefined ? all : all.slice(Math.max(0, all.length - limit))).map(({ profileKey, fact, ...sighting }) => sighting)
    },

    async latelySeen(newest) {
      const all = [...sightings.values()].flat().sort((x, y) => (y.recorded ?? y.at) - (x.recorded ?? x.at) || (x.subject < y.subject ? -1 : 1))
      const window = all.slice(0, newest)
      const last = window.at(-1)
      return { subjects: [...new Set(window.map(sighting => sighting.subject))], count: window.length, oldest: last?.recorded ?? last?.at ?? null, older: all.length > window.length }
    },

    async subjectPage(after, inclusive, limit) {
      const page: Subject[] = []
      // Discard later ids as we go so the sweep never has to sort a copy of the whole store.
      for (const subject of labels.keys()) {
        if (after !== null && (byKey(subject, after) < 0 || (!inclusive && subject === after))) continue
        page.push(subject)
        if (page.length === limit * 2) page.sort(byKey).length = limit
      }
      return page.sort(byKey).slice(0, limit)
    },

    async *sightingsUntil(recorded) {
      yield [...sightings.values()].flatMap((log) => log.filter((sighting) => (sighting.recorded ?? sighting.at) <= recorded))
    },

    async pruneSightings(before) {
      let gone = 0
      for (const [subject, log] of sightings) {
        const kept = log.filter((sighting) => (sighting.recorded ?? sighting.at) >= before)
        const cuts = withdrawals.get(subject)
        if (cuts) for (const row of log) {
          if ((row.recorded ?? row.at) >= before || row.profileKey === undefined || !/^(phone|voip):/.test(row.identifier)) continue
          const fact = contactFact(row.identifier)
          if (!cuts.has(fact)) continue
          const held = valuesFor(valuesFor(phoneProfiles, subject), fact)
          held.set(row.at + ':' + row.profileKey, { at: row.at, key: row.profileKey })
        }
        gone += log.length - kept.length
        if (kept.length > 0) sightings.set(subject, kept)
        else sightings.delete(subject)
      }
      return gone
    },

    async addDecision(decision) {
      if (decision.action === 'forget') created.delete(decision.about[0]!)
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

    async unprovenParties(limit) {
      const pending: Awaited<ReturnType<Tx['unprovenParties']>> = []
      const prunes = decisions.filter(row => row.action === 'prune').map(row => ({ at: row.at, cutoff: Number(row.about[0]) }))
      let callsChecked = 0
      for (const list of said.values()) {
        const size = pending.length
        for (const row of list) {
          if (row.topic !== 'party' || !('subject' in row.data)) continue
          const subject = row.data.subject
          const erased = erasedRecord(subject)
          if (!erased || erased.seq === row.deletion) continue
          const call = calls.get(row.about)
          let fresh = Infinity
          for (const sighting of sightings.get(subject) ?? []) {
            const recorded = sighting.recorded ?? sighting.at
            if (!sighting.identifier.startsWith('review:') && recorded > erased.at) fresh = Math.min(fresh, recorded)
          }
          const ready = call && call.at > erased.at && fresh !== Infinity ? Math.max(call.recorded, fresh) : undefined
          const retryFrom = prunes.reduce((first, p) => p.cutoff > erased.at ? Math.min(first, p.at) : first, Infinity)
          pending.push({ subject, call: row.about, key: row.key, deletion: erased.seq, erasedAt: erased.at, ...(ready !== undefined && { ready }), ...(retryFrom !== Infinity && { retryFrom }) })
        }
        if (pending.length > size && ++callsChecked === limit) break
      }
      return pending
    },

    async partyReturn(subject, call) {
      return partyReturn(subject, call)
    },

    async confirmPartyReturn(call, key, deletion) {
      const row = said.get('party\u0000' + call)?.find(row => row.key === key)
      if (row) row.deletion = deletion
    },

    async removePartyStatements(call, keys) {
      const id = 'party\u0000' + call
      const gone = new Set(keys)
      const left = (said.get(id) ?? []).filter(row => !gone.has(row.key))
      if (left.length) said.set(id, left)
      else said.delete(id)
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

  /** Every collection, copied together, so what two of them share stays shared. */
  const collections = { bySubject, byIdentifier, profiles, hidden, withdrawals, factStatements, ignored, labels, byComponent, byCluster, sightings, created, touches, separated, flows, flowsBy, flowIds, consents, decisions, outcomes, values, calls, withheld, reservedBySubject, reservedByIdentifier, callLines, lineKinds, texts, textStops, phoneProfiles, sent, payments, results, spurned, leases, costs, reads, said, receipts, receiptSubjects, settings, events, once, deliveries }
  const snapshot = () => structuredClone({ ...collections, lastEvent, epoch, writes, built, jobs: outbox.jobs, ops: ops.kept })
  const restore = (kept: ReturnType<typeof snapshot>) => {
    const refill = (now: any, then: any) => {
      if (Array.isArray(now)) now.splice(0, Infinity, ...then)
      else {
        now.clear()
        for (const each of then) now instanceof Map ? now.set(each[0], each[1]) : now.add(each)
      }
    }
    for (const name of Object.keys(collections) as (keyof typeof collections)[]) refill(collections[name], kept[name])
    refill(outbox.jobs, kept.jobs)
    for (const name of Object.keys(ops.kept) as (keyof typeof ops.kept)[]) refill(ops.kept[name], kept.ops[name])
    ;({ lastEvent, epoch, writes, built } = kept)
  }

  let tail: Promise<unknown> = Promise.resolve()
  const queue = <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    const run = tail.then(() => work(tx))
    tail = run.catch(() => undefined)
    return run
  }
  const write = <T>(work: (tx: Tx) => Promise<T>, { whole = false } = {}) => queue(async (bound) => {
    const before = whole ? snapshot() : undefined
    writes += 1
    try {
      return await work(bound)
    } catch (error) {
      if (before) restore(before)
      throw error
    }
  })

  // Asked for from outside a write, a job is changed in a turn of its own, so a write undone takes nothing of it along.
  const queued = <A extends unknown[], R>(call: (...given: A) => Promise<R>) => (...given: A) => queue(() => call(...given))
  const jobs: OutboxStore = { add: queued(outbox.add), claim: queued(outbox.claim), swap: queued(outbox.swap), standing: queued(outbox.standing), start: queued(outbox.start), get: queued(outbox.get), list: queued(outbox.list), counts: queued(outbox.counts), oldestDue: queued(outbox.oldestDue) }
  return { write, read: queue, outbox: jobs, ops: { ...ops, pendingAlert: queued(ops.pendingAlert) }, snapshot }
}

/** The cluster changes among events, as they were before there were others. */
const changed = (events: readonly GraphEvent[]): NumberedChange[] =>
  events.flatMap((each) => (each.type === 'cluster.changed' ? [{ seq: each.seq, at: each.at, subject: each.data.subject, from: each.data.from ?? undefined, to: each.data.to ?? undefined }] : []))

const copied = (decision: Decision): Decision => ({ ...decision, about: [...decision.about] })
const bySystem = (decision: Decision) => decision.by?.startsWith('system:') ?? false
const ofPair = (decision: Decision) => decision.action === 'join' || decision.action === 'unjoin' || decision.action === 'separate' || decision.action === 'rejoin'

function copy(edge: Edge): Edge {
  return { ...edge }
}
