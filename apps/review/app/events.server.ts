import { setTimeout as delay } from 'node:timers/promises'
import { accountGraph } from 'account-graph'
import { requireReviewer, reviewGet, signedOut } from './auth.server'
import { runtime } from './runtime.server'

export async function events(request: Request) {
  const session = await requireReviewer(request)
  const config = runtime()
  if (!config.eventsToken) return new Response(null, { status: 204 })
  const cancel = new AbortController()
  const signal = AbortSignal.any([request.signal, cancel.signal, session.controller.signal, config.stopped.signal, AbortSignal.timeout(Math.max(1, session.expires - Date.now()))])
  const graph = accountGraph({ url: config.graphUrl, token: config.eventsToken, timeoutMs: 8000 })
  let cursor = request.headers.get('last-event-id') || null
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
            cursor = null
            send('id:\nevent: change\ndata: {"views":["*"],"subjects":[]}')
            continue
          }
          const { events, more } = page.value
          const views = new Set<string>(), subjects = new Set<string>()
          for (const event of events) {
            if (event.type === 'cluster.changed' || event.type === 'callback.overdue') {
              subjects.add(event.data.subject)
              for (const view of ['accounts','journey','board','calls','decide','channels']) views.add(view)
            } else views.add('health')
          }
          if (version !== undefined && version !== pulse.version) views.add('*')
          version = pulse.version
          // The cursor is opaque. Strip line breaks before writing a field in the SSE envelope.
          cursor = page.value.cursor
          const id = cursor.replace(/[\r\n\0]/g, '')
          if (views.size) send('id: ' + id + '\nevent: change\ndata: ' + JSON.stringify({views: [...views], subjects: [...subjects]}))
          else send('id: ' + id + '\n: up to date')
          if (!more) await delay(1500, undefined, { signal })
        }
      } catch (error) {
        if (!signal.aborted && !(error instanceof Response && error.status === 303)) send('event: unavailable\ndata: {}')
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
  return new Response(body, { headers: {'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no'} })
}
