/**
 * Takes the webhook a call tracking service sends after each call, and
 * reports the call to the graph server. Written from CallRail's published
 * API and never run against a live account: check the body and the signature
 * yours sends before relying on it.
 *
 *   GRAPH_TOKEN=… SIGNING_KEY=… node examples/call-tracking.ts
 *
 * Point the service's post-call webhook at POST /calls here, over HTTPS.
 * Each call is written to a folder before it is answered for, because the
 * service does not send it again, and is taken out once the server has it.
 * The folder holds telephone numbers: keep it where only this can read it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { accountGraph, isFault } from '../src/index.ts'
import type { RecordEntry } from '../src/index.ts'

/** Whether a body was signed with the key: HMAC-SHA1 in base64, as CallRail's API says. */
export function signed(raw: Buffer, signature: string | undefined, key: string): boolean {
  if (!signature || !key) return false
  const made = createHmac('sha1', key).update(raw).digest()
  const given = Buffer.from(signature, 'base64')
  return given.length === made.length && timingSafeEqual(given, made)
}

const number = (value: unknown) => (typeof value === 'string' && /^\+\d{8,15}$/.test(value) ? value : undefined)

/** The call as the graph server takes it, or why it cannot be. */
export function toCall(said: Record<string, unknown>, person = process.env.ANSWERED_BY === 'person'): { call: RecordEntry } | { problem: string } {
  const { id, customer_phone_number, tracking_phone_number, start_time, duration, answered, voicemail, direction } = said
  if (!/^[\w.-]{1,80}$/.test(typeof id === 'number' ? String(id) : typeof id === 'string' ? id : '')) return { problem: 'no id' }
  // A time without its zone could be hours off, and a tap is matched within minutes.
  if (typeof start_time !== 'string' || !/(Z|[+-]\d\d:?\d\d)$/.test(start_time) || Number.isNaN(Date.parse(start_time))) return { problem: 'no start_time with a zone' }
  const [customer, tracking] = [number(customer_phone_number), number(tracking_phone_number)]
  if (!tracking) return { problem: 'no tracking_phone_number' }
  if (direction !== 'inbound' && direction !== 'outbound') return { problem: 'no call direction' }
  const outbound = direction === 'outbound'
  if (outbound && !customer) return { problem: 'an outbound call to no number' }
  const seconds = duration === undefined || duration === null || duration === '' ? NaN : Number(duration)
  return {
    call: {
      type: 'call', key: `callrail-${id}`, at: Date.parse(start_time),
      ...(outbound ? { direction: 'outbound', from: tracking, to: customer! } : { direction: 'inbound', ...(customer && { from: customer }), to: tracking }),
      ...(Number.isFinite(seconds) && seconds >= 0 && { duration: Math.round(seconds) }),
      // An answered line can be a phone menu. ANSWERED_BY=person says that only people answer these numbers. Otherwise the desk reports it.
      ...(voicemail === true ? { result: { answered: false, voicemail: true } } : typeof answered === 'boolean' && (person || !answered) && { result: { answered } }),
    },
  }
}

export interface Forwarder {
  /** Keeps the call, then tries to send what is kept. */
  take(call: RecordEntry): void
  /** Sends what is kept, oldest first, and stops at the first the server cannot be reached for. */
  flush(): Promise<{ sent: number; refused: number; left: number }>
}

export function createForwarder({ folder, graph, token, fetch: fetcher }: { folder: string; graph: string; token: string; fetch?: typeof fetch }): Forwarder {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const calls = accountGraph({ url: graph, token, timeoutMs: 10_000, ...(fetcher && { fetch: fetcher }) })
  let running: Promise<{ sent: number; refused: number; left: number }> | undefined
  const kept = () => readdirSync(folder).filter((name) => name.endsWith('.json')).sort()
  async function run() {
    let sent = 0
    let refused = 0
    for (const name of kept()) {
      const at = join(folder, name)
      // The same call would be refused again: it is set aside for somebody to look at.
      const aside = () => {
        renameSync(at, `${at}.refused`)
        refused += 1
      }
      try {
        const { results: [result] } = await calls.record({ entries: [JSON.parse(readFileSync(at, 'utf8'))] })
        // Somebody who was deleted since stays so.
        if (result!.ok || result!.reason === 'FORGOTTEN') {
          rmSync(at)
          sent += 1
        } else aside()
      } catch (error) {
        // A fault that may pass holds up the rest, and the key makes the next try safe.
        if (!isFault(error) || error.retryable || error.code !== 'INPUT.MALFORMED') break
        aside()
      }
    }
    return { sent, refused, left: kept().length }
  }
  return {
    take(made) {
      const name = `${String(made.at).padStart(15, '0')}-${createHash('sha256').update(made.key).digest('hex').slice(0, 16)}.json`
      writeFileSync(join(folder, `${name}.part`), JSON.stringify(made), { mode: 0o600, flush: true })
      renameSync(join(folder, `${name}.part`), join(folder, name))
    },
    // One at a time: the same call is not sent twice at once.
    flush: () => (running ??= run().finally(() => (running = undefined))),
  }
}

export function createTracker({ key, forwarder }: { key: string; forwarder: Forwarder }) {
  return createServer(async (request, response) => {
    const answer = (status: number, text = '') => void response.writeHead(status, { 'content-type': 'text/plain' }).end(text)
    try {
      if (request.method !== 'POST' || new URL(request.url ?? '/', 'http://localhost').pathname !== '/calls') return answer(404)
      const parts: Buffer[] = []
      let size = 0
      for await (const part of request as AsyncIterable<Buffer>) {
        if ((size += part.length) > 200_000) return answer(413)
        parts.push(part)
      }
      const raw = Buffer.concat(parts)
      const signature = request.headers['signature']
      if (!signed(raw, typeof signature === 'string' ? signature : undefined, key)) return answer(401)
      let said: unknown
      try {
        said = JSON.parse(raw.toString('utf8'))
      } catch {}
      if (typeof said !== 'object' || said === null || Array.isArray(said)) return answer(400, 'not a JSON object')
      const made = toCall(said as Record<string, unknown>)
      if ('problem' in made) return answer(422, made.problem)
      forwarder.take(made.call)
      answer(204)
      await forwarder.flush()
    } catch (error) {
      console.error(error)
      if (!response.headersSent) answer(500)
    }
  })
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { GRAPH_URL = 'http://localhost:8080', GRAPH_TOKEN = '', SIGNING_KEY = '', SPOOL = './calls-waiting', PORT = '3001' } = process.env
  if (!GRAPH_TOKEN || !SIGNING_KEY) throw new Error('GRAPH_TOKEN and SIGNING_KEY are required')
  const forwarder = createForwarder({ folder: SPOOL, graph: GRAPH_URL, token: GRAPH_TOKEN })
  const flush = () => forwarder.flush().then(({ refused, left }) => (refused || left) && console.log(`${left} waiting, ${refused} refused`), console.error)
  createTracker({ key: SIGNING_KEY, forwarder }).listen(Number(PORT), () => console.log(`POST /calls on ${PORT}`))
  void flush()
  setInterval(flush, 30_000)
}
