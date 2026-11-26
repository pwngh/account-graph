import { randomUUID } from 'node:crypto'
import { runtime } from './runtime.server'
import { reviewGet, withGraph } from './auth.server'

export function remaining(request: Request, view: string) {
  return withGraph(request, async session => {
    const legacy = runtime().stage ? '/legacy' : runtime().graphUrl + '/review'
    const base = { view, legacy: legacy + '#/' + view }
    if (view === 'decide') {
      const audit = await reviewGet(request, session, 'decisions', {limit: '1'})
      const queue = await reviewGet(request, session, 'undecided')
      return {...base, queue, context: {seen: audit.decisions[0]?.seq ?? 0, key: randomUUID(), at: Date.now()}}
    }
    if (view === 'channels') {
      const {rows} = await reviewGet(request, session, 'report')
      return {...base, rows: rows.map((r: Record<string,unknown>) => ({source:r.source, name:r.campaign || r.campaignId, visits:r.visits, cost:r.cost, value:r.value, outcomes:r.outcomes}))}
    }
    const ops = await reviewGet(request, session, 'ops')
    return {...base, feeds: ops.feeds}
  })
}
