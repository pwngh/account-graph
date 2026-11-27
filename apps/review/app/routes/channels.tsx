import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { loadChannels } from '../channels.server'
import { Channels } from '../views/channels'

export const loader = ({ request }: LoaderFunctionArgs) => loadChannels(request)
export default function ChannelsPage() { return <Channels model={useLoaderData<typeof loader>()}/> }
