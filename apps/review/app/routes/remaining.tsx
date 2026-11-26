import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { changeAccounts } from '../account.server'
import { remaining } from '../remaining.server'
import { Answer, DecisionForm, DecisionScope, Subject, Table, percent, type ActionResult } from '../views/shared'
const name = (request: Request) => new URL(request.url).pathname.slice(1).replace(/\.data$/, '')
export const loader = ({request}: LoaderFunctionArgs) => remaining(request, name(request))
export async function action({request}: ActionFunctionArgs) {
  if (name(request) !== 'decide') throw new Response('This page has no form.', {status: 405})
  return changeAccounts(request)
}
interface Pair {a: string, b: string, score: number}
const feeds: Record<string,string> = {calls: 'Calls', touches: 'Visits', costs: 'Campaign costs', results: 'Call results'}
export function Remaining({model}: {model: Awaited<ReturnType<typeof remaining>>}) {
  const title = model.view === 'decide' ? 'Matches' : model.view === 'health' ? 'Health' : 'Channels'
  return <DecisionScope key={model.view}><section><h2>{title}</h2><p><a href={model.legacy}>Open the full {title} view on the original reviewer screen</a>. Sign in there with your reviewer token.</p>
    {'queue' in model && <><p>Pending {model.queue.total} · IDs checked {model.queue.seen}</p><ol>{model.queue.pairs.map((p: Pair) => <li className="queue-pair" key={JSON.stringify([p.a,p.b])}><Subject id={p.a}/> and <Subject id={p.b}/> · {percent(p.score)}
      <DecisionForm context={model.context} intent="join" subject={p.a} other={p.b}/><DecisionForm context={model.context} intent="separate" subject={p.a} other={p.b}/></li>)}</ol>{!model.queue.pairs.length && <p>No pending matches</p>}</>}
    {'rows' in model && <><h3>Attribution</h3><Table headers={['Source','Campaign','Visits','Spend','Outcomes','Value']} title="Campaigns">{model.rows.map((r: Record<string,string|number>, i: number) => <tr key={i}>{['source','name','visits','cost','outcomes','value'].map(key => <td key={key}>{r[key] ?? '—'}</td>)}</tr>)}</Table></>}
    {'feeds' in model && <ul>{model.feeds.map((f: {name: string,quiet: boolean,hours: number}) => <li key={f.name}>{feeds[f.name]}{f.quiet ? ' feed is stale.' : f.hours ? ' feed is within its limit.' : ' feed is not monitored.'}</li>)}</ul>}</section></DecisionScope>
}
export default function Page() { return <><Answer result={useActionData<ActionResult>()}/><Remaining model={useLoaderData<typeof loader>()}/></> }
