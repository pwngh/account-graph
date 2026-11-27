import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { changeAccounts } from '../account.server'
import { remaining } from '../remaining.server'
import { Answer, DecisionScope, Table, Time, type ActionResult } from '../views/shared'
import { Matches, type MatchesModel } from '../views/matches'
const name = (request: Request) => new URL(request.url).pathname.slice(1).replace(/\.data$/, '')
export const loader = ({request}: LoaderFunctionArgs) => remaining(request, name(request))
export async function action({request}: ActionFunctionArgs) {
  if (name(request) !== 'decide') throw new Response('This page has no form.', {status: 405})
  return changeAccounts(request)
}
const feeds: Record<string,string> = {calls: 'Calls', touches: 'Visits', costs: 'Campaign costs', results: 'Call results'}
export function Remaining({model}: {model: Awaited<ReturnType<typeof remaining>>}) {
  if (model.view === 'decide') return <Matches model={model as unknown as MatchesModel}/>
  const title = model.view === 'health' ? 'Health' : 'Channels'
  return <DecisionScope key={model.view}><section><h2>{title}</h2><p>{model.legacy ? <><a href={model.legacy}>Open the full {title} view on the original reviewer screen</a>. Sign in there with your reviewer token.</> : `The original reviewer screen has the full ${title} view.`}</p>
    {'rows' in model && <><h3>Attribution</h3><Table headers={['Source','Campaign','Visits','Spend','Outcomes','Value']} title="Campaigns">{model.rows.map((r: Record<string,string|number>, i: number) => <tr key={i}>{['source','name','visits','cost','outcomes','value'].map(key => <td key={key}>{r[key] ?? '—'}</td>)}</tr>)}</Table></>}
    {'paused' in model && model.paused && <p className="stopped" role="alert">{`Sends to ad platforms are paused. ${model.paused.reason}. Since `}<Time at={model.paused.at}/>. Run account-graph sends resume once the cause is fixed.</p>}
    {'feeds' in model && <ul>{model.feeds.map((f: {name: string,quiet: boolean,hours: number}) => <li key={f.name}>{feeds[f.name]}{f.quiet ? ' feed is stale.' : f.hours ? ' feed is within its limit.' : ' feed is not monitored.'}</li>)}</ul>}</section></DecisionScope>
}
export default function Page() { return <><Answer result={useActionData<ActionResult>()}/><Remaining model={useLoaderData<typeof loader>()}/></> }
