import { randomUUID } from 'node:crypto'
import { data } from 'react-router'
import { checkOrigin, reviewGet, withGraph } from './auth.server'
import { clusterLayout } from './views/cluster-layout'

export function loadAccounts(request: Request, subject?: string) {
  return withGraph(request, async session => {
    const get = (path: string, query?: Record<string,string>) => reviewGet(request, session, path, query)
    const audit = await get('audit')
    const query = new URL(request.url).searchParams
    const offset = Math.max(0, Number(query.get('offset')) || 0)
    const author = ['people', 'system'].includes(query.get('author') ?? '') ? query.get('author')! : ''
    const [clusters, recent, decisions] = await Promise.all([get('clusters', {offset: String(offset)}), get('recent'), get('decisions', {limit: '30', author, ...(query.get('before') && {before: query.get('before')!})})])
    const selected = subject ?? clusters[0]?.id
    const profile = selected ? await get('subject', {subject: selected}) : undefined
    return { subject, profile, layout: profile?.known ? clusterLayout(profile) : undefined, audit, clusters, recent, decisions, retraction: session.retraction, key: randomUUID(), at: Date.now(), offset, author }
  })
}

export async function changeAccounts(request: Request, subject?: string) {
  checkOrigin(request)
  return withGraph(request, async (session, graph) => {
    const form = await request.formData()
    const field = (name: string) => String(form.get(name) ?? '').trim()
    const intent = field('intent')
    const who = field('subject')
    const key = field('key'), at = Number(field('at')), seen = Number(field('seen'))
    const invalid = (error: string) => data({error}, {status: 400})
    if (!key || !at || !field('seen') || !Number.isSafeInteger(seen) || seen < 0 || (subject && who !== subject)) return invalid('Reopen the form and try again.')
    const common = { key, at, by: session.name, seen, ...(field('reason') && {reason: field('reason')}) }
    const options = { signal: request.signal }
    let answer
    if (intent === 'forget') {
      if (field('confirm') !== 'yes') return invalid('Confirm the ID to delete.')
      answer = await graph.forget({ ...common, subjects: [who], platforms: field('retract') ? 'retract' : 'report' }, options)
      if (answer.ok) return { saved: 'This ID was deleted.', sent: answer.value.sent.map(row => ({...row, target: row.platform, transactionId: row.conversion})) }
    } else if (intent === 'mute' || intent === 'restore') {
      answer = await graph.decide({ ...common, action: intent === 'mute' ? 'mute' : 'unmute', fact: { identifier: field('identifier') } }, options)
    } else {
      const actions = { join: 'merge', separate: 'split', rejoin: 'unsplit', unjoin: 'unmerge' } as const
      if (!Object.hasOwn(actions, intent) || !who || !field('other') || who === field('other')) return invalid('Choose two different IDs.')
      answer = await graph.decide({ ...common, action: actions[intent as keyof typeof actions], pairs: [{ a: who, b: field('other') }] }, options)
    }
    if (!answer.ok) return data({ error: answer.reason === 'STALE' ? 'A newer decision was made. Review the updated evidence before trying again.' : 'The graph refused this change (' + answer.reason + ').' }, {status: 409})
    if ('notAsAsked' in answer.value && (answer.value.notAsAsked.length || answer.value.stands === false)) return { saved: 'The decision was recorded. Other evidence or a later decision determines the current group.' }
    return { saved: 'Decision saved.' }
  })
}
