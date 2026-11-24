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
  msclkid?: string
  ttclid?: string
  landing?: string
  referrer?: string
}

export interface AttributedTouch extends Touch {
  /** Strength of the best chain of links from the converting subject to the touch's subject. */
  confidence: number
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
  /** When it was written down. */
  recorded: number
}

/** What became of a call no one answered. */
export interface FollowUp {
  /**
   * `open` nobody has spoken to the caller since. `returned` you rang back
   * and they answered. `tried again` they rang again and got through.
   * `hidden` they hid their number, so it cannot be returned.
   */
  state: 'open' | 'returned' | 'tried again' | 'hidden'
  /** The call that closed it, and how long after the miss it began, in milliseconds. */
  by?: string
  delay?: number
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
  /** Outcomes credited to this row, per step. */
  stages: Record<string, { count: number; value: number }>
  /** Outcomes credited to this row, all steps together. */
  outcomes: number
  value: number
  /** How many days of the period, up to today, have cost data for this campaign, and how many have none. */
  costDays: number
  missingDays: number
  /** Too few days have cost data to say what anything cost: some, and fewer than half. On the total, every campaign with cost data is so. */
  thin: boolean
  /**
   * The cost over the outcomes credited to this campaign on the days that
   * have cost data. Null when there is no cost, no such outcome, or too few days.
   */
  costPerOutcome: number | null
  /** The value of those outcomes over the same cost. Null for the same reasons, or when they are worth nothing. */
  returnOnCost: number | null
  /** The same outcomes by the dimension asked for. Costs are not split: a campaign is charged whole. */
  breakdown?: Breakdown
}

/** Outcomes and missed calls by the value of one dimension, each named by that value, in order. `(not recorded)` is always the last. */
export type Breakdown = { name: string; stages: Record<string, { count: number; value: number }>; outcomes: number; value: number; missed: number }[]

export interface Report {
  from: string
  to: string
  /** Highest cost first, then highest value. */
  rows: ReportRow[]
  total: Omit<ReportRow, 'source' | 'campaignId' | 'campaign'>
  /** Over how many days of the period costs could have been recorded: those up to today. */
  days: number
  /** Campaigns with cost data on too few days, left out of the total's cost per outcome and return. */
  leftOut: number
  /** The dimension the rows are broken down by, when one was asked for. */
  by?: string
  /** The dimensions something in these days was recorded under, for choosing one. */
  dimensions: string[]
  /** Every currency the costs and outcomes named. More than one means the sums mix currencies. */
  currencies: string[]
}
