import { createHash, randomUUID } from 'node:crypto'
import type { Alerter } from './alerts.ts'
import { followUp } from './calls.ts'
import type { Graph } from './graph.ts'
import type { OutboxStore } from './outbox.ts'
import { longAgo } from './hours.ts'
import type { Hours } from './hours.ts'
import { dayIn, paid, sourceOf } from './report.ts'

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
  /** How the run that began last ended, whatever an older one did since. Absent while it has not. */
  outcome?: 'done' | 'failed'
  /** When each run that has begun and not ended began, newest first. */
  open: number[]
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
/** What is known of one feed: when it last wrote something, and since when someone has been watching it. */
export interface FeedNote {
  last?: number
  watched?: number
}

/** Where what runs by itself is written down. Each call is atomic on its own, and none of it counts as a write to the graph. */
export interface OpsStore {
  feeds(): Promise<Map<Feed, FeedNote>>
  /** Notes since when a feed has been watched, unless it already is. */
  watch(feed: Feed, at: number): Promise<void>
  /** Notes that a run of a job began. A run that began before `forgotten` and never ended is dropped. */
  jobStarted(run: string, name: string, at: number, forgotten: number): Promise<void>
  /** Notes that a run ended. Only the run it names, whatever else of that name is running. */
  jobEnded(run: string, name: string, at: number, error?: string): Promise<void>
  jobs(): Promise<JobRun[]>
  /** Keeps an alert unless its key is already kept. Resolves to whether it was new. */
  addAlert(alert: KeptAlert): Promise<boolean>
  /** Keeps an alert as not delivered. One with its key that is still waiting stays as it is; one that was delivered waits again. */
  keepAlert(alert: KeptAlert): Promise<void>
  /** Hands out the undelivered alert tried longest ago, if not since `before`, and notes that it is tried now, so no two servers deliver one. */
  claimAlert(now: number, before: number): Promise<KeptAlert | undefined>
  alertDelivered(key: string, at: number): Promise<void>
  alertFailed(key: string, error: string): Promise<void>
  /** Alerts not delivered yet, oldest first. */
  undelivered(): Promise<KeptAlert[]>
}

export interface OpsOptions {
  /** The webhook alerts are posted to. Without one, they are kept and shown as not delivered. */
  url?: string
  /** After how many hours of silence each feed is said to be quiet. One left out, or 0, is not watched. */
  quiet?: Partial<Record<Feed, number>>
  /** After how many hours a missed caller from a paid arrival, not reached since, is said to be waiting. 0 is never. */
  returnHours?: number
  /** Where what waits to be sent is kept, and after how many hours past its time it is said to be late. 0 is never. */
  outbox?: Pick<OutboxStore, 'oldestDue'>
  lateHours?: number
  /** When you are open. With it, silent calls and results and waiting callers are counted in hours you were open. */
  hours?: Hours
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
  /** Alerts that have not been delivered, oldest first. */
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
/** How long after it is due a missed call is still worth an alert. Older ones are in the Calls view. */
const LOOKBACK = 14 * 24 * HOUR
/** After how long a run that never ended is no longer shown. */
const FORGOTTEN = 30 * 24 * HOUR

/** The feeds that fall silent because you are closed. Visits come at night too, and costs when the platform sends them. */
const DESKS: readonly Feed[] = ['calls', 'results']

export function createOps(graph: Graph, store: OpsStore, options: OpsOptions = {}): Ops {
  const silentSince = (feed: Feed, at: number, hours: number) => longAgo(DESKS.includes(feed) ? options.hours : undefined, at, hours * HOUR)
  const now = options.now ?? Date.now
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
  async function post({ key, text }: { key: string; text: string }): Promise<boolean> {
    const error = await deliver(text)
    if (error === undefined) await store.alertDelivered(key, now())
    else await store.alertFailed(key, error)
    return error === undefined
  }
  // When each kind was last sent, so it is not repeated within ten minutes.
  const sent = new Map<string, number>()

  const ops: Ops = {
    async run(name, work) {
      // Writing it down must not stop the work it is about.
      const run = randomUUID()
      await store.jobStarted(run, name, now(), now() - FORGOTTEN).catch(onError)
      let result: Awaited<ReturnType<typeof work>>
      try {
        result = await work()
      } catch (error) {
        await store.jobEnded(run, name, now(), problem(error)).catch(onError)
        throw error
      }
      await store.jobEnded(run, name, now()).catch(onError)
      return result
    },

    async alert(about, text) {
      const at = now()
      if (at - (sent.get(about) ?? -Infinity) < 10 * 60_000) return false
      if (sent.size >= 1000) sent.clear()
      sent.set(about, at)
      const error = await deliver(text)
      // The same words are the same message, however often they could not be delivered. Other words are another.
      const key = `alert:${about}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
      if (error === undefined) await store.alertDelivered(key, at).catch(onError)
      else {
        // Nobody heard this one, so the next of its kind must not be held back.
        if (sent.get(about) === at) sent.delete(about)
        await store.keepAlert({ key, text, at, error }).catch(onError)
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
        const { last, watched } = feeds.get(feed) ?? {}
        if (!(hours > 0)) continue
        await store.watch(feed, at)
        if ((last ?? watched ?? at) > silentSince(feed, at, hours)) continue
        // Named after the last record, so one silence is said once and the next one again.
        await ops.once(`quiet:${feed}:${last ?? 'never'}`, `account-graph: no ${feed} for ${hours} ${options.hours && DESKS.includes(feed) ? 'open ' : ''}${hours === 1 ? 'hour' : 'hours'}. ${last === undefined ? 'None has ever been recorded.' : `The last was written down ${when(last)} (${timeZone}).`}`)
      }

      const late = options.lateHours ?? 0
      let due: number | undefined
      try {
        if (late > 0) due = await options.outbox?.oldestDue()
      } catch (error) {
        // What else there is to look for does not depend on the outbox.
        onError(error)
      }
      // Once a day while it lasts: a backlog that drains slowly has a new oldest job at every look.
      if (due !== undefined && at - due >= late * HOUR) await ops.once(`late:${dayIn(at, timeZone)}`, `account-graph: conversions are waiting to be sent. The oldest should have gone ${when(due)} (${timeZone}).`)

      const hours = options.returnHours ?? 0
      if (hours > 0) {
        // Due between these: not yet, and so long ago that the Calls view is where to look.
        const due = longAgo(options.hours, at, hours * HOUR)
        const past = longAgo(options.hours, at - LOOKBACK, hours * HOUR)
        const seen = new Set<string>()
        let after: { at: number; id: string } | undefined
        while (Number.isFinite(due)) {
          const page = await graph.openCalls({ from: dayIn(Math.max(0, past)), to: dayIn(at), ...(after && { after }) })
          for (const { call, followUp: { attempts }, touch } of page) {
            if (call.at > due || call.at < past || seen.has(call.subject) || !touch || !paid(touch)) continue
            seen.add(call.subject)
            // Named after the first miss nobody has answered for, however old, so ringing again is not a new alert.
            const calls = await graph.callsOf([call.subject])
            const first = calls.find((each) => each.direction === 'inbound' && each.result?.answered === false && followUp(each, calls).state === 'open') ?? call
            const tries = attempts === 0 ? 'Nobody has rung back.' : attempts === 1 ? 'Rung back once, not reached.' : `Rung back ${attempts} times, not reached.`
            await ops.once(`unreturned:${call.subject}:${first.id}`, `account-graph: a caller from ${sourceOf(touch)}${touch.campaign || touch.campaignId ? `, ${touch.campaign || touch.campaignId}` : ''} has waited over ${hours} ${options.hours ? 'open ' : ''}${hours === 1 ? 'hour' : 'hours'} for a call back. Missed ${when(call.at)} (${timeZone}). ${tries} ${call.subject}`, call.subject)
          }
          if (page.length < 50) break
          after = page.at(-1)!.call
        }
      }

      // One at a time, so a slow webhook never has two servers working through the same list. A webhook that
      // refuses one will refuse the rest, so the first that does not arrive ends the pass.
      const begun = now()
      const before = begun - 60_000
      // Well inside the time to the next look, so it never waits on a slow webhook.
      while (now() - begun < 120_000) {
        const alert = await store.claimAlert(now(), before)
        if (!alert || !(await post(alert))) break
      }
    },

    async state() {
      const at = now()
      const feeds = await store.feeds()
      return {
        feeds: FEEDS.map((name) => {
          const hours = options.quiet?.[name] ?? 0
          const { last, watched } = feeds.get(name) ?? {}
          return { name, last: last ?? null, hours, quiet: hours > 0 && (last ?? watched ?? at) <= silentSince(name, at, hours) }
        }),
        jobs: (await store.jobs()).map((job) => {
          const state = job.outcome ?? (at - job.started >= STUCK ? 'stuck' : 'running')
          return { ...job, open: job.open.filter((began) => at - began >= STUCK), state } as const
        }),
        undelivered: await store.undelivered(),
        alerts: options.url !== undefined,
        at,
      }
    },

    async test() {
      const text = 'account-graph: this is a test alert. Nothing is wrong.'
      const error = await deliver(text)
      if (error === undefined) return { delivered: true }
      await store.addAlert({ key: `test:${now()}`, text, at: now(), error })
      return { delivered: false, error }
    },
  }
  return ops
}

/** Where a memory store keeps what runs by itself. `fed` is how its writes say what they fed, and `forget` how it loses a subject. */
export function createMemoryOps(): OpsStore & { fed(feed: Feed, at: number): void; forget(subject: string): void } {
  const feeds = new Map<Feed, FeedNote>()
  const jobs = new Map<string, Omit<JobRun, 'open'> & { run?: string }>()
  const runs = new Map<string, { name: string; at: number }>()
  const alerts = new Map<string, KeptAlert & { delivered?: number; tried: number }>()
  const open = () => [...alerts.values()].filter((alert) => alert.delivered === undefined).sort((x, y) => x.at - y.at)
  const bare = ({ delivered: _, tried: __, ...alert }: KeptAlert & { delivered?: number; tried: number }): KeptAlert => alert
  return {
    fed: (feed, at) => void feeds.set(feed, { ...feeds.get(feed), last: Math.max(at, feeds.get(feed)?.last ?? 0) }),
    forget(subject) {
      for (const [key, alert] of alerts) if (alert.subject === subject) alerts.delete(key)
    },
    async feeds() {
      return new Map([...feeds].map(([feed, note]) => [feed, { ...note }]))
    },
    async watch(feed, at) {
      feeds.set(feed, { watched: at, ...feeds.get(feed) })
    },
    async jobStarted(run, name, at, forgotten) {
      for (const [id, each] of runs) if (each.name === name && each.at < forgotten) runs.delete(id)
      runs.set(run, { name, at })
      const { outcome: _, ...job } = jobs.get(name) ?? {}
      jobs.set(name, { ...job, name, started: at, run })
    },
    async jobEnded(run, name, at, error) {
      runs.delete(run)
      const job = jobs.get(name) ?? { name, started: at, run }
      jobs.set(name, { ...job, ...(error === undefined ? { succeeded: at } : { failed: at, error }), ...(job.run === run && { outcome: error === undefined ? ('done' as const) : ('failed' as const) }) })
    },
    async jobs() {
      const began = (name: string) => [...runs.values()].filter((run) => run.name === name).map((run) => run.at).sort((x, y) => y - x)
      return [...jobs.values()].sort((x, y) => (x.name < y.name ? -1 : 1)).map(({ run: _, ...job }) => ({ ...job, open: began(job.name) }))
    },
    async addAlert(alert) {
      if (alerts.has(alert.key)) return false
      // Whoever adds it has just tried it, or is about to.
      alerts.set(alert.key, { ...alert, tried: alert.at })
      return true
    },
    async keepAlert(alert) {
      if (alerts.get(alert.key)?.delivered === undefined && alerts.has(alert.key)) return
      alerts.set(alert.key, { ...alert, tried: alert.at })
    },
    async claimAlert(now, before) {
      const [due] = open().filter((alert) => alert.tried <= before).sort((x, y) => x.tried - y.tried)
      if (due) due.tried = now
      return due && bare(due)
    },
    async alertDelivered(key, at) {
      const alert = alerts.get(key)
      if (alert) alert.delivered = at
    },
    async alertFailed(key, error) {
      const alert = alerts.get(key)
      if (alert) alert.error = error
    },
    async undelivered() {
      return open().map(bare)
    },
  }
}
