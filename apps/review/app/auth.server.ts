import { randomUUID } from 'node:crypto'
import { createCookieSessionStorage, data, redirect } from 'react-router'
import { accountGraph } from 'account-graph'
import { runtime, type Reviewer } from './runtime.server'

const lifetime = 8 * 3600
export const publicOrigin = (request: Request) => runtime().origin ?? new URL(request.url).origin
function storage(request: Request) {
  const { protocol, hostname } = new URL(publicOrigin(request))
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname)
  return createCookieSessionStorage<{ id: string }>({ cookie: {
    name: 'review_session', secrets: [runtime().secret], httpOnly: true, sameSite: 'strict', secure: protocol !== 'http:' || !loopback, path: '/', maxAge: lifetime,
  } })
}

export function checkOrigin(request: Request) {
  if (request.method !== 'POST' || request.headers.get('origin') !== publicOrigin(request)) throw new Response('This form must be submitted from the review app.', { status: 403 })
}

function revoke(session?: Reviewer) {
  if (session) {
    runtime().sessions.delete(session.id)
    session.controller.abort()
  }
}

export async function current(request: Request) {
  const cookie = await storage(request).getSession(request.headers.get('cookie'))
  const id = cookie.get('id')
  const session = id && runtime().sessions.get(id)
  if (session && session.expires > Date.now()) return session
  if (session) revoke(session)
}

export async function signedOut(request: Request, session?: Reviewer) {
  revoke(session)
  const jar = storage(request)
  const cookie = await jar.getSession(request.headers.get('cookie'))
  return redirect('/signin', { status: 303, headers: { 'set-cookie': await jar.destroySession(cookie) } })
}

export async function requireReviewer(request: Request) {
  const session = await current(request)
  if (session) return session
  // Only a local review path can be a destination after signing in.
  const path = new URL(request.url).pathname.replace(/\.data$/, '')
  throw redirect('/signin?next=' + encodeURIComponent(safePath(path)))
}

function safePath(path: unknown) {
  return typeof path === 'string' && /^\/(accounts|journey|board|calls|decide|channels|health)(\/[^?#\\]*)?$/.test(path) ? path : '/accounts'
}

export async function reviewGet(request: Request, session: Pick<Reviewer, 'token'>, path: string, query: Record<string, string> = {}) {
  const address = new URL('/review/api/' + path, runtime().graphUrl)
  address.search = new URLSearchParams(query).toString()
  const response = await fetch(address, { headers: { authorization: 'Bearer ' + session.token }, redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) })
  if (response.status === 401) throw await signedOut(request, 'id' in session ? session as Reviewer : undefined)
  if (!response.ok) throw new Response('The graph could not answer. Reload to try again.', { status: response.status >= 500 ? 503 : response.status })
  return response.json()
}

export async function withGraph<T>(request: Request, work: (session: Reviewer, graph: ReturnType<typeof accountGraph>) => Promise<T>) {
  const session = await requireReviewer(request)
  const graph = accountGraph({ url: runtime().graphUrl, token: session.token, timeoutMs: 8000 })
  try {
    return await work(session, graph)
  } catch (error) {
    if (error instanceof Response) throw error
    const fault = error as { code?: string, message?: string }
    if (fault.code === 'AUTH.REJECTED') throw await signedOut(request, session)
    if (fault.code?.startsWith('INPUT.')) throw new Response('Check the values in the form and try again.', { status: 400 })
    throw new Response('The graph is unavailable. Reload to try again.', { status: 503 })
  } finally {
    await graph.close()
  }
}

export async function openSession(request: Request, token: string, name: string, retraction: Reviewer['retraction']) {
  const sessions = runtime().sessions
  for (const prior of sessions.values()) if (prior.expires <= Date.now()) revoke(prior)
  revoke(await current(request))
  const id = randomUUID()
  sessions.set(id, { id, name, token, retraction, controller: new AbortController(), expires: Date.now() + lifetime * 1000 })
  const jar = storage(request)
  const cookie = await jar.getSession()
  cookie.set('id', id)
  return jar.commitSession(cookie)
}

export async function signIn(request: Request) {
  checkOrigin(request)
  const form = await request.formData()
  const token = String(form.get('token') ?? '')
  if (!/^[!-~]{1,2048}$/.test(token)) return data({ error: 'Enter your reviewer token.' }, { status: 400 })
  try {
    const me = await reviewGet(request, { token }, 'me')
    if (!me.reviewer) return data({ error: 'Use a token issued to a reviewer.' }, { status: 403 })
    return redirect(safePath(form.get('next')), { status: 303, headers: { 'set-cookie': await openSession(request, token, me.reviewer, me.retraction) } })
  } catch (error) {
    if (error instanceof Response && error.status === 303) return data({ error: 'The graph did not accept this reviewer token.' }, { status: 401, headers: { 'set-cookie': (await signedOut(request, await current(request))).headers.get('set-cookie')! } })
    return data({ error: 'The graph is unavailable. Try signing in again.' }, { status: 503 })
  }
}
