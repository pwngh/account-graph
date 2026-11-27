import type { LoaderFunctionArgs } from 'react-router'
import { channelsCsv } from '../channels.server'

export const loader = ({ request }: LoaderFunctionArgs) => channelsCsv(request)
