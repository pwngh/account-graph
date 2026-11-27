import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { changeAccounts } from '../account.server'
import { remaining } from '../remaining.server'
import { Answer, type ActionResult } from '../views/shared'
import { Matches, type MatchesModel } from '../views/matches'
const name = (request: Request) => new URL(request.url).pathname.slice(1).replace(/\.data$/, '')
export const loader = ({request}: LoaderFunctionArgs) => remaining(request, name(request))
export async function action({request}: ActionFunctionArgs) {
  if (name(request) !== 'decide') throw new Response('This page has no form.', {status: 405})
  return changeAccounts(request)
}
export function Remaining({model}: {model: Awaited<ReturnType<typeof remaining>>}) {
  return <Matches model={model as unknown as MatchesModel}/>
}
export default function Page() { return <><Answer result={useActionData<ActionResult>()}/><Remaining model={useLoaderData<typeof loader>()}/></> }
