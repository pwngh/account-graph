import type { Edge, KeptCall, Subject } from '../contract/types.ts'
import type { Job } from './outbox.ts'
import type { Tx } from './store.ts'
import { newest } from './said.ts'

export async function partyOf(tx: Tx, id: string): Promise<KeptCall['party']> {
  const last = newest(await tx.saidOf('party', id))
  return last && { ...last.data, at: last.at }
}

export const ownerOf = (id: string, party: NonNullable<KeptCall['party']>) => party.role === 'self' || party.role === 'representative' ? party.subject : `call:${id}`

/** A reported party supersedes the browser tied by the old guess and any flag about somebody using that line before. */
export const withoutGuesses = (flags: string[]) => flags.filter(flag => flag !== 'code' && flag !== 'taken' && flag !== 'pool' && flag !== 'ambiguous' && flag !== 'repeat')

export function stopCallJob(job: Job, owner: Subject): Job {
  if (job.state === 'sent' || job.delivered || job.requestId) return { ...job, subject: owner, state: 'sent', note: 'call_party' }
  const { consent, click, confidence, ...rest } = job
  return { ...rest, keys: {}, subject: owner, state: 'skipped', note: 'call_party' }
}

export interface CallTrace {
  edge: Edge
  remove: number
  next?: Edge
}

/** The phone may have been seen many times. A note or tie reserved to this call may also outlive its pruned sightings. */
export async function callTraces(tx: Tx, call: KeptCall, line: Subject): Promise<{ changes: CallTrace[]; affected: Subject[] }> {
  if (call.direction === 'outbound') return { changes: [], affected: [] }
  const marks = [`dialed:call-${call.id}`, `dial:${call.id}`, `lease:${call.id}`, `text:call:${call.id}`]
  const hash = line.startsWith('caller:') && !call.flags.includes('toll_free') ? line.slice(7) : undefined
  const refs = [...marks, ...(hash ? [`phone:${hash}`, `voip:${hash}`] : [])]
  const edges = await tx.edgesOn(refs)
  // A text's tap is called dial:text-<id>. Even at the same instant its own occurrence stays.
  const text = call.id.startsWith('text-') ? await tx.textOf(call.id.slice(5)) : undefined
  const changes: CallTrace[] = []
  const history = new Map<Subject, Awaited<ReturnType<Tx['history']>>>()
  for (const edge of edges) {
    const { subject, identifier } = edge
    const mark = marks.includes(identifier)
    if ((!mark && subject !== line) || call.at < edge.first || call.at > edge.last) continue
    let seen = history.get(subject)
    if (!seen) history.set(subject, (seen = await tx.history(subject)))
    const all = seen.filter(row => row.identifier === identifier)
    const at = all.filter(row => row.at === call.at && row.event === 'call')
    const other = text?.visitor && identifier === marks[1] && (text.subject === subject || text.visitor === subject)
    const reserved = other && text.at === call.at ? 1 : 0
    const remove = mark ? Math.max(0, at.length - reserved) : Math.min(1, at.length)
    const pruned = edge.count - all.length
    // Losing the only dated row for a pruned boundary leaves just the bounds the other rows still establish.
    const otherPruned = other && all.length - remove === 0 ? 1 : 0
    const old = mark ? Math.max(0, pruned - otherPruned) : remove ? 0 : Math.min(1, pruned)
    const count = edge.count - remove - old
    if (count === edge.count) continue
    const removed = new Set(at.slice(0, remove))
    const times = all.filter(row => !removed.has(row)).map(row => row.at)
    if (count > times.length) {
      if (edge.first !== call.at) times.push(edge.first)
      if (edge.last !== call.at) times.push(edge.last)
      if (other) times.push(text.at)
      if (!times.length) times.push(call.at)
    }
    let first = Infinity
    let last = -Infinity
    for (const at of times) {
      first = Math.min(first, at)
      last = Math.max(last, at)
    }
    changes.push({ edge, remove, ...(count && { next: { subject, identifier, first, last, count } }) })
  }
  const changed = new Set(changes.map(({ edge }) => edge.identifier))
  const holders = [...new Set(edges.filter(edge => changed.has(edge.identifier)).map(edge => edge.subject))]
  return { changes, affected: [...new Set([...holders, ...(await tx.aroundOf(holders)).keys()])] }
}
