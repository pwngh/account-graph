import { setTimeout as delay } from 'node:timers/promises'
import { accountGraph } from 'account-graph'
import { requireReviewer, reviewGet, signedOut } from './auth.server'
import { runtime } from './runtime.server'

// A new tab already has server-rendered data. Other tabs can start at the last observed head.
const heads = new WeakMap<ReturnType<typeof runtime>, string>()

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
  const graph = accountGraph({ url: config.graphUrl, token: config.eventsToken, timeoutMs: 8000 })
  const previousId = request.headers.get('last-event-id') ?? ''
  const resume = previousId.length <= 200 ? previousId : ''
  let cursor = resume || heads.get(config) || null
  let catchingUp = !resume
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (message: string) => controller.enqueue(encoder.encode(message + '\n\n'))
      let version: number | undefined
      const beat = setInterval(() => { if (!signal.aborted) send(': heartbeat') }, 15000)
      try {
        send(': connected')
        while (!signal.aborted) {
          // Some writes, including ordinary sightings, produce no public event. The version covers them.
          const pulse = await reviewGet(new Request(request, { signal }), session, 'pulse')
          if (signal.aborted) break
          const page = await graph.events({ after: cursor, limit: 500 }, { signal })
          if (signal.aborted) break
          if (!page.ok) {
            if (cursor === null) throw new Error('The graph has no event cursor')
            cursor = null
            catchingUp = true
            continue
          }
          const { events, more } = page.value
          const previous = cursor
          cursor = page.value.cursor
          if (!more) heads.set(config, cursor)
          // An empty cursor means the start of graph history. Skip old pages together and refresh once at the head.
          if (catchingUp && more) continue
          const views = new Set<string>(), subjects = new Set<string>()
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
          // A sighting and a cluster change can commit between the same two reads. Refresh the visible view on a write gap.
          if (catchingUp || (version !== undefined && version !== pulse.version)) views.add('*')
          catchingUp = false
          version = pulse.version
          // The cursor is opaque. Strip line breaks before writing a field in the SSE envelope.
          const id = cursor.replace(/[\r\n\0]/g, '')
          if (views.size) send('id: ' + id + '\nevent: change\ndata: ' + JSON.stringify({views: [...views], subjects: [...subjects]}))
          else if (previous !== cursor) send('id: ' + id + '\n: up to date')
          if (!more) await delay(1500, undefined, { signal })
        }
      } catch (error) {
        if ((error as {code?: string})?.code === 'AUTH.REJECTED') await signedOut(request, session)
        else if (!signal.aborted && !(error instanceof Response && error.status === 303)) send('event: unavailable\ndata: {}')
      } finally {
        clearInterval(beat)
        if (session.controller.signal.aborted || session.expires <= Date.now()) {
          await signedOut(request, session)
          if (!request.signal.aborted && !cancel.signal.aborted) send('event: signout\ndata: {}')
        }
        await graph.close()
        if (!cancel.signal.aborted) controller.close()
      }
    },
    cancel() { cancel.abort() },
  })
  return new Response(body, {headers})
}
