import { Form, useActionData, useLoaderData, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { signIn, signInPage } from '../auth.server'
export const loader = ({request}: LoaderFunctionArgs) => signInPage(request)
export const action = ({request}: ActionFunctionArgs) => signIn(request)
// A refused attempt says when the address may try again.
export const headers = ({actionHeaders}: {actionHeaders: Headers}) => actionHeaders.has('retry-after') ? {'retry-after': actionHeaders.get('retry-after')!} : new Headers()
export default function SignIn() {
  const answer = useActionData<typeof action>()
  const before = useLoaderData<typeof loader>()
  const [query] = useSearchParams()
  return <section><h2>Sign in</h2>
    {before?.ended && !answer && <p role="status" id="ended">Your session has ended. That happens when the review app is restarted, after eight hours, or when you sign out in another tab. {query.get('next') ? 'Sign in again and you return to the page you were on.' : 'Sign in again.'} Decisions you had saved are kept.</p>}
    <Form method="post" reloadDocument>
    <input type="hidden" name="next" value={query.get('next') ?? '/accounts'} />
    <label>Reviewer token <input type="password" autoComplete="current-password" name="token" required /></label>
    <button className="primary">Sign in</button>
    {answer?.error && <p role="alert">{answer.error}</p>}
  </Form></section>
}
