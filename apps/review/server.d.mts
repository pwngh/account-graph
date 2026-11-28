import type { RequestListener, Server } from 'node:http'
import type { Stage } from '../../examples/firm/stage-state.ts'
interface Settings {
  origin?: string
  graphUrl?: string
  eventsToken?: string
  secret?: string
  legacyUrl?: string
  stage?: Stage
  /** How many proxies of your own stand in front: `true` for one, or a number. */
  trustProxy?: boolean | number | string
}
export function reviewListener(settings?: Settings): Promise<RequestListener & {stop(): void, config: {addressOf(forwarded: string | string[] | undefined, socket: string | undefined): string | undefined}}>
export function reviewServer(settings?: Settings & {port?: number, host?: string}): Promise<Server>
