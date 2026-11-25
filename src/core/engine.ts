import type { Change } from '../contract/types.ts'
import { createGraph } from './graph.ts'
import type { Graph } from './graph.ts'
import { createOutbox } from './outbox.ts'
import type { Outbox, OutboxOptions } from './outbox.ts'
import { defaultPolicy } from './policy.ts'
import type { Policy } from './policy.ts'
import { createService } from './service.ts'
import type { Service, ServiceOptions } from './service.ts'
import type { Store, Tx } from './store.ts'
import { unit } from './unit.ts'

export interface EngineOptions extends Omit<ServiceOptions, 'outbox' | 'now'> {
  policy?: Policy
  /** The ad platforms, and how they are sent to. With no target nothing is sent. */
  delivery?: OutboxOptions
  now?: () => number
}

/** The graph with what is made on it: the outbox, and what every way in does with what it is given. */
export interface Parts {
  graph: Graph
  outbox: Outbox | undefined
  service: Service
}

export interface Inside extends Parts {
  tx: Tx
  /** The subjects that have moved so far. */
  changes: Change[]
}

export interface Engine extends Parts {
  store: Store
  policy: Policy
  options: EngineOptions
  now: () => number
  /** Reads the graph and its delivery rows in the same store snapshot. */
  read<T>(work: (parts: Parts) => Promise<T>): Promise<T>
  /** One entry, as one transaction: all of what it does, or none. */
  unit<T>(work: (inside: Inside) => Promise<T>, instead?: Partial<Pick<ServiceOptions, 'address' | 'lineType'>>): Promise<T>
}

export function createEngine(store: Store, options: EngineOptions = {}): Engine {
  const now = options.now ?? Date.now
  const policy = options.policy ?? defaultPolicy
  const { policy: _, delivery, now: __, ...service } = options
  const parts = (on: Store, onChange?: (changes: Change[]) => void, instead: Partial<Pick<ServiceOptions, 'address' | 'lineType'>> = {}): Parts => {
    const graph = createGraph(on, policy, { now, ...(onChange && { onChange }) })
    const outbox = delivery && delivery.targets.length > 0 ? createOutbox(graph, on.outbox, { now, ...delivery }) : undefined
    return { graph, outbox, service: createService(graph, { ...service, ...instead, ...(outbox && { outbox }), now }) }
  }
  return {
    ...parts(store),
    store,
    policy,
    options,
    now,
    read: work => store.read(tx => work(parts({
      read: each => each(tx),
      write: async () => { throw new Error('A lookup cannot write') },
      outbox: tx.outbox,
      ops: store.ops,
    }))),
    unit: (work, instead) => unit(store, (inside, tx) => {
      const changes: Change[] = []
      return work({ ...parts(inside, (more) => void changes.push(...more), instead), tx, changes })
    }),
  }
}
