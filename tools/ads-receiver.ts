/**
 * A receiver on this machine that answers as each ad platform does when it takes a request, and prints what it was sent.
 * Start it, and start the server with `ADS_TEST_RECEIVER` set to its address:
 *   node tools/ads-receiver.ts 9000
 *   ADS_TEST_RECEIVER=http://127.0.0.1:9000 npm start
 * Each request is one line of JSON: the path and the body. Nothing is kept.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { pathToFileURL } from 'node:url'

/** What a platform answers to a request it took, by the path the request went to. */
function answer(path: string, body: string): unknown {
  if (path.endsWith('/token')) return { access_token: 'test-receiver', expires_in: 3600 }
  if (path === '/v1/events:ingest') return { requestId: 'test-receiver' }
  if (/^\/v\d+\.\d+\/[^/]+\/events$/.test(path)) {
    const data = (JSON.parse(body) as { data?: unknown }).data
    return { events_received: Array.isArray(data) ? data.length : 0, fbtrace_id: 'test-receiver' }
  }
  if (path.startsWith('/CampaignManagement/')) return { PartialErrors: [] }
  if (path.startsWith('/open_api/')) return { code: 0, request_id: 'test-receiver' }
  return undefined
}

/** A receiver that tells `heard` of each request, and answers 404 to a path no platform has. */
export function adsReceiver(heard: (request: { path: string; body: string }) => void = (request) => console.log(JSON.stringify(request))): Server {
  return createServer((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => parts.push(part))
    request.on('end', () => {
      let path = ''
      let said: string | undefined
      try {
        path = new URL(request.url ?? '/', 'http://receiver').pathname
        const body = Buffer.concat(parts).toString('utf8')
        heard({ path, body })
        const answered = answer(path, body)
        said = answered === undefined ? undefined : JSON.stringify(answered)
      } catch {
        said = undefined
      }
      response.writeHead(said === undefined ? 404 : 200, { 'content-type': 'application/json', ...(path.startsWith('/CampaignManagement/') && { TrackingId: 'test-receiver' }) }).end(said ?? '{"error":"no platform has this path"}')
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 9000)
  adsReceiver().listen(port, '127.0.0.1', () => console.error(`ad platforms answer at http://127.0.0.1:${port}`))
}
