import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { loadAccounts, changeAccounts } from '../account.server'
import { Answer, type ActionResult } from '../views/shared'
import { readSubject, subjectAddress } from '../navigation'
import Accounts from '../views/accounts'
export const loader = ({request,url,params}: LoaderFunctionArgs) => loadAccounts(request, readSubject(url) ?? params.subject)
export const action = ({request,url,params}: ActionFunctionArgs) => changeAccounts(request, subjectAddress(url.pathname)?.subject ?? params.subject)
export default function AccountPage() {
  const data = useLoaderData<typeof loader>()
  return <><Answer result={useActionData<ActionResult>()}/><Accounts key={data.subject ?? ''} data={data}/></>
}
