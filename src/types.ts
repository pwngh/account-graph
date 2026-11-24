/** A thing with an identity: `account:42`, `visitor:9f3c`, `lead:7`. */
export type Subject = string

/** An observed attribute, written `kind:value`: `fingerprint:ab12`, `ip:203.0.113.9`. */
export type Identifier = string

/** One event in which a subject was seen with some identifiers. */
export interface Observation {
  subject: Subject
  identifiers: readonly Identifier[]
  /** Epoch milliseconds. */
  at: number
  /** What the subject was doing: `login`, `trade`, `enroll`, `pageview`. */
  event?: string
}

/** One row of the append-only log an observation expands to. */
export interface Sighting {
  subject: Subject
  identifier: Identifier
  /** When it happened, in epoch milliseconds. */
  at: number
  event?: string
  /** When it was written down, which can be later than when it happened. The graph sets this. */
  recorded?: number
}

/** Every sighting of one identifier on one subject, folded together. */
export interface Edge {
  subject: Subject
  identifier: Identifier
  first: number
  last: number
  count: number
}

export interface IdentifierState {
  /** How many distinct subjects carry the identifier. */
  fanout: number
  /** Set by hand to stop an identifier from linking anything. */
  ignored: boolean
}

/** Why one shared identifier counts toward a link. */
export interface Reason {
  identifier: Identifier
  /** Probability, from this identifier alone, that the two subjects are one person. */
  evidence: number
  fanout: number
  /** Milliseconds between the two subjects' sightings; 0 when they overlap. */
  gap: number
  /** The group its kind is in, when the policy puts it in one. */
  group?: string
  /** False when a stronger reason of the same group counted in its place. */
  counted?: false
}

export type Level = 'same' | 'related'

/** A scored pair, with `a < b`. */
export interface Pair {
  a: Subject
  b: Subject
  score: number
  level: Level
  reasons: Reason[]
}

/** A pair seen from one side. */
export interface Link {
  subject: Subject
  score: number
  level: Level
  reasons: Reason[]
}

export interface Cluster {
  /** The smallest member, so the id never depends on arrival order. */
  id: Subject
  members: Subject[]
  /** Larger than the policy's `review` size. A cluster this big is more often a bad identifier than one person. */
  oversized: boolean
}

/** Where a subject sits: the component it can reach over `same` links, and its cluster inside it. */
export interface Labels {
  component: Subject
  cluster: Subject
}

/** Value moving from one subject to another: a trade, a transfer, a lost match. */
export interface Flow {
  /** Your id for it, at most 200 characters. The same flow sent twice is counted once. */
  id: string
  from: Subject
  to: Subject
  /** A whole number of the asset's smallest unit: cents, gold pieces. */
  amount: number
  at: number
  /** What moved, when you track more than one thing. */
  asset?: string
}

/** Every flow from one subject to another in one asset, folded together. */
export interface FlowEdge {
  from: Subject
  to: Subject
  asset: string
  count: number
  total: number
  first: number
  last: number
}

/** What recording a flow answers: the tie between the two, and whether the flow was already recorded. */
export interface Transferred extends Counterparty {
  duplicate: boolean
}

/** Someone a subject has exchanged value with, and how the two are tied by identity. */
export interface Counterparty {
  subject: Subject
  asset: string
  /** `same`: one cluster. `related`: linked, not joined. `none`: no identity tie. */
  relation: Level | 'none'
  /** The direct link's score, or 0 when there is none. */
  score: number
  reasons: Reason[]
  sent: number
  received: number
  /** Flows in both directions. */
  count: number
  /** 0 when value moved evenly both ways, 1 when it only ever moved one way. */
  imbalance: number
  first: number
  last: number
}

/** Value that left a subject and came back to it through others: A paid B, B paid C, C paid A. */
export interface Ring {
  /** The subjects in the order value moved, starting with the one asked about. The last pays the first. */
  subjects: Subject[]
  asset: string
  /** The least that moved along any step: the most that could have gone all the way round. */
  amount: number
  /** How many of the others are in the same cluster as the first. A ring among one person's accounts is the clearest sign. */
  tied: number
}

/** How much the graph holds. */
export interface Counts {
  subjects: number
  clusters: number
  identifiers: number
  edges: number
  sightings: number
  touches: number
  decisions: number
  outcomes: number
}

/** What a person agreed to. Both are about advertising; neither affects fraud checks. */
export interface Consent {
  /** Their data may be sent to an ad platform to measure ads. */
  adUserData: boolean
  /** Their data may be used to personalize ads. */
  adPersonalization: boolean
}

/** One answer about advertising, as it was given. Answers are added to and never changed. */
export interface ConsentAnswer extends Consent {
  /** When it was given, in epoch milliseconds. 0 when it is not known: an answer kept from before there was a history. */
  at: number
  /** Where it was given: `banner`, `browser signal`, or a name of your own. */
  source?: string
  /** When it was written down. */
  recorded: number
}

/** Who made a decision and why, for the record. */
export interface Why {
  by?: string
  reason?: string
}

/** Who is deciding and why, and what they had seen when they did. */
export interface Deciding extends Why {
  /**
   * The newest decision on the record when they looked. One made since that names
   * the same subject or identifier refuses theirs with `Outdated`. Left out, nothing is checked.
   */
  seen?: number
  /** Decided by a program on its own. A `restore` someone has made since stands over it, so it decides nothing. */
  automatic?: boolean
}

/** One entry in the record of decisions people made about the graph. Entries are never changed. */
export interface Decision extends Why {
  /** 1 for the first decision, then counting up with no gaps. */
  seq: number
  /** When it was made, in epoch milliseconds. */
  at: number
  action: 'ignore' | 'restore' | 'separate' | 'rejoin' | 'join' | 'forget' | 'rebuild' | 'prune'
  /** What it was about: an identifier, a subject, or two subjects. */
  about: string[]
  /** Seals this entry to the one before it. */
  hash: string
}

/** Two subjects a backend says are different people, or with `separated: false` no longer says so; or that it has joined. */
export interface Told {
  a: Subject
  b: Subject
  /** For separations only. Defaults to true. */
  separated?: boolean
  /** Why, for this pair. Defaults to the reason given for the whole list. */
  reason?: string
}

/** What came of a list of pairs. */
export interface Recorded {
  changes: Change[]
  /** How many pairs were decided. */
  recorded: number
  /** How many already stood that way by the last decision about them, and were left alone. */
  already: number
}

/** What the record says of two subjects. */
export interface Verdict {
  a: Subject
  b: Subject
  /** The last decision about the two. */
  last: Decision
  /** The last decision that kept them apart, if any ever did. A later join does not undo it. */
  apart?: Decision
  /** How many times systems have reported the opposite of what a system reported before: kept apart, then joined, or the other way. */
  reversals: number
}

/** A cluster change as it was written down: who moved, from where to where, and when. */
export interface Moved extends Change {
  at: number
}

/** A cluster change in the order they were written. `seq` only grows, and some numbers are missing. */
export interface NumberedChange extends Moved {
  seq: number
}

/** One page of cluster changes, oldest first. Pass `next` as `after` for what came later. */
export interface ChangePage {
  changes: NumberedChange[]
  next: number
  /** Whether there is another page already. */
  more: boolean
}

/** A subject whose cluster moved. `from` is undefined for a subject not seen before. */
export interface Change {
  subject: Subject
  from: Subject | undefined
  to: Subject | undefined
}

/** A marketing touchpoint: one arrival that carried a click id, a UTM tag, or an outside referrer. */
export interface Touch {
  subject: Subject
  at: number
  source?: string
  medium?: string
  /** The campaign's name, from `utm_campaign`. */
  campaign?: string
  /** The ad platform's own ids, when the landing address carried them. Costs join on `campaignId`. */
  campaignId?: string
  adGroupId?: string
  adId?: string
  /** The search keyword, from `utm_term`. */
  term?: string
  /** Which ad or link, from `utm_content`. */
  content?: string
  /** Parameters of your own that the landing address carried, by name. */
  custom?: Record<string, string>
  gclid?: string
  gbraid?: string
  wbraid?: string
  fbclid?: string
  /** Meta's own id for this browser, from the `_fbp` cookie its pixel keeps on your site. Says nothing of where the visitor came from. */
  fbp?: string
  msclkid?: string
  ttclid?: string
  landing?: string
  referrer?: string
}

export interface AttributedTouch extends Touch {
  /** Strength of the best chain of links from the converting subject to the touch's subject. */
  confidence: number
  /** The two are one cluster, so the touch can be credited however weak the chain between them. */
  joined: boolean
  /** The subjects that chain passes through, starting at the converting subject. */
  via: Subject[]
}

export interface Attribution {
  subject: Subject
  at: number
  /** Every touch inside the window, newest first. */
  touches: AttributedTouch[]
  /** The newest touch at or above the `same` threshold. */
  credited: AttributedTouch | undefined
  reason: 'credited' | 'low_confidence' | 'no_touch'
}

/** Something a subject did that you count: an inquiry, an enrollment, a payment. */
export interface Outcome {
  /** Your id for this outcome. Recording it twice records it once. */
  transactionId: string
  subject: Subject
  /** When it happened, in epoch milliseconds. */
  at: number
  /** Which step this is, in your own words: `inquiry`, `enrolled`, `paid`. The report counts each step apart. */
  stage?: string
  /**
   * What this outcome counts as on each ad platform, by target name:
   * `{ google: '987654321', meta: 'Lead' }`. A plain string names it for the only target.
   * Without it the outcome is counted in the report and sent nowhere.
   */
  action?: string | Record<string, string>
  value?: number
  currency?: string
  /** Where it happened. Defaults to WEB. */
  source?: 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER'
  /** Hashed before it is stored. */
  email?: string
  phone?: string
  consent?: Consent
  /** Facts to break the report down by: at most 8, each a short code. */
  tags?: Record<string, string>
}

/** The part of an outcome the graph keeps for the report. */
export interface Counted {
  transactionId: string
  subject: Subject
  at: number
  stage: string
  value: number
  currency: string
  tags?: Record<string, string>
}

/** That something recorded as an outcome, or a call, was nobody's inquiry: `spam`, or `other`, such as a wrong number, a supplier or somebody who is a client already. */
export interface NotLead {
  kind: 'spam' | 'other'
  /** When it was said. */
  at: number
}

/** One value an outcome has had. Values are added to and never changed. */
export interface OutcomeValue {
  value: number
  currency: string
  /** When it was written down, in epoch milliseconds. 0 when that is not known: a value kept from before there was a history. */
  at: number
  /** Why it changed, where that was said: money given back, or money that will not come. Without it, what was known was corrected. */
  kind?: Loss
}

/** A reason an outcome came to be worth less. */
export type Loss = 'refund' | 'write_off'

/** What outcomes were worth when they were first recorded, and what they are worth now. */
export interface ValueChange {
  outcomes: number
  /** Of outcomes whose first value is known. `firstUnknown` counts the others, which are in none of this sum. */
  first: number
  firstUnknown: number
  /** What all of them are worth now: net of the two below. */
  now: number
  /** Of what they were worth, how much was given back, and how much will not come, where a change of value said so. */
  refunded: number
  writtenOff: number
  /** How many were worth something once and are worth nothing now. */
  zeroed: number
}

/** A phone call as it is kept, with its result once one is known. */
export interface KeptCall {
  id: string
  /** `inbound` someone rang you. `outbound` you rang them. */
  direction: 'inbound' | 'outbound'
  /** The other side: `caller:` and a hash of their number, or `call:` and the call's id when they hid it. */
  subject: Subject
  /** When it began, in epoch milliseconds. */
  at: number
  /** The number of yours it was on, in E.164 form. */
  to: string
  /** How long it lasted in seconds, from when the phone system picked up. Absent when the provider did not say. */
  duration?: number
  flags: string[]
  /** The visitor whose tap led to it. */
  visitor?: Subject
  /** Facts about it, carried on to its outcome. */
  tags?: Record<string, string>
  /** When it was written down. */
  recorded: number
  result?: CallResult
}

/** How a call went, as whoever runs the phones reports it. */
export interface CallResult {
  /** A person spoke to the caller. The phone system picking up is not an answer, and neither is voicemail. Absent when it is not known. */
  answered?: boolean
  voicemail?: boolean
  /** How long the caller waited before someone answered or they gave up, in seconds. */
  waited?: number
  /** When a system of yours says somebody reached the caller, however they did: from another line, by a text answered, in person. */
  returned?: number
  /** When it was written down. */
  recorded: number
}

/** What became of a call no one answered. */
export interface FollowUp {
  /**
   * `open` nobody has spoken to the caller since. `returned` you rang back
   * and they answered, or a system of yours says they were reached. `called again` they called again and got through.
   * `hidden` they hid their number, so it cannot be returned.
   */
  state: 'open' | 'returned' | 'called again' | 'hidden'
  /** The call that closed it, or that a return was reported for, and how long after the miss that was, in milliseconds. */
  by?: string
  delay?: number
  /** A system of yours reported the return, and no call shows it. */
  reported?: true
  /** How often you rang and nothing says they answered, before it was closed. */
  attempts: number
}

/** A missed call nobody has returned, with what it was credited to. */
export interface OpenCall {
  call: KeptCall
  followUp: FollowUp
  /** The arrival the call is credited to, as an outcome would be. */
  touch?: AttributedTouch
}

/** A number shown to one visitor for a while, so a call to it is theirs. Held from `start` up to `until`. The subject is empty once forgotten. */
export interface Lease {
  number: string
  subject: Subject
  start: number
  until: number
}

/** Why something a subject did belongs to the person asked about. */
export interface Tie {
  /** `self` it is the subject asked about. `cluster` the graph treats the two as one person. `linked` they are linked strongly enough to be credited, and a cut keeps them in two clusters. */
  how: 'self' | 'cluster' | 'linked'
  /** Strength of the best chain of links: from the subject asked about inside its cluster, and from the nearest of the cluster to anybody else. Null when no chain is left. */
  score: number | null
  /** The subjects that chain passes through, starting at the one it begins from. */
  via: Subject[]
  /** The kinds of identifier the chain's last link rests on, strongest first. */
  kinds: string[]
}

/** One thing that happened to a person. */
export type Entry = { at: number; subject: Subject } & (
  | { kind: 'visit'; touch: Touch }
  | { kind: 'sighting'; event: string; identifiers: Identifier[] }
  | { kind: 'call'; call: KeptCall; followUp?: FollowUp; notLead?: NotLead['kind'] }
  | { kind: 'outcome'; outcome: Counted; first: OutcomeValue | null; notLead?: NotLead['kind'] }
  | { kind: 'value'; transactionId: string; stage: string; from: OutcomeValue; to: OutcomeValue }
  | { kind: 'consent'; answer: ConsentAnswer }
  | { kind: 'decision'; decision: Decision }
)

/** Everything recorded about one person, across the subjects that are them. */
export interface Journey {
  subject: Subject
  /** Each subject something here was recorded on, and why it is this person. */
  subjects: Record<Subject, Tie>
  /** Oldest first: the newest that many, or those before the time asked for. */
  entries: Entry[]
  /** Pass as `before` for the entries before these, or null when there are none. */
  next: number | null
  /** Subjects left out because the person has more than are read. */
  more: number
}

/** What an ad platform charged for one campaign on one day. Writing the same day, source and campaign again replaces it. */
export interface Cost {
  /** The day, written `YYYY-MM-DD` in the ad account's time zone. */
  day: string
  /** The platform: `google`, `meta`, `microsoft`, `tiktok`, or your own name for another. */
  source: string
  /** The platform's id for the campaign. Leave it out for spend that belongs to no campaign. */
  campaignId?: string
  /** The campaign's name. */
  campaign?: string
  /** What was charged, in whole units of the currency: 12.5 is twelve and a half. */
  amount: number
  currency?: string
  clicks?: number
  impressions?: number
  /** How many conversions the platform says this spend brought, by its own rules. They need not be whole, and are never outcomes here. */
  conversions?: number
  /** What the platform says those are worth, in the currency of the amount. */
  conversionValue?: number
}

/** A cost as it is kept. What the platform claims is there only where it was said. */
export type CostRow = Required<Omit<Cost, 'conversions' | 'conversionValue'>> & Pick<Cost, 'conversions' | 'conversionValue'>

/**
 * What a platform says it brought, beside what is credited to it here, over
 * the days it said so. The two need not agree: a platform counts by its own
 * rules, often on the day of the click, and two may claim the same one.
 */
export interface Reported {
  /** Days of the period, up to today, with a number from the platform. */
  days: number
  conversions: number
  /** Null when the platform gave no value for some of them. */
  value: number | null
  /** Outcomes credited here on those days, of the one step asked for with `per` or of all. */
  credited: number
  /** What those are worth now. */
  creditedValue: number
}

/** Outcomes of one step. */
export interface StageCount {
  count: number
  value: number
  people: number
  /** How long after the arrival they came, over the outcomes that have one in the year before. Absent when none has. */
  delay?: Delay
}

/** Days from arrival to outcome. */
export interface Delay {
  /** How many outcomes have an arrival in the year before them. */
  count: number
  /** Half of them came within this many days, and 95 in 100 within that many. */
  median: number
  p95: number
  /** The share that came inside the window, and so can be credited. */
  inside: number
}

/** One line of the report: a campaign, or a source with no campaign, and what it cost and brought in. */
export interface ReportRow {
  /** The platform or site the visitor came from. `(none)` holds outcomes no arrival could be credited with. */
  source: string
  campaignId: string
  campaign: string
  cost: number
  clicks: number
  impressions: number
  /** Arrivals recorded in the period. */
  visits: number
  /** Calls no one answered, by result, credited the way outcomes are. They are never outcomes. */
  missed: number
  /** Outcomes and calls said to be no lead, credited the same way. They are in no other number here. */
  notLeads: number
  /** Outcomes credited to this row, per step, how many people they are, and how long after their arrival they came. */
  stages: Record<string, StageCount>
  /** Outcomes credited to this row, all steps together. */
  outcomes: number
  value: number
  /** How many people those outcomes are, whatever accounts they used. A renewal is a second outcome and not a second person. */
  people: number
  /** What those outcomes were first worth and are worth now. */
  valueChange: ValueChange
  /** How many days of the period, up to today, have cost data for this campaign, and how many have none. */
  costDays: number
  missingDays: number
  /** Fewer than half of the days have cost data, which is too few to say what anything cost. Never so for spend on no campaign, nor for a campaign with no paid arrival and no cost at all. On the total, every campaign that would count is so. */
  insufficientData: boolean
  /**
   * The cost over the outcomes credited to this campaign on the days that
   * have cost data. Null when there is no cost, no such outcome, or too few days.
   */
  costPerOutcome: number | null
  /** The value of those outcomes over the same cost. Null for the same reasons, or when they are worth nothing. */
  returnOnCost: number | null
  /** What the platform says it brought. Absent where it said nothing. On the total, over the rows that have one. */
  reported?: Reported
  /** The same outcomes by the dimension asked for. Costs are not split: a campaign is charged whole. */
  breakdown?: Breakdown
}

/** Outcomes and missed calls by the value of one dimension, each named by that value, in order. `(not set)` is always the last. */
export type Breakdown = { name: string; stages: Record<string, StageCount>; outcomes: number; value: number; people: number; missed: number; notLeads: number }[]

export interface Report {
  from: string
  to: string
  /** Highest cost first, then highest value. */
  rows: ReportRow[]
  total: Omit<ReportRow, 'source' | 'campaignId' | 'campaign'>
  /** Over how many days of the period costs could have been recorded: those up to today. */
  days: number
  /**
   * Set when part of the period is too recent for its arrivals to have done
   * all they will. `after` is the last day that has had its time, and `days`
   * how long that is: 95 in 100 outcomes of the slowest step come within it.
   */
  incomplete?: { after: string; days: number }
  /** The outcomes of the period by the month they were first recorded in, `YYYY-MM`, oldest first. Those from before there was a history are under `(not set)`. */
  months: (ValueChange & { month: string })[]
  /** Campaigns with cost data on too few days, left out of the total's cost per outcome and return. */
  excluded: number
  /** The dimension the rows are broken down by, when one was asked for. */
  by?: string
  /** The one step `costPerOutcome` counts, when one was asked for. The return still sets all value against the cost. */
  per?: string
  /** The dimensions something in these days was recorded under, for choosing one. */
  dimensions: string[]
  /** Every currency the costs and outcomes named. More than one means the sums mix currencies. */
  currencies: string[]
}
