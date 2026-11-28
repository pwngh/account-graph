import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadChannels } from '../channels.server'
import { Channels } from '../views/channels'
import { keptThroughOutage } from '../kept'

export const loader = ({ request }: LoaderFunctionArgs) => loadChannels(request)
export default function ChannelsPage() { return <Channels model={useLoaderData<typeof loader>()}/> }

// Read again while the graph is away, the page keeps what it showed.
export const clientLoader = keptThroughOutage
