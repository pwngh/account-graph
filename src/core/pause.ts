/**
 * A stop on sends to ad platforms, kept in the database so every process
 * obeys it. While it stands, the outbox worker sends nothing and jobs wait as
 * they are. Taking it back lets them go on the next pass.
 */
import type { Store } from './store.ts'

const SETTING = 'sendsPaused'

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

export async function resumeSends(store: Store): Promise<void> {
  await store.write((tx) => tx.setSetting(SETTING, ''))
}
