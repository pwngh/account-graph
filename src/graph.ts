import { brokenAt, seal } from './audit.ts'
import { board } from './board.ts'
import type { BoardColumn, BoardPlace } from './board.ts'
import type { Labeled } from './calibrate.ts'
import { summarizeCalls } from './callreport.ts'
import type { CallSummary } from './callreport.ts'
import { followUp } from './calls.ts'
import { followed } from './followed.ts'
import type { Followed } from './followed.ts'
import type { Hours } from './hours.ts'
import { UNSTORABLE } from './identifiers.ts'
import { checkTouch } from './touch.ts'
import { createMemoryStore } from './memory.ts'
import { defaultPolicy, evidence, plainPolicy, policyHash, ruleFor, usable, weigh } from './policy.ts'
import type { Policy } from './policy.ts'
import { dayIn, dayStart, dimension, fold, nextDay } from './report.ts'
import type { Credited } from './report.ts'
import { partition, scorePairs } from './resolve.ts'
import { checkTags, touchTag } from './tags.ts'
import type { DecisionPage, Store, Tx } from './store.ts'
import type {
  Attribution,
  AttributedTouch,
  CallResult,
  Change,
  Cluster,
  Consent,
  ConsentAnswer,
  Cost,
  Counted,
  Counterparty,
  Counts,
  Deciding,
  Decision,
  Edge,
  Entry,
  Flow,
  Identifier,
  Journey,
  KeptCall,
  Labels,
  Lease,
  Link,
  Loss,
  Moved,
  NotLead,
  Observation,
  OpenCall,
  Outcome,
  OutcomeValue,
  Pair,
  Reason,
  Recorded,
  Report,
  Ring,
  Sighting,
  Subject,
  Tie,
  Told,
  Touch,
  Transferred,
  Verdict,
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

export interface ReportOptions {
  /** The first and last day to cover, each written `YYYY-MM-DD`. */
  from: string
  to: string
  /** The time zone the days are in, such as `America/New_York`. Use the ad account's. Defaults to UTC. */
  timeZone?: string
  /** How far back from an outcome a touch may be. Defaults to 90 days. */
  window?: number
  /** How many links a touch may be from the subject of an outcome. Defaults to 2. */
  hops?: number
  /**
   * A dimension to break each line down by: `touch.<name>` what the arrival
   * said, `outcome.<name>` what is known of the outcome, `hour` or `weekday`.
   */
  by?: string
  /** The one step whose outcomes `costPerOutcome` counts: what a client cost, and not what a client or a call did. */
  per?: string
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

/** A decision that has not been made. */
export type Supposed = { action: 'join'; a: Subject; b: Subject } | { action: 'separate'; a: Subject; b: Subject; separated?: boolean } | { action: 'ignore'; identifier: Identifier; ignored?: boolean }

/** What a decision would do. A subject of no cluster counts as a cluster of one. */
export interface Foreseen {
  moved: number
  before: { id: Subject; size: number }[]
  after: { id: Subject; size: number }[]
}

export interface Graph {
  /** Records observations and returns every subject whose cluster moved. */
  observe(input: Observation | readonly Observation[]): Promise<Change[]>
  /** Every subject linked to this one, strongest first, with the reasons. Computed from edges on each call. */
  links(subject: Subject): Promise<Link[]>
  /** Every subject seen with any of the given identifiers, with when: who else has this fingerprint, who tapped this number. */
  holders(identifiers: readonly Identifier[]): Promise<Edge[]>
  /** The cluster a subject belongs to, or undefined for a subject never observed. */
  cluster(subject: Subject): Promise<Cluster | undefined>
  /** Records a marketing touchpoint. */
  touch(touch: Touch): Promise<void>
  /** Finds the touches that led to a conversion by this subject. */
  attribute(subject: Subject, options: AttributeOptions): Promise<Attribution>
  /**
   * Records something a subject did, for the report. The first record of an
   * id stands; `restate` changes its value. Resolves to false when the id was already recorded.
   */
  outcome(outcome: Outcome): Promise<boolean>
  /**
   * Changes the value of a recorded outcome: a refund, a write-off, or, without
   * a kind, what was actually paid. The value is what it is worth after. A kind
   * may raise the value only to take back what was said with the same kind.
   * Resolves to false for an unknown id.
   */
  restate(transactionId: string, value: number, currency?: string, kind?: Loss): Promise<boolean>
  /** Takes a recorded outcome out of the report: it turned out not to have happened. Resolves to false for an unknown id. */
  withdraw(transactionId: string): Promise<boolean>
  /** Every value a recorded outcome has had, oldest first. */
  values(transactionId: string): Promise<OutcomeValue[]>
  /** An outcome as it was recorded, or undefined when it was not. */
  outcomeOf(transactionId: string): Promise<Counted | undefined>
  /** Keeps a call. `recordCall` does this. */
  keepCall(call: Omit<KeptCall, 'result' | 'recorded'>): Promise<void>
  /** Keeps how a call went, which may be known before or after the call itself. What a report leaves out stays as an earlier one said it. */
  keepCallResult(id: string, result: Omit<CallResult, 'recorded'>): Promise<void>
  /** Keeps when a caller was reached as a system of yours reports it, or with undefined takes that back. `recordReturn` does this. */
  keepReturn(id: string, at: number | undefined): Promise<void>
  /**
   * Says an outcome was no lead, or with undefined takes that back. A call is `call:` and its id, and either may not be
   * recorded yet. It stays on record, and counts nowhere. `recordNotLead` does this, and tells the ad platforms.
   */
  markNotLead(id: string, kind: NotLead['kind'] | undefined): Promise<void>
  /** Which of these outcomes, by transaction id, were said to be no lead. */
  notLeads(ids: readonly string[]): Promise<Map<string, NotLead>>
  /** A kept call with its result, or undefined for an id no call was kept for. */
  keptCall(id: string): Promise<KeptCall | undefined>
  /** Whether an arrival since a time is on record for a subject, and no standing opt-out from measuring ads. */
  followable(subject: Subject, since: number): Promise<boolean>
  /**
   * Shows a subject one of your numbers as their own for some minutes, or the one they hold for that much longer. No
   * two subjects hold one number at one time. Undefined when every number is held. With `arrivedSince`, null for a
   * subject with no arrival since then, or whose standing answer is no to measuring ads.
   */
  lease(subject: Subject, options: { numbers: readonly string[]; minutes: number; at?: number; arrivedSince?: number }): Promise<Lease | null | undefined>
  /** Who a number was shown to at a time, or within `grace` milliseconds before it when nobody held it since. */
  leaseholder(number: string, at: number, grace?: number): Promise<Subject | undefined>
  /** How many of the numbers are held at a time. */
  leasesAt(numbers: readonly string[], at?: number): Promise<number>
  /**
   * Ties a caller to the visitor whose call it is, by an identifier both then carry. Not where a reviewer keeps the two
   * apart, the visitor is already tied to another caller, or what matched them no longer does: that they held the pool
   * number, or one of the notes their taps left. Returns whether they are tied. `recordCall` does this.
   */
  tieCall(caller: Subject, visitor: Subject, identifier: Identifier, at: number, by: { pool: string; grace: number } | { notes: readonly Identifier[] }): Promise<boolean>
  /** Every kept call to or from the given subjects, oldest first. */
  callsOf(subjects: readonly Subject[]): Promise<KeptCall[]>
  /**
   * Missed calls nobody has returned, oldest first, with what each is
   * credited to. `from` and `to` are days; pass the last call of a page as `after` for the next.
   */
  openCalls(options: { from: string; to: string; timeZone?: string; limit?: number; after?: { at: number; id: string } }): Promise<OpenCall[]>
  /** Calls to you over a range of days: how they went, by hour and weekday, and how many could be placed. */
  callSummary(options: { from: string; to: string; timeZone?: string; at?: number; results?: 'expected'; resultWait?: number; hours?: Hours }): Promise<CallSummary>
  /**
   * People by the furthest step they ever reached, with missed calls nobody returned first: whoever reached a step or
   * had a call in the last `days` days, today included.
   */
  board(options: BoardOptions): Promise<Board>
  /** What followed calls in a range of days: who reached a step within some days of one. See `Followed` for what it does not say. */
  followed(options: { from: string; to: string; timeZone?: string; step: string; days: number; at?: number; least?: number }): Promise<Followed>
  /** How a call went, whether or not the call itself was kept. */
  callResult(id: string): Promise<CallResult | undefined>
  /** Records what campaigns cost. A row for the same day, source and campaign replaces the one before. */
  spend(costs: Cost | readonly Cost[]): Promise<void>
  /**
   * What each campaign cost and what it brought in over a range of days.
   * Each outcome in the range goes to the campaign of its credited touch,
   * the same touch `attribute` credits, on the day the outcome happened.
   */
  report(options: ReportOptions): Promise<Report>
  /** Stops, or with `false` resumes, linking through one identifier. */
  ignore(identifier: Identifier, ignored?: boolean, why?: Deciding): Promise<Change[]>
  /**
   * Records a reviewer's decision that two subjects are different people, or
   * with `false` withdraws it. The two never share a cluster while it stands,
   * whatever they share later.
   */
  separate(a: Subject, b: Subject, separated?: boolean, why?: Deciding): Promise<Change[]>
  /**
   * Records a list of separations, or withdrawals, in one transaction with
   * one decision each. A pair whose last decision already says so is left
   * alone, so a system can send its whole list again.
   */
  separateAll(pairs: readonly Told[], why?: Why): Promise<Recorded>
  /** Records a list of joins the same way: two records another system merged are one person here too. */
  joinAll(pairs: readonly Told[], why?: Why): Promise<Recorded>
  /**
   * Records an answer a subject gave about advertising. Every answer is kept.
   * The newest by when it was given stands, whatever order they arrive in,
   * and the outbox honours that one. `at` defaults to now.
   */
  consent(subject: Subject, consent: Consent, given?: { at?: number; source?: string }): Promise<void>
  /** The standing answer of each given subject. A subject that never answered is absent. */
  consentOf(subjects: readonly Subject[]): Promise<Map<Subject, Consent>>
  /** Every answer a subject gave, the standing one first. With `limit`, only that many. */
  consentHistory(subject: Subject, limit?: number): Promise<ConsentAnswer[]>
  /** Records a reviewer's decision that two subjects are one person. They join one cluster unless separated. `marked` is told the mark it leaves, to `ignore` if it is taken back. */
  join(a: Subject, b: Subject, why?: Deciding, marked?: (mark: Identifier) => void): Promise<Change[]>
  /** A number that is different after every write: the same number means nothing has changed. */
  version(): Promise<number>
  /** How much the graph holds: subjects, clusters, identifiers, edges, sightings, touches, decisions. */
  counts(): Promise<Counts>
  /** The subjects a reviewer has separated from this one. */
  separations(subject: Subject): Promise<Subject[]>
  /** The clusters with two or more members, largest first: where a reviewer should look. `offset` skips that many. */
  clusters(limit?: number, offset?: number): Promise<{ id: Subject; size: number; oversized: boolean }[]>
  /** What a decision would do to the clusters now, worked out without making it: how many subjects would move, and the clusters it is about before and after. */
  foresee(decision: Supposed): Promise<Foreseen>
  /** Subjects with an arrival that carries this ad click id, whole, in order. */
  clicked(id: string, limit?: number): Promise<Subject[]>
  /** Subjects whose id starts with the text, in order. */
  search(text: string, limit?: number): Promise<Subject[]>
  /** The newest cluster changes, newest first: who joined or left which cluster, and when. */
  recent(limit?: number): Promise<Moved[]>
  /** What two subjects share, however weak, without any reviewer's mark, and how they stand. */
  between(a: Subject, b: Subject): Promise<Between>
  /**
   * Pairs that are related and not joined, strongest first, for someone to decide. Only pairs with a subject of the newest
   * sightings, 10,000 unless told otherwise: scoring every pair reads the whole graph.
   */
  undecided(options?: { limit?: number; sightings?: number }): Promise<Undecided>
  /**
   * Every pair a reviewer joined or kept apart, with what the two share, in
   * the form `fit` takes. A pair that shares nothing is left out, since it
   * says nothing about any identifier. `exclude` leaves out decisions by
   * authors whose name starts with it: `system:` keeps only what people decided.
   */
  reviewed(options?: { exclude?: string }): Promise<Labeled[]>
  /**
   * Records value moving between two subjects, and says how the two are tied by identity.
   * A flow already recorded under its id adds nothing; another flow under that id is refused.
   */
  transfer(flow: Flow): Promise<Transferred>
  /** Everyone a subject has exchanged value with, largest volume first. */
  flows(subject: Subject): Promise<Counterparty[]>
  /** The counterparties tied to this subject by identity, with at least `count` flows between them. */
  collusion(subject: Subject, count?: number): Promise<Counterparty[]>
  /**
   * Rings of value through a subject: it paid someone, who paid someone, who paid it back.
   * `length` is the most subjects a ring may have, 4 by default. Largest amount first, 50 at most.
   */
  rings(subject: Subject, length?: number): Promise<Ring[]>
  /** Deletes a subject and everything recorded about it, unsent conversions included. */
  forget(subject: Subject, why?: Deciding): Promise<Change[]>
  /**
   * Everything recorded about the person a subject is: arrivals, what they
   * were seen doing, calls, steps and their values, consent and decisions,
   * each with the subject it is on and why that subject is this person.
   */
  journey(subject: Subject, options?: { before?: number; limit?: number }): Promise<Journey>
  /** Every sighting of a subject, oldest first. With `limit`, only the newest that many. */
  history(subject: Subject, limit?: number): Promise<Sighting[]>
  /** Recomputes every cluster from edges. Run it after changing the policy. */
  rebuild(why?: Why): Promise<Change[]>
  /** Every decision people made about the graph, oldest first: what was ignored, separated, forgotten, and by whom. */
  decisions(): Promise<Decision[]>
  /** One page of decisions, newest first. */
  decisionPage(page: DecisionPage): Promise<Decision[]>
  /** What the record says of each given pair. A pair nothing was decided about is left out. */
  verdicts(pairs: readonly (readonly [Subject, Subject])[]): Promise<Verdict[]>
  /** Pairs that systems have contradicted themselves or each other about three times or more, the most recently decided first. */
  disputes(limit?: number): Promise<Verdict[]>
  /** Checks that the record of decisions is whole and unaltered. `brokenAt` names the first entry that does not fit, `head` the newest entry and its hash. */
  audit(): Promise<{ sound: boolean; brokenAt?: number; head?: { seq: number; hash: string } }>
  /**
   * The graph as it stood at a time: a copy in memory, built from the
   * sightings written down and the decisions made up to then. A sighting
   * that happened earlier but arrived later is not in it. A forgotten
   * subject, and anything pruned, is gone from every past.
   */
  asOf(at: number): Promise<Graph>
  /**
   * Deletes sightings written down before a time, with answers about
   * advertising that no longer stand and call results whose call never
   * came, to keep the logs from growing forever. Links and clusters do
   * not change, because edges keep what they folded, and each subject keeps
   * the answer that stands. `history`, `consentHistory` and `asOf` lose what
   * was deleted. Returns how many went.
   */
  prune(before: number, why?: Why): Promise<number>
  /**
   * The policy this graph runs, and whether the stored clusters were built
   * with it. `due` means they were not, or that it is not known: call `rebuild`.
   */
  policy(): Promise<PolicyState>
  /** Compares stored clusters with a full recompute. Empty when they agree. */
  verify(): Promise<Change[]>
  /** `verify` and `policy` together, both as of one moment. */
  check(): Promise<{ changes: Change[]; policy: PolicyState }>
}

export interface PolicyState {
  /** Names the running policy. Two policies that score and cluster alike have the same hash. */
  hash: string
  /** The hash the stored clusters were built with, `mixed` when more than one policy has written them, or undefined when it was not recorded. */
  builtWith: string | undefined
  due: boolean
  /** The running policy as plain JSON, with a half-life that never ends written `none`. */
  rules: ReturnType<typeof plainPolicy>
}

const DAY = 86_400_000
const HOUR = 3_600_000
/** What two subjects share, and how they stand. */
export interface Between {
  /** Whether something other than a reviewer's mark was recorded about both. Without it, sharing nothing says nothing. */
  known: boolean
  /** Whether they are in one cluster, by whatever put them there. */
  joined: boolean
  /** Whether a reviewer keeps them apart. */
  apart: boolean
  /** What the shared identifiers alone come to, 0 for none. */
  score: number
  reasons: Reason[]
  /** What both hold that links nobody, because it is muted or over its cap. */
  idle: Identifier[]
}

/** Pairs the graph finds related and has not joined, strongest first. */
export interface Undecided {
  pairs: Pair[]
  /** How many there are among the subjects looked at, and how many subjects those are. */
  total: number
  seen: number
}

export interface BoardOptions {
  /** The steps in order, the furthest last. `wait` is how many hours at it is too long. */
  steps: readonly { name: string; wait?: number }[]
  /** Defaults to 90, at most 365. */
  days?: number
  timeZone?: string
  at?: number
  /** How many hours a missed call may wait. Left out or 0, none has waited too long. */
  returnHours?: number
  /** When you are open. With it, hours of waiting are those you were open. */
  hours?: Hours
  /** The most rows of one column. Counts are of everybody. Defaults to 50. */
  limit?: number
}

/** A person on the board, with the arrival credited with where they stand. */
export interface BoardRow extends BoardPlace {
  touch?: AttributedTouch
  /** From their furthest step, their newest call, or else that arrival. */
  language?: string
}

export interface Board {
  at: number
  /** Today, and the first day read. */
  day: string
  from: string
  columns: BoardColumn<BoardRow>[]
  /** People with outcomes of no step you named, and no missed call. */
  unplaced: number
}

/** The most subjects of one person a journey reads. */
const MOST = 60
const MIXED = 'mixed'
/** The moments a range of days begins and ends in a time zone. */
function range(from: string, to: string, timeZone?: string): [number, number] {
  const start = dayStart(from, timeZone)
  const end = dayStart(nextDay(to), timeZone)
  if (end <= start) throw new TypeError('A report needs `from` on or before `to`')
  return [start, end]
}

const pairKey = (a: Subject, b: Subject) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/** A decision refused because another, made since its author looked, names the same subject or identifier. */
export class Outdated extends Error {
  decision: Decision
  constructor(decision: Decision) {
    super(`${decision.by ?? 'Someone'} has decided about ${decision.about.join(' and ')} since you looked`)
    this.name = 'Outdated'
    this.decision = decision
  }
}

export function createGraph(store: Store, policy: Policy = defaultPolicy, options: GraphOptions = {}): Graph {
  // A copy, so a caller that edits its own policy later changes nothing here: the hash always names what scores.
  policy = structuredClone(policy)
  const hash = policyHash(policy)
  /**
   * Notes which policy the clusters are being written with: this one when
   * nothing was stored before, and more than one when another has written
   * them already. Asked on every write, because another server may have
   * rebuilt them since.
   */
  async function mark(tx: Tx): Promise<void> {
    const before = await tx.builtWith()
    if (before === hash) return
    if (await tx.empty()) await tx.setBuiltWith(hash)
    else if (before !== MIXED) await tx.setBuiltWith(MIXED)
  }

  /** Components and clusters of the given subjects, from their edges and the reviewer's separations. */
  async function compute(tx: Tx, subjects: readonly Subject[], supposing?: Supposed): Promise<Map<Subject, Labels>> {
    let edges = await tx.edgesOf(subjects)
    const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
    const among = new Set(subjects)
    let separated = (await tx.separatedOf(subjects)).filter(([a, b]) => among.has(a) && among.has(b))
    if (supposing?.action === 'join') {
      // Joined as a decision would join them, by an identifier of their own. Nobody else can hold one with no number.
      const identifier = 'review:join-'
      edges = [...edges, ...[supposing.a, supposing.b].map((subject) => ({ subject, identifier, first: now(), last: now(), count: 1 }))]
      states.set(identifier, { fanout: 2, ignored: false })
    } else if (supposing?.action === 'ignore') states.set(supposing.identifier, { ...states.get(supposing.identifier)!, ignored: supposing.ignored ?? true })
    else if (supposing) {
      separated = separated.filter(([a, b]) => !(a === supposing.a && b === supposing.b) && !(a === supposing.b && b === supposing.a))
      if (supposing.separated ?? true) separated.push([supposing.a, supposing.b])
    }
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
    const changes = diff(stored, next).filter((change) => change.from !== change.to)
    await tx.addChanges(now(), changes)
    return changes
  }

  /**
   * Where every subject should sit that is joined to another, from all edges. One that is not here is on its own. Reads
   * the edges a pair at a time, and keeps only the pairs that join: the graph may be larger than memory.
   */
  async function recompute(tx: Tx): Promise<Map<Subject, Labels>> {
    const caps = Object.fromEntries(Object.entries(policy.kinds).map(([kind, rule]) => [kind, rule.cap]))
    const alone = Object.entries(policy.kinds).filter(([, rule]) => policy.same <= 0 || (!rule.corroborates && rule.weight >= policy.same - 1e-9)).map(([kind]) => kind)
    const pairs: Pair[] = []
    const joined = new Set<Subject>()
    for await (const batch of tx.sharing(caps, alone)) {
      for (const shared of batch) {
        const score = weigh(policy, shared.map(({ a, b, fanout }) => evidence(policy, a, b, fanout)))
        if (score < policy.same) continue
        const [a, b] = [shared[0]!.a.subject, shared[0]!.b.subject]
        pairs.push({ a, b, score, level: 'same', reasons: [] })
        joined.add(a).add(b)
      }
    }
    const subjects = [...joined]
    const separated = (await tx.separatedOf(subjects)).filter(([a, b]) => joined.has(a) && joined.has(b))
    return partition(subjects, pairs, separated, policy)
  }

  /** Every subject whose stored labels are not what a full recompute gives, with what they should be: undefined where nothing is held any more. */
  async function wrong(tx: Tx): Promise<{ subject: Subject; stored: Labels | undefined; next: Labels | undefined }[]> {
    const labels = await recompute(tx)
    const out: { subject: Subject; stored: Labels | undefined; next: Labels | undefined }[] = []
    for await (const batch of tx.everyone()) {
      for (const { subject, labels: stored, held } of batch) {
        const next = held ? (labels.get(subject) ?? { component: subject, cluster: subject }) : undefined
        if (stored?.component !== next?.component || stored?.cluster !== next?.cluster) out.push({ subject, stored, next })
      }
    }
    return out.sort((x, y) => (x.subject < y.subject ? -1 : 1))
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

  type Reached = Map<Subject, { confidence: number; via: Subject[] }>

  /** Every subject within `hops` links of any of those given, with the strength of the best chain to each. With `only`, through those subjects and to them. */
  async function reach(tx: Tx, from: readonly Subject[], hops: number, only?: ReadonlySet<Subject>, last?: Map<Subject, Link>): Promise<Reached> {
    const reached: Reached = new Map(from.map((subject) => [subject, { confidence: 1, via: [] }]))
    // Two subjects kept apart are two people, so nothing of the one is reached from the other, through a third subject either.
    const apart = new Set((await tx.separatedOf(from)).flat().filter((subject) => !reached.has(subject)))
    let frontier = [...from]
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const links = await neighbors(tx, frontier)
      const improved = new Set<Subject>()
      // As the hop began: a chain made better during it is followed in the next one, or it would be a link longer.
      for (const [near, start] of frontier.sort().map((each) => [each, reached.get(each)!] as const)) {
        for (const link of links.get(near) ?? []) {
          if (apart.has(link.subject) || (only && !only.has(link.subject))) continue
          const confidence = start.confidence * link.score
          const known = reached.get(link.subject)
          if (known && known.confidence >= confidence) continue
          reached.set(link.subject, { confidence, via: [...start.via, near] })
          last?.set(link.subject, link)
          improved.add(link.subject)
        }
      }
      frontier = [...improved]
    }
    return reached
  }

  /** The touches in the window before a conversion, on every subject reached, and the one that earns the credit. */
  async function credit(subject: Subject, at: number, window: number, reached: Reached, tx: Tx): Promise<Attribution> {
    const touches: AttributedTouch[] = (await tx.touchesOf([...reached.keys()], at - window, at))
      .map((touch) => ({ ...touch, ...reached.get(touch.subject)! }))
      .sort((x, y) => y.at - x.at || y.confidence - x.confidence || (x.subject < y.subject ? -1 : 1))
    const credited = touches.find((touch) => touch.confidence >= policy.same)
    const reason = credited ? 'credited' : touches.length > 0 ? 'low_confidence' : 'no_touch'
    return { subject, at, touches, credited, reason }
  }

  /** Those of some outcomes, or of some calls, that nobody said were no lead. */
  const leadsOf = async <T>(tx: Tx, list: readonly T[], id: (each: T) => string): Promise<T[]> => {
    const not = await tx.notLeads(list.map(id))
    return not.size === 0 ? [...list] : list.filter((each) => !not.has(id(each)))
  }
  const outcomeId = (outcome: Counted) => outcome.transactionId
  const callId = (call: KeptCall) => `call:${call.id}`

  const followable = async (tx: Tx, subject: Subject, since: number, at: number) => (await tx.touchesOf([subject], since, at)).length > 0 && (await tx.consentOf([subject])).get(subject)?.adUserData !== false

  const holderOf = async (tx: Tx, number: string, at: number, grace: number): Promise<Subject | undefined> => {
    const [last] = await tx.newestLeases([number], at)
    return last && (at < last.until || (grace > 0 && at - last.until <= grace)) ? last.subject || undefined : undefined
  }

  /** Appends decisions to the record, each sealed to the one before it. Returns their sequence numbers. */
  async function decideAll(tx: Tx, entries: readonly { action: Decision['action']; about: string[]; why?: Why | undefined }[]): Promise<number[]> {
    let last = await tx.lastDecision()
    const seqs: number[] = []
    for (const { action, about, why } of entries) {
      keepable(why?.by, why?.reason)
      const entry = { seq: (last?.seq ?? 0) + 1, at: now(), action, about, ...(why?.by && { by: why.by }), ...(why?.reason && { reason: why.reason }) }
      last = { ...entry, hash: seal(last?.hash ?? '', entry) }
      await tx.addDecision(last)
      seqs.push(entry.seq)
    }
    return seqs
  }

  /** Refuses someone who decides about what another has decided since they looked. */
  async function current(tx: Tx, about: readonly string[], why: Deciding | undefined): Promise<void> {
    const seen = why?.seen
    if (seen === undefined) return
    if (!Number.isSafeInteger(seen) || seen < 0) throw new TypeError('`seen` must be the number of a decision')
    const newer = await tx.newestNaming(about, seen)
    if (newer) throw new Outdated(newer)
  }

  const decide = async (tx: Tx, action: Decision['action'], about: string[], why: Deciding | undefined) => {
    // An undo is about a decision already made, so it is taken whatever came since. A mute was checked before.
    if (action !== 'restore' && action !== 'rejoin' && action !== 'ignore') await current(tx, about, why)
    return (await decideAll(tx, [{ action, about, why }]))[0]!
  }

  /** What the record says of each pair, from its decisions. */
  async function verdictsOf(tx: Tx, pairs: readonly (readonly [Subject, Subject])[]): Promise<Map<string, Verdict>> {
    const ordered = new Map(pairs.map(([a, b]) => [pairKey(a, b), a < b ? ([a, b] as const) : ([b, a] as const)]))
    const out = new Map<string, Verdict>()
    const said = new Map<string, boolean>()
    for (const decision of await tx.decisionsAbout([...ordered.values()])) {
      const [a, b] = decision.about as [Subject, Subject]
      const key = pairKey(a, b)
      const verdict: Verdict = out.get(key) ?? { a, b, last: decision, reversals: 0 }
      out.set(key, verdict)
      verdict.last = decision
      if (decision.action === 'separate') verdict.apart = decision
      if (!decision.by?.startsWith('system:')) continue
      const apart = decision.action === 'separate'
      if (said.has(key) && said.get(key) !== apart) verdict.reversals += 1
      said.set(key, apart)
    }
    return out
  }

  /** Which of the given pairs are kept apart, and which hold a reviewer's or a system's join that was not muted. */
  async function standing(tx: Tx, pairs: readonly (readonly [Subject, Subject])[]) {
    const subjects = unique(pairs.flat())
    const apart = new Set((await tx.separatedOf(subjects)).map(([a, b]) => pairKey(a, b)))
    const marks = (await tx.edgesOf(subjects)).filter((edge) => edge.identifier.startsWith('review:'))
    const states = await tx.states(unique(marks.map((edge) => edge.identifier)))
    const held = new Map<Subject, Set<Identifier>>()
    for (const { subject, identifier } of marks) if (!states.get(identifier)!.ignored) held.set(subject, (held.get(subject) ?? new Set()).add(identifier))
    const joined = new Set(pairs.filter(([a, b]) => [...(held.get(a) ?? [])].some((identifier) => held.get(b)?.has(identifier))).map(([a, b]) => pairKey(a, b)))
    return { apart, joined }
  }

  /**
   * The pairs of a list that are news, in order. A pair is not news when the
   * last decision about it says the same and still holds: forgetting a
   * subject, or muting a join, leaves the record as it was and the decision
   * without effect. A report that contradicts the last one is news even
   * where nothing moves, because two systems that disagree must show.
   */
  async function news(tx: Tx, told: readonly { pair: [Subject, Subject]; action: 'separate' | 'rejoin' | 'join'; why: Why }[]) {
    const pairs = told.map((each) => each.pair)
    const last = new Map([...(await verdictsOf(tx, pairs))].map(([key, verdict]) => [key, verdict.last.action]))
    const { apart, joined } = await standing(tx, pairs)
    return told.filter(({ pair, action }) => {
      const key = pairKey(...pair)
      const holds = action === 'separate' ? apart.has(key) : action === 'rejoin' ? !apart.has(key) : joined.has(key)
      const before = last.get(key)
      if (holds && (before === action || (before === undefined && action === 'rejoin'))) return false
      last.set(key, action)
      if (action === 'separate') apart.add(key)
      else if (action === 'rejoin') apart.delete(key)
      else joined.add(key)
      return true
    })
  }

  const tell = (pairs: readonly Told[], verb: string, why: Why | undefined) => {
    if (!Array.isArray(pairs)) throw new TypeError(`${verb} needs a list of pairs`)
    return pairs.map((told) => ({ pair: pairOf(told?.a, told?.b, verb), separated: told.separated ?? true, why: { ...why, ...(told.reason && { reason: String(told.reason) }) } }))
  }

  /** Adds an outcome's value to its history, unless it is the one it already has. */
  async function revalue(tx: Tx, { transactionId, subject, value, currency }: Counted, kind?: Loss): Promise<void> {
    const last = (await tx.valuesOf(transactionId, subject)).at(-1)
    if (last?.value !== value || last.currency !== currency) await tx.addValue(transactionId, subject, { value, currency, at: now(), ...(kind && { kind }) })
  }

  /** Refuses text the database cannot keep, before anything is written. */
  const keepable = (...texts: (string | undefined)[]) => {
    for (const text of texts) if (text !== undefined && UNSTORABLE.test(text)) throw new TypeError('Text may not hold a NUL or half of a character')
  }

  const pairOf = (a: Subject, b: Subject, verb: string): [Subject, Subject] => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) throw new TypeError(`${verb} needs two different subjects`)
    keepable(a, b)
    return a < b ? [a, b] : [b, a]
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
    await mark(tx)
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

  async function policyState(tx: Tx): Promise<PolicyState> {
    const builtWith = await tx.builtWith()
    return { hash, builtWith, due: builtWith !== hash && !(await tx.empty()), rules: plainPolicy(policy) }
  }

  /** The subjects whose stored labels are not what a full recompute gives. */
  async function differences(tx: Tx): Promise<Change[]> {
    return (await wrong(tx)).map(({ subject, stored, next }) => ({ subject, from: stored?.cluster, to: next?.cluster }))
  }

  const graph: Graph = {
    async observe(input) {
      const observations = Array.isArray(input) ? (input as readonly Observation[]) : [input as Observation]
      const sightings: Sighting[] = []
      const recorded = now()
      for (const { subject, identifiers, at, event } of observations) {
        if (typeof subject !== 'string' || !subject) throw new TypeError('An observation needs a subject')
        if (!Number.isSafeInteger(at)) throw new TypeError(`Observation of "${subject}" needs a time in whole epoch milliseconds`)
        if (event !== undefined && typeof event !== 'string') throw new TypeError(`Observation of "${subject}" needs its event as text`)
        if (UNSTORABLE.test(subject) || (event !== undefined && UNSTORABLE.test(event))) throw new TypeError('An observation holds text that cannot be kept')
        for (const identifier of new Set(identifiers)) {
          if (UNSTORABLE.test(identifier)) throw new TypeError('An observation holds text that cannot be kept')
          ruleFor(policy, identifier)
          sightings.push(event === undefined ? { subject, identifier, at, recorded } : { subject, identifier, at, event, recorded })
        }
      }
      if (sightings.length === 0) return []

      return changing((tx) => record(tx, sightings))
    },

    links(subject) {
      return store.read(async (tx) => (await neighbors(tx, [subject])).get(subject) ?? [])
    },

    between(a, b) {
      return store.read(async (tx) => {
        const labels = await tx.labelsOf([a, b])
        const [x, y] = [labels.get(a), labels.get(b)]
        const edges = (await tx.edgesOf(unique([a, b]))).filter((edge) => !edge.identifier.startsWith('review:'))
        // However weak what they share is.
        const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
        const [pair] = scorePairs(policy, edges, states, undefined, 0)
        const of = (subject: Subject) => new Set(edges.filter((edge) => edge.subject === subject).map((edge) => edge.identifier))
        const [held, others] = [of(a), of(b)]
        return {
          known: held.size > 0 && others.size > 0,
          joined: x !== undefined && x.cluster === y?.cluster,
          apart: (await tx.separatedOf([a])).some((each) => each.includes(b)),
          score: pair?.score ?? 0,
          reasons: pair?.reasons ?? [],
          idle: a === b ? [] : [...held].filter((identifier) => others.has(identifier) && !usable(policy, identifier, states.get(identifier))).sort(),
        }
      })
    },

    holders(identifiers) {
      return store.read((tx) => tx.edgesOn(identifiers))
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
      checkTouch(touch)
      await store.write(async (tx) => {
        await tx.addTouch(touch)
        await tx.fed('touches', now())
      })
    },

    attribute(subject, { at, window = 90 * DAY, hops = 2 }) {
      return store.read(async (tx) => credit(subject, at, window, await reach(tx, [subject], hops), tx))
    },

    async outcome(outcome) {
      const { transactionId, subject, at } = outcome
      if (!transactionId || !subject) throw new TypeError('An outcome needs a transactionId and a subject')
      if (typeof transactionId !== 'string' || typeof subject !== 'string') throw new TypeError('An outcome needs a transactionId and a subject, each as text')
      if (!Number.isSafeInteger(at)) throw new TypeError(`Outcome "${transactionId}" needs a time in whole epoch milliseconds`)
      const value = outcome.value ?? 0
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Outcome "${transactionId}" has a value that is not a number`)
      for (const text of [outcome.stage, outcome.currency]) if (text !== undefined && typeof text !== 'string') throw new TypeError(`Outcome "${transactionId}" needs its stage and currency as text`)
      keepable(transactionId, subject, outcome.stage, outcome.currency)
      const tags = checkTags(outcome.tags, `Outcome "${transactionId}"`)
      const counted: Counted = { transactionId, subject, at, stage: outcome.stage || 'outcome', value, currency: outcome.currency ?? '', ...(tags && { tags }) }
      return store.write(async (tx) => {
        if (await tx.outcomeOf(transactionId)) return false
        await tx.setOutcome(counted)
        await revalue(tx, counted)
        return true
      })
    },

    async restate(transactionId, value, currency, kind) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('A restated value must be zero or more')
      if (currency !== undefined && typeof currency !== 'string') throw new TypeError('A restated currency must be text')
      if (kind !== undefined && kind !== 'refund' && kind !== 'write_off') throw new TypeError('A value changes for a `refund` or a `write_off`, or for neither')
      keepable(transactionId, currency)
      return store.write(async (tx) => {
        const found = await tx.outcomeOf(transactionId)
        if (!found) return false
        if (kind !== undefined) {
          if (currency && currency !== found.currency) throw new TypeError('A refund or a write-off is in the currency the outcome is in')
          // One said by mistake is taken back by saying it the other way, and no more than was said.
          let said = 0
          if (value > found.value) {
            const values = await tx.valuesOf(transactionId, found.subject)
            values.forEach((each, i) => (said += each.kind === kind && each.currency === found.currency ? values[i - 1]!.value - each.value : 0))
          }
          if (value > found.value && (said <= 0 || value - found.value > said + 1e-6)) throw new TypeError(`Outcome "${transactionId}" has not had that much ${kind === 'refund' ? 'refunded' : 'written off'}`)
        }
        const restated = { ...found, value, ...(currency && { currency }) }
        await tx.setOutcome(restated)
        await revalue(tx, restated, kind)
        return true
      })
    },

    async withdraw(transactionId) {
      return store.write(async (tx) => {
        if (!(await tx.outcomeOf(transactionId))) return false
        await tx.removeOutcome(transactionId)
        return true
      })
    },

    values(transactionId) {
      return store.read(async (tx) => {
        const outcome = await tx.outcomeOf(transactionId)
        return outcome ? tx.valuesOf(transactionId, outcome.subject) : []
      })
    },

    outcomeOf(transactionId) {
      return store.read((tx) => tx.outcomeOf(transactionId))
    },

    async keepCall(call) {
      await store.write(async (tx) => {
        // Only a visitor still tied by this call: one forgotten meanwhile is not written down again.
        const { visitor, ...rest } = call
        const tied = visitor !== undefined && (await tx.edgesOn([`dial:${call.id}`, `lease:${call.id}`])).some((edge) => edge.subject === visitor)
        await tx.setCall({ ...rest, ...(tied && { visitor }), recorded: now() })
        await tx.fed('calls', now())
      })
    },

    async keepCallResult(id, result) {
      await store.write(async (tx) => {
        // What this report does not say stays as it was said before. A person who answered after all did not go to voicemail.
        const { voicemail, ...before } = (await tx.callResultOf(id)) ?? {}
        await tx.setCallResult(id, { ...before, ...(voicemail !== undefined && !result.answered && { voicemail }), ...result, recorded: now() })
        await tx.fed('results', now())
      })
    },

    async keepReturn(id, at) {
      await store.write(async (tx) => {
        const { returned: _, ...before } = (await tx.callResultOf(id)) ?? { recorded: now() }
        // Nothing is left of a result that only said this.
        if (at === undefined && !('answered' in before) && !('voicemail' in before) && !('waited' in before)) await tx.removeCallResult(id)
        else await tx.setCallResult(id, { ...before, ...(at !== undefined && { returned: at }) })
      })
    },

    async markNotLead(id, kind) {
      if (typeof id !== 'string' || !id) throw new TypeError('Say which outcome was no lead, by its transaction id')
      if (kind !== undefined && kind !== 'spam' && kind !== 'other') throw new TypeError('What was no lead is `spam` or `other`')
      await store.write((tx) => tx.setNotLead(id, kind && { kind, at: now() }))
    },

    notLeads(ids) {
      return store.read((tx) => tx.notLeads(ids))
    },

    keptCall(id) {
      return store.read((tx) => tx.callOf(id))
    },

    async tieCall(caller, visitor, identifier, at, by) {
      ruleFor(policy, identifier)
      let tied = false
      // One transaction: two calls reported at once cannot both find the visitor free.
      await changing(async (tx) => {
        const apart = (await tx.separatedOf([caller])).some((pair) => pair.includes(visitor))
        const others = ((await neighbors(tx, [visitor])).get(visitor) ?? []).some((link) => link.subject !== caller && link.reasons.some((reason) => /^(dial|lease):/.test(reason.identifier)))
        // What matched the two is read again: whoever was forgotten meanwhile is not tied, even where they have been seen since.
        const matched = 'pool' in by ? (await holderOf(tx, by.pool, at, by.grace)) === visitor : (await tx.edgesOn(by.notes)).some((edge) => edge.subject === visitor)
        tied = !apart && !others && matched
        return tied ? record(tx, [caller, visitor].map((subject) => ({ subject, identifier, at, event: 'call', recorded: now() }))) : []
      })
      return tied
    },

    followable(subject, since) {
      return store.read((tx) => followable(tx, subject, since, now()))
    },

    async lease(subject, { numbers, minutes, at = now(), arrivedSince }) {
      if (typeof subject !== 'string' || !subject) throw new TypeError('A lease needs a subject')
      if (!Number.isSafeInteger(at)) throw new TypeError('A lease needs a time in whole epoch milliseconds')
      if (!(Number.isFinite(minutes) && minutes > 0)) throw new TypeError('A lease needs its length in minutes, above zero')
      const until = at + Math.ceil(minutes * 60_000)
      return store.write(async (tx) => {
        // Asked here, where nobody can forget the visitor or write down an opt-out in between.
        if (arrivedSince !== undefined && !(await followable(tx, subject, arrivedSince, at))) return null
        const newest = new Map((await tx.newestLeases(numbers, Number.MAX_SAFE_INTEGER)).map((lease) => [lease.number, lease]))
        // Whoever holds one keeps it, a while longer.
        const own = [...newest.values()].find((lease) => lease.subject === subject && lease.until > at)
        if (own) {
          const longer = { ...own, until: Math.max(own.until, until) }
          await tx.setLease(longer)
          return longer
        }
        // Of those free, the one released longest ago: a number seen last week is still on somebody's screen more than one seen last year.
        const ended = (number: string) => newest.get(number)?.until ?? -Infinity
        const free = unique(numbers).filter((number) => ended(number) <= at)
        if (free.length === 0) return undefined
        const number = free.reduce((best, next) => (ended(next) < ended(best) ? next : best))
        const lease = { number, subject, start: at, until }
        await tx.setLease(lease)
        return lease
      })
    },

    leaseholder(number, at, grace = 0) {
      return store.read((tx) => holderOf(tx, number, at, grace))
    },

    leasesAt(numbers, at = now()) {
      return store.read(async (tx) => (await tx.newestLeases(numbers, at)).filter((lease) => lease.until > at).length)
    },

    callsOf(subjects) {
      return store.read((tx) => tx.callsOf(subjects))
    },

    openCalls({ from, to, timeZone, limit = 50, after }) {
      const [start, end] = range(from, to, timeZone)
      return store.read(async (tx) => {
        const open = await tx.openCalls(start, end, limit, after)
        const later = await leadsOf(tx, await tx.callsOf(unique(open.map((call) => call.subject))), callId)
        const out: OpenCall[] = []
        for (const call of open) {
          const { credited } = await credit(call.subject, call.at, 90 * DAY, await reach(tx, [call.subject], 2), tx)
          out.push({ call, followUp: followUp(call, later), ...(credited && { touch: credited }) })
        }
        return out
      })
    },

    callSummary({ from, to, timeZone, at = now(), ...options }) {
      const [start, end] = range(from, to, timeZone)
      return store.read(async (tx) => {
        const calls = await tx.callsBetween(start, end)
        const missed = calls.filter((call) => call.direction === 'inbound' && call.result?.answered === false)
        // A call filed under its number's channel left a touch of its own, on the caller, at the moment it began.
        const own = new Set((await tx.touchesBetween(start, end)).filter((touch) => touch.landing?.startsWith('tel:')).map((touch) => `${touch.at} ${touch.landing} ${touch.subject}`))
        const filed = new Set(calls.filter((call) => own.has(`${call.at} tel:${call.to} ${call.subject}`)).map((call) => call.id))
        return summarizeCalls(calls, await leadsOf(tx, await tx.callsOf(unique(missed.map((call) => call.subject))), callId), filed, at, timeZone, { ...options, notLeads: new Set((await tx.notLeads(calls.map(callId))).keys()) })
      })
    },

    async board({ steps, days = 90, timeZone, at = now(), returnHours = 0, limit = 50, hours }) {
      if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new TypeError('`days` must be a whole number from 1 to 365')
      const day = dayIn(at, timeZone)
      const today = dayStart(day, timeZone)
      const from = dayStart(new Date(Date.parse(day) - (days - 1) * DAY).toISOString().slice(0, 10), timeZone)
      return store.read(async (tx) => {
        const outcomes = await leadsOf(tx, await tx.outcomesBetween(from, at + 1), outcomeId)
        const found = unique([...outcomes, ...(await leadsOf(tx, await tx.callsBetween(from, at + 1), callId))].map((each) => each.subject))
        const labels = await tx.labelsOf(found)
        const everyone = await tx.membersOf(unique([...labels.values()].map((label) => label.component)))
        const person = (subject: Subject) => everyone.get(subject)?.cluster ?? subject
        const people = new Map(found.map((subject) => [person(subject), { outcomes: [] as Counted[], calls: [] as KeptCall[] }]))
        const theirs = unique([...found, ...everyone.keys()]).filter((subject) => people.has(person(subject)))
        for (const outcome of await leadsOf(tx, await tx.outcomesOf(theirs), outcomeId)) people.get(person(outcome.subject))!.outcomes.push(outcome)
        for (const call of await leadsOf(tx, await tx.callsOf(theirs), callId)) people.get(person(call.subject))!.calls.push(call)
        const { columns, unplaced } = board([...people.values()], { steps: steps.map(({ name, wait }) => ({ name, ...(wait && { wait: wait * HOUR }) })), at, today, ...(returnHours > 0 && { returnWait: returnHours * HOUR }), ...(hours && { hours }) })
        // Only those shown are traced to an ad: it is the slow part.
        const shown: BoardColumn<BoardRow>[] = []
        for (const column of columns) {
          const rows: BoardRow[] = []
          for (const place of column.rows.slice(0, limit)) {
            const { credited } = await credit(place.subject, place.at, 90 * DAY, await reach(tx, [place.subject], 2), tx)
            const language = place.outcome?.tags?.language ?? place.call?.tags?.language ?? touchTag(credited, 'language')
            rows.push({ ...place, ...(credited && { touch: credited }), ...(language !== undefined && { language }) })
          }
          shown.push({ ...column, rows })
        }
        return { at, day, from: dayIn(from, timeZone), columns: shown, unplaced }
      })
    },

    async followed({ from, to, timeZone, at = now(), ...options }) {
      const [start, end] = range(from, to, timeZone)
      if (typeof options.step !== 'string' || !options.step) throw new TypeError('Say which step to look for')
      if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365) throw new TypeError('`days` must be a whole number from 1 to 365')
      return store.read(async (tx) => {
        const inPeriod = await leadsOf(tx, (await tx.callsBetween(start, end)).filter((call) => call.direction === 'inbound'), callId)
        // A person is a cluster: whoever rings from two numbers is counted once, and what they did under an account is theirs.
        const labels = await tx.labelsOf(unique(inPeriod.map((call) => call.subject)))
        const clusterOf = (subject: Subject) => labels.get(subject)?.cluster ?? subject
        const everyone = await tx.membersOf(unique([...labels.values()].map((label) => label.component)))
        const subjects = unique([...inPeriod.map((call) => call.subject), ...everyone.keys()])
        const person = (subject: Subject) => everyone.get(subject)?.cluster ?? clusterOf(subject)
        const group = <T extends { subject: Subject }>(list: readonly T[]) => {
          const out = new Map<Subject, T[]>()
          for (const each of list) out.set(person(each.subject), [...(out.get(person(each.subject)) ?? []), each])
          return out
        }
        const called = group(inPeriod)
        const calls = group(await leadsOf(tx, await tx.callsOf(subjects), callId))
        const reached = group(await leadsOf(tx, (await tx.outcomesOf(subjects)).filter((outcome) => outcome.stage === options.step), outcomeId))
        return followed([...called].map(([who, mine]) => ({ called: mine, calls: calls.get(who) ?? [], reached: (reached.get(who) ?? []).map((outcome) => outcome.at) })), { ...options, at })
      })
    },

    callResult(id) {
      return store.read((tx) => tx.callResultOf(id))
    },

    async spend(input) {
      const costs = Array.isArray(input) ? (input as readonly Cost[]) : [input as Cost]
      const rows = costs.map((cost): Required<Cost> => {
        dayStart(cost?.day)
        if (typeof cost.source !== 'string' || !cost.source.trim()) throw new TypeError('A cost needs a source, such as "google"')
        if (typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0) throw new TypeError(`The cost of ${cost.day} needs an amount of zero or more`)
        for (const count of [cost.clicks, cost.impressions]) {
          if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new TypeError(`The cost of ${cost.day} has a count that is not a whole number`)
        }
        const named = [cost.campaignId, cost.campaign, cost.currency].map((text) => {
          if (typeof text === 'object' && text !== null) throw new TypeError(`The cost of ${cost.day} needs its campaign and currency as text`)
          return String(text ?? '')
        })
        keepable(cost.source, ...named)
        return {
          day: cost.day,
          source: cost.source.trim().toLowerCase(),
          campaignId: String(cost.campaignId ?? ''),
          campaign: String(cost.campaign ?? ''),
          amount: cost.amount,
          currency: String(cost.currency ?? ''),
          clicks: cost.clicks ?? 0,
          impressions: cost.impressions ?? 0,
        }
      })
      if (rows.length > 0) {
        await store.write(async (tx) => {
          await tx.addCosts(rows)
          await tx.fed('costs', now())
        })
      }
    },

    async report({ from, to, timeZone, window = 90 * DAY, hops = 2, by, per }) {
      if (by !== undefined) dimension(by)
      const [start, end] = range(from, to, timeZone)
      return store.read(async (tx) => {
        // Who a subject can reach does not depend on when, so one subject's outcomes share one search.
        const reached = new Map<Subject, Reached>()
        // Looked for over a year, so how many arrivals the window leaves out can be said. Only those inside it are credited.
        const creditOf = async (subject: Subject, at: number, back = Math.max(window, 365 * DAY)) => {
          let from = reached.get(subject)
          if (!from) reached.set(subject, (from = await reach(tx, [subject], hops)))
          const { credited: touch } = await credit(subject, at, back, from, tx)
          const inside = touch !== undefined && touch.at >= at - window
          return { touch: inside ? touch : undefined, delay: touch && at - touch.at, inside }
        }
        const recorded = await tx.outcomesBetween(start, end)
        const outcomes = await leadsOf(tx, recorded, outcomeId)
        const labels = await tx.labelsOf(unique(outcomes.map((outcome) => outcome.subject)))
        const first = await tx.firstValues(outcomes)
        const credited: Credited[] = []
        for (const outcome of outcomes) credited.push({ outcome, first: first.get(outcome.transactionId), person: labels.get(outcome.subject)?.cluster ?? outcome.subject, ...(await creditOf(outcome.subject, outcome.at)) })
        // How long steps take is read from the last half year and not from the days asked about: the newest days hold
        // few outcomes, which is what it has to say. Some of each step, so a common quick one does not hide a slow one.
        const history: Credited[] = []
        for (const outcome of await leadsOf(tx, await tx.newestOutcomes(now() - 180 * DAY, now(), 200), outcomeId)) history.push({ outcome, ...(await creditOf(outcome.subject, outcome.at, window)) })
        // What was no lead is counted apart, where it would have been credited.
        const notLeads: { at: number; touch: Touch | undefined; tags: Record<string, string> | undefined }[] = []
        const lead = new Set(outcomes)
        for (const outcome of recorded) if (!lead.has(outcome)) notLeads.push({ at: outcome.at, touch: (await creditOf(outcome.subject, outcome.at)).touch, tags: outcome.tags })
        const missed: typeof notLeads = []
        const inbound = (await tx.callsBetween(start, end)).filter((call) => call.direction === 'inbound')
        const spurned = await tx.notLeads(inbound.map(callId))
        // A call that was counted is an outcome, and is counted once.
        const counted = new Set(recorded.map(outcomeId))
        for (const call of inbound) {
          const not = spurned.has(callId(call))
          if (not ? counted.has(callId(call)) : call.result?.answered !== false) continue
          ;(not ? notLeads : missed).push({ at: call.at, touch: (await creditOf(call.subject, call.at, window)).touch, tags: call.tags })
        }
        return fold(from, to, await tx.costsBetween(from, to), await tx.touchesBetween(start, end), credited, { missed, notLeads, by, per, timeZone, through: dayIn(now(), timeZone), history })
      })
    },

    async ignore(identifier, ignored = true, why) {
      if (typeof ignored !== 'boolean') throw new TypeError('ignore needs true or false')
      keepable(identifier)
      const { cap } = ruleFor(policy, identifier)
      return changing(async (tx) => {
        if (ignored) await current(tx, [identifier], why)
        const before = (await tx.states([identifier])).get(identifier)
        // Asked for what already holds, nothing is decided: a server that mutes an address again after a restart adds no entry.
        if ((before?.ignored ?? false) === ignored) return []
        if (ignored && why?.automatic && (await tx.newestNaming([identifier], 0, ['ignore', 'restore']))?.action === 'restore') return []
        await decide(tx, ignored ? 'ignore' : 'restore', [identifier], why)
        await tx.setIgnored(identifier, ignored)
        if (!before || before.fanout > cap) return []
        await mark(tx)
        return settle(tx, new Set((await tx.edgesOn([identifier])).map((edge) => edge.subject)))
      })
    },

    async separate(a, b, separated = true, why) {
      const pair = pairOf(a, b, 'separate')
      return changing(async (tx) => {
        await decide(tx, separated ? 'separate' : 'rejoin', pair, why)
        await mark(tx)
        await tx.setSeparated(a, b, separated)
        return settle(tx, new Set([a, b]))
      })
    },

    async join(a, b, why, marked) {
      const pair = pairOf(a, b, 'join')
      ruleFor(policy, 'review:0')
      let mark: Identifier | undefined
      const changes = await changing(async (tx) => {
        // Named after the decision, not the subjects, so no two joins can collide and a forgotten id leaves no trace.
        let identifier = `review:join-${await decide(tx, 'join', pair, why)}`
        // A name some subject already holds would join these two to strangers. Take one nobody holds.
        while ((await tx.states([identifier])).has(identifier)) identifier += '+'
        mark = identifier
        const at = now()
        return record(tx, pair.map((subject) => ({ subject, identifier, at, event: 'review', recorded: at })))
      })
      marked?.(mark!)
      return changes
    },

    version() {
      return store.read((tx) => tx.version())
    },

    async separateAll(pairs, why) {
      const told = tell(pairs, 'separate', why).map((each) => ({ ...each, action: each.separated ? ('separate' as const) : ('rejoin' as const) }))
      let recorded = 0
      const changes = await changing(async (tx) => {
        const next = await news(tx, told)
        recorded = next.length
        if (recorded === 0) return []
        await decideAll(tx, next.map(({ action, pair, why }) => ({ action, about: pair, why })))
        await mark(tx)
        for (const { pair, action } of next) await tx.setSeparated(...pair, action === 'separate')
        return settle(tx, new Set(next.flatMap(({ pair }) => pair)))
      })
      return { changes, recorded, already: told.length - recorded }
    },

    async joinAll(pairs, why) {
      ruleFor(policy, 'review:0')
      const told = tell(pairs, 'join', why).map((each) => ({ ...each, action: 'join' as const }))
      let recorded = 0
      const changes = await changing(async (tx) => {
        const next = await news(tx, told)
        recorded = next.length
        if (recorded === 0) return []
        const seqs = await decideAll(tx, next.map(({ action, pair, why }) => ({ action, about: pair, why })))
        const at = now()
        const sightings: Sighting[] = []
        const { joined } = await standing(tx, next.map(({ pair }) => pair))
        for (const [i, { pair }] of next.entries()) {
          // One mark is enough: a second would keep the two joined after someone muted the first.
          if (joined.has(pairKey(...pair))) continue
          joined.add(pairKey(...pair))
          let identifier = `review:join-${seqs[i]}`
          while ((await tx.states([identifier])).has(identifier)) identifier += '+'
          sightings.push(...pair.map((subject) => ({ subject, identifier, at, event: 'review', recorded: at })))
        }
        return sightings.length > 0 ? record(tx, sightings) : []
      })
      return { changes, recorded, already: told.length - recorded }
    },

    counts() {
      return store.read((tx) => tx.counts())
    },

    separations(subject) {
      return store.read(async (tx) => (await tx.separatedOf([subject])).map(([a, b]) => (a === subject ? b : a)).sort())
    },

    clusters(limit = 50, offset = 0) {
      return store.read(async (tx) => (await tx.largestClusters(limit, offset)).map((each) => ({ ...each, oversized: each.size > policy.review })))
    },

    async foresee(decision) {
      const { action } = decision
      if (action === 'join' || action === 'separate') pairOf(decision.a, decision.b, action)
      else if (action === 'ignore') keepable(decision.identifier)
      else throw new TypeError('foresee needs an action: join, separate or ignore')
      const flag = action === 'separate' ? decision.separated : action === 'ignore' ? decision.ignored : undefined
      if (flag !== undefined && typeof flag !== 'boolean') throw new TypeError(`foresee ${action} needs true or false`)
      return store.read(async (tx) => {
        let about: Subject[]
        if (action === 'ignore') {
          const { cap } = ruleFor(policy, decision.identifier)
          const state = (await tx.states([decision.identifier])).get(decision.identifier)
          // What nobody holds, or too many to link, joins nobody either way.
          about = !state || state.fanout > cap ? [] : unique((await tx.edgesOn([decision.identifier])).map((edge) => edge.subject))
        } else about = [decision.a, decision.b]
        const own = await tx.labelsOf(about)
        const stored = await tx.membersOf(unique([...own.values()].map((labels) => labels.component)))
        const subjects = unique([...stored.keys(), ...about])
        const next = await compute(tx, subjects, decision)
        const was = (subject: Subject) => stored.get(subject)?.cluster ?? subject
        const moved = subjects.filter((subject) => was(subject) !== next.get(subject)!.cluster)
        const then = (subject: Subject) => next.get(subject)!.cluster
        // Every cluster that one of them is in before or after, and what each of those was or becomes.
        const named = [...about, ...moved]
        const ids = new Set([...named.map(was), ...named.map(then)])
        const shown = new Set(subjects.filter((subject) => ids.has(was(subject)) || ids.has(then(subject))))
        const sized = (clusterOf: (subject: Subject) => Subject) => {
          const held = new Set([...shown].map(clusterOf))
          const sizes = new Map<Subject, number>()
          for (const subject of subjects) if (held.has(clusterOf(subject))) sizes.set(clusterOf(subject), (sizes.get(clusterOf(subject)) ?? 0) + 1)
          return [...sizes].map(([id, size]) => ({ id, size })).sort((x, y) => y.size - x.size || (x.id < y.id ? -1 : 1))
        }
        return { moved: moved.length, before: sized(was), after: sized(then) }
      })
    },

    clicked(id, limit = 20) {
      return store.read((tx) => tx.clicked(id, limit))
    },

    search(text, limit = 20) {
      return store.read((tx) => tx.subjectsStarting(text, limit))
    },

    recent(limit = 50) {
      return store.read((tx) => tx.recentChanges(limit))
    },

    async undecided({ limit = 50, sightings = 10_000 } = {}) {
      return store.read(async (tx) => {
        const lately = await tx.latelySeen(sightings)
        const pairs = new Map<string, Pair>()
        // A pair kept apart is not a link, and one a reviewer's mark joins has been decided, even where a cut keeps it in two clusters.
        for (const [subject, links] of await neighbors(tx, lately)) {
          for (const link of links) {
            if (link.reasons.some((reason) => reason.identifier.startsWith('review:join-'))) continue
            const [a, b] = subject < link.subject ? [subject, link.subject] : [link.subject, subject]
            pairs.set(pairKey(a, b), { a, b, score: link.score, level: link.level, reasons: link.reasons })
          }
        }
        const labels = await tx.labelsOf(unique([...pairs.values()].flatMap(({ a, b }) => [a, b])))
        const open = [...pairs.values()].filter(({ a, b }) => labels.get(a)!.cluster !== labels.get(b)!.cluster)
        open.sort((x, y) => y.score - x.score || (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1))
        return { pairs: open.slice(0, limit), total: open.length, seen: lately.length }
      })
    },

    reviewed({ exclude } = {}) {
      return store.read(async (tx) => {
        // The last decision about a pair is the one that stands.
        const verdicts = new Map<string, { a: Subject; b: Subject; same: boolean } | undefined>()
        const theirs = new Set<number>()
        for (const { seq, action, about, by } of await tx.decisions()) {
          if (exclude && by?.startsWith(exclude)) {
            theirs.add(seq)
            continue
          }
          const [a, b] = about
          if (a === undefined || b === undefined) continue
          if (action === 'join') verdicts.set(pairKey(a, b), { a, b, same: true })
          if (action === 'separate') verdicts.set(pairKey(a, b), { a, b, same: false })
          if (action === 'rejoin') verdicts.set(pairKey(a, b), undefined)
        }
        // Score every shared identifier, however weak, and leave out the reviewer's own mark: it is the answer, not evidence.
        const out: Labeled[] = []
        for (const verdict of verdicts.values()) {
          if (!verdict) continue
          const edges = await tx.edgesOf([verdict.a, verdict.b])
          const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
          const shared = scorePairs(policy, edges, states, undefined, 0).flatMap((pair) => pair.reasons)
          const reasons = shared.filter((reason) => !reason.identifier.startsWith('review:'))
          // A join stands while a mark links the two, unless it is the mark of a join left out. Muted, it was taken back, and says nothing.
          if (verdict.same && !shared.some(({ identifier }) => identifier.startsWith('review:') && !theirs.has(Number.parseInt(identifier.slice(12), 10)))) continue
          if (reasons.length > 0) out.push({ reasons, same: verdict.same })
        }
        return out
      })
    },

    async consent(subject, consent, given = {}) {
      if (typeof subject !== 'string' || !subject) throw new TypeError('Consent needs a subject')
      if (typeof consent?.adUserData !== 'boolean' || typeof consent.adPersonalization !== 'boolean') {
        throw new TypeError('Consent needs adUserData and adPersonalization, each true or false')
      }
      const recorded = now()
      const { at = recorded, source } = given
      if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('An answer needs its time in whole epoch milliseconds')
      // An answer dated ahead would stand over every real one until that day came.
      if (at > recorded + DAY) throw new TypeError('An answer cannot be dated in the future')
      if (source !== undefined && (typeof source !== 'string' || source.length > 200)) throw new TypeError('The source of an answer must be text of at most 200 characters')
      keepable(subject, source)
      await store.write((tx) => tx.addConsent(subject, { at, adUserData: consent.adUserData, adPersonalization: consent.adPersonalization, ...(source && { source }), recorded }))
    },

    consentOf(subjects) {
      return store.read((tx) => tx.consentOf(subjects))
    },

    consentHistory(subject, limit) {
      return store.read((tx) => tx.consentHistory(subject, limit))
    },

    async transfer(flow) {
      const { id, from, to, amount, at, asset = '' } = flow
      if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new TypeError('A flow needs an id of its own, as text of at most 200 characters')
      if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) throw new TypeError('A flow needs two different subjects')
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('A flow needs a whole, positive amount in the smallest unit')
      if (!Number.isSafeInteger(at)) throw new TypeError('A flow needs a time in whole epoch milliseconds')
      if (typeof asset !== 'string') throw new TypeError('A flow needs its asset as text')
      if ([id, from, to, asset].some((text) => UNSTORABLE.test(text))) throw new TypeError('A flow holds text that cannot be kept')
      return store.write(async (tx) => {
        const before = await tx.flowOf(id)
        if (before && !(before.from === from && before.to === to && before.amount === amount && before.at === at && before.asset === asset)) {
          throw new TypeError(`Flow "${id}" was already recorded with different details`)
        }
        if (!before) await tx.addFlow({ id, from, to, amount, at, asset })
        const tie = (await counterparties(tx, from)).find((row) => row.subject === to && row.asset === asset)!
        return { ...tie, duplicate: before !== undefined }
      })
    },

    flows(subject) {
      return store.read((tx) => counterparties(tx, subject))
    },

    async collusion(subject, count = 3) {
      return (await graph.flows(subject)).filter((row) => row.relation !== 'none' && row.count >= count)
    },

    rings(subject, length = 4) {
      return store.read(async (tx) => {
        // Follow value outward one step at a time, at most `length - 1` steps, keeping who paid whom.
        const paid = new Map<string, Map<Subject, number>>()
        const key = (from: Subject, asset: string) => `${asset}\u0000${from}`
        let frontier = [subject]
        const seen = new Set(frontier)
        for (let step = 1; step < length && frontier.length > 0; step++) {
          const next = new Set<Subject>()
          for (const flow of await tx.flowsOf(frontier)) {
            if (!seen.has(flow.from)) continue
            let out = paid.get(key(flow.from, flow.asset))
            if (!out) paid.set(key(flow.from, flow.asset), (out = new Map()))
            out.set(flow.to, flow.total)
            if (!seen.has(flow.to)) next.add(flow.to)
          }
          // A subject that pays thousands of others is an exchange, not a ring member. Stop widening there.
          frontier = [...next].sort().slice(0, 500)
          for (const reached of frontier) seen.add(reached)
        }
        // The last step back needs the flows out of the outermost subjects too.
        for (const flow of await tx.flowsOf(frontier)) {
          if (flow.to !== subject || !seen.has(flow.from)) continue
          let out = paid.get(key(flow.from, flow.asset))
          if (!out) paid.set(key(flow.from, flow.asset), (out = new Map()))
          out.set(flow.to, flow.total)
        }

        const found: Ring[] = []
        const assets = new Set([...paid.keys()].map((entry) => entry.slice(0, entry.indexOf('\u0000'))))
        for (const asset of [...assets].sort()) {
          const walk = (path: Subject[], least: number) => {
            for (const [to, total] of [...(paid.get(key(path[path.length - 1]!, asset)) ?? [])].sort()) {
              if (to === subject) found.push({ subjects: [...path], asset, amount: Math.min(least, total), tied: 0 })
              else if (path.length < length && !path.includes(to)) walk([...path, to], Math.min(least, total))
            }
          }
          walk([subject], Infinity)
        }
        found.sort((x, y) => y.amount - x.amount || (x.subjects.join('\u0000') < y.subjects.join('\u0000') ? -1 : 1))
        const rings = found.filter((ring) => ring.subjects.length > 1).slice(0, 50)
        const labels = await tx.labelsOf(unique(rings.flatMap((ring) => ring.subjects)))
        const home = labels.get(subject)?.cluster
        for (const ring of rings) ring.tied = home === undefined ? 0 : ring.subjects.slice(1).filter((other) => labels.get(other)?.cluster === home).length
        return rings
      })
    },

    async forget(subject, why) {
      if (typeof subject !== 'string') throw new TypeError('forget needs a subject')
      keepable(subject)
      return changing(async (tx) => {
        await decide(tx, 'forget', [subject], why)
        const edges = await tx.edgesOf([subject])
        const component = (await tx.labelsOf([subject])).get(subject)?.component
        const affected = new Set(component === undefined ? [] : (await tx.membersOf([component])).keys())
        await mark(tx)
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

    async journey(subject, { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
      if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError('limit must be a whole number above zero')
      return store.read(async (tx) => {
        const own = (await tx.labelsOf([subject])).get(subject)
        const members = own ? (await tx.clusterOf(own.cluster)).sort() : [subject]
        // The person: their cluster, and whoever is tied to any of it strongly enough that their arrivals would be credited.
        // Nobody kept apart from any of them, though: a browser two people used is tied to both, and they are still two.
        const within = new Set(members)
        const links = new Map<Subject, Link>()
        const reached = await reach(tx, members, 2, undefined, links)
        const strong = [...reached].filter(([, { confidence }]) => confidence >= policy.same).map(([each]) => each)
        const everyone = unique([subject, ...members, ...strong.sort()])
        const people = everyone.slice(0, MOST)
        // Inside the cluster a tie is the best chain from the subject asked about, however long.
        const inside = new Map<Subject, Link>()
        const chains = await reach(tx, [subject], members.length, within, inside)
        const tie = (each: Subject): Tie => {
          const [found, link] = within.has(each) ? [chains.get(each), inside.get(each)] : [reached.get(each), links.get(each)]
          return {
            how: each === subject ? 'self' : within.has(each) ? 'cluster' : 'linked',
            score: found?.confidence ?? null,
            via: found?.via ?? [],
            kinds: unique((link?.reasons ?? []).filter((reason) => reason.counted !== false).map((reason) => reason.identifier.slice(0, reason.identifier.indexOf(':')))),
          }
        }

        const entries: Entry[] = []
        for (const touch of await tx.touchesOf(people, 0, before - 1)) entries.push({ at: touch.at, subject: touch.subject, kind: 'arrival', touch })
        const calls = await tx.callsOf(people)
        const outcomes = await tx.outcomesOf(people)
        const not = await tx.notLeads([...calls.map(callId), ...outcomes.map(outcomeId)])
        const spurned = (id: string) => (not.has(id) ? { notLead: not.get(id)!.kind } : {})
        for (const call of calls) entries.push({ at: call.at, subject: call.subject, kind: 'call', call, ...spurned(callId(call)), ...(call.direction === 'inbound' && call.result?.answered === false && { followUp: followUp(call, calls.filter((each) => !not.has(callId(each)))) }) })
        for (const each of people) {
          // One moment is many sightings, one for each identifier. What a call or a reviewer's join left is told by the call and the decision.
          const rang = new Set(calls.filter((call) => call.subject === each || call.visitor === each).map((call) => call.at))
          const moments = new Map<string, Entry & { kind: 'seen' }>()
          for (const { at, event = '', identifier } of await tx.history(each)) {
            if (at >= before || (event === 'call' && rang.has(at)) || (event === 'review' && identifier.startsWith('review:join-'))) continue
            const key = `${at} ${event}`
            const moment = moments.get(key) ?? { at, subject: each, kind: 'seen', event, identifiers: [] }
            moments.set(key, moment)
            moment.identifiers.push(identifier)
          }
          entries.push(...moments.values())
          for (const answer of await tx.consentHistory(each)) entries.push({ at: answer.at, subject: each, kind: 'consent', answer })
        }
        for (const outcome of outcomes) {
          const [first, ...later] = await tx.valuesOf(outcome.transactionId, outcome.subject)
          entries.push({ at: outcome.at, subject: outcome.subject, kind: 'step', outcome, first: first ?? null, ...spurned(outcomeId(outcome)) })
          let from = first
          for (const to of later) {
            entries.push({ at: to.at, subject: outcome.subject, kind: 'value', transactionId: outcome.transactionId, stage: outcome.stage, from: from!, to })
            from = to
          }
        }
        const named = new Set(people)
        for (const decision of await tx.decisionsNaming(people)) entries.push({ at: decision.at, subject: decision.about.find((each) => named.has(each))!, kind: 'decision', decision })

        const found = entries.filter((entry) => entry.at < before).sort((x, y) => x.at - y.at || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.subject < y.subject ? -1 : 1))
        // A page never ends inside a moment, so the next one can begin before it.
        let cut = Math.max(0, found.length - limit)
        while (cut > 0 && found[cut - 1]!.at === found[cut]!.at) cut -= 1
        const page = found.slice(cut)
        return {
          subject,
          ties: Object.fromEntries(unique(page.map((entry) => entry.subject)).map((each) => [each, tie(each)])),
          entries: page,
          next: cut > 0 ? page[0]!.at : null,
          more: everyone.length - people.length,
        }
      })
    },

    history(subject, limit) {
      return store.read((tx) => tx.history(subject, limit))
    },

    rebuild(why) {
      return changing(async (tx) => {
        await decide(tx, 'rebuild', [], why)
        await tx.setBuiltWith(hash)
        const moved = await wrong(tx)
        const labels = new Map(moved.flatMap(({ subject, next }) => (next ? [[subject, next] as const] : [])))
        if (labels.size > 0) await tx.setLabels(labels)
        const changes = moved.map(({ subject, stored, next }) => ({ subject, from: stored?.cluster, to: next?.cluster })).filter((change) => change.from !== change.to)
        await tx.addChanges(now(), changes)
        return changes
      })
    },

    async prune(before, why) {
      if (!Number.isSafeInteger(before)) throw new TypeError('prune needs a time in whole epoch milliseconds')
      return store.write(async (tx) => {
        await decide(tx, 'prune', [String(before)], why)
        return (await tx.pruneSightings(before)) + (await tx.pruneConsent(before)) + (await tx.pruneCallResults(before)) + (await tx.pruneLeases(before)) + (await tx.pruneNotLeads(before))
      })
    },

    decisions() {
      return store.read((tx) => tx.decisions())
    },

    decisionPage(page) {
      return store.read((tx) => tx.decisionPage(page))
    },

    verdicts(pairs) {
      return store.read(async (tx) => [...(await verdictsOf(tx, pairs)).values()])
    },

    disputes(limit = 50) {
      return store.read(async (tx) => {
        // Three reversals take four decisions at least. Counting decisions first leaves few pairs to read in full.
        const verdicts = [...(await verdictsOf(tx, await tx.pairsDecidedBySystems(4))).values()]
        return verdicts.filter((verdict) => verdict.reversals >= 3).sort((x, y) => y.last.seq - x.last.seq).slice(0, limit)
      })
    },

    async audit() {
      const decisions = await graph.decisions()
      const broken = brokenAt(decisions)
      const last = decisions.at(-1)
      return { sound: broken === undefined, ...(broken !== undefined && { brokenAt: broken }), ...(last && { head: { seq: last.seq, hash: last.hash } }) }
    },

    async asOf(at) {
      // Stamp the copy's sightings with the time asked about, so the copy's own log reads as of then.
      const past = createGraph(createMemoryStore(), policy, { now: () => at })
      const decisions = await store.read(async (tx) => {
        // A thousand to a write, however many come at a time.
        let batch: Observation[] = []
        for await (const sightings of tx.sightingsUntil(at)) {
          for (const { subject, identifier, at: seen, event } of sightings) {
            batch.push({ subject, identifiers: [identifier], at: seen, ...(event !== undefined && { event }) })
            if (batch.length < 1000) continue
            await past.observe(batch)
            batch = []
          }
        }
        if (batch.length > 0) await past.observe(batch)
        return (await tx.decisions()).filter((decision) => decision.at <= at)
      })
      for (const { action, about } of decisions) {
        if (action === 'ignore' || action === 'restore') await past.ignore(about[0]!, action === 'ignore')
        if (action === 'separate' || action === 'rejoin') await past.separate(about[0]!, about[1]!, action === 'separate')
      }
      return past
    },

    policy() {
      return store.read(policyState)
    },

    verify() {
      return store.read(differences)
    },

    check() {
      return store.read(async (tx) => ({ changes: await differences(tx), policy: await policyState(tx) }))
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
