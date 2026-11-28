import { Palette } from './views/palette'
import { useEffect, useEffectEvent, useState } from 'react'
import { Form, Link, Links, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useLocation, useNavigation, useRouteError, useRevalidator, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router'
import { current, reviewerZone } from './auth.server'
import { runtime } from './runtime.server'
import { ZoneContext } from './views/shared'
import { ViewMark, type ViewName } from './views/marks'
import { affectsPage, oldBookmark, subjectAddress, subjectPath } from './navigation'
import original from '../../../src/edge/review/style.css?url'
import additions from './style.css?url'
export const links = () => [{rel: 'icon', type: 'image/svg+xml', href: '/favicon.ico'}, {rel: 'stylesheet', href: original}, {rel: 'stylesheet', href: additions}]
export async function loader({request}: LoaderFunctionArgs) { return {name: (await current(request))?.name, legacy: runtime().legacy, live: Boolean(runtime().eventsToken), zone: await reviewerZone(request)} }
const menu: [string, string, ViewName][] = [['accounts','Accounts','accounts'], ['journey','Journey','journey'], ['board/90','Board','board'], ['decide','Matches','decide'], ['calls','Calls','calls'], ['channels','Channels','channels'], ['health','Health','health']]

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
  const {revalidate} = useRevalidator()
  useEffect(() => {
    // Times are written on the server. Tell it this browser's zone once, then read the page again in it.
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!local || !data?.name) return
    const saved = /(?:^|;\s*)review_zone=([^;]*)/.exec(document.cookie)?.[1]
    if (saved === encodeURIComponent(local)) return
    document.cookie = 'review_zone=' + encodeURIComponent(local) + '; path=/; max-age=31536000; samesite=strict' + (window.location.protocol === 'https:' ? '; secure' : '')
    if (data.zone !== local) void revalidate()
  }, [data?.name, data?.zone, revalidate])
  // The server cannot tell which keyboard this is, so the page says Ctrl K until the browser has said.
  const [keys, setKeys] = useState('Ctrl K')
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.platform)) setKeys('⌘ K') }, [])
  const subject = subjectAddress(location.pathname)?.subject
  return <html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Account review</title><Links/></head><body>
    <a className="skip" href="#view">Skip to content</a><header><h1>Account review</h1>{data?.name && <>
    <nav id="views" aria-label="Views">{menu.map(([path,title,mark]) => <Link aria-current={location.pathname.split('/')[1] === path.split('/')[0] ? 'page' : undefined} key={path} to={path === 'journey' && subject ? subjectPath(subject, 'journey') : '/' + path}><ViewMark name={mark}/>{title}</Link>)}</nav>
    <Form id="find" className="row" method="post" action="/search"><label>Search <input name="text" aria-keyshortcuts="Control+K Meta+K" placeholder="Search" autoComplete="off" enterKeyHint="search" required /></label><button className="primary">Open</button><span id="summon" aria-hidden="true"><kbd>{keys}</kbd></span></Form>
    <Form id="who" className="row" method="post" action="/signout" reloadDocument><bdi id="name">{data.name}</bdi><button id="leave">Sign out</button></Form></>}</header>
    <div id="notice" role="status">{navigation.state === 'loading' ? 'Opening view…' : navigation.state === 'submitting' ? 'Saving…' : ''}</div>
    {data?.name && <Palette views={menu}/>}
    <main id="view" tabIndex={-1}><ZoneContext.Provider value={data?.zone ?? 'UTC'}>{children}</ZoneContext.Provider></main><footer>{data?.name && location.pathname !== '/stage' && (data.live ? <Live path={location.pathname}/> : <p className="meta">Live updates are off. Reload to see changes.</p>)}{data?.name && <span id="zone">Times in {data.zone}</span>}</footer><ScrollRestoration/><Scripts/></body></html>
}
export default function App() { return <Outlet/> }
export function ErrorBoundary() {
  const error = useRouteError()
  return <section role="alert"><h2>{isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : 'The page could not be opened'}</h2>
    <p>{isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : 'The graph is unavailable. Reload to try again.'}</p><a href="">Try again</a> · <a href="/accounts">Accounts</a></section>
}
