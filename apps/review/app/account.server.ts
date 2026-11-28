import { subjectPath } from './navigation'
import { graphTime } from './runtime.server'
import { randomUUID } from 'node:crypto'
import { data, redirect } from 'react-router'
import { fieldsOf } from './forms.server'
import { checkOrigin, reviewCalled, reviewGet, withGraph } from './auth.server'
import type { KnownProfile, ProfilePage } from './views/accounts'
import { clusterLayout } from './views/cluster-layout'

function pageOf(profile: KnownProfile, wanted: number): ProfilePage {
  const { links, separated, verdicts, edges, apart, cluster, dates, ...rest } = profile
  const size = links.length + separated.length
  const start = Math.min(Math.max(0, Math.ceil(size / 50) - 1), wanted) * 50
  const end = start + 50
  const page = links.slice(start, end)
  const cuts = separated.slice(Math.max(0, start - links.length), Math.max(0, end - links.length))
  const ids = new Set([profile.subject, ...page.map(link => link.subject), ...cuts])
  return {
    ...rest, links: page, separated: cuts, start,
    listedMembers: cluster.members.filter(id => ids.has(id)), memberCount: cluster.members.length,
    cluster: { oversized: cluster.oversized, limitedByCalls: cluster.limitedByCalls },
    linkCount: links.length, separatedCount: separated.length, strongest: links.reduce((best, link) => Math.max(best, link.score), 0),
    dates: Object.fromEntries([...ids].map(id => [id, dates?.[id] ?? {}])),
    verdicts: verdicts.filter(row => ids.has(row.a) && ids.has(row.b) && (row.a === profile.subject || row.b === profile.subject)),
  }
}

export function loadAccounts(request: Request, subject?: string) {
  return withGraph(request, async (session, graph) => {
    const get = (path: string, query?: Record<string,string>) => reviewGet(request, session, path, query)
    const audit = await get('audit')
    const query = new URL(request.url).searchParams
    const offset = Math.max(0, Number(query.get('offset')) || 0)
    const author = ['people', 'system'].includes(query.get('author') ?? '') ? query.get('author')! : ''
    const [clusters, recent, decisions] = await Promise.all([get('clusters', {offset: String(offset)}), get('recent'), get('decisions', {limit: '30', author, ...(query.get('before') && {before: query.get('before')!})})])
    const selected = subject ?? clusters[0]?.id
    const profile = selected ? await get('subject', {subject: selected}) : undefined
    const wanted = Math.max(0, Math.floor(Number(query.get('links')) || 0))
    const page = !subject ? undefined : profile?.known ? pageOf(profile, wanted) : profile
    const called = await reviewCalled(request, session, [subject, ...clusters.map((cluster: {id: string}) => cluster.id), ...recent.flatMap((row: {subject: string, to?: string}) => [row.subject, row.to]), ...(page?.known ? [...page.links.map((link: {subject: string}) => link.subject), ...page.separated, ...(page.flows ?? []).map((flow: {subject: string}) => flow.subject), ...(page.rings ?? []).flatMap((ring: {subjects: string[]}) => ring.subjects)] : [])])
    // The account that is open lists every number and email of its person, not only the newest.
    if (subject) {
      // The later read stands. A person forgotten between the two is not shown by what the first one said.
      const every = (await reviewCalled(request, session, [subject], true))[subject]
      if (every) called[subject] = every
      else delete called[subject]
    }
    // What the person wrote, kept as a copy to read back. A graph that cannot say leaves the section out.
    const wrote = subject ? (await graph.lookup({ kind: 'messages', subject }, { signal: request.signal }).catch(() => ({ messages: [] }))).messages : []
    return { subject, called, wrote, profile: page, layout: profile?.known ? clusterLayout(profile) : undefined, audit, clusters, recent, decisions, retraction: session.retraction, key: randomUUID(), at: graphTime(), offset, author }
  })
}

export async function changeAccounts(request: Request, subject?: string, fields?: URLSearchParams) {
  checkOrigin(request)
  return withGraph(request, async (session, graph) => {
    const form = fields ?? await fieldsOf(request)
    const field = (name: string) => String(form.get(name) ?? '').trim()
    const intent = field('intent')
    const who = field('subject')
    const key = field('key'), at = Number(field('at')), seen = Number(field('seen'))
    const invalid = (error: string) => data({error}, {status: 400})
    if (!key || !at || !field('seen') || !Number.isSafeInteger(seen) || seen < 0 || (subject && who !== subject)) return invalid('Reopen the form and try again.')
    const common = { key, at, by: session.name, seen, ...(field('reason') && {reason: field('reason')}) }
    const options = { signal: request.signal }
    const saved = (message: string) => {
      if (field('_enhanced') === '1') return { saved: message }
      const url = new URL(request.url)
      return redirect((subject ? subjectPath(subject) : url.pathname.replace(/\.data$/, '')) + url.search, 303)
    }
    let answer
    if (intent === 'forget') {
      if (field('confirm') !== 'yes') return invalid('Confirm the ID to delete.')
      answer = await graph.forget({ ...common, subjects: [who], platforms: field('retract') ? 'retract' : 'report' }, options)
      if (answer.ok && !answer.value.sent.length) return saved('This ID was deleted.')
      if (answer.ok) return { saved: 'This ID was deleted.', sent: answer.value.sent.map(row => ({...row, target: row.platform, transactionId: row.conversion})) }
    } else if (intent === 'mute' || intent === 'restore') {
      answer = await graph.decide({ ...common, action: intent === 'mute' ? 'mute' : 'unmute', fact: { identifier: field('identifier') } }, options)
    } else {
      const actions = { join: 'merge', separate: 'split', rejoin: 'unsplit', unjoin: 'unmerge' } as const
      if (!Object.hasOwn(actions, intent) || !who || !field('other') || who === field('other')) return invalid('Choose two different IDs.')
      // A join with an ID nobody has would tie this person to nothing, and show as done. The other three name a pair the page already listed.
      if (intent === 'join' && !(await reviewGet(request, session, 'subject', { subject: field('other') })).known) return invalid('No record has the ID ' + field('other') + '. Check it and try again.')
      answer = await graph.decide({ ...common, action: actions[intent as keyof typeof actions], pairs: [{ a: who, b: field('other') }] }, options)
    }
    if (!answer.ok) return data({ error: answer.reason === 'STALE' ? 'A newer decision was made. Review the updated evidence before trying again.' : 'The graph refused this change (' + answer.reason + ').' }, {status: 409})
    if ('notAsAsked' in answer.value && (answer.value.notAsAsked.length || answer.value.stands === false)) return saved('The decision was recorded. Other evidence or a later decision determines the current group.')
    return saved('Decision saved.')
  })
}
