import { subjectPath } from '../navigation'
import { fieldsOf } from '../forms.server'
import { Link, redirect, useActionData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { checkOrigin, requireReviewer, reviewCalled, withGraph } from '../auth.server'
import { knownOf, shownPhone } from '../views/shared'
export async function loader({request}: LoaderFunctionArgs) { await requireReviewer(request); return null }
export async function action({request}: ActionFunctionArgs) {
  checkOrigin(request)
  return withGraph(request, async (session, graph) => {
    const text = String((await fieldsOf(request)).get('text') ?? '').trim()
    const result = await graph.lookup({kind: 'find', text}, {signal: request.signal})
    const exact = result.subjects.length === 1 ? result.subjects[0] : result.by === 'subject' && result.subjects.find(id => id === text)
    if (exact) throw redirect(subjectPath(exact), 303)
    return { ...result, called: await reviewCalled(request, session, result.subjects) }
  })
}
export default function Search() {
  const result = useActionData<typeof action>()
  // A search the graph could not answer says so, and the words stay in the box above.
  if (result && 'error' in result) return <section><h2>Search</h2><p className="apart" role="alert">The graph did not answer. Search again in a moment.</p></section>
  return <section><h2>Search</h2>{result?.subjects.length ? <ul>{result.subjects.map(id => <li key={id}><Link to={subjectPath(id)} title={knownOf(id, result.called[id])}><bdi>{result.called[id]?.name ?? (result.called[id]?.phone ? shownPhone(result.called[id].phone) : id)}</bdi></Link></li>)}</ul> : <p>{result ? 'No results.' : 'Search by name, ID, email, phone number or ad click.'}</p>}</section>
}
