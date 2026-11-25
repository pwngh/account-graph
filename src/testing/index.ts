import { internalsOf } from '../client/internals.ts'
import type { AccountGraph } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'

/** One pass of every worker of a local instance, now: sends what is due, reads costs, looks for what is late, posts events. */
export async function runWorkers(graph: AccountGraph): Promise<void> {
  const open = internalsOf(graph)
  if (!open) throw fault(FAULT_CODES.CONFIG.UNSUPPORTED, 'Workers run in a local instance')
  await (await open()).pass()
}
