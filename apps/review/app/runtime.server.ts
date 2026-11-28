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

import type { Stage } from '../../../examples/firm/stage-state'

interface Settings {
  stage?: Stage
  graphUrl?: string
  eventsToken?: string
  secret?: string
  origin?: string
  legacyUrl?: string
}

export function configure(settings: Settings = {}) {
  const secret = settings.secret || process.env.REVIEW_SESSION_SECRET || (process.env.NODE_ENV === 'development' && randomBytes(32).toString('base64url'))
  if (!secret) throw new Error('Set REVIEW_SESSION_SECRET before starting the review app')
  // The secret signs every session cookie. A short one can be guessed offline from a single cookie.
  if (secret.length < 32) throw new Error('Set REVIEW_SESSION_SECRET to at least 32 random characters')
  const graphUrl = new URL(settings.graphUrl ?? process.env.REVIEW_GRAPH_URL ?? 'http://127.0.0.1:8080').origin
  // A setting passed through empty, as Compose passes one that is not set, is no setting.
  const origin = (settings.origin ?? process.env.REVIEW_ORIGIN) || undefined
  // The secret in compose.yaml is in the repository for anyone to read, so it is only for trying the app out on your own machine.
  if (secret.startsWith('change-me') && origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.localhost)(:\d+)?$/.test(origin)) throw new Error(`Change REVIEW_SESSION_SECRET before serving reviewers at ${origin}`)
  const eventsToken = settings.eventsToken ?? process.env.REVIEW_EVENTS_TOKEN
  // The graph's address can be internal. Link to the original screen only where the operator says reviewers can reach it.
  const legacyUrl = settings.stage ? '/legacy' : (settings.legacyUrl ?? process.env.REVIEW_LEGACY_URL) || undefined
  if (legacyUrl && !legacyUrl.startsWith('/') && !/^https?:$/.test(new URL(legacyUrl).protocol)) throw new Error('Set REVIEW_LEGACY_URL to an http or https address')
  return { graphUrl, stage: settings.stage, origin, secret, eventsToken, legacy: legacyUrl || undefined, sessions: new Map<string, Reviewer>(), attempts: new Map<string, { count: number, since: number }>(), reportZone: undefined as string | undefined, stopped: new AbortController() }
}
type Runtime = ReturnType<typeof configure>
const scope = new AsyncLocalStorage<Runtime>()
const clients = new AsyncLocalStorage<string>()
let development: Runtime | undefined
export const runtime = () => scope.getStore() ?? (development ??= configure())
/** The production server passes the connection's address. Behind a proxy every reviewer shares the proxy's. */
export const serveWith = (value: Runtime, work: () => void, address?: string) => scope.run(value, () => address ? clients.run(address, work) : work())
export const clientAddress = () => clients.getStore()

// Times written on the server, in card rows for example, use the reviewer's zone for the request being answered.
const zones = new AsyncLocalStorage<string>()
export const zone = () => zones.getStore() ?? 'UTC'
export const inZone = <T>(name: string, work: () => T) => zones.run(name, work)
export function validZone(name?: string) {
  if (!name || name.length > 64) return
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

export const graphTime = () => runtime().stage?.state().clock ?? Date.now()
