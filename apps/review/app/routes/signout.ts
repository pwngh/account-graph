import type { ActionFunctionArgs } from 'react-router'
import { checkOrigin, requireReviewer, signedOut } from '../auth.server'
export async function action({request}: ActionFunctionArgs) {
  checkOrigin(request)
  return signedOut(request, await requireReviewer(request))
}
