import { firstOpen, stands } from './calls.ts'
import type { CallTime, Edge, KeptCall, Subject } from '../contract/types.ts'
import type { Job } from './outbox.ts'
import type { CallLineKind, Tx } from './store.ts'
import { newest } from './said.ts'

export async function partyOf(tx: Tx, id: string): Promise<KeptCall['party']> {
  const last = newest(await tx.saidOf('party', id))
  return last && { ...last.data, at: last.at }
}

export const ownerOf = (id: string, party: NonNullable<KeptCall['party']>) => party.role === 'self' || party.role === 'representative' ? party.subject : `call:${id}`

// Removing the answer between two misses can make them one wait again. Its old alert can already be waiting for a retry.
export async function reopenWaits(tx: Tx, removed: readonly CallTime[]): Promise<void> {
  const answered = new Set(removed.filter(call => call.result?.answered || stands(call)).map(call => call.subject))
  if (!answered.size) return
  const past = await tx.callTimes([...answered])
  const gone = new Set(removed.map(call => call.id))
  const keys: string[] = []
  for (const subject of answered) {
    const own = past.filter(call => call.subject === subject)
    const before = firstOpen(own)
    const after = firstOpen(own.filter(call => !gone.has(call.id)))
    if (before && after && before.id !== after.id) keys.push(`unreturned:${subject}:${before.id}`)
  }
  if (keys.length) await tx.dropCallbacks(keys)
}

// A pending notice for the new owner can also have changed, even though it knew nothing of this call.
export async function affectedMisses(tx: Tx, call: KeptCall, owner: Subject): Promise<string[]> {
  if (owner === call.subject || (await tx.notLeads([`call:${call.id}`])).size) return []
  const before = call.direction === 'outbound' || call.result?.answered ? call.at : -Infinity
  const missed = call.direction === 'inbound' && call.result?.answered === false
  const returned = missed ? call.result?.returned ?? -Infinity : -Infinity
  return (await tx.callTimes([owner])).filter(each => each.id !== call.id && each.direction === 'inbound' && each.result?.answered === false &&
    (each.at < Math.max(before, returned) || (missed && call.at <= each.at))).map(each => each.id)
}

// Call ids contain no colons. A route subject is private evidence for a callback's credit.
export const creditSubject = (subject: Subject) => `subject:${subject}`

/** A reported party supersedes the browser tied by the old guess and any flag about somebody using that line before. */
export const withoutGuesses = (flags: string[]) => flags.filter(flag => flag !== 'code' && flag !== 'taken' && flag !== 'pool' && flag !== 'ambiguous' && flag !== 'repeat')

export function stopCallJob({ metaUserAgent, ...job }: Job, owner: Subject): Job {
  if (job.note === 'call_party') return { ...job, subject: owner }
  if (job.state === 'sent' || job.delivered || job.requestId) return { ...job, subject: owner, delivered: true, state: job.state === 'pending' && job.restated ? 'pending' : 'sent', note: 'call_party' }
  const { consent, click, confidence, ...rest } = job
  return { ...rest, keys: {}, subject: owner, state: 'skipped', note: 'call_party' }
}

export interface CallTrace {
  edge: Edge
  recorded: number
  remove: number
  next?: Edge
}

/** The phone may have been seen many times. A note or tie reserved to this call may also outlive its pruned sightings. */
export async function callTraces(tx: Tx, call: KeptCall, line: Subject, lineKind?: CallLineKind): Promise<{ changes: CallTrace[]; affected: Subject[] }> {
  if (call.direction === 'outbound') return { changes: [], affected: [] }
  const marks = [`dialed:call-${call.id}`, `dial:${call.id}`, `lease:${call.id}`, `text:call:${call.id}`]
  const hash = line.startsWith('caller:') && !call.flags.includes('toll_free') ? line.slice(7) : undefined
  const raw = hash && lineKind !== 'none' ? (lineKind ? [`${lineKind}:${hash}`] : [`phone:${hash}`, `voip:${hash}`]) : []
  const refs = [...marks, ...raw]
  const edges = await tx.edgesOn(refs)
  // A text's tap is called dial:text-<id>. Even at the same instant its own occurrence stays.
  const text = call.id.startsWith('text-') ? await tx.textOf(call.id.slice(5)) : undefined
  const changes: CallTrace[] = []
  const history = new Map<Subject, Awaited<ReturnType<Tx['history']>>>()
  const observed = new Set<string>()
  if (raw.length === 2) {
    // An older call has no stored line kind. Its dated sighting is better evidence than the bounds of a pruned edge.
    const seen = await tx.history(line)
    history.set(line, seen)
    for (const row of seen) if (row.at === call.at && row.event === 'call' && raw.includes(row.identifier)) observed.add(row.identifier)
  }
  for (const edge of edges) {
    const { subject, identifier } = edge
    const mark = marks.includes(identifier)
    if (call.at < edge.first || call.at > edge.last) continue
    if (!mark && (subject !== line || (observed.size > 0 && !observed.has(identifier)))) continue
    let seen = history.get(subject)
    if (!seen) history.set(subject, (seen = await tx.history(subject)))
    const all = seen.filter(row => row.identifier === identifier)
    const at = all.filter(row => row.at === call.at && row.event === 'call')
    const other = text?.visitor && identifier === marks[1] && (text.subject === subject || text.visitor === subject)
    const reserved = other && text.at === call.at ? 1 : 0
    const remove = mark ? Math.max(0, at.length - reserved) : Math.min(1, at.length)
    const pruned = edge.count - all.length
    // Losing the only dated row for a pruned boundary leaves only the bounds the other rows still establish.
    const otherPruned = other && all.length - remove === 0 ? 1 : 0
    // Each missing boundary accounts for one pruned sighting which cannot be this call.
    const elsewhere = !mark && pruned > 0 ? [...new Set([edge.first, edge.last])].filter(at => at !== call.at && !all.some(row => row.at === at)).length : 0
    const old = mark ? Math.max(0, pruned - otherPruned) : remove ? 0 : Math.min(1, Math.max(0, pruned - elsewhere))
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
    const recorded = [...removed].reduce((first, row) => Math.min(first, row.recorded ?? row.at), old ? Math.min(call.at, call.recorded) : call.recorded)
    changes.push({ edge, recorded, remove, ...(count && { next: { subject, identifier, first, last, count } }) })
  }
  const changed = new Set(changes.map(({ edge }) => edge.identifier))
  const holders = [...new Set(edges.filter(edge => changed.has(edge.identifier)).map(edge => edge.subject))]
  return { changes, affected: [...new Set([...holders, ...(await tx.aroundOf(holders)).keys()])] }
}
