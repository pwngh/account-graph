import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { loadAccounts, changeAccounts } from '../account.server'
import { Answer, type ActionResult } from '../views/shared'
import Accounts from '../views/accounts'
export const loader = ({request,params}: LoaderFunctionArgs) => loadAccounts(request, params.subject)
export const action = ({request,params}: ActionFunctionArgs) => changeAccounts(request, params.subject)
export default function AccountPage() {
  const data = useLoaderData<typeof loader>()
  return <><Answer result={useActionData<ActionResult>()}/><Accounts key={data.subject ?? ''} data={data}/></>
}
