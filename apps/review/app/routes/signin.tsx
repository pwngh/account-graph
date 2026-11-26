import { Form, useActionData, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { signIn, signInPage } from '../auth.server'
export const loader = ({request}: LoaderFunctionArgs) => signInPage(request)
export const action = ({request}: ActionFunctionArgs) => signIn(request)
export default function SignIn() {
  const answer = useActionData<typeof action>()
  const [query] = useSearchParams()
  return <section><h2>Sign in</h2><Form method="post" reloadDocument>
    <input type="hidden" name="next" value={query.get('next') ?? '/accounts'} />
    <label>Reviewer token <input type="password" autoComplete="current-password" name="token" required /></label>
    <button className="primary">Sign in</button>
    {answer?.error && <p role="alert">{answer.error}</p>}
  </Form></section>
}
