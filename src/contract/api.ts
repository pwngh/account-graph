import type { Decided, Outcome } from './outcome.ts'
import type { CallState, CallSummary, Change, Conflict, Consent, Followed, FollowUp, Level, Report, Ring, TextReply, Tie } from './types.ts'

export type { CallState, CallSummary, Change, Conflict, Consent, Decided, Followed, FollowUp, Level, Outcome, Report, Ring, TextReply, Tie }

// ── The interface. Local and remote implement exactly this. ──────────────────
export interface AccountGraph {
  record(request: RecordRequest, options?: CallOptions): Promise<RecordResponse>
  decide(request: DecideRequest, options?: CallOptions): Promise<Decided<DecideValue, DecideRefusal>>
  forget(request: ForgetRequest, options?: CallOptions): Promise<Decided<ForgetValue, ForgetRefusal>>
  lookup<Q extends LookupRequest>(request: Q, options?: CallOptions): Promise<LookupValue[Q['kind']]>
  report<Q extends ReportRequest>(request: Q, options?: CallOptions): Promise<{ readonly asOf: At; readonly value: ReportValue[Q['kind']] }>
  events(request: EventsRequest, options?: CallOptions): Promise<Outcome<EventPage, 'CURSOR_LOST'>>
  /** Refuses new calls, waits up to 30 seconds for those accepted, stops workers, closes connections. Safe to call twice. */
  close(): Promise<void>
}

/** Exactly economy-edge's src/ports/options.ts. `correlationId` travels as `x-request-id`. */
export interface CallOptions {
  readonly signal?: AbortSignal
  readonly correlationId?: string
}

/** Epoch milliseconds, an integer. Always given by the caller. Never defaulted. */
export type At = number

// ── record ───────────────────────────────────────────────────────────────────
export interface RecordRequest {
  /** 1 to 100. One at a time, in order, one transaction each. A later entry sees what an earlier one committed, and one refusal undoes nothing. */
  readonly entries: readonly RecordEntry[]
}

/** `key` is yours, 1 to 200 characters, and unique within its `type`. The graph never mints one. A `conversion` key may not begin with `call:`, `text:` or `page:`. */
export interface Keyed<T extends string> {
  readonly type: T
  readonly key: string
  readonly at: At
}

export type RecordEntry =
  | ProfileEntry | ArrivalEntry | CostEntry | ConversionEntry | RestatementEntry | PaymentEntry
  | CallEntry | CallUpdateEntry | TextEntry | ConsentEntry | LinkEntry | TransferEntry

export interface ProfileEntry extends Keyed<'profile'> {
  readonly subject: string
  /** At least one, unless somebody speaks for them. */
  readonly facts: Facts
  readonly event?: string
  /** Somebody else who told this, such as a parent: their own browser, number or email. What is theirs is not written on the subject, and neither is joined to the other. */
  readonly speaker?: Speaker
}

/** Whoever speaks for a subject. One without a device or a phone is not used, and a note says so. */
export interface Speaker {
  readonly device?: string
  readonly phone?: string
  readonly email?: string
}

/** Plain facts. The graph normalizes, checks and hashes them. At least one. */
export interface Facts {
  readonly email?: string
  readonly phone?: string
  readonly device?: string
  readonly ip?: string
  readonly address?: { readonly street: string; readonly street2?: string; readonly secondary?: string; readonly city?: string; readonly state?: string; readonly zipcode?: string }
  readonly name?: { readonly first: string; readonly last: string }
  readonly dob?: string
  /** Already `kind:value`: `hardware:…`, `passkey:…`, `payment:…`. Kinds the graph writes itself are refused: see KIND_RESERVED. */
  readonly identifiers?: readonly string[]
}

export interface ArrivalEntry extends Keyed<'arrival'> {
  readonly subject: string
  readonly source?: string
  readonly medium?: string
  readonly campaign?: string
  readonly campaignId?: string
  readonly adGroupId?: string
  readonly adId?: string
  readonly term?: string
  readonly content?: string
  readonly landing?: string
  readonly referrer?: string
  readonly clicks?: Partial<Record<'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'fbp' | 'msclkid' | 'ttclid', string>>
  readonly custom?: Readonly<Record<string, string>>
}

/** `at` is when the platform was read. Per row, the newest `at` stands. No subject. */
export interface CostEntry extends Keyed<'cost'> {
  readonly rows: readonly {
    readonly day: string
    readonly source: string
    readonly amount: number
    readonly currency: string
    readonly campaignId?: string
    readonly campaign?: string
    readonly clicks?: number
    readonly impressions?: number
    readonly conversions?: number
    readonly conversionValue?: number
  }[]
}

/** `key` is the transaction id. */
export interface ConversionEntry extends Keyed<'conversion'> {
  readonly subject: string
  readonly stage: string
  readonly value?: number
  readonly currency?: string
  /** What it counts as on each platform. Left out, the stage's own. */
  readonly actions?: Readonly<Record<string, string>>
  readonly channel?: 'WEB' | 'APP' | 'IN_STORE' | 'PHONE' | 'MESSAGE' | 'OTHER'
  readonly email?: string
  readonly phone?: string
  readonly consent?: Consent
  readonly tags?: Readonly<Record<string, string>>
}

export interface RestatementEntry extends Keyed<'restatement'> {
  readonly of: { readonly type: 'conversion' | 'call' | 'text'; readonly key: string }
  readonly change:
    /** What it is worth. The newest by (`at`, `key`) stands. */
    | { readonly kind: 'correct'; readonly value: number; readonly currency?: string }
    /** How much was lost, not what is left, so the order they arrive in does not matter. */
    | { readonly kind: 'refund' | 'write_off'; readonly amount: number; readonly currency?: string }
    /** Takes back one earlier refund or write-off, by its key. */
    | { readonly kind: 'reverse'; readonly restatement: string }
    | { readonly kind: 'not_lead'; readonly why: 'spam' | 'other' }
    | { readonly kind: 'lead' }
}

/** May come before its conversion. Once there is one, the conversion is worth what was paid, and restatements of value are refused with PAID. */
export interface PaymentEntry extends Keyed<'payment'> {
  readonly conversion: string
  readonly direction: 'received' | 'refunded'
  readonly amount: number
  readonly currency?: string
}

export interface CallEntry extends Keyed<'call'> {
  readonly direction: 'inbound' | 'outbound'
  readonly from?: string
  readonly to: string
  readonly duration?: number
  readonly result?: CallResult
  /** The code the caller read out or entered, from the page they saw. Pages are given codes where the server has `textCodes` on. Never kept. */
  readonly code?: string
  readonly tags?: Readonly<Record<string, string>>
}

export interface CallResult {
  readonly answered: boolean
  readonly voicemail?: boolean
  readonly waited?: number
}

/** May come before its call. `at` is when it was said. The newest by (`at`, `key`) stands, whatever order they arrive in. */
export interface CallUpdateEntry extends Keyed<'call_update'> {
  readonly call: string
  readonly change: { readonly kind: 'result'; readonly result: CallResult } | { readonly kind: 'returned'; /** When they were reached, which is not when it was said. */ readonly reachedAt: At } | { readonly kind: 'not_returned' }
}

export interface TextEntry extends Keyed<'text'> {
  readonly direction: 'inbound' | 'outbound'
  readonly from: string
  readonly to: string
  /** Read for a code and for STOP. Never kept. */
  readonly text?: string
  readonly code?: string
  readonly tags?: Readonly<Record<string, string>>
}

export interface ConsentEntry extends Keyed<'consent'> {
  readonly subject: string
  readonly consent: Consent
  readonly source?: string
}

/** The same entry always gives the same URL. */
export interface LinkEntry extends Keyed<'link'> {
  readonly subject: string
  readonly url: string
  readonly expires: At
  readonly purpose?: string
}

export interface TransferEntry extends Keyed<'transfer'> {
  readonly from: string
  readonly to: string
  readonly amount: number
  readonly asset?: string
}

/** One per entry, in order. */
export interface RecordResponse {
  readonly results: readonly RecordResult[]
}
export type RecordResult = { [T in keyof RecordValue]: { readonly type: T; readonly key: string } & Decided<RecordValue[T] & Told, RecordRefusal> }[keyof RecordValue]
/** `duplicate`: the key was recorded before, and the rest says how it stands now. `stands`: false when something newer already does. */
export interface Told {
  readonly duplicate: boolean
  readonly stands: boolean
}

export interface RecordValue {
  profile: { readonly changes: readonly Change[]; readonly notes: Readonly<Record<string, string>> }
  arrival: { readonly subject: string }
  cost: { readonly written: number; readonly older: number }
  conversion: { readonly value: number; readonly currency: string; readonly deliveries: readonly Delivery[] }
  restatement: { readonly counts: boolean; readonly value: number | null; readonly deliveries: readonly Delivery[] }
  payment: { readonly value: number | null; readonly deliveries: readonly Delivery[] }
  call: CallValue
  call_update: { readonly state: CallState; readonly counted: boolean; readonly followUp: FollowUp | null }
  text: { readonly subject: string; readonly flags: readonly string[]; readonly counted: boolean; readonly visitor?: string }
  consent: Readonly<Consent>
  link: { readonly url: string }
  transfer: { readonly relation: Level | 'none'; readonly score: number }
}
export interface CallValue {
  readonly subject: string
  readonly state: CallState
  readonly counted: boolean
  readonly flags: readonly string[]
  readonly visitor?: string
}

/** What a caller may know of an outbox job. No keys, attempts, rev or due. */
export interface Delivery {
  readonly conversion: string
  readonly platform: string
  readonly state: 'held' | 'pending' | 'sent' | 'skipped' | 'failed'
  readonly note?: string
}

/** None of these is kept with the key: put right what was wrong and send the same key again. */
export type RecordRefusal =
  /** The key was used for something else. `fields` names what differs, never its value. */
  | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }
  | { readonly reason: 'UNKNOWN_REFERENCE'; readonly of: { readonly type: 'conversion' | 'call' | 'text' | 'restatement'; readonly key: string } }
  | { readonly reason: 'KIND_NOT_IN_POLICY'; readonly kind: string }
  | { readonly reason: 'KIND_RESERVED'; readonly kind: string }
  /** None of the facts says who somebody is: `notes` says why of each. */
  | { readonly reason: 'NO_FACT_USED'; readonly notes: Readonly<Record<string, string>> }
  | { readonly reason: 'CURRENCY_MISMATCH'; readonly expected: string }
  /** It has payments, so it is worth what was paid. */
  | { readonly reason: 'PAID' }
  /** The key, or what it is about, belongs to somebody who was deleted. */
  | { readonly reason: 'FORGOTTEN' }
  /** The deadline came first. Nothing was tried. */
  | { readonly reason: 'NOT_ATTEMPTED' }

// ── decide ───────────────────────────────────────────────────────────────────
export interface Deciding {
  readonly key: string
  readonly at: At
  /** Required. With a reviewer's token it must be that reviewer. `system:…` needs the service token. */
  readonly by: string
  readonly reason?: string
  /** `decisions` from the lookup you decided by. A later decision about the same subjects refuses yours. Not an event `seq`. */
  readonly seen?: number
}
export type DecideRequest = Deciding &
  (
    | { readonly action: 'merge' | 'unmerge' | 'split' | 'unsplit'; /** 1 to 1,000, all or none. */ readonly pairs: readonly { readonly a: string; readonly b: string; readonly reason?: string }[] }
    | { readonly action: 'mute' | 'unmute'; readonly fact: { readonly email: string } | { readonly phone: string } | { readonly ip: string } | { readonly identifier: string } }
  )
export interface DecideValue {
  readonly duplicate: boolean
  readonly changes: readonly Change[]
  readonly recorded: number
  readonly already: number
  /** Pairs not as asked afterwards: a merge a split holds apart, or an unmerge that other evidence still joins. Use `split` to keep those apart. */
  readonly notAsAsked: readonly { readonly a: string; readonly b: string; readonly because: 'split' | 'evidence' | 'other_merges' }[]
}
export type DecideRefusal =
  /** A newer decision names them. `decision` is its number. */
  | { readonly reason: 'STALE'; readonly decision: number; readonly by: string | null; readonly at: At }
  | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }
  | { readonly reason: 'KIND_NOT_IN_POLICY'; readonly kind: string }
  /** `unmerge` only, and then none of the pairs is. `evidence`: joined by what they share, so there is no merge to take back. */
  | { readonly reason: 'NOT_JOINED'; readonly pairs: readonly { readonly a: string; readonly b: string; readonly because: 'apart' | 'evidence' | 'other_merges' }[] }
  | { readonly reason: 'FORGOTTEN' }

// ── forget ───────────────────────────────────────────────────────────────────
export interface ForgetRequest {
  readonly key: string
  readonly at: At
  readonly by: string
  readonly reason?: string
  readonly seen?: number
  /** 1 to 50, named one by one. All or none. */
  readonly subjects: readonly string[]
  /** `retract` also asks every platform that has a way to take its conversions back. */
  readonly platforms: 'report' | 'retract'
}
export interface ForgetValue {
  readonly duplicate: boolean
  readonly changes: readonly Change[]
  /** What had reached a platform. Kept with the key, so a lost answer can be asked for again. `pending`: a retraction is being asked for. */
  readonly sent: readonly { readonly conversion: string; readonly platform: string; readonly action: string; readonly at: At; readonly state: 'pending' | 'accepted' | 'rejected' | 'not_requested'; readonly note?: string }[]
}
export type ForgetRefusal = { readonly reason: 'STALE'; readonly decision: number; readonly by: string | null; readonly at: At } | { readonly reason: 'KEY_REUSED'; readonly fields: readonly string[] }

// ── lookup ───────────────────────────────────────────────────────────────────
export type LookupRequest =
  | { readonly kind: 'person'; /** 1 to 100. */ readonly subjects: readonly string[]; readonly at: At }
  | { readonly kind: 'journey'; readonly subject: string; readonly before?: number }
  | { readonly kind: 'find'; readonly text: string }
  | { readonly kind: 'match'; readonly facts: Facts; readonly at: At }
  | { readonly kind: 'caller'; readonly from?: string; readonly to: string; readonly at: At }
  | { readonly kind: 'conflicts'; /** 1 to 50. */ readonly subjects: readonly string[] }
  | { readonly kind: 'record'; readonly type: 'conversion' | 'call' | 'text'; readonly key: string; readonly at: At }
  | { readonly kind: 'transfers'; readonly subject: string; readonly tiedOnly?: boolean }

export interface LookupValue {
  /** `decisions` is the newest decision, read in the same snapshot. Pass it as `seen`. */
  person: { readonly decisions: number; readonly people: readonly Person[] }
  journey: { readonly subjects: Readonly<Record<string, Tie>>; readonly entries: readonly JourneyEntry[]; readonly next: number | null; readonly more: number }
  find: { readonly by: 'email' | 'phone' | 'click' | 'subject'; readonly subjects: readonly string[] }
  match: { readonly candidates: readonly Match[]; readonly notes: Readonly<Record<string, string>> }
  caller: { readonly subject: string | null; readonly area: string | null; readonly known: boolean; readonly people: readonly Match[]; readonly visitor: string | null; /** Missed calls nobody has returned, and texts nobody has answered. */ readonly waiting: { readonly calls: number; readonly texts: number }; readonly arrival: Arrival | null }
  conflicts: { readonly conflicts: readonly Conflict[] }
  record: RecordView | null
  transfers: { readonly counterparties: readonly Tied[]; readonly rings: readonly Ring[] }
}
/** Why is said by kind. No identifier leaves the graph, because most are hashes of an email or a phone. */
export interface Match {
  readonly subject: string
  readonly members: readonly string[]
  readonly score: number
  readonly level: Level
  readonly kinds: readonly string[]
  readonly conflict?: 'birth' | 'given'
  /** What they share would join them, and nothing confirms that they are one person: see the policy's `records`. */
  readonly unconfirmed?: true
}
export interface Tied {
  readonly subject: string
  readonly asset: string
  readonly relation: Level | 'none'
  readonly score: number
  readonly kinds: readonly string[]
  readonly sent: number
  readonly received: number
  readonly count: number
  readonly imbalance: number
  readonly first: At
  readonly last: At
}
export type JourneyEntry = { readonly at: At; readonly subject: string } & (
  | { readonly kind: 'visit'; readonly arrival: Arrival }
  | { readonly kind: 'sighting'; readonly event: string; readonly kinds: readonly string[] }
  | { readonly kind: 'call'; readonly call: string; readonly direction: 'inbound' | 'outbound'; readonly state: CallState; readonly followUp: FollowUp | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'text'; readonly text: string; readonly direction: 'inbound' | 'outbound'; readonly reply: TextReply | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'link'; readonly link: string; readonly purpose: string | null; readonly opened: At | null; readonly openings: number }
  | { readonly kind: 'conversion'; readonly conversion: string; readonly stage: string; readonly value: number; readonly currency: string; readonly deliveries: readonly Delivery[]; readonly notLead: 'spam' | 'other' | null }
  | { readonly kind: 'value'; readonly conversion: string; readonly from: number; readonly to: number; readonly why: 'correct' | 'refund' | 'write_off' | 'reverse' | 'payment' }
  | { readonly kind: 'consent'; readonly consent: Readonly<Consent>; readonly source: string | null }
  | { readonly kind: 'decision'; readonly decision: number; readonly action: string; readonly by: string | null; readonly reason: string | null }
)
export interface Person {
  readonly subject: string
  readonly known: boolean
  readonly members: readonly string[]
  readonly oversized: boolean
  readonly arrival: Arrival | null
  /** The strongest arrival, where none is strong enough to credit. */
  readonly possible: Arrival | null
  readonly consent: Consent | null
  readonly textsOptedOut: boolean
}
export interface Arrival {
  readonly at: At
  readonly source: string
  readonly campaign: string | null
  readonly campaignId: string | null
  readonly landing: string | null
  /** Parameters of your own that the landing address carried. */
  readonly custom: Readonly<Record<string, string>>
  readonly confidence: number
  readonly how: Tie['how']
}
export type RecordView =
  | { readonly type: 'conversion'; readonly subject: string; readonly at: At; readonly stage: string; readonly values: readonly { readonly value: number; readonly currency: string; readonly at: At; readonly kind?: 'refund' | 'write_off' }[]; readonly notLead: 'spam' | 'other' | null; readonly deliveries: readonly Delivery[] }
  | { readonly type: 'call'; readonly subject: string; readonly at: At; readonly direction: 'inbound' | 'outbound'; readonly state: CallState; readonly followUp: FollowUp | null; readonly notLead: 'spam' | 'other' | null }
  | { readonly type: 'text'; readonly subject: string; readonly at: At; readonly direction: 'inbound' | 'outbound'; readonly flags: readonly string[]; readonly reply: TextReply | null; readonly notLead: 'spam' | 'other' | null }

// ── report ───────────────────────────────────────────────────────────────────
/** Days, `YYYY-MM-DD`, in a named zone. The same shape as economy-edge's Window, with its zone said. An `at` within a minute of now is answered from the shared answer, whose moment is `asOf`. */
export interface Window {
  readonly from: string
  readonly to: string
  readonly timeZone: string
}
export type ReportRequest =
  | { readonly kind: 'campaigns'; readonly window: Window; readonly by?: string; readonly per?: string }
  | { readonly kind: 'pipeline'; readonly at: At; readonly days: number }
  | { readonly kind: 'calls'; readonly window: Window; readonly at: At }
  | { readonly kind: 'callbacks'; readonly window: Window; readonly at: At; readonly after?: string }
  | { readonly kind: 'texts'; readonly window: Window; readonly at: At; readonly after?: string }
  | { readonly kind: 'after_calls'; readonly window: Window; readonly at: At; readonly step: string; readonly days: number }
  | { readonly kind: 'deliveries'; readonly state: Delivery['state'] }

export interface ReportValue {
  campaigns: Report & { readonly timeZone: string; readonly steps: readonly string[] }
  pipeline: { readonly at: At; readonly day: string; readonly from: string; readonly unplaced: number; readonly columns: readonly PipelineColumn[] }
  calls: CallSummary
  callbacks: Page<{ readonly call: string; readonly subject: string; readonly at: At; readonly state: CallState; readonly attempts: number; readonly arrival: Arrival | null }>
  texts: Page<{ readonly text: string; readonly subject: string; readonly at: At; readonly unanswered: number; readonly arrival: Arrival | null }>
  after_calls: Followed
  deliveries: { readonly deliveries: readonly Delivery[] }
}
export interface PipelineColumn {
  /** Null for missed and not returned. */
  readonly step: string | null
  readonly wait: number | null
  readonly people: number
  readonly fresh: number
  readonly late: number | null
  readonly done: number | null
  readonly rows: readonly PipelineRow[]
}
export interface PipelineRow {
  readonly subject: string
  readonly at: At
  readonly late: boolean
  readonly step: string | null
  readonly value: number | null
  readonly currency: string | null
  readonly language: string | null
  readonly call: { readonly state: CallState; readonly direction: 'inbound' | 'outbound' } | null
  readonly arrival: Arrival | null
}
export interface Page<T> {
  readonly rows: readonly T[]
  readonly next: string | null
}

// ── events ───────────────────────────────────────────────────────────────────
export interface EventsRequest {
  /** `cursor` of the last page you acted on. Null to start. Opaque: it names this database's history as well as a place in it. */
  readonly after: string | null
  /** 1 to 1,000. */
  readonly limit: number
}
export interface EventPage {
  readonly schemaVersion: 1
  readonly events: readonly (GraphEvent | UnrecognizedEvent)[]
  readonly cursor: string
  readonly more: boolean
}
export interface Event<T extends string, D> {
  readonly schemaVersion: 1
  readonly seq: number
  readonly type: T
  readonly at: At
  readonly data: D
}
/** From a newer server. Keep it, and move on. */
export interface UnrecognizedEvent {
  readonly schemaVersion: 1
  readonly seq: number
  readonly type: 'Unrecognized'
  readonly raw: unknown
}
export type GraphEvent =
  | Event<'cluster.changed', { readonly subject: string; readonly from: string | null; readonly to: string | null }>
  | Event<'conversion.failed', { readonly conversion: string; readonly platform: string; readonly note: string }>
  | Event<'delivery.paused', { readonly reason: string }>
  | Event<'delivery.late', { readonly oldestDue: At }>
  | Event<'costs.failed', { readonly source: string; readonly reason: string }>
  | Event<'feed.quiet', { readonly feed: 'touches' | 'calls' | 'results' | 'costs'; readonly last: At | null; readonly hours: number }>
  | Event<'callback.overdue', { readonly call: string; readonly subject: string; readonly missedAt: At; readonly attempts: number; readonly source: string; readonly campaign: string | null; readonly campaignId: string | null }>
  | Event<'audit.head', { readonly seq: number; readonly hash: string; readonly sound: boolean; readonly brokenAt: number | null }>

// ── the factory ──────────────────────────────────────────────────────────────
export interface Common {
  /** How long one call may take, waiting for the write lock included. Defaults to 30,000. */
  readonly timeoutMs?: number
}
export interface RemoteOptions extends Common {
  readonly url: string
  readonly token: string
  readonly fetch?: typeof fetch
  readonly databaseUrl?: never
  readonly memory?: never
}
/** One of two places to keep it. Everything else is the same. */
export type LocalOptions = LocalSettings & (InPostgres | InMemory)
export interface InPostgres {
  readonly databaseUrl: string
  readonly schema?: string
  /** Whether this process sends conversions, pulls costs and delivers events. Said, not defaulted: either default is a trap. */
  readonly workers: boolean
  /** Keys the receipts. The first signs and all are tried. At least 32 characters each. One that rows still name may not be dropped. */
  readonly receiptSecrets: readonly [string, ...string[]]
  readonly memory?: never
  readonly url?: never
}
export interface InMemory {
  readonly memory: true
  readonly workers?: boolean
  readonly databaseUrl?: never
  readonly url?: never
}
export interface LocalSettings extends Common {
  /** Left out, the policy the database was built with. One that differs throws CONFIG.MISMATCH until `account-graph rebuild`. */
  readonly policy?: PolicyOptions
  readonly identifierSecret?: string
  readonly linkSecret?: string
  readonly timeZone?: string
  readonly openHours?: OpenHours
  readonly stages?: Readonly<Record<string, { readonly value?: number; readonly currency?: string; readonly action?: Readonly<Record<string, string>>; readonly wait?: number }>>
  readonly phones?: {
    readonly numbers?: Readonly<Record<string, { readonly source: string; readonly medium?: string; readonly campaign?: string; readonly campaignId?: string; readonly tags?: Readonly<Record<string, string>> }>>
    readonly exclude?: readonly string[]
    readonly minimumSeconds?: number
    readonly resultsExpectedWithinMinutes?: number
    readonly returnHours?: number
    /** The country code of numbers written without one. Defaults to 1. */
    readonly country?: string
    /** How long before a call a tap on its number may be. Defaults to 180. */
    readonly tapSeconds?: number
    /** Numbers shown to one visitor at a time. */
    readonly pool?: { readonly numbers: readonly string[]; readonly minutes: number; readonly graceMinutes: number }
  }
  readonly ads?: {
    readonly google?: { readonly customerId: string; readonly loginCustomerId?: string; readonly serviceAccount: GoogleServiceAccount }
    readonly meta?: { readonly pixelId: string; readonly accessToken: string; readonly siteUrl: string; readonly testEventCode?: string }
    readonly microsoft?: { readonly clientId: string; readonly refreshToken: string; readonly developerToken: string; readonly customerId: string; readonly accountId: string; readonly clientSecret?: string }
    readonly tiktok?: { readonly pixelCode: string; readonly accessToken: string; readonly siteUrl: string }
    readonly retractOnForget?: boolean
    readonly delayMs?: number
  }
  readonly costs?: {
    readonly google?: { readonly customerId: string; readonly developerToken: string; readonly loginCustomerId?: string; readonly serviceAccount: GoogleServiceAccount; readonly conversions?: boolean }
    readonly meta?: { readonly adAccountId: string; readonly accessToken: string; readonly conversions?: string }
  }
  readonly checks?: {
    readonly address?: { readonly authId: string; readonly authToken: string }
    readonly lineType?: { readonly accountSid: string; readonly authToken: string }
  }
  readonly monitor?: { readonly quietHours?: Partial<Record<'touches' | 'calls' | 'results' | 'costs', number>>; readonly lateHours?: number; readonly auditHours?: number }
  readonly webhook?: { readonly url: string; readonly secret: string }
  /** A Slack-style `{ text }` address. The same events, written as sentences. */
  readonly alerts?: { readonly url: string }
  readonly now?: () => At
  /** Asks ad platforms, checks and webhooks in place of the global one: for tests and demos. */
  readonly fetch?: typeof fetch
}

export interface GoogleServiceAccount {
  readonly client_email: string
  readonly private_key: string
}
type Span = `${number}:${number}-${number}:${number}`
export interface OpenHours extends Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', readonly Span[]>> {
  readonly holidays?: readonly ('us' | 'us-tx' | `${number}-${number}-${number}`)[]
  readonly timeZone?: string
}
export interface RuleOptions {
  readonly weight: number
  readonly dilution: number
  readonly cap: number
  readonly halfLife: number | 'none'
  readonly group?: string
  readonly corroborates?: true
  readonly relates?: true
}
export type BuiltInKind = 'review' | 'passkey' | 'email' | 'phone' | 'voip' | 'address' | 'payment' | 'device' | 'ga' | 'hardware' | 'fingerprint' | 'canvas' | 'ip' | 'link' | 'carry' | 'opened' | 'lease' | 'dial' | 'text' | 'place' | 'birth' | 'dialed' | 'behalf' | 'named' | 'ward' | 'given' | 'initial' | 'dated'
export interface PolicyOptions {
  readonly same?: number
  readonly related?: number
  readonly bridge?: number
  readonly review?: number
  readonly apart?: readonly ('birth' | 'given')[]
  /** Two records are one person only where somebody said so, or a name or a date of birth agrees. Requires `apart`. */
  readonly records?: 'confirmed'
  /** Only what differs. A misspelled kind or field does not compile. */
  readonly kinds?: { readonly [K in BuiltInKind]?: Partial<RuleOptions> }
  /** Kinds of your own, said in full. */
  readonly customKinds?: Readonly<Record<string, RuleOptions>>
}

// ── webhooks ─────────────────────────────────────────────────────────────────
export interface RawWebhook {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}
