import { type ActionFunctionArgs } from 'react-router'
import { checkOrigin, withGraph } from '../auth.server'

/** The kinds of ID a name typed without one is tried as, as the original screen tries them. */
const KNOWN_KINDS = ['account', 'visitor', 'lead', 'caller', 'contact', 'person']

/** Who what was typed into the search palette can mean. What is typed may be an email or a phone number, so it comes in a body, never an address. */
export async function action({ request }: ActionFunctionArgs) {
  checkOrigin(request)
  return withGraph(request, async (_session, graph) => {
    const text = String((await request.json().catch(() => ({})))?.text ?? '').trim().slice(0, 512)
    if (!text) return { by: 'subject', subjects: [] as string[] }
    const found = await graph.lookup({ kind: 'find', text }, { signal: request.signal })
    if (found.subjects.length > 0 || found.by !== 'subject' || text.includes(':')) return { by: found.by, subjects: found.subjects.slice(0, 8) }
    const tried = await Promise.all(KNOWN_KINDS.map(kind => graph.lookup({ kind: 'find', text: kind + ':' + text }, { signal: request.signal })))
    return { by: 'subject', subjects: tried.flatMap(each => each.subjects).slice(0, 8) }
  })
}
