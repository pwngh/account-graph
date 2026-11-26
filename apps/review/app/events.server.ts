import { setTimeout as delay } from 'node:timers/promises'
import { accountGraph } from 'account-graph'
import { requireReviewer } from './auth.server'
import { runtime } from './runtime.server'

type Runtime = ReturnType<typeof runtime>
interface Listener {
  /** A new tab already has server-rendered data. It asks for one refresh of its view once the follower is at the head. */
  fresh: boolean
  send(message: string): void
  fail(): void
}
interface Follower { listeners: Set<Listener>, cursor: string | null, stop?: AbortController }

// One follower per process reads the graph for every open tab. It starts with the first tab and stops with the last.
const followers = new WeakMap<Runtime, Follower>()
export function followerOf(config: Runtime) {
  let follower = followers.get(config)
  if (!follower) followers.set(config, follower = { listeners: new Set(), cursor: null })
  return follower
}

function join(config: Runtime, listener: Listener) {
  const follower = followerOf(config)
  follower.listeners.add(listener)
  if (!follower.stop) void follow(config, follower)
  return () => {
    if (!follower.listeners.delete(listener) || follower.listeners.size) return
    follower.stop?.abort()
    follower.stop = undefined
  }
}

// The cursor is opaque. Strip line breaks before writing a field in the SSE envelope.
const idOf = (cursor: string) => cursor.replace(/[\r\n\0]/g, '')

function changesIn(events: readonly { type: string, data?: any }[], views: Set<string>, subjects: Set<string>) {
  for (const event of events) {
    if (event.type === 'cluster.changed' || event.type === 'callback.overdue') {
      subjects.add(event.data.subject)
      if (event.type === 'cluster.changed') {
        if (event.data.from) subjects.add(event.data.from)
        if (event.data.to) subjects.add(event.data.to)
      }
      for (const view of ['accounts','journey','board','calls','decide','channels']) views.add(view)
    } else views.add('health')
  }
}

async function pulse(config: Runtime, signal: AbortSignal): Promise<{ version: number }> {
  const response = await fetch(new URL('/review/api/pulse', config.graphUrl), { headers: { authorization: 'Bearer ' + config.eventsToken }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
  if (!response.ok) throw new Error('The graph answered ' + response.status + ' to the events token')
  return response.json()
}

async function follow(config: Runtime, follower: Follower) {
  const stop = follower.stop = new AbortController()
  const signal = AbortSignal.any([stop.signal, config.stopped.signal])
  const graph = accountGraph({ url: config.graphUrl, token: config.eventsToken!, timeoutMs: 8000 })
  let catchingUp = follower.cursor === null
  let version: number | undefined
  try {
    while (!signal.aborted) {
      // Some writes, including ordinary sightings, produce no public event. The version covers them.
      const { version: now } = await pulse(config, signal)
      if (signal.aborted) break
      const page = await graph.events({ after: follower.cursor, limit: 500 }, { signal })
      if (signal.aborted) break
      if (!page.ok) {
        if (follower.cursor === null) throw new Error('The graph has no event cursor')
        follower.cursor = null
        catchingUp = true
        continue
      }
      const { events, more } = page.value
      const previous = follower.cursor
      const cursor = follower.cursor = page.value.cursor
      // An empty cursor means the start of graph history. Skip old pages together and refresh once at the head.
      if (catchingUp && more) continue
      const views = new Set<string>(), subjects = new Set<string>()
      changesIn(events, views, subjects)
      // A sighting and a cluster change can commit between the same two reads. Refresh the visible view on a write gap.
      if (catchingUp || (version !== undefined && version !== now)) views.add('*')
      catchingUp = false
      version = now
      for (const listener of follower.listeners) {
        const shown = listener.fresh ? [...views, '*'] : [...views]
        listener.fresh = false
        if (shown.length) listener.send('id: ' + idOf(cursor) + '\nevent: change\ndata: ' + JSON.stringify({views: shown, subjects: [...subjects]}))
        else if (previous !== cursor) listener.send('id: ' + idOf(cursor) + '\n: up to date')
      }
      if (!more) await delay(1500, undefined, { signal })
    }
  } catch {
    if (!signal.aborted) for (const listener of [...follower.listeners]) listener.fail()
  } finally {
    if (follower.stop === stop) follower.stop = undefined
    await graph.close()
  }
}

export async function events(request: Request) {
  const session = await requireReviewer(request)
  const config = runtime()
  const cancel = new AbortController()
  const signal = AbortSignal.any([request.signal, cancel.signal, session.controller.signal, config.stopped.signal, AbortSignal.timeout(Math.max(1, session.expires - Date.now()))])
  const headers = {'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no'}
  if (new URL(request.url).searchParams.has('stage') && config.stage) {
    const stage = config.stage
    const encode = new TextEncoder()
    let stop = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => controller.enqueue(encode.encode(text + '\n\n'))
        const snapshot = () => {
          const { scenes: _, practice: __, ...state } = stage.state()
          send('id: ' + state.boot + '.' + state.revision + '\nevent: stage\ndata: ' + JSON.stringify(state))
        }
        const unsubscribe = stage.subscribe(snapshot)
        const beat = setInterval(() => send(': heartbeat'), 15000)
        stop = () => {
          unsubscribe()
          clearInterval(beat)
          signal.removeEventListener('abort', finish)
        }
        function finish() {
          stop()
          if (!request.signal.aborted && !config.stopped.signal.aborted) send('event: signout\ndata: {}')
          controller.close()
        }
        signal.addEventListener('abort', finish, {once: true})
        if (signal.aborted) finish()
        else snapshot()
      },
      cancel() { stop(); cancel.abort() },
    })
    return new Response(body, {headers})
  }
  if (!config.eventsToken) return new Response(null, { status: 204 })
  const previousId = request.headers.get('last-event-id') ?? ''
  const resume = previousId.length <= 200 ? previousId : ''
  let leave = () => {}
  let open = true
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const write = (message: string) => { if (open) controller.enqueue(encoder.encode(message + '\n\n')) }
      const beat = setInterval(() => write(': heartbeat'), 15000)
      const end = (last?: string) => {
        if (!open) return
        if (last) write(last)
        open = false
        leave()
        clearInterval(beat)
        signal.removeEventListener('abort', finish)
        if (!cancel.signal.aborted) controller.close()
      }
      function finish() {
        if (session.controller.signal.aborted || session.expires <= Date.now()) {
          config.sessions.delete(session.id)
          session.controller.abort()
          if (!request.signal.aborted && !cancel.signal.aborted) return end('event: signout\ndata: {}')
        }
        end()
      }
      // Until a resumed stream has caught up, the shared follower's notices wait behind it.
      const waiting: string[] = []
      let caughtUp = !resume
      const listener: Listener = { fresh: !resume, send: message => caughtUp ? write(message) : waiting.push(message), fail: () => end('event: unavailable\ndata: {}') }
      write(': connected')
      signal.addEventListener('abort', finish, {once: true})
      if (signal.aborted) return finish()
      leave = join(config, listener)
      if (!resume) return
      const graph = accountGraph({ url: config.graphUrl, token: config.eventsToken!, timeoutMs: 8000 })
      try {
        let cursor = resume, more = true
        const views = new Set<string>(), subjects = new Set<string>()
        while (more && !signal.aborted) {
          const page = await graph.events({ after: cursor, limit: 500 }, { signal })
          // An unknown cursor cannot be resumed. The follower refreshes the view at its head instead.
          if (!page.ok) {
            listener.fresh = true
            break
          }
          more = page.value.more
          cursor = page.value.cursor
          changesIn(page.value.events, views, subjects)
        }
        if (!listener.fresh && views.size) write('id: ' + idOf(cursor) + '\nevent: change\ndata: ' + JSON.stringify({views: [...views], subjects: [...subjects]}))
        else if (!listener.fresh && cursor !== resume) write('id: ' + idOf(cursor) + '\n: up to date')
      } catch {
        if (!signal.aborted) return end('event: unavailable\ndata: {}')
      } finally {
        await graph.close()
      }
      caughtUp = true
      for (const message of waiting.splice(0)) write(message)
    },
    cancel() {
      open = false
      leave()
      cancel.abort()
    },
  })
  return new Response(body, {headers})
}
