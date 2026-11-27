import { randomUUID } from 'node:crypto'
import { graphTime, runtime } from './runtime.server'
import { reviewGet, withGraph } from './auth.server'

export function remaining(request: Request, view: string) {
  return withGraph(request, async session => {
    const legacy = runtime().legacy
    const base = { view, legacy: legacy && legacy + '#/' + view }
    if (view === 'decide') {
      const audit = await reviewGet(request, session, 'decisions', {limit: '1'})
      const queue = await reviewGet(request, session, 'undecided')
      const context = {seen: audit.decisions[0]?.seq ?? 0, key: randomUUID(), at: graphTime()}
      // The pair the address names, or the strongest. A pair decided since is no longer in the queue, and the first takes its place.
      const named = new URL(request.url).searchParams.get('pair')
      const at = Math.max(0, queue.pairs.findIndex((pair: {a: string, b: string}) => pair.a + '\n' + pair.b === named))
      const pair = queue.pairs[at]
      if (!pair) return {...base, queue, context, at}
      const sides = await Promise.all([pair.a, pair.b].map(async subject => sideOf(subject, await reviewGet(request, session, 'subject', {subject}))))
      return {...base, queue, context, at, sides, effect: await effectOf(session.token, pair)}
    }
    if (view === 'channels') {
      const {rows} = await reviewGet(request, session, 'report')
      return {...base, rows: rows.map((r: Record<string,unknown>) => ({source:r.source, name:r.campaign || r.campaignId, visits:r.visits, cost:r.cost, value:r.value, outcomes:r.outcomes}))}
    }
    throw new Response('Unknown view', {status: 404})
  })
}

/** What the comparison of a pair shows of one of them. The page gets this and not the whole record. */
function sideOf(subject: string, profile: any) {
  const history: {at: number, identifier: string, event?: string}[] = profile.history ?? []
  const times = history.map(row => row.at).filter(at => at > 0)
  return {
    subject, kinds: [...new Set(history.map(row => row.identifier.slice(0, row.identifier.indexOf(':'))))], events: [...new Set(history.map(row => row.event).filter((event): event is string => !!event))],
    first: times.length ? Math.min(...times) : undefined, last: times.length ? Math.max(...times) : undefined, sightings: history.length,
    members: Math.max(1, profile.cluster?.members.length ?? 1), separated: profile.separated?.length ?? 0,
  }
}

/** What joining a pair would make of their groups, worked out and not done. The pair can be decided without it, so a failure says nothing. */
async function effectOf(token: string, pair: {a: string, b: string}) {
  try {
    const response = await fetch(new URL('/review/api/foresee', runtime().graphUrl), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'join', a: pair.a, b: pair.b }), redirect: 'error', signal: AbortSignal.timeout(8000) })
    if (!response.ok) return undefined
    const { moved, after } = await response.json() as { moved: number, after: { size: number }[] }
    if (moved === 0) return 'Joining changes no groups.'
    const sizes = after.map(({ size }) => size.toLocaleString('en-US'))
    return 'After joining: ' + (after.length === 1 ? '1 person (' + (after[0]!.size === 1 ? '1 ID' : sizes[0] + ' IDs') + ')' : after.length.toLocaleString('en-US') + ' people (' + (sizes.length > 6 ? sizes.slice(0, 6).join(', ') + ' and ' + (sizes.length - 6).toLocaleString('en-US') + ' more' : sizes.join(', ')) + ' IDs)')
  } catch {
    return undefined
  }
}
