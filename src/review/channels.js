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
  const unknown = () => el('span', { class: 'muted' }, '(not recorded)')
  const withheld = (row) => el('span', { class: 'muted', title: row === report.total ? 'No campaign has cost data on enough days to say.' : `Cost data for ${row.costDays} of ${report.days} days is too little to say.` }, 'withheld')
  const per = (row) => (row.costPerOutcome !== null ? money(row.costPerOutcome) : row.thin ? withheld(row) : '')
  const back = (row) => (row.returnOnCost !== null ? `${row.returnOnCost.toFixed(1)}×` : row.thin ? withheld(row) : '')
  // A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is shown as one.
  const spent = (row) => (row.costDays === 0 && row.cost === 0 && row.clicks === 0 ? [td('num', row.source === '(none)' ? '' : unknown(), row.thin ? el('span', { class: 'reason' }, `${row.missingDays} of ${report.days} days missing`) : ''), td('num', row.source === '(none)' ? '' : unknown())]
    : [td('num', money(row.cost), row.missingDays > 0 ? el('span', { class: 'reason' }, `${row.missingDays} of ${report.days} days missing`) : ''), td('num', amount(row.clicks))])
  // How many people, where that is not how many outcomes: a renewal is a second outcome and not a second person.
  const counted = (step) => (step ? [amount(step.count), step.people === step.count ? '' : el('span', { class: 'reason' }, `${amount(step.people)} ${step.people === 1 ? 'person' : 'people'}`)] : [''])
  const cells = (row) => [...spent(row), td('num', amount(row.visits)),
    ...stages.map((stage) => td('num', ...counted(row.stages[stage]))), td('num', row.people || ''),
    ...(report.total.missed > 0 ? [td('num', row.missed || '')] : []), td('num', money(row.value)), td('num', per(row)), td('num', back(row))]
  // A campaign is charged whole, so its cost, clicks and arrivals stay on its own line and are not split.
  const split = (row) => (row.breakdown ?? []).filter((part) => part.outcomes + part.missed > 0 || part.name === '(not recorded)').map((part) => el('tr', { class: 'part' }, td(''), td('who', part.name), td(''), td(''), td(''),
    ...stages.map((stage) => td('num', ...counted(part.stages[stage]))), td('num', part.people || ''), ...(report.total.missed > 0 ? [td('num', part.missed || '')] : []), td('num', money(part.value)), td(''), td('')))
  const table = el('table', {}, el('tr', {}, th('Source'), th('Campaign'), th('Cost', 'num'), th('Clicks billed', 'num'), th('Arrivals seen', 'num'),
    ...stages.map((stage) => th(stage, 'num')), th('People', 'num'), ...(report.total.missed > 0 ? [th('Missed calls', 'num')] : []), th('Value', 'num'), th('Cost per outcome', 'num'), th('Return', 'num')))
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
  if (report.rows.length > 0) section.append(el('p', { class: 'muted' }, `Cost per outcome and return set a campaign's cost against its own outcomes, on the days its cost is known. With fewer than half of the ${amount(report.days)} days known they are withheld.${report.leftOut > 0 ? ` The total leaves out ${amount(report.leftOut)} ${report.leftOut === 1 ? 'campaign' : 'campaigns'} for that reason.` : ''}`))
  if (report.filling) section.append(el('p', { class: 'banner' }, el('b', {}, 'Still filling. '), `95 in 100 outcomes of the slowest step come within ${amount(report.filling.days)} days of the arrival, so arrivals after ${report.filling.after} have not had their time. Their cost is here already and some of their outcomes are not.`))
  section.append(report.rows.length > 0 ? wide('Channels', table) : el('p', { class: 'muted' }, 'Nothing was recorded in these days.'))
  if (report.currencies.length > 1) section.append(el('p', { class: 'apart' }, `These sums mix currencies: ${report.currencies.join(', ')}.`))
  const timed = stages.filter((stage) => report.total.stages[stage].delay)
  if (timed.length > 0) {
    const times = el('table', {}, el('tr', {}, th('Step'), th('Outcomes with an arrival', 'num'), th('Half within', 'num'), th('95 in 100 within', 'num'), th('Inside the window', 'num')))
    for (const stage of timed) {
      const { count, median, p95, inside } = report.total.stages[stage].delay
      times.append(el('tr', {}, td('', stage), td('num', `${amount(count)} of ${amount(report.total.stages[stage].count)}`), td('num', `${median.toLocaleString()} days`), td('num', `${p95.toLocaleString()} days`), td('num', percent(inside))))
    }
    box.append(el('section', {}, el('h2', {}, 'From arrival to each step'), el('p', { class: 'muted' }, `Days from the newest arrival to the outcome, over outcomes of ${report.from} to ${report.to} that have one in the year before. An arrival outside the window is counted here and credited with nothing.`), wide('From arrival to each step', times)))
  }
})
