import { randomUUID } from 'node:crypto'
import { brokenAt, seal } from './audit.ts'
import { board } from './board.ts'
import type { BoardColumn, BoardPlace } from './board.ts'
import type { Labeled } from './calibrate.ts'
import { summarizeCalls } from './callreport.ts'
import type { CallSummary } from './callreport.ts'
import { followUp, isTie } from './calls.ts'
import { Gone, asks, beginnings, replyTo } from './texts.ts'
import { followed } from './followed.ts'
import type { Followed } from './followed.ts'
import type { Hours } from './hours.ts'
import { UNSTORABLE } from './identifiers.ts'
import { CLICK_IDS, checkTouch } from './touch.ts'
import { createMemoryStore } from './memory.ts'
import type { Job } from './outbox.ts'
import { UNNAMED, defaultPolicy, evidence, joins, plainPolicy, policyHash, ruleFor, told, usable, weigh } from './policy.ts'
import type { Policy } from './policy.ts'
import { dayIn, dayStart, dimension, fold, nextDay } from './report.ts'
import type { Credited } from './report.ts'
import { conflict, knownOf, partition, scorePairs } from './resolve.ts'
import type { Known } from './resolve.ts'
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
  CostRow,
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
  KeptText,
  OpenText,
  SentLink,
  Labels,
  Lease,
  Link,
  Loss,
  Moved,
  CallTime,
  Candidate,
  ChangePage,
  Conflict,
  Payment,
  Person,
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
  /**
   * Records money received for an outcome, or given back. From the first payment on, the outcome is worth what was paid
   * less what was given back, and never below zero. It may come before its outcome. Recording an id again with the same
   * details records it once, and with others is refused.
   */
  pay(payment: Payment): Promise<{ duplicate: boolean; value?: number }>
  /** Several people at once, as a list shows them, in the order given. */
  people(subjects: readonly Subject[], options?: { at?: number }): Promise<Person[]>
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
  /**
   * Unties a call from whoever tapped the number, or keeps it from being tied: another call could have come of the same tap,
   * or came of it, or makes the number busy. Untied, it is filed under `line`, the channel of the number it rang.
   */
  doubtCall(id: string, ambiguous: boolean, line?: Omit<Touch, 'subject' | 'at'>): Promise<void>
  /** Kept calls to a number with `from <= at < to`, oldest first. */
  callsTo(number: string, from: number, to: number): Promise<KeptCall[]>
  /** Every kept call to or from the given subjects, oldest first. */
  callsOf(subjects: readonly Subject[]): Promise<KeptCall[]>
  /**
   * Records a subject and who speaks for it: their browser, the number they call from, or both. Each is related to the
   * subject by a mark of its own, and not joined to it. Said again, it is the mark there is. `identifiers` are what the subject was given of
   * its own, and the marks.
   */
  speak(who: { subject: Subject; identifiers: readonly Identifier[] }, by: readonly { subject: Subject; identifiers: readonly Identifier[] }[], at: number, event?: string): Promise<{ marks: Identifier[]; identifiers: Identifier[]; changes: Change[] }>
  /** Keeps a link made for one person. `POST /link` does this. */
  keepLink(link: { id: string; subject: Subject; purpose?: string; at: number; expires: number }): Promise<void>
  /** Notes that a link made for a subject was opened. Resolves to false when no such link is kept. */
  linkOpened(id: string, subject: Subject, at: number): Promise<boolean>
  /** Every kept link made for anyone of a subject's cluster, oldest first. */
  linksSent(subject: Subject): Promise<SentLink[]>
  /** Keeps a text message, with the arrival it is filed under, unless it is kept already. `recordText` does this. Resolves to whether it was written. */
  keepText(text: Omit<KeptText, 'recorded'>, touch?: Touch): Promise<boolean>
  /** A kept text, or undefined for an id no text was kept for. */
  keptText(id: string): Promise<KeptText | undefined>
  /** Every kept text to or from the given subjects, oldest first. */
  textsOf(subjects: readonly Subject[]): Promise<KeptText[]>
  /**
   * Texts nobody has replied to, the oldest of each sender, oldest first, with what each is credited to. `from` and `to`
   * are days; pass the last text of a page as `after` for the next.
   */
  openTexts(options: { from: string; to: string; timeZone?: string; limit?: number; after?: { at: number; id: string } }): Promise<OpenText[]>
  /** Whether anyone of a subject's cluster last asked, by STOP or START, for no more texts, and when. Undefined when nobody has said. */
  texting(subject: Subject): Promise<{ optedOut: boolean; at: number } | undefined>
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
  /**
   * Every cluster change numbered above `after`, oldest first, so a system that keeps the number it got to misses none.
   * `after` defaults to 0, the first change kept. A subject no change has named is in the cluster of its own name.
   */
  changes(options?: { after?: number; limit?: number }): Promise<ChangePage>
  /**
   * Who somebody with these identifiers may be, strongest first, as if they were seen with them at a time. Nothing is
   * written. Who is tied too weakly to be related is left out.
   */
  match(identifiers: readonly Identifier[], options?: { at?: number; limit?: number }): Promise<Candidate[]>
  /**
   * Which of the given subjects are kept apart, from each other or from anyone on record, themselves or through somebody
   * they are or may be. An empty list says that none is known here, and not that there is none.
   */
  conflicts(subjects: readonly Subject[]): Promise<Conflict[]>
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
  /**
   * Deletes a subject and everything recorded about it, unsent conversions
   * included, or several together: all of them or, if it is refused, none.
   * `gone` hears what conversions were deleted, once they are.
   */
  forget(subject: Subject | readonly Subject[], why?: Deciding, gone?: (jobs: Job[]) => void): Promise<Change[]>
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
  /** The fact that says they are two people, under a policy that keeps people apart by it. Nobody decided it. */
  conflict?: 'birth' | 'given'
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
export interface BoardRow extends Omit<BoardPlace, 'call'> {
  /** Their newest call. */
  call?: KeptCall
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

/** The order of entries at the same moment. A type added to the journey has a place here or does not compile. */
const KIND_ORDER: Record<Entry['kind'], number> = { visit: 0, call: 1, text: 1, link: 1, consent: 2, decision: 3, sighting: 4, outcome: 5, value: 6 }
/** The most subjects of one person a journey reads. */
const MOST = 60
/** How many subjects one read of many takes at a time. */
const TOGETHER = 50_000
const MIXED = 'mixed'
/** The moments a range of days begins and ends in a time zone. */
function range(from: string, to: string, timeZone?: string): [number, number] {
  const start = dayStart(from, timeZone)
  const end = dayStart(nextDay(to), timeZone)
  if (end <= start) throw new TypeError('A report requires `from` on or before `to`')
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
  async function compute(tx: Tx, subjects: readonly Subject[], supposing?: Supposed, onCut?: (a: Subject, b: Subject) => void): Promise<Map<Subject, Labels>> {
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
    const pairs = scorePairs(policy, edges, states)
    const two = pairs.filter(({ reasons }) => told(policy, reasons)).map(({ a, b }): [Subject, Subject] => [a, b])
    return partition(subjects, pairs, separated, policy, knownOf(policy, edges, (identifier) => states.get(identifier)?.ignored ?? false, two.length > 0), onCut, two, sinceOf(edges))
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
    const alone = Object.entries(policy.kinds).filter(([, rule]) => policy.same <= 0 || rule.relates || (!rule.corroborates && rule.weight >= policy.same - 1e-9)).map(([kind]) => kind)
    const pairs: Pair[] = []
    const joined = new Set<Subject>()
    const two: [Subject, Subject][] = []
    for await (const batch of tx.sharing(caps, alone)) {
      for (const shared of batch) {
        const reasons = shared.map(({ a, b, fanout }) => evidence(policy, a, b, fanout))
        const score = weigh(policy, reasons)
        if (told(policy, reasons)) two.push([shared[0]!.a.subject, shared[0]!.b.subject])
        if (!joins(policy, score, reasons)) continue
        const [a, b] = [shared[0]!.a.subject, shared[0]!.b.subject]
        pairs.push({ a, b, score, level: 'same', reasons: [] })
        joined.add(a).add(b)
      }
    }
    const subjects = [...joined]
    const separated = (await tx.separatedOf(subjects)).filter(([a, b]) => joined.has(a) && joined.has(b))
    const said = two.filter(([a, b]) => joined.has(a) && joined.has(b))
    const facts = await known(tx, subjects, said.length > 0)
    const kept = unique([...separated.flat(), ...said.flat(), ...[...facts].filter(([, own]) => own.facts.size > 0).map(([subject]) => subject)])
    const since = new Map<Subject, number>()
    for (let i = 0; i < kept.length; i += TOGETHER) for (const [subject, at] of sinceOf(await tx.edgesOf(kept.slice(i, i + TOGETHER)))) since.set(subject, at)
    return partition(subjects, pairs, separated, policy, facts, undefined, said, since)
  }

  /** When each subject was first seen with anything but a decision about it. */
  function sinceOf(edges: readonly Edge[]): Map<Subject, number> {
    const out = new Map<Subject, number>()
    for (const { subject, identifier, first } of edges) if (!identifier.startsWith('review:') && first < (out.get(subject) ?? Infinity)) out.set(subject, first)
    return out
  }

  /** What is known of these subjects that cannot be two people's. Nothing is read where the policy keeps nobody apart by it. */
  async function known(tx: Tx, subjects: readonly Subject[], joins = false): Promise<Map<Subject, Known>> {
    const out = new Map<Subject, Known>()
    if (!policy.apart?.length && !joins) return out
    for (let i = 0; i < subjects.length; i += TOGETHER) {
      const edges = (await tx.edgesOf(subjects.slice(i, i + TOGETHER))).filter(({ identifier }) => /^(birth|given|initial|dated|review|device|phone|voip|named):/.test(identifier))
      const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
      for (const [subject, facts] of knownOf(policy, edges, (identifier) => states.get(identifier)?.ignored ?? false, joins)) out.set(subject, facts)
    }
    return out
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
    const states = await tx.shared(subjects)
    const open = [...states.keys()].filter((identifier) => usable(policy, identifier, states.get(identifier)))
    const apart = new Set((await tx.separatedOf(subjects)).map(([a, b]) => pairKey(a, b)))
    const from = new Set(subjects)
    const out = new Map<Subject, Link[]>()
    const add = (subject: Subject, link: Link) => {
      if (!from.has(subject)) return
      const links = out.get(subject)
      if (links) links.push(link)
      else out.set(subject, [link])
    }
    const found = scorePairs(policy, await tx.edgesOn(open), states, from)
    const facts = await known(tx, unique(found.flatMap(({ a, b }) => [a, b])))
    const homes = facts.size > 0 ? await tx.labelsOf([...facts.keys()]) : new Map<Subject, Labels>()
    for (const { a, b, score, level, reasons } of found) {
      if (apart.has(pairKey(a, b))) continue
      // In one group in spite of a fact, decisions hold them there, and the fact is overruled.
      const between = homes.get(a) && homes.get(a)!.cluster === homes.get(b)?.cluster ? undefined : conflict(policy, facts.get(a), facts.get(b))
      // However strong what they share is, they are two people, and are shown as related.
      const link = { score, level: between ? ('related' as const) : level, reasons, ...(between && { conflict: between }) }
      add(a, { subject: b, ...link })
      add(b, { subject: a, ...link })
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

  type Reached = Map<Subject, { confidence: number; via: Subject[]; joined?: true; speaks?: true; from?: Subject; earns?: true }>

  /** Every subject within `hops` links of any of those given, with the strength of the best chain to each. With `only`, through those subjects and to them. */
  async function reach(tx: Tx, from: readonly Subject[], hops: number, only?: ReadonlySet<Subject>, last?: Map<Subject, Link>, crediting = false): Promise<Reached> {
    const reached: Reached = new Map(from.map((subject) => [subject, { confidence: 1, via: [] }]))
    // Two subjects kept apart are two people, so nothing of the one is reached from the other, through a third subject either.
    const apart = new Set((await tx.separatedOf(from)).flat().filter((subject) => !reached.has(subject)))
    const borders = bordersOf(tx)
    let frontier = [...from]
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const links = await neighbors(tx, frontier)
      await borders.load([...from, ...frontier, ...[...links.values()].flat().map((link) => link.subject)], links)
      frontier = spread(reached, apart, frontier, links, borders, from, only, last, crediting)
    }
    return reached
  }

  /** Whether one of the two speaks for the other. */
  const speaks = (link: Link) => told(policy, link.reasons) && link.reasons.some(({ identifier }) => identifier.startsWith('behalf:'))
  const unnamed = new Set(policy.unnamed ?? UNNAMED)
  const names = (subject: Subject) => !unnamed.has(subject.slice(0, Math.max(0, subject.indexOf(':'))))

  /** One hop of a search: goes over the links of the frontier, and returns the subjects it found a better chain to. */
  function spread(reached: Reached, apart: ReadonlySet<Subject>, frontier: Subject[], links: ReadonlyMap<Subject, Link[]>, borders: ReturnType<typeof bordersOf>, from: readonly Subject[], only?: ReadonlySet<Subject>, last?: Map<Subject, Link>, crediting = false): Subject[] {
    const improved = new Set<Subject>()
    // As the hop began: a chain made better during it is followed in the next one, or it would be a link longer.
    for (const [near, start] of frontier.sort().map((each) => [each, reached.get(each)!] as const)) {
      for (const link of links.get(near) ?? []) {
        const said = speaks(link)
        if ((link.conflict && !said) || apart.has(link.subject) || (only && !only.has(link.subject)) || (told(policy, link.reasons) && !said)) continue
        // Credit goes from whoever speaks to whoever they speak for, and not on: what brought one of their children did not bring another.
        if (said ? !crediting || start.speaks || !names(near) || names(link.subject) || !borders.one(from[0]!, near) : start.speaks && !borders.one(near, link.subject)) continue
        if (!said && !start.speaks && (borders.cut(near, link.subject) || borders.between(near, link.subject) || from.some((origin) => borders.between(origin, link.subject)))) continue
        const confidence = start.confidence * link.score
        const known = reached.get(link.subject)
        const speaking = (said || start.speaks) && { speaks: true as const, from: said ? near : start.from! }
        if (known && known.confidence >= confidence) {
          // A stronger way there by other links takes nothing from what the mark says.
          if (!speaking || known.speaks) continue
          reached.set(link.subject, { ...known, ...speaking })
        } else reached.set(link.subject, { confidence, via: [...start.via, near], ...(speaking || (known?.speaks && { speaks: true as const, from: known.from! })) })
        last?.set(link.subject, link)
        improved.add(link.subject)
      }
    }
    return [...improved]
  }

  /**
   * The links that separations and facts took, and the groups they keep apart. A search follows no such link, at any hop or from either side,
   * though a later cut may have left a group on one side of it with nobody whose facts are known.
   */
  function bordersOf(tx: Tx) {
    const labels = new Map<Subject, Labels>()
    const facts = new Map<Subject, Known[]>()
    const read = new Set<Subject>()
    const decided = new Map<string, boolean>()
    const taken = new Set<string>()
    /** The groups of two a reviewer keeps apart, and of two where one speaks for the other. Nothing is read for them until such a link is met. */
    const spoken = new Set<string>()
    const marked = new Set<Subject>()
    let met = false
    return {
      /** Whether two are one subject or in one group. */
      one: (a: Subject, b: Subject) => a === b || (labels.has(a) && labels.get(a)!.cluster === labels.get(b)?.cluster),
      /** Whether a separation or a fact took the link between two, and they are not one by others. */
      cut: (a: Subject, b: Subject) => taken.has(pairKey(a, b)) && labels.get(a)?.cluster !== labels.get(b)?.cluster,
      async load(subjects: Iterable<Subject>, links: ReadonlyMap<Subject, Link[]> = new Map()): Promise<void> {
        const said = [...links].flatMap(([near, list]) => list.filter(speaks).map((link) => [near, link.subject] as const))
        met ||= said.length > 0
        // A strong link out of a group was cut, and it may be for a mark between two others of the two groups.
        const strong = [...links].some(([, list]) => list.some((link) => link.level === 'same'))
        if (!policy.apart?.length && !met && !strong) return
        const unread = unique([...subjects].filter((subject) => !labels.has(subject)))
        for (let i = 0; i < unread.length; i += TOGETHER) for (const [subject, own] of await tx.labelsOf(unread.slice(i, i + TOGETHER))) labels.set(subject, own)
        for (const [a, b] of said) if (labels.get(a)?.cluster !== labels.get(b)?.cluster) spoken.add(pairKey(labels.get(a)!.cluster, labels.get(b)!.cluster))
        const over = [...links].flatMap(([near, list]) => list.filter((link) => link.level === 'same' && labels.get(near)?.cluster !== labels.get(link.subject)?.cluster).map(() => labels.get(near)?.component ?? near))
        const cutUps = unique(over).filter((id) => !marked.has(id))
        for (let i = 0; i < cutUps.length; i += TOGETHER) {
          for (const id of cutUps.slice(i, i + TOGETHER)) marked.add(id)
          const members = await tx.membersOf(cutUps.slice(i, i + TOGETHER))
          const marks = (await tx.edgesOf([...members.keys()])).filter((edge) => edge.identifier.startsWith('behalf:'))
          const states = await tx.states(unique(marks.map((edge) => edge.identifier)))
          for (const { a, b, reasons } of scorePairs(policy, marks, states, undefined, 0)) if (told(policy, reasons) && members.get(a)!.cluster !== members.get(b)!.cluster) spoken.add(pairKey(members.get(a)!.cluster, members.get(b)!.cluster))
          // Two a reviewer keeps apart are two, and what was cut off with the one is not the other's.
          const apart = (await tx.separatedOf([...members.keys()])).filter(([a, b]) => members.has(a) && members.has(b) && members.get(a)!.component === members.get(b)!.component)
          for (const [a, b] of apart) if (members.get(a)!.cluster !== members.get(b)!.cluster) spoken.add(pairKey(members.get(a)!.cluster, members.get(b)!.cluster))
          const split = new Set(apart.map(([a]) => members.get(a)!.component))
          if (split.size > 0) await compute(tx, [...members].filter(([, own]) => split.has(own.component)).map(([subject]) => subject), undefined, (a, b) => taken.add(pairKey(a, b)))
        }
        if (!policy.apart?.length) return
        const ids = unique(unread.flatMap((subject) => labels.get(subject)?.component ?? [])).filter((id) => !read.has(id))
        for (let i = 0; i < ids.length; i += TOGETHER) {
          const members = await tx.membersOf(ids.slice(i, i + TOGETHER))
          const some = new Map<Subject, Known[]>()
          for (const [subject, own] of await known(tx, [...members.keys()])) {
            const { cluster, component } = members.get(subject)!
            if (own.facts.size === 0) continue
            facts.set(cluster, [...(facts.get(cluster) ?? []), own])
            some.set(component, [...(some.get(component) ?? []), own])
          }
          // Worked out again only where somebody differs from somebody: what was cut is not stored.
          const cutUp = new Set([...some].filter(([, facts]) => facts.some((one, i) => facts.slice(i + 1).some((other) => conflict(policy, one, other)))).map(([component]) => component))
          if (cutUp.size > 0) await compute(tx, [...members].filter(([, own]) => cutUp.has(own.component)).map(([subject]) => subject), undefined, (a, b) => taken.add(pairKey(a, b)))
        }
        for (const id of ids) read.add(id)
      },
      between(a: Subject, b: Subject): boolean {
        const [x, y] = [labels.get(a), labels.get(b)]
        if (x && y && spoken.has(pairKey(x.cluster, y.cluster))) return true
        if (!x || !y || x.cluster === y.cluster || x.component !== y.component) return false
        const key = pairKey(x.cluster, y.cluster)
        let found = decided.get(key)
        if (found === undefined) decided.set(key, (found = (facts.get(x.cluster) ?? []).some((one) => (facts.get(y.cluster) ?? []).some((other) => conflict(policy, one, other)))))
        return found
      },
    }
  }

  /** `reach` from each of many subjects by itself, read together: one read a hop for a thousand of them, not one for each. */
  async function reachEach(tx: Tx, subjects: readonly Subject[], hops: number): Promise<Map<Subject, Reached>> {
    const out = new Map<Subject, Reached>()
    for (let i = 0; i < subjects.length; i += TOGETHER) {
      const searches = subjects.slice(i, i + TOGETHER).map((subject) => ({ subject, reached: new Map([[subject, { confidence: 1, via: [] }]]) as Reached, apart: new Set<Subject>(), frontier: [subject] }))
      const bySubject = new Map(searches.map((search) => [search.subject, search]))
      const borders = bordersOf(tx)
      await borders.load(bySubject.keys())
      for (const [a, b] of await tx.separatedOf([...bySubject.keys()])) {
        bySubject.get(a)?.apart.add(b)
        bySubject.get(b)?.apart.add(a)
      }
      const links = new Map<Subject, Link[]>()
      for (let hop = 0; hop < hops && searches.some((search) => search.frontier.length > 0); hop++) {
        const unread = unique(searches.flatMap((search) => search.frontier)).filter((subject) => !links.has(subject))
        for (let j = 0; j < unread.length; j += TOGETHER) {
          const some = unread.slice(j, j + TOGETHER)
          const found = await neighbors(tx, some)
          for (const subject of some) links.set(subject, found.get(subject) ?? [])
          await borders.load([...bySubject.keys(), ...some, ...[...found.values()].flat().map((link) => link.subject)], found)
        }
        for (const search of searches) search.frontier = spread(search.reached, search.apart, search.frontier, links, borders, [search.subject], undefined, undefined, true)
      }
      for (const { subject, reached } of searches) out.set(subject, reached)
    }
    return out
  }

  /**
   * Marks whoever a search found in the searcher's own cluster. A chain of links multiplies, so two that each join can come
   * to less than one that joins, and the cluster has already been decided. Whoever speaks for the searcher is one person too,
   * and what brought any of that person's browsers brought the searcher.
   */
  async function asOne(tx: Tx, searches: Map<Subject, Reached>): Promise<Map<Subject, Reached>> {
    const everyone = unique([...searches.values()].flatMap((reached) => [...reached.keys()]))
    const clusters = new Map<Subject, Subject>()
    for (let i = 0; i < everyone.length; i += TOGETHER) for (const [subject, { cluster }] of await tx.labelsOf(everyone.slice(i, i + TOGETHER))) clusters.set(subject, cluster)
    for (const [subject, reached] of searches) {
      const own = clusters.get(subject)
      if (own === undefined) continue
      const homes = new Set([own])
      for (const [each, found] of reached) if (found.speaks && clusters.get(found.from!) === own && clusters.get(each) !== own) homes.add(clusters.get(each)!)
      for (const [each, found] of reached) {
        if (clusters.get(each) === own) found.joined = true
        else if (found.speaks && homes.has(clusters.get(each)!)) found.earns = true
      }
    }
    return searches
  }

  /** The same credit as `credit` for many conversions of about one time, read together. `reached` keeps the searches for the next such read. */
  async function creditAll(tx: Tx, asked: readonly { subject: Subject; at: number }[], window: number, hops: number, reached = new Map<Subject, Reached>()): Promise<(subject: Subject, at: number) => Attribution> {
    const subjects = unique(asked.map(({ subject }) => subject))
    for (const [subject, found] of await asOne(tx, await reachEach(tx, subjects.filter((subject) => !reached.has(subject)), hops))) reached.set(subject, found)
    const touches = new Map<Subject, Touch[]>()
    if (asked.length > 0) {
      let [from, to] = [Infinity, -Infinity]
      for (const { at } of asked) [from, to] = [Math.min(from, at - window), Math.max(to, at)]
      const everyone = unique(subjects.flatMap((subject) => [...reached.get(subject)!.keys()]))
      for (let i = 0; i < everyone.length; i += TOGETHER) {
        for (const touch of await tx.touchesOf(everyone.slice(i, i + TOGETHER), from, to)) {
          const theirs = touches.get(touch.subject)
          if (theirs) theirs.push(touch)
          else touches.set(touch.subject, [touch])
        }
      }
    }
    return (subject, at) => {
      const within = reached.get(subject)!
      return credited(subject, at, within, [...within.keys()].flatMap((each) => (touches.get(each) ?? []).filter((touch) => touch.at >= at - window && touch.at <= at)))
    }
  }

  /** The touches in the window before a conversion, on every subject reached, and the one that earns the credit. */
  const credit = async (subject: Subject, at: number, window: number, reached: Reached, tx: Tx): Promise<Attribution> => credited(subject, at, reached, await tx.touchesOf([...reached.keys()], at - window, at))

  /** A call or text filed under its number's own channel, which is where it was made and no visit. */
  const byLine = (touch: Touch) => /^(tel|sms):/.test(touch.landing ?? '')
  /** An arrival that says which ad or campaign brought it. */
  const campaigned = (touch: Touch) => !byLine(touch) && Boolean(CLICK_IDS.some((id) => touch[id]) || touch.campaign || touch.campaignId)
  /**
   * Of touches newest first, the one that earns the credit: the newest that is the person's. Where that is a phone line, an
   * ad click or a campaign that brought them before it comes first, because the line is only where they called.
   */
  const own = (touches: readonly AttributedTouch[]) => touches.filter((touch) => touch.confidence >= policy.same || ((touch.joined || touch.speaker) && !byLine(touch)))
  const earning = (touches: readonly AttributedTouch[]): AttributedTouch | undefined => {
    const theirs = own(touches)
    return (theirs[0] && byLine(theirs[0]) && theirs.find(campaigned)) || theirs[0]
  }

  function credited(subject: Subject, at: number, reached: Reached, found: readonly Touch[]): Attribution {
    const touches: AttributedTouch[] = found
      .map((touch) => {
        const { confidence, via, joined = false, earns } = reached.get(touch.subject)!
        return { ...touch, confidence, via, joined, ...(earns && { speaker: true as const }) }
      })
      .sort((x, y) => y.at - x.at || y.confidence - x.confidence || (x.subject < y.subject ? -1 : 1))
    const best = earning(touches)
    const reason = best ? 'credited' : touches.length > 0 ? 'low_confidence' : 'no_touch'
    return { subject, at, touches, credited: best, reason }
  }

  /** Those of some outcomes, or of some calls, that nobody said were no lead. */
  const leadsOf = async <T>(tx: Tx, list: readonly T[], id: (each: T) => string): Promise<T[]> => {
    const not = await tx.notLeads(list.map(id))
    return not.size === 0 ? [...list] : list.filter((each) => !not.has(id(each)))
  }
  const outcomeId = (outcome: Counted) => outcome.transactionId
  /** A text with the flag that says it began a conversation, which is worked out and not kept. */
  const withFirst = (text: KeptText, own: readonly KeptText[]): KeptText => (beginnings(own).has(text.id) ? { ...text, flags: ['first', ...text.flags] } : text)
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
    if (!Number.isSafeInteger(seen) || seen < 0) throw new TypeError('`seen` must be a decision number')
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
    if (!Array.isArray(pairs)) throw new TypeError(`${verb} requires a list of pairs`)
    return pairs.map((told) => ({ pair: pairOf(told?.a, told?.b, verb), separated: told.separated ?? true, why: { ...why, ...(told.reason && { reason: String(told.reason) }) } }))
  }

  /** An outcome as its payments have it: what they come to, to the hundred-thousandth, in their currency. */
  function paidFor(outcome: Counted, payments: readonly Required<Payment>[]): Counted {
    if (payments.length === 0) return outcome
    const paid = payments.find((each) => each.currency)?.currency
    if (paid && outcome.currency && outcome.currency !== paid) throw new TypeError(`Outcome "${outcome.transactionId}" must use the currency of its payments`)
    const value = payments.reduce((sum, { kind, amount }) => sum + (kind === 'refund' ? -amount : amount), 0)
    return { ...outcome, value: Math.max(0, Math.round(value * 1e5) / 1e5), currency: outcome.currency || paid || '' }
  }

  /** Adds an outcome's value to its history, unless it is the one it already has. */
  async function revalue(tx: Tx, { transactionId, subject, value, currency }: Counted, kind?: Loss): Promise<void> {
    const last = (await tx.valuesOf(transactionId, subject)).at(-1)
    if (last?.value !== value || last.currency !== currency) await tx.addValue(transactionId, subject, { value, currency, at: now(), ...(kind && { kind }) })
  }

  /** Refuses text the database cannot keep, before anything is written. */
  const keepable = (...texts: (string | undefined)[]) => {
    for (const text of texts) if (text !== undefined && UNSTORABLE.test(text)) throw new TypeError('Text contains unsupported characters')
  }

  const pairOf = (a: Subject, b: Subject, verb: string): [Subject, Subject] => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) throw new TypeError(`${verb} requires two different subjects`)
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
        if (typeof subject !== 'string' || !subject) throw new TypeError('An observation requires a subject')
        if (!Number.isSafeInteger(at)) throw new TypeError(`Observation of "${subject}" requires "at", an integer in epoch milliseconds`)
        if (event !== undefined && typeof event !== 'string') throw new TypeError(`Observation of "${subject}" requires its event as a string`)
        if (UNSTORABLE.test(subject) || (event !== undefined && UNSTORABLE.test(event))) throw new TypeError('An observation contains unsupported characters')
        for (const identifier of new Set(identifiers)) {
          if (UNSTORABLE.test(identifier)) throw new TypeError('An observation contains unsupported characters')
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

    async match(identifiers, { at = now(), limit = 20 } = {}) {
      const given = unique(identifiers)
      for (const each of given) ruleFor(policy, each)
      // Nobody's id: no subject on record has an empty one.
      const nobody = ''
      return store.read(async (tx) => {
        const states = new Map([...(await tx.states(given))].map(([identifier, state]) => [identifier, { ...state, fanout: state.fanout + 1 }]))
        const open = given.filter((identifier) => usable(policy, identifier, states.get(identifier)))
        const edges = [...(await tx.edgesOn(open)), ...open.map((identifier): Edge => ({ subject: nobody, identifier, first: at, last: at, count: 1 }))]
        const found = scorePairs(policy, edges, states, new Set([nobody]))
        const labels = await tx.labelsOf(found.map((pair) => pair.b))
        found.sort((x, y) => y.score - x.score || (x.b < y.b ? -1 : 1))
        const out: Candidate[] = []
        const some = found.slice(0, limit)
        const facts = await known(tx, some.map((pair) => pair.b))
        const own = knownOf(policy, given.map((identifier): Edge => ({ subject: nobody, identifier, first: at, last: at, count: 1 })), () => false).get(nobody)
        for (const { b: subject, score, level, reasons } of some) {
          const between = conflict(policy, own, facts.get(subject))
          out.push({ subject, score, level: between ? 'related' : level, reasons, ...(between && { conflict: between }), members: (await tx.clusterOf(labels.get(subject)!.cluster)).sort() })
        }
        return out
      })
    },

    conflicts(subjects) {
      return store.read(async (tx) => {
        const asked = unique(subjects)
        const labels = await tx.labelsOf(asked)
        // Who each is: itself, everyone in its cluster, and everyone any of those is only related to.
        const people = new Map<Subject, Map<Subject, Conflict['how']>>()
        for (const subject of asked) {
          const own = labels.get(subject)
          const who = new Map<Subject, Conflict['how']>([[subject, 'recorded']])
          const members = own ? await tx.clusterOf(own.cluster) : []
          for (const member of members) if (!who.has(member)) who.set(member, 'same')
          const related = unique([...(await neighbors(tx, [...who.keys()])).values()].flat().filter((link) => !link.conflict).map((link) => link.subject)).filter((each) => !who.has(each))
          const theirs = await tx.labelsOf(related)
          // Whoever any of them is kept apart from is somebody else, and so is everyone that person is.
          const others = new Set((await tx.separatedOf([...who.keys()])).flat().filter((each) => !who.has(each)))
          for (const each of unique([...theirs.values()].map((label) => label.cluster))) {
            const group = await tx.clusterOf(each)
            if (!group.some((member) => others.has(member))) for (const member of group) if (!who.has(member)) who.set(member, 'possible')
          }
          people.set(subject, who)
        }
        const order = ['recorded', 'same', 'possible'] as const
        const weaker = (x: Conflict['how'], y: Conflict['how']) => order[Math.max(order.indexOf(x), order.indexOf(y))]!
        const found = new Map<string, Conflict>()
        for (const a of asked) {
          const who = people.get(a)!
          for (const [x, y] of await tx.separatedOf([...who.keys()])) {
            for (const [mine, theirs] of [[x, y], [y, x]] as const) {
              const how = who.get(mine)
              if (!how || theirs === a) continue
              // Against those asked about who may be the other side, and the other side itself unless one of them surely is.
              const against = asked.filter((b) => b !== a && people.get(b)!.has(theirs))
              const sure = against.some((b) => people.get(b)!.get(theirs) !== 'possible')
              for (const b of new Set(sure ? against : [...against, theirs])) {
                const conflict: Conflict = { a, b, how: weaker(how, b === theirs ? 'recorded' : people.get(b)!.get(theirs)!), rests: x < y ? [x, y] : [y, x] }
                const key = `${a}\u0000${b}`
                const known = found.get(key)
                if (!known || order.indexOf(conflict.how) < order.indexOf(known.how)) found.set(key, conflict)
              }
            }
          }
        }
        return [...found.values()].sort((p, q) => order.indexOf(p.how) - order.indexOf(q.how) || (p.a === q.a ? (p.b < q.b ? -1 : 1) : p.a < q.a ? -1 : 1))
      })
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
        const facts = await known(tx, unique([a, b]))
        const between = a === b || (x !== undefined && x.cluster === y?.cluster) ? undefined : conflict(policy, facts.get(a), facts.get(b))
        return {
          known: held.size > 0 && others.size > 0,
          joined: x !== undefined && x.cluster === y?.cluster,
          apart: (await tx.separatedOf([a])).some((each) => each.includes(b)),
          ...(between && { conflict: between }),
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
      return store.read(async (tx) => credit(subject, at, window, (await asOne(tx, new Map([[subject, await reach(tx, [subject], hops, undefined, undefined, true)]]))).get(subject)!, tx))
    },

    async outcome(outcome) {
      const { transactionId, subject, at } = outcome
      if (!transactionId || !subject) throw new TypeError('An outcome requires a transactionId and a subject')
      if (typeof transactionId !== 'string' || typeof subject !== 'string') throw new TypeError('An outcome requires a transactionId and a subject, as strings')
      if (!Number.isSafeInteger(at)) throw new TypeError(`Outcome "${transactionId}" requires "at", an integer in epoch milliseconds`)
      const value = outcome.value ?? 0
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Outcome "${transactionId}" has a value that is not a number`)
      for (const text of [outcome.stage, outcome.currency]) if (text !== undefined && typeof text !== 'string') throw new TypeError(`Outcome "${transactionId}" requires its stage and currency as strings`)
      keepable(transactionId, subject, outcome.stage, outcome.currency)
      const tags = checkTags(outcome.tags, `Outcome "${transactionId}"`)
      const counted: Counted = { transactionId, subject, at, stage: outcome.stage || 'outcome', value, currency: outcome.currency ?? '', ...(tags && { tags }) }
      return store.write(async (tx) => {
        if (await tx.outcomeOf(transactionId)) return false
        // Whoever was forgotten while their text was being counted is not written down again.
        if (outcome.ofText !== undefined && (await tx.textOf(outcome.ofText))?.subject !== subject) throw new Gone()
        // Paid for before it was recorded, it is worth what was paid.
        const worth = paidFor(counted, await tx.paymentsOf(transactionId))
        await tx.setOutcome(worth)
        await revalue(tx, worth)
        return true
      })
    },

    async pay({ id, transactionId, amount, kind = 'payment', currency = '' }) {
      if (typeof id !== 'string' || !id || typeof transactionId !== 'string' || !transactionId) throw new TypeError('A payment requires an id and a transactionId, as strings')
      if (!(typeof amount === 'number' && amount >= 1e-5 && amount <= 1e10)) throw new TypeError(`Payment "${id}" requires an amount above zero, of ten billion at most`)
      if (kind !== 'payment' && kind !== 'refund') throw new TypeError(`Payment "${id}" must be a payment or a refund`)
      if (typeof currency !== 'string') throw new TypeError(`Payment "${id}" requires its currency as a string`)
      keepable(id, transactionId, currency)
      return store.write(async (tx) => {
        const before = await tx.paymentOf(id)
        const outcome = await tx.outcomeOf(transactionId)
        if (before && (before.transactionId !== transactionId || before.amount !== amount || before.kind !== kind || before.currency !== currency)) throw new TypeError(`Payment "${id}" was already recorded with different details`)
        if (before) return { duplicate: true, ...(outcome && { value: outcome.value }) }
        const payments = [...(await tx.paymentsOf(transactionId)), { id, transactionId, amount, kind, currency }]
        if (new Set([outcome?.currency, ...payments.map((each) => each.currency)].filter(Boolean)).size > 1) throw new TypeError(`Payment "${id}" must use the currency of its outcome`)
        await tx.addPayment(payments.at(-1)!)
        if (!outcome) return { duplicate: false }
        const worth = paidFor(outcome, payments)
        if (worth.value !== outcome.value || worth.currency !== outcome.currency) {
          await tx.setOutcome(worth)
          // What was given back is counted from the refunds, which come in any order, and not from how the value moved.
          await revalue(tx, worth)
        }
        return { duplicate: false, value: worth.value }
      })
    },

    people(subjects, { at = now() } = {}) {
      return store.read(async (tx) => {
        const asked = unique(subjects)
        const labels = await tx.labelsOf(asked)
        const creditOf = await creditAll(tx, asked.map((subject) => ({ subject, at })), 90 * DAY, 2)
        const out: Person[] = []
        for (const subject of asked) {
          const own = labels.get(subject)
          const members = own ? (await tx.clusterOf(own.cluster)).sort() : [subject]
          const said = (await tx.textsOf(members)).filter((text) => text.flags.includes('opt_out') || text.flags.includes('opt_in')).at(-1)
          const { credited } = creditOf(subject, at)
          out.push({ subject, members, ...(credited && { touch: credited }), optedOut: said?.flags.includes('opt_out') ?? false })
        }
        return out
      })
    },

    async restate(transactionId, value, currency, kind) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('A restated value must be zero or more')
      if (currency !== undefined && typeof currency !== 'string') throw new TypeError('A restated currency must be a string')
      if (kind !== undefined && kind !== 'refund' && kind !== 'write_off') throw new TypeError('`kind` must be `refund` or `write_off`')
      keepable(transactionId, currency)
      return store.write(async (tx) => {
        const found = await tx.outcomeOf(transactionId)
        if (!found) return false
        if (kind !== undefined) {
          if (currency && currency !== found.currency) throw new TypeError('A refund or write-off must use the currency of the outcome')
          // One said by mistake is taken back by saying it the other way, and no more than was said.
          let said = 0
          // As much as the sums below can be off by, which grows with what they are made of.
          let off = Number.EPSILON * value
          if (value > found.value) {
            const values = await tx.valuesOf(transactionId, found.subject)
            values.forEach((each, i) => {
              if (each.kind !== kind || each.currency !== found.currency) return
              const before = values[i - 1]!.value
              said += before - each.value
              off += Number.EPSILON * Math.max(before, each.value, Math.abs(said))
            })
          }
          if (value > found.value && (said <= 0 || value - found.value > said + off)) throw new TypeError(`Outcome "${transactionId}" cannot reverse more than was ${kind === 'refund' ? 'refunded' : 'written off'}`)
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
        // One doubted meanwhile is not tied either.
        const doubted = (await tx.states([`dial:${call.id}`])).get(`dial:${call.id}`)?.ignored === true
        const tied = visitor !== undefined && (await tx.edgesOn([...(doubted ? [] : [`dial:${call.id}`]), `lease:${call.id}`])).some((edge) => edge.subject === visitor)
        // What was said of it meanwhile stays said.
        const said = (await tx.callOf(call.id))?.flags.includes('ambiguous') && doubted && !call.flags.includes('pool')
        await tx.setCall({ ...rest, ...(said && { flags: [...new Set([...call.flags, 'ambiguous'])] }), ...(tied && { visitor }), recorded: now() })
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
      if (typeof id !== 'string' || !id) throw new TypeError('`transactionId` is required')
      if (kind !== undefined && kind !== 'spam' && kind !== 'other') throw new TypeError('`kind` must be `spam` or `other`')
      await store.write((tx) => tx.setNotLead(id, kind && { kind, at: now() }))
    },

    notLeads(ids) {
      return store.read((tx) => tx.notLeads(ids))
    },

    keptCall(id) {
      return store.read((tx) => tx.callOf(id))
    },

    async speak(who, by, at, event = 'speaker') {
      ruleFor(policy, 'behalf:0')
      if (!names(who.subject) || by.some((each) => names(each.subject))) throw new TypeError('A browser or a caller speaks for a record of yours')
      const marks: Identifier[] = []
      let identifiers: readonly Identifier[] = who.identifiers
      // One transaction, with what is known of each: no moment has them as one.
      const changes = await changing(async (tx) => {
        marks.length = 0
        const held = await tx.edgesOf([who.subject, ...by.map((each) => each.subject)])
        const edges = held.filter((edge) => edge.identifier.startsWith('behalf:'))
        // A browser known by another id too is the same browser.
        const theirs = new Set(held.filter((edge) => edge.subject !== who.subject && edge.identifier.startsWith('device:')).map((edge) => edge.identifier))
        identifiers = who.identifiers.filter((each) => !theirs.has(each))
        const own = edges.filter((edge) => edge.subject === who.subject).map((edge) => edge.identifier).sort()
        // Said again, it is the mark there is, muted or not. It names nobody, so a forgotten id leaves no trace.
        for (const [i, each] of by.entries()) {
          const before = by.findIndex((other) => other.subject === each.subject)
          marks.push(before < i ? marks[before]! : (own.find((mark) => edges.some((edge) => edge.subject === each.subject && edge.identifier === mark)) ?? `behalf:${randomUUID()}`))
        }
        const recorded = now()
        return record(tx, [{ ...who, identifiers: [...identifiers, ...marks] }, ...by.map((each, i) => ({ ...each, identifiers: [...each.identifiers, marks[i]!] }))].flatMap((each) => unique(each.identifiers).map((identifier) => ({ subject: each.subject, identifier, at, event, recorded }))))
      })
      return { marks, identifiers: [...identifiers, ...new Set(marks)], changes }
    },

    async tieCall(caller, visitor, identifier, at, by) {
      ruleFor(policy, identifier)
      let tied = false
      // One transaction: two calls reported at once cannot both find the visitor free.
      await changing(async (tx) => {
        const apart = (await tx.separatedOf([caller])).some((pair) => pair.includes(visitor))
        const others = ((await neighbors(tx, [visitor])).get(visitor) ?? []).some((link) => link.subject !== caller && link.reasons.some((reason) => isTie(reason.identifier, visitor, link.subject)))
        // What matched the two is read again: whoever was forgotten meanwhile is not tied, even where they have been seen since.
        const matched = 'pool' in by ? (await holderOf(tx, by.pool, at, by.grace)) === visitor : (await tx.edgesOn(by.notes)).some((edge) => edge.subject === visitor)
        // Another call reported meanwhile may have cast doubt on it.
        tied = !apart && !others && matched && !(await tx.states([identifier])).get(identifier)?.ignored
        return tied ? record(tx, [caller, visitor].map((subject) => ({ subject, identifier, at, event: 'call', recorded: now() }))) : []
      })
      return tied
    },

    async doubtCall(id, ambiguous, line) {
      const identifier = `dial:${id}`
      await changing(async (tx) => {
        // What a person has looked at and restored stays.
        if ((await tx.newestNaming([identifier], 0, ['ignore', 'restore']))?.action === 'restore') return []
        const call = await tx.callOf(id)
        // Shown the number, it is of no tap.
        if (call?.flags.includes('pool')) return []
        if (call && (call.visitor !== undefined || (ambiguous && !call.flags.includes('ambiguous')))) {
          const { visitor, ...rest } = call
          await tx.setCall({ ...rest, flags: [...new Set([...call.flags, ...(ambiguous ? ['ambiguous'] : [])])] })
          if (line && visitor !== undefined) await tx.addTouch({ ...line, subject: call.subject, at: call.at })
        }
        if ((await tx.states([identifier])).get(identifier)?.ignored) return []
        // Nobody decided anything, so nothing is added to the audit log, which is kept for good. The call says it is in doubt.
        const holders = (await tx.edgesOn([identifier])).map((edge) => edge.subject)
        await tx.setIgnored(identifier, true)
        if (holders.length === 0) return []
        await mark(tx)
        return settle(tx, new Set(holders))
      })
    },

    async callsTo(number, from, to) {
      return (await store.read((tx) => tx.callsBetween(from, to))).filter((call) => call.to === number)
    },

    followable(subject, since) {
      return store.read((tx) => followable(tx, subject, since, now()))
    },

    async lease(subject, { numbers, minutes, at = now(), arrivedSince }) {
      if (typeof subject !== 'string' || !subject) throw new TypeError('A lease requires a subject')
      if (!Number.isSafeInteger(at)) throw new TypeError('A lease requires `at`, an integer in epoch milliseconds')
      if (!(Number.isFinite(minutes) && minutes > 0)) throw new TypeError('A lease requires its length in minutes, above zero')
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

    async keepLink(link) {
      keepable(link.id, link.subject, link.purpose)
      await store.write((tx) => tx.setLink({ ...link, openings: 0 }))
    },

    linkOpened(id, subject, at) {
      return store.write(async (tx) => {
        const link = await tx.linkOf(id)
        if (link?.subject !== subject) return false
        await tx.setLink({ ...link, opened: Math.min(link.opened ?? at, at), openings: link.openings + 1 })
        return true
      })
    },

    linksSent(subject) {
      return store.read(async (tx) => {
        const own = (await tx.labelsOf([subject])).get(subject)
        return tx.linksSent(own ? await tx.clusterOf(own.cluster) : [subject])
      })
    },

    async keepText(text, touch) {
      keepable(text.id, text.subject, text.to, text.visitor, ...text.flags)
      if (touch) checkTouch(touch)
      return store.write(async (tx) => {
        if (await tx.textOf(text.id)) return false
        const { visitor, ...rest } = text
        // Whoever was forgotten since the two were tied is not written down again.
        const tied = visitor !== undefined && (await tx.edgesOn([`text:${text.id}`, `dial:text-${text.id}`])).some((edge) => edge.subject === visitor)
        await tx.setText({ ...rest, ...(tied && { visitor }), recorded: now() })
        if (touch) {
          await tx.addTouch(touch)
          await tx.fed('touches', now())
        }
        return true
      })
    },

    keptText(id) {
      return store.read((tx) => tx.textOf(id))
    },

    textsOf(subjects) {
      return store.read((tx) => tx.textsOf(subjects))
    },

    openTexts({ from, to, timeZone, limit = 50, after }) {
      const [start, end] = range(from, to, timeZone)
      return store.read(async (tx) => {
        const open = await tx.openTexts(start, end, limit, after)
        const senders = unique(open.map((each) => each.subject))
        const theirs = await tx.textsOf(senders)
        const calls = await leadsOf(tx, await tx.callsOf(senders), callId)
        const creditOf = await creditAll(tx, open, 90 * DAY, 2)
        return open.map((text) => {
          const { credited } = creditOf(text.subject, text.at)
          const [own, spoken] = [theirs.filter((each) => each.subject === text.subject), calls.filter((each) => each.subject === text.subject)]
          const unanswered = own.filter((each) => asks(each) && replyTo(each, own, spoken).state === 'open').length
          return { text: withFirst(text, own), unanswered, ...(credited && { touch: credited }) }
        })
      })
    },

    texting(subject) {
      return store.read(async (tx) => {
        const own = (await tx.labelsOf([subject])).get(subject)
        const members = own ? await tx.clusterOf(own.cluster) : [subject]
        const said = (await tx.textsOf(members)).filter((text) => text.flags.includes('opt_out') || text.flags.includes('opt_in')).at(-1)
        return said && { optedOut: said.flags.includes('opt_out'), at: said.at }
      })
    },

    openCalls({ from, to, timeZone, limit = 50, after }) {
      const [start, end] = range(from, to, timeZone)
      return store.read(async (tx) => {
        const open = await tx.openCalls(start, end, limit, after)
        const later = await leadsOf(tx, await tx.callsOf(unique(open.map((call) => call.subject))), callId)
        const out: OpenCall[] = []
        const creditOf = await creditAll(tx, open, 90 * DAY, 2)
        for (const call of open) {
          const { credited } = creditOf(call.subject, call.at)
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
      if (!Array.isArray(steps) || !steps.every((step) => typeof step?.name === 'string' && step.name)) throw new TypeError('`steps` must be a list, such as [{ name: "inquiry" }]')
      if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new TypeError('`days` must be an integer from 1 to 365')
      const day = dayIn(at, timeZone)
      const today = dayStart(day, timeZone)
      const from = dayStart(new Date(Date.parse(day) - (days - 1) * DAY).toISOString().slice(0, 10), timeZone)
      return store.read(async (tx) => {
        const outcomes = await leadsOf(tx, await tx.outcomesBetween(from, at + 1), outcomeId)
        const found = unique([...outcomes.map((each) => each.subject), ...(await tx.calledBetween(from, at + 1))])
        const everyone = await tx.aroundOf(found)
        const person = (subject: Subject) => everyone.get(subject)?.cluster ?? subject
        const people = new Map(found.map((subject) => [person(subject), { outcomes: [] as Counted[], calls: [] as CallTime[] }]))
        const theirs = unique([...found, ...everyone.keys()]).filter((subject) => people.has(person(subject)))
        for (const outcome of await leadsOf(tx, await tx.outcomesOf(theirs), outcomeId)) people.get(person(outcome.subject))!.outcomes.push(outcome)
        for (const call of await tx.callTimes(theirs)) people.get(person(call.subject))!.calls.push(call)
        const { columns, unplaced } = board([...people.values()], { steps: steps.map(({ name, wait }) => ({ name, ...(wait && { wait: wait * HOUR }) })), at, today, ...(returnHours > 0 && { returnWait: returnHours * HOUR }), ...(hours && { hours }) })
        // Only those shown are traced to an ad: it is the slow part.
        const shown: BoardColumn<BoardRow>[] = []
        const placed = columns.flatMap((column) => column.rows.slice(0, limit))
        const creditOf = await creditAll(tx, placed, 90 * DAY, 2)
        const calls = new Map((await tx.callsWith(placed.flatMap((place) => place.call?.id ?? []))).map((call) => [call.id, call]))
        for (const column of columns) {
          const rows: BoardRow[] = []
          for (const place of column.rows.slice(0, limit)) {
            const { credited } = creditOf(place.subject, place.at)
            const { call: newest, ...rest } = place
            const call = newest && calls.get(newest.id)
            const language = place.outcome?.tags?.language ?? call?.tags?.language ?? touchTag(credited, 'language')
            rows.push({ ...rest, ...(call && { call }), ...(credited && { touch: credited }), ...(language !== undefined && { language }) })
          }
          shown.push({ ...column, rows })
        }
        return { at, day, from: dayIn(from, timeZone), columns: shown, unplaced }
      })
    },

    async followed({ from, to, timeZone, at = now(), ...options }) {
      const [start, end] = range(from, to, timeZone)
      if (typeof options.step !== 'string' || !options.step) throw new TypeError('`step` is required')
      if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365) throw new TypeError('`days` must be an integer from 1 to 365')
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
      const rows = costs.map((cost): CostRow => {
        dayStart(cost?.day)
        if (typeof cost.source !== 'string' || !cost.source.trim()) throw new TypeError('A cost requires a source, such as "google"')
        if (typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0) throw new TypeError(`The cost of ${cost.day} requires an amount of zero or more`)
        for (const count of [cost.clicks, cost.impressions]) {
          if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new TypeError(`The cost of ${cost.day} has a count that is not an integer`)
        }
        for (const claim of [cost.conversions, cost.conversionValue]) {
          if (claim !== undefined && (typeof claim !== 'number' || !Number.isFinite(claim))) throw new TypeError(`The cost of ${cost.day} has conversions that are not a number`)
        }
        if (cost.conversions !== undefined && cost.conversions < 0) throw new TypeError(`The cost of ${cost.day} requires conversions of zero or more`)
        if (cost.conversionValue !== undefined && cost.conversions === undefined) throw new TypeError(`The cost of ${cost.day} has a conversion value and no conversions`)
        const named = [cost.campaignId, cost.campaign, cost.currency].map((text) => {
          if (typeof text === 'object' && text !== null) throw new TypeError(`The cost of ${cost.day} requires its campaign and currency as strings`)
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
          ...(cost.conversions !== undefined && { conversions: cost.conversions }),
          ...(cost.conversionValue !== undefined && { conversionValue: cost.conversionValue }),
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
        // Looked for over a year, so how many arrivals the window leaves out can be said. Only those inside it are credited.
        const year = Math.max(window, 365 * DAY)
        const recorded = await tx.outcomesBetween(start, end)
        const outcomes = await leadsOf(tx, recorded, outcomeId)
        const labels = await tx.labelsOf(unique(outcomes.map((outcome) => outcome.subject)))
        const first = await tx.firstValues(outcomes)
        // How long steps take is read from the last half year and not from the days asked about: the newest days hold
        // few outcomes, which is what it has to say. Some of each step, so a common quick one does not hide a slow one.
        const newest = await leadsOf(tx, await tx.newestOutcomes(now() - 180 * DAY, now(), 200), outcomeId)
        const inbound = await tx.missesBetween(start, end)
        const spurned = await tx.notLeads(inbound.map(callId))
        // A call that was counted is an outcome, and is counted once.
        const counted = new Set(recorded.map(outcomeId))
        const uncounted = inbound.filter((call) => (spurned.has(callId(call)) ? !counted.has(callId(call)) : call.result?.answered === false))
        // Each is read for the days it needs: the newest half year can be far from the days asked about.
        const reached = new Map<Subject, Reached>()
        const ofOutcome = await creditAll(tx, recorded, year, hops, reached)
        const ofCall = await creditAll(tx, uncounted, window, hops, reached)
        const ofNewest = await creditAll(tx, newest, window, hops, reached)
        const creditOf = ({ subject, at }: { subject: Subject; at: number }, find = ofOutcome) => {
          const { touches } = find(subject, at)
          // An ad outside the window takes nothing from what is inside it.
          const touch = earning(touches.filter((each) => each.at >= at - window)) ?? own(touches)[0]
          const inside = touch !== undefined && touch.at >= at - window
          return { touch: inside ? touch : undefined, delay: touch && at - touch.at, inside }
        }
        const credited: Credited[] = outcomes.map((outcome) => ({ outcome, first: first.get(outcome.transactionId), person: labels.get(outcome.subject)?.cluster ?? outcome.subject, ...creditOf(outcome) }))
        const history: Credited[] = newest.map((outcome) => ({ outcome, ...creditOf(outcome, ofNewest) }))
        // What was no lead is counted apart, where it would have been credited.
        const notLeads: { at: number; touch: Touch | undefined; tags: Record<string, string> | undefined }[] = []
        const lead = new Set(outcomes)
        for (const outcome of recorded) if (!lead.has(outcome)) notLeads.push({ at: outcome.at, touch: creditOf(outcome).touch, tags: outcome.tags })
        const missed: typeof notLeads = []
        for (const call of uncounted) (spurned.has(callId(call)) ? notLeads : missed).push({ at: call.at, touch: creditOf(call, ofCall).touch, tags: call.tags })
        return fold(from, to, await tx.costsBetween(from, to), await tx.touchesBetween(start, end), credited, { missed, notLeads, by, per, timeZone, through: dayIn(now(), timeZone), history })
      })
    },

    async ignore(identifier, ignored = true, why) {
      if (typeof ignored !== 'boolean') throw new TypeError('ignore requires true or false')
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
        // A fact links nobody, and is weighed wherever the policy keeps people apart by one.
        if (!before || (before.fanout > cap && !(policy.apart?.length && /^(birth|given|initial|dated):/.test(identifier)))) return []
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
      else throw new TypeError('foresee requires an action: join, separate or ignore')
      const flag = action === 'separate' ? decision.separated : action === 'ignore' ? decision.ignored : undefined
      if (flag !== undefined && typeof flag !== 'boolean') throw new TypeError(`foresee ${action} requires true or false`)
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

    async changes({ after = 0, limit = 500 } = {}) {
      if (!(Number.isSafeInteger(after) && after >= 0)) throw new TypeError('`after` must be the number of a change')
      if (!(Number.isSafeInteger(limit) && limit > 0)) throw new TypeError('`limit` must be a positive integer')
      return store.read(async (tx) => {
        const found = await tx.changesAfter(after, limit + 1)
        const changes = found.slice(0, limit)
        return { changes, next: changes.at(-1)?.seq ?? after, more: found.length > limit }
      })
    },

    recent(limit = 50) {
      return store.read((tx) => tx.recentChanges(limit))
    },

    async undecided({ limit = 50, sightings = 10_000 } = {}) {
      return store.read(async (tx) => {
        const lately = await tx.latelySeen(sightings)
        const pairs = new Map<string, Pair>()
        const two: [Subject, Subject][] = []
        // A pair kept apart is not a link, and one a reviewer's mark joins has been decided, even where a cut keeps it in two clusters. Of two
        // where one speaks for the other, it has been said that they are two.
        for (const [subject, links] of await neighbors(tx, lately)) {
          for (const link of links) {
            if (speaks(link)) two.push([subject, link.subject])
            if (link.reasons.some((reason) => reason.identifier.startsWith('review:join-')) || speaks(link)) continue
            const [a, b] = subject < link.subject ? [subject, link.subject] : [link.subject, subject]
            pairs.set(pairKey(a, b), { a, b, score: link.score, level: link.level, reasons: link.reasons, ...(link.conflict && { conflict: link.conflict }) })
          }
        }
        const labels = await tx.labelsOf(unique([...[...pairs.values()].flatMap(({ a, b }) => [a, b]), ...two.flat()]))
        const said = new Set(two.map(([a, b]) => pairKey(labels.get(a)!.cluster, labels.get(b)!.cluster)))
        const open = [...pairs.values()].filter(({ a, b }) => labels.get(a)!.cluster !== labels.get(b)!.cluster && !said.has(pairKey(labels.get(a)!.cluster, labels.get(b)!.cluster)))
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
      if (typeof subject !== 'string' || !subject) throw new TypeError('Consent requires a subject')
      if (typeof consent?.adUserData !== 'boolean' || typeof consent.adPersonalization !== 'boolean') {
        throw new TypeError('Consent requires adUserData and adPersonalization, each true or false')
      }
      const recorded = now()
      const { at = recorded, source } = given
      if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Consent requires `at`, an integer in epoch milliseconds')
      // An answer dated ahead would stand over every real one until that day came.
      if (at > recorded + DAY) throw new TypeError('Consent cannot be dated in the future')
      if (source !== undefined && (typeof source !== 'string' || source.length > 200)) throw new TypeError('Consent `source` must be a string of at most 200 characters')
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
      if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new TypeError('A flow requires an id of its own, as a string of at most 200 characters')
      if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) throw new TypeError('A flow requires two different subjects')
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('A flow requires `amount`, a positive integer in the smallest unit')
      if (!Number.isSafeInteger(at)) throw new TypeError('A flow requires `at`, an integer in epoch milliseconds')
      if (typeof asset !== 'string') throw new TypeError('A flow requires its asset as a string')
      if ([id, from, to, asset].some((text) => UNSTORABLE.test(text))) throw new TypeError('A flow contains unsupported characters')
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

    async forget(subject, why, gone) {
      const subjects = typeof subject === 'string' ? [subject] : Array.isArray(subject) ? unique<Subject>(subject) : []
      if (subjects.length === 0 || subjects.some((each) => typeof each !== 'string')) throw new TypeError('forget requires a subject')
      keepable(...subjects)
      let jobs: Job[] = []
      const changes = await changing(async (tx) => {
        await current(tx, subjects, why)
        jobs = []
        for (const each of subjects) await decideAll(tx, [{ action: 'forget', about: [each], why }])
        const edges = await tx.edgesOf(subjects)
        const components = unique([...(await tx.labelsOf(subjects)).values()].flatMap(({ component }) => (component === undefined ? [] : [component])))
        const affected = new Set((await tx.membersOf(components)).keys())
        await mark(tx)
        for (const each of subjects) {
          jobs.push(...(await tx.removeSubject(each)))
          affected.delete(each)
        }
        // Losing a subject can bring an identifier back under its cap, which links the rest again.
        const identifiers = unique(edges.map((edge) => edge.identifier))
        const states = await tx.states(identifiers)
        const open = identifiers.filter((identifier) => usable(policy, identifier, states.get(identifier)))
        for (const edge of await tx.edgesOn(open)) affected.add(edge.subject)
        return settle(tx, affected)
      })
      gone?.(jobs)
      return changes
    },

    async journey(subject, { before = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
      if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError('limit must be a positive integer')
      return store.read(async (tx) => {
        const own = (await tx.labelsOf([subject])).get(subject)
        const members = own ? (await tx.clusterOf(own.cluster)).sort() : [subject]
        // The person: their cluster, and whoever is tied to any of it strongly enough that their arrivals would be credited.
        // Nobody kept apart from any of them, though: a browser two people used is tied to both, and they are still two.
        const within = new Set(members)
        // Whoever is in a group with somebody named is that person's, however strong the tie: one person's record shows nothing
        // of another's, and no path goes through it.
        const unnamed = new Set(policy.unnamed ?? UNNAMED)
        const isNamed = (each: Subject) => !unnamed.has(each.slice(0, Math.max(0, each.indexOf(':'))))
        const links = new Map<Subject, Link>()
        let reached = await reach(tx, members, 2, undefined, links)
        const near = [...reached.keys()].filter((each) => !within.has(each) && !isNamed(each))
        const homes = await tx.labelsOf(near)
        const others = new Set<Subject>()
        for (const cluster of unique([...homes.values()].map((label) => label.cluster))) if ((await tx.clusterOf(cluster)).some(isNamed)) others.add(cluster)
        const theirs = new Set([...members, ...near.filter((each) => !others.has(homes.get(each)?.cluster ?? each))])
        if ([...reached.keys()].some((each) => !theirs.has(each))) {
          links.clear()
          reached = await reach(tx, members, 2, theirs, links)
        }
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
        for (const touch of await tx.touchesOf(people, 0, before - 1)) entries.push({ at: touch.at, subject: touch.subject, kind: 'visit', touch })
        const calls = await tx.callsOf(people)
        const outcomes = await tx.outcomesOf(people)
        const not = await tx.notLeads([...calls.map(callId), ...outcomes.map(outcomeId)])
        const spurned = (id: string) => (not.has(id) ? { notLead: not.get(id)!.kind } : {})
        for (const call of calls) entries.push({ at: call.at, subject: call.subject, kind: 'call', call, ...spurned(callId(call)), ...(call.direction === 'inbound' && call.result?.answered === false && { followUp: followUp(call, calls.filter((each) => !not.has(callId(each)))) }) })
        for (const link of await tx.linksSent(people)) entries.push({ at: link.at, subject: link.subject, kind: 'link', link })
        const texts = await tx.textsOf(people)
        const badTexts = await tx.notLeads(texts.map((text) => `text:${text.id}`))
        for (const text of texts) {
          const bad = badTexts.get(`text:${text.id}`)
          const own = texts.filter((each) => each.subject === text.subject)
          entries.push({ at: text.at, subject: text.subject, kind: 'text', text: withFirst(text, own), ...(bad && { notLead: bad.kind }), ...(asks(text) && { reply: replyTo(text, own, calls.filter((each) => each.subject === text.subject && !not.has(callId(each)))) }) })
        }
        for (const each of people) {
          // One moment is many sightings, one for each identifier. What a call or a reviewer's join left is told by the call and the decision.
          const rang = new Set([...calls, ...texts].filter((call) => call.subject === each || call.visitor === each).map((call) => call.at))
          const moments = new Map<string, Entry & { kind: 'sighting' }>()
          for (const { at, event = '', identifier } of await tx.history(each)) {
            if (at >= before || ((event === 'call' || event === 'text') && rang.has(at)) || (event === 'review' && identifier.startsWith('review:join-'))) continue
            const key = `${at} ${event}`
            const moment = moments.get(key) ?? { at, subject: each, kind: 'sighting', event, identifiers: [] }
            moments.set(key, moment)
            moment.identifiers.push(identifier)
          }
          entries.push(...moments.values())
          for (const answer of await tx.consentHistory(each)) entries.push({ at: answer.at, subject: each, kind: 'consent', answer })
        }
        for (const outcome of outcomes) {
          const [first, ...later] = await tx.valuesOf(outcome.transactionId, outcome.subject)
          entries.push({ at: outcome.at, subject: outcome.subject, kind: 'outcome', outcome, first: first ?? null, ...spurned(outcomeId(outcome)) })
          let from = first
          for (const to of later) {
            entries.push({ at: to.at, subject: outcome.subject, kind: 'value', transactionId: outcome.transactionId, stage: outcome.stage, from: from!, to })
            from = to
          }
        }
        const named = new Set(people)
        for (const decision of await tx.decisionsNaming(people)) entries.push({ at: decision.at, subject: decision.about.find((each) => named.has(each))!, kind: 'decision', decision })

        const found = entries.filter((entry) => entry.at < before).sort((x, y) => x.at - y.at || (KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.subject < y.subject ? -1 : 1)))
        // A page never ends inside a moment, so the next one can begin before it.
        let cut = Math.max(0, found.length - limit)
        while (cut > 0 && found[cut - 1]!.at === found[cut]!.at) cut -= 1
        const page = found.slice(cut)
        return {
          subject,
          subjects: Object.fromEntries(unique(page.map((entry) => entry.subject)).map((each) => [each, tie(each)])),
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
      if (!Number.isSafeInteger(before)) throw new TypeError('prune requires `before`, an integer in epoch milliseconds')
      return store.write(async (tx) => {
        await decide(tx, 'prune', [String(before)], why)
        return (await tx.pruneSightings(before)) + (await tx.pruneConsent(before)) + (await tx.pruneCallResults(before)) + ((await tx.pruneLeases(before)) + (await tx.pruneLinks(before))) + (await tx.pruneNotLeads(before))
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
