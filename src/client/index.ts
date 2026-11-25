import type { AccountGraph, LocalOptions, RemoteOptions } from '../contract/api.ts'
import { FAULT_CODES, fault } from '../contract/fault.ts'
import { localGraph } from './local.ts'
import { remoteGraph } from './remote.ts'

/** Synchronous, and does no I/O. Throws CONFIG.INVALID naming everything wrong at once. */
export function accountGraph(options: RemoteOptions | LocalOptions): AccountGraph {
  if (typeof options !== 'object' || options === null) throw fault(FAULT_CODES.CONFIG.INVALID, 'accountGraph requires options')
  const given = options as unknown as Record<string, unknown>
  if (['url', 'databaseUrl', 'memory'].filter((name) => given[name] !== undefined).length !== 1) throw fault(FAULT_CODES.CONFIG.INVALID, 'Exactly one of `url`, `databaseUrl` and `memory` must be given')
  return given.url !== undefined ? remoteGraph(options as RemoteOptions) : localGraph(options as LocalOptions)
}
