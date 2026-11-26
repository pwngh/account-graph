import { randomBytes } from 'node:crypto'
import { renderToReadableStream } from 'react-dom/server'
import { ServerRouter, type EntryContext } from 'react-router'
export { configure, serveWith } from './runtime.server'
export default async function document(request: Request, status: number, headers: Headers, context: EntryContext) {
  const nonce = randomBytes(18).toString('base64')
  const policy = ["default-src 'none'", "script-src 'nonce-" + nonce + "' 'strict-dynamic'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data:", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]
  headers.set('content-security-policy', policy.join('; '))
  headers.set('cache-control', 'no-store')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-type', 'text/html; charset=utf-8')
  if (request.method === 'HEAD') return new Response(null, {status,headers})
  const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} nonce={nonce}/>, {nonce, signal: request.signal})
  return new Response(body, {status,headers})
}
