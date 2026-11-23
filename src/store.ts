import type { OutboxStore } from './outbox.ts'
import type { Change, Consent, Counts, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, Labels, Moved, Sighting, Subject, Touch } from './types.ts'

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

export interface Tx {
  /** Logs sightings and folds them into edges. Returns how many new edges each identifier gained. */
  addSightings(sightings: readonly Sighting[]): Promise<Map<Identifier, number>>
  /** Deletes a subject with its sightings, edges, touches, flows, consent, and reviewer decisions. */
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
  /** Records the latest consent a subject gave. */
  setConsent(subject: Subject, consent: Consent): Promise<void>
  /** The latest consent of each given subject. A subject that never answered is absent. */
  consentOf(subjects: readonly Subject[]): Promise<Map<Subject, Consent>>
  addTouch(touch: Touch): Promise<void>
  /** Touches on the given subjects with `from <= at <= to`. */
  touchesOf(subjects: readonly Subject[], from: number, to: number): Promise<Touch[]>
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
}
