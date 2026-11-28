/**
 * Checks a running stack as a member of staff meets it: the graph answers, the review app serves its sign-in
 * page, a wrong token is refused, a reviewer signs in, and each page opens as itself.
 *   docker compose up --build --detach --wait
 *   node tools/stack-check.ts
 *
 * GRAPH_URL, REVIEW_URL and REVIEW_TOKEN name another stack. The defaults are the ones compose.yaml starts.
 * Every request has ten seconds, and the whole check two minutes.
 */
const graph = process.env.GRAPH_URL ?? 'http://localhost:8080'
const app = process.env.REVIEW_URL ?? 'http://localhost:3100'
const token = process.env.REVIEW_TOKEN ?? 'change-me-review-token'

const deadline = AbortSignal.timeout(120_000)
const done: string[] = []
function check(what: string, holds: boolean, seen?: unknown): void {
  if (!holds) throw new Error(`${what}${seen === undefined ? '' : `: ${String(seen).slice(0, 200)}`}`)
  done.push(what)
}

/** One request and its whole answer, within ten seconds. A redirect is answered as it is, not followed. */
async function ask(url: string, init: RequestInit = {}): Promise<{ status: number; text: string; location: string; cookies: string }> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]) })
  return { status: response.status, text: await response.text(), location: response.headers.get('location') ?? '', cookies: response.headers.getSetCookie().map((each) => each.split(';')[0]).join('; ') }
}

/** A stack that was just started may not answer on the first try. */
async function reached(url: string): Promise<Awaited<ReturnType<typeof ask>>> {
  let last: unknown
  for (let tries = 0; tries < 30; tries++) {
    try {
      return await ask(url)
    } catch (error) {
      if (deadline.aborted) break
      last = error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error(`${url} did not answer: ${String(last)}`)
}

const signin = (given: string) => ask(app + '/signin', { method: 'POST', headers: { origin: app, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: given }) })
/** Whether an answer sends the browser to the sign-in page of this app. */
const sentToSignin = (answer: { status: number; location: string }) => answer.status >= 300 && answer.status < 400 && new URL(answer.location, app).origin === new URL(app).origin && new URL(answer.location, app).pathname === '/signin'
/** The page's own entry in the menu is the one marked as open. */
const opens = (html: string, view: string) => (html.match(/<a\b[^>]*aria-current="page"[^>]*>/g) ?? []).some((link) => new RegExp(`href="/${view}(["/?])`).test(link))

try {
  const health = await reached(graph + '/health')
  check('the graph says it is healthy', health.status === 200, health.status)

  const page = await reached(app + '/signin')
  check('the review app serves its sign-in page', page.status === 200 && page.text.includes('<form'), page.status)

  // A wrong token is told so, and whatever cookie comes back with that opens nothing.
  const refused = await signin('not-a-token')
  check('a wrong token is refused', refused.status >= 400 && refused.status < 500, refused.status)
  const tried = await ask(app + '/accounts', { headers: { cookie: refused.cookies } })
  check('a refused sign-in opens no page', sentToSignin(tried), `${tried.status} ${tried.location}`)

  const entered = await signin(token)
  check('a reviewer signs in', entered.status >= 300 && entered.status < 400 && entered.cookies.length > 0 && !sentToSignin(entered), `${entered.status} ${entered.location}`)

  for (const [path, view] of [['/accounts', 'accounts'], ['/board/90', 'board'], ['/calls', 'calls'], ['/channels', 'channels'], ['/decide', 'decide'], ['/health', 'health']] as const) {
    const opened = await ask(app + path, { headers: { cookie: entered.cookies } })
    check(`${path} opens for the reviewer, as itself`, opened.status === 200 && opens(opened.text, view), `${opened.status} ${opened.location}`)
  }

  const closed = await ask(app + '/accounts')
  check('a page does not open without signing in', sentToSignin(closed), `${closed.status} ${closed.location}`)

  console.log(done.map((line) => `ok  ${line}`).join('\n'))
} catch (error) {
  console.log(done.map((line) => `ok  ${line}`).join('\n'))
  console.error(`not ok  ${(error as Error).message}`)
  process.exitCode = 1
}
