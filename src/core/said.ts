import type { CallParty, Loss } from '../contract/types.ts'

/**
 * What was said of something, kept as it was said. What it comes to is worked
 * out from all of it, so it does not depend on the order it arrived in: the
 * newest by when it was said, and then by its key, stands.
 */
export type Said = { about: string; key: string; at: number } & (
  | { topic: 'worth'; data: WorthSaid }
  | { topic: 'lead'; data: { kind: 'spam' | 'other' | null } }
  | { topic: 'result'; data: { answered: boolean; voicemail?: boolean; waited?: number } }
  | { topic: 'party'; data: CallParty & { by: string } }
  | { topic: 'return'; data: { reachedAt: number | null } }
)
export type Topic = Said['topic']
export type SaidOf<T extends Topic> = Extract<Said, { topic: T }>

export type WorthSaid =
  /** What it was worth before any of this. */
  | { kind: 'base'; value: number; currency: string }
  | { kind: 'correct'; value: number; currency?: string }
  | { kind: Loss; amount: number }
  | { kind: 'reverse'; restatement: string }

/** Bytes, and not a language's order, so every place that compares agrees. */
export const byKey = (x: string, y: string): number => Buffer.compare(Buffer.from(x), Buffer.from(y))
export const later = (x: { at: number; key: string }, y: { at: number; key: string }): number => x.at - y.at || byKey(x.key, y.key)

export const newest = <T extends { at: number; key: string }>(said: readonly T[]): T | undefined => said.reduce<T | undefined>((best, each) => (best === undefined || later(each, best) > 0 ? each : best), undefined)

const cents = (value: number) => Math.round(value * 1e5) / 1e5

/** What an outcome with no payment is worth, and how much of it was lost and how. A reversal undoes the one refund or write-off it names, wherever either comes. */
export function worthOf(said: readonly SaidOf<'worth'>[]): { value: number; currency: string; refunded: number; writtenOff: number; stands: string | undefined } | undefined {
  const base = said.find((each) => each.data.kind === 'base')
  if (!base || base.data.kind !== 'base') return undefined
  const undone = new Set(said.flatMap(({ data }) => (data.kind === 'reverse' ? [data.restatement] : [])))
  const correct = newest(said.filter((each) => each.data.kind === 'correct'))
  const from = correct?.data.kind === 'correct' ? correct.data : base.data
  const lost = (kind: Loss) => cents(said.reduce((sum, { key, data }) => (data.kind === kind && !undone.has(key) ? sum + data.amount : sum), 0))
  const [refunded, writtenOff] = [lost('refund'), lost('write_off')]
  return { value: Math.max(0, cents(from.value - refunded - writtenOff)), currency: ('currency' in from && from.currency) || base.data.currency, refunded, writtenOff, stands: correct?.key }
}
