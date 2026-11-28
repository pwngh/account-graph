import type { Feed, KeptAlert, OpsStore } from './ops.ts'
import type { GraphEvent } from '../contract/api.ts'
import type { Delivery, EventHead, NewEvent } from './events.ts'
import type { Receipt } from './receipts.ts'
import type { Said, SaidOf, Topic } from './said.ts'
import type { Details } from './details.ts'
import { byKey } from './said.ts'
import type { Job, OutboxStore } from './outbox.ts'
import type { CallResult, CallTime, Change, Consent, ConsentAnswer, CostRow, Counted, Counts, Decision, Edge, Flow, FlowEdge, Identifier, IdentifierState, KeptCall, KeptText, KeptWords, Labels, Lease, Moved, NotLead, NumberedChange, SentLink, OutcomeValue, Payment, Sighting, Subject, Touch } from '../contract/types.ts'

export type AddedSightings = Map<Identifier, number> & { restored?: Set<Subject> }

export interface TextNumber {
  subject: Subject
  line: Subject
  active: boolean
  first?: number
  held?: { at: number; key: string; held: boolean }[]
  uncertain?: { first: number; last: number }
  stop?: number
  stopKey?: string
  through?: { at: number; key: string }
}

export interface TextStop {
  subject: Subject
  line: Subject
  at: number
  key: string
  through?: { at: number; key: string }
}

export interface CallEvidence {
  call: string
  subject: Subject
  identifier: Identifier
  at: number
  recorded: number
}

export type CallLineKind = 'phone' | 'voip' | 'none'

export interface SubjectDates {
  firstSeen?: number
  createdAt?: number
}

/**
 * Where the graph lives. Sightings and touches are the record; edges and
 * fanouts fold the sightings; components and clusters are derived and can
 * always be rebuilt.
 */
export interface Store {
  /** Runs `work` alone. No other write overlaps it, and it commits whole or not at all. */
  write<T>(work: (tx: Tx) => Promise<T>, options?: WriteOptions): Promise<T>
  /** Runs `work` against one consistent snapshot. */
  read<T>(work: (tx: Tx) => Promise<T>): Promise<T>
  /** Conversions waiting to be sent. */
  outbox: OutboxStore
  /** When each feed last wrote something, how jobs ran, and alerts for people. */
  ops: OpsStore
}

// Immutable input rows for a new store. Keys are unique within each batch.
export interface ActivityRows {
  touches: { touch: Touch; call: string | undefined }[]
  outcomes: Counted[]
  values: { transactionId: string; subject: Subject; value: OutcomeValue }[]
  calls: { call: Omit<KeptCall, 'result'>; lineKind: CallLineKind | undefined }[]
  results: [string, CallResult][]
  decisions: Decision[]
  /** What is said of records themselves, as it stands. */
  details?: { subject: Subject; field: string; value: string; at: number; key: string }[]
  /** A number or an email beside its hash, for identifiers already written and held. */
  shown?: { identifier: Identifier; value: string }[]
}

export interface WriteOptions {
  /** Several writes are made in this one, so what a failed one left must go with it. A store that cannot undo a write otherwise must here. */
  whole?: boolean
}

export interface DecisionPage {
  /** Only decisions with a smaller sequence number. */
  before?: number
  limit: number
  /** `people` and `system` split on the author's name starting with `system:`. Anything else is one author's name. */
  author?: string
}

export interface Tx {
  /** Loads visits, calls, outcomes and their history together into a new store. */
  insertActivity(rows: ActivityRows): Promise<void>
  /** The jobs of conversions, written and read in this transaction. */
  outbox: OutboxStore
  /** Runs `work` as a write inside this one. Where it throws, what it wrote is gone and the rest stands. */
  nested<T>(work: () => Promise<T>): Promise<T>
  /** Logs sightings and folds them into edges. Returns how many new edges each identifier gained. */
  addSightings(sightings: readonly Sighting[]): Promise<AddedSightings>
  /** Records a withdrawal and returns every identifier whose active holders changed, including dependent name keys. */
  withdrawFact(subject: Subject, identifiers: readonly Identifier[], at: number, key: string, recorded: number, decision?: number): Promise<Identifier[]>
  factHistory(before: number): Promise<{ subject: Subject; identifiers: Identifier[]; at: number; key: string; decision?: number }[]>
  factWithdrawn(subject: Subject, identifiers: readonly Identifier[], at: number, key: string): Promise<boolean>
  /** Deletes a subject with its sightings, edges, touches, outcomes, calls, leases, flows, consent, alerts, conversions, and reviewer decisions. */
  removeSubject(subject: Subject, only?: readonly string[]): Promise<Job[]>
  /** A removed call sighting counts its holder and bounds which cuts can change, but gives no positive evidence. */
  callEvidence(filter?: { subjects?: readonly Subject[]; identifiers?: readonly Identifier[]; calls?: readonly string[]; before?: number }): Promise<CallEvidence[]>
  hasCallEvidence(): Promise<boolean>
  /** Private original lines and route flags used only to decide whether two calls competed for a tap or a number. */
  rivalCalls(number: string, first: number, last: number, line?: Subject): Promise<KeptCall[]>
  reserveCall(rows: readonly CallEvidence[]): Promise<void>
  /** Remembers which original code won when the public call already has a party. */
  markPartyCode(id: string, visitor?: Subject): Promise<void>
  /** The visitor previously tied by this call, kept privately for its credit. */
  callVisitors(ids: readonly string[]): Promise<Map<string, Subject>>
  /** Active edges and whether a withdrawn edge touches any of these subjects or identifiers. */
  matchingEdges(subjects: readonly Subject[]): Promise<{ active: Edge[]; reserved: boolean }>
  /** Dates of the exact subjects, where there is a direct observation or a creation statement. */
  subjectDates(subjects: readonly Subject[]): Promise<Map<Subject, SubjectDates>>
  /** Keeps the newest creation statement by time and then key. */
  setCreatedAt(subject: Subject, createdAt: number, at: number, key: string): Promise<boolean>
  createdAtStands(subject: Subject, createdAt: number, at: number, key: string): Promise<boolean>
  /** Keeps what is said of a record itself, as given: its name, date of birth and address. Of each field, the newest by time and then key stands. */
  setDetails(subject: Subject, details: Details, at: number, key: string): Promise<void>
  /** Keeps a phone number or an email beside its hash, for people to read. Only an identifier this subject holds takes one, and it goes when the last holder does. */
  setShown(subject: Subject, shown: ReadonlyMap<Identifier, string>): Promise<void>
  /** Keeps what somebody wrote, as a copy to read back. The first kept under an entry's key stands. `author` is whoever spoke for the subject, and their words go when either is forgotten. */
  keepWords(words: KeptWords & { recorded: number; author?: Subject }): Promise<void>
  /** What these exact subjects wrote and was recorded since a time, the newest first. */
  wordsOf(subjects: readonly Subject[], limit: number, since: number): Promise<KeptWords[]>
  /** Deletes what was recorded before a time. Answers how many. */
  pruneWords(before: number): Promise<number>
  /** Every number and email kept for each of these exact subjects to read, with when the subject was last seen with it. Newest first. */
  contactsOf(subjects: readonly Subject[]): Promise<Map<Subject, { field: 'phone' | 'email'; value: string; last: number }[]>>
  /** Records whose kept name contains this text, whatever the case, in ID order. Each store folds case by its own rules, which differ for a few letters outside ASCII. */
  namedLike(text: string, limit: number): Promise<Subject[]>
  /** What is kept of each of these exact subjects that has any: its name, and of the numbers and emails kept for it to read, the one it was seen with last. */
  detailsOf(subjects: readonly Subject[]): Promise<Map<Subject, Details>>
  /** Which lines can speak about texts for these subjects, including an earlier STOP from a withdrawn line. */
  textNumbers(subjects: readonly Subject[]): Promise<TextNumber[]>
  /** Both visible and withdrawn edges can establish who shared a phone before a withdrawal. */
  phoneHoldersBefore(identifiers: readonly Identifier[], at: number): Promise<Edge[]>
  keepTextStops(rows: readonly TextStop[]): Promise<void>
  edgesOf(subjects: readonly Subject[]): Promise<Edge[]>
  edgesOn(identifiers: readonly Identifier[]): Promise<Edge[]>
  /**
   * What every two subjects share, a pair at a time and in batches, so a graph larger than memory can be read. Only
   * identifiers that can link: not muted, and held by no more than their kind's cap. A pair that shares one identifier,
   * of a kind not in `alone`, may be left out. Throws where an identifier that could link has a kind `caps` does not name.
   */
  sharing(caps: Readonly<Record<string, number>>, alone: readonly string[]): AsyncIterable<{ a: Edge; b: Edge; fanout: number; people?: number }[][]>
  /** Every subject, in batches: where it sits, and whether it holds any identifier. */
  everyone(): AsyncIterable<{ subject: Subject; labels: Labels | undefined; held: boolean }[]>
  states(identifiers: readonly Identifier[]): Promise<Map<Identifier, IdentifierState>>
  /** The identifiers of these subjects that somebody else holds too, not muted, which is all that could link them. */
  shared(subjects: readonly Subject[]): Promise<Map<Identifier, IdentifierState>>
  setIgnored(identifier: Identifier, ignored: boolean): Promise<void>
  /** Where each given subject sits. Unknown subjects are absent. */
  labelsOf(subjects: readonly Subject[]): Promise<Map<Subject, Labels>>
  /** Every member of the given components. */
  membersOf(components: readonly Subject[]): Promise<Map<Subject, Labels>>
  /** The members of one cluster. */
  clusterOf(cluster: Subject): Promise<Subject[]>
  /** A number that is different after every write. The same number means nothing has changed. */
  version(): Promise<number>
  /** How much the graph holds. */
  counts(): Promise<Counts>
  /** The clusters with two or more members, largest first, skipping the first `offset`. */
  largestClusters(limit: number, offset?: number): Promise<{ id: Subject; size: number }[]>
  /** The subjects of that many of the sightings written down last, each once, in no order. Of those written down at one time, by subject. */
  latelySeen(sightings: number): Promise<{ subjects: Subject[]; count: number; oldest: number | null; older: boolean }>
  /** A review sweep may resume inside the last subject when only some of its pairs fit on the page. */
  subjectPage(after: Subject | null, inclusive: boolean, limit: number): Promise<Subject[]>
  /** Subjects whose id starts with the text, in order. */
  subjectsStarting(text: string, limit: number): Promise<Subject[]>
  /** Writes down cluster changes as they happen. */
  addChanges(at: number, changes: readonly Change[]): Promise<void>
  /**
   * Numbers events and keeps them. The number comes from a row that is held until the write commits, so no higher number
   * is seen before a lower one. Call it last, because that row is held from here on. Resolves to how many were new.
   */
  emit(events: readonly NewEvent[]): Promise<number>
  /** Keeps an alert with the event it names. A fresh failure batch may reopen the same message. */
  addAlert(alert: KeptAlert, again?: boolean, calls?: readonly string[]): Promise<boolean>
  pendingAlert: OpsStore['pendingAlert']
  /** Private sources of callback notices whose credited paths touched these subjects. */
  callbacksThrough(sources: readonly string[]): Promise<Map<string, readonly string[]>>
  dropCallbacks(keys: readonly string[]): Promise<void>
  eventHead(): Promise<EventHead>
  eventsAfter(seq: number, limit: number): Promise<GraphEvent[]>
  /** Begins another history, as after a restored backup. Every cursor is lost. */
  newEpoch(): Promise<string>
  pruneEvents(before: number): Promise<number>
  pruneReceipts(before: number): Promise<number>
  /** Takes the turn to deliver to a receiver, for as long as the lease. Undefined while another has it or it is not due. */
  claimDelivery(sink: string, now: number, lease: number): Promise<Delivery | undefined>
  setDelivery(delivery: Delivery): Promise<void>
  /** The newest cluster changes, newest first. */
  recentChanges(limit: number): Promise<Moved[]>
  /** Cluster changes numbered above `seq`, oldest first. */
  changesAfter(seq: number, limit: number): Promise<NumberedChange[]>
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
  /** The call whose number supplied this arrival, an empty string for another source, or absent for an older row. */
  addTouch(touch: Touch, call?: string): Promise<void>
  /** A confirmation removes every indistinguishable old arrival if the call predates source tracking. */
  dropTouch(subject: Subject, at: number, landing: string, call: string, confirmed?: boolean): Promise<void>
  /** Touches on the given subjects with `from <= at <= to`. */
  touchesOf(subjects: readonly Subject[], from: number, to: number): Promise<Touch[]>
  /** Which calls supplied this number-channel visit. Older visits may have several possible sources. */
  callsBehind(touch: Touch): Promise<string[]>
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
  setCall(call: Omit<KeptCall, 'result'>, lineKind?: CallLineKind, pendingParty?: boolean): Promise<void>
  /** The physical line of a recorded call, for deleting either side of a staff confirmation. */
  callLine(id: string): Promise<Subject | undefined>
  /** Applies the standing assertion to this call. A call arriving after its assertion left no guesses to take back. */
  applyCallParty(id: string, arriving?: boolean): Promise<Subject[]>
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
  /** The same, of those with one of these ids. */
  callsWith(ids: readonly string[]): Promise<KeptCall[]>
  /** When each call of the given subjects was and how it went, oldest first, without calls that were no lead. That is all that says who waits for whom. */
  callTimes(subjects: readonly Subject[]): Promise<CallTime[]>
  /** Everyone in the components the given subjects are in. */
  aroundOf(subjects: readonly Subject[]): Promise<Map<Subject, Labels>>
  /** Who called or was called in a range of time, leaving out calls that were no lead. */
  calledBetween(from: number, to: number): Promise<Subject[]>
  /** Calls to you in a range of time that nobody answered, or that were no lead. */
  missesBetween(from: number, to: number): Promise<KeptCall[]>
  addPayment(payment: Required<Payment>): Promise<void>
  paymentOf(id: string): Promise<Required<Payment> | undefined>
  /** Every payment of an outcome, in no order. */
  paymentsOf(transactionId: string): Promise<Required<Payment>[]>
  /** Keeps a link sent to one person, or what is known of it now. */
  setLink(link: SentLink): Promise<void>
  linkOf(id: string): Promise<SentLink | undefined>
  /** Every kept link made for the given subjects, oldest first. */
  linksSent(subjects: readonly Subject[]): Promise<SentLink[]>
  /** Deletes kept links that stopped naming anyone before a time. Returns how many went. */
  pruneLinks(before: number): Promise<number>
  /** Keeps a text message. */
  setText(text: KeptText): Promise<void>
  textOf(id: string): Promise<KeptText | undefined>
  /** Every kept text to or from the given subjects, oldest first. */
  textsOf(subjects: readonly Subject[]): Promise<KeptText[]>
  /** The oldest text of each sender in a range of time that nobody has replied to, neither by text nor in a call, of those who did not ask for no more. */
  openTexts(from: number, to: number, limit: number, after?: { at: number; id: string }): Promise<KeptText[]>
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
  addCosts(costs: readonly CostRow[], read?: { at: number; key: string }): Promise<number>
  /** The receipt of a key, under any of the hashes it may have. */
  receiptOf(type: string, macs: readonly string[]): Promise<Receipt | undefined>
  addReceipt(receipt: Receipt, subjects: readonly Subject[]): Promise<void>
  setReceiptSent(type: string, macs: readonly string[], sent: unknown): Promise<void>
  /** Removes the receipt of a key, under any of its hashes, tombstone or not. */
  dropReceipt(type: string, macs: readonly string[]): Promise<void>
  /** Takes subjects out of what is said of others, and drops undelivered alerts that name any of these keys. */
  unname(subjects: readonly Subject[], keys: readonly string[]): Promise<void>
  /** The keys of what is recorded of subjects: conversions, calls, texts, payments, transfers and links. */
  keysOf(subjects: readonly Subject[], only?: readonly string[]): Promise<{ type: string; key: string }[]>
  /** Calls that mentioned an erased record but now belong to another record, including pending calls. */
  retainedPartyCalls(subjects: readonly Subject[], only?: readonly string[]): Promise<string[]>
  /**
   * Empties every receipt of the subjects, of the keys, and of what is about either, and leaves an empty one for a key
   * that has none. Read before the subjects are removed.
   */
  forgetReceipts(subjects: readonly Subject[], keys: readonly { type: string; mac: string; secretId: string; all: readonly string[] }[], at: number, retainedCalls?: readonly string[], only?: readonly string[]): Promise<void>
  /** Which secrets made the receipts that are kept. */
  receiptSecrets(): Promise<string[]>
  /** Something this database was set up with, which every process must share. */
  settingOf(name: string): Promise<string | undefined>
  setSetting(name: string, value: string): Promise<void>
  /** Keeps one thing said. Resolves to false where that key of that topic and thing was there. */
  addSaid(said: Said): Promise<boolean>
  saidOf<T extends Topic>(topic: T, about: string): Promise<SaidOf<T>[]>
  /** The same of many things at once, in no order. */
  saidAbout<T extends Topic>(topic: T, about: readonly string[]): Promise<SaidOf<T>[]>
  /** Costs with `from <= day <= to`, days written `YYYY-MM-DD`. */
  costsBetween(from: string, to: string): Promise<CostRow[]>
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
  /** The latest deletion, if any. A returned record can be named only for a call that followed that deletion. */
  partyReturn(subject: Subject, call: string): Promise<number | 'forgotten' | undefined>
  confirmPartyReturn(call: string, key: string, deletion: number): Promise<void>
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
 * its key, then by when it was written down. Two that tie on both stand as the refusal, so
 * the answer never depends on the order they arrived in.
 */
export function standingFirst(x: ConsentAnswer, y: ConsentAnswer): number {
  return y.at - x.at || byKey(y.key ?? '', x.key ?? '') || y.recorded - x.recorded || Number(x.adUserData) - Number(y.adUserData) || Number(x.adPersonalization) - Number(y.adPersonalization)
}
