/**
 * A stop on sends to ad platforms, kept in the database so every process
 * obeys it. While it stands, the outbox worker sends nothing and jobs wait as
 * they are. Taking it back lets them go on the next pass.
 */
import type { Store, Tx } from './store.ts'

const SETTING = 'sendsPaused'
const FAILURES = 'failuresThisHour'
const HOUR = 3_600_000

/** When the stop was put on, in epoch milliseconds, and why. */
export interface Paused {
  at: number
  reason: string
}

/** The stop that stands, or undefined when sends go. */
export async function sendsPaused(store: Store): Promise<Paused | undefined> {
  const value = await store.read((tx) => tx.settingOf(SETTING))
  if (!value) return undefined
  try {
    const { at, reason } = JSON.parse(value) as Partial<Paused>
    if (typeof at === 'number' && typeof reason === 'string') return { at, reason }
  } catch {}
  // A value nobody can read still stops sends. Taking the stop back clears it.
  return { at: 0, reason: 'unreadable' }
}

export async function pauseSends(store: Store, reason: string, at: number): Promise<void> {
  await store.write((tx) => tx.setSetting(SETTING, JSON.stringify({ at, reason })))
}

/** Takes the stop back. The count of failures starts again, so the failures that put it on cannot put it on again. */
export async function resumeSends(store: Store): Promise<void> {
  await store.write(async (tx) => {
    await tx.setSetting(SETTING, '')
    await tx.setSetting(FAILURES, '')
  })
}

/**
 * Counts conversions that failed for good, in the transaction that records them, so every process adds to one count.
 * The count starts again an hour after its first failure. Resolves to the reason when this puts the stop on, and
 * undefined when it does not, or a stop already stands.
 */
export async function countFailures(tx: Tx, failed: number, at: number, limit: number): Promise<string | undefined> {
  if (!(limit > 0) || failed <= 0) return undefined
  let window = { start: at, count: 0 }
  try {
    const kept = JSON.parse((await tx.settingOf(FAILURES)) || 'null') as typeof window | null
    if (kept && typeof kept.start === 'number' && typeof kept.count === 'number' && at - kept.start < HOUR) window = kept
  } catch {}
  window.count += failed
  await tx.setSetting(FAILURES, JSON.stringify(window))
  if (window.count < limit || (await tx.settingOf(SETTING))) return undefined
  const reason = `${window.count} conversions failed for good within an hour, and PAUSE_AFTER_FAILURES is ${limit}`
  await tx.setSetting(SETTING, JSON.stringify({ at, reason }))
  return reason
}
