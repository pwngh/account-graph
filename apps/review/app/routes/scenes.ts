import type { LoaderFunctionArgs } from 'react-router'
import { requireReviewer } from '../auth.server'
import { stage } from '../stage.server'
export async function loader({request}: LoaderFunctionArgs) {
  await requireReviewer(request)
  return Response.json(stage().state(), {headers: {'cache-control': 'no-store'}})
}
