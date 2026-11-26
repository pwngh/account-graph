import { randomBytes } from 'node:crypto'
import { renderToReadableStream } from 'react-dom/server'
import { ServerRouter, type EntryContext } from 'react-router'
import { runtime } from './runtime.server'
export { configure, serveWith } from './runtime.server'
export default async function document(request: Request, status: number, headers: Headers, context: EntryContext) {
  const nonce = randomBytes(18).toString('base64')
  const policy = ["default-src 'none'", "script-src 'nonce-" + nonce + "' 'strict-dynamic'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data:", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]
  const stage = runtime().stage
  if (stage && new URL(request.url).pathname === '/stage') policy.push('frame-src ' + new URL(stage.state().site).origin)
  headers.set('content-security-policy', policy.join('; '))
  headers.set('cache-control', 'no-store')
  // A native POST under no-referrer can carry Origin: null. Same-origin forms must retain their origin.
  headers.set('referrer-policy', 'same-origin')
  headers.set('cross-origin-opener-policy', 'same-origin')
  headers.set('cross-origin-resource-policy', 'same-origin')
  headers.set('permissions-policy', 'camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-type', 'text/html; charset=utf-8')
  if (request.method === 'HEAD') return new Response(null, {status,headers})
  const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} nonce={nonce}/>, {nonce, signal: request.signal})
  return new Response(body, {status,headers})
}
