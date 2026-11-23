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
}

/** What a person agreed to. Both are about advertising; neither affects fraud checks. */
export interface Consent {
  /** Their data may be sent to an ad platform to measure ads. */
  adUserData: boolean
  /** Their data may be used to personalize ads. */
  adPersonalization: boolean
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
  campaign?: string
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
