import type { GraphEvent } from '../contract/api.ts'

/** Something that happened, before it has a number. */
export type NewEvent = { [T in GraphEvent['type']]: { type: T; at: number; data: Extract<GraphEvent, { type: T }>['data']; /** Whom it is about, so forgetting them deletes it. */ subject?: string; /** Said once: another with the same name is not. */ once?: string } }[GraphEvent['type']]

/** Where events stand: the newest number, the oldest that is kept, and which history these numbers are of. */
export interface EventHead {
  seq: number
  epoch: string
  oldest: number
}

/** Where one receiver of events has got to. */
export interface Delivery {
  sink: string
  seq: number
  due: number
  attempts: number
  /** When the event it is waiting on was first refused. */
  since?: number
}

export const cursorOf = ({ epoch }: Pick<EventHead, 'epoch'>, seq: number): string => `${epoch}.${seq}`

/** The number a cursor stands at, or undefined where it is not of this history, or more than what there is, or of what is no longer kept. */
export function seqOf(head: EventHead, cursor: string | null): number | undefined {
  if (cursor === null) return 0
  const cut = cursor.lastIndexOf('.')
  const seq = Number(cursor.slice(cut + 1))
  if (cut < 1 || cursor.slice(0, cut) !== head.epoch || !/^\d{1,15}$/.test(cursor.slice(cut + 1)) || seq > head.seq || seq < head.oldest - 1) return undefined
  return seq
}
