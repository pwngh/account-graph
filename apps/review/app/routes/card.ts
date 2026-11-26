import type { LoaderFunctionArgs } from 'react-router'
import { readSubject } from '../navigation'
import { loadCard } from '../reports.server'

export async function loader({ request, url, params }: LoaderFunctionArgs) {
  const snapshot = new URL(request.url).searchParams.get('snapshot')
  if (snapshot && !/^[0-9a-f-]{36}$/.test(snapshot)) return Response.json({error:'Invalid report snapshot.'}, {status:400})
  try {
    const answer = await loadCard(request, params.report, readSubject(url) ?? params.which)
    return Response.json({ ...answer, snapshot }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof Response && error.headers.has('location')) throw error
    return Response.json({ snapshot, error: 'These details are unavailable. Open the report again to read the current row.' }, { status: error instanceof Response ? error.status : 503, headers: { 'cache-control': 'no-store' } })
  }
}
