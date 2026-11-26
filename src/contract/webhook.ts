import type { At, GraphEvent, RawWebhook, UnrecognizedEvent } from './api.ts'

export type { RawWebhook } from './api.ts'

const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))
}

export const SIGNATURE = 'x-account-graph-signature'

/** `t=<epoch ms>,v1=<HMAC-SHA256 of "<t>.<body>" in hex>`. */
export async function signWebhook(secret: string, at: At, body: string): Promise<string> {
  return `t=${at},v1=${await hmac(secret, `${at}.${body}`)}`
}

/** Compares every character, so how long it takes says nothing of which was wrong. */
function same(x: string, y: string): boolean {
  let different = x.length ^ y.length
  for (let i = 0; i < x.length; i++) different |= x.charCodeAt(i) ^ (y.charCodeAt(i % Math.max(1, y.length)) || 0)
  return different === 0
}

/** Whether a webhook came from a server that holds the secret, and lately. Never throws on what was sent. On false, reject the request. */
export async function verifyWebhook(webhook: RawWebhook, options: { readonly secret: string; readonly now: At; readonly maxAgeMs: number }): Promise<boolean> {
  const header = Object.entries(webhook.headers ?? {}).find(([name]) => name.toLowerCase() === SIGNATURE)?.[1]
  const match = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/.exec(typeof header === 'string' ? header : '')
  if (!match || typeof webhook.body !== 'string') return false
  const at = Number(match[1])
  if (!(Math.abs(options.now - at) <= options.maxAgeMs)) return false
  return same(await hmac(options.secret, `${at}.${webhook.body}`), match[2]!)
}

const TYPES: ReadonlySet<string> = new Set<GraphEvent['type']>(['cluster.changed', 'conversion.failed', 'delivery.paused', 'delivery.late', 'costs.failed', 'feed.quiet', 'callback.overdue', 'audit.head'])

/** An event as it was sent, or what could not be read as one. */
export function readEvent(value: unknown): GraphEvent | UnrecognizedEvent {
  const event = value as Partial<GraphEvent> | null
  const known = typeof event === 'object' && event !== null && event.schemaVersion === 1 && TYPES.has(String(event.type)) && Number.isSafeInteger(event.seq) && Number.isSafeInteger(event.at) && typeof event.data === 'object' && event.data !== null
  return known ? (event as GraphEvent) : { schemaVersion: 1, seq: typeof event === 'object' && event !== null && Number.isSafeInteger(event.seq) ? event.seq! : 0, type: 'Unrecognized', raw: value }
}

/** Pure and total. What it does not know comes back as Unrecognized, with the raw value. */
export function parseWebhook(webhook: RawWebhook): readonly (GraphEvent | UnrecognizedEvent)[] {
  let body: any
  try {
    body = JSON.parse(webhook.body)
  } catch {
    body = webhook.body
  }
  return Array.isArray(body?.events) ? body.events.map(readEvent) : [readEvent(body)]
}
