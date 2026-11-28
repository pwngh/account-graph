import { type ActionFunctionArgs } from 'react-router'
import { checkOrigin, withGraph } from '../auth.server'

/** The kinds of ID a name typed without one is tried as, as the original screen tries them. */
const KNOWN_KINDS = ['account', 'visitor', 'lead', 'caller', 'contact', 'person']

/** Who what was typed into the search palette can mean. What is typed may be an email or a phone number, so it comes in a body, never an address. */
export async function action({ request }: ActionFunctionArgs) {
  checkOrigin(request)
  return withGraph(request, async (_session, graph) => {
    // Words typed into a search, and no more: a larger body is not read.
    if (Number(request.headers.get('content-length') ?? Infinity) > 2048) throw new Response('Too much to search for.', { status: 413 })
    const body = await request.json().catch(() => ({}))
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 512) : ''
    if (!text) return { by: 'subject', subjects: [] as string[] }
    const found = await graph.lookup({ kind: 'find', text }, { signal: request.signal })
    if (found.subjects.length > 0 || found.by !== 'subject' || text.includes(':')) return { by: found.by, subjects: found.subjects.slice(0, 8) }
    // One kind after another, until there are enough, so a name nobody has asks the graph in turn and not all at once.
    const subjects: string[] = []
    for (const kind of KNOWN_KINDS) {
      if (subjects.length >= 8 || request.signal.aborted) break
      subjects.push(...(await graph.lookup({ kind: 'find', text: kind + ':' + text }, { signal: request.signal })).subjects)
    }
    return { by: 'subject', subjects: subjects.slice(0, 8) }
  })
}
