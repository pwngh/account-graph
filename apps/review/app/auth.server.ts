import { fieldsOf } from './forms.server'
import { randomUUID } from 'node:crypto'
import { createCookieSessionStorage, data, redirect } from 'react-router'
import { accountGraph } from 'account-graph'
import { subjectAddress } from './navigation'
import { clientAddress, runtime, validZone, type Reviewer } from './runtime.server'

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
  // The cookie is one this app signed, and no session answers to it: the app was restarted, the session ran its eight hours, or it was ended elsewhere.
  // The page says so. A reviewer sent here without a word takes it for a fault.
  // The cookie is left as it is. Signing in replaces it, and an answer that cleared it could arrive after a sign-in from another tab and undo it.
  if (cookie.has('id') && !await current(request)) return { ended: true }
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

// The browser's script stores the reviewer's zone in a cookie on first load. Until then, and without scripts, times are in the report's zone.
const zoneCookie = /(?:^|;\s*)review_zone=([^;]{1,200})/
const zonesOf = new WeakMap<Request, Promise<string>>()
export function reviewerZone(request: Request) {
  let found = zonesOf.get(request)
  if (!found) zonesOf.set(request, found = lookup())
  return found
  async function lookup() {
    let saved
    try {
      saved = decodeURIComponent(zoneCookie.exec(request.headers.get('cookie') ?? '')?.[1] ?? '')
    } catch {}
    const chosen = validZone(saved)
    if (chosen) return chosen
    const config = runtime()
    if (config.reportZone) return config.reportZone
    const session = await current(request)
    if (!session) return 'UTC'
    try {
      // An empty day of texts is the smallest answer that names the report's zone.
      const { timeZone } = await reviewGet(request, session, 'texts', { from: '1970-01-01', to: '1970-01-01' })
      return config.reportZone = validZone(timeZone) ?? 'UTC'
    } catch {
      return 'UTC'
    }
  }
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

/** What a person is called: the values the graph keeps of their group, and the record of the firm's own that stands for one the graph made. */
export interface Called { name?: string, phone?: string, email?: string, record?: string, phones?: string[], emails?: string[], dob?: string, address?: string, line?: string, callerName?: string, callerPlace?: string }

/**
 * What to call the people a page lists. Where the graph cannot say, the page shows IDs, as it did.
 */
export async function reviewCalled(request: Request, session: Pick<Reviewer, 'token'> & Partial<Pick<Reviewer, 'controller' | 'id'>>, subjects: Iterable<string | undefined | null>, every = false): Promise<Record<string, Called>> {
  const asked = [...new Set([...subjects].filter((each): each is string => typeof each === 'string' && each.length > 0))].slice(0, 2000)
  if (asked.length === 0) return {}
  // What people are called is an addition to a page. Where it cannot be read, the page shows IDs, as it did.
  let response: Response
  try {
    response = await fetch(new URL('/review/api/called', runtime().graphUrl), { method: 'POST', headers: { authorization: 'Bearer ' + session.token, 'content-type': 'application/json' }, body: JSON.stringify({ subjects: asked, ...(every && { every }) }), redirect: 'error', signal: AbortSignal.any([request.signal, ...(session.controller ? [session.controller.signal] : []), deadline(request)]) })
  } catch {
    return {}
  }
  if (response.status === 401) throw await signedOut(request, 'id' in session ? session as Reviewer : undefined)
  if (!response.ok) return {}
  return response.json().catch(() => ({}))
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
    // A page that cannot be read is replaced by one that says so. A form whose answer did not come is answered here, so the page it is on stays
    // as it is, with what was entered. Whether the graph took it is not known: the answer may be what was lost. The same form sent again is recorded once.
    const sent = request.method !== 'GET' && request.method !== 'HEAD'
    const unsaved = () => data({ error: 'The graph did not answer, so this may not have been saved. What you entered is still here. Send it again in a moment. Sent twice, it is recorded once.' }, { status: 503 }) as T
    if (error instanceof Response) {
      if (sent && error.status >= 500) return unsaved()
      throw error
    }
    const fault = error as { code?: string, message?: string }
    if (fault.code === 'AUTH.REJECTED') throw await signedOut(request, session)
    if (typeof fault.code === 'string' && fault.code.startsWith('INPUT.')) throw new Response('Check the values in the form and try again.', { status: 400 })
    if (sent) return unsaved()
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
  sessions.set(id, { id, name, token, retraction, controller, expires, since: Date.now() })
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

// Each address gets a few guesses at a reviewer token in a window. Signing in clears its count.
const attemptsAllowed = 10, attemptWindow = 15 * 60_000
function tooManyAttempts(address: string | undefined) {
  if (!address) return 0
  const attempts = runtime().attempts
  const now = Date.now()
  if (attempts.size > 10_000) for (const [key, entry] of attempts) if (now - entry.since > attemptWindow) attempts.delete(key)
  let entry = attempts.get(address)
  if (!entry || now - entry.since > attemptWindow) attempts.set(address, entry = { count: 0, since: now })
  entry.count++
  return entry.count > attemptsAllowed ? Math.ceil((entry.since + attemptWindow - now) / 1000) : 0
}

export async function signIn(request: Request) {
  checkOrigin(request)
  const address = clientAddress()
  const wait = tooManyAttempts(address)
  if (wait) return data({ error: 'Too many sign-in attempts from this address. Try again in ' + Math.ceil(wait / 60) + (wait > 60 ? ' minutes.' : ' minute.') }, { status: 429, headers: { 'retry-after': String(wait) } })
  const form = await fieldsOf(request)
  const token = String(form.get('token') ?? '')
  if (!/^[!-~]{1,2048}$/.test(token)) return data({ error: 'Enter your reviewer token.' }, { status: 400 })
  try {
    const me = await reviewGet(request, { token }, 'me')
    if (!me.reviewer) return data({ error: 'Use a token issued to a reviewer.' }, { status: 403 })
    if (address) runtime().attempts.delete(address)
    return redirect(safePath(form.get('next')), { status: 303, headers: { 'set-cookie': await openSession(request, token, me.reviewer, me.retraction) } })
  } catch (error) {
    if (error instanceof Response && error.status === 303) return data({ error: 'The graph did not accept this reviewer token.' }, { status: 401, headers: { 'set-cookie': (await signedOut(request, await current(request))).headers.get('set-cookie')! } })
    return data({ error: 'The graph is unavailable. Try signing in again.' }, { status: 503 })
  }
}
