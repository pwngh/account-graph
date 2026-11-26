import type { ActionFunctionArgs } from 'react-router'
import { checkOrigin, requireReviewer, signedOut } from '../auth.server'
// Signing out changes state, so only the form's POST does it. An address typed or followed gets an answer, not a server error.
export function loader() {
  throw new Response('Sign out with the Sign out button at the top of the page.', {status: 405, headers: {allow: 'POST'}})
}
export async function action({request}: ActionFunctionArgs) {
  checkOrigin(request)
  return signedOut(request, await requireReviewer(request))
}
