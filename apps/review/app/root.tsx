import { useEffect, useEffectEvent, useState } from 'react'
import { Form, Link, Links, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useLocation, useNavigation, useRouteError, useRevalidator, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router'
import { current } from './auth.server'
import { runtime } from './runtime.server'
import { affectsPage, oldBookmark, subjectAddress, subjectPath } from './navigation'
import original from '../../../src/edge/review/style.css?url'
import additions from './style.css?url'
export const links = () => [{rel: 'icon', type: 'image/svg+xml', href: '/favicon.ico'}, {rel: 'stylesheet', href: original}, {rel: 'stylesheet', href: additions}]
export async function loader({request}: LoaderFunctionArgs) { return {name: (await current(request))?.name, legacy: runtime().legacy, live: Boolean(runtime().eventsToken)} }
const menu = [['accounts','Accounts'], ['journey','Journey'], ['board/90','Board'], ['decide','Matches'], ['calls','Calls'], ['channels','Channels'], ['health','Health']]

function Live({path}: {path: string}) {
  const {revalidate} = useRevalidator()
  const [status, setStatus] = useState('')
  const report = useRouteLoaderData('journey')
  const receive = useEffectEvent((event: MessageEvent) => {
    const subjects = report?.journey ? [report.which, ...Object.keys(report.journey.subjects)] : []
    if (affectsPage(JSON.parse(event.data), path, subjects)) void revalidate()
  })
  useEffect(() => {
    if (!window.EventSource) return
    const stream = new EventSource('/events')
    let connected = false
    stream.onopen = () => { if (connected) void revalidate(); connected = true; setStatus('') }
    stream.addEventListener('change', receive)
    stream.addEventListener('signout', () => { stream.close(); location.replace('/signin') })
    const interrupted = () => setStatus('Live updates interrupted. Reload for the latest data.')
    // A server restart ends the stream plainly, and the browser opens it again by itself.
    stream.onerror = () => stream.readyState === EventSource.CLOSED ? interrupted() : setStatus('Live updates paused. Reconnecting…')
    stream.addEventListener('unavailable', () => { stream.close(); interrupted() })
    return () => stream.close()
  }, [revalidate])
  return <span role="status">{status}</span>
}

export function Layout({children}: {children: React.ReactNode}) {
  const data = useRouteLoaderData<typeof loader>('root')
  const location = useLocation()
  const navigation = useNavigation()
  useEffect(() => {
    function bookmark() {
      const path = oldBookmark(window.location.hash, window.location.pathname, data?.legacy)
      if (path) window.location.replace(!data?.name && path.startsWith('/') && !path.startsWith('/legacy') ? '/signin?next=' + encodeURIComponent(path) : path)
    }
    bookmark()
    window.addEventListener('hashchange', bookmark)
    return () => window.removeEventListener('hashchange', bookmark)
  }, [data?.legacy, data?.name])
  useEffect(() => {
    function search(event: KeyboardEvent) {
      const input = document.querySelector<HTMLInputElement>('#find input')
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && input) {
        event.preventDefault()
        input.focus()
        input.select()
      }
    }
    window.addEventListener('keydown', search)
    return () => window.removeEventListener('keydown', search)
  }, [])
  const subject = subjectAddress(location.pathname)?.subject
  return <html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Account review</title><Links/></head><body>
    <a className="skip" href="#view">Skip to content</a><header><h1>Account review</h1>{data?.name && <>
    <nav id="views" aria-label="Views">{menu.map(([path,title]) => <Link aria-current={location.pathname.split('/')[1] === path.split('/')[0] ? 'page' : undefined} key={path} to={path === 'journey' && subject ? subjectPath(subject, 'journey') : '/' + path}>{title}</Link>)}</nav>
    <Form id="find" className="row" method="post" action="/search"><label>Search <input name="text" aria-keyshortcuts="Control+K Meta+K" placeholder="Search" autoComplete="off" required /></label><button>Open</button></Form>
    <Form method="post" action="/signout" reloadDocument><bdi>{data.name}</bdi> <button>Sign out</button></Form></>}</header>
    <div id="notice" role="status">{navigation.state === 'loading' ? 'Opening view…' : navigation.state === 'submitting' ? 'Saving…' : ''}</div>
    <main id="view" tabIndex={-1}>{children}</main><footer>{data?.name && location.pathname !== '/stage' && (data.live ? <Live path={location.pathname}/> : <p className="meta">Live updates are off. Reload to see changes.</p>)}</footer><ScrollRestoration/><Scripts/></body></html>
}
export default function App() { return <Outlet/> }
export function ErrorBoundary() {
  const error = useRouteError()
  return <section role="alert"><h2>{isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : 'The page could not be opened'}</h2>
    <p>{isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : 'The graph is unavailable. Reload to try again.'}</p><a href="">Try again</a> · <a href="/accounts">Accounts</a></section>
}
