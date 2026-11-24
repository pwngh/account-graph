const iso = (date) => date.toISOString().slice(0, 10)

// What each campaign cost and brought in.
view('channels', 'Channels', async (box, first, last) => {
  const range = { from: first || iso(new Date(Date.now() - 29 * 86400000)), to: last || iso(new Date()) }
  const from = el('input', { type: 'date', value: range.from, required: '' })
  const to = el('input', { type: 'date', value: range.to, required: '' })
  const pick = el('form', { class: 'row', on: { submit: (event) => { event.preventDefault(); location.hash = `#/channels/${from.value}/${to.value}` } } },
    el('label', {}, 'From', from), el('label', {}, 'To', to), el('button', { class: 'primary' }, 'Show'))
  const section = el('section', {}, el('h3', {}, 'Channels'), el('p', { class: 'muted' }, 'What each campaign cost and what it brought in. An outcome counts on the day it happened, under the arrival that earned it.'), pick)
  box.append(section)
  const report = await api('GET', `/report?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
  const stages = report.steps.filter((step) => report.total.stages[step])
  const per = (cost, count) => (count > 0 && cost > 0 ? money(cost / count) : '')
  const back = (value, cost) => (cost > 0 && value > 0 ? `${(value / cost).toFixed(1)}×` : '')
  const cells = (row) => [td('num', money(row.cost)), td('num', amount(row.clicks)), td('num', amount(row.visits)),
    ...stages.map((stage) => td('num', row.stages[stage]?.count ?? '')),
    td('num', money(row.value)), td('num', per(row.cost, row.outcomes)), td('num', back(row.value, row.cost))]
  const table = el('table', {}, el('tr', {}, th('Source'), th('Campaign'), th('Cost', 'num'), th('Clicks billed', 'num'), th('Arrivals seen', 'num'),
    ...stages.map((stage) => th(stage, 'num')), th('Value', 'num'), th('Cost per outcome', 'num'), th('Return', 'num')))
  for (const row of report.rows) {
    table.append(el('tr', {}, td('', row.source === '(none)' ? el('span', { class: 'muted' }, 'no arrival credited') : row.source),
      td('who', row.campaign || row.campaignId || el('span', { class: 'muted' }, 'no campaign named'), row.campaign && row.campaignId ? el('span', { class: 'reason' }, row.campaignId) : ''), ...cells(row)))
  }
  table.append(el('tr', { class: 'sum' }, td('', 'All'), td(''), ...cells(report.total)))
  section.append(el('p', { class: 'muted' }, `${report.from} to ${report.to}, days in ${report.timeZone}.${report.currencies.length === 1 ? ` Money in ${report.currencies[0]}.` : ''}`))
  section.append(report.rows.length > 0 ? wide('Channels', table) : el('p', { class: 'muted' }, 'Nothing was recorded in these days.'))
  if (report.currencies.length > 1) section.append(el('p', { class: 'apart' }, `These sums mix currencies: ${report.currencies.join(', ')}.`))
})
