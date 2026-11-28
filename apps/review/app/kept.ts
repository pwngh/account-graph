import { isRouteErrorResponse, type ClientLoaderFunctionArgs } from 'react-router'

/**
 * The page this tab shows, as it was read, by its address. When the page reads itself again and the graph does not answer, it keeps what
 * it showed and says so, where it would otherwise be replaced by the error page. Only the page on screen is kept: another page, or this
 * one opened again after leaving it, shows the error as before.
 */
let shown: { key: string; data: unknown } | undefined
const keyOf = (address: string) => {
  const url = new URL(address, 'http://page')
  return url.pathname + url.search
}

/** Keeps what the page on screen shows. Called once the page is displayed. */
export function remember(address: string, data: unknown) {
  shown = data === undefined ? undefined : { key: keyOf(address), data }
}

/** The note the page shows while it keeps what it last read. */
export const AWAY_NOTE = 'The graph is not answering. This page shows what it last read.'
export const GRAPH_AWAY = 'graph-away', GRAPH_BACK = 'graph-back'

export async function keptThroughOutage({ request, serverLoader }: ClientLoaderFunctionArgs) {
  try {
    const data = await serverLoader()
    window.dispatchEvent(new Event(GRAPH_BACK))
    return data
  } catch (error) {
    const unavailable = (error instanceof Response || isRouteErrorResponse(error)) && error.status === 503
    if (!unavailable || shown?.key !== keyOf(request.url)) throw error
    window.dispatchEvent(new Event(GRAPH_AWAY))
    return shown.data
  }
}
