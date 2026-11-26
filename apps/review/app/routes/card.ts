import type { LoaderFunctionArgs } from 'react-router'
import { loadCard } from '../reports.server'

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const answer = await loadCard(request, params.report, params.which)
    return Response.json(answer, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof Response && error.headers.has('location')) throw error
    return Response.json({ error: 'These details are unavailable. Open the report again to read the current row.' }, { status: error instanceof Response ? error.status : 503, headers: { 'cache-control': 'no-store' } })
  }
}
