import type { Graph } from './graph.ts'
import type { Attribution, AttributedTouch, Consent, Outcome, Subject } from './types.ts'

export type { Outcome }

/** `held` waits for whoever held it: it is not sent until it is released. */
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
  /** The email and phone of an outcome, hashed the way this platform matches them. */
  keys(outcome: Outcome): Record<string, string>
  /** The touch this platform can credit: the newest one that carries its click id at or above `confidence`. */
  click(attribution: Attribution, confidence: number): AttributedTouch | undefined
  /** Sends jobs that share an action in one request. Throws when the platform refuses. */
  deliver(action: string, items: readonly Item[]): Promise<{ requestId?: string }>
  /** Whether trying again could fix a refusal: a rate limit, an outage, a credential that needs repair. */
  retryable(error: unknown): boolean
  /** Most jobs in one request. */
  batch: number
  /** The platform refuses outcomes older than this many milliseconds. */
  maxAge?: number
  /** Sending an id again with a new value changes the value the platform recorded. */
  restates?: boolean
}

/** Where jobs are kept. Each call is atomic on its own. */
export interface OutboxStore {
  /** Stores the job unless one with its transaction id and target exists. Returns the stored job either way. */
  add(job: Job): Promise<Job>
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
  /** Every job of one transaction, one per target. */
  get(transactionId: string): Promise<Job[]>
  /** Jobs in one state, the most recently due first. */
  list(state: JobState, limit: number): Promise<Job[]>
  counts(): Promise<Record<JobState, number>>
  /** Deletes every job of a subject. */
  remove(subject: Subject): Promise<void>
}

export interface OutboxOptions {
  /** The platforms to send to. See `googleAds` and `meta`. */
  targets: readonly Target[]
  /** The lowest confidence at which a click is sent. Defaults to 0.9. */
  confidence?: number
  /** How far back a click may be. Defaults to 90 days. */
  window?: number
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
  /**
   * Changes the value of an outcome, for a refund or a corrected amount, and
   * sends it again to every platform that can restate. Others keep what they have.
   */
  restate(transactionId: string, value: number, currency?: string): Promise<Job[]>
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
  /** Sends every job that is due. Call it on a timer, from as many workers as you like. */
  run(): Promise<Pass>
  /** Calls `run` every `interval` milliseconds. Returns a function that stops it. */
  start(interval: number, onError?: (error: unknown) => void): () => void
  /** Every job of one transaction, one per platform. */
  get(transactionId: string): Promise<Job[]>
  /** Jobs in one state, the most recently due first: what failed, what was skipped and why. */
  list(state: JobState, limit?: number): Promise<Job[]>
  /** Puts a transaction's failed and skipped jobs back in line, after you fixed what stopped them. */
  retry(transactionId: string): Promise<Job[]>
  counts(): Promise<Record<JobState, number>>
}

const DAY = 86_400_000

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
  if (targets.size === 0) throw new TypeError('An outbox needs at least one target')

  /** Thirty seconds, doubling each try up to an hour, shortened by up to half so workers do not retry in step. */
  const backoff = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** (attempts - 1)) * (0.5 + random() / 2)

  /** Marks a job failed for good and remembers it for `onFailed`. */
  async function fail(job: Job, note: string, pass: Pass, failed: Job[]): Promise<void> {
    const dead: Job = { ...job, state: 'failed', note }
    if (!(await store.swap(job, dead))) return
    failed.push(dead)
    pass.failed += 1
  }

  /** Changes a stored job, starting again from what is stored whenever something else changed it first. */
  async function change(job: Job, make: (current: Job) => Job | undefined): Promise<Job> {
    for (;;) {
      const current = (await store.get(job.transactionId)).find((each) => each.target === job.target)
      // Forgotten meanwhile, or nothing to change.
      const next = current && make(current)
      if (!current || !next) return current ?? job
      if (await store.swap(current, next)) return { ...next, rev: (current.rev ?? 0) + 1 }
    }
  }

  /** Whether a job reached its platform. A job from before that was noted says so by its state, or by the request that carried it. */
  const reached = (job: Job) => Boolean(job.delivered || job.state === 'sent' || job.requestId)

  /** A job whose outcome was taken back: held if it never arrived, worth nothing where the platform can be told, and left where it cannot. */
  function takenBack(job: Job): Job {
    if (!reached(job)) return { ...job, withdrawn: true, state: 'held', attempts: 0, note: 'withdrawn' }
    const gone: Job = { ...job, delivered: true, withdrawn: true }
    if (!targets.get(job.target)?.restates) return { ...gone, state: 'sent', note: 'withdrawn, but this platform keeps it' }
    return { ...gone, value: 0, restated: true, state: 'pending', attempts: 0, due: now(), note: 'withdrawn' }
  }

  /**
   * A job that changed while `sent`, as it was before, was on its way. That
   * one arrived, and possibly after a newer one did, so what the job says
   * now is sent once more where the platform keeps the last value it hears.
   */
  function landed(sent: Job, current: Job, target: Target): Job | undefined {
    // Already known to have arrived, with the value it has now: there is nothing to put right.
    if (current.delivered && current.value === sent.value) return undefined
    const arrived: Job = { ...current, delivered: true }
    if (current.withdrawn) return takenBack(arrived)
    if (!target.restates || current.value === sent.value) return arrived
    return { ...arrived, restated: true, state: 'pending', attempts: 0, due: now() }
  }

  async function deliver(target: Target, action: string, claimed: readonly Item[], pass: Pass, failed: Job[]): Promise<void> {
    // What was taken back or changed since it was claimed is left to the next pass.
    const standing = new Set(await store.standing(claimed.map(({ job }) => job)))
    const items = claimed.filter(({ job }) => standing.has(job))
    if (items.length === 0) return
    try {
      const { requestId } = await target.deliver(action, items)
      for (const { job } of items) {
        const sent: Job = { ...job, state: 'sent', delivered: true, ...(requestId && { requestId }) }
        if (!(await store.swap(job, sent))) await change(job, (current) => landed(job, current, target))
        pass.sent += 1
      }
    } catch (error) {
      const note = String((error as Error)?.message ?? error).slice(0, 500)
      if (target.retryable(error)) {
        for (const { job } of items) {
          if (job.attempts >= maxAttempts) await fail(job, note, pass, failed)
          else if (await store.swap(job, { ...job, due: now() + backoff(job.attempts), note })) pass.retried += 1
        }
      } else if (items.length > 1) {
        // A platform rejects a whole request for one bad event. Send each alone to find it.
        for (const item of items) await deliver(target, action, [item], pass, failed)
      } else await fail(items[0]!.job, note, pass, failed)
    }
  }

  /** The jobs of an outcome, one for each platform its action names. */
  function prepare(outcome: Outcome, state: 'pending' | 'held'): Job[] {
    const { transactionId, subject, at } = outcome
    if (!transactionId || !subject) throw new TypeError('An outcome needs a transactionId and a subject')
    if (!Number.isSafeInteger(at)) throw new TypeError(`Outcome "${transactionId}" needs a time in whole epoch milliseconds`)
    let actions = outcome.action
    if (typeof actions === 'string') {
      if (targets.size > 1) throw new TypeError(`Outcome "${transactionId}" must name its action per target, such as { google: '…' }`)
      actions = { [options.targets[0]!.name]: actions }
    }
    const named = Object.entries(actions ?? {})
    if (named.some(([, action]) => !action)) throw new TypeError(`Outcome "${transactionId}" names a target with no action`)
    for (const [name] of named) if (!targets.has(name)) throw new TypeError(`Outcome "${transactionId}" names an unknown target "${name}"`)
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
      ...(outcome.consent && { consent: outcome.consent }),
      state,
      attempts: 0,
      due: now() + (options.delay ?? 0),
    }))
  }

  async function add(outcome: Outcome, jobs: readonly Job[]): Promise<Job[]> {
    const out: Job[] = []
    for (const job of jobs) {
      const stored = await store.add(job)
      const same =
        stored.subject === job.subject &&
        stored.at === job.at &&
        stored.action === job.action &&
        (stored.restated || stored.value === job.value) &&
        JSON.stringify(Object.entries(stored.keys).sort()) === JSON.stringify(Object.entries(job.keys).sort())
      if (!same) throw new TypeError(`Outcome "${outcome.transactionId}" was already recorded with different details`)
      out.push(stored)
    }
    return out
  }

  const outbox: Outbox = {
    async record(outcome) {
      const jobs = prepare(outcome, 'pending')
      // Counted first: it checks the rest of the outcome, and a job must never be queued for an outcome the report refused.
      await graph.outcome(outcome)
      return add(outcome, jobs)
    },

    async hold(outcome) {
      // One already held, or on its way, stands as it is; a platform left out when this was cut off is added.
      return Promise.all(prepare(outcome, 'held').map((job) => store.add(job)))
    },

    async release(outcome) {
      const before = await store.get(outcome.transactionId)
      if (before.length === 0) return outbox.record(outcome)
      await graph.outcome(outcome)
      return Promise.all(
        before.map((job) =>
          change(job, (current) => {
            if (current.state !== 'held' && !current.withdrawn) return undefined
            const { withdrawn: _, note: __, ...rest } = current
            if (!reached(current)) return { ...rest, state: 'pending', due: now() + (options.delay ?? 0) }
            // It had arrived, and may have been restated to nothing since: give it its value again.
            if (!targets.get(current.target)?.restates) return { ...rest, state: 'sent' }
            return { ...rest, value: outcome.value ?? 0, state: 'pending', attempts: 0, due: now() }
          }),
        ),
      )
    },

    async withdraw(transactionId) {
      await graph.withdraw(transactionId)
      return Promise.all((await store.get(transactionId)).map((job) => change(job, (current) => (current.withdrawn ? undefined : takenBack(current)))))
    },

    async restate(transactionId, value, currency) {
      await graph.restate(transactionId, value, currency)
      const changed: Job[] = []
      for (const job of await store.get(transactionId)) {
        if (!targets.get(job.target)?.restates) continue
        let done = false
        const next = await change(job, (current) => {
          done = !(current.state === 'skipped' || current.state === 'held' || current.withdrawn)
          return done ? { ...current, value, ...(currency && { currency }), restated: true, state: 'pending', attempts: 0, due: now(), note: 'restated' } : undefined
        })
        if (done) changed.push(next)
      }
      return changed
    },

    async run() {
      const pass: Pass = { sent: 0, skipped: 0, failed: 0, retried: 0 }
      const failed: Job[] = []
      const groups = new Map<string, { target: Target; action: string; items: Item[] }>()
      const attributions = new Map<string, Attribution>()
      for (const job of await store.claim(now(), lease, options.batch ?? 500)) {
        const skip = async (note: string) => {
          if (await store.swap(job, { ...job, state: 'skipped', note })) pass.skipped += 1
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
        const asked = `${job.subject}\u0000${job.at}`
        let attribution = attributions.get(asked)
        if (!attribution) attributions.set(asked, (attribution = await graph.attribute(job.subject, { at: job.at, window: options.window ?? 90 * DAY })))
        const touch = target.click(attribution, confidence)
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
        if (!touch && Object.keys(job.keys).length === 0) {
          await skip('no_match_key')
          continue
        }
        const key = `${job.target}\u0000${job.action}`
        const group = groups.get(key) ?? { target, action: job.action, items: [] }
        groups.set(key, group)
        group.items.push({ job: { ...job, ...(touch && { confidence: touch.confidence }) }, touch, consent })
      }
      for (const { target, action, items } of groups.values()) {
        for (let i = 0; i < items.length; i += target.batch) await deliver(target, action, items.slice(i, i + target.batch), pass, failed)
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

    async retry(transactionId) {
      const again: Job[] = []
      for (const job of await store.get(transactionId)) {
        if (job.state !== 'failed' && job.state !== 'skipped') continue
        const next = await change(job, (current) => (current.state === 'failed' || current.state === 'skipped' ? { ...current, state: 'pending', attempts: 0, due: now(), note: 'retried' } : undefined))
        if (next.state === 'pending') again.push(next)
      }
      return again
    },

    counts: () => store.counts(),
  }
  return outbox
}

/** An outbox store in process memory, for tests and demos. */
export function createMemoryOutbox(): OutboxStore {
  const jobs = new Map<string, Job>()
  const key = (job: { transactionId: string; target: string }) => `${job.transactionId}\u0000${job.target}`
  const unchanged = (job: Job) => {
    const stored = jobs.get(key(job))
    return stored !== undefined && stored.rev === job.rev
  }
  return {
    async add(job) {
      if (!jobs.has(key(job))) jobs.set(key(job), structuredClone({ ...job, rev: 0 }))
      return structuredClone(jobs.get(key(job))!)
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
      jobs.set(key(after), structuredClone({ ...after, rev: before.rev! + 1 }))
      return true
    },
    async standing(given) {
      return given.filter(unchanged)
    },
    async get(transactionId) {
      return [...jobs.values()].filter((job) => job.transactionId === transactionId).map((job) => structuredClone(job))
    },
    async list(state, limit) {
      const found = [...jobs.values()].filter((job) => job.state === state)
      return found.sort((x, y) => y.due - x.due || (x.transactionId < y.transactionId ? -1 : 1)).slice(0, limit).map((job) => structuredClone(job))
    },
    async counts() {
      const out: Record<JobState, number> = { held: 0, pending: 0, sent: 0, skipped: 0, failed: 0 }
      for (const job of jobs.values()) out[job.state] += 1
      return out
    },
    async remove(subject) {
      for (const [id, job] of jobs) if (job.subject === subject) jobs.delete(id)
    },
  }
}
