import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { readSubject } from '../navigation'
import { loadCard } from '../reports.server'
import { CardBody } from '../views/reports'
import { keptThroughOutage } from '../kept'

export async function loader({ request, url, params }: LoaderFunctionArgs) {
  return loadCard(request, params.report, readSubject(url) ?? params.which)
}

export default function DetailPage() {
  const { card, canonical } = useLoaderData<typeof loader>()
  return <section><h2>{card.title}</h2><CardBody card={card}/><Link to={canonical}>Back to report</Link></section>
}

// Read again while the graph is away, the page keeps what it showed.
export const clientLoader = keptThroughOutage
