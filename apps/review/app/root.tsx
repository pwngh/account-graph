import { useEffect, useState } from 'react'
import { Form, Links, NavLink, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useLocation, useNavigation, useRouteError, useRevalidator, useRouteLoaderData, type LoaderFunctionArgs } from 'react-router'
import { current } from './auth.server'
import original from '../../../src/edge/review/style.css?url'
import additions from './style.css?url'
export const links = () => [{rel: 'stylesheet', href: original}, {rel: 'stylesheet', href: additions}]
export async function loader({request}: LoaderFunctionArgs) { return {name: (await current(request))?.name} }
const menu = [['accounts','Accounts'], ['journey','Journey'], ['board/90','Board'], ['decide','Matches'], ['calls','Calls'], ['channels','Channels'], ['health','Health']]

function Live({path}: {path: string}) {
  const {revalidate} = useRevalidator()
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!window.EventSource) return
    const stream = new EventSource('/events')
    let connected = false
    const view = path.split('/')[1]
    stream.onopen = () => { if (connected) void revalidate(); connected = true; setStatus('') }
    stream.addEventListener('change', event => {
      const {views} = JSON.parse(event.data)
      if (views.includes('*') || views.includes(view)) void revalidate()
    })
    stream.addEventListener('signout', () => { stream.close(); location.replace('/signin') })
    const unavailable = () => setStatus('Live updates interrupted. Reload for the latest data.')
    stream.onerror = unavailable
    stream.addEventListener('unavailable', unavailable)
    return () => stream.close()
  }, [path, revalidate])
  return <span role="status">{status}</span>
}

export function Layout({children}: {children: React.ReactNode}) {
  const data = useRouteLoaderData<typeof loader>('root')
  const location = useLocation()
  const navigation = useNavigation()
  useEffect(() => {
    function bookmark() {
      const path = window.location.hash.slice(1)
      if (/^\/(accounts|journey|board|decide|calls|channels|health)(\/[^?#\\]*)?$/.test(path)) window.location.replace(path)
    }
    bookmark()
    window.addEventListener('hashchange', bookmark)
    return () => window.removeEventListener('hashchange', bookmark)
  }, [])
  const subject = /^\/(?:accounts|journey)\/(.+?)\/?$/.exec(location.pathname)?.[1]
  return <html lang="en"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="robots" content="noindex, nofollow"/><title>Account review</title><Links/></head><body>
    <a className="skip" href="#view">Skip to content</a><header><h1>Account review</h1>{data?.name && <>
    <nav id="views" aria-label="Views">{menu.map(([path,title]) => <NavLink key={path} to={'/' + (path === 'journey' && subject ? path + '/' + subject : path)}>{title}</NavLink>)}</nav>
    <Form id="find" className="row" method="post" action="/search"><label>Search <input name="text" placeholder="Search" autoComplete="off" required /></label><button>Open</button></Form>
    <Form method="post" action="/signout" reloadDocument>{data.name} <button>Sign out</button></Form></>}</header>
    <div id="notice" role="status">{navigation.state === 'loading' ? 'Opening view…' : navigation.state === 'submitting' ? 'Saving…' : ''}</div>
    <main id="view" tabIndex={-1}>{children}</main><footer>{data?.name && location.pathname !== '/stage' && <Live path={location.pathname}/>}</footer><ScrollRestoration/><Scripts/></body></html>
}
export default function App() { return <Outlet/> }
export function ErrorBoundary() {
  const error = useRouteError()
  return <section role="alert"><h2>{isRouteErrorResponse(error) && error.status === 404 ? 'Page not found' : 'The page could not be opened'}</h2>
    <p>{isRouteErrorResponse(error) && typeof error.data === 'string' ? error.data : 'The graph is unavailable. Reload to try again.'}</p><a href="">Try again</a> · <a href="/accounts">Accounts</a></section>
}
