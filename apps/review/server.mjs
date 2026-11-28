import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { createRequestListener } from '@react-router/node'

export async function reviewListener(settings = {}) {
  const build = await import('./build/server/index.js')
  const {configure, serveWith} = build.entry.module
  const config = configure(settings)
  const router = createRequestListener({build: config.origin ? {...build, allowedActionOrigins: [new URL(config.origin).host]} : build, mode: 'production'})
  const listener = (request, response) => {
    // Node drops the headers past its limit without a word, and a proxy's own entry could be among them. Such a request is refused whole.
    if (request.rawHeaders.length / 2 >= (request.socket.server?.maxHeadersCount || 2000)) return response.writeHead(431, {'content-type': 'text/plain'}).end('This request has too many headers.')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    if (request.method === 'POST') {
      const origin = config.origin ?? (request.socket.encrypted ? 'https://' : 'http://') + request.headers.host
      if (request.headers.origin !== origin) return response.writeHead(403, {'content-type': 'text/plain'}).end('This form must be submitted from the review app.')
    }
    const asset = /^\/assets\/([\w.-]+\.(js|css|woff2))$/.exec((request.url ?? '').split('?')[0])
    if (asset && ['HEAD','GET'].includes(request.method)) {
      readFile(new URL('./build/client/assets/' + asset[1], import.meta.url)).then(body => {
        response.writeHead(200, {'content-type': {js:'text/javascript',css:'text/css',woff2:'font/woff2'}[asset[2]], 'cache-control':'public, max-age=31536000, immutable'}).end(request.method === 'HEAD' ? undefined : body)
      }, () => response.writeHead(404).end())
    } else serveWith(config, () => router(request,response), config.addressOf(request.headers['x-forwarded-for'], request.socket.remoteAddress))
  }
  listener.config = config
  listener.stop = () => { config.stopped.abort(); for (const session of config.sessions.values()) session.controller.abort(); config.sessions.clear() }
  return listener
}

export async function reviewServer({port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1', ...settings} = {}) {
  const listener = await reviewListener(settings)
  const server = createServer(listener)
  const close = server.close.bind(server)
  server.close = callback => { listener.stop(); return close(callback) }
  server.listen(port, host)
  await once(server, 'listening')
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await reviewServer()
  console.log('Account review listening on port ' + server.address().port)
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close())
}
