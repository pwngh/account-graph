import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadReport } from '../reports.server'
import { readSubject } from '../navigation'
import { Report } from '../views/reports'

export function loader({ request, url, params }: LoaderFunctionArgs) {
  const kind = url.pathname.split('/')[1].toLowerCase()
  if (kind !== 'journey' && kind !== 'calls' && kind !== 'board') throw new Response('Unknown report', {status: 404})
  return loadReport(request, kind, kind === 'journey' ? readSubject(url) ?? params.subject : params.days)
}

export default function ReportPage() {
  return <Report data={useLoaderData<typeof loader>()}/>
}
