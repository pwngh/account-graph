import { redirect } from 'react-router'
import { randomUUID } from 'node:crypto'
import { graphTime, runtime } from './runtime.server'
import { reviewCalled, reviewGet, withGraph } from './auth.server'

export function remaining(request: Request, view: string) {
  return withGraph(request, async session => {
    const base = { view }
    if (view === 'decide') {
      // The newest decisions, by anyone. The write context and the list of this reviewer's own come from this one read.
      const audit = await reviewGet(request, session, 'decisions', {limit: '200'})
      // As many as the graph gives at once, so Skip reaches every pair it lists. `older` checks every record, from the start or from a place
      // a page before gave, where the queue is otherwise of recent sightings.
      const older = new URL(request.url).searchParams.get('older') ?? ''
      const sweep: Record<string, string> = older === 'all' ? {full: 'true'} : /^[\w-]{1,500}$/.test(older) ? {cursor: older} : {}
      // A place the graph does not take, from an old bookmark or a typed address, is a check from the start.
      const found = await reviewGet(request, session, 'undecided', {limit: '500', ...sweep}).catch(error => {
        if (error instanceof Response && error.status === 400 && 'cursor' in sweep) throw redirect('/decide?older=all', 303)
        throw error
      })
      const context = {seen: audit.decisions[0]?.seq ?? 0, key: randomUUID(), at: graphTime()}
      // Pairs skipped in this visit are in the address, so Skip and Restore skipped work without scripts, and the queue leaves them out.
      const skipped = new URL(request.url).searchParams.getAll('skip').slice(0, 500)
      const passed = new Set(skipped)
      const listed = found.pairs.length
      found.pairs = found.pairs.filter((pair: {a: string, b: string}) => !passed.has(pair.a + '\n' + pair.b))
      // The pair the address names, or the strongest. A pair decided since is no longer in the queue, and the first takes its place.
      const named = new URL(request.url).searchParams.get('pair')
      const at = Math.max(0, found.pairs.findIndex((pair: {a: string, b: string}) => pair.a + '\n' + pair.b === named))
      const pair = found.pairs[at]
      // What this reviewer joined or separated since signing in, the newest first, each pair once, as the original screen lists it. A pair is
      // listed only where the newest decision on it, by anyone, is that join or separation of theirs, so Undo takes back their own.
      const seen = new Set<string>()
      const mine: {action: 'join' | 'separate', a: string, b: string, at: number}[] = []
      for (const decision of audit.decisions as {action: string, about: string[], at: number, by?: string}[]) {
        if (decision.about.length !== 2 || !['join', 'separate', 'unjoin', 'rejoin'].includes(decision.action) || decision.about.includes('[Deleted]')) continue
        const key = JSON.stringify([...decision.about].sort())
        if (seen.has(key)) continue
        seen.add(key)
        if (decision.by === session.name && decision.at >= session.since && (decision.action === 'join' || decision.action === 'separate')) mine.push({action: decision.action, a: decision.about[0]!, b: decision.about[1]!, at: decision.at})
      }
      // The pair the address names, where another reviewer decided it since it was opened: who, how and when, so the page says why it is gone.
      const [x, y] = named?.split('\n') ?? []
      const latest = named && x && y && !passed.has(named) && !found.pairs.some((each: {a: string, b: string}) => each.a + '\n' + each.b === named)
        ? (audit.decisions as {action: string, about: string[], at: number, by?: string}[]).find(decision => decision.about.length === 2 && decision.about.includes(x) && decision.about.includes(y))
        : undefined
      const gone = latest && latest.by !== session.name ? {action: latest.action, by: latest.by ?? '', at: latest.at, a: x!, b: y!} : undefined
      const session_ = {skipped, passed: listed - found.pairs.length, mine, ...(gone && {gone})}
      // A row of the queue shows the kinds of what a pair shares. The identifiers themselves go to the page for the open pair only.
      const kindsOf = (each: {reasons: {identifier: string, counted?: false}[]}) => [...new Set(each.reasons.filter(reason => reason.counted !== false).map(reason => reason.identifier.split(':')[0]))].join(', ')
      const queue = {...found, pairs: found.pairs.map((each: any) => ({a: each.a, b: each.b, score: each.score, level: each.level, kinds: kindsOf(each)}))}
      // The page draws forty pairs of each kind. Each row needs only what to call its two sides. A number and an email go to the page for the open pair only.
      const drawn = [...found.pairs.filter((each: {level: string}) => each.level === 'same').slice(0, 40), ...found.pairs.filter((each: {level: string}) => each.level !== 'same').slice(0, 40), ...(pair ? [pair] : [])]
      const known = await reviewCalled(request, session, [...drawn, ...mine, ...(gone ? [gone] : [])].flatMap((each: {a: string, b: string}) => [each.a, each.b]))
      const called = Object.fromEntries(Object.entries(known).map(([id, each]) => [id, pair && (id === pair.a || id === pair.b) ? each : each.name ? {name: each.name} : each.phone ? {phone: each.phone} : each.record ? {record: each.record} : {}]))
      const sweeping = 'full' in sweep || 'cursor' in sweep ? older : undefined
      if (!pair) return {...base, queue, context, at, called, older: sweeping, ...session_}
      const sides = await Promise.all([pair.a, pair.b].map(async subject => sideOf(subject, await reviewGet(request, session, 'subject', {subject}))))
      return {...base, queue, context, at, called, older: sweeping, ...session_, reasons: pair.reasons, sides, effect: await effectOf(session.token, pair)}
    }
    throw new Response('Unknown view', {status: 404})
  })
}

/** What the comparison of a pair shows of one of them. The page gets this and not the whole record. */
function sideOf(subject: string, profile: any) {
  const history: {at: number, identifier: string, event?: string}[] = profile.history ?? []
  let first: number | undefined, last: number | undefined
  for (const { at } of history) {
    if (!(at > 0)) continue
    if (first === undefined || at < first) first = at
    if (last === undefined || at > last) last = at
  }
  return {
    subject, kinds: [...new Set(history.map(row => row.identifier.slice(0, row.identifier.indexOf(':'))))], events: [...new Set(history.map(row => row.event).filter((event): event is string => !!event))],
    first, last, sightings: history.length,
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
