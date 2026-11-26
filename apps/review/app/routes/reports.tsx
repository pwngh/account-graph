import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadReport } from '../reports.server'
import { Report } from '../views/reports'

export function loader({ request, params }: LoaderFunctionArgs) {
  const kind = new URL(request.url).pathname.split('/')[1].replace(/\.data$/, '')
  if (kind !== 'journey' && kind !== 'calls' && kind !== 'board') throw new Response('Unknown report', {status: 404})
  return loadReport(request, kind, params.subject ?? params.days)
}

export default function ReportPage() {
  return <Report data={useLoaderData<typeof loader>()}/>
}
