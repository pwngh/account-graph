import { reviewGet, withGraph } from './auth.server'
import { daysBefore } from './cards.server.js'
import { graphTime } from './runtime.server'

type Row = Record<string, any>
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** What a Channels address asks for. Anything it does not say is left to the graph. */
function asked(request: Request) {
  const query = new URL(request.url).searchParams
  const text = (name: string) => (query.get(name) ?? '').trim().slice(0, 200)
  const days = Number(text('days'))
  return {
    window: (DAY.test(text('from')) && DAY.test(text('to')) ? { from: text('from'), to: text('to') } : {}) as Record<string, string>,
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

// A cell a spreadsheet would run as a formula is given as text.
const cell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value !== 'number' ? "'" + text : text
  return /[",\n\r]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe
}

/** The campaigns of a Channels address as a CSV file: one line a campaign, then the total. */
export function channelsCsv(request: Request) {
  return withGraph(request, async session => {
    const { window, per } = asked(request)
    const report = await reviewGet(request, session, 'report', { ...window, ...(per && { per }) }) as Row
    const stages: string[] = report.steps.filter((step: string) => report.total.stages[step])
    // A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is given as one.
    const unknown = (row: Row) => row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0)
    const line = (row: Row, source: string, campaign: string, id: string) => [source, campaign, id, unknown(row) ? '' : row.cost, unknown(row) ? '' : row.clicks, row.visits, ...stages.map(stage => row.stages[stage]?.count ?? 0), row.people, row.missed, row.value, row.costPerOutcome ?? '', row.returnOnCost ?? '', row.missingDays ?? '']
    const lines = [
      ['Source', 'Campaign', 'Campaign ID', 'Spend', 'Clicks', 'Visits', ...stages, 'People', 'Missed calls', 'Value', per ? 'Cost per ' + per : 'Cost per outcome', 'ROAS', 'Days without cost data'],
      ...report.rows.map((row: Row) => line(row, row.source === '(none)' ? 'Unattributed' : row.source, row.campaign ?? '', row.campaignId ?? '')),
      line(report.total, 'Total', '', ''),
    ]
    return new Response(lines.map(each => each.map(cell).join(',')).join('\r\n') + '\r\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="channels-${report.from}-${report.to}.csv"`, 'cache-control': 'no-store' } })
  })
}
