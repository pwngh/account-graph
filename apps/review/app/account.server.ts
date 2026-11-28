import { subjectPath } from './navigation'
import { graphTime, runtime } from './runtime.server'
import { randomUUID } from 'node:crypto'
import { data, redirect } from 'react-router'
import { fieldsOf } from './forms.server'
import { checkOrigin, reviewCalled, reviewGet, withGraph } from './auth.server'
import type { KnownProfile, ProfilePage } from './views/accounts'
import { clusterLayout } from './views/cluster-layout'

/** What the Links and Sightings tables are narrowed to, from the address: a value of each column the original screen filters by. */
export type Narrowed = { status?: string, kind?: string, type?: string, words?: string, event?: string, seen?: string, saw?: string }
const typeOf = (subject: string) => subject.includes(':') ? subject.slice(0, subject.indexOf(':')) : subject
const kindsOf = (reasons: { identifier: string, counted?: false }[]) => [...new Set(reasons.filter(reason => reason.counted !== false).map(reason => typeOf(reason.identifier)))]
/** Each value of a column and how many rows have it, in the order first met. */
function tally(values: string[][]) {
  const counts = new Map<string, number>()
  for (const each of values) for (const value of new Set(each)) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
}

function pageOf(profile: KnownProfile, wanted: number, narrowed: Narrowed = {}): ProfilePage {
  const { links: allLinks, separated: allSeparated, verdicts, edges, apart, cluster, dates, history: allHistory, ...rest } = profile
  // A link is in one of four groups, as the table shows it.
  const statusOf = (link: KnownProfile['links'][number]) => link.level !== 'same' ? 'Related' : cluster.members.includes(link.subject) ? 'Same person' : 'High confidence'
  const rows = [...allLinks.map(link => ({ id: link.subject, status: [statusOf(link)], kind: kindsOf(link.reasons), type: [typeOf(link.subject)] })), ...allSeparated.map(id => ({ id, status: ['Separated'], kind: [] as string[], type: [typeOf(id)] }))]
  // Words are looked for in what a row shows: its ID, its status and the kinds of what it shares.
  const has = (words: string | undefined, ...texts: string[]) => !words || texts.join(' ').toLowerCase().includes(words.toLowerCase())
  const keeps = (row: { id: string } & Record<'status' | 'kind' | 'type', string[]>) => (['status', 'kind', 'type'] as const).every(name => !narrowed[name] || row[name].includes(narrowed[name])) && has(narrowed.words, row.id, ...row.status, ...row.kind)
  const kept = new Set(rows.filter(keeps).map(row => row.id))
  const links = allLinks.filter(link => kept.has(link.subject))
  const separated = allSeparated.filter(id => kept.has(id))
  const sightings = allHistory.map(row => ({ row, event: row.event ? [row.event] : [], seen: [typeOf(row.identifier)] }))
  const history = sightings.filter(each => (!narrowed.event || each.event.includes(narrowed.event)) && (!narrowed.seen || each.seen.includes(narrowed.seen)) && has(narrowed.saw, each.row.event ?? '', each.row.identifier)).map(each => each.row)
  const filters = {
    links: { Status: tally(rows.map(row => row.status)), Identifier: tally(rows.map(row => row.kind)), Type: tally(rows.map(row => row.type)) },
    sightings: { Event: tally(sightings.map(each => each.event)), Identifier: tally(sightings.map(each => each.seen)) },
    shown: links.length + separated.length, seen: history.length, total: allHistory.length,
  }
  const size = links.length + separated.length
  const start = Math.min(Math.max(0, Math.ceil(size / 50) - 1), wanted) * 50
  const end = start + 50
  const page = links.slice(start, end)
  const cuts = separated.slice(Math.max(0, start - links.length), Math.max(0, end - links.length))
  const ids = new Set([profile.subject, ...page.map(link => link.subject), ...cuts])
  return {
    ...rest, links: page, separated: cuts, start, history, filters,
    listedMembers: cluster.members.filter(id => ids.has(id)), memberCount: cluster.members.length,
    cluster: { oversized: cluster.oversized, limitedByCalls: cluster.limitedByCalls },
    linkCount: allLinks.length, separatedCount: allSeparated.length, strongest: allLinks.reduce((best, link) => Math.max(best, link.score), 0),
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
    const narrowed = Object.fromEntries((['status', 'kind', 'type', 'words', 'event', 'seen', 'saw'] as const).flatMap(name => { const value = query.get(name); return value && value.length <= 100 ? [[name, value]] : [] })) as Narrowed
    const page = !subject ? undefined : profile?.known ? pageOf(profile, wanted, narrowed) : profile
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
    return { subject, called, wrote, link: subject ? runtime().recordLink(subject) : undefined, profile: page, layout: profile?.known ? clusterLayout(profile) : undefined, audit, clusters, recent, decisions, retraction: session.retraction, key: randomUUID(), at: graphTime(), offset, author }
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
