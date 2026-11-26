import type { LocalOptions } from '../contract/api.ts'
import type { Engine } from '../core/engine.ts'
import { createWebhook } from '../core/delivery.ts'
import type { Ops } from '../core/ops.ts'
import { sendsPaused } from '../core/pause.ts'
import { costSourcesOf } from './providers.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export interface Workers {
  start(): void
  /** One pass of each, whether it is due or not. */
  pass(): Promise<void>
  stop(): Promise<void>
}

/** What runs by itself: sending, reading costs, looking for what is late, and telling of it. Each takes a lease, so many processes do it once. */
export function createWorkers(engine: Engine, ops: Ops, options: LocalOptions, log: (line: string) => void): Workers {
  const { store, outbox, graph, now } = engine
  const wait = (error: unknown) => String((error as Error)?.message ?? error)
  const jobs: { name: string; every: number; lease: number; work: () => Promise<unknown>; failed: (reason: string) => void }[] = []

  // Claims its own rows, so every process may send. A stop put on with `account-graph sends pause` holds every process.
  if (outbox) {
    jobs.push({
      name: 'outbox', every: 30_000, lease: 0, work: async () => ((await sendsPaused(store)) ? undefined : outbox.run()),
      failed: (reason) => void ops.alert('outbox', `account-graph: the outbox failed and conversions are not being sent. ${reason}`, { type: 'delivery.paused', at: now(), data: { reason } }),
    })
  }
  for (const [name, source] of costSourcesOf(options)) {
    jobs.push({
      name: `costs:${name}`, every: 6 * HOUR, lease: 10 * MINUTE,
      work: async () => {
        const at = now()
        const rows = await source(new Date(at - 7 * 24 * HOUR).toISOString().slice(0, 10), new Date(at).toISOString().slice(0, 10))
        await graph.spend(rows, { at, key: `pull ${name}` })
        log(`costs: ${rows.length} rows from ${name}`)
      },
      failed: (reason) => void ops.alert(`costs:${name}`, `account-graph: reading campaign costs from ${name} failed. ${reason}`, { type: 'costs.failed', at: now(), data: { source: name, reason } }),
    })
  }
  const auditHours = options.monitor?.auditHours ?? 0
  if (auditHours > 0) {
    jobs.push({
      name: 'audit head', every: Math.max(1, auditHours) * HOUR, lease: 10 * MINUTE,
      work: async () => {
        const { sound, brokenAt, head } = await graph.audit()
        if (head) await ops.alert('audit', `account-graph: audit log entry ${head.seq}, hash ${head.hash}. ${sound ? 'Verified.' : `Altered at entry ${brokenAt}.`} Store this outside the database.`, { type: 'audit.head', at: now(), data: { seq: head.seq, hash: head.hash, sound, brokenAt: brokenAt ?? null } })
      },
      failed: (reason) => log(`audit: ${reason}`),
    })
  }
  jobs.push({ name: 'checks', every: 5 * MINUTE, lease: 4 * MINUTE, work: () => ops.check(), failed: (reason) => log(`checks: ${reason}`) })
  if (options.webhook) {
    const webhook = createWebhook(store, { ...options.webhook, now, ...(options.fetch && { fetch: options.fetch }), onSkipped: ({ seq, reason }) => void ops.alert('webhook', `account-graph: the webhook refused events for a day, up to ${seq}, and they were passed over. ${reason}`) })
    jobs.push({ name: 'webhook', every: 5_000, lease: 0, work: () => webhook.run(), failed: (reason) => log(`webhook: ${reason}`) })
  }

  let stopped = false
  const timers: NodeJS.Timeout[] = []
  const running = new Map<string, Promise<void>>()
  const run = ({ name, work, failed }: (typeof jobs)[number]): Promise<void> => {
    const under = running.get(name)
    if (under) return under
    // Sending and posting go on all the time, so only what is done now and then is written down.
    const done = (name === 'webhook' ? work() : ops.run(name, work)).then(() => undefined, (error) => failed(wait(error))).finally(() => running.delete(name))
    running.set(name, done)
    return done
  }
  const due = async (job: (typeof jobs)[number]) => {
    if (stopped) return
    if (job.lease === 0) return run(job)
    const sink = `job ${job.name}`
    const turn = await store.write((tx) => tx.claimDelivery(sink, now(), job.lease))
    if (!turn) return
    // From when it began, and a little early, or the next look would always be too soon.
    const began = now()
    await run(job)
    await store.write((tx) => tx.setDelivery({ ...turn, due: began + job.every - 1000 }))
  }
  return {
    start() {
      for (const job of jobs) {
        const go = () => void due(job).catch((error) => log(`${job.name}: ${wait(error)}`))
        const timer = setInterval(go, Math.min(job.every, 5 * MINUTE))
        timer.unref()
        timers.push(timer)
        if (job.lease > 0) go()
      }
    },
    async pass() {
      for (const job of jobs) await run(job)
    },
    async stop() {
      stopped = true
      for (const timer of timers) clearInterval(timer)
      await Promise.all(running.values())
    },
  }
}
