import { useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { loadReport, retryConversion, sayOfCall } from '../reports.server'
import { Answer, type ActionResult } from '../views/shared'
import { readSubject } from '../navigation'
import { Report } from '../views/reports'

export function loader({ request, url, params }: LoaderFunctionArgs) {
  const kind = url.pathname.split('/')[1].toLowerCase()
  if (kind !== 'journey' && kind !== 'calls' && kind !== 'board' && kind !== 'health') throw new Response('Unknown report', {status: 404})
  return loadReport(request, kind, kind === 'journey' ? readSubject(url) ?? params.subject : params.days)
}

// Three of these pages have forms: Retry on a rejected conversion on Health, and what a reviewer says of a missed call on Calls and on the Board.
export async function action({ request, url }: ActionFunctionArgs) {
  const kind = url.pathname.split('/')[1].toLowerCase()
  if (kind === 'health') return retryConversion(request)
  if (kind === 'calls' || kind === 'board') return sayOfCall(request)
  throw new Response('This page has no form.', {status: 405})
}

export default function ReportPage() {
  return <><Answer result={useActionData<ActionResult>()}/><Report data={useLoaderData<typeof loader>()}/></>
}
