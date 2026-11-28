import { malformed, refused } from '../contract/fault.ts'
import { keepableText } from './identifiers.ts'
import type { Graph } from './graph.ts'
import type { Attribution, AttributedTouch, Change, Consent, Counted, Deciding, Loss, Outcome, Payment, Subject } from '../contract/types.ts'

export type { Outcome }

/** `held` waits for whoever held it. It is not sent until it is released. */
export type JobState = 'held' | 'pending' | 'sent' | 'skipped' | 'failed'

/** An outcome on its way to one platform, and what became of it. */
export interface Job {
  transactionId: string
  /** The platform it goes to. */
  target: string
  subject: Subject
  at: number
  action: string
  value?: number
  currency?: string
  source?: Outcome['source']
  /** The email and phone, hashed the way this platform matches them. */
  keys: Record<string, string>
  /** Which of `keys` were made from the email and the number kept of the record, because the outcome gave none. */
  filed?: string[]
  /** Raw HTTP user agent only for opted-in Meta website conversions. Never a match key. */
  metaUserAgent?: string
  consent?: Consent
  state: JobState
  /** How many times a worker has picked it up. */
  attempts: number
  /** The earliest time a worker may pick it up, in epoch milliseconds. */
  due: number
  /** Counts every claim and change of the stored job. The store keeps it. */
  rev?: number
  /** Why it was skipped, failed, or is waiting to retry. */
  note?: string
  /** The click that was sent, and how strongly the graph tied it to the subject. */
  click?: Record<string, string>
  confidence?: number
  /** The platform's id for the request that carried it. */
  requestId?: string
  /** Its value was changed after it was first recorded. */
  restated?: boolean
  /** It reached its platform at least once, whatever has happened since. */
  delivered?: boolean
  /** Its outcome was taken back, and has not been given back since. */
  withdrawn?: boolean
}

/** A job ready to send, with the touch and consent that go with it. */
export interface Item {
  job: Job
  touch: AttributedTouch | undefined
  consent: Consent | undefined
}

/** An ad platform the outbox can send to. */
export interface Target {
  /** The name outcomes use for it in `action`. */
  name: string
  /** Accept the actual converting browser's user agent with advertising consent. */
  clientUserAgent?: boolean
  /** The email and phone of an outcome, hashed the way this platform matches them. */
  keys(outcome: Outcome): Record<string, string>
  /** The touch this platform can credit, which is the newest one that carries its click id at or above `confidence`. The outbox gives only touches it trusts, and 0. */
  click(attribution: Attribution, confidence: number): AttributedTouch | undefined
  /** Sends jobs that share an action in one request. Throws when the platform refuses. */
  deliver(action: string, items: readonly Item[]): Promise<{ requestId?: string }>
  /** Whether trying again could fix a refusal: a rate limit, an outage, a credential that needs repair. */
  retryable(error: unknown): boolean
  /**
   * Takes back what was sent of someone who was forgotten, where the platform
   * has a way. Answers with why each was refused, or undefined where it was
   * taken back, in the order given. Throws when all of it was refused.
   */
  forget?(jobs: readonly Job[]): Promise<(string | undefined)[]>
  /** Most jobs in one request. */
  batch: number
  /** The platform refuses outcomes older than this many milliseconds. */
  maxAge?: number
  /** Sending an id again with a new value changes the value the platform recorded. */
  restates?: boolean
}

/** Where jobs are kept. Each call is atomic on its own. */
export interface OutboxStore {
  /**
   * Stores the job unless one with its transaction id and target exists. Resolves to the stored job either way, or with
   * `counted` to undefined when there is none and its outcome is not on record, because its subject was forgotten meanwhile.
   */
  add(job: Job, counted?: boolean): Promise<Job | undefined>
  /**
   * Hands out up to `limit` pending jobs that are due, and pushes each one's
   * due time to `now + lease`. A worker that dies leaves its jobs to be
   * handed out again once the lease runs out. No job goes to two workers at once.
   */
  claim(now: number, lease: number, limit: number): Promise<Job[]>
  /**
   * Replaces `before` with `after` and counts its `rev` up, unless the
   * stored job's `rev` is no longer that of `before`. Resolves to whether it
   * did, so nothing written from an old reading undoes a newer change.
   */
  swap(before: Job, after: Job): Promise<boolean>
  /** Which of the given jobs have not been claimed or changed since they were read. */
  standing(jobs: readonly Job[]): Promise<Job[]>
  /** Guards the jobs, call ownership and requested subjects' latest advertising refusals until the request starts. */
  start(jobs: readonly Job[], send: (standing: readonly Job[], partyRevision: string | undefined, refusals: ReadonlyMap<Subject, number>) => void, subjects?: readonly Subject[]): Promise<void>
  /** Every job of one transaction, one per target. */
  get(transactionId: string): Promise<Job[]>
  /** Jobs in one state, the most recently due first. */
  list(state: JobState, limit: number): Promise<Job[]>
  counts(): Promise<Record<JobState, number>>
  /** When the pending job that has been due the longest fell due. */
  oldestDue(): Promise<number | undefined>
}

/** A conversion of someone who was forgotten, and whether its platform was told. It says nothing of the person. */
export interface Sent {
  transactionId: string
  target: string
  action: string
  at: number
  /** `accepted` means the platform rejected nothing, `rejected` that it did, and `not_requested` that it was not asked. */
  state: 'accepted' | 'rejected' | 'not_requested'
  /** Why it was refused, or that it may not have arrived. */
  note?: string
}

export interface OutboxOptions {
  /** The platforms to send to. See `googleAds` and `meta`. */
  targets: readonly Target[]
  /** The lowest confidence at which a click is sent. Left out, 0.9, and any click of the person's own cluster. */
  confidence?: number
  /** How far back a click may be. Defaults to 90 days. */
  window?: number
  /** How long after it happened an outcome with no click, email or phone waits for one, in milliseconds. Defaults to seven days. */
  patience?: number
  /** How long to hold a new outcome before sending, so late evidence can arrive. Defaults to none. */
  delay?: number
  /** How long a worker has to finish a job before another may take it. Defaults to one minute. */
  lease?: number
  /** After this many tries a job fails for good. Defaults to 8. */
  maxAttempts?: number
  /** Jobs per pass. Defaults to 500. */
  batch?: number
  /**
   * Hears about each pass's jobs that failed for good, after the pass. Use it
   * to alert someone. A throw here is logged and changes nothing.
   */
  onFailed?: (jobs: Job[]) => void | Promise<void>
  /** Tell platforms that have a way when someone is forgotten. Off unless asked for. */
  retractOnForget?: boolean
  now?: () => number
  random?: () => number
}

export interface Pass {
  sent: number
  skipped: number
  failed: number
  /** Jobs put back to try again later. */
  retried: number
}

export interface Outbox {
  /**
   * Records an outcome: once in the graph, for the report, and as one job per
   * platform named in `action`. Safe to call again with the same id.
   */
  record(outcome: Outcome): Promise<Job[]>
  /** `graph.pay`, and tells the platforms that can be told what its outcome is worth now. */
  pay(payment: Payment): Promise<{ duplicate: boolean; value?: number; jobs: Job[] }>
  /**
   * Changes the value of an outcome, for a refund or a corrected amount, and
   * sends it again to every platform that can restate. Others keep what they have.
   */
  restate(transactionId: string, value: number, currency?: string, kind?: Loss): Promise<Job[]>
  /**
   * Keeps an outcome's jobs without sending them or counting the outcome,
   * until `release` with the same id. The keys are hashed now, so what they
   * were made from need not be kept.
   */
  hold(outcome: Outcome): Promise<Job[]>
  /** Counts an outcome that was held or withdrawn, and sends its jobs. One that was neither is recorded. */
  release(outcome: Outcome): Promise<Job[]>
  /**
   * Takes back an outcome that turned out not to have happened. It leaves
   * the report, its unsent jobs are held, and where it was sent its value is
   * restated to nothing on every platform that can restate. Others keep it.
   */
  withdraw(transactionId: string): Promise<Job[]>
  /** Takes an outcome's jobs back and leaves the outcome, because it was no lead. */
  takeBack(transactionId: string): Promise<Job[]>
  /** Gives back the jobs `takeBack` took, at what the outcome is worth now. */
  giveBack(transactionId: string): Promise<Job[]>
  /**
   * Forgets a subject the way `graph.forget` does, and says which of its
   * conversions had reached a platform. With `retractOnForget`, or `retract` for this one, a platform that
   * has a way is told after the subject is gone here, and not again. What was not
   * told is in the answer and kept nowhere.
   */
  forget(subject: Subject | readonly Subject[], why?: Deciding, how?: { retract?: boolean }): Promise<{ changes: Change[]; sent: Sent[] }>
  /** Brings an outcome's jobs to what it is worth on record, and tells the platforms that can be told. */
  revalue(transactionId: string): Promise<Job[]>
  /** Whether a platform can be asked to take a conversion back. */
  canRetract(target: string): boolean
  /** Asks the platforms that have a way to take back what was sent of somebody who is gone, and says how each answered. */
  retract(jobs: readonly Job[]): Promise<Sent[]>
  /** The platforms that can be asked to retract a conversion, and whether every `forget` asks them. */
  readonly retraction: { targets: string[]; always: boolean }
  /** Sends every job that is due. Call it on a timer, from as many workers as you like. */
  run(): Promise<Pass>
  /** Calls `run` every `interval` milliseconds. Returns a function that stops it. */
  start(interval: number, onError?: (error: unknown) => void): () => void
  /** Every job of one transaction, one per platform. */
  get(transactionId: string): Promise<Job[]>
  /** Jobs in one state, the most recently due first: what failed, what was skipped and why. */
  list(state: JobState, limit?: number): Promise<Job[]>
  /** Puts a transaction's failed and skipped jobs back in line, after you fixed what stopped them. With `target`, only that platform's. */
  retry(transactionId: string, target?: string): Promise<Job[]>
  counts(): Promise<Record<JobState, number>>
}

const DAY = 86_400_000

const reached = (job: Job) => Boolean(job.delivered || job.state === 'sent' || job.requestId)
// The target already knows the transaction id. An adjustment gives it no newly named subject.
/** A job with the keys its outcome gave, and none made from the record. They are made again at each send, while consent stands. */
function unfiled(job: Job): Job {
  if (!job.filed) return job
  const { filed, ...rest } = job
  return { ...rest, keys: Object.fromEntries(Object.entries(job.keys).filter(([name]) => !filed.includes(name))) }
}
const forTarget = (job: Job): Job => job.note === 'call_party' ? { ...job, subject: job.transactionId } : job
const privateNote = (job: Job, note: string) => job.note === 'call_party' ? job.note : note

/** Which of these jobs had reached their platform, or may have, in order. None is told of here. */
export function sentOf(jobs: readonly Job[]): Sent[] {
  return jobs
    .map((job): [Job, boolean] => [job, reached(job)])
    // One that was picked up may have arrived with no answer. Telling a platform of it could be the first it hears.
    .filter(([job, arrived]) => arrived || (job.attempts > 0 && (job.state !== 'skipped' || job.note === 'call_party') && job.note !== 'unknown_target'))
    .map(([{ transactionId, target, action, at }, arrived]): Sent => ({ transactionId, target, action, at, state: 'not_requested', ...(!arrived && { note: 'may not have arrived' }) }))
    .sort((x, y) => (x.transactionId < y.transactionId ? -1 : x.transactionId > y.transactionId ? 1 : x.target < y.target ? -1 : 1))
}

/** What went wrong, without what was sent. A platform may answer with it, and whoever reads the note has no need of a hashed email or phone, this one's or another's in the same request. */
const noted = (error: unknown, keys: readonly string[]) =>
  [...keys].filter((key) => key.length > 3).sort((a, b) => b.length - a.length).reduce((text, key) => text.replaceAll(new RegExp(key.replace(/[^\w]/g, '\\$&'), 'gi'), '(left out)'), String((error as Error)?.message ?? error))
const noteOf = (error: unknown, keys: readonly string[]) => keepableText(noted(error, keys), 500)

/**
 * Sends recorded outcomes to ad platforms at least once. Each platform keeps
 * the first event per transaction id, so a job sent twice after a crash
 * counts once.
 */
export function createOutbox(graph: Graph, store: OutboxStore, options: OutboxOptions): Outbox {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const confidence = options.confidence ?? 0.9
  const lease = options.lease ?? 60_000
  const maxAttempts = options.maxAttempts ?? 8
  const targets = new Map(options.targets.map((target) => [target.name, target]))
  if (targets.size === 0) throw malformed('An outbox requires at least one target')

  /** Thirty seconds, doubling each try up to an hour, shortened by up to half so workers do not retry in step. In whole milliseconds, as a retry time is kept. */
  const backoff = (attempts: number) => Math.round(Math.min(3_600_000, 30_000 * 2 ** (attempts - 1)) * (0.5 + random() / 2))

  /** Marks a job failed for good and remembers it for `onFailed`. */
  async function fail(job: Job, note: string, pass: Pass, failed: Job[]): Promise<void> {
    const { metaUserAgent, ...kept } = job
    const dead: Job = { ...kept, state: 'failed', note: privateNote(job, note) }
    if (!(await store.swap(job, dead))) return
    failed.push({ ...dead, rev: job.rev! + 1 })
    pass.failed += 1
  }

  /** Changes a stored job, starting again from what is stored whenever something else changed it first. */
  async function change(job: Job, make: (current: Job) => Job | undefined | Promise<Job | undefined>, sent?: Job): Promise<Job> {
    for (;;) {
      const current = (await store.get(job.transactionId)).find((each) => each.target === job.target)
      // Forgotten meanwhile, or nothing to change.
      if (!current) return job
      let next: Job | undefined
      if (current.note === 'call_party' && !reached(current)) {
        if (!sent) return current
        // An acknowledgment can arrive after a refund, a withdrawal or a correction of its owner.
        const target = targets.get(sent.target)
        const match = target?.restates || target?.forget ? { keys: sent.keys, ...(sent.click && { click: sent.click }), ...(sent.consent && { consent: sent.consent }) } : {}
        const { value, currency, ...original } = current
        next = { ...original, ...match, ...(sent.value !== undefined && { value: sent.value }), ...(sent.currency && { currency: sent.currency }), delivered: true, state: 'sent' }
      } else next = await make(current)
      if (!next) return current
      // Keep the original match private through retries and further changes of value.
      if (current.note === 'call_party') next = { ...next, note: 'call_party' }
      if (!await store.swap(current, next)) continue
      const stored = { ...next, rev: (current.rev ?? 0) + 1 }
      if (sent && current.note === 'call_party' && !reached(current) && targets.get(sent.target)?.restates) {
        // The acknowledgment is visible first, so a later refund updates this same revision and wins a race with reconciliation.
        return change(stored, async held => {
          const outcome = await graph.outcomeOf(held.transactionId)
          if (!outcome || (await graph.notLeads([held.transactionId])).size) return held.withdrawn ? undefined : takenBack(held)
          const worth = worthNow(held, outcome)
          return worth === held || held.withdrawn ? undefined : { ...worth, state: 'pending', attempts: 0, due: now() }
        })
      }
      return stored
    }
  }

  /** A job whose outcome was taken back: held if it never arrived, worth nothing where the platform can be told, and left where it cannot. */
  function takenBack(job: Job): Job {
    const { metaUserAgent, ...kept } = job
    if (!reached(job)) return { ...kept, withdrawn: true, state: 'held', attempts: 0, note: 'withdrawn' }
    const gone: Job = { ...kept, delivered: true, withdrawn: true }
    if (!targets.get(job.target)?.restates) return { ...gone, state: 'sent', note: 'withdrawn, but this platform keeps it' }
    return { ...gone, value: 0, restated: true, state: 'pending', attempts: 0, due: now(), note: 'withdrawn' }
  }

  /** A job with what its outcome is worth now. One whose worth is the same stays as it is, so that the same outcome recorded again is still the same. */
  function worthNow(job: Job, { value, currency }: Pick<Outcome, 'value' | 'currency'>): Job {
    if ((value ?? 0) === (job.value ?? 0) && (!currency || currency === job.currency)) return job
    return { ...job, value: value ?? 0, ...(currency && { currency }), restated: true }
  }

  /** A job whose outcome counts after all. */
  function givenBack(job: Job, worth: Pick<Outcome, 'value' | 'currency'>): Job {
    const { withdrawn: _, note: __, ...rest } = job
    if (!reached(job)) return { ...worthNow(rest, worth), state: 'pending', due: now() + (options.delay ?? 0) }
    // It had arrived, and may have been restated to nothing since. Give it its value again.
    if (!targets.get(job.target)?.restates) return { ...rest, state: 'sent' }
    return { ...worthNow(rest, worth), value: worth.value ?? 0, state: 'pending', attempts: 0, due: now() }
  }

  /**
   * A job that changed while `sent`, as it was before, was on its way. That
   * one arrived, and it may have come after a newer one did, so what the job says
   * now is sent once more where the platform keeps the last value it hears.
   */
  function landed(sent: Job, current: Job, target: Target): Job | undefined {
    // Already known to have arrived, with the value it has now. There is nothing to put right.
    if (current.delivered && current.value === sent.value) return undefined
    const { metaUserAgent, ...kept } = current
    const arrived: Job = { ...kept, delivered: true, ...(sent.click && { click: sent.click }) }
    if (current.withdrawn) return takenBack(arrived)
    if (!target.restates || current.value === sent.value) return arrived
    return { ...arrived, restated: true, state: 'pending', attempts: 0, due: now() }
  }

  type Selection = { party: string | undefined; again: Set<string> }
  async function deliver(target: Target, action: string, claimed: readonly Item[], pass: Pass, failed: Job[], selection: Selection): Promise<void> {
    // What was taken back or changed since it was claimed is left to the next pass.
    const standing = await store.standing(claimed.map(({ job }) => job))
    if (!standing.length) return
    let items: Item[] = []
    let request: ReturnType<Target['deliver']> | undefined
    try {
      const subjects = new Set<Subject>()
      for (const { job, touch } of claimed) if (job.metaUserAgent) {
        subjects.add(job.subject)
        if (touch) subjects.add(touch.subject)
      }
      await store.start(standing, (current, party, refusals) => {
        // Correcting another call or forgetting its visitor can remove this job's click without changing the job itself.
        if (party !== selection.party) {
          for (const job of current) selection.again.add(jobKey(job))
          return
        }
        const kept = new Set(current)
        items = claimed.filter(({ job, touch }) => {
          if (!kept.has(job)) return false
          // A refusal since selection can belong to the person or the browser whose click was credited.
          const since = job.consent ? job.at : 0
          if (job.metaUserAgent && ((refusals.get(job.subject) ?? -Infinity) >= since || (touch && (refusals.get(touch.subject) ?? -Infinity) >= since))) {
            selection.again.add(jobKey(job))
            return false
          }
          return true
        })
        if (!items.length) return
        const sending = items.map(item => ({ ...item, job: forTarget(item.job) }))
        request = (async () => target.deliver(action, sending))()
        // It can already be rejected while PostgreSQL is releasing the read locks.
        void request.catch(() => {})
      }, [...subjects])
    } catch (error) {
      // Once the request has started, a lost reply to the read transaction cannot take it back.
      if (!request) throw error
    }
    if (!request) return
    try {
      const { requestId } = await request
      for (const { job, consent } of items) {
        const { metaUserAgent, ...kept } = job
        const sent: Job = { ...kept, ...(job.transactionId.startsWith('call:') && target.restates && consent && { consent }), state: 'sent', delivered: true, ...(requestId && { requestId }) }
        if (!(await store.swap(job, sent))) await change(job, (current) => landed(job, current, target), sent)
        pass.sent += 1
      }
    } catch (error) {
      const note = noteOf(error, items.flatMap(({ job }) => Object.values(job.keys)))
      if (target.retryable(error)) {
        for (const { job } of items) {
          if (job.attempts >= maxAttempts) await fail(job, note, pass, failed)
          else if (await store.swap(job, { ...job, due: now() + backoff(job.attempts), note: privateNote(job, note) })) pass.retried += 1
        }
      } else if (items.length > 1) {
        // A platform rejects a whole request for one bad event. Send each alone to find it.
        for (const item of items) await deliver(target, action, [item], pass, failed, selection)
      } else await fail(items[0]!.job, note, pass, failed)
    }
  }

  async function sendClaimed(claimed: readonly Job[], pass: Pass, failed: Job[]): Promise<Job[]> {
    const selection: Selection = { party: await graph.partyRevision(), again: new Set() }
    const groups = new Map<string, { target: Target; action: string; items: Item[] }>()
    const attributions = new Map<string, Attribution>()
    const spurned = await graph.notLeads(claimed.map((job) => job.transactionId))
    const contacts = new Map<Subject, { email?: string; phone?: string }>()
    /** The keys a platform makes of one value, or none where it cannot be read as an email or a number. */
    const hashed = (target: Target, value: { email: string } | { phone: string }): Record<string, string> => {
      try {
        return target.keys(value as Outcome)
      } catch {
        return {}
      }
    }
    for (const stored of claimed) {
      // One that was sent with keys from the record, or waits to be sent again, has them made anew below.
      const job = stored.note === 'call_party' ? stored : unfiled(stored)
      // Said to be no lead before it was queued. It waits, and one that is taking a conversion back goes out.
      if (spurned.has(job.transactionId) && !job.withdrawn) {
        await change(job, (current) => (current.withdrawn ? undefined : takenBack(current)))
        // Taken back in between, it is given back, because whoever did that may have found nothing to give.
        if ((await graph.notLeads([job.transactionId])).size === 0) await outbox.giveBack(job.transactionId)
        continue
      }
      const skip = async (note: string) => {
        const { metaUserAgent, ...kept } = job
        if (await store.swap(job, { ...kept, state: 'skipped', note: privateNote(job, note) })) pass.skipped += 1
      }
      const target = targets.get(job.target)
      if (!target) {
        await fail(job, 'unknown_target', pass, failed)
        continue
      }
      if (job.consent && !job.consent.adUserData) {
        await skip('consent_denied')
        continue
      }
      if (target.maxAge !== undefined && now() - job.at > target.maxAge) {
        await skip('too_old')
        continue
      }
      const key = `${job.target}\u0000${job.action}`
      const group = groups.get(key) ?? { target, action: job.action, items: [] }
      groups.set(key, group)
      if (job.note === 'call_party') {
        if (reached(job) && target.restates && (job.click || Object.keys(job.keys).length)) {
          // Only replay the match already sent. A click seen on the new record cannot identify the original conversion.
          const touch = job.click && { ...job.click, subject: job.transactionId, at: job.at, confidence: job.confidence ?? 1, joined: false, via: [] }
          group.items.push({ job, touch, consent: job.consent })
        } else await skip('call_party')
        continue
      }
      const asked = `${job.subject}\u0000${job.at}`
      let attribution = attributions.get(asked)
      if (!attribution) attributions.set(asked, (attribution = await graph.attribute(job.subject, { at: job.at, window: options.window ?? 90 * DAY })))
      // A person's own click counts however weak the chain to it, unless a lowest confidence was asked for.
      const touches = attribution.touches.filter((each) => each.confidence >= confidence || (each.joined && options.confidence === undefined))
      const touch = target.click({ ...attribution, touches, credited: touches[0], reason: touches[0] ? 'credited' : attribution.touches[0] ? 'low_confidence' : 'no_touch' }, 0)
      const subjects = touch && touch.subject !== job.subject ? [job.subject, touch.subject] : [job.subject]
      // With no consent on the outcome, use what the person and the browser that clicked told us.
      let consent = job.consent
      if (consent) {
        // What the outcome said was true when it happened. A refusal given since is newer, so it decides.
        const since = (await Promise.all(subjects.map((subject) => graph.consentHistory(subject, 1)))).flat().filter((answer) => answer.at >= job.at)
        if (since.some((answer) => !answer.adUserData)) {
          await skip('consent_denied')
          continue
        }
        if (since.some((answer) => !answer.adPersonalization)) consent = { ...consent, adPersonalization: false }
      } else {
        const known = [...(await graph.consentOf(subjects)).values()]
        if (known.some((each) => !each.adUserData)) {
          await skip('consent_denied')
          continue
        }
        if (known.length === subjects.length) consent = { adUserData: true, adPersonalization: known.every((each) => each.adPersonalization) }
      }
      // The outcome named no email or phone, the record has one, and the person agreed to their data going to ad platforms.
      if (consent?.adUserData) {
        if (!contacts.has(job.subject)) contacts.set(job.subject, await graph.contactOf(job.subject))
        const { email, phone } = contacts.get(job.subject)!
        const made = { ...(email !== undefined && hashed(target, { email })), ...(phone !== undefined && hashed(target, { phone })) }
        const filed = Object.keys(made).filter((name) => !(name in job.keys))
        if (filed.length > 0) Object.assign(job, { keys: { ...made, ...job.keys }, filed })
      }
      if (!touch && Object.keys(job.keys).length === 0) {
        // Whose it is can come out later: they open a link, or call again. Looked at less and less often, it is given up on in the end.
        const age = now() - job.at
        const until = Math.ceil(job.at + (options.patience ?? 7 * DAY))
        if (now() >= until) await skip('no_match_key')
        else if (await store.swap(job, { ...job, attempts: job.attempts - 1, due: Math.min(until, now() + Math.max(10 * 60_000, Math.ceil(age / 4))), note: 'no_match_key' })) pass.retried += 1
        continue
      }
      // It waited for this, and waits no more.
      if (job.note === 'no_match_key') delete job.note
      group.items.push({ job: { ...job, ...(touch && { confidence: touch.confidence }) }, touch, consent })
    }
    for (const { target, action, items } of groups.values()) {
      for (let i = 0; i < items.length; i += target.batch) await deliver(target, action, items.slice(i, i + target.batch), pass, failed, selection)
    }
    // Prepare the original claim again. A refused adapter may have stamped its old click on the item it was given.
    return claimed.filter((job) => selection.again.has(jobKey(job)))
  }

  /** The jobs of an outcome, one for each platform its action names. */
  async function prepare(outcome: Outcome, state: 'pending' | 'held'): Promise<Job[]> {
    const { transactionId, subject, at } = outcome
    if (!transactionId || !subject) throw malformed('An outcome requires a transactionId and a subject')
    if (!Number.isSafeInteger(at)) throw malformed(`Outcome "${transactionId}" requires "at", an integer in epoch milliseconds`)
    let actions = outcome.action
    if (typeof actions === 'string') {
      if (targets.size > 1) throw malformed(`Outcome "${transactionId}" must name its action per target, such as { google: '…' }`)
      actions = { [options.targets[0]!.name]: actions }
    }
    const named = Object.entries(actions ?? {})
    if (named.some(([, action]) => !action)) throw malformed(`Outcome "${transactionId}" names a target with no action`)
    for (const [name] of named) if (!targets.has(name)) throw malformed(`Outcome "${transactionId}" names an unknown target "${name}"`)
    let metaUserAgent: string | undefined
    if (state === 'pending' && targets.get('meta')?.clientUserAgent && named.some(([name]) => name === 'meta') && (outcome.source ?? 'WEB') === 'WEB' && outcome.consent?.adUserData !== false) {
      const agent = outcome.userAgent
      if (typeof agent === 'string' && /^[^\p{Cc}\p{Cs}]{1,1024}$/u.test(agent)) {
        const saved = (await graph.consentOf([subject])).get(subject)
        if (saved?.adUserData !== false && (outcome.consent?.adUserData ?? saved?.adUserData)) metaUserAgent = agent
      }
    }
    return named.map(([name, action]) => ({
      transactionId,
      target: name,
      subject,
      at,
      action,
      ...(outcome.value !== undefined && { value: outcome.value }),
      ...(outcome.currency && { currency: outcome.currency }),
      ...(outcome.source && { source: outcome.source }),
      keys: targets.get(name)!.keys(outcome),
      ...(name === 'meta' && metaUserAgent && { metaUserAgent }),
      ...(outcome.consent && { consent: outcome.consent }),
      state,
      attempts: 0,
      due: now() + (options.delay ?? 0),
    }))
  }

  async function add(outcome: Outcome, jobs: readonly Job[], counted: Counted | undefined): Promise<Job[]> {
    const out: Job[] = []
    for (const job of jobs) {
      const stored = await store.add(counted ? worthNow(job, counted) : job, true)
      if (!stored) continue
      const same =
        stored.subject === job.subject &&
        stored.at === job.at &&
        stored.action === job.action &&
        (stored.restated || stored.value === job.value) &&
        JSON.stringify(Object.entries(unfiled(stored).keys).sort()) === JSON.stringify(Object.entries(job.keys).sort())
      if (!same) throw refused(`Outcome "${outcome.transactionId}" was already recorded with different details`, { reason: 'KEY_REUSED', fields: [] })
      out.push(stored)
    }
    return out
  }

  /** Brings the jobs of an outcome to what it is worth on record, and answers with those that changed. */
  async function settle(transactionId: string): Promise<Job[]> {
    const changed: Job[] = []
    for (const job of await store.get(transactionId)) {
      let done = false
      let last: Job | undefined
      // Until nothing is left to change. A worth that came and went again while one was stored changed no job.
      do {
        done = false
        const next = await change(job, async (current) => {
          done = false
          // Read after the job, so whoever changes the worth later changes the job later too.
          const outcome = await graph.outcomeOf(transactionId)
          const worth = outcome && !current.withdrawn ? worthNow(current, outcome) : current
          // One that never arrived is sent when it would have been. One that did is sent again where the platform takes it.
          if (worth === current || (reached(current) && (current.state === 'skipped' || current.state === 'held' || !targets.get(current.target)?.restates))) return undefined
          done = true
          return reached(current) ? { ...worth, state: 'pending', attempts: 0, due: now(), note: 'restated' } : worth
        })
        if (done) last = next
      } while (done)
      if (last) changed.push(last)
    }
    return changed
  }

  const outbox: Outbox = {
    async record(outcome) {
      const jobs = await prepare(outcome, 'pending')
      // Counted first, because it checks the rest of the outcome, and a job must never be queued for an outcome the report refused.
      await graph.outcome(outcome)
      const counted = await graph.outcomeOf(outcome.transactionId)
      const added = await add(outcome, jobs, counted)
      // Paid for while it was added.
      const settled = new Map((await settle(outcome.transactionId)).map((job) => [job.target, job]))
      return added.map((job) => settled.get(job.target) ?? job)
    },

    async hold(outcome) {
      // One already held, or on its way, stands as it is; a platform left out when this was cut off is added.
      return Promise.all((await prepare(outcome, 'held')).map(async (job) => (await store.add(job))!))
    },

    async release(outcome) {
      const before = await store.get(outcome.transactionId)
      if (before.length === 0) return outbox.record(outcome)
      await graph.outcome(outcome)
      return Promise.all(
        before.map((job) =>
          change(job, async (current) =>
            current.state === 'held' || current.withdrawn ? givenBack(current, (await graph.outcomeOf(outcome.transactionId)) ?? outcome) : undefined,
          ),
        ),
      )
    },

    async withdraw(transactionId) {
      await graph.withdraw(transactionId)
      return Promise.all((await store.get(transactionId)).map((job) => change(job, (current) => (current.withdrawn ? undefined : takenBack(current)))))
    },

    async takeBack(transactionId) {
      return Promise.all((await store.get(transactionId)).map((job) => change(job, (current) => (current.withdrawn ? undefined : takenBack(current)))))
    },

    async giveBack(transactionId) {
      return Promise.all((await store.get(transactionId)).map((job) => change(job, async (current) => {
        const outcome = await graph.outcomeOf(transactionId)
        if (!outcome) return undefined
        if (current.withdrawn) return givenBack(current, outcome)
        // Marked and given back before any pass saw it, it was never held, and may have been restated meanwhile.
        const next = current.state === 'pending' && !reached(current) ? worthNow(current, outcome) : current
        return next === current ? undefined : next
      })))
    },

    async restate(transactionId, value, currency, kind) {
      // A loss is of something counted. Without it there is nothing to say what was lost.
      if (!(await graph.restate(transactionId, value, currency, kind)) && kind) return []
      const changed: Job[] = []
      for (const job of await store.get(transactionId)) {
        if (!targets.get(job.target)?.restates) continue
        let done = false
        const next = await change(job, async (current) => {
          done = !(current.state === 'skipped' || current.state === 'held' || current.withdrawn)
          if (!done) return undefined
          // Read after the job, so whoever restates later changes the job later too. One with no outcome on record is worth what was said.
          const outcome = await graph.outcomeOf(transactionId)
          const worth = outcome ? { value: outcome.value, ...(outcome.currency && { currency: outcome.currency }) } : { value, ...(currency && { currency }) }
          return { ...current, ...worth, restated: true, state: 'pending', attempts: 0, due: now(), note: 'restated' }
        })
        if (done) changed.push(next)
      }
      return changed
    },

    async pay(payment) {
      const paid = await graph.pay(payment)
      // Told again when it is reported again, because the first time may have been cut off here.
      return { ...paid, jobs: paid.value === undefined ? [] : await settle(payment.transactionId) }
    },

    retraction: { targets: options.targets.filter((target) => target.forget).map((target) => target.name), always: options.retractOnForget ?? false },
    revalue: settle,
    canRetract: (target) => Boolean(targets.get(target)?.forget),
    async retract(jobs) {
      const sent = sentOf(jobs)
      for (const [name, target] of targets) {
        const theirs = jobs.filter((job) => job.target === name && reached(job))
        if (!target.forget) continue
        for (let i = 0; i < theirs.length; i += target.batch) {
          const some = theirs.slice(i, i + target.batch)
          const keys = some.flatMap((job) => [...Object.values(job.keys), ...Object.values(job.click ?? {})])
          let refusals: (string | undefined)[]
          try {
            refusals = await target.forget(some.map(forTarget))
          } catch (error) {
            refusals = some.map(() => String((error as Error)?.message ?? error))
          }
          some.forEach((job, j) => {
            const found = sent.find((each) => each.transactionId === job.transactionId && each.target === name)!
            const refusal = refusals[j]
            if (refusal === undefined) found.state = 'accepted'
            else [found.state, found.note] = ['rejected', noteOf(refusal, keys)]
          })
        }
      }
      return sent
    },
    async forget(subject, why, { retract = false } = {}) {
      let jobs: Job[] = []
      const changes = await graph.forget(subject, why, (gone) => void (jobs = gone))
      return { changes, sent: options.retractOnForget || retract ? await outbox.retract(jobs) : sentOf(jobs) }
    },

    async run() {
      const pass: Pass = { sent: 0, skipped: 0, failed: 0, retried: 0 }
      const failed: Job[] = []
      const claimed = await store.claim(now(), lease, options.batch ?? 500)
      if (claimed.length) for (const job of await sendClaimed(claimed, pass, failed)) {
        // Give each still-current job its own fresh reading. Repeated corrections release the claim for the next pass at once.
        if ((await sendClaimed([job], pass, failed)).length && await store.swap(job, { ...job, due: now(), attempts: job.attempts - 1 })) pass.retried++
      }
      if (failed.length > 0 && options.onFailed) {
        try {
          await options.onFailed(failed)
        } catch (error) {
          console.error(error)
        }
      }
      return pass
    },

    start(interval, onError = console.error) {
      let running = false
      const timer = setInterval(async () => {
        if (running) return
        running = true
        try {
          await outbox.run()
        } catch (error) {
          onError(error)
        } finally {
          running = false
        }
      }, interval)
      timer.unref?.()
      return () => clearInterval(timer)
    },

    get: (transactionId) => store.get(transactionId),
    list: (state, limit = 100) => store.list(state, limit),

    async retry(transactionId, target) {
      const again: Job[] = []
      for (const job of await store.get(transactionId)) {
        if ((job.state !== 'failed' && job.state !== 'skipped') || (target !== undefined && job.target !== target)) continue
        const next = await change(job, (current) => (current.state === 'failed' || current.state === 'skipped' ? { ...current, state: 'pending', attempts: 0, due: now(), note: 'retried' } : undefined))
        if (next.state === 'pending') again.push(next)
      }
      return again
    },

    counts: () => store.counts(),
  }
  return outbox
}

const jobKey = (job: { transactionId: string; target: string }) => `${job.transactionId}\u0000${job.target}`

/** An outbox store in process memory, for tests and demos. `recorded` says whether a job's outcome is on record. */
export function createMemoryOutbox(recorded: (job: Job) => boolean = () => true, partyRevision: () => string | undefined = () => undefined, refusals: (subjects: readonly Subject[]) => Map<Subject, number> = () => new Map(), made: <K, V>() => Map<K, V> = () => new Map()): OutboxStore & { remove(subject: Subject): Promise<Job[]>; jobs: Map<string, Job> } {
  const jobs = made<string, Job>()
  const unchanged = (job: Job) => {
    const stored = jobs.get(jobKey(job))
    return stored !== undefined && stored.rev === job.rev
  }
  return {
    jobs,
    async add(job, counted) {
      if (!jobs.has(jobKey(job)) && counted && !recorded(job)) return undefined
      if (!jobs.has(jobKey(job))) jobs.set(jobKey(job), structuredClone({ ...job, rev: 0 }))
      return structuredClone(jobs.get(jobKey(job))!)
    },
    async claim(now, lease, limit) {
      const due = [...jobs.values()].filter((job) => job.state === 'pending' && job.due <= now).sort((x, y) => x.due - y.due)
      return due.slice(0, limit).map((job) => {
        job.attempts += 1
        job.due = now + lease
        job.rev! += 1
        return structuredClone(job)
      })
    },
    async swap(before, after) {
      if (!unchanged(before)) return false
      jobs.set(jobKey(after), structuredClone({ ...after, rev: before.rev! + 1 }))
      return true
    },
    async standing(given) {
      return given.filter(unchanged)
    },
    async start(given, send, subjects = []) {
      send(given.filter(unchanged), partyRevision(), refusals(subjects))
    },
    // A read that copies what it finds walks the jobs without the store's journal, so a write that asks pays only for what it changes.
    async get(transactionId) {
      return [...Map.prototype.values.call(jobs)].filter((job) => job.transactionId === transactionId).map((job) => structuredClone(job))
    },
    async list(state, limit) {
      const found = [...Map.prototype.values.call(jobs)].filter((job) => job.state === state)
      return found.sort((x, y) => y.due - x.due || (x.transactionId < y.transactionId ? -1 : 1)).slice(0, limit).map((job) => structuredClone(job))
    },
    async oldestDue() {
      let oldest: number | undefined
      for (const job of jobs.values()) if (job.state === 'pending' && !(job.due >= oldest!)) oldest = job.due
      return oldest
    },
    async counts() {
      const out: Record<JobState, number> = { held: 0, pending: 0, sent: 0, skipped: 0, failed: 0 }
      for (const job of jobs.values()) out[job.state] += 1
      return out
    },
    async remove(subject) {
      const gone: Job[] = []
      for (const [id, job] of jobs) if (job.subject === subject && jobs.delete(id)) gone.push(job)
      return gone
    },
  }
}
