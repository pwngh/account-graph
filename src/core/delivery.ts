import { signWebhook, SIGNATURE } from '../contract/webhook.ts'
import { cursorOf } from './events.ts'
import type { Store } from './store.ts'

export interface WebhookOptions {
  url: string
  secret: string
  fetch?: typeof fetch
  now?: () => number
  /** Hears when a receiver has refused an event for a day, and it is passed over. */
  onSkipped?: (skipped: { seq: number; reason: string }) => void | Promise<void>
}

const DAY = 86_400_000
const LEASE = 30_000
const MOST = 100

/**
 * Posts events to a receiver, in order and at least once. One process posts
 * at a time, whichever has the lease. One that keeps being refused is tried
 * for a day and then passed over: `events` still has it.
 */
export function createWebhook(store: Store, options: WebhookOptions) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  const backoff = (attempts: number) => Math.min(3_600_000, 30_000 * 2 ** (attempts - 1))
  /** Posts what there is. Resolves to how many events were delivered. */
  async function run(): Promise<number> {
    let delivered = 0
    for (;;) {
      const turn = await store.write((tx) => tx.claimDelivery('webhook', now(), LEASE))
      if (!turn) return delivered
      const { events, head } = await store.read(async (tx) => ({ events: await tx.eventsAfter(turn.seq, MOST + 1), head: await tx.eventHead() }))
      const page = events.slice(0, MOST)
      const last = page.at(-1)
      if (!last) {
        await store.write((tx) => tx.setDelivery({ ...turn, seq: turn.seq }))
        return delivered
      }
      const body = JSON.stringify({ schemaVersion: 1, cursor: cursorOf(head, last.seq), more: events.length > MOST, events: page })
      let reason: string | undefined
      try {
        const response = await fetcher(options.url, { method: 'POST', headers: { 'content-type': 'application/json', [SIGNATURE]: await signWebhook(options.secret, now(), body) }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
        if (!response.ok) reason = `it answered ${response.status}`
      } catch (error) {
        reason = String((error as Error)?.message ?? error)
      }
      if (reason === undefined) {
        delivered += page.length
        await store.write((tx) => tx.setDelivery({ sink: 'webhook', seq: last.seq, due: 0, attempts: 0 }))
        if (events.length <= MOST) return delivered
        continue
      }
      const since = turn.since ?? now()
      if (now() - since >= DAY) {
        await store.write((tx) => tx.setDelivery({ sink: 'webhook', seq: last.seq, due: 0, attempts: 0 }))
        await options.onSkipped?.({ seq: last.seq, reason })
        continue
      }
      const attempts = turn.attempts + 1
      await store.write((tx) => tx.setDelivery({ ...turn, attempts, since, due: now() + backoff(attempts) }))
      return delivered
    }
  }
  return { run }
}
