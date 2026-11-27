import { reviewGet, withGraph } from './auth.server'
import { daysBefore } from './cards.server.js'
import { graphTime } from './runtime.server'
import { csvCell as cell } from './csv'

type Row = Record<string, any>
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** A day that the calendar has. A month has no day 31 it lacks, whatever the pattern allows. */
const isDay = (text: string) => DAY.test(text) && new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text

/**
 * What a Channels address asks for. With no days given the graph chooses them.
 * With days given, both are needed, each a day of the calendar and in order, because a report of other days than those asked would mislead.
 */
function asked(request: Request) {
  const query = new URL(request.url).searchParams
  const text = (name: string) => (query.get(name) ?? '').trim().slice(0, 200)
  const [from, to] = [text('from'), text('to')]
  if ((from || to) && !(isDay(from) && isDay(to) && from <= to)) throw new Response('Choose a first and a last day, the first no later than the last.', { status: 400 })
  const days = Number(text('days'))
  return {
    window: (from ? { from, to } : {}) as Record<string, string>,
    by: text('by'), per: text('per'), rank: text('rank'), step: text('step'), days: Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30,
  }
}

/** What each campaign cost and brought in, with the days before for comparison, and what followed calls where a step is chosen. */
export function loadChannels(request: Request) {
  return withGraph(request, async session => {
    const get = (path: string, query: Record<string, string>) => reviewGet(request, session, path, query) as Promise<Row>
    const { window, by, per, rank, step, days } = asked(request)
    const report = await get('report', { ...window, ...(by && { by }), ...(per && { per }) })
    const before = daysBefore(report as { from: string, to: string })
    const then = await get('report', { from: before.from, to: before.to, ...(per && { per }) })
    const followed = step ? await get('followed', { from: report.from, to: report.to, step, days: String(days) }) : undefined
    // The presets count back from today in the report's zone.
    const day = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: report.timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(graphTime()).map(({ type, value }) => [type, value]))
    return { view: 'channels' as const, report, before, then: { total: then.total as Row, rows: then.rows.length as number, currencies: then.currencies as string[] }, by, per, rank, step, days, followed, today: day.year + '-' + day.month + '-' + day.day }
  })
}

/** The campaigns of a Channels address as a CSV file: a line for each campaign, the lines of a breakdown under it, then the total. */
export function channelsCsv(request: Request) {
  return withGraph(request, async session => {
    const { window, by, per } = asked(request)
    const report = await reviewGet(request, session, 'report', { ...window, ...(by && { by }), ...(per && { per }) }) as Row
    const stages: string[] = report.steps.filter((step: string) => report.total.stages[step])
    // A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is given as one.
    const unknown = (row: Row) => row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0)
    const reached = (row: Row) => [...stages.map(stage => row.stages[stage]?.count ?? 0), row.people, row.missed, row.value]
    const named = (row: Row) => row === report.total ? ['Total', '', ''] : [row.source === '(none)' ? 'Unattributed' : row.source, row.campaign ?? '', row.campaignId ?? '']
    const split = by ? [''] : []
    // A campaign is charged whole, so the lines of its breakdown have no spend, clicks or visits of their own.
    const lines = (row: Row) => [
      [...named(row), ...split, unknown(row) ? '' : row.cost, unknown(row) ? '' : row.clicks, row.visits, ...reached(row), row.costPerOutcome ?? '', row.returnOnCost ?? '', row.missingDays ?? ''],
      ...(row.breakdown ?? []).map((part: Row) => [...named(row), part.name === '(not set)' ? 'Not set' : part.name, '', '', '', ...reached(part), '', '', '']),
    ]
    const head = ['Source', 'Campaign', 'Campaign ID', ...(by ? ['Breakdown'] : []), 'Spend', 'Clicks', 'Visits', ...stages, 'People', 'Missed calls', 'Value', per ? 'Cost per ' + per : 'Cost per outcome', 'ROAS', 'Days without cost data']
    const file = [head, ...report.rows.flatMap(lines), ...lines(report.total)]
    return new Response(file.map(each => each.map(cell).join(',')).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="channels-${report.from}-${report.to}.csv"`, 'cache-control': 'no-store' } })
  })
}
