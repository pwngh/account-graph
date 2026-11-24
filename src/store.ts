import type { OutboxStore } from './outbox.ts'
import type { Change, Consent, ConsentAnswer, Cost, Counted, Counts, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, Labels, Moved, Sighting, Subject, Touch } from './types.ts'

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
  /** Deletes a subject with its sightings, edges, touches, outcomes, flows, consent, and reviewer decisions. */
  removeSubject(subject: Subject): Promise<void>
  edgesOf(subjects: readonly Subject[]): Promise<Edge[]>
  edgesOn(identifiers: readonly Identifier[]): Promise<Edge[]>
  allEdges(): Promise<Edge[]>
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
  /** Subjects whose id starts with the text, in order. */
  subjectsStarting(text: string, limit: number): Promise<Subject[]>
  /** Writes down cluster changes as they happen. */
  addChanges(at: number, changes: readonly Change[]): Promise<void>
  /** The newest cluster changes, newest first. */
  recentChanges(limit: number): Promise<Moved[]>
  /** Whether no subject has been recorded. */
  empty(): Promise<boolean>
  /** Which policy the stored clusters were built with, by its hash. */
  builtWith(): Promise<string | undefined>
  setBuiltWith(hash: string): Promise<void>
  /** Every kind some stored identifier has. Reads every identifier. */
  kinds(): Promise<string[]>
  allLabels(): Promise<Map<Subject, Labels>>
  setLabels(labels: ReadonlyMap<Subject, Labels>): Promise<void>
  /** Records, or with `false` withdraws, a reviewer's decision that two subjects are different people. */
  setSeparated(a: Subject, b: Subject, separated: boolean): Promise<void>
  /** Every separated pair with at least one end among the given subjects. */
  separatedOf(subjects: readonly Subject[]): Promise<[Subject, Subject][]>
  /** Folds one flow of value into the running totals between its two subjects. */
  addFlow(flow: Required<Flow>): Promise<void>
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
  /** Every touch with `from <= at < to`, whoever it belongs to. */
  touchesBetween(from: number, to: number): Promise<Touch[]>
  /** Records an outcome for the report, replacing one with the same id. */
  setOutcome(outcome: Counted): Promise<void>
  outcomeOf(transactionId: string): Promise<Counted | undefined>
  /** Outcomes with `from <= at < to`, oldest first. */
  outcomesBetween(from: number, to: number): Promise<Counted[]>
  /** Records what campaigns cost, replacing any row with the same day, source and campaign. */
  addCosts(costs: readonly Required<Cost>[]): Promise<void>
  /** Costs with `from <= day <= to`, days written `YYYY-MM-DD`. */
  costsBetween(from: string, to: string): Promise<Required<Cost>[]>
  /** Sightings of a subject, oldest first. With `limit`, only the newest that many. */
  history(subject: Subject, limit?: number): Promise<Sighting[]>
  /** Every sighting written down at or before a time, for replaying what was known then. */
  sightingsUntil(recorded: number): Promise<Sighting[]>
  /** Deletes sightings written down before a time. Edges keep what they folded. Returns how many went. */
  pruneSightings(before: number): Promise<number>
  /** Appends to the record of decisions. */
  addDecision(decision: Decision): Promise<void>
  lastDecision(): Promise<Decision | undefined>
  /** Every decision, oldest first. */
  decisions(): Promise<Decision[]>
  /** One page of decisions, newest first: those before a sequence number, by people, by systems, or by one author. */
  decisionPage(page: DecisionPage): Promise<Decision[]>
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
