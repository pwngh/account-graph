import type { Feed, OpsStore } from './ops.ts'
import type { OutboxStore } from './outbox.ts'
import type { CallResult, Change, Consent, ConsentAnswer, Cost, Counted, Counts, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, KeptCall, Labels, Lease, Moved, NotLead, OutcomeValue, Sighting, Subject, Touch } from './types.ts'

/**
 * Where the graph lives. Sightings and touches are the record; edges and
 * fanouts fold the sightings; components and clusters are derived and can
 * always be rebuilt.
 */
export interface Store {
  /** Runs `work` alone: no other write overlaps it, and it commits whole or not at all. */
  write<T>(work: (tx: Tx) => Promise<T>): Promise<T>
  /** Runs `work` against one consistent snapshot. */
  read<T>(work: (tx: Tx) => Promise<T>): Promise<T>
  /** Conversions waiting to be sent. */
  outbox: OutboxStore
  /** When each feed last wrote something, how jobs ran, and alerts for people. */
  ops: OpsStore
}

export interface DecisionPage {
  /** Only decisions with a smaller sequence number. */
  before?: number
  limit: number
  /** `people` and `system` split on the author's name starting with `system:`. Anything else is one author's name. */
  author?: string
}

export interface Tx {
  /** Logs sightings and folds them into edges. Returns how many new edges each identifier gained. */
  addSightings(sightings: readonly Sighting[]): Promise<Map<Identifier, number>>
  /** Deletes a subject with its sightings, edges, touches, outcomes, calls, leases, flows, consent, alerts, conversions, and reviewer decisions. */
  removeSubject(subject: Subject): Promise<void>
  edgesOf(subjects: readonly Subject[]): Promise<Edge[]>
  edgesOn(identifiers: readonly Identifier[]): Promise<Edge[]>
  /**
   * What every two subjects share, a pair at a time and in batches, so a graph larger than memory can be read. Only
   * identifiers that can link: not muted, and held by no more than their kind's cap. A pair that shares one identifier,
   * of a kind not in `alone`, may be left out. Throws where an identifier that could link has a kind `caps` does not name.
   */
  sharing(caps: Readonly<Record<string, number>>, alone: readonly string[]): AsyncIterable<{ a: Edge; b: Edge; fanout: number }[][]>
  /** Every subject, in batches: where it sits, and whether it holds any identifier. */
  everyone(): AsyncIterable<{ subject: Subject; labels: Labels | undefined; held: boolean }[]>
  states(identifiers: readonly Identifier[]): Promise<Map<Identifier, IdentifierState>>
  setIgnored(identifier: Identifier, ignored: boolean): Promise<void>
  /** Where each given subject sits. Unknown subjects are absent. */
  labelsOf(subjects: readonly Subject[]): Promise<Map<Subject, Labels>>
  /** Every member of the given components. */
  membersOf(components: readonly Subject[]): Promise<Map<Subject, Labels>>
  /** The members of one cluster. */
  clusterOf(cluster: Subject): Promise<Subject[]>
  /** A number that is different after every write: the same number means nothing has changed. */
  version(): Promise<number>
  /** How much the graph holds. */
  counts(): Promise<Counts>
  /** The clusters with two or more members, largest first, skipping the first `offset`. */
  largestClusters(limit: number, offset?: number): Promise<{ id: Subject; size: number }[]>
  /** The subjects of that many of the sightings written down last, each once, in no order. Of those written down at one time, by subject. */
  latelySeen(sightings: number): Promise<Subject[]>
  /** Subjects whose id starts with the text, in order. */
  subjectsStarting(text: string, limit: number): Promise<Subject[]>
  /** Writes down cluster changes as they happen. */
  addChanges(at: number, changes: readonly Change[]): Promise<void>
  /** The newest cluster changes, newest first. */
  recentChanges(limit: number): Promise<Moved[]>
  /** Notes that a feed wrote something down at a time. */
  fed(feed: Feed, at: number): Promise<void>
  /** Whether no subject has been recorded. */
  empty(): Promise<boolean>
  /** Which policy the stored clusters were built with, by its hash. */
  builtWith(): Promise<string | undefined>
  setBuiltWith(hash: string): Promise<void>
  /** Every kind some stored identifier has. Reads every identifier. */
  kinds(): Promise<string[]>
  setLabels(labels: ReadonlyMap<Subject, Labels>): Promise<void>
  /** Records, or with `false` withdraws, a reviewer's decision that two subjects are different people. */
  setSeparated(a: Subject, b: Subject, separated: boolean): Promise<void>
  /** Every separated pair with at least one end among the given subjects. */
  separatedOf(subjects: readonly Subject[]): Promise<[Subject, Subject][]>
  /** Keeps one flow of value under its id, and folds it into the running totals between its two subjects. */
  addFlow(flow: Required<Flow>): Promise<void>
  flowOf(id: string): Promise<Required<Flow> | undefined>
  /** Every folded flow into or out of the given subjects. */
  flowsOf(subjects: readonly Subject[]): Promise<FlowEdge[]>
  /** Adds one answer about advertising to a subject's history. */
  addConsent(subject: Subject, answer: ConsentAnswer): Promise<void>
  /** The standing answer of each given subject, the one `standingFirst` puts first. A subject that never answered is absent. */
  consentOf(subjects: readonly Subject[]): Promise<Map<Subject, Consent>>
  /** Every answer of a subject, the standing one first. With `limit`, only that many. */
  consentHistory(subject: Subject, limit?: number): Promise<ConsentAnswer[]>
  /** Deletes answers written down before a time, except each subject's standing one. Returns how many went. */
  pruneConsent(before: number): Promise<number>
  addTouch(touch: Touch): Promise<void>
  /** Touches on the given subjects with `from <= at <= to`. */
  touchesOf(subjects: readonly Subject[], from: number, to: number): Promise<Touch[]>
  /** The subjects with a touch that carries this ad click id, whole, in order. */
  clicked(id: string, limit: number): Promise<Subject[]>
  /** Every touch with `from <= at < to`, whoever it belongs to. */
  touchesBetween(from: number, to: number): Promise<Touch[]>
  /** Records an outcome for the report, replacing one with the same id. */
  setOutcome(outcome: Counted): Promise<void>
  outcomeOf(transactionId: string): Promise<Counted | undefined>
  /** Adds a value to the history of an outcome. */
  addValue(transactionId: string, subject: Subject, value: OutcomeValue): Promise<void>
  /** Every value an outcome of a subject has had, oldest first. An id used again for someone else has a history of its own. */
  valuesOf(transactionId: string, subject: Subject): Promise<OutcomeValue[]>
  /** The first value of each given outcome, by its id, the most it was ever worth, and how much of it was refunded and written off, and in which currencies. */
  firstValues(outcomes: readonly Counted[]): Promise<Map<string, OutcomeValue & { most: number; refunded: number; writtenOff: number; lostIn: string[] }>>
  /** Takes an outcome out of the report. Its values stay in its history. */
  removeOutcome(transactionId: string): Promise<void>
  /** Which of these outcomes, by transaction id, were said to be no lead. A call is `call:` and its id. */
  notLeads(ids: readonly string[]): Promise<Map<string, NotLead>>
  /** Says an outcome is no lead, or with undefined takes that back. The outcome may not be recorded yet. */
  setNotLead(id: string, said: NotLead | undefined): Promise<void>
  /** Deletes what was said before a time about outcomes and calls that never came. Returns how many went. */
  pruneNotLeads(before: number): Promise<number>
  /** Keeps a call, replacing one with the same id. Its result is kept apart, and may arrive first. */
  setCall(call: Omit<KeptCall, 'result'>): Promise<void>
  setCallResult(id: string, result: CallResult): Promise<void>
  removeCallResult(id: string): Promise<void>
  /** A call with its result, or undefined for an id no call was kept for. */
  callOf(id: string): Promise<KeptCall | undefined>
  /** A result, whether or not its call was kept. */
  callResultOf(id: string): Promise<CallResult | undefined>
  /** Every call to or from the given subjects, oldest first. */
  callsOf(subjects: readonly Subject[]): Promise<KeptCall[]>
  /**
   * Missed calls with `from <= at < to` that nobody has spoken to the caller
   * since, oldest first. With `after`, only those past that call.
   */
  openCalls(from: number, to: number, limit: number, after?: { at: number; id: string }): Promise<KeptCall[]>
  /** Calls with `from <= at < to`, oldest first. */
  callsBetween(from: number, to: number): Promise<KeptCall[]>
  /** The newest lease of each given number that began by a time. A number never leased by then is absent. */
  newestLeases(numbers: readonly string[], by: number): Promise<Lease[]>
  /** Keeps a lease, replacing the one of the same number that began at the same time. */
  setLease(lease: Lease): Promise<void>
  /** Deletes leases that ended before a time. Returns how many went. */
  pruneLeases(before: number): Promise<number>
  /** Deletes results written down before a time whose call never came. Returns how many went. */
  pruneCallResults(before: number): Promise<number>
  /** Outcomes with `from <= at < to`, oldest first. */
  outcomesBetween(from: number, to: number): Promise<Counted[]>
  /** Every outcome of the given subjects, oldest first. */
  outcomesOf(subjects: readonly Subject[]): Promise<Counted[]>
  /** The newest outcomes of each step with `from <= at < to`, at most `each` of one step. */
  newestOutcomes(from: number, to: number, each: number): Promise<Counted[]>
  /** Records what campaigns cost, replacing any row with the same day, source and campaign. */
  addCosts(costs: readonly Required<Cost>[]): Promise<void>
  /** Costs with `from <= day <= to`, days written `YYYY-MM-DD`. */
  costsBetween(from: string, to: string): Promise<Required<Cost>[]>
  /** Sightings of a subject, oldest first. With `limit`, only the newest that many. */
  history(subject: Subject, limit?: number): Promise<Sighting[]>
  /** Every sighting written down at or before a time, for replaying what was known then. */
  sightingsUntil(recorded: number): AsyncIterable<Sighting[]>
  /** Deletes sightings written down before a time. Edges keep what they folded. Returns how many went. */
  pruneSightings(before: number): Promise<number>
  /** Appends to the record of decisions. */
  addDecision(decision: Decision): Promise<void>
  lastDecision(): Promise<Decision | undefined>
  /** The newest decision after a sequence number that names any of the given subjects or identifiers. A prune names none. */
  newestNaming(names: readonly string[], after: number, among?: readonly Decision['action'][]): Promise<Decision | undefined>
  /** Every decision, oldest first. */
  decisions(): Promise<Decision[]>
  /** One page of decisions, newest first: those before a sequence number, by people, by systems, or by one author. */
  decisionPage(page: DecisionPage): Promise<Decision[]>
  /** Every decision that names one of the given subjects, oldest first. Reads every decision. */
  decisionsNaming(subjects: readonly Subject[]): Promise<Decision[]>
  /** Every decision that joined, separated or rejoined one of the given pairs, oldest first. Each pair is in order. */
  decisionsAbout(pairs: readonly (readonly [Subject, Subject])[]): Promise<Decision[]>
  /** The pairs that systems have decided about this many times or more. */
  pairsDecidedBySystems(times: number): Promise<[Subject, Subject][]>
}

/**
 * Puts the standing answer first: the newest by when it was given, then by
 * when it was written down. Two that tie on both stand as the refusal, so
 * the answer never depends on the order they arrived in.
 */
export function standingFirst(x: ConsentAnswer, y: ConsentAnswer): number {
  return y.at - x.at || y.recorded - x.recorded || Number(x.adUserData) - Number(y.adUserData) || Number(x.adPersonalization) - Number(y.adPersonalization)
}
