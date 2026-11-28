import { subjectPath } from './navigation.ts'
import { graphTime, inZone, runtime } from './runtime.server'
import { createHash, randomUUID } from 'node:crypto'
import { data, redirect } from 'react-router'
import { checkOrigin, requireReviewer, reviewCalled, reviewerZone, reviewGet, signedOut, withGraph } from './auth.server'
import { fieldsOf } from './forms.server'
import { cardModels, daysBefore } from './cards.server.js'

export type ReportKind = 'journey' | 'board' | 'calls' | 'health'
type Read = (path: string, query?: Record<string, string>) => Promise<any>
type Row = Record<string, any>
const missing = () => new Response('These details have changed. Open the report again.', { status: 404 })
const identity = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('base64url').slice(0, 24)

export function loadReport(request: Request, kind: ReportKind, which?: string, selected?: string) {
  return withGraph(request, async (session, graph) => {
    const report = await inZone(await reviewerZone(request), () => prepareReport(kind, which, new URL(request.url).searchParams, (path, query) => reviewGet(request, session, path, query), selected, graphTime()))
    // A card read by itself names nobody. A page names everyone it lists.
    if (selected !== undefined) return report
    const called = await reviewCalled(request, session, listed(report))
    // The open call says what the phone company says of its caller, which is asked for with everything else kept of that one record.
    const open = report.kind === 'calls' ? report.open?.calls[report.picked]?.subject : undefined
    if (open) Object.assign(called, { [open]: { ...called[open], ...(await reviewCalled(request, session, [open], true))[open] } })
    if (report.kind !== 'journey' || !report.which || !report.journey?.entries.some((entry: Row) => entry.kind === 'call')) return { ...report, called }
    // The records a call in this history can be named for: this one, where the firm made it, and whoever holds the number read for it.
    const records = new Set<string>(madeByGraph(report.which) ? [] : [report.which])
    const phone = called[report.which]?.phone
    if (phone) for (const id of (await graph.lookup({ kind: 'find', text: phone }, { signal: request.signal }).catch(() => ({ subjects: [] as string[] }))).subjects) if (!madeByGraph(id)) records.add(id)
    return { ...report, records: [...records], called: { ...called, ...await reviewCalled(request, session, [...records].filter(id => !(id in called))) } }
  })
}
/** An ID the graph makes for a caller, a visitor or one call. It is nobody's record. */
const madeByGraph = (subject: string) => /^(visitor|caller|call):/.test(subject)

/** Everyone a report lists, to ask what each is called. */
function listed(report: Row): string[] {
  if (report.kind === 'journey') return [report.which, ...Object.keys(report.journey?.subjects ?? {}), ...(report.events ?? []).map((event: Row) => event.entry.subject)]
  if (report.kind === 'board') return [...report.board.columns.flatMap((column: Row) => column.rows.map((row: Row) => row.subject)), ...report.texts.map(({ text }: Row) => text.subject)]
  if (report.kind === 'calls') return [...report.open.calls.map((call: Row) => call.subject), ...(report.story?.rows ?? []).map(({ entry }: Row) => entry.subject)]
  if (report.kind === 'health') return [...report.refused.map((job: Row) => job.subject), ...report.disputes.flatMap(({ a, b }: Row) => [a, b])]
  return []
}

export async function loadCard(request: Request, kind?: string, which?: string) {
  const item = new URL(request.url).searchParams.get('item')
  if (!item || !/^[a-z.]+\.[\w-]{24}$/.test(item) || (kind !== 'calls' && kind !== 'journey' && kind !== 'board' && kind !== 'health')) throw missing()
  const { cards, canonical, page } = await loadReport(request, kind, which, item)
  // The way back is to the column and the people the card was among.
  return { card: cards[item], canonical: page ? canonical + '?column=' + page.column + '&from=' + page.from + '#column-' + page.column : canonical }
}

export async function prepareReport(kind: ReportKind, which: string | undefined, query: URLSearchParams, read: Read, selected?: string, at = Date.now()) {
  const cache = new Map<string, Promise<any>>()
  const get = (path: string, query: Record<string, string> = {}) => {
    const key = path + '?' + new URLSearchParams(query)
    if (!cache.has(key)) cache.set(key, read(path, query))
    return cache.get(key)!
  }
  const models: Record<string, any> = cardModels((path: string) => {
    const [name, args] = path.slice(1).split('?')
    return get(name, Object.fromEntries(new URLSearchParams(args)))
  })
  const qs = new URLSearchParams()
  const canonical = kind === 'journey' && which ? subjectPath(which, kind) : '/' + kind + (which ? '/' + encodeURIComponent(which) : '')
  const specs: { type: string, id: string, data: Row }[] = []
  const add = (type: string, id: string, data: Row) => {
    const key = type + '.' + identity(id)
    if (selected == null || key === selected) specs.push({ type, id: key, data })
    return key
  }
  const report: Row = { kind, which, canonical, snapshot: randomUUID() }
  const me = await get('me')
  const { limits, targets: goals } = me
  if (kind === 'journey') {
    if (which) {
      const args = { subject: which }
      const before = query.get('before')
      if (before && /^\d+$/.test(before)) qs.set('before', before)
      const journey = report.journey = await get('journey', { ...args, ...Object.fromEntries(qs) })
      // The time this page was read. What is taken back from it is said at this time.
      report.at = at
      const { entries, subjects, next } = journey
      const atOf = (e: Row) => [e.subject,e.kind,e.at,e.call?.id,e.text?.id,e.outcome?.transactionId,e.decision?.seq,e.event]
      const facts = { entries, ties: subjects, subject: which, at, limits, partial: next !== null, here: true }
      const seen = new Map<string, number>()
      report.events = entries.map((entry: Row) => {
        const identity = JSON.stringify(atOf(entry))
        const n = seen.get(identity) ?? 0
        seen.set(identity, n + 1)
        const id = identity + '/' + n
        const call = entry.kind === 'call' ? add('call', id, { ...facts, ...entry, at }) : undefined
        const wait = entry.kind === 'call' && entry.followUp?.delay >= 0 ? add('chart.wait', id, { ...entry, pick: true }) : undefined
        return { entry, mark: entry.at > 0 ? add('chart.mark', id, { ...facts, entry }) : undefined, call, wait }
      })
      const positive = (entries as Row[]).filter(e => e.at > 0)
      const low = positive[0]?.at ?? 0
      const high = positive.at(-1)?.at ?? low
      const groups = new Map<string, any[]>()
      for (const event of report.events) {
        if (!event.mark) continue
        const bin = Math.round((event.entry.at - low) / Math.max(1, high - low) * 42)
        const k = event.entry.kind + '/' + bin
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k)!.push(event)
      }
      // A mark for calls nobody answered is drawn only where every call it stands for was one.
      const unanswered = (entry: any) => entry.kind === 'call' && (entry.state === 'missed' || entry.state === 'voicemail')
      report.groups = [...groups.values()].map(events => ({ at: events[0].entry.at, kind: events[0].entry.kind, look: events.every(e => unanswered(e.entry)) ? 'missed' : events[0].entry.kind, count: events.length, card: events.length === 1 ? events[0].mark : add('chart.number', events.map(e => e.mark).join('/'), { list: events.map(e => e.entry) }) }))
    }
  } else if (kind === 'board') {
    // One column can be read further on. The address says which and from where, and the links to a card's details keep both.
    const [column, from] = [query.get('column') ?? '', query.get('from') ?? '']
    // The foot's links step by fifty, so any other place is read as the column's beginning.
    const further = /^\d{1,3}$/.test(column) && /^[1-9]\d{0,6}$/.test(from) && Number(from) % 50 === 0
    if (further) for (const [name, value] of [['column', column], ['from', from]]) qs.set(name, value)
    const board = report.board = await get('board', { days: which || '90', ...(further && { column, from }) })
    if (further) report.page = { column: Number(column), from: Number(from) }
    const inbox = await get('texts', { from: board.from, to: board.day })
    report.texts = inbox.texts.map((text: Row) => ({ text, card: add('board.text', text.subject, { text, at: board.at }) }))
    report.moreTexts = inbox.next != null
    report.metrics = ['people', 'overdue', 'fresh', 'advanced'].map(key => add('board.' + key, '', { board }))
    report.columns = board.columns.map((column: Row) => column.rows.map((row: Row) => add('board.person', row.subject, { row, column, board, limits })))
  } else if (kind === 'calls') {
    for (const name of ['from', 'to']) if (query.has(name)) qs.set(name, query.get(name)!)
    const window = Object.fromEntries(qs)
    let [open, summary] = await Promise.all([get('calls', window), get('calls/summary', window)])
    const page = Number(query.get('page') ?? 0)
    if (!Number.isSafeInteger(page) || page < 0 || page > 100) throw new Response('Choose a page from the report.', {status: 400})
    const first = open
    report.oldest = first.calls[0]?.at
    for (let i = 0; i < page; i++) {
      if (open.next == null) throw missing()
      open = await get('calls', { ...window, after: open.next })
    }
    if (page) qs.set('page', String(page))
    const before = daysBefore(summary)
    const { total: then } = await get('calls/summary', { from: before.from, to: before.to })
    const facts = { summary, then, open: first, goals, limits }
    // The presets count back from today in the report's zone, as the original screen does.
    const day = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: summary.timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map(({ type, value }) => [type, value]))
    report.today = day.year + '-' + day.month + '-' + day.day
    Object.assign(report, { summary, then, before, open, page, metrics: ['inbound','answered','missed','returned','awaiting'].map(key => add('calls.' + key, '', facts)) })
    // One card for each row of Call results. The row for calls that are not leads is there only when there are some.
    report.results = Object.fromEntries(['Answered', 'Missed', 'Voicemail', 'Waiting', 'Unknown', 'Returned', 'Called again', ...(summary.total.notLeads > 0 ? ['Not a lead'] : [])].map(name => [name, add('calls.result', name, { name, summary, then })]))
    report.calls = open.calls.map((call: Row) => add('call', call.id, { call, state: call.state, followUp: { state: 'open', attempts: call.attempts }, credit: call, limits, at: open.at }))
    report.measure = ['calls','answered','missed','voicemail','unknown','waiting','returned'].includes(query.get('measure') || '') ? query.get('measure') : 'missed'
    const state = query.get('result')
    report.result = state === 'missed' || state === 'voicemail' ? state : 'all'
    if (report.result !== 'all') qs.set('result', report.result)
    const available = open.calls.map((call: Row, index: number) => ({ call, index })).filter(({ call }: {call: Row}) => report.result === 'all' || call.state === report.result)
    const picked = available.find(({index}: {index: number}) => report.calls[index] === query.get('pick')) ?? available[0]
    if (picked) {
      const { call, index } = picked
      report.picked = index
      if (query.has('pick')) qs.set('pick', report.calls[index])
      // The selected row and its story share a journey with the historical rows behind the call cards.
      const journey = await get('journey', {subject: call.subject})
      report.story = {
        count: journey.entries.length, more: journey.next !== null, ids: Object.keys(journey.subjects).length,
        rows: journey.entries.slice(-14).reverse().map((entry: Row) => ({
          entry, card: entry.kind === 'call' ? add('call', 'history/' + entry.call.id, { ...entry, at: open.at, entries: journey.entries, partial: journey.next !== null, limits, here: false }) : undefined,
        })),
      }
    }
  } else if (kind === 'health') {
    // A server built as a library may not say how its own jobs run.
    const running = get('ops').catch(error => error instanceof Response && error.status === 404 ? null : Promise.reject(error))
    const [policy, disputes, audit, ops] = await Promise.all([get('policy'), get('disputes'), get('audit'), running])
    const refused = ops?.outbox?.failed > 0 ? await get('conversions', { state: 'failed' }) : []
    Object.assign(report, { policy, disputes, audit, ops, refused, at: ops?.at ?? at, feeds: (ops?.feeds ?? []).map((feed: Row) => add('health.feed', feed.name, { feed, at: ops.at, limits, alerts: ops.alerts })) })
  } else throw missing()
  if (selected !== undefined && specs.length === 0) throw missing()
  const cards: Record<string, Row> = {}
  let index = 0
  // A board may have hundreds of people. Limit outstanding graph requests and share each journey within this read.
  async function fill() {
    while (index < specs.length) {
      const spec = specs[index++]
      const model = models[spec.type]
      const card = model.now(spec.data)
      if (!card) continue
      let extra, error
      try {
        extra = await model.more?.(spec.data)
      } catch (failure) {
        if (failure instanceof Response && failure.headers.has('location')) throw failure
        error = 'Some details are unavailable. Read current details to try again.'
      }
      const params = new URLSearchParams(qs)
      params.set('item', spec.id)
      cards[spec.id] = {
        type: spec.type, error, title: card.title, value: card.value, sum: extra?.sum ?? card.sum,
        rows: [...(card.rows ?? []), ...(extra?.rows ?? [])].filter(([, value]) => value != null && value !== '' && value !== false),
        say: [...(card.say ?? []), ...(extra?.say ?? [])].filter(Boolean),
        links: [...(card.links ?? []), ...(extra?.links ?? [])].filter(link => link?.href),
        href: '/details' + canonical + '?' + params,
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(6, specs.length)}, fill))
  if (selected && !cards[selected]) throw missing()
  return { ...report, cards, canonical, kind, which } as Row
}

/** Puts a rejected conversion back in line for the platform that refused it. */
export async function retryConversion(request: Request) {
  checkOrigin(request)
  const session = await requireReviewer(request)
  const form = await fieldsOf(request)
  const [transactionId, target] = [String(form.get('transactionId') ?? ''), String(form.get('target') ?? '')]
  if (form.get('intent') !== 'retry' || !transactionId || !target) return data({ error: 'Reopen Health and try again.' }, { status: 400 })
  let response
  try {
    response = await fetch(new URL('/review/api/retry', runtime().graphUrl), { method: 'POST', headers: { authorization: 'Bearer ' + session.token, 'content-type': 'application/json' }, body: JSON.stringify({ transactionId, target }), redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]) })
  } catch {
    // The graph may have queued it before the connection was lost, so the page is the only thing to trust.
    return data({ error: 'The graph did not answer. Reload Health to see whether the conversion was queued.' }, { status: 503 })
  }
  // A token the graph no longer takes ends the session, as it does on every other page.
  if (response.status === 401) throw await signedOut(request, session)
  if (!response.ok) return data({ error: 'The graph refused the retry. Reload to see the current state.' }, { status: response.status >= 500 ? 503 : 409 })
  const put = await response.json() as unknown[]
  if (form.get('_enhanced') === '1') return { saved: put.length > 0 ? 'The conversion was queued.' : 'The conversion is no longer rejected.' }
  return redirect('/health', 303)
}

/**
 * What a reviewer says of a missed call: that the caller was reached, or that the call was nobody's inquiry.
 * It is recorded with the reviewer's own token and signed with their name, so the graph decides whether they may.
 */
/** What a reviewer can say of a call: two statements, and the two that take them back. */
const SAYINGS = ['reached', 'not_lead', 'not_reached', 'lead'] as const
type Saying = typeof SAYINGS[number]
/**
 * Who a call was with, as the graph names it. `excluded` says it was not the chosen record, and `unknown` names nobody.
 * A call that names nobody is under its own ID.
 */
const PARTIES = ['self', 'representative', 'excluded', 'unknown'] as const
type Party = typeof PARTIES[number]

export async function sayOfCall(request: Request) {
  checkOrigin(request)
  return withGraph(request, async (session, graph) => {
    const form = await fieldsOf(request)
    const field = (name: string) => String(form.get(name) ?? '').trim()
    const [intent, call, key] = [field('intent'), field('call'), field('key')]
    // The time is the form's own, from when the page was read, so the same form sent twice is one statement. A page left open for a day is read again first.
    const at = Number(field('at'))
    const now = graphTime()
    if (!call || !key || key.length > 150 || !(intent === 'party' || (SAYINGS as readonly string[]).includes(intent)) || !Number.isSafeInteger(at) || at > now + 60_000 || at < now - 86_400_000) return data({ error: 'Reload the page and try again.' }, { status: 400 })
    // One page read can say this of several calls, so the call is part of the key. A call's ID may be long, and a key may not.
    const said = key + '/' + createHash('sha256').update(call).digest('hex').slice(0, 16)
    const by = session.name
    const done = (saved: string) => {
      if (field('_enhanced') === '1') return { saved }
      const url = new URL(request.url)
      // Without a script the page is read again, at the same days and filter, with the next call open.
      url.searchParams.delete('pick')
      return redirect(url.pathname.replace(/\.data$/, '') + url.search, 303)
    }
    if (intent === 'party') {
      // Which record the call was with. The record is the one chosen from the list, or the one whose ID was typed, and never a default.
      const [role, picked, typed] = [field('role'), field('subject'), field('other')]
      const wrong = (error: string) => data({ error }, { status: 400 })
      if (!(PARTIES as readonly string[]).includes(role)) return wrong('Choose who was on the call, then save again.')
      const nobody = role === 'unknown'
      if (!nobody && !picked && !typed) return wrong('Choose a record, or give its ID, then save again.')
      // A typed ID is the choice where the list was left as the page had it. A record chosen from the list and another typed are two choices.
      if (picked && typed && picked !== typed && picked !== field('was')) return wrong('Choose a record from the list or give an ID, not both.')
      const subject = nobody ? undefined : typed || picked
      // A call named for an ID nobody has would be in no history at all.
      if (subject !== undefined && (subject.length > 300 || madeByGraph(subject) || !(await reviewGet(request, session, 'subject', { subject })).known)) return wrong('No record has this ID. Check it and save again.')
      // The statement that stands is read now, and must be the one the page showed. Then the graph takes this one only if that one still stands.
      const stands = await graph.lookup({ kind: 'party', call }, { signal: request.signal }) as { key: string; role: string; subject?: string; by: string; at: number } | null
      const changed = data({ error: 'Somebody said who this call was with after this page was read. Reload the page.' }, { status: 409 })
      // The call moves to the history of the record it is named for, or to its own where it names nobody, so the reviewer is taken there, to the call's row.
      const home = role === 'self' || role === 'representative' ? subject! : 'call:' + call
      const moved = () => redirect(subjectPath(home, 'journey') + '#call-' + encodeURIComponent(encodeURIComponent(call)), 303)
      // The same form sent twice with the same choice is one statement, and the second is answered as the first was.
      if (stands?.key === said + '/party' && stands.role === role && stands.subject === subject) return moved()
      if ((stands ? [stands.by, stands.at, stands.role].join(' ') : '') !== field('seen')) return changed
      const result = (await graph.record({ entries: [{ type: 'call_update', key: said + '/party', at, call, change: subject === undefined ? { kind: 'party', role: 'unknown', by, seen: stands?.key ?? null } : { kind: 'party', role: role as Exclude<Party, 'unknown'>, subject, by, seen: stands?.key ?? null } }] }, { signal: request.signal })).results[0]!
      if (!result.ok) return result.reason === 'STALE' ? changed : data({ error: result.reason === 'FORGOTTEN' ? 'This record was deleted since the call, so the call cannot be named for it.' : 'The graph refused this (' + result.reason + ').' }, { status: 409 })
      if (result.value.stands === false) return changed
      return moved()
    }
    const of = { type: 'call', key: call } as const
    const [entry, saved] = ({
      reached: [{ type: 'call_update', key: said + '/reached', at, call, change: { kind: 'returned', reachedAt: at, by } }, 'Recorded: the caller was reached. Their missed calls no longer wait.'],
      not_lead: [{ type: 'restatement', key: said + '/not-lead', at, of, change: { kind: 'not_lead', why: field('why') === 'spam' ? 'spam' : 'other', by } }, 'Recorded: not a lead. The call is out of the counts.'],
      // Each takes the other statement back. The newest of the two stands, and this page was read after the one it shows.
      not_reached: [{ type: 'call_update', key: said + '/not-reached', at, call, change: { kind: 'not_returned', by } }, 'Recorded: the report that the caller was reached is taken back.'],
      lead: [{ type: 'restatement', key: said + '/lead', at, of, change: { kind: 'lead', by } }, 'Recorded: the call is a lead again. It is back in the counts.'],
    } as const)[intent as Saying]
    let result
    try {
      result = (await graph.record({ entries: [entry] }, { signal: request.signal })).results[0]!
    } catch (error) {
      // A graph server from before reviewers could say this refuses the whole call.
      if ((error as { code?: string }).code === 'AUTH.FORBIDDEN') return data({ error: 'This graph server does not take this from a reviewer. Update it, or record it from your own system.' }, { status: 403 })
      throw error
    }
    if (!result.ok) return data({ error: result.reason === 'UNKNOWN_REFERENCE' ? 'The graph no longer has this call. Reload the page.' : 'The graph refused this (' + result.reason + ').' }, { status: 409 })
    // The newest statement stands. One said from a page read before a newer one changes nothing, and the reviewer is told so.
    if ((result.value as { stands?: boolean }).stands === false) return data({ error: 'Something newer was said of this call after this page was read. Reload the page.' }, { status: 409 })
    return done(saved)
  })
}
