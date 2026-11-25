import { createHash, randomUUID } from 'node:crypto'
import { malformed, refused } from '../contract/fault.ts'
import { later, newest, worthOf } from './said.ts'
import { brokenAt, seal } from './audit.ts'
import { board } from './board.ts'
import type { BoardColumn, BoardPlace } from './board.ts'
import type { Labeled } from './calibrate.ts'
import { creditSubject } from './call-party.ts'
import { callGroups } from './call-partition.ts'
import { summarizeCalls } from './callreport.ts'
import type { CallSummary } from './callreport.ts'
import { byCode, codeTie, firstOpen, followUp, isTie } from './calls.ts'
import { Gone, asks, beginnings, replyTo } from './texts.ts'
import { followed } from './followed.ts'
import type { Followed } from './followed.ts'
import type { Hours } from './hours.ts'
import { UNSTORABLE, nameEvidence } from './identifiers.ts'
import { CLICK_IDS, checkTouch } from './touch.ts'
import { createMemoryStore } from './memory.ts'
import type { Job } from './outbox.ts'
import type { KeptAlert } from './ops.ts'
import type { NewEvent } from './events.ts'
import { UNNAMED, checkedReasons, defaultPolicy, earlierReasons, evidence, joins, plainPolicy, policyHash, ruleFor, told, usable, weigh } from './policy.ts'
import type { Policy } from './policy.ts'
import { dayIn, dayStart, dimension, fold, nextDay, paid, sourceOf } from './report.ts'
import type { Credited } from './report.ts'
import { commonClusters, components, confirmed, conflict, knownOf, partition, scorePairs } from './resolve.ts'
import type { Known } from './resolve.ts'
import { checkTags, touchTag } from './tags.ts'
import type { CallEvidence, CallLineKind, DecisionPage, Store, Tx } from './store.ts'
import type {
  Attribution,
  AttributedTouch,
  CallParty,
  PartyStatement,
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
  Identifier, IdentifierState,
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
} from '../contract/types.ts'

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

type JourneyDelivery = Pick<Job, 'target' | 'state' | 'note' | 'value'>
type RecordedJourney = Omit<Journey, 'entries'> & { entries: (Entry & { sent?: JourneyDelivery[] })[] }

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
  /** Whether any of these subjects speaks for a member of the person's cluster. */
  spokenForBy(person: Subject, speakers: ReadonlySet<Subject>): Promise<boolean>
  /** Every subject seen with any of the given identifiers, with when: who else has this fingerprint, who tapped this number. */
  holders(identifiers: readonly Identifier[]): Promise<Edge[]>
  /** The cluster a subject belongs to, or undefined for a subject never observed. */
  cluster(subject: Subject, explain?: boolean): Promise<Cluster | undefined>
  /** Records a marketing touchpoint. */
  touch(touch: Touch, call?: string): Promise<void>
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
  /**
   * Says what a recorded outcome is worth, or how much of it was lost. Kept as it was said, so its worth does not depend
   * on the order things arrive in. Refused for one that is not recorded, or that has payments.
   */
  revise(said: { key: string; at: number; transactionId: string; change: { kind: 'correct'; value: number; currency?: string } | { kind: Loss; amount: number; currency?: string } | { kind: 'reverse'; restatement: string } }): Promise<{ value: number; currency: string; stands: boolean }>
  /** `markNotLead`, by when it was said. */
  sayLead(said: { id: string; key: string; at: number; kind?: NotLead['kind'] | undefined }): Promise<{ stands: boolean; lead: boolean }>
  /** `keepCallResult`, by when it was said. The result that stands counts whole. */
  sayResult(said: { call: string; key: string; at: number; result: { answered: boolean; voicemail?: boolean; waited?: number } }): Promise<{ stands: boolean }>
  /** An older process could put the physical line and its matching evidence back after a staff confirmation. */
  repairCallReports(): Promise<void>
  /** Identifies one call independently of the line or the call result. */
  sayParty(said: { call: string, key: string, at: number, party: CallParty & { by: string }, seen?: string | null }): Promise<{ stands: boolean }>
  refreshParty(id: string): Promise<Change[]>
  partyHistory(id: string): Promise<(PartyStatement & { key: string })[]>
  partyRevision(): Promise<string | undefined>
  /** `keepReturn`, by when it was said, which is not when they were reached. */
  sayReturn(said: { call: string; key: string; at: number; reachedAt?: number | undefined }): Promise<{ stands: boolean }>
  /** Every value a recorded outcome has had, oldest first. */
  values(transactionId: string): Promise<OutcomeValue[]>
  /** An outcome as it was recorded, or undefined when it was not. */
  outcomeOf(transactionId: string): Promise<Counted | undefined>
  /** Keeps a call. `recordCall` does this. */
  keepCall(call: Omit<KeptCall, 'result' | 'recorded'>, lineKind?: CallLineKind, reserved?: { identifiers: Identifier[]; tie?: { identifier: Identifier; notes?: Identifier[]; pool?: { number: string; grace: number } } }): Promise<void>
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
  /** The last turn of a number that began by a time, whoever's it was. */
  shownTo(number: string, at: number): Promise<Lease | undefined>
  /** Who a number was shown to at a time, or within `grace` milliseconds before it when nobody held it since. */
  leaseholder(number: string, at: number, grace?: number): Promise<Subject | undefined>
  /** How many of the numbers are held at a time. */
  leasesAt(numbers: readonly string[], at?: number): Promise<number>
  /**
   * Ties a caller to the visitor whose call it is, by an identifier both then carry. Not where a reviewer keeps the two
   * apart, the visitor is already tied to another caller, or what matched them no longer does: that they held the pool
   * number, or one of the notes their taps left. Returns whether they are tied. `recordCall` does this.
   */
  tieCall(caller: Subject, visitor: Subject, identifier: Identifier, at: number, by: { pool: string; grace: number } | { notes: readonly Identifier[] }, withheldCall?: string): Promise<boolean>
  /**
   * Unties a call from whoever tapped the number, or keeps it from being tied: another call could have come of the same tap,
   * or came of it, or makes the number busy. Untied, it is filed under `line`, the channel of the number it rang.
   */
  doubtCall(id: string, ambiguous: boolean, line?: Omit<Touch, 'subject' | 'at'>): Promise<void>
  /**
   * Gives a call that was recorded without it the visitor its code names, as `tieCall` would have: whoever it was tied to by a
   * tap or a number shown to them is untied, and it is flagged `code`, or `taken` and filed under `line` where the two cannot
   * be tied. Nothing where a code has said already, or a person has restored the tie it has.
   */
  nameCall(id: string, visitor: Subject, note: Identifier, line?: Omit<Touch, 'subject' | 'at'>): Promise<void>
  /** Kept calls to a number with `from <= at < to`, oldest first. */
  callsTo(number: string, from: number, to: number): Promise<KeptCall[]>
  /** Withheld evidence may veto another call competing for a visitor. */
  rivalCalls(number: string, from: number, to: number, line?: Subject): Promise<KeptCall[]>
  rivalTies(subject: Subject): Promise<{ subject: Subject; identifier: Identifier }[]>
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
  /** Adds an opt-out to the original inbound message when both numbers still match. */
  stopText(id: string, subject: Subject, to: string): Promise<{ text: KeptText | undefined; added: boolean }>
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
  /** Checks the overdue call and its credit while keeping the alert and its optional event. */
  queueCallback(alert: KeptAlert, event: Extract<NewEvent, { type: 'callback.overdue' }>, keepEvent: boolean): Promise<boolean>
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
  spend(costs: Cost | readonly Cost[], read?: { at: number; key: string }): Promise<number>
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
  separateAll(pairs: readonly Told[], why?: Deciding): Promise<Recorded>
  /** Records a list of joins the same way: two records another system merged are one person here too. */
  joinAll(pairs: readonly Told[], why?: Deciding): Promise<Recorded>
  /**
   * Takes joins back: mutes every mark a pair's joins left, with one decision for each pair. Refused where any of them
   * has none, and then none is taken back. What joined them besides stays.
   */
  unjoinAll(pairs: readonly Told[], why?: Deciding): Promise<Recorded>
  /** Whether each pair is in one cluster now, whether a split stands between them, and whether a join does. */
  standingOf(pairs: readonly (readonly [Subject, Subject])[]): Promise<{ together: boolean; apart: boolean; joined: boolean }[]>
  /**
   * Records an answer a subject gave about advertising. Every answer is kept.
   * The newest by when it was given stands, whatever order they arrive in,
   * and the outbox honours that one. `at` defaults to now.
   */
  consent(subject: Subject, consent: Consent, given?: { at?: number; source?: string; key?: string }): Promise<{ stands: boolean }>
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
  forget(subject: Subject | readonly Subject[], why?: Deciding, gone?: (jobs: Job[]) => void, only?: readonly string[]): Promise<Change[]>
  /**
   * Everything recorded about the person a subject is: arrivals, what they
   * were seen doing, calls, steps and their values, consent and decisions,
   * each with the subject it is on and why that subject is this person.
   */
  journey(subject: Subject, options?: { before?: number; limit?: number; deliveries?: boolean }): Promise<RecordedJourney>
  /** Every sighting of a subject, oldest first. With `limit`, only the newest that many. */
  history(subject: Subject, limit?: number): Promise<Sighting[]>
  subjectDates: Tx['subjectDates']
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
  if (end <= start) throw malformed('A report requires `from` on or before `to`')
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
  return graphOn(store, policy, options).graph
}

function graphOn(store: Store, policy: Policy, options: GraphOptions): { graph: Graph; record: (tx: Tx, sightings: readonly Sighting[]) => Promise<Change[]> } {
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
  async function compute(tx: Tx, subjects: readonly Subject[], supposing?: Supposed, onCut?: (a: Subject, b: Subject) => void, onLimited?: (subjects: Subject[]) => void, local?: { active: Edge[]; reserved: boolean }): Promise<Map<Subject, Labels>> {
    const first = local ?? await tx.matchingEdges(subjects)
    // A removed tie can move a separation's cut to a different link. Include the former holders and their components when testing both readings.
    if (!first.reserved) return computeOn(tx, subjects, [], supposing, onCut, onLimited, first.active)
    const scope = new Set(subjects)
    let next = [...subjects]
    const batches = [first.active]
    const checked = new Set<Identifier>()
    while (next.length) {
      const privateEdges = await tx.callEvidence({ subjects: next })
      const edges = batches[batches.length - 1]!
      const ids = unique([...edges, ...privateEdges].map(edge => edge.identifier)).filter(id => !checked.has(id))
      for (const id of ids) checked.add(id)
      const rows = await tx.callEvidence({ identifiers: ids })
      if (!rows.length) break
      const holders = await tx.edgesOn(unique(rows.map(row => row.identifier)))
      const added = unique([...rows, ...holders].map(edge => edge.subject)).filter(subject => !scope.has(subject))
      next = unique([...added, ...(await tx.aroundOf(added)).keys()]).filter(subject => !scope.has(subject))
      for (const subject of next) scope.add(subject)
      if (next.length) batches.push(await tx.edgesOf(next))
    }
    const everyone = [...scope]
    return computeOn(tx, everyone, await tx.callEvidence({ subjects: everyone }), supposing, onCut, onLimited, batches.length === 1 ? first.active : batches.flat())
  }

  async function computeOn(tx: Tx, subjects: readonly Subject[], withdrawn: readonly CallEvidence[], supposing?: Supposed, onCut?: (a: Subject, b: Subject) => void, onLimited?: (subjects: Subject[]) => void, loaded?: Edge[]): Promise<Map<Subject, Labels>> {
    let active = loaded ?? await tx.edgesOf(subjects)
    const states = await tx.states(unique((withdrawn.length ? [...active, ...withdrawn] : active).map(row => row.identifier)))
    const among = new Set(subjects)
    let separated = (await tx.separatedOf(subjects)).filter(([a, b]) => among.has(a) && among.has(b))
    if (supposing?.action === 'join') {
      const identifier = 'review:join-'
      active = [...active, ...[supposing.a, supposing.b].map(subject => ({ subject, identifier, first: now(), last: now(), count: 1 }))]
      states.set(identifier, { fanout: 2, ignored: false })
    } else if (supposing?.action === 'ignore') states.set(supposing.identifier, { ...states.get(supposing.identifier)!, ignored: supposing.ignored ?? true })
    else if (supposing) {
      separated = separated.filter(([a, b]) => !(a === supposing.a && b === supposing.b) && !(a === supposing.b && b === supposing.a))
      if (supposing.separated ?? true) separated.push([supposing.a, supposing.b])
    }

    return callGroups(policy, [...subjects], active, withdrawn, states, separated, group, onCut, onLimited)

    function group(subjects: Subject[], edges: Edge[], states: Map<Identifier, IdentifierState>) {
      let different = false
      const select = (shared: Reason[]) => checkedReasons(shared, () => { different = true })
      const pairs = scorePairs(policy, edges, states, undefined, policy.related, select)
      const spoken = (links: Pair[]) => links.filter(({ reasons }) => told(policy, reasons)).map(({ a, b }): [Subject, Subject] => [a, b])
      const two = spoken(pairs)
      const facts = knownOf(policy, edges, silent(states), separated.length > 0 || two.length > 0)
      const since = separated.length || two.length || facts.size || different || policy.records === 'confirmed' ? sinceOf(edges) : undefined
      const current = partition(subjects, pairs, separated, policy, facts, onCut, two, since)
      if (!different && ![...facts.values()].some((own) => own.changed)) return current
      const before = scorePairs(policy, edges, states, undefined, policy.related, earlierReasons)
      const oldTwo = spoken(before)
      const oldFacts = oldTwo.length && !two.length && !separated.length ? knownOf(policy, edges, silent(states), true) : facts
      return commonClusters(current, partition(subjects, before, separated, policy, previousFacts(oldFacts), onCut, oldTwo, since))
    }
  }

  /**
   * Recomputes the components of `affected` subjects. Sound when `affected`
   * holds both ends of every pair whose score the current write changed: any
   * other `same` pair that reaches into this set was already `same`, so its
   * far end is in one of these components. Clusters are cut from whole
   * components, which is why components, not clusters, bound the work.
   */
  async function settle(tx: Tx, affected: ReadonlySet<Subject>, privateHolders = false): Promise<Change[]> {
    const stored = await tx.aroundOf([...affected])
    // A line known only through stated calls has no stored group. It can still lead to active holders of earlier call ties.
    const subjects = privateHolders ? unique([...stored.keys(), ...affected]) : [...stored.keys()]
    const local = await tx.matchingEdges(subjects)
    // A lone subject cannot change its own group unless a former holder brings another group into reach.
    if (!local.reserved && subjects.length === 1) {
      const subject = subjects[0]!
      const labels = stored.get(subject)
      if (labels?.component === subject && labels.cluster === subject) return []
    }
    const next = await compute(tx, subjects, undefined, undefined, undefined, local)
    if (!local.reserved) return apply(tx, stored, next)
    const more = [...next.keys()].filter(subject => !stored.has(subject))
    if (more.length) for (const [subject, labels] of await tx.labelsOf(more)) stored.set(subject, labels)
    const changes = await apply(tx, stored, next)
    if (changes.length) await recheckCallbacks(tx, [...stored.keys()], true)
    return changes
  }

  async function apply(tx: Tx, stored: ReadonlyMap<Subject, Labels>, next: ReadonlyMap<Subject, Labels>): Promise<Change[]> {
    const moved = new Map<Subject, Labels>()
    for (const [subject, labels] of next) {
      const before = stored.get(subject)
      if (!before || before.component !== labels.component || before.cluster !== labels.cluster) moved.set(subject, labels)
    }
    if (moved.size > 0) await tx.setLabels(moved)
    const changes = diff(stored, next).filter((change) => change.from !== change.to)
    if (changes.length) await tx.addChanges(now(), changes)
    return changes
  }

  const previousFacts = (known: Map<Subject, Known>) => new Map([...known].map(([subject, facts]) => [subject, facts.earlier ?? facts]))

  /**
   * Where every subject should sit that is joined to another, from all edges. One that is not here is on its own. Reads
   * the edges a pair at a time, and keeps only the pairs that join: the graph may be larger than memory.
   */
  async function recompute(tx: Tx): Promise<Map<Subject, Labels>> {
    let changed = false
    const current = await fromPairs(tx, false, () => { changed = true })
    const labels = changed ? commonClusters(current, await fromPairs(tx, true)) : current
    const withdrawn = await tx.callEvidence()
    if (!withdrawn.length) return labels
    const holders = await tx.edgesOn(unique(withdrawn.map(row => row.identifier)))
    const near = new Set([...holders, ...withdrawn].map(row => row.subject))
    const components = new Set([...near].map(subject => labels.get(subject)?.component ?? subject))
    for (const [subject, own] of labels) if (components.has(own.component)) near.add(subject)
    for (const [subject, own] of await computeOn(tx, [...near], withdrawn)) labels.set(subject, own)
    return labels
  }

  async function fromPairs(tx: Tx, previous: boolean, changed?: () => void): Promise<Map<Subject, Labels>> {
    const caps = Object.fromEntries(Object.entries(policy.kinds).map(([kind, rule]) => [kind, rule.cap]))
    const alone = Object.entries(policy.kinds).filter(([, rule]) => policy.same <= 0 || rule.relates || (!rule.corroborates && rule.weight >= policy.same - 1e-9)).map(([kind]) => kind)
    const pairs: Pair[] = []
    const joined = new Set<Subject>()
    const two: [Subject, Subject][] = []
    for await (const batch of tx.sharing(caps, alone)) {
      for (const shared of batch) {
        const raw = shared.map(({ a, b, fanout }) => evidence(policy, a, b, fanout))
        const reasons = previous ? earlierReasons(raw) : checkedReasons(raw, changed)
        if (reasons.length === 0) continue
        const score = weigh(policy, reasons)
        if (told(policy, reasons)) two.push([shared[0]!.a.subject, shared[0]!.b.subject])
        if (!joins(policy, score, reasons)) continue
        const [a, b] = [shared[0]!.a.subject, shared[0]!.b.subject]
        pairs.push({ a, b, score, level: 'same', reasons: [] })
        joined.add(a).add(b)
      }
    }
    const subjects = [...joined]
    const separations = await tx.separatedOf(subjects)
    // Without fact cuts, only a component with both ends of a separation needs its staff joins read.
    const groups = !policy.apart?.length && (separations.length || two.length) ? components(subjects, pairs) : undefined
    const within = ([a, b]: [Subject, Subject]) => joined.has(a) && joined.has(b) && (!groups || groups.get(a) === groups.get(b))
    const separated = separations.filter(within)
    const said = two.filter(within)
    const ends = [...separated.flat(), ...said.flat()]
    const split = new Set(ends.map((subject) => groups?.get(subject)))
    const need = groups ? subjects.filter((subject) => split.has(groups.get(subject))) : subjects
    const read = await known(tx, need, ends.length > 0)
    if (changed && [...read.values()].some((own) => own.changed)) changed()
    const facts = previous ? previousFacts(read) : read
    // Where records have to be confirmed, when each was first seen can say whose a browser is.
    const kept = unique([...(policy.records ? subjects : []), ...ends, ...[...facts].filter(([, own]) => own.facts.size || own.earlier?.facts.size).map(([subject]) => subject)])
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

  /** Whether an identifier says nothing of who somebody is: muted, or evidence that more hold than its cap. A note has no cap to go by. */
  const silent = (states: ReadonlyMap<Identifier, IdentifierState>, unavailable?: ReadonlySet<Identifier>) => (identifier: Identifier) => unavailable?.has(identifier) === true || states.get(identifier)?.ignored === true || (ruleFor(policy, identifier).weight > 0 && !usable(policy, identifier, states.get(identifier)))

  /** What is known of these subjects that cannot be two people's. Nothing is read where the policy keeps nobody apart by it. */
  async function known(tx: Tx, subjects: readonly Subject[], joins = false, unavailable?: ReadonlySet<Identifier>): Promise<Map<Subject, Known>> {
    const out = new Map<Subject, Known>()
    if (!policy.apart?.length && !joins) return out
    for (let i = 0; i < subjects.length; i += TOGETHER) {
      const edges = (await tx.edgesOf(subjects.slice(i, i + TOGETHER))).filter(({ identifier }) => /^(birth|given|initial|dated|compound|review|named|ward|name|passkey|person):/.test(identifier))
      const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
      for (const [subject, facts] of knownOf(policy, edges, silent(states, unavailable), joins)) out.set(subject, facts)
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

  /** Whether two records are joined by what they share alone, where the policy asks for more. */
  const unsure = (a: Subject, b: Subject, labels: ReadonlyMap<Subject, Labels>) =>
    policy.records === 'confirmed' && names(a) && names(b) && labels.get(a)?.cluster !== labels.get(b)?.cluster

  const withheldApart = new WeakSet<Link>()
  const callRelates = (identifier: Identifier) => /^(phone|voip|dial|lease|text|dialed):/.test(identifier) && ruleFor(policy, identifier).relates
  const hasCallRelations = Object.entries(policy.kinds).some(([kind, rule]) => rule.relates && /^(phone|voip|dial|lease|text|dialed)$/.test(kind))
  const otherLineKind = (id: Identifier) => id.startsWith('phone:') ? 'voip:' + id.slice(6) : id.startsWith('voip:') ? 'phone:' + id.slice(5) : undefined
  function uncertainLines(rows: readonly CallEvidence[]) {
    const keys = new Set(rows.map(row => row.call + '\u0000' + row.identifier))
    return (row: CallEvidence) => {
      const other = otherLineKind(row.identifier)
      return other !== undefined && keys.has(row.call + '\u0000' + other)
    }
  }

  /** A skipped carrier check leaves two possible kinds for one line. Either kind may still be below its cap. */
  async function withinCaps(tx: Tx, identifiers: Identifier[], states: ReadonlyMap<Identifier, IdentifierState>) {
    const open = new Set(identifiers.filter(id => states.has(id) && states.get(id)!.fanout <= ruleFor(policy, id).cap))
    const over = identifiers.filter(id => !open.has(id) && states.has(id) && /^(phone|voip):/.test(id))
    if (!over.length) return open
    const rows = await tx.callEvidence({ identifiers: unique(over.flatMap(id => [id, otherLineKind(id)!])) })
    const uncertain = new Map<Identifier, Set<Subject>>()
    for (const row of rows.filter(uncertainLines(rows))) {
      if (!uncertain.has(row.identifier)) uncertain.set(row.identifier, new Set())
      uncertain.get(row.identifier)!.add(row.subject)
    }
    for (const id of over) if (states.get(id)!.fanout - (uncertain.get(id)?.size ?? 0) <= ruleFor(policy, id).cap) open.add(id)
    return open
  }

  async function possibleCallRelations(tx: Tx, identifiers: Identifier[], extra = 0) {
    const rows = await tx.callEvidence({ identifiers })
    const held = new Map<string, { holders: Subject[]; permits: (...subjects: Subject[]) => boolean }>()
    if (!rows.length) return held
    const ids = unique(rows.map(row => row.identifier))
    const states = await tx.states(ids)
    const all = await tx.callEvidence({ calls: unique(rows.map(row => row.call)) })
    const uncertain = uncertainLines(all)
    for (const id of ids) {
      const state = states.get(id)!
      const cap = ruleFor(policy, id).cap
      const required = new Set<Subject>()
      const optional = new Set<Subject>()
      for (const row of rows.filter(row => row.identifier === id)) {
        if (uncertain(row)) optional.add(row.subject)
        else required.add(row.subject)
      }
      if (state.ignored || state.fanout - optional.size + extra > cap) continue
      for (const edge of await tx.edgesOn([id])) required.add(edge.subject)
      const permits = (...subjects: Subject[]) => required.size + extra + subjects.filter(subject => !required.has(subject)).length <= cap
      held.set(id, { holders: unique([...required, ...optional]), permits })
    }
    return held
  }

  async function originalSeparations(tx: Tx, subjects: readonly Subject[]) {
    const apart = new Set<string>()
    if (!hasCallRelations || !await tx.hasCallEvidence()) return apart
    const own = [...await tx.callEvidence({ subjects }), ...await tx.edgesOf(subjects)]
    const identifiers = unique(own.filter(row => callRelates(row.identifier)).map(row => row.identifier))
    for (const { holders, permits } of (await possibleCallRelations(tx, identifiers)).values()) for (const [i, a] of holders.entries()) {
      for (const b of holders.slice(i + 1)) if (permits(a, b)) apart.add(pairKey(a, b))
    }
    return apart
  }

  /** Links of each given subject, scored from edges. A pair a reviewer separated is not a link. */
  async function neighbors(tx: Tx, subjects: readonly Subject[]): Promise<Map<Subject, Link[]>> {
    const states = await tx.shared(subjects)
    const open = [...states.keys()].filter((identifier) => usable(policy, identifier, states.get(identifier)))
    const apart = new Set((await tx.separatedOf(subjects)).map(([a, b]) => pairKey(a, b)))
    const former = await originalSeparations(tx, subjects)
    const from = new Set(subjects)
    const out = new Map<Subject, Link[]>()
    const add = (subject: Subject, link: Link, separated: boolean) => {
      if (!from.has(subject)) return
      if (separated) withheldApart.add(link)
      const links = out.get(subject)
      if (links) links.push(link)
      else out.set(subject, [link])
    }
    const found = scorePairs(policy, await tx.edgesOn(open), states, from)
    const facts = await known(tx, unique(found.flatMap(({ a, b }) => [a, b])))
    const homes = policy.records ? await tx.labelsOf(unique(found.flatMap(({ a, b }) => [a, b]))) : facts.size > 0 ? await tx.labelsOf([...facts.keys()]) : new Map<Subject, Labels>()
    for (const { a, b, score, level, reasons } of found) {
      if (apart.has(pairKey(a, b))) continue
      // In one group in spite of a fact, decisions hold them there, and the fact is overruled.
      const between = homes.get(a) && homes.get(a)!.cluster === homes.get(b)?.cluster ? undefined : conflict(policy, facts.get(a), facts.get(b))
      // However strong what they share is, they are two people, and are shown as related.
      const possibly = !between && (level === 'same' || reasons.some((reason) => /^(person|perhaps):/.test(reason.identifier))) && unsure(a, b, homes)
      const separated = former.has(pairKey(a, b)) && !reasons.some(reason => reason.identifier.startsWith('review:') || ruleFor(policy, reason.identifier).relates)
      const link = { score, level: between || possibly || separated ? ('related' as const) : level, reasons, ...(between && { conflict: between }), ...(possibly && { unconfirmed: true as const }) }
      add(a, { subject: b, ...link }, separated)
      add(b, { subject: a, ...link }, separated)
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

  type Reached = Map<Subject, { confidence: number; via: Subject[]; joined?: true; speaks?: true; from?: Subject; earns?: true; anothers?: true }>

  /** Every subject within `hops` links of any of those given, with the strength of the best chain to each. With `only`, through those subjects and to them. */
  async function reach(tx: Tx, from: readonly Subject[], hops: number, only?: ReadonlySet<Subject>, last?: Map<Subject, Link>, crediting = false): Promise<Reached> {
    const reached: Reached = new Map(from.map((subject) => [subject, { confidence: 1, via: [] }]))
    // Two subjects kept apart are two people, so nothing of the one is reached from the other, through a third subject either.
    const apart = new Set((await tx.separatedOf(from)).flat().filter((subject) => !reached.has(subject)))
    const borders = bordersOf(tx)
    let frontier = [...from]
    for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
      const links = await neighbors(tx, frontier)
      await borders.load([...from, ...frontier, ...[...links.values()].flat().map((link) => link.subject)], links, from)
      frontier = spread(reached, apart, frontier, links, borders, from, only, last, crediting)
    }
    return reached
  }

  /** Whether the policy keeps people apart by an identifier, which then counts however many hold it. */
  const isFact = (identifier: Identifier) => Boolean(policy.apart?.length) && /^(birth|given|initial|dated|compound):/.test(identifier)
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
        if (withheldApart.has(link) || (link.conflict && !said) || apart.has(link.subject) || (only && !only.has(link.subject)) || (told(policy, link.reasons) && !said)) continue
        // Credit goes from whoever speaks to whoever they speak for, and not on: what brought one of their children did not bring another.
        if (said ? !crediting || borders.kept(near, link.subject) || start.speaks || !names(near) || names(link.subject) || !borders.one(from[0]!, near) : start.speaks && !borders.one(near, link.subject)) continue
        if (!said && !start.speaks && (borders.cut(near, link.subject) || borders.between(near, link.subject) || from.some((origin) => borders.kept(origin, link.subject) || borders.between(origin, link.subject)))) continue
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
    /** The groups of two a reviewer keeps apart, looked for wherever one speaks for another: a decision comes before what was said. */
    const kept = new Set<string>()
    const checked = new Set<Subject>()
    const far = new Set<Subject>()
    const groupOf = new Map<Subject, Subject>()
    const apartPairs: [Subject, Subject][] = []
    return {
      /** Whether a reviewer keeps somebody of the one's group apart from somebody of the other's. */
      kept: (a: Subject, b: Subject) => kept.has(pairKey(labels.get(a)?.cluster ?? a, labels.get(b)?.cluster ?? b)),
      /** Whether two are one subject or in one group. */
      one: (a: Subject, b: Subject) => a === b || (labels.has(a) && labels.get(a)!.cluster === labels.get(b)?.cluster),
      /** Whether a separation or a fact took the link between two, and they are not one by others. */
      cut: (a: Subject, b: Subject) => taken.has(pairKey(a, b)) && labels.get(a)?.cluster !== labels.get(b)?.cluster,
      async load(subjects: Iterable<Subject>, links: ReadonlyMap<Subject, Link[]> = new Map(), origins: readonly Subject[] = []): Promise<void> {
        const said = [...links].flatMap(([near, list]) => list.filter(link => speaks(link) || withheldApart.has(link)).map((link) => [near, link.subject] as const))
        met ||= said.length > 0
        if (!policy.apart?.length && !met && links.size === 0) return
        const unread = unique([...subjects].filter((subject) => !labels.has(subject)))
        for (let i = 0; i < unread.length; i += TOGETHER) for (const [subject, own] of await tx.labelsOf(unread.slice(i, i + TOGETHER))) labels.set(subject, own)
        for (const [a, b] of said) if (labels.get(a)?.cluster !== labels.get(b)?.cluster) spoken.add(pairKey(labels.get(a)!.cluster, labels.get(b)!.cluster))
        // Everybody of the groups of those and of whoever the search began from, and who of them a reviewer keeps apart, read together and once.
        const asked = unique([...said.flat(), ...origins]).filter((each) => !checked.has(each))
        if (asked.length > 0) {
          const ofGroup = new Map<Subject, Subject>()
          const ids = unique(asked.flatMap((each) => labels.get(each)?.component ?? []))
          const groups = new Set(asked.map((each) => labels.get(each)?.cluster ?? each))
          for (let i = 0; i < ids.length; i += TOGETHER) for (const [subject, own] of await tx.membersOf(ids.slice(i, i + TOGETHER))) if (groups.has(own.cluster)) ofGroup.set(subject, own.cluster)
          for (const each of asked) {
            checked.add(each)
            if (!ofGroup.has(each)) ofGroup.set(each, labels.get(each)?.cluster ?? each)
          }
          const all = [...ofGroup.keys()]
          // Everybody of a group that was read, so none of them has it read again.
          for (const each of all) checked.add(each)
          for (let i = 0; i < all.length; i += TOGETHER) for (const [a, b] of await tx.separatedOf(all.slice(i, i + TOGETHER))) {
            for (const each of [a, b]) if (!ofGroup.has(each)) far.add(each)
            apartPairs.push([a, b])
          }
          // The other end may be of a group not asked about until now.
          for (const [subject, group] of ofGroup) groupOf.set(subject, group)
          const ends = [...far].filter((each) => !groupOf.has(each))
          for (let i = 0; i < ends.length; i += TOGETHER) for (const [subject, own] of await tx.labelsOf(ends.slice(i, i + TOGETHER))) groupOf.set(subject, own.cluster)
          for (const [a, b] of apartPairs) kept.add(pairKey(groupOf.get(a) ?? a, groupOf.get(b) ?? b))
        }
        // A link out of a group to another of its component: the two were cut, and it may be for a decision or a mark between two others of them.
        const over = [...links].flatMap(([near, list]) => list.filter((link) => labels.get(near)?.cluster !== labels.get(link.subject)?.cluster && (link.level === 'same' || labels.get(near)?.component === labels.get(link.subject)?.component)).map(() => labels.get(near)?.component ?? near))
        const cutUps = unique(over).filter((id) => !marked.has(id))
        for (let i = 0; i < cutUps.length; i += TOGETHER) {
          const batch = cutUps.slice(i, i + TOGETHER)
          for (const id of batch) marked.add(id)
          const members = await tx.membersOf(batch)
          const edges = await tx.edgesOf([...members.keys()])
          const marks = edges.filter((edge) => edge.identifier.startsWith('behalf:'))
          const states = await tx.states(unique(marks.map((edge) => edge.identifier)))
          for (const { a, b, reasons } of scorePairs(policy, marks, states, undefined, 0)) if (told(policy, reasons) && members.get(a)!.cluster !== members.get(b)!.cluster) spoken.add(pairKey(members.get(a)!.cluster, members.get(b)!.cluster))
          // Two a reviewer keeps apart are two, and what was cut off with the one is not the other's.
          const apart = (await tx.separatedOf([...members.keys()])).filter(([a, b]) => members.has(a) && members.has(b) && members.get(a)!.component === members.get(b)!.component)
          for (const [a, b] of apart) if (members.get(a)!.cluster !== members.get(b)!.cluster) spoken.add(pairKey(members.get(a)!.cluster, members.get(b)!.cluster))
          const split = new Set(apart.map(([a]) => members.get(a)!.component))
          if (split.size < batch.length && await tx.hasCallEvidence()) {
            const held = await tx.callEvidence({ subjects: [...members.keys()] })
            for (const row of held) split.add(members.get(row.subject)!.component)
            const ids = new Set((await tx.callEvidence({ identifiers: unique(edges.map(edge => edge.identifier)) })).map(row => row.identifier))
            for (const edge of edges) if (ids.has(edge.identifier)) split.add(members.get(edge.subject)!.component)
          }
          if (split.size > 0) await compute(tx, [...members].filter(([, own]) => split.has(own.component)).map(([subject]) => subject), undefined, (a, b) => taken.add(pairKey(a, b)))
        }
        if (!policy.apart?.length) return
        const ids = unique(unread.flatMap((subject) => labels.get(subject)?.component ?? [])).filter((id) => !read.has(id))
        for (let i = 0; i < ids.length; i += TOGETHER) {
          const members = await tx.membersOf(ids.slice(i, i + TOGETHER))
          const some = new Map<Subject, Known[]>()
          for (const [subject, own] of await known(tx, [...members.keys()])) {
            const { cluster, component } = members.get(subject)!
            if (!(own.facts.size || own.earlier?.facts.size)) continue
            facts.set(cluster, [...(facts.get(cluster) ?? []), own])
            some.set(component, [...(some.get(component) ?? []), own])
          }
          // Worked out again only where somebody differs from somebody: what was cut is not stored.
          const cutUp = new Set([...some].filter(([, facts]) => facts.some((one, i) => facts.slice(i + 1).some((other) => conflict(policy, one, other)))).map(([component]) => component))
          if (cutUp.size > 0) await compute(tx, [...members].filter(([, own]) => cutUp.has(own.component)).map(([subject]) => subject), undefined, (a, b) => taken.add(pairKey(a, b)))
        }
        for (const id of ids) read.add(id)
      },
      between(a: Subject, b: Subject, by?: 'birth'): boolean {
        const [x, y] = [labels.get(a), labels.get(b)]
        if (by) return x !== undefined && y !== undefined && x.cluster !== y.cluster && x.component === y.component && (facts.get(x.cluster) ?? []).some((one) => (facts.get(y.cluster) ?? []).some((other) => conflict(policy, one, other) === by))
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
          await borders.load([...bySubject.keys(), ...some, ...[...found.values()].flat().map((link) => link.subject)], found, [...bySubject.keys()])
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
    const components = new Map<Subject, Subject>()
    for (let i = 0; i < everyone.length; i += TOGETHER) for (const [subject, { cluster, component }] of await tx.labelsOf(everyone.slice(i, i + TOGETHER))) {
      clusters.set(subject, cluster)
      components.set(subject, component)
    }
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
    if (policy.credit === undefined || policy.credit >= policy.same) return searches
    // Under the bar that joins, a browser or a caller that is one with a record is that record's, whoever else is near it.
    const weak = new Set([...searches].flatMap(([subject, reached]) => [...reached].filter(([each, { confidence, joined, earns }]) => confidence < policy.same && !joined && !earns && each !== subject).flatMap(([each]) => clusters.get(each) ?? [])))
    const whole = unique([...clusters].filter(([, cluster]) => weak.has(cluster)).flatMap(([each]) => components.get(each) ?? []))
    const ofRecords = new Set<Subject>()
    for (let i = 0; i < whole.length; i += TOGETHER) for (const [each, { cluster }] of await tx.membersOf(whole.slice(i, i + TOGETHER))) if (names(each) && weak.has(cluster)) ofRecords.add(cluster)
    for (const reached of searches.values()) for (const [each, found] of reached) if (!found.joined && (names(each) || ofRecords.has(clusters.get(each)!))) found.anothers = true
    return searches
  }

  type ForCall = Pick<KeptCall, 'id' | 'party'>

  async function creditVisitors(tx: Tx, calls: readonly ForCall[]): Promise<Map<string, { subject: Subject; joined: boolean }>> {
    const named = calls.flatMap(call => call.party?.role === 'self' || call.party?.role === 'representative' ? [{ id: call.id, owner: call.party.subject }] : [])
    if (!named.length) return new Map()
    const visitors = await tx.callVisitors(named.map(call => call.id))
    if (!visitors.size) return new Map()
    const groups = await tx.aroundOf(unique([...visitors.values()]))
    const records = new Map<Subject, Set<Subject>>()
    for (const [subject, { cluster }] of groups) if (names(subject)) {
      if (!records.has(cluster)) records.set(cluster, new Set())
      records.get(cluster)!.add(subject)
    }
    const allowed = new Map<string, { subject: Subject; joined: boolean }>()
    for (const call of named) {
      const visitor = visitors.get(call.id)
      if (!visitor) continue
      const owners = records.get(groups.get(visitor)?.cluster ?? visitor)
      if (!owners || (owners.size === 1 && owners.has(call.owner))) allowed.set(call.id, { subject: visitor, joined: owners?.has(call.owner) ?? false })
    }
    return allowed
  }

  /** The same credit as `credit` for many conversions of about one time, read together. `reached` keeps the searches for the next such read. */
  async function creditAll(tx: Tx, asked: readonly { subject: Subject; at: number }[], window: number, hops: number, reached = new Map<Subject, Reached>(), calls: readonly ForCall[] = []): Promise<(subject: Subject, at: number, call?: ForCall) => Attribution> {
    const visitors = await creditVisitors(tx, calls)
    const subjects = unique(asked.map(({ subject }) => subject))
    for (const [subject, found] of await asOne(tx, await reachEach(tx, subjects.filter((subject) => !reached.has(subject)), hops))) reached.set(subject, found)
    const touches = new Map<Subject, Touch[]>()
    if (asked.length > 0) {
      let [from, to] = [Infinity, -Infinity]
      for (const { at } of asked) [from, to] = [Math.min(from, at - window), Math.max(to, at)]
      const everyone = unique([...subjects.flatMap((subject) => [...reached.get(subject)!.keys()]), ...[...visitors.values()].map(visitor => visitor.subject)])
      for (let i = 0; i < everyone.length; i += TOGETHER) {
        for (const touch of await tx.touchesOf(everyone.slice(i, i + TOGETHER), from, to)) {
          const theirs = touches.get(touch.subject)
          if (theirs) theirs.push(touch)
          else touches.set(touch.subject, [touch])
        }
      }
    }
    return (subject, at, call) => {
      if (call?.party) {
        const within: Reached = new Map([[subject, { confidence: 1, via: [] }]])
        const visitor = visitors.get(call.id)
        if (visitor && visitor.subject !== subject) within.set(visitor.subject, { confidence: 1, via: [subject], ...(visitor.joined && { joined: true }) })
        const named = call.party.role === 'self' || call.party.role === 'representative'
        const own = named ? [...within.keys()].flatMap(each => (touches.get(each) ?? []).filter(touch => !byLine(touch) && touch.at >= at - window && touch.at <= at)) : []
        return credited(subject, at, within, own, visitor && !visitor.joined && visitor.subject !== subject ? visitor.subject : undefined)
      }
      const within = reached.get(subject)!
      return credited(subject, at, within, [...within.keys()].flatMap((each) => (touches.get(each) ?? []).filter((touch) => touch.at >= at - window && touch.at <= at)))
    }
  }

  // Identical public credit on the same path needs no replacement notice. The private proof keeps no ad click or campaign text.
  const arrivalKey = (touch: AttributedTouch) => `credit:${createHash('sha256').update(JSON.stringify([touch.subject, touch.at, touch.via, sourceOf(touch), touch.campaign, touch.campaignId])).digest('hex')}`

  async function settleParty(tx: Tx, id: string, arriving = false, overwritten = false): Promise<Change[]> {
    const affected = await tx.applyCallParty(id, arriving, overwritten)
    const changes = await settle(tx, new Set(affected))
    await recheckCallbacks(tx, affected)
    return changes
  }

  async function recheckCallbacks(tx: Tx, affected: Subject[], visitorGroups = false, exactCall?: string): Promise<void> {
    if (!affected.length && !exactCall) return
    const callsToCheck = new Set(exactCall ? [exactCall] : [])
    const paths = new Set(visitorGroups ? [] : affected.map(creditSubject))
    if (visitorGroups) {
      for (const row of await tx.callEvidence({ subjects: affected })) {
        if (row.identifier === `dial:${row.call}` || row.identifier === `lease:${row.call}` || row.identifier === codeTie(row.call)) callsToCheck.add(row.call)
      }
      if (!callsToCheck.size) return
      // A report cached by another process may give a confirmed call credit from the visitor's former cluster.
      await tx.setSetting('callParty', randomUUID())
    }
    // A new code or cluster can replace an owner's own arrival. Only the notice for the displayed call needs that check.
    const found = await tx.callbacksThrough([...paths, ...callsToCheck])
    const notices = [...found].filter(([, sources]) => callsToCheck.has(sources[0]!) || sources.some(id => paths.has(id)))
    if (!notices.length) return
    const calls = await tx.callsWith(unique(notices.map(([, sources]) => sources[0]!)))
    const credit = await creditAll(tx, calls, 90 * DAY, 2, undefined, calls)
    const current = new Map(calls.map(call => {
      const { credited } = credit(call.subject, call.at, call)
      return [call.id, { key: credited && arrivalKey(credited), own: call.party && credited?.subject === call.subject }] as const
    }))
    const gone = notices.filter(([, sources]) => {
      const next = current.get(sources[0]!)
      // Older confirmed calls could only credit their owner's own visit. Its notice had no stored path.
      if (next?.own && !sources.some(id => id.startsWith('credit:'))) return false
      return !next?.key || !sources.includes(next.key)
    }).map(([key]) => key)
    if (gone.length) await tx.dropCallbacks(gone)
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
  const own = (touches: readonly AttributedTouch[]) => touches.filter((touch) => touch.confidence >= (byLine(touch) || touch.anothers ? policy.same : (policy.credit ?? policy.same)) || ((touch.joined || touch.speaker) && !byLine(touch)))
  const earning = (touches: readonly AttributedTouch[]): AttributedTouch | undefined => {
    const theirs = own(touches)
    return (theirs[0] && byLine(theirs[0]) && theirs.find(campaigned)) || theirs[0]
  }

  function credited(subject: Subject, at: number, reached: Reached, found: readonly Touch[], campaignOnly?: Subject): Attribution {
    const touches: AttributedTouch[] = found
      .map((touch) => {
        const { confidence, via, joined = false, earns, anothers } = reached.get(touch.subject)!
        return { ...touch, confidence, via, joined, ...(touch.subject === campaignOnly && { campaignOnly: true as const }), ...(earns && { speaker: true as const }), ...(anothers && { anothers }) }
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
  // Reports may count a record's staff-merged duplicates together. A guessed link, a shared line or two different stated owners cannot vouch for that.
  async function personWithCalls(tx: Tx, calls: readonly Pick<KeptCall, 'subject' | 'party'>[], cluster: (subject: Subject) => Subject) {
    const exact = new Set(calls.filter(call => call.party).map(call => call.subject))
    const owners = new Map([...exact].map(subject => [subject, subject]))
    const named = [...exact].filter(names)
    if (named.length) {
      const labels = await tx.labelsOf(named)
      const groups = new Set([...labels.values()].map(label => label.cluster))
      const members = await tx.membersOf(unique([...labels.values()].map(label => label.component)))
      const records = [...members].filter(([subject, label]) => names(subject) && groups.has(label.cluster)).map(([subject]) => subject)
      const marks = (await tx.edgesOf(records)).filter(edge => edge.identifier.startsWith('review:join-'))
      const states = await tx.states(unique(marks.map(edge => edge.identifier)))
      const first = new Map<Identifier, Subject>()
      const pairs: { a: Subject; b: Subject; level: 'same' }[] = []
      for (const { subject, identifier } of marks) {
        if (!usable(policy, identifier, states.get(identifier))) continue
        const a = first.get(identifier)
        if (a && members.get(a)!.cluster === members.get(subject)!.cluster) pairs.push({ a, b: subject, level: 'same' })
        else first.set(identifier, subject)
      }
      const joined = components(records, pairs)
      const claimed = new Map<Subject, Set<Subject>>()
      for (const subject of named) {
        const group = joined.get(subject) ?? subject
        claimed.set(group, (claimed.get(group) ?? new Set()).add(subject))
      }
      for (const [subject, group] of joined) {
        const records = claimed.get(group)
        if (records?.size === 1) owners.set(subject, [...records][0]!)
      }
    }
    return (subject: Subject) => owners.has(subject) ? `subject:${owners.get(subject)}` : `cluster:${cluster(subject)}`
  }

  const followable = async (tx: Tx, subject: Subject, since: number, at: number) => (await tx.touchesOf([subject], since, at)).length > 0 && (await tx.consentOf([subject])).get(subject)?.adUserData !== false

  /** Whether a caller may be tied to a visitor: no reviewer keeps the two apart, and the visitor is no other caller's. */
  async function formerTies(tx: Tx, subject: Subject) {
    const ids = unique((await tx.callEvidence({ subjects: [subject] })).map(row => row.identifier).filter(id => /^(dial|text|lease):/.test(id)))
    const states = await tx.states(ids)
    const open = ids.filter(id => usable(policy, id, states.get(id)))
    const rows = [...await tx.callEvidence({ identifiers: open }), ...await tx.edgesOn(open)]
    return rows.filter(row => subject !== row.subject && isTie(row.identifier, subject, row.subject)).map(row => ({ subject: row.subject, identifier: row.identifier }))
  }

  const tieable = async (tx: Tx, caller: Subject, visitor: Subject, identifier: Identifier): Promise<boolean> =>
    !(await tx.separatedOf([caller])).some((pair) => pair.includes(visitor)) &&
    !((await neighbors(tx, [visitor])).get(visitor) ?? []).some((link) => link.subject !== caller && link.reasons.some((reason) => isTie(reason.identifier, visitor, link.subject))) &&
    !(await formerTies(tx, visitor)).some(tie => tie.subject !== caller) &&
    !(await tx.states([identifier])).get(identifier)?.ignored

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
    if (!Number.isSafeInteger(seen) || seen < 0) throw malformed('`seen` must be a decision number')
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

  /** The marks reviewers' joins left on both of each pair, that still count. */
  async function marksOf(tx: Tx, pairs: readonly (readonly [Subject, Subject])[]): Promise<Identifier[][]> {
    const edges = (await tx.edgesOf(unique(pairs.flat()))).filter((edge) => edge.identifier.startsWith('review:join-'))
    const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
    const held = new Map<Subject, Set<Identifier>>()
    for (const { subject, identifier } of edges) if (!states.get(identifier)!.ignored) held.set(subject, (held.get(subject) ?? new Set()).add(identifier))
    return pairs.map(([a, b]) => [...(held.get(a) ?? [])].filter((each) => held.get(b)?.has(each)))
  }

  /** Whether each pair is tied by what they share, any reviewer's mark left out. */
  async function pairsTied(tx: Tx, pairs: readonly (readonly [Subject, Subject])[]): Promise<boolean[]> {
    const edges = (await tx.edgesOf(unique(pairs.flat()))).filter((edge) => !edge.identifier.startsWith('review:'))
    const states = await tx.states(unique(edges.map((edge) => edge.identifier)))
    const scored = new Set(scorePairs(policy, edges, states).filter((pair) => pair.score >= policy.same).map(({ a, b }) => pairKey(a, b)))
    return pairs.map(([a, b]) => scored.has(pairKey(a, b)))
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
    if (!Array.isArray(pairs)) throw malformed(`${verb} requires a list of pairs`)
    return pairs.map((told) => ({ pair: pairOf(told?.a, told?.b, verb), separated: told.separated ?? true, why: { ...why, ...(told.reason && { reason: String(told.reason) }) } }))
  }

  /** An outcome as its payments have it: what they come to, to the hundred-thousandth, in their currency. */
  function paidFor(outcome: Counted, payments: readonly Required<Payment>[]): Counted {
    if (payments.length === 0) return outcome
    const paid = payments.find((each) => each.currency)?.currency
    if (paid && outcome.currency && outcome.currency !== paid) throw refused(`Outcome "${outcome.transactionId}" must use the currency of its payments`, { reason: 'CURRENCY_MISMATCH', expected: paid })
    const value = payments.reduce((sum, { kind, amount }) => sum + (kind === 'refund' ? -amount : amount), 0)
    return { ...outcome, value: Math.max(0, Math.round(value * 1e5) / 1e5), currency: outcome.currency || paid || '' }
  }

  /** Adds an outcome's value to its history, unless it is the one it already has. */
  async function revalue(tx: Tx, { transactionId, subject, value, currency }: Counted, kind?: Loss, why?: OutcomeValue['why']): Promise<void> {
    const last = (await tx.valuesOf(transactionId, subject)).at(-1)
    if (last?.value !== value || last.currency !== currency) await tx.addValue(transactionId, subject, { value, currency, at: now(), ...(kind && { kind }), ...(why && { why }) })
  }

  /** Refuses text the database cannot keep, before anything is written. */
  const keepable = (...texts: (string | undefined)[]) => {
    for (const text of texts) if (text !== undefined && UNSTORABLE.test(text)) throw malformed('Text contains unsupported characters')
  }

  const pairOf = (a: Subject, b: Subject, verb: string): [Subject, Subject] => {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) throw malformed(`${verb} requires two different subjects`)
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
      return !state.ignored && before <= ruleFor(policy, identifier).cap && state.fanout > 1
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
      for (const observation of observations) {
        const { subject, identifiers, at, event } = observation ?? {}
        if (typeof subject !== 'string' || !subject) throw malformed('An observation requires a subject')
        if (!Number.isSafeInteger(at)) throw malformed(`Observation of "${subject}" requires "at", an integer in epoch milliseconds`)
        if (event !== undefined && typeof event !== 'string') throw malformed(`Observation of "${subject}" requires its event as a string`)
        if (!Array.isArray(identifiers) || identifiers.some((each) => typeof each !== 'string')) throw malformed(`Observation of "${subject}" requires its identifiers as a list of strings`)
        if (UNSTORABLE.test(subject) || (event !== undefined && UNSTORABLE.test(event))) throw malformed('An observation contains unsupported characters')
        for (const identifier of nameEvidence(identifiers)) {
          if (UNSTORABLE.test(identifier)) throw malformed('An observation contains unsupported characters')
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

    spokenForBy(person, speakers) {
      return store.read(async (tx) => {
        const home = (await tx.labelsOf([person])).get(person)
        const members = home ? await tx.clusterOf(home.cluster) : [person]
        for (const links of (await neighbors(tx, members)).values()) {
          if (links.some((link) => speakers.has(link.subject) && link.level !== 'same' && link.reasons.some((reason) => reason.identifier.startsWith('behalf:')))) return true
        }
        return false
      })
    },

    async match(identifiers, { at = now(), limit = 20 } = {}) {
      const given = nameEvidence(identifiers)
      for (const each of given) ruleFor(policy, each)
      // Nobody's id: no subject on record has an empty one.
      const nobody = ''
      return store.read(async (tx) => {
        const states = await tx.states(given)
        for (const identifier of given) {
          const kept = states.get(identifier)
          states.set(identifier, { ignored: kept?.ignored ?? false, fanout: (kept?.fanout ?? 0) + 1 })
        }
        // Counting this record can make a name public for it and for everyone who already holds it.
        const unavailable = new Set(given.filter(silent(states)))
        const open = given.filter((identifier) => usable(policy, identifier, states.get(identifier)))
        const edges = [...(await tx.edgesOn(open)), ...open.map((identifier): Edge => ({ subject: nobody, identifier, first: at, last: at, count: 1 }))]
        const found = scorePairs(policy, edges, states, new Set([nobody]))
        const labels = await tx.labelsOf(found.map((pair) => pair.b))
        found.sort((x, y) => y.score - x.score || (x.b < y.b ? -1 : 1))
        const out: Candidate[] = []
        const some = found.slice(0, limit)
        const facts = await known(tx, some.map((pair) => pair.b), false, unavailable)
        const own = knownOf(policy, given.map((identifier): Edge => ({ subject: nobody, identifier, first: at, last: at, count: 1 })), (identifier) => unavailable.has(identifier)).get(nobody)

        // A call that used to place a browser with another record can still rule out a proposed match. Keep that record private.
        const hasFormer = policy.apart?.length && await tx.hasCallEvidence()
        const distinct = given.filter(callRelates)
        const formerTold = new Set<Subject>()
        if (distinct.length) for (const { holders, permits } of (await possibleCallRelations(tx, distinct, 1)).values()) {
          for (const subject of holders) if (permits(subject)) formerTold.add(subject)
        }
        const nearby = new Map<Subject, (Known | undefined)[]>()
        async function formerRecords(home: Labels) {
          const cached = nearby.get(home.cluster)
          if (cached) return cached
          const component = await tx.membersOf([home.component])
          const others = [...component].filter(([member, labels]) => names(member) && labels.cluster !== home.cluster).map(([member]) => member)
          let records: (Known | undefined)[] = []
          if (others.length) {
            const subjects = [...component.keys()]
            let touched = (await tx.callEvidence({ subjects })).length > 0
            if (!touched) {
              const ids = unique((await tx.edgesOf(subjects)).map(edge => edge.identifier).filter(id => /^(phone|voip):/.test(id)))
              touched = ids.length > 0 && (await tx.callEvidence({ identifiers: ids })).length > 0
            }
            if (touched) {
              const facts = await known(tx, others, false, unavailable)
              records = others.map(subject => facts.get(subject))
            }
          }
          nearby.set(home.cluster, records)
          return records
        }
        for (const { b: subject, score, level, reasons } of some) {
          const members = (await tx.clusterOf(labels.get(subject)!.cluster)).sort()
          // A browser or a caller answers for the records it is one with, because they are shown with it.
          const theirs = names(subject) ? [facts.get(subject)] : [...(await known(tx, members.filter(names), false, unavailable)).values()]
          // The caller's own facts can keep a probe apart. Only a record can confirm a claim on another record.
          const between = conflict(policy, own, facts.get(subject)) ?? theirs.map((each) => conflict(policy, own, each)).find((each) => each !== undefined)
          // Asked about before they are on record, they are a record to be.
          const possibly = !between && (level === 'same' ? !theirs.some((each) => confirmed(own, each)) : reasons.some((reason) => /^(person|perhaps):/.test(reason.identifier))) && policy.records === 'confirmed' && members.some(names)
          let former = formerTold.has(subject) && !reasons.some(reason => reason.identifier.startsWith('review:'))
          if (!former && !between && !possibly && level === 'same' && hasFormer && policy.apart?.length && !names(subject)) {
            const records = await formerRecords(labels.get(subject)!)
            const needsRecord = policy.records === 'confirmed' && !theirs.some(each => confirmed(own, each))
            former = records.some(record => conflict(policy, own, record) || (needsRecord && !confirmed(own, record)))
          }
          out.push({ subject, score, level: between || possibly || former ? 'related' : level, reasons, ...(between && { conflict: between }), ...(possibly && { unconfirmed: true as const }), members })
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

    cluster(subject, explain) {
      return store.read(async (tx) => {
        const own = (await tx.labelsOf([subject])).get(subject)
        if (!own) return undefined
        const members = (await tx.clusterOf(own.cluster)).sort()
        let limited = false
        if (explain && await tx.hasCallEvidence()) await compute(tx, [...(await tx.membersOf([own.component])).keys()], undefined, undefined, group => { if (group.includes(subject)) limited = true })
        return { id: own.cluster, members, oversized: members.length > policy.review, ...(limited ? { limitedByCalls: true as const } : {}) }
      })
    },

    async touch(touch, call) {
      checkTouch(touch)
      await store.write(async (tx) => {
        await tx.addTouch(touch, call ?? '')
        await tx.fed('touches', now())
      })
    },

    attribute(subject, { at, window = 90 * DAY, hops = 2 }) {
      return store.read(async (tx) => credit(subject, at, window, (await asOne(tx, new Map([[subject, await reach(tx, [subject], hops, undefined, undefined, true)]]))).get(subject)!, tx))
    },

    async outcome(outcome) {
      const { transactionId, subject, at } = outcome
      if (!transactionId || !subject) throw malformed('An outcome requires a transactionId and a subject')
      if (typeof transactionId !== 'string' || typeof subject !== 'string') throw malformed('An outcome requires a transactionId and a subject, as strings')
      if (!Number.isSafeInteger(at)) throw malformed(`Outcome "${transactionId}" requires "at", an integer in epoch milliseconds`)
      const value = outcome.value ?? 0
      if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed(`Outcome "${transactionId}" has a value that is not a number`)
      for (const text of [outcome.stage, outcome.currency]) if (text !== undefined && typeof text !== 'string') throw malformed(`Outcome "${transactionId}" requires its stage and currency as strings`)
      keepable(transactionId, subject, outcome.stage, outcome.currency)
      const tags = checkTags(outcome.tags, `Outcome "${transactionId}"`)
      const counted: Counted = { transactionId, subject, at, stage: outcome.stage || 'outcome', value, currency: outcome.currency ?? '', ...(tags && { tags }) }
      return store.write(async (tx) => {
        if (await tx.outcomeOf(transactionId)) return false
        // Whoever was forgotten while their text was being counted is not written down again.
        if (outcome.ofText !== undefined && (await tx.textOf(outcome.ofText))?.subject !== subject) throw new Gone()
        // Paid for before it was recorded, it is worth what was paid.
        const payments = await tx.paymentsOf(transactionId)
        // Taken back and counted again, it is worth what was said of it meanwhile too.
        const said = payments.length === 0 ? worthOf(await tx.saidOf('worth', transactionId)) : undefined
        const worth = said ? { ...counted, value: said.value, currency: said.currency || counted.currency } : paidFor(counted, payments)
        await tx.setOutcome(worth)
        // What it was said to be worth comes first, whether or not it was paid for already.
        if (payments.length > 0) await revalue(tx, counted)
        await revalue(tx, worth, undefined, payments.length > 0 ? 'payment' : undefined)
        return true
      })
    },

    async pay({ id, transactionId, amount, kind = 'payment', currency = '' }) {
      if (typeof id !== 'string' || !id || typeof transactionId !== 'string' || !transactionId) throw malformed('A payment requires an id and a transactionId, as strings')
      if (!(typeof amount === 'number' && amount >= 1e-5 && amount <= 1e10)) throw malformed(`Payment "${id}" requires an amount above zero, of ten billion at most`)
      if (kind !== 'payment' && kind !== 'refund') throw malformed(`Payment "${id}" must be a payment or a refund`)
      if (typeof currency !== 'string') throw malformed(`Payment "${id}" requires its currency as a string`)
      keepable(id, transactionId, currency)
      return store.write(async (tx) => {
        const before = await tx.paymentOf(id)
        const outcome = await tx.outcomeOf(transactionId)
        if (before && (before.transactionId !== transactionId || before.amount !== amount || before.kind !== kind || before.currency !== currency)) throw refused(`Payment "${id}" was already recorded with different details`, { reason: 'KEY_REUSED', fields: [] })
        if (before) return { duplicate: true, ...(outcome && { value: outcome.value }) }
        const payments = [...(await tx.paymentsOf(transactionId)), { id, transactionId, amount, kind, currency }]
        if (new Set([outcome?.currency, ...payments.map((each) => each.currency)].filter(Boolean)).size > 1) throw refused(`Payment "${id}" must use the currency of its outcome`, { reason: 'CURRENCY_MISMATCH', expected: outcome?.currency || payments.find((each) => each.currency)!.currency })
        await tx.addPayment(payments.at(-1)!)
        if (!outcome) return { duplicate: false }
        const worth = paidFor(outcome, payments)
        if (worth.value !== outcome.value || worth.currency !== outcome.currency) {
          await tx.setOutcome(worth)
          // What was given back is counted from the refunds, which come in any order, and not from how the value moved.
          await revalue(tx, worth, undefined, 'payment')
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
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw malformed('A restated value must be zero or more')
      if (currency !== undefined && typeof currency !== 'string') throw malformed('A restated currency must be a string')
      if (kind !== undefined && kind !== 'refund' && kind !== 'write_off') throw malformed('`kind` must be `refund` or `write_off`')
      keepable(transactionId, currency)
      return store.write(async (tx) => {
        const found = await tx.outcomeOf(transactionId)
        if (!found) return false
        if (kind !== undefined) {
          if (currency && currency !== found.currency) throw malformed('A refund or write-off must use the currency of the outcome')
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
          if (value > found.value && (said <= 0 || value - found.value > said + off)) throw malformed(`Outcome "${transactionId}" cannot reverse more than was ${kind === 'refund' ? 'refunded' : 'written off'}`)
        }
        const restated = { ...found, value, ...(currency && { currency }) }
        await tx.setOutcome(restated)
        await revalue(tx, restated, kind)
        return true
      })
    },

    async revise({ key, at, transactionId, change }) {
      keepable(key, transactionId)
      return store.write(async (tx) => {
        const found = await tx.outcomeOf(transactionId)
        if (!found) throw refused(`No conversion "${transactionId}" is recorded`, { reason: 'UNKNOWN_REFERENCE' })
        if ((await tx.paymentsOf(transactionId)).length > 0) throw refused(`Conversion "${transactionId}" has payments, so it is worth what was paid`, { reason: 'PAID' })
        if ('currency' in change && change.currency && found.currency && change.currency !== found.currency) throw refused(`Conversion "${transactionId}" is in ${found.currency}`, { reason: 'CURRENCY_MISMATCH', expected: found.currency })
        const before = await tx.saidOf('worth', transactionId)
        if (change.kind === 'reverse' && !before.some((each) => each.key === change.restatement && (each.data.kind === 'refund' || each.data.kind === 'write_off'))) throw refused(`No refund or write-off "${change.restatement}" of conversion "${transactionId}" is recorded`, { reason: 'UNKNOWN_REFERENCE', restatement: change.restatement })
        if (before.length === 0) await tx.addSaid({ topic: 'worth', about: transactionId, key: '', at: found.at, data: { kind: 'base', value: found.value, currency: found.currency } })
        // The first currency that is named is the conversion's, whoever names it. Another is refused from then on.
        const named = 'currency' in change && !found.currency ? change.currency : undefined
        const data = change.kind === 'correct' ? { kind: change.kind, value: change.value, ...(change.currency && { currency: change.currency }) } : change.kind === 'reverse' ? { kind: change.kind, restatement: change.restatement } : { kind: change.kind, amount: change.amount }
        await tx.addSaid({ topic: 'worth', about: transactionId, key, at, data })
        const worth = worthOf(await tx.saidOf('worth', transactionId))!
        const restated = { ...found, value: worth.value, currency: found.currency || named || worth.currency }
        await tx.setOutcome(restated)
        await revalue(tx, restated, undefined, change.kind)
        return { value: worth.value, currency: restated.currency, stands: change.kind !== 'correct' || worth.stands === key }
      })
    },

    async sayLead({ id, key, at, kind }) {
      keepable(key, id)
      return store.write(async (tx) => {
        const before = await tx.saidOf('lead', id)
        const [marked] = (await tx.notLeads([id])).values()
        // What was said before anything was kept of who said it when.
        if (before.length === 0 && marked) await tx.addSaid({ topic: 'lead', about: id, key: '', at: marked.at, data: { kind: marked.kind } })
        await tx.addSaid({ topic: 'lead', about: id, key, at, data: { kind: kind ?? null } })
        const stands = newest(await tx.saidOf('lead', id))!
        await tx.setNotLead(id, stands.data.kind ? { kind: stands.data.kind, at: stands.at } : undefined)
        return { stands: stands.key === key, lead: stands.data.kind === null }
      })
    },

    async sayResult({ call, key, at, result }) {
      keepable(key, call)
      return store.write(async (tx) => {
        const before = await tx.callResultOf(call)
        if ((await tx.saidOf('result', call)).length === 0 && before?.answered !== undefined) {
          const { answered, voicemail, waited, recorded } = before
          await tx.addSaid({ topic: 'result', about: call, key: '', at: recorded, data: { answered, ...(voicemail !== undefined && { voicemail }), ...(waited !== undefined && { waited }) } })
        }
        await tx.addSaid({ topic: 'result', about: call, key, at, data: result })
        const stands = newest(await tx.saidOf('result', call))!
        await tx.setCallResult(call, { ...stands.data, ...(before?.returned !== undefined && { returned: before.returned }), recorded: now() })
        await tx.fed('results', now())
        return { stands: stands.key === key }
      })
    },

    async repairCallReports() {
      if (await store.read(tx => tx.settingOf('repairCallReports')) !== 'due') return
      let done = false
      while (!done) await changing(async tx => {
        const ids = await tx.overwrittenCalls(50)
        const changes: Change[] = []
        for (const id of ids) changes.push(...await settleParty(tx, id, false, true))
        if (ids.length) await tx.setSetting('callParty', randomUUID())
        done = ids.length < 50
        if (done) await tx.setSetting('repairCallReports', 'done')
        return changes
      })
    },

    async sayParty({ call, key, at, party, seen }) {
      keepable(key, call, party.by, ...(party.role === 'unknown' ? [] : [party.subject]))
      let stands = false
      await changing(async (tx) => {
        const deletion = 'subject' in party ? await tx.partyReturn(party.subject, call) : undefined
        if (deletion === 'forgotten') throw refused('The record named for this call was forgotten', { reason: 'FORGOTTEN' })
        if (seen !== undefined) {
          const current = newest(await tx.saidOf('party', call))
          if (seen !== (current?.key ?? null)) throw refused('The party statement has changed', { reason: 'STALE', decision: current?.key ?? null, by: current?.data.by ?? null, at: current?.at ?? null })
        }
        const added = await tx.addSaid({ topic: 'party', about: call, key, at, data: party })
        if (added && deletion !== undefined) await tx.confirmPartyReturn(call, key, deletion)
        stands = newest(await tx.saidOf('party', call))!.key === key
        if (!added || !stands) return []
        await tx.setSetting('callParty', randomUUID())
        return settleParty(tx, call)
      })
      return { stands }
    },

    refreshParty(id) {
      return changing(async tx => {
        await tx.setSetting('callParty', randomUUID())
        return settleParty(tx, id)
      })
    },

    partyHistory(id) {
      return store.read(async (tx) => (await tx.saidOf('party', id)).sort(later).map(({ key, at, data }) => ({ key, at, ...data })))
    },

    partyRevision() {
      return store.read((tx) => tx.settingOf('callParty'))
    },

    async sayReturn({ call, key, at, reachedAt }) {
      keepable(key, call)
      return store.write(async (tx) => {
        const { returned, ...before } = (await tx.callResultOf(call)) ?? { recorded: now() }
        if ((await tx.saidOf('return', call)).length === 0 && returned !== undefined) await tx.addSaid({ topic: 'return', about: call, key: '', at: returned, data: { reachedAt: returned } })
        await tx.addSaid({ topic: 'return', about: call, key, at, data: { reachedAt: reachedAt ?? null } })
        const stands = newest(await tx.saidOf('return', call))!
        const reached = stands.data.reachedAt
        if (reached === null && !('answered' in before) && !('voicemail' in before) && !('waited' in before)) await tx.removeCallResult(call)
        else await tx.setCallResult(call, { ...before, ...(reached !== null && { returned: reached }) })
        return { stands: stands.key === key }
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

    async keepCall(call, lineKind, reserved) {
      await store.write(async (tx) => {
        // Only a visitor still tied by this call: one forgotten meanwhile is not written down again.
        const { visitor, ...rest } = call
        // One doubted meanwhile is not tied either.
        const doubted = (await tx.states([`dial:${call.id}`])).get(`dial:${call.id}`)?.ignored === true
        let tied = visitor !== undefined && (await tx.edgesOn([...(doubted ? [] : [`dial:${call.id}`]), `lease:${call.id}`, codeTie(call.id)])).some((edge) => edge.subject === visitor)
        // What was said of it meanwhile stays said.
        const before = await tx.callOf(call.id)
        const stated = (await tx.saidOf('party', call.id)).length > 0
        const pending = !before && stated && reserved
        if (pending && visitor && reserved.tie) {
          const source = reserved.tie
          const available = source.pool ? (await holderOf(tx, source.pool.number, call.at, source.pool.grace)) === visitor : (await tx.edgesOn(source.notes ?? [])).some(edge => edge.subject === visitor)
          tied = available && await tieable(tx, call.subject, visitor, source.identifier)
        }
        const said = before?.flags.includes('ambiguous') && doubted && !call.flags.includes('pool') && !byCode(call)
        await tx.setCall({ ...rest, ...(said && { flags: [...new Set([...call.flags, 'ambiguous'])] }), ...(tied && { visitor }), recorded: now() }, lineKind, !before && stated)
        if (pending) {
          const rows = reserved.identifiers.map(identifier => ({ subject: call.subject, identifier }))
          if (tied && visitor && reserved.tie) for (const subject of [call.subject, visitor]) rows.push({ subject, identifier: reserved.tie.identifier })
          await tx.reserveCall(rows.map(row => ({ ...row, call: call.id, at: call.at, recorded: now() })))
          const holders = await tx.edgesOn(rows.map(row => row.identifier))
          await settle(tx, new Set([...holders, ...rows].map(edge => edge.subject)), true)
        }
        if (stated) await settleParty(tx, call.id, !before)
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
      if (typeof id !== 'string' || !id) throw malformed('`transactionId` is required')
      if (kind !== undefined && kind !== 'spam' && kind !== 'other') throw malformed('`kind` must be `spam` or `other`')
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
      if (!names(who.subject) || by.some((each) => names(each.subject))) throw malformed('A browser or a caller speaks for a record of yours')
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
        const devices = by.map((each) => each.subject.startsWith('visitor:') ? each.identifiers.filter((identifier) => identifier.startsWith('device:')) : [])
        const heldDevices = unique(devices.flat())
        const states = await tx.states([...own, ...heldDevices])
        const browsers = own.length ? await tx.edgesOn(heldDevices) : []
        const spoken = (browsers.length ? await tx.edgesOn(own) : edges).filter((edge) => edge.subject !== who.subject && own.includes(edge.identifier)).sort((a, b) => a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0)
        const marked: { subject: Subject; identifiers: Identifier[] }[] = []
        // Said again, it is the mark there is, muted or not. It names nobody, so a forgotten id leaves no trace.
        for (const [i, each] of by.entries()) {
          const aliases = browsers.filter((edge) => edge.subject.startsWith('visitor:') && devices[i]!.includes(edge.identifier))
          const same = spoken.filter((edge) => edge.subject === each.subject || aliases.some((other) => other.subject === edge.subject && (states.get(edge.identifier)?.ignored || usable(policy, other.identifier, states.get(other.identifier)))))
          const past = same.find((edge) => states.get(edge.identifier)?.ignored) ?? same.find((edge) => edge.subject === each.subject) ?? same[0]
          const before = by.findIndex((other, j) => other.subject === each.subject || devices[i]!.some((device) => devices[j]!.includes(device)))
          const mark = before < i ? marks[before]! : past?.identifier ?? `behalf:${randomUUID()}`
          marks.push(mark)
          // Keep both original holders. A third holder would thin the mark or put it over its cap.
          if (before === i) marked.push({ subject: past?.subject ?? each.subject, identifiers: [mark] })
        }
        const recorded = now()
        return record(tx, [{ ...who, identifiers: [...identifiers, ...marks] }, ...by, ...marked].flatMap((each) => nameEvidence(each.identifiers).map((identifier) => ({ subject: each.subject, identifier, at, event, recorded }))))
      })
      return { marks, identifiers: [...identifiers, ...new Set(marks)], changes }
    },

    async tieCall(caller, visitor, identifier, at, by, withheldCall) {
      ruleFor(policy, identifier)
      let tied = false
      // One transaction: two calls reported at once cannot both find the visitor free.
      await changing(async (tx) => {
        // What matched the two is read again: whoever was forgotten meanwhile is not tied, even where they have been seen since.
        const matched = 'pool' in by ? (await holderOf(tx, by.pool, at, by.grace)) === visitor : (await tx.edgesOn(by.notes)).some((edge) => edge.subject === visitor)
        // Another call reported meanwhile may have cast doubt on it.
        tied = matched && (await tieable(tx, caller, visitor, identifier))
        if (!tied) return []
        if (withheldCall) {
          const call = await tx.callOf(withheldCall)
          if (!call || await tx.callLine(withheldCall) !== caller) return []
          await tx.reserveCall([caller, visitor].map(subject => ({ call: withheldCall, subject, identifier, at, recorded: call.recorded })))
          return settle(tx, new Set([caller, visitor]), true)
        }
        return record(tx, [caller, visitor].map((subject) => ({ subject, identifier, at, event: 'call', recorded: now() })))
      })
      return tied
    },

    async doubtCall(id, ambiguous, line) {
      const identifier = `dial:${id}`
      await changing(async (tx) => {
        // What a person has looked at and restored stays.
        if ((await tx.newestNaming([identifier], 0, ['ignore', 'restore']))?.action === 'restore') return []
        const call = await tx.callOf(id)
        const withheld = await tx.callEvidence({ calls: [id], identifiers: [identifier] })
        // Only the original tap can lose a contest. A later rival cannot change the party, a code or a pool assignment.
        if (call?.party && !withheld.length) return []
        if (call && !call.party && (call.flags.includes('pool') || byCode(call))) return []
        if (call && !call.party && (call.visitor !== undefined || (ambiguous && !call.flags.includes('ambiguous')))) {
          const { visitor, ...rest } = call
          await tx.setCall({ ...rest, flags: [...new Set([...call.flags, ...(ambiguous ? ['ambiguous'] : [])])] })
          if (line && visitor !== undefined) await tx.addTouch({ ...line, subject: call.subject, at: call.at }, id)
        }
        if ((await tx.states([identifier])).get(identifier)?.ignored) return []
        const holders = (await tx.edgesOn([identifier])).map((edge) => edge.subject)
        // Not tied yet, it is kept from being tied, and there is nothing to have decided.
        if (holders.length > 0) await decide(tx, 'ignore', [identifier], { by: 'calls', reason: 'another call leaves the tap it rests on in doubt', automatic: true })
        await tx.setIgnored(identifier, true)
        if (withheld.length) await tx.setSetting('callParty', randomUUID())
        const affected = new Set([...holders, ...withheld.map(row => row.subject)])
        if (!affected.size) return []
        await mark(tx)
        const changes = await settle(tx, affected, withheld.length > 0)
        await recheckCallbacks(tx, [...affected], false, id)
        return changes
      })
    },

    async nameCall(id, visitor, note, line) {
      const identifier = codeTie(id)
      ruleFor(policy, identifier)
      await changing(async (tx) => {
        const call = await tx.callOf(id)
        const guesses = [`dial:${id}`, `lease:${id}`]
        if (!call || byCode(call) || (await tx.newestNaming(guesses, 0, ['ignore', 'restore']))?.action === 'restore') return []
        // Forgotten since the code was looked up, whoever it named is named by nothing.
        if (!(await tx.edgesOn([note])).some((edge) => edge.subject === visitor)) return []
        if (call.party) {
          const raw = (await tx.rivalCalls(call.to, call.at, call.at + 1)).find(row => row.id === id)
          if (!raw || byCode(raw)) return []
          const guessed = await tx.callEvidence({ calls: [id], identifiers: guesses })
          for (const previous of unique(guessed.map(row => row.identifier))) await tx.setIgnored(previous, true)
          const tied = await tieable(tx, raw.subject, visitor, identifier)
          if (tied) await tx.reserveCall([raw.subject, visitor].map(subject => ({ call: id, subject, identifier, at: call.at, recorded: now() })))
          await tx.markPartyCode(id, tied ? visitor : undefined)
          await tx.setSetting('callParty', randomUUID())
          const affected = new Set([...guessed.map(row => row.subject), raw.subject, visitor])
          const changes = await settle(tx, affected, tied || guessed.length > 0)
          await recheckCallbacks(tx, [...affected], false, id)
          return changes
        }
        // Left beside the code's, a tie by a tap would count twice what is known once.
        const guessed = await tx.edgesOn(guesses)
        const held = unique(guessed.map((edge) => edge.identifier))
        const states = await tx.states(held)
        for (const each of held) {
          if (states.get(each)?.ignored) continue
          await decide(tx, 'ignore', [each], { by: 'calls', reason: 'the caller gave the code of a visitor', automatic: true })
          await tx.setIgnored(each, true)
        }
        await mark(tx)
        const changes = await settle(tx, new Set(guessed.map((edge) => edge.subject)))
        const tied = await tieable(tx, call.subject, visitor, identifier)
        const { visitor: guess, ...rest } = call
        await tx.setCall({ ...rest, flags: [...call.flags.filter((flag) => flag !== 'ambiguous' && flag !== 'pool'), tied ? 'code' : 'taken'], ...(tied && { visitor }) })
        // As it would be had the code come first: filed under its number only where it is tied to nobody.
        if (tied && line && guess === undefined) await tx.dropTouch(call.subject, call.at, line.landing!, id)
        if (!tied && line && guess !== undefined) await tx.addTouch({ ...line, subject: call.subject, at: call.at }, id)
        return tied ? [...changes, ...(await record(tx, [call.subject, visitor].map((subject) => ({ subject, identifier, at: call.at, event: 'call', recorded: now() }))))] : changes
      })
    },

    rivalCalls: (number, from, to, line) => store.read(async tx => {
      const calls = await tx.rivalCalls(number, from, to, line)
      const held = await tx.callEvidence({ calls: calls.map(call => call.id) })
      const states = await tx.states(unique(held.map(row => row.identifier)))
      for (const call of calls) {
        const tie = held.find(row => row.call === call.id && row.subject !== call.subject && /^(dial|lease|text):/.test(row.identifier) && !states.get(row.identifier)?.ignored)
        if (tie) call.visitor = tie.subject
        else if (call.party) delete call.visitor
      }
      return calls
    }),

    rivalTies: subject => store.read(tx => formerTies(tx, subject)),

    async callsTo(number, from, to) {
      return (await store.read((tx) => tx.callsBetween(from, to))).filter((call) => call.to === number)
    },

    followable(subject, since) {
      return store.read((tx) => followable(tx, subject, since, now()))
    },

    async lease(subject, { numbers, minutes, at = now(), arrivedSince }) {
      if (typeof subject !== 'string' || !subject) throw malformed('A lease requires a subject')
      if (!Number.isSafeInteger(at)) throw malformed('A lease requires `at`, an integer in epoch milliseconds')
      if (!(Number.isFinite(minutes) && minutes > 0)) throw malformed('A lease requires its length in minutes, above zero')
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
        // The one who had it last gets it back.
        const free = unique(numbers).filter((number) => ended(number) <= at)
        if (free.length === 0) return undefined
        const number = free.find((each) => newest.get(each)?.subject === subject) ?? free.reduce((best, next) => (ended(next) < ended(best) ? next : best))
        const lease = { number, subject, start: at, until }
        await tx.setLease(lease)
        return lease
      })
    },

    async shownTo(number, at) {
      return (await store.read((tx) => tx.newestLeases([number], at)))[0]
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
          await tx.addTouch(touch, '')
          await tx.fed('touches', now())
        }
        return true
      })
    },

    stopText(id, subject, to) {
      return store.write(async tx => {
        const text = await tx.textOf(id)
        if (text?.direction !== 'inbound' || text.subject !== subject || text.to !== to || text.flags.includes('opt_out')) return { text, added: false }
        const stopped = { ...text, flags: [...text.flags.filter(flag => flag !== 'opt_in'), 'opt_out'] }
        await tx.setText(stopped)
        return { text: stopped, added: true }
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
        const creditOf = await creditAll(tx, open, 90 * DAY, 2, undefined, open)
        for (const call of open) {
          const { credited } = creditOf(call.subject, call.at, call)
          out.push({ call, followUp: followUp(call, later), ...(credited && { touch: credited }) })
        }
        return out
      })
    },

    queueCallback(alert, event, keepEvent) {
      return store.write(async (tx) => {
        const { data } = event
        const call = await tx.callOf(data.call)
        if (!call || call.subject !== data.subject || alert.subject !== call.subject || call.at !== data.missedAt || call.direction !== 'inbound' || call.result?.answered !== false) return false
        const calls = await leadsOf(tx, await tx.callsOf([call.subject]), callId)
        if (!calls.some((each) => each.id === call.id)) return false
        const wait = followUp(call, calls)
        const first = firstOpen(calls)
        if (wait.state !== 'open' || wait.attempts !== data.attempts || !first || alert.key !== `unreturned:${call.subject}:${first.id}`) return false
        const creditOf = await creditAll(tx, [call], 90 * DAY, 2, undefined, [call])
        const { credited } = creditOf(call.subject, call.at, call)
        if (!credited || !paid(credited) || sourceOf(credited) !== data.source || (credited.campaign ?? null) !== data.campaign || (credited.campaignId ?? null) !== data.campaignId) return false
        // The notice may name a later miss than its key, and count attempts that staff can later assign to someone else.
        const attempts = calls.filter(each => each.direction === 'outbound' && each.at > call.at)
        const channel = credited.landing?.startsWith('tel:') ? await tx.callsBehind(credited) : []
        const route = [...credited.via, credited.subject]
        const sources = unique([call.id, first.id, ...attempts.map(each => each.id), ...channel, ...(credited.via.length ? route.map(creditSubject) : []), ...(credited.via.length || call.party ? [arrivalKey(credited)] : [])])
        if (!await tx.addAlert(alert, false, sources)) return false
        if (keepEvent) await tx.emit([{ ...event, once: alert.key, subject: call.subject, calls: sources }])
        return true
      }, { whole: true })
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
      if (!Array.isArray(steps) || !steps.every((step) => typeof step?.name === 'string' && step.name)) throw malformed('`steps` must be a list, such as [{ name: "inquiry" }]')
      if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw malformed('`days` must be an integer from 1 to 365')
      const day = dayIn(at, timeZone)
      const today = dayStart(day, timeZone)
      const from = dayStart(new Date(Date.parse(day) - (days - 1) * DAY).toISOString().slice(0, 10), timeZone)
      return store.read(async (tx) => {
        const outcomes = await leadsOf(tx, await tx.outcomesBetween(from, at + 1), outcomeId)
        const found = unique([...outcomes.map((each) => each.subject), ...(await tx.calledBetween(from, at + 1))])
        const everyone = await tx.aroundOf(found)
        const cluster = (subject: Subject) => everyone.get(subject)?.cluster ?? subject
        const groups = new Set(found.map(cluster))
        const theirs = unique([...found, ...everyone.keys()]).filter((subject) => groups.has(cluster(subject)))
        const times = await tx.callTimes(theirs)
        const parties = new Map(times.filter((call) => call.party).map((call) => [`call:${call.id}`, call]))
        const person = await personWithCalls(tx, times, cluster)
        const people = new Map(found.map((subject) => [person(subject), { outcomes: [] as Counted[], calls: [] as CallTime[] }]))
        for (const outcome of await leadsOf(tx, await tx.outcomesOf(theirs), outcomeId)) people.get(person(outcome.subject))?.outcomes.push(outcome)
        for (const call of times) people.get(person(call.subject))?.calls.push(call)
        const { columns, unplaced } = board([...people.values()], { steps: steps.map(({ name, wait }) => ({ name, ...(wait && { wait: wait * HOUR }) })), at, today, ...(returnHours > 0 && { returnWait: returnHours * HOUR }), ...(hours && { hours }) })
        // Only those shown are traced to an ad: it is the slow part.
        const shown: BoardColumn<BoardRow>[] = []
        const placed = columns.flatMap((column) => column.rows.slice(0, limit))
        // A record may have reached this step before the confirmed call whose outcome the row shows.
        const forPlace = (place: typeof placed[number]) => {
          const call = place.miss ?? parties.get(place.outcome?.transactionId ?? '')
          return { subject: place.subject, at: call?.party ? call.at : place.at, call }
        }
        const asks = placed.map(forPlace)
        const creditOf = await creditAll(tx, asks, 90 * DAY, 2, undefined, asks.flatMap(ask => ask.call ?? []))
        const calls = new Map((await tx.callsWith(placed.flatMap((place) => place.call?.id ?? []))).map((call) => [call.id, call]))
        for (const column of columns) {
          const rows: BoardRow[] = []
          for (const place of column.rows.slice(0, limit)) {
            const { call: newest, miss, ...rest } = place
            const ask = forPlace(place)
            const { credited } = creditOf(ask.subject, ask.at, ask.call)
            const call = newest && calls.get(newest.id)
            const language = place.outcome?.tags?.language ?? call?.tags?.language ?? touchTag(credited?.campaignOnly ? undefined : credited, 'language')
            rows.push({ ...rest, ...(call && { call }), ...(credited && { touch: credited }), ...(language !== undefined && { language }) })
          }
          shown.push({ ...column, rows })
        }
        return { at, day, from: dayIn(from, timeZone), columns: shown, unplaced }
      })
    },

    async followed({ from, to, timeZone, at = now(), ...options }) {
      const [start, end] = range(from, to, timeZone)
      if (typeof options.step !== 'string' || !options.step) throw malformed('`step` is required')
      if (!Number.isSafeInteger(options.days) || options.days < 1 || options.days > 365) throw malformed('`days` must be an integer from 1 to 365')
      return store.read(async (tx) => {
        const inPeriod = await leadsOf(tx, (await tx.callsBetween(start, end)).filter((call) => call.direction === 'inbound'), callId)
        // A person is a cluster: whoever rings from two numbers is counted once, and what they did under an account is theirs.
        const labels = await tx.labelsOf(unique(inPeriod.map((call) => call.subject)))
        const clusterOf = (subject: Subject) => labels.get(subject)?.cluster ?? subject
        const everyone = await tx.membersOf(unique([...labels.values()].map((label) => label.component)))
        const subjects = unique([...inPeriod.map((call) => call.subject), ...everyone.keys()])
        const all = await leadsOf(tx, await tx.callsOf(subjects), callId)
        const person = await personWithCalls(tx, all, (subject) => everyone.get(subject)?.cluster ?? clusterOf(subject))
        const group = <T extends { subject: Subject }>(list: readonly T[]) => {
          const out = new Map<Subject, T[]>()
          for (const each of list) out.set(person(each.subject), [...(out.get(person(each.subject)) ?? []), each])
          return out
        }
        const called = group(inPeriod)
        const calls = group(all)
        const reached = group(await leadsOf(tx, (await tx.outcomesOf(subjects)).filter((outcome) => outcome.stage === options.step), outcomeId))
        return followed([...called].map(([who, mine]) => ({ called: mine, calls: calls.get(who) ?? [], reached: (reached.get(who) ?? []).map((outcome) => outcome.at) })), { ...options, at })
      })
    },

    callResult(id) {
      return store.read((tx) => tx.callResultOf(id))
    },

    async spend(input, read) {
      const costs = Array.isArray(input) ? (input as readonly Cost[]) : [input as Cost]
      const rows = costs.map((cost): CostRow => {
        dayStart(cost?.day)
        if (typeof cost.source !== 'string' || !cost.source.trim()) throw malformed('A cost requires a source, such as "google"')
        if (typeof cost.amount !== 'number' || !Number.isFinite(cost.amount) || cost.amount < 0) throw malformed(`The cost of ${cost.day} requires an amount of zero or more`)
        for (const count of [cost.clicks, cost.impressions]) {
          if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw malformed(`The cost of ${cost.day} has a count that is not an integer`)
        }
        for (const claim of [cost.conversions, cost.conversionValue]) {
          if (claim !== undefined && (typeof claim !== 'number' || !Number.isFinite(claim))) throw malformed(`The cost of ${cost.day} has conversions that are not a number`)
        }
        if (cost.conversions !== undefined && cost.conversions < 0) throw malformed(`The cost of ${cost.day} requires conversions of zero or more`)
        if (cost.conversionValue !== undefined && cost.conversions === undefined) throw malformed(`The cost of ${cost.day} has a conversion value and no conversions`)
        const named = [cost.campaignId, cost.campaign, cost.currency].map((text) => {
          if (typeof text === 'object' && text !== null) throw malformed(`The cost of ${cost.day} requires its campaign and currency as strings`)
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
      if (rows.length === 0) return 0
      return store.write(async (tx) => {
        await tx.fed('costs', now())
        return tx.addCosts(rows, read)
      })
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
        const ids = unique([...recorded, ...newest].map(outcomeId).filter((id) => id.startsWith('call:')).map((id) => id.slice(5)))
        const calls = await tx.callsWith(ids)
        const parties = new Map(calls.map((call) => [callId(call), call]))
        const inbound = await tx.missesBetween(start, end)
        const spurned = await tx.notLeads(inbound.map(callId))
        // A call that was counted is an outcome, and is counted once.
        const counted = new Set(recorded.map(outcomeId))
        const uncounted = inbound.filter((call) => (spurned.has(callId(call)) ? !counted.has(callId(call)) : call.result?.answered === false))
        // Each is read for the days it needs: the newest half year can be far from the days asked about.
        const reached = new Map<Subject, Reached>()
        const ofOutcome = await creditAll(tx, recorded, year, hops, reached, calls)
        const ofCall = await creditAll(tx, uncounted, window, hops, reached, uncounted)
        const ofNewest = await creditAll(tx, newest, window, hops, reached, calls)
        const creditOf = (entry: Counted | KeptCall, find = ofOutcome) => {
          const { subject, at } = entry
          const { touches } = find(subject, at, 'transactionId' in entry ? parties.get(entry.transactionId) : entry)
          // An ad outside the window takes nothing from what is inside it.
          const touch = earning(touches.filter((each) => each.at >= at - window)) ?? own(touches)[0]
          const inside = touch !== undefined && touch.at >= at - window
          // A visitor known only through the call supplies a campaign, never tag values or a time from which its arrival could be inferred.
          const reportTouch = touch?.campaignOnly ? { source: sourceOf(touch), ...(touch.campaign && { campaign: touch.campaign }), ...(touch.campaignId && { campaignId: touch.campaignId }) } : touch
          return { touch: inside ? reportTouch : undefined, delay: touch && !touch.campaignOnly ? at - touch.at : undefined, inside, ...(touch?.campaignOnly && paid(touch) && { paidCampaign: true as const }) }
        }
        const person = await personWithCalls(tx, [...calls, ...uncounted], (subject) => labels.get(subject)?.cluster ?? subject)
        const credited: Credited[] = outcomes.map((outcome) => ({ outcome, first: first.get(outcome.transactionId), person: person(outcome.subject), ...creditOf(outcome) }))
        const history: Credited[] = newest.map((outcome) => ({ outcome, ...creditOf(outcome, ofNewest) }))
        // What was no lead is counted apart, where it would have been credited.
        const notLeads: { at: number; touch: Credited['touch']; paidCampaign?: true; tags: Record<string, string> | undefined }[] = []
        const lead = new Set(outcomes)
        for (const outcome of recorded) if (!lead.has(outcome)) notLeads.push({ at: outcome.at, ...creditOf(outcome), tags: outcome.tags })
        const missed: typeof notLeads = []
        for (const call of uncounted) (spurned.has(callId(call)) ? notLeads : missed).push({ at: call.at, ...creditOf(call, ofCall), tags: call.tags })
        return fold(from, to, await tx.costsBetween(from, to), await tx.touchesBetween(start, end), credited, { missed, notLeads, by, per, timeZone, through: dayIn(now(), timeZone), history })
      })
    },

    async ignore(identifier, ignored = true, why) {
      if (typeof identifier !== 'string') throw malformed('ignore requires an identifier')
      if (typeof ignored !== 'boolean') throw malformed('ignore requires true or false')
      keepable(identifier)
      ruleFor(policy, identifier)
      return changing(async (tx) => {
        if (ignored) await current(tx, [identifier], why)
        const states = await tx.states([identifier])
        const before = states.get(identifier)
        // Asked for what already holds, nothing is decided: a server that mutes an address again after a restart adds no entry.
        if ((before?.ignored ?? false) === ignored) return []
        if (ignored && why?.automatic && (await tx.newestNaming([identifier], 0, ['ignore', 'restore']))?.action === 'restore') return []
        await decide(tx, ignored ? 'ignore' : 'restore', [identifier], why)
        await tx.setIgnored(identifier, ignored)
        if (/^(dial:|lease:|text:call:)/.test(identifier)) await recheckCallbacks(tx, (await tx.callEvidence({ identifiers: [identifier] })).map(row => row.subject), true)
        // A fact links nobody, and is weighed wherever the policy keeps people apart by one.
        if (!before || (!isFact(identifier) && !(await withinCaps(tx, [identifier], states)).has(identifier))) return []
        await mark(tx)
        const holders = [...await tx.edgesOn([identifier]), ...await tx.callEvidence({ identifiers: [identifier] })]
        return settle(tx, new Set(holders.map(edge => edge.subject)))
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
        await current(tx, unique(told.flatMap(({ pair }) => pair)), why)
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
        await current(tx, unique(told.flatMap(({ pair }) => pair)), why)
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

    async unjoinAll(pairs, why) {
      const told = tell(pairs, 'join', why)
      const changes = await changing(async (tx) => {
        const subjects = unique(told.flatMap(({ pair }) => pair))
        await current(tx, subjects, why)
        const marks = await marksOf(tx, told.map(({ pair }) => pair))
        const without = told.filter((_, n) => marks[n]!.length === 0)
        if (without.length > 0) {
          const labels = await tx.labelsOf(subjects)
          const found = await pairsTied(tx, without.map(({ pair }) => pair))
          throw refused('A pair was not joined', {
            reason: 'NOT_JOINED',
            pairs: without.map(({ pair: [a, b] }, n) => ({ a, b, because: labels.get(a)?.cluster === undefined || labels.get(a)?.cluster !== labels.get(b)?.cluster ? 'apart' : found[n] ? 'evidence' : 'other_merges' })),
          })
        }
        await decideAll(tx, told.map(({ pair, why }) => ({ action: 'unjoin', about: pair, why })))
        const gone = unique(marks.flat())
        for (const mark of gone) await tx.setIgnored(mark, true)
        await mark(tx)
        return settle(tx, new Set((await tx.edgesOn(gone)).map((edge) => edge.subject)))
      })
      return { changes, recorded: told.length, already: 0 }
    },

    standingOf(pairs) {
      return store.read(async (tx) => {
        const labels = await tx.labelsOf(unique(pairs.flat()))
        const { apart, joined } = await standing(tx, pairs)
        return pairs.map(([a, b]) => ({ together: labels.get(a) !== undefined && labels.get(a)?.cluster === labels.get(b)?.cluster, apart: apart.has(pairKey(a, b)), joined: joined.has(pairKey(a, b)) }))
      })
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
      else throw malformed('foresee requires an action: join, separate or ignore')
      const flag = action === 'separate' ? decision.separated : action === 'ignore' ? decision.ignored : undefined
      if (flag !== undefined && typeof flag !== 'boolean') throw malformed(`foresee ${action} requires true or false`)
      return store.read(async (tx) => {
        let about: Subject[]
        let former: Subject[] = []
        if (action === 'ignore') {
          const id = decision.identifier
          ruleFor(policy, id)
          const states = await tx.states([id])
          const open = isFact(id) || (await withinCaps(tx, [id], states)).has(id) ? [id] : []
          about = unique((await tx.edgesOn(open)).map(edge => edge.subject))
          // A private holder can change the cut. Its id is not a group to show in the preview.
          former = unique((await tx.callEvidence({ identifiers: open })).map(row => row.subject))
        } else about = [decision.a, decision.b]
        const own = await tx.labelsOf(unique([...about, ...former]))
        const stored = await tx.membersOf(unique([...own.values()].map((labels) => labels.component)))
        const subjects = unique([...stored.keys(), ...about])
        const next = await compute(tx, subjects, decision)
        const was = (subject: Subject) => stored.get(subject)?.cluster ?? subject
        const then = (subject: Subject) => next.get(subject)?.cluster ?? subject
        const moved = subjects.filter((subject) => was(subject) !== then(subject))
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
      if (!(Number.isSafeInteger(after) && after >= 0)) throw malformed('`after` must be the number of a change')
      if (!(Number.isSafeInteger(limit) && limit > 0)) throw malformed('`limit` must be a positive integer')
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
        const joined: [Subject, Subject][] = []
        // A pair kept apart is not a link, and one a reviewer's mark joins has been decided, even where a cut keeps it in two clusters. Of two
        // where one speaks for the other, it has been said that they are two.
        for (const [subject, links] of await neighbors(tx, lately)) {
          for (const link of links) {
            if (speaks(link)) {
              two.push([subject, link.subject])
              continue
            }
            if (link.reasons.some((reason) => reason.identifier.startsWith('review:join-'))) {
              // Where births took a telephone or a browser from a record it was joined to, that is for somebody to look at.
              // So is one that is left out because the two it was joined to are not one person by anything.
              if (!(policy.records || policy.apart?.includes('birth')) || (names(subject) && names(link.subject))) continue
              joined.push([subject, link.subject])
            }
            const [a, b] = subject < link.subject ? [subject, link.subject] : [link.subject, subject]
            pairs.set(pairKey(a, b), { a, b, score: link.score, level: link.level, reasons: link.reasons, ...(link.conflict && { conflict: link.conflict }), ...(link.unconfirmed && { unconfirmed: true as const }) })
          }
        }
        const labels = await tx.aroundOf(unique([...[...pairs.values()].flatMap(({ a, b }) => [a, b]), ...two.flat()]))
        // A recent alias can offer an old pair. The speaker mark may be on another member of either candidate's cluster.
        const groups = new Set<Subject>()
        for (const { a, b } of pairs.values()) {
          const one = labels.get(a)!.cluster
          const other = labels.get(b)!.cluster
          if (one !== other) groups.add(one).add(other)
        }
        const recent = new Set(lately)
        const extra = [...labels].filter(([subject, home]) => groups.has(home.cluster) && !recent.has(subject)).map(([subject]) => subject)
        for (let i = 0; i < extra.length; i += TOGETHER) {
          const edges = await tx.edgesOf(extra.slice(i, i + TOGETHER))
          const marked = unique(edges.filter(edge => edge.identifier.startsWith('behalf:')).map(edge => edge.subject))
          if (marked.length) for (const [a, links] of await neighbors(tx, marked)) for (const link of links) {
            if (speaks(link) && labels.has(link.subject)) two.push([a, link.subject])
          }
        }
        const said = new Set(two.map(([a, b]) => pairKey(labels.get(a)!.cluster, labels.get(b)!.cluster)))
        const borders = bordersOf(tx)
        await borders.load(joined.flat(), undefined, joined.flat())
        for (const [a, b] of joined) if (borders.kept(a, b) || (!policy.records && !borders.between(a, b, 'birth'))) pairs.delete(pairKey(a, b))
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
          if (action === 'unjoin') verdicts.delete(pairKey(a, b))
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
      if (typeof subject !== 'string' || !subject) throw malformed('Consent requires a subject')
      if (typeof consent?.adUserData !== 'boolean' || typeof consent.adPersonalization !== 'boolean') {
        throw malformed('Consent requires adUserData and adPersonalization, each true or false')
      }
      const recorded = now()
      const { at = recorded, source, key } = given
      if (!Number.isSafeInteger(at) || at < 0) throw malformed('Consent requires `at`, an integer in epoch milliseconds')
      // An answer dated ahead would stand over every real one until that day came.
      if (at > recorded + DAY) throw malformed('Consent cannot be dated in the future')
      if (source !== undefined && (typeof source !== 'string' || source.length > 200)) throw malformed('Consent `source` must be a string of at most 200 characters')
      keepable(subject, source, key)
      return store.write(async (tx) => {
        await tx.addConsent(subject, { at, adUserData: consent.adUserData, adPersonalization: consent.adPersonalization, ...(source && { source }), ...(key && { key }), recorded })
        const [first] = await tx.consentHistory(subject, 1)
        return { stands: first?.at === at && first.recorded === recorded && (key === undefined || first.key === key) }
      })
    },

    consentOf(subjects) {
      return store.read((tx) => tx.consentOf(subjects))
    },

    consentHistory(subject, limit) {
      return store.read((tx) => tx.consentHistory(subject, limit))
    },

    async transfer(flow) {
      const { id, from, to, amount, at, asset = '' } = flow
      if (typeof id !== 'string' || !id.trim() || id.length > 200) throw malformed('A flow requires an id of its own, as a string of at most 200 characters')
      if (typeof from !== 'string' || typeof to !== 'string' || !from || !to || from === to) throw malformed('A flow requires two different subjects')
      if (!Number.isSafeInteger(amount) || amount <= 0) throw malformed('A flow requires `amount`, a positive integer in the smallest unit')
      if (!Number.isSafeInteger(at)) throw malformed('A flow requires `at`, an integer in epoch milliseconds')
      if (typeof asset !== 'string') throw malformed('A flow requires its asset as a string')
      if ([id, from, to, asset].some((text) => UNSTORABLE.test(text))) throw malformed('A flow contains unsupported characters')
      return store.write(async (tx) => {
        const before = await tx.flowOf(id)
        if (before && !(before.from === from && before.to === to && before.amount === amount && before.at === at && before.asset === asset)) {
          throw refused(`Flow "${id}" was already recorded with different details`, { reason: 'KEY_REUSED', fields: [] })
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

    async forget(subject, why, gone, only) {
      const subjects = typeof subject === 'string' ? [subject] : Array.isArray(subject) ? unique<Subject>(subject) : []
      if (subjects.length === 0 || subjects.some((each) => typeof each !== 'string')) throw malformed('forget requires a subject')
      keepable(...subjects)
      let jobs: Job[] = []
      const changes = await changing(async (tx) => {
        await current(tx, subjects, why)
        jobs = []
        // Other workers may already have a cached report about this person, even before a party was named.
        await tx.setSetting('callParty', randomUUID())
        const erased = await tx.keysOf(subjects, only)
        // An alert can name a call or an outcome. A party statement key is never part of its payload.
        const keys = erased.filter(({ type, key }) => type !== 'call_update' && key.length > 3).map(({ key }) => key)
        if (!only) for (const each of subjects) await decideAll(tx, [{ action: 'forget', about: [each], why }])
        const calls = erased.filter(key => key.type === 'call').map(key => key.key)
        const removed = [...await tx.callEvidence({ calls }), ...(only ? [] : await tx.callEvidence({ subjects }))]
        const edges = [...(only ? [] : await tx.edgesOf(subjects)), ...removed]
        const components = unique([...(await tx.labelsOf(unique([...subjects, ...removed.map(row => row.subject)]))).values()].flatMap(({ component }) => (component === undefined ? [] : [component])))
        const affected = new Set((await tx.membersOf(components)).keys())
        await mark(tx)
        for (const each of subjects) {
          jobs.push(...(await tx.removeSubject(each, only)))
          if (!only) affected.delete(each)
        }
        // Losing a subject can bring an identifier back under its cap, which links the rest again.
        const identifiers = unique(edges.map((edge) => edge.identifier))
        const states = await tx.states(identifiers)
        const open = [...await withinCaps(tx, identifiers, states)].filter(id => !states.get(id)!.ignored)
        for (const edge of await tx.edgesOn(open)) affected.add(edge.subject)
        const moved = await settle(tx, affected)
        await recheckCallbacks(tx, [...affected])
        // Last: what moved is said of the groups they were in, and those may have had their names.
        await tx.unname(only ? [] : subjects, keys)
        return moved
      })
      gone?.(jobs)
      return changes
    },

    async journey(subject, { before = Number.MAX_SAFE_INTEGER, limit = 200, deliveries = false } = {}) {
      if (!(Number.isInteger(limit) && limit > 0)) throw malformed('limit must be a positive integer')
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
        // A call or a text names the browser it was tied to, where that is this person's.
        const theirOwn = new Set(everyone)
        const namingOwn = <T extends { visitor?: Subject }>(each: T): T => {
          if (each.visitor === undefined || theirOwn.has(each.visitor)) return each
          const { visitor: _, ...rest } = each
          return rest as T
        }
        const recorded = await tx.callsOf(people)
        // A guessed link may still put two records in one cluster. A staff statement is for the exact record it names.
        const visible = (call: KeptCall) => !call.party || ((call.party.role === 'self' || call.party.role === 'representative') && call.party.subject === subject)
        const hidden = new Set(recorded.filter((call) => !visible(call)).map(callId))
        const calls = recorded.filter(visible).map(namingOwn)
        const outcomes = (await tx.outcomesOf(people)).filter((outcome) => !hidden.has(outcome.transactionId))
        const not = await tx.notLeads([...calls.map(callId), ...outcomes.map(outcomeId)])
        const spurned = (id: string) => (not.has(id) ? { notLead: not.get(id)!.kind } : {})
        for (const call of calls) entries.push({ at: call.at, subject: call.subject, kind: 'call', call, ...spurned(callId(call)), ...(call.direction === 'inbound' && call.result?.answered === false && { followUp: followUp(call, calls.filter((each) => !not.has(callId(each)))) }) })
        for (const link of await tx.linksSent(people)) entries.push({ at: link.at, subject: link.subject, kind: 'link', link })
        const texts = (await tx.textsOf(people)).map(namingOwn)
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
        // Delivery state belongs beside the ownership that was current when this journey was read.
        const shown = deliveries ? await Promise.all(page.map(async entry => {
          if (entry.kind !== 'outcome') return entry
          const jobs = await tx.outbox.get(entry.outcome.transactionId)
          return { ...entry, sent: jobs.map(({ target, state, note, value }) => ({ target, state, ...(note && { note }), ...(value !== undefined && { value }) })) }
        })) : page
        return {
          subject,
          subjects: Object.fromEntries(unique(page.map((entry) => entry.subject)).map((each) => [each, tie(each)])),
          entries: shown,
          next: cut > 0 ? page[0]!.at : null,
          more: everyone.length - people.length,
        }
      })
    },

    history(subject, limit) {
      return store.read((tx) => tx.history(subject, limit))
    },

    subjectDates(subjects) {
      return store.read((tx) => tx.subjectDates(subjects))
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
        if (changes.length) await recheckCallbacks(tx, [...(await tx.aroundOf(changes.map(change => change.subject))).keys()], true)
        return changes
      })
    },

    async prune(before, why) {
      if (!Number.isSafeInteger(before)) throw malformed('prune requires `before`, an integer in epoch milliseconds')
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
      const copy = createMemoryStore()
      const past = graphOn(copy, policy, { now: () => at })
      const decisions = await store.read(async (tx) => {
        // Copy the stored evidence exactly. Repeating a legacy name as a fresh observation would vouch for a spelling nobody checked.
        const withdrawn = await tx.callEvidence({ before: at })
        if (withdrawn.length) await copy.write(tx => tx.reserveCall(withdrawn))
        let batch: Sighting[] = []
        for await (const sightings of tx.sightingsUntil(at)) {
          for (const { subject, identifier, at: seen, event } of sightings) {
            batch.push({ subject, identifier, at: seen, recorded: at, ...(event !== undefined && { event }) })
            if (batch.length < 1000) continue
            await copy.write((tx) => past.record(tx, batch))
            batch = []
          }
        }
        if (batch.length > 0) await copy.write((tx) => past.record(tx, batch))
        return (await tx.decisions()).filter((decision) => decision.at <= at)
      })
      for (const { action, about } of decisions) {
        if (action === 'ignore' || action === 'restore') await past.graph.ignore(about[0]!, action === 'ignore')
        if (action === 'separate' || action === 'rejoin') await past.graph.separate(about[0]!, about[1]!, action === 'separate')
      }
      return past.graph
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
  return { graph, record }
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
