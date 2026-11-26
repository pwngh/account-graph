import { subjectPath } from '../navigation'
import { fieldsOf } from '../forms.server'
import { Link, redirect, useActionData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { checkOrigin, requireReviewer, withGraph } from '../auth.server'
export async function loader({request}: LoaderFunctionArgs) { await requireReviewer(request); return null }
export async function action({request}: ActionFunctionArgs) {
  checkOrigin(request)
  return withGraph(request, async (_, graph) => {
    const text = String((await fieldsOf(request)).get('text') ?? '').trim()
    const result = await graph.lookup({kind: 'find', text}, {signal: request.signal})
    const exact = result.subjects.length === 1 ? result.subjects[0] : result.by === 'subject' && result.subjects.find(id => id === text)
    if (exact) throw redirect(subjectPath(exact), 303)
    return result
  })
}
export default function Search() {
  const result = useActionData<typeof action>()
  return <section><h2>Search</h2>{result?.subjects.length ? <ul>{result.subjects.map(id => <li key={id}><Link to={subjectPath(id)}><bdi>{id}</bdi></Link></li>)}</ul> : <p>{result ? 'No results.' : 'Search by ID, email, phone number or ad click.'}</p>}</section>
}
