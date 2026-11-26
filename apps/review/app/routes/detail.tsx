import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadCard } from '../reports.server'
import { CardBody } from '../views/reports'

export async function loader({ request, params }: LoaderFunctionArgs) {
  return loadCard(request, params.report, params.which)
}

export default function DetailPage() {
  const { card, canonical } = useLoaderData<typeof loader>()
  return <section><h2>{card.title}</h2><CardBody card={card}/><Link to={canonical}>Back to report</Link></section>
}
