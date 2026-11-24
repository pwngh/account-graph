import type { Alerter } from './alerts.ts'
import { followUp } from './calls.ts'
import type { Graph } from './graph.ts'
import { dayIn, sourceOf } from './report.ts'
import type { Touch } from './types.ts'

/** What the graph is fed with. A feed's time is when its last record was written down. */
export const FEEDS = ['touches', 'calls', 'results', 'costs'] as const
export type Feed = (typeof FEEDS)[number]

/** One kind of work that runs by itself, and how its last runs went. Times are epoch milliseconds. */
export interface JobRun {
  name: string
  started: number
  succeeded?: number
  failed?: number
  /** Why it failed, the last time it did. */
  error?: string
  /** When a run began that was given up on: nothing finished it within a quarter of an hour. */
  unfinished?: number
}

/** A message for a person, kept until it has been delivered. */
export interface KeptAlert {
  /** Adding a key that is already there adds nothing, so what it is about is said once. */
  key: string
  text: string
  at: number
  /** Whom it is about, so forgetting them deletes it. */
  subject?: string
  /** Why it could not be delivered, the last time it was tried. */
  error?: string
}

/** Where what runs by itself is written down. Each call is atomic on its own, and none of it counts as a write to the graph. */
export interface OpsStore {
  /** When each feed last wrote something. A feed that never did is absent. */
  feeds(): Promise<Map<Feed, number>>
  /** Notes that a job began. A run before it that began longer than `stuck` ago and never finished is noted as unfinished. */
  jobStarted(name: string, at: number, stuck: number): Promise<void>
  jobEnded(name: string, at: number, error?: string): Promise<void>
  jobs(): Promise<JobRun[]>
  /** Keeps an alert unless its key is already kept. Resolves to whether it was new. */
  addAlert(alert: KeptAlert): Promise<boolean>
  /** Keeps an alert as not delivered, in place of one with its key. */
  replaceAlert(alert: KeptAlert): Promise<void>
  /** Hands out undelivered alerts not handed out since `now - lease`, oldest first, so no two servers deliver one. */
  claimAlerts(now: number, lease: number, limit: number): Promise<KeptAlert[]>
  alertDelivered(key: string, at: number): Promise<void>
  alertFailed(key: string, error: string): Promise<void>
  /** Alerts not delivered yet, oldest first. */
  undelivered(limit: number): Promise<KeptAlert[]>
}

export interface OpsOptions {
  /** The webhook alerts are posted to. Without one, they are kept and shown as not delivered. */
  url?: string
  /** After how many hours of silence each feed is said to be quiet. One left out, or 0, is not watched. */
  quiet?: Partial<Record<Feed, number>>
  /** After how many hours a missed caller from a paid arrival, not reached since, is said to be waiting. 0 is never. */
  returnHours?: number
  /** The time zone times are written in. */
  timeZone?: string
  fetch?: typeof fetch
  now?: () => number
  /** Hears about an alert that could not be delivered. Defaults to `console.error`. */
  onError?: (error: unknown) => void
}

export interface OpsState {
  feeds: { name: Feed; last: number | null; hours: number; quiet: boolean }[]
  jobs: (JobRun & { state: 'running' | 'stuck' | 'done' | 'failed' })[]
  /** Alerts that have not been delivered. */
  undelivered: KeptAlert[]
  /** Whether a webhook is set. */
  alerts: boolean
  at: number
}

export interface Ops {
  /** Runs a job and writes down when it began and how it ended. */
  run<T>(name: string, work: () => Promise<T>): Promise<T>
  /** Posts an alert, at most one about the same thing in ten minutes. One that cannot be delivered is kept and tried again. */
  alert: Alerter
  /** Posts an alert the first time its key is seen, and never again. */
  once(key: string, text: string, subject?: string): Promise<void>
  /** Looks for quiet feeds and callers nobody has rung back, and tries again to deliver what was not. */
  check(): Promise<void>
  state(): Promise<OpsState>
  /** Posts a test alert and says whether it arrived. */
  test(): Promise<{ delivered: boolean; error?: string }>
}

const HOUR = 3_600_000
const STUCK = 15 * 60_000
/** How far back a missed call is still worth an alert. Older ones are in the Calls view. */
const LOOKBACK = 14 * 24 * HOUR

/** Whether an arrival was paid for: it carries an ad click, names a campaign by its id, or says so in its medium. */
export function paid(touch: Touch): boolean {
  return Boolean(touch.gclid || touch.gbraid || touch.wbraid || touch.fbclid || touch.msclkid || touch.ttclid || touch.campaignId) || /^(cpc|ppc|cpm|cpv|paid.*|display)$/i.test(touch.medium ?? '')
}

export function createOps(graph: Graph, store: OpsStore, options: OpsOptions = {}): Ops {
  const now = options.now ?? Date.now
  const started = now()
  const timeZone = options.timeZone ?? 'UTC'
  const when = (at: number) => new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(at)
  const problem = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 500)
  /** Posts a message. Resolves to why it could not be, or undefined when it was. */
  async function deliver(text: string): Promise<string | undefined> {
    if (!options.url) return 'No webhook is set. Set ALERT_WEBHOOK.'
    try {
      const response = await (options.fetch ?? fetch)(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 3000) }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`The alert webhook answered ${response.status}`)
      return undefined
    } catch (error) {
      onError(error)
      return problem(error)
    }
  }
  const onError = options.onError ?? console.error

  /** Delivers a kept alert, and writes down whether it arrived. */
  async function post({ key, text }: { key: string; text: string }): Promise<void> {
    const error = await deliver(text)
    if (error === undefined) await store.alertDelivered(key, now())
    else await store.alertFailed(key, error)
  }
  // When each kind was last sent, so it is not repeated within ten minutes.
  const sent = new Map<string, number>()

  const ops: Ops = {
    async run(name, work) {
      // Writing it down must not stop the work it is about.
      await store.jobStarted(name, now(), STUCK).catch(onError)
      try {
        const result = await work()
        await store.jobEnded(name, now()).catch(onError)
        return result
      } catch (error) {
        await store.jobEnded(name, now(), problem(error)).catch(onError)
        throw error
      }
    },

    async alert(about, text) {
      const at = now()
      if (at - (sent.get(about) ?? -Infinity) < 10 * 60_000) return false
      if (sent.size >= 1000) sent.clear()
      sent.set(about, at)
      const error = await deliver(text)
      const key = `last:${about}`
      // One that arrived also settles an earlier one of its kind that did not.
      if (error === undefined) await store.alertDelivered(key, at).catch(onError)
      else {
        // Nobody heard this one, so the next of its kind must not be held back.
        if (sent.get(about) === at) sent.delete(about)
        await store.replaceAlert({ key, text, at, error }).catch(onError)
      }
      return error === undefined
    },

    async once(key, text, subject) {
      if (await store.addAlert({ key, text, at: now(), ...(subject && { subject }) })) await post({ key, text })
    },

    async check() {
      const at = now()
      const feeds = await store.feeds()
      for (const feed of FEEDS) {
        const hours = options.quiet?.[feed] ?? 0
        const last = feeds.get(feed)
        if (!(hours > 0) || at - (last ?? started) < hours * HOUR) continue
        // Named after the last record, so one silence is said once and the next one again.
        await ops.once(`quiet:${feed}:${last ?? 'never'}`, `account-graph: no ${feed} for ${hours} ${hours === 1 ? 'hour' : 'hours'}. ${last === undefined ? 'None has ever been recorded.' : `The last was written down ${when(last)} (${timeZone}).`}`)
      }

      const hours = options.returnHours ?? 0
      if (hours > 0) {
        const seen = new Set<string>()
        let after: { at: number; id: string } | undefined
        for (;;) {
          const page = await graph.openCalls({ from: dayIn(at - LOOKBACK), to: dayIn(at), ...(after && { after }) })
          for (const { call, followUp: { attempts }, touch } of page) {
            if (call.at > at - hours * HOUR || call.at < at - LOOKBACK || seen.has(call.subject) || !touch || !paid(touch)) continue
            seen.add(call.subject)
            // Named after the first miss nobody has answered for, however old, so ringing again is not a new alert.
            const calls = await graph.callsOf([call.subject])
            const first = calls.find((each) => each.direction === 'inbound' && each.result?.answered === false && followUp(each, calls).state === 'open') ?? call
            const tries = attempts === 0 ? 'Nobody has rung back.' : attempts === 1 ? 'Rung back once, not reached.' : `Rung back ${attempts} times, not reached.`
            await ops.once(`unreturned:${call.subject}:${first.id}`, `account-graph: a caller from ${sourceOf(touch)}${touch.campaign || touch.campaignId ? `, ${touch.campaign || touch.campaignId}` : ''} has waited over ${hours} ${hours === 1 ? 'hour' : 'hours'} for a call back. Missed ${when(call.at)} (${timeZone}). ${tries} ${call.subject}`, call.subject)
          }
          if (page.length < 50) break
          after = page.at(-1)!.call
        }
      }

      for (const alert of await store.claimAlerts(now(), 60_000, 50)) await post(alert)
    },

    async state() {
      const at = now()
      const feeds = await store.feeds()
      return {
        feeds: FEEDS.map((name) => {
          const hours = options.quiet?.[name] ?? 0
          const last = feeds.get(name) ?? null
          return { name, last, hours, quiet: hours > 0 && at - (last ?? started) >= hours * HOUR }
        }),
        jobs: (await store.jobs()).map((job) => {
          const ended = Math.max(job.succeeded ?? 0, job.failed ?? 0)
          const state = job.started > ended ? (at - job.started >= STUCK ? 'stuck' : 'running') : (job.failed ?? 0) > (job.succeeded ?? 0) ? 'failed' : 'done'
          return { ...job, state } as const
        }),
        undelivered: await store.undelivered(50),
        alerts: options.url !== undefined,
        at,
      }
    },

    async test() {
      const error = await deliver('account-graph: this is a test alert. Nothing is wrong.')
      return error === undefined ? { delivered: true } : { delivered: false, error }
    },
  }
  return ops
}

/** Where a memory store keeps what runs by itself. `fed` is how its writes say what they fed, and `forget` how it loses a subject. */
export function createMemoryOps(): OpsStore & { fed(feed: Feed, at: number): void; forget(subject: string): void; prune(before: number): number } {
  const feeds = new Map<Feed, number>()
  const jobs = new Map<string, JobRun>()
  const alerts = new Map<string, KeptAlert & { delivered?: number; tried?: number }>()
  const open = () => [...alerts.values()].filter((alert) => alert.delivered === undefined).sort((x, y) => x.at - y.at)
  const bare = ({ delivered: _, tried: __, ...alert }: KeptAlert & { delivered?: number; tried?: number }): KeptAlert => alert
  return {
    fed: (feed, at) => void feeds.set(feed, Math.max(at, feeds.get(feed) ?? 0)),
    forget(subject) {
      for (const [key, alert] of alerts) if (alert.subject === subject) alerts.delete(key)
    },
    prune(before) {
      let gone = 0
      for (const [key, alert] of alerts) if (alert.delivered !== undefined && alert.at < before) gone += Number(alerts.delete(key))
      return gone
    },
    async feeds() {
      return new Map(feeds)
    },
    async jobStarted(name, at, stuck) {
      const before = jobs.get(name)
      const left = before && before.started > Math.max(before.succeeded ?? 0, before.failed ?? 0) && before.started <= at - stuck
      jobs.set(name, { ...before, name, started: at, ...(left && { unfinished: before.started }) })
    },
    async jobEnded(name, at, error) {
      const job = jobs.get(name)
      if (job) jobs.set(name, error === undefined ? { ...job, succeeded: at } : { ...job, failed: at, error })
    },
    async jobs() {
      return [...jobs.values()].sort((x, y) => (x.name < y.name ? -1 : 1)).map((job) => ({ ...job }))
    },
    async addAlert(alert) {
      if (alerts.has(alert.key)) return false
      // Whoever adds it is about to try it.
      alerts.set(alert.key, { ...alert, tried: alert.at })
      return true
    },
    async replaceAlert(alert) {
      alerts.set(alert.key, { ...alert, tried: alert.at })
    },
    async claimAlerts(now, lease, limit) {
      const due = open().filter((alert) => (alert.tried ?? 0) <= now - lease).slice(0, limit)
      for (const alert of due) alert.tried = now
      return due.map(bare)
    },
    async alertDelivered(key, at) {
      const alert = alerts.get(key)
      if (alert) alert.delivered = at
    },
    async alertFailed(key, error) {
      const alert = alerts.get(key)
      if (alert) alert.error = error
    },
    async undelivered(limit) {
      return open().slice(0, limit).map(bare)
    },
  }
}
