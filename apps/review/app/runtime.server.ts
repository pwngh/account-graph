import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

export interface Reviewer {
  id: string
  token: string
  name: string
  retraction: { targets: string[], always: boolean }
  controller: AbortController
  expires: number
}

interface Settings {
  graphUrl?: string
  eventsToken?: string
  secret?: string
  origin?: string
}

export function configure(settings: Settings = {}) {
  const secret = settings.secret || process.env.REVIEW_SESSION_SECRET || (process.env.NODE_ENV === 'development' && randomBytes(32).toString('base64url'))
  if (!secret) throw new Error('Set REVIEW_SESSION_SECRET before starting the review app')
  const graphUrl = new URL(settings.graphUrl ?? process.env.REVIEW_GRAPH_URL ?? 'http://127.0.0.1:8080').origin
  const origin = settings.origin ?? process.env.REVIEW_ORIGIN
  const eventsToken = settings.eventsToken ?? process.env.REVIEW_EVENTS_TOKEN
  return { graphUrl, origin, secret, eventsToken, sessions: new Map<string, Reviewer>(), stopped: new AbortController() }
}
type Runtime = ReturnType<typeof configure>
const scope = new AsyncLocalStorage<Runtime>()
let development: Runtime | undefined
export const runtime = () => scope.getStore() ?? (development ??= configure())
export const serveWith = (value: Runtime, work: () => void) => scope.run(value, work)
