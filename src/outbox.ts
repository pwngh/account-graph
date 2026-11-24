import type { Graph } from './graph.ts'
import type { Attribution, AttributedTouch, Consent, Outcome, Subject } from './types.ts'

export type { Outcome }

export type JobState = 'pending' | 'sent' | 'skipped' | 'failed'

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
  /** Why it was skipped, failed, or is waiting to retry. */
  note?: string
  /** The click that was sent, and how strongly the graph tied it to the subject. */
  click?: Record<string, string>
  confidence?: number
  /** The platform's id for the request that carried it. */
  requestId?: string
  /** Its value was changed after it was first recorded. */
  restated?: boolean
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
  save(job: Job): Promise<void>
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
    await store.save(dead)
    failed.push(dead)
    pass.failed += 1
  }

  async function deliver(target: Target, action: string, items: readonly Item[], pass: Pass, failed: Job[]): Promise<void> {
    try {
      const { requestId } = await target.deliver(action, items)
      for (const { job } of items) {
        await store.save({ ...job, state: 'sent', ...(requestId && { requestId }) })
        pass.sent += 1
      }
    } catch (error) {
      const note = String((error as Error)?.message ?? error).slice(0, 500)
      if (target.retryable(error)) {
        for (const { job } of items) {
          if (job.attempts >= maxAttempts) await fail(job, note, pass, failed)
          else {
            await store.save({ ...job, due: now() + backoff(job.attempts), note })
            pass.retried += 1
          }
        }
      } else if (items.length > 1) {
        // A platform rejects a whole request for one bad event. Send each alone to find it.
        for (const item of items) await deliver(target, action, [item], pass, failed)
      } else await fail(items[0]!.job, note, pass, failed)
    }
  }

  const outbox: Outbox = {
    async record(outcome) {
      const { transactionId, subject, at } = outcome
      if (!transactionId || !subject) throw new TypeError('An outcome needs a transactionId and a subject')
      if (!Number.isFinite(at)) throw new TypeError(`Outcome "${transactionId}" needs a time in epoch milliseconds`)
      let actions = outcome.action
      if (typeof actions === 'string') {
        if (targets.size > 1) throw new TypeError(`Outcome "${transactionId}" must name its action per target, such as { google: '…' }`)
        actions = { [options.targets[0]!.name]: actions }
      }
      const named = Object.entries(actions ?? {})
      if (named.some(([, action]) => !action)) throw new TypeError(`Outcome "${transactionId}" names a target with no action`)
      for (const [name] of named) if (!targets.has(name)) throw new TypeError(`Outcome "${transactionId}" names an unknown target "${name}"`)

      // Counted first: it checks the rest of the outcome, and a job must never be queued for an outcome the report refused.
      await graph.outcome(outcome)
      const jobs: Job[] = []
      for (const [name, action] of named) {
        const job: Job = {
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
          state: 'pending',
          attempts: 0,
          due: now() + (options.delay ?? 0),
        }
        const stored = await store.add(job)
        const same =
          stored.subject === job.subject &&
          stored.at === job.at &&
          stored.action === job.action &&
          (stored.restated || stored.value === job.value) &&
          JSON.stringify(Object.entries(stored.keys).sort()) === JSON.stringify(Object.entries(job.keys).sort())
        if (!same) throw new TypeError(`Outcome "${transactionId}" was already recorded with different details`)
        jobs.push(stored)
      }
      return jobs
    },

    async restate(transactionId, value, currency) {
      await graph.restate(transactionId, value, currency)
      const changed: Job[] = []
      for (const job of await store.get(transactionId)) {
        if (!targets.get(job.target)?.restates || job.state === 'skipped') continue
        const next: Job = { ...job, value, ...(currency && { currency }), restated: true, state: 'pending', attempts: 0, due: now(), note: 'restated' }
        await store.save(next)
        changed.push(next)
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
          await store.save({ ...job, state: 'skipped', note })
          pass.skipped += 1
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
        const next: Job = { ...job, state: 'pending', attempts: 0, due: now(), note: 'retried' }
        await store.save(next)
        again.push(next)
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
  return {
    async add(job) {
      if (!jobs.has(key(job))) jobs.set(key(job), structuredClone(job))
      return structuredClone(jobs.get(key(job))!)
    },
    async claim(now, lease, limit) {
      const due = [...jobs.values()].filter((job) => job.state === 'pending' && job.due <= now).sort((x, y) => x.due - y.due)
      return due.slice(0, limit).map((job) => {
        job.attempts += 1
        job.due = now + lease
        return structuredClone(job)
      })
    },
    async save(job) {
      jobs.set(key(job), structuredClone(job))
    },
    async get(transactionId) {
      return [...jobs.values()].filter((job) => job.transactionId === transactionId).map((job) => structuredClone(job))
    },
    async list(state, limit) {
      const found = [...jobs.values()].filter((job) => job.state === state)
      return found.sort((x, y) => y.due - x.due || (x.transactionId < y.transactionId ? -1 : 1)).slice(0, limit).map((job) => structuredClone(job))
    },
    async counts() {
      const out: Record<JobState, number> = { pending: 0, sent: 0, skipped: 0, failed: 0 }
      for (const job of jobs.values()) out[job.state] += 1
      return out
    },
    async remove(subject) {
      for (const [id, job] of jobs) if (job.subject === subject) jobs.delete(id)
    },
  }
}
