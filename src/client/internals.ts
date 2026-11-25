import type { AccountGraph, LocalOptions } from '../contract/api.ts'
import type { Asked, Six } from '../core/six.ts'
import type { Engine } from '../core/engine.ts'
import type { Ops } from '../core/ops.ts'
import type { Hours } from '../core/hours.ts'

/** What stands behind a local instance, for the edge and for tests. Nobody who only holds the instance can reach it. */
export interface Internals {
  options: LocalOptions
  engine: Engine
  six: Six
  ops: Ops
  hours: Hours | undefined
  /** Runs a call as the instance does: checked, bounded, and with its faults mapped. */
  call(name: 'record' | 'decide' | 'forget' | 'lookup' | 'report' | 'events', request: unknown, asked?: Asked): Promise<unknown>
  /** One pass of every worker, now. */
  pass(): Promise<void>
}

const behind = new WeakMap<AccountGraph, () => Promise<Internals>>()
export const keep = (graph: AccountGraph, open: () => Promise<Internals>): void => void behind.set(graph, open)
/** Undefined for a remote instance. */
export const internalsOf = (graph: AccountGraph): (() => Promise<Internals>) | undefined => behind.get(graph)
