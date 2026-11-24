// What each campaign cost and brought in.
/** A dimension in words: which side it is from matters as much as its name. */
const dimensionName = (by) => (by === 'hour' ? 'Hour it happened' : by === 'weekday' ? 'Weekday it happened' : by.startsWith('touch.') ? `Arrival: ${by.slice(6).replaceAll('_', ' ')}` : `Outcome: ${by.slice(8).replaceAll('_', ' ')}`)

const GROUPS = { answer: 'How the first call went', talk: 'How long they talked, of those answered', language: 'Language of the first call', returned: 'Whether a missed call was returned' }

/** What followed calls: who reached a step within some days. Asked for only once a step is chosen. */
async function whatFollowed(box, report, address, step, within) {
  const days = Number(within) || 30
  const steps = [...new Set([...report.steps, ...(step ? [step] : [])])]
  // A step reached only after these days is not in the report's list, so any may be typed.
  const pick = el('input', { list: 'steps', value: step, required: '', autocomplete: 'off', placeholder: 'a step', size: 14 })
  const known = el('datalist', { id: 'steps' }, ...steps.map((each) => el('option', { value: each })))
  const count = el('input', { type: 'number', min: 1, max: 365, value: days, required: '' })
  const form = el('form', { class: 'row', on: { submit: (event) => { event.preventDefault(); go(address(pick.value.trim(), count.value)) } } },
    el('label', {}, 'Who went on to', pick), known, el('label', {}, 'within days', count), el('button', { class: 'primary' }, 'Show'))
  const section = el('section', {}, el('h2', {}, 'What followed a call, not what it caused'), form)
  box.append(section)
  if (!step) return void section.append(el('p', { class: 'muted' }, 'Name a step to see who reached it after calling.'))
  const answer = await api('GET', `/followed?from=${report.from}&to=${report.to}&step=${encodeURIComponent(step)}&days=${days}`)
  section.append(el('p', { class: 'muted' }, `People whose call was ${answer.from} to ${answer.to}, days in ${answer.timeZone}, and how many reached "${answer.step}" within ${amount(answer.days)} days. People choose whether to call and how long to talk, and someone chooses whom to ring back, so a difference between two rows is not an effect.`))
  for (const group of answer.groups) {
    const rows = group.rows.map((row) => el('tr', {}, td('', row.name), td('num', amount(row.people)), td('num', amount(row.reached)), td('num', percent(row.share))))
    section.append(el('h2', {}, GROUPS[group.by]))
    if (group.by === 'returned') section.append(el('p', { class: 'muted' }, 'The clock starts a day after the miss for everyone. Whoever had reached the step or got through on their own by then is left out.'))
    section.append(rows.length > 0 ? wide(GROUPS[group.by], el('table', {}, el('tr', {}, th(''), th('People', 'num'), th('Reached it', 'num'), th('Share', 'num')), ...rows)) : el('p', {}, group.thin > 0 ? '' : 'Nobody to count.'),
      group.thin > 0 ? el('p', { class: 'muted' }, `${amount(group.thin)} ${group.thin === 1 ? 'person is' : 'people are'} in rows of fewer than ${amount(answer.least)}, which are not shown.`) : '')
  }
  const { first, returned } = answer.leftOut
  section.append(el('p', { class: 'muted' }, `Left out of the first three tables: ${amount(first.already)} who had reached the step before the call ended, ${amount(first.running)} still inside their days. Left out of the last: ${amount(returned.already)} who had reached the step by the landmark, ${amount(returned.running)} still inside their days, ${amount(returned.through)} who got through on their own before it.`))
}

view('channels', 'Channels', async (box, first, last, by = '', step = '', within = '30', per = '') => {
  const { form: pick, query, resolved } = period('channels', first, last, ...(by || step || per ? [by, step, within, per] : []))
  const section = el('section', {}, el('h3', {}, 'Channels'), pick)
  box.append(section)
  const report = await api('GET', `/report?${query}${by ? `&by=${encodeURIComponent(by)}` : ''}${per ? `&per=${encodeURIComponent(per)}` : ''}`)
  resolved(report)
  const address = (now) => {
    const next = { by, step, within, per, ...now }
    const [from, to] = [...pick.querySelectorAll('input')].map((input) => input.value)
    return `#/channels/${from || report.from}/${to || report.to}${next.by || next.step || next.per ? `/${[next.by, next.step, next.within, next.per].map(encodeURIComponent).join('/')}` : ''}`
  }
  // Shown as money where the report names one currency. Where it mixes them, a sign would say something false.
  let coin
  try {
    if (report.currencies.length === 1) coin = new Intl.NumberFormat(undefined, { style: 'currency', currency: report.currencies[0] })
  } catch {}
  const cash = (n) => (coin ? coin.format(n) : money(n))
  const stages = report.steps.filter((step) => report.total.stages[step])
  const unknown = unrecorded
  const withheld = (row) => el('span', { class: 'muted', title: row === report.total ? 'No campaign has cost data on enough days to say.' : `Cost data for ${row.costDays} of ${report.days} days is too little to say.` }, 'withheld')
  const each = (row) => (row.costPerOutcome !== null ? cash(row.costPerOutcome) : row.thin ? withheld(row) : none())
  const back = (row) => (row.returnOnCost !== null ? `${row.returnOnCost.toFixed(1)}×` : row.thin ? withheld(row) : none())
  // A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is shown as one.
  const spent = (row) => {
    if (row.source === '(none)') return [td('num', none()), td('num', none())]
    return row.costDays === 0 && row.cost === 0 && row.clicks === 0 ? [td('num', unknown()), td('num', unknown())] : [td('num', cash(row.cost)), td('num', amount(row.clicks))]
  }
  // How many people, where that is not how many outcomes: a renewal is a second outcome and not a second person.
  const counted = (step) => (step ? [amount(step.count), step.people === step.count ? '' : el('span', { class: 'reason' }, `${amount(step.people)} ${step.people === 1 ? 'person' : 'people'}`)] : [tally(0)])
  const reached = (row) => edge([...stages.map((stage) => td('num', ...counted(row.stages[stage]))), td('num', tally(row.people)), ...(report.total.missed > 0 ? [td('num', tally(row.missed))] : [])])
  const cells = (row) => [...edge([...spent(row), td('num', tally(row.visits))]), ...reached(row), ...edge([td('num', cash(row.value)), td('num', each(row)), td('num', back(row))])]
  // A campaign is charged whole, so its cost, clicks and arrivals stay on its own line and are not split.
  const split = (row) => (row.breakdown ?? []).filter((part) => part.outcomes + part.missed > 0 || part.name === '(not recorded)').map((part) => el('tr', { class: 'part' }, td(''), td('who', part.name), ...edge([td(''), td(''), td('')]), ...reached(part), ...edge([td('num', cash(part.value)), td(''), td('')])))
  const table = el('table', {}, el('tr', {}, el('td', { colspan: 2 }), group('Spend and traffic', 3), group('What followed', stages.length + 1 + (report.total.missed > 0 ? 1 : 0)), group('What it was worth', 3)),
    el('tr', {}, th('Source'), th('Campaign'), ...edge([th('Cost', 'num'), th('Clicks billed', 'num'), th('Arrivals seen', 'num')]),
      ...edge([...stages.map((stage) => th(stage, 'num')), th('People', 'num'), ...(report.total.missed > 0 ? [th('Missed calls', 'num')] : [])]), ...edge([th('Value', 'num'), th(per ? `Cost per ${per}` : 'Cost per outcome', 'num'), th('Return', 'num')])))
  const note = (parts) => (parts.some(Boolean) ? el('span', { class: 'reason' }, parts.filter(Boolean).join(' · ')) : '')
  for (const row of report.rows) {
    table.append(el('tr', {}, td('', row.source === '(none)' ? el('span', { class: 'muted' }, 'no arrival credited') : row.source),
      td('who', row.campaign || row.campaignId || el('span', { class: 'muted' }, 'no campaign named'), note([row.campaign && row.campaignId, row.missingDays > 0 && (row.costDays > 0 || row.thin) && `${row.missingDays} of ${report.days} days missing`])), ...cells(row)), ...split(row))
  }
  table.append(el('tr', { class: 'sum' }, td('', 'All'), td('who', note([report.leftOut > 0 && `cost and return leave out ${amount(report.leftOut)} ${report.leftOut === 1 ? 'campaign' : 'campaigns'}`])), ...cells(report.total)), ...split(report.total))
  const breakdown = el('select', { on: { change: () => go(address({ by: breakdown.value })) } }, el('option', { value: '' }, 'Nothing'),
    ...[...new Set([...report.dimensions, ...(by ? [by] : [])])].map((each) => el('option', { value: each, ...(each === by && { selected: '' }) }, dimensionName(each))))
  const choose = el('select', { on: { change: () => go(address({ per: choose.value })) } }, el('option', { value: '' }, 'every outcome'),
    ...[...new Set([...report.steps, ...(per ? [per] : [])])].map((stage) => el('option', { value: stage, ...(stage === per && { selected: '' }) }, stage)))
  pick.append(el('label', {}, 'Break down by', breakdown), el('label', {}, 'Cost per', choose))
  section.append(el('p', { class: 'muted' }, `${report.from} to ${report.to}, days in ${report.timeZone}.${report.currencies.length === 1 ? ` Money in ${report.currencies[0]}.` : ''}${by.startsWith('touch.') ? ' Broken down by what the credited arrival said.' : by.startsWith('outcome.') ? ' Broken down by what is known of each outcome.' : ''}`),
    el('details', {}, el('summary', { class: 'muted' }, 'How these are worked out'), el('p', { class: 'muted' }, `An outcome counts on the day it happened, under the arrival that earned it. What an outcome cost, and the return, set a campaign's cost against its own outcomes on the days its cost is known; with fewer than half of the ${amount(report.days)} days known they are withheld.${per ? ` Only "${per}" is counted in the cost; the return sets all value against it.` : ''}${by ? ' Costs, clicks and arrivals belong to the campaign and are not split.' : ''} 0 is known to be none. — is nothing to say: no cost, or nothing credited that is worth anything.`)))
  if (report.filling) section.append(el('p', { class: 'banner' }, el('b', {}, 'Still filling. '), `95 in 100 outcomes of the slowest step come within ${amount(report.filling.days)} days of the arrival, so arrivals after ${report.filling.after} have not had their time. Their cost is here already and some of their outcomes are not.`))
  section.append(...(report.rows.length > 0 ? [wide('Channels', table), saved(`channels-${report.from}-${report.to}`, table)] : [el('p', { class: 'muted' }, 'Nothing was recorded in these days.')]))
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
  // What outcomes were first worth and are worth now. A step value is a guess until the real amount is known.
  const valued = (change) => [td('num', amount(change.outcomes)), td('num', change.outcomes === change.firstUnknown ? unknown() : money(change.first), change.firstUnknown > 0 && change.firstUnknown < change.outcomes ? el('span', { class: 'reason' }, `of ${amount(change.outcomes - change.firstUnknown)}`) : ''), td('num', money(change.now)), td('num', change.zeroed || ''), td('num', change.firstUnknown || '')]
  const heads = () => [th('Outcomes', 'num'), th('First recorded', 'num'), th('Now', 'num'), th('Restated to zero', 'num'), th('First value not recorded', 'num')]
  if (report.total.worth.outcomes > 0) {
    const named = (row) => (row.source === '(none)' ? 'no arrival credited' : `${row.source}${row.campaign || row.campaignId ? `, ${row.campaign || row.campaignId}` : ''}`)
    const byCampaign = el('table', {}, el('tr', {}, th('Campaign'), ...heads()), ...report.rows.filter((row) => row.worth.outcomes > 0).map((row) => el('tr', {}, td('who', named(row)), ...valued(row.worth))), el('tr', { class: 'sum' }, td('', 'All'), ...valued(report.total.worth)))
    const byMonth = el('table', {}, el('tr', {}, th('Month first recorded'), ...heads()), ...report.months.map((each) => el('tr', {}, td('', each.month), ...valued(each))))
    box.append(el('section', {}, el('h2', {}, 'Value: first recorded, and now'), el('p', { class: 'muted' }, `Outcomes of ${report.from} to ${report.to}. Now is all of them. First recorded is of those whose first value is known. A value first recorded is often a step's, and is restated once what was collected is known.`), wide('Value by campaign', byCampaign), el('p', {}), wide('Value by month of first record', byMonth)))
  }
  await whatFollowed(box, report, (chosen, days) => address({ step: chosen, within: days }), step, within)
})
