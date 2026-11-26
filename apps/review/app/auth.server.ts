import { fieldsOf } from './forms.server'
import { randomUUID } from 'node:crypto'
import { createCookieSessionStorage, data, redirect } from 'react-router'
import { accountGraph } from 'account-graph'
import { subjectAddress } from './navigation'
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

export async function signInPage(request: Request) {
  const jar = storage(request)
  const cookie = await jar.getSession(request.headers.get('cookie'))
  if (cookie.has('id') && !await current(request)) {
    return data(null, {headers: {'set-cookie': await jar.destroySession(cookie)}})
  }
  return null
}

export async function requireReviewer(request: Request) {
  const session = await current(request)
  if (session) return session
  // Only a local review path can be a destination after signing in.
  const url = new URL(request.url)
  const path = url.pathname.replace(/\.data$/, '') + url.search
  throw redirect('/signin?next=' + encodeURIComponent(safePath(path)))
}

function safePath(path: unknown) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/accounts'
  const base = 'https://review.example.org'
  const url = new URL(path, base)
  if (url.origin !== base || !/^\/(accounts|journey|board|calls|decide|channels|health)(\/[^?#]*)?$/.test(url.pathname)) return '/accounts'
  const clean = new URLSearchParams()
  const filters: Record<string,RegExp> = {from: /^\d{4}-\d{2}-\d{2}$/, to: /^\d{4}-\d{2}-\d{2}$/, page: /^\d+$/, measure: /^(calls|answered|missed|voicemail|unknown|waiting|returned)$/, before: /^\d+$/, offset: /^\d+$/, links: /^\d+$/, author: /^(people|system)$/}
  for (const [key, allowed] of Object.entries(filters)) {
    const value = url.searchParams.get(key)
    if (value && allowed.test(value)) clean.set(key, value)
  }
  return (subjectAddress(url.pathname)?.path ?? url.pathname) + (clean.size ? '?' + clean : '') + (url.pathname.startsWith('/journey/') && url.hash.startsWith('#call-') ? url.hash : '')
}

// A board can make several successive reads for its details. They share one deadline.
const deadlines = new WeakMap<Request, AbortSignal>()
function deadline(request: Request) {
  const existing = deadlines.get(request)
  if (existing) return existing
  const signal = AbortSignal.timeout(8000)
  deadlines.set(request, signal)
  return signal
}

export async function reviewGet(request: Request, session: Pick<Reviewer, 'token'> & Partial<Pick<Reviewer, 'controller' | 'id'>>, path: string, query: Record<string, string> = {}) {
  const address = new URL('/review/api/' + path, runtime().graphUrl)
  address.search = new URLSearchParams(query).toString()
  const response = await fetch(address, { headers: { authorization: 'Bearer ' + session.token }, redirect: 'error', signal: AbortSignal.any([request.signal, ...(session.controller ? [session.controller.signal] : []), deadline(request)]) })
  if (response.status === 401) throw await signedOut(request, 'id' in session ? session as Reviewer : undefined)
  if (!response.ok) throw new Response('The graph could not answer. Reload to try again.', { status: response.status >= 500 ? 503 : response.status })
  return response.json()
}

export async function withGraph<T>(request: Request, work: (session: Reviewer, graph: ReturnType<typeof accountGraph>) => Promise<T>) {
  const session = await requireReviewer(request)
  const graph = accountGraph({ url: runtime().graphUrl, token: session.token, timeoutMs: 8000 })
  try {
    const answer = await work(session, graph)
    if (session.controller.signal.aborted) throw await signedOut(request, session)
    return answer
  } catch (error) {
    if (session.controller.signal.aborted) throw await signedOut(request, session)
    if (error instanceof Response) throw error
    const fault = error as { code?: string, message?: string }
    if (fault.code === 'AUTH.REJECTED') throw await signedOut(request, session)
    if (typeof fault.code === 'string' && fault.code.startsWith('INPUT.')) throw new Response('Check the values in the form and try again.', { status: 400 })
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
  const controller = new AbortController()
  const expires = Date.now() + lifetime * 1000
  sessions.set(id, { id, name, token, retraction, controller, expires })
  const expiry = setTimeout(() => {
    sessions.delete(id)
    controller.abort()
  }, lifetime * 1000).unref()
  controller.signal.addEventListener('abort', () => clearTimeout(expiry), {once: true})
  const jar = storage(request)
  const cookie = await jar.getSession()
  cookie.set('id', id)
  return jar.commitSession(cookie)
}

export async function signIn(request: Request) {
  checkOrigin(request)
  const form = await fieldsOf(request)
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
