import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { changeAccounts } from '../account.server'
import { remaining } from '../remaining.server'
import { Answer, DecisionScope, Table, type ActionResult } from '../views/shared'
import { Matches, type MatchesModel } from '../views/matches'
const name = (request: Request) => new URL(request.url).pathname.slice(1).replace(/\.data$/, '')
export const loader = ({request}: LoaderFunctionArgs) => remaining(request, name(request))
export async function action({request}: ActionFunctionArgs) {
  if (name(request) !== 'decide') throw new Response('This page has no form.', {status: 405})
  return changeAccounts(request)
}
export function Remaining({model}: {model: Awaited<ReturnType<typeof remaining>>}) {
  if (model.view === 'decide') return <Matches model={model as unknown as MatchesModel}/>
  return <DecisionScope key={model.view}><section><h2>Channels</h2><p>{model.legacy ? <><a href={model.legacy}>Open the full Channels view on the original reviewer screen</a>. Sign in there with your reviewer token.</> : 'The original reviewer screen has the full Channels view.'}</p>
    {'rows' in model && <><h3>Attribution</h3><Table headers={['Source','Campaign','Visits','Spend','Outcomes','Value']} title="Campaigns">{model.rows.map((r: Record<string,string|number>, i: number) => <tr key={i}>{['source','name','visits','cost','outcomes','value'].map(key => <td key={key}>{r[key] ?? '—'}</td>)}</tr>)}</Table></>}</section></DecisionScope>
}
export default function Page() { return <><Answer result={useActionData<ActionResult>()}/><Remaining model={useLoaderData<typeof loader>()}/></> }
