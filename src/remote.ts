/** The package where there is no Node: the same names, over HTTP only. */
import type { AccountGraph, LocalOptions, RemoteOptions } from './contract/api.ts'
import { FAULT_CODES, fault } from './contract/fault.ts'
import { remoteGraph } from './client/remote.ts'

export function accountGraph(options: RemoteOptions | LocalOptions): AccountGraph {
  if (typeof options !== 'object' || options === null || options.url === undefined) throw fault(FAULT_CODES.CONFIG.UNSUPPORTED, 'A graph in this process requires Node')
  return remoteGraph(options)
}
export * from './contract/index.ts'
