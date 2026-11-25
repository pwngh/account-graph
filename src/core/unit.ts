import type { Store, Tx } from './store.ts'

/**
 * Runs `work` as one write, whatever it does: all of it or none. What it is
 * handed looks like the store, so a graph and an outbox made on it write and
 * read in that one transaction.
 */
export function unit<T>(store: Store, work: (inside: Store, tx: Tx) => Promise<T>): Promise<T> {
  return store.write((tx) => work({ write: (each) => tx.nested(() => each(tx)), read: (each) => each(tx), outbox: tx.outbox, ops: store.ops }, tx), { whole: true })
}
