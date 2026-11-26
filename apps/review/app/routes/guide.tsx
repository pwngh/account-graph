import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { requireReviewer } from '../auth.server'
import calls from '../../../../docs/calls.md?raw'
import report from '../../../../docs/report.md?raw'
import operations from '../../../../docs/operations.md?raw'

// Cards refer to these parts of the manual. Serve the version that shipped with the app, including offline.
const sections: Record<string, [string, string]> = {
  'call-results': [calls, 'Call results'],
  'unanswered-texts': [calls, 'Unanswered texts'],
  board: [report, 'Board'],
  steps: [report, 'Steps'],
  'missed-callers': [operations, 'Missed callers'],
  'opening-hours': [operations, 'Opening hours'],
}
export async function loader({request, params}: LoaderFunctionArgs) {
  await requireReviewer(request)
  const which = params.section ?? ''
  if (!Object.hasOwn(sections, which)) throw new Response('Unknown section', {status: 404})
  const [document, title] = sections[which]
  const lines = document.split('\n')
  const start = lines.findIndex(line => /^#{2,3} /.test(line) && line.replace(/^#+ /, '') === title)
  const end = lines.findIndex((line, i) => i > start && /^#{1,3} /.test(line))
  return {title, body: lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim()}
}
export default function Guide() {
  const {title, body} = useLoaderData<typeof loader>()
  return <section><h2>{title}</h2><pre className="manual">{body}</pre></section>
}
