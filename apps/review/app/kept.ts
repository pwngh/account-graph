import { isRouteErrorResponse, type ClientLoaderFunctionArgs } from 'react-router'

/**
 * What each page last read, by its address, in this browser tab. A page that reads itself again while the graph does not answer keeps
 * what it showed, and says so, where it would otherwise be replaced by the error page. A page opened for the first time has nothing kept,
 * and shows the error as before.
 */
const kept = new Map<string, unknown>()
const MOST = 10
const keyOf = (address: string) => {
  const url = new URL(address, 'http://page')
  return url.pathname + url.search
}

/** Keeps what a page read, as the page shows it. */
export function remember(address: string, data: unknown) {
  if (data === undefined) return
  const key = keyOf(address)
  kept.delete(key)
  kept.set(key, data)
  if (kept.size > MOST) kept.delete(kept.keys().next().value!)
}

let away = false
/** Told whether the graph answered the last read of a page. */
export const GRAPH_AWAY = 'graph-away', GRAPH_BACK = 'graph-back'

export async function keptThroughOutage({ request, serverLoader }: ClientLoaderFunctionArgs) {
  const key = keyOf(request.url)
  try {
    const data = await serverLoader()
    remember(key, data)
    if (away) window.dispatchEvent(new Event(GRAPH_BACK))
    away = false
    return data
  } catch (error) {
    const unavailable = (error instanceof Response || isRouteErrorResponse(error)) && error.status === 503
    if (!unavailable || !kept.has(key)) throw error
    away = true
    window.dispatchEvent(new Event(GRAPH_AWAY))
    return kept.get(key)
  }
}
