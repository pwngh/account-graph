import type { RequestListener, Server } from 'node:http'
import type { Stage } from '../../examples/firm/stage-state.ts'
interface Settings {
  origin?: string
  graphUrl?: string
  eventsToken?: string
  secret?: string
  stage?: Stage
}
export function reviewListener(settings?: Settings): Promise<RequestListener & {stop(): void}>
export function reviewServer(settings?: Settings & {port?: number, host?: string}): Promise<Server>
