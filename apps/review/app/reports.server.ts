import { subjectPath } from './navigation.ts'
import { graphTime, inZone } from './runtime.server'
import { createHash, randomUUID } from 'node:crypto'
import { reviewerZone, reviewGet, withGraph } from './auth.server'
import { cardModels, daysBefore } from './cards.server.js'

export type ReportKind = 'journey' | 'board' | 'calls'
type Read = (path: string, query?: Record<string, string>) => Promise<any>
type Row = Record<string, any>
const missing = () => new Response('These details have changed. Open the report again.', { status: 404 })
const identity = (...values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('base64url').slice(0, 24)

export function loadReport(request: Request, kind: ReportKind, which?: string, selected?: string) {
  return withGraph(request, async session => inZone(await reviewerZone(request), () => prepareReport(kind, which, new URL(request.url).searchParams, (path, query) => reviewGet(request, session, path, query), selected, graphTime())))
}

export async function loadCard(request: Request, kind?: string, which?: string) {
  const item = new URL(request.url).searchParams.get('item')
  if (!item || !/^[a-z.]+\.[\w-]{24}$/.test(item) || (kind !== 'calls' && kind !== 'journey' && kind !== 'board')) throw missing()
  const { cards, canonical } = await loadReport(request, kind, which, item)
  return { card: cards[item], canonical }
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
    const board = report.board = await get('board', { days: which || '90' })
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
