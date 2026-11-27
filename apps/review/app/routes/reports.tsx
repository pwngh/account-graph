import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { loadReport, retryConversion } from '../reports.server'
import { Answer, type ActionResult } from '../views/shared'
import { readSubject } from '../navigation'
import { Report } from '../views/reports'

export function loader({ request, url, params }: LoaderFunctionArgs) {
  const kind = url.pathname.split('/')[1].toLowerCase()
  if (kind !== 'journey' && kind !== 'calls' && kind !== 'board' && kind !== 'health') throw new Response('Unknown report', {status: 404})
  return loadReport(request, kind, kind === 'journey' ? readSubject(url) ?? params.subject : params.days)
}

// Health has the one form of these pages: Retry on a rejected conversion.
export async function action({ request, url }: ActionFunctionArgs) {
  if (url.pathname.split('/')[1].toLowerCase() !== 'health') throw new Response('This page has no form.', {status: 405})
  return retryConversion(request)
}

export default function ReportPage() {
  return <><Answer result={useActionData<ActionResult>()}/><Report data={useLoaderData<typeof loader>()}/></>
}
