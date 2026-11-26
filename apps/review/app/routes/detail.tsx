import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadReport } from '../reports.server'
import { CardBody } from '../views/reports'

export async function loader({ request, params }: LoaderFunctionArgs) {
  const kind = params.report
  const item = new URL(request.url).searchParams.get('item')
  if (!item || !/^[a-z.]+\.[\w-]{24}$/.test(item) || (kind !== 'calls' && kind !== 'journey' && kind !== 'board')) throw new Response('Unknown detail', {status: 404})
  const { cards, canonical } = await loadReport(request, kind, params.which, item)
  return { card: cards[item], canonical }
}

export default function DetailPage() {
  const { card, canonical } = useLoaderData<typeof loader>()
  return <section><h2>{card.title}</h2><CardBody card={card}/><Link to={canonical}>Back to report</Link></section>
}
