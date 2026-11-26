import type { LoaderFunctionArgs } from 'react-router'
import { events } from '../events.server'
export const loader = ({ request }: LoaderFunctionArgs) => events(request)
