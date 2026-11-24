// What each campaign cost and brought in.
/** A dimension in words: which side it is from matters as much as its name. */
const dimensionName = (by) => (by === 'hour' ? 'Hour it happened' : by === 'weekday' ? 'Weekday it happened' : by.startsWith('touch.') ? `Arrival: ${by.slice(6).replaceAll('_', ' ')}` : `Outcome: ${by.slice(8).replaceAll('_', ' ')}`)

view('channels', 'Channels', async (box, first, last, by = '') => {
  const { form: pick, query, resolved } = period('channels', first, last, by)
  const section = el('section', {}, el('h3', {}, 'Channels'), el('p', { class: 'muted' }, 'What each campaign cost and what it brought in. An outcome counts on the day it happened, under the arrival that earned it.'), pick)
  box.append(section)
  const report = await api('GET', `/report?${query}${by ? `&by=${encodeURIComponent(by)}` : ''}`)
  resolved(report)
  const stages = report.steps.filter((step) => report.total.stages[step])
  const per = (cost, count) => (count > 0 && cost > 0 ? money(cost / count) : '')
  const back = (value, cost) => (cost > 0 && value > 0 ? `${(value / cost).toFixed(1)}×` : '')
  const cells = (row) => [td('num', money(row.cost)), td('num', amount(row.clicks)), td('num', amount(row.visits)),
    ...stages.map((stage) => td('num', row.stages[stage]?.count ?? '')),
    ...(report.total.missed > 0 ? [td('num', row.missed || '')] : []), td('num', money(row.value)), td('num', per(row.cost, row.outcomes)), td('num', back(row.value, row.cost))]
  // A campaign is charged whole, so its cost, clicks and arrivals stay on its own line and are not split.
  const split = (row) => (row.breakdown ?? []).filter((part) => part.outcomes + part.missed > 0 || part.name === '(not recorded)').map((part) => el('tr', { class: 'part' }, td(''), td('who', part.name), td(''), td(''), td(''),
    ...stages.map((stage) => td('num', part.stages[stage]?.count ?? '')), ...(report.total.missed > 0 ? [td('num', part.missed || '')] : []), td('num', money(part.value)), td(''), td('')))
  const table = el('table', {}, el('tr', {}, th('Source'), th('Campaign'), th('Cost', 'num'), th('Clicks billed', 'num'), th('Arrivals seen', 'num'),
    ...stages.map((stage) => th(stage, 'num')), ...(report.total.missed > 0 ? [th('Missed calls', 'num')] : []), th('Value', 'num'), th('Cost per outcome', 'num'), th('Return', 'num')))
  for (const row of report.rows) {
    table.append(el('tr', {}, td('', row.source === '(none)' ? el('span', { class: 'muted' }, 'no arrival credited') : row.source),
      td('who', row.campaign || row.campaignId || el('span', { class: 'muted' }, 'no campaign named'), row.campaign && row.campaignId ? el('span', { class: 'reason' }, row.campaignId) : ''), ...cells(row)), ...split(row))
  }
  table.append(el('tr', { class: 'sum' }, td('', 'All'), td(''), ...cells(report.total)), ...split(report.total))
  const breakdown = el('select', { on: { change: () => {
    const [from, to] = [...pick.querySelectorAll('input')].map((input) => input.value)
    go(`#/channels/${from || report.from}/${to || report.to}${breakdown.value ? `/${encodeURIComponent(breakdown.value)}` : ''}`)
  } } }, el('option', { value: '' }, 'Nothing'),
    ...[...new Set([...report.dimensions, ...(by ? [by] : [])])].map((each) => el('option', { value: each, ...(each === by && { selected: '' }) }, dimensionName(each))))
  pick.append(el('label', {}, 'Break down by', breakdown))
  section.append(el('p', { class: 'muted' }, `${report.from} to ${report.to}, days in ${report.timeZone}.${report.currencies.length === 1 ? ` Money in ${report.currencies[0]}.` : ''}${by.startsWith('touch.') ? ' Broken down by what the credited arrival said.' : by.startsWith('outcome.') ? ' Broken down by what is known of each outcome.' : ''}${by ? ' Costs, clicks and arrivals belong to the campaign and are not split.' : ''}`))
  section.append(report.rows.length > 0 ? wide('Channels', table) : el('p', { class: 'muted' }, 'Nothing was recorded in these days.'))
  if (report.currencies.length > 1) section.append(el('p', { class: 'apart' }, `These sums mix currencies: ${report.currencies.join(', ')}.`))
})
