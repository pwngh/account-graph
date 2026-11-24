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
  const section = el('section', {}, reviewDisplay.section('What followed a call', form))
  box.append(section)
  const caveat = 'These are observed differences, not effects: people choose whether to call and how long to talk, and someone chooses whom to call back.'
  if (!step) {
    section.append(notes(caveat))
    return
  }
  const answer = await api('GET', `/followed?from=${report.from}&to=${report.to}&step=${encodeURIComponent(step)}&days=${days}`)
  const panels = el('div', { class: 'panel-grid' })
  section.append(el('p', { class: 'meta' }, `People whose call was in these days, and how many reached "${answer.step}" within ${amount(answer.days)} days`), reviewDisplay.range(answer), panels)
  for (const group of answer.groups) {
    const rows = group.rows.map((row) => el('tr', {}, td('', row.name), td('num', amount(row.people)), td('num', amount(row.reached)),
      td('num share', reviewDisplay.compare(percent(row.share), row.share))))
    panels.append(el('section', {}, el('h3', {}, GROUPS[group.by]),
      rows.length > 0 ? wide(GROUPS[group.by], el('table', {}, el('tr', {}, th('Group'), th('People', 'num'), th('Reached it', 'num'), th('Share', 'num')), ...rows))
        : group.thin === 0 ? el('p', { class: 'muted' }, 'No eligible callers.') : '',
      group.thin > 0 ? el('p', { class: 'meta' }, `${amount(group.thin)} ${group.thin === 1 ? 'person withheld' : 'people withheld'} in groups of fewer than ${amount(answer.least)}.`) : '',
      group.by === 'returned' ? notes('For callbacks, the clock starts one day after the missed call. People who already reached the step or got through on their own by then are excluded.') : ''))
  }
  const { first, returned } = answer.leftOut
  section.append(notes(caveat,
    `Excluded from the first three tables: ${amount(first.already)} reached the step before the call ended; ${amount(first.running)} still within the time window.`,
    `Excluded from the callback table: ${amount(returned.already)} reached the step by the one-day mark; ${amount(returned.running)} still within the time window; ${amount(returned.through)} got through on their own before the mark.`))
}

view('channels', 'Channels', async (box, first, last, by = '', step = '', within = '30', per = '') => {
  const { form: pick, query, resolved } = period('channels', first, last, ...(by || step || per ? [by, step, within, per] : []))
  const section = el('section', {}, reviewDisplay.heading('Channels', pick))
  box.append(section)
  const report = await api('GET', `/report?${query}${by ? `&by=${encodeURIComponent(by)}` : ''}${per ? `&per=${encodeURIComponent(per)}` : ''}`)
  resolved(report)
  const before = daysBefore(report)
  const then = (await api('GET', `/report?from=${before.from}&to=${before.to}${per ? `&per=${encodeURIComponent(per)}` : ''}`))
  // Compared only where the days before hold something of the same kind, in the same one currency.
  const alike = then.rows.length > 0 && report.currencies.length <= 1 && String(then.currencies) === String(report.currencies)
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
  const table = el('table', { class: 'campaign-report' }, el('tr', {}, group('Attribution', 2, true), group('Spend and traffic', 3), group('What followed', stages.length + 1 + (report.total.missed > 0 ? 1 : 0)), group('What it was worth', 3)),
    el('tr', {}, th('Source'), th('Campaign'), ...edge([th('Cost', 'num'), th('Clicks', 'num', 'Clicks billed'), th('Arrivals', 'num', 'Arrivals seen')]),
      ...edge([...stages.map((stage) => th(stage, 'num')), th('People', 'num'), ...(report.total.missed > 0 ? [th('Missed', 'num', 'Missed calls')] : [])]),
      ...edge([th('Value', 'num'), th(`Cost / ${per || 'outcome'}`, 'num', per ? `Cost per ${per}` : 'Cost per outcome'), th('Return', 'num')])))
  const all = report.total
  if (report.rows.length > 0) section.append(tiles(['Spent', all.costDays > 0 ? cash(all.cost) : '(not recorded)', all.missingDays > 0 && all.costDays > 0 ? `${amount(all.missingDays)} of ${amount(report.days)} days missing` : '', '', { change: alike && all.missingDays === 0 && then.total.missingDays === 0 && then.total.costDays > 0 ? changed(all.cost, then.total.cost, cash, before) : '' }], ['Worth', cash(all.value), `${amount(all.outcomes)} ${all.outcomes === 1 ? 'outcome' : 'outcomes'}`, '', { change: alike && !report.filling ? changed(all.value, then.total.value, cash, before, 'up') : '' }], ['People', amount(all.people), `${amount(all.visits)} arrivals seen`, '', { change: then.rows.length > 0 && !report.filling ? changed(all.people, then.total.people, amount, before, 'up') : '' }],
    [per ? `Cost per ${per}` : 'Cost per outcome', all.costPerOutcome !== null ? cash(all.costPerOutcome) : all.thin ? 'withheld' : '—', report.leftOut > 0 ? `leaves out ${amount(report.leftOut)} ${report.leftOut === 1 ? 'campaign' : 'campaigns'}` : ''], ['Return', all.returnOnCost !== null ? `${all.returnOnCost.toFixed(1)}×` : all.thin ? 'withheld' : '—', report.leftOut > 0 ? `leaves out ${amount(report.leftOut)} ${report.leftOut === 1 ? 'campaign' : 'campaigns'}` : ''],
    all.missed > 0 && ['Missed calls', amount(all.missed), 'by result, returned ones too', '', { change: then.rows.length > 0 ? changed(all.missed, then.total.missed, amount, before, 'down') : '' }]))
  const note = (parts) => (parts.some(Boolean) ? el('span', { class: 'reason' }, parts.filter(Boolean).join(' · ')) : '')
  const rows = report.rows.map((row) => ({ row, lines: [] }))
  for (const { row, lines } of rows) {
    lines.push(el('tr', {}, td('', row.source === '(none)' ? el('span', { class: 'muted' }, 'no arrival credited') : sourced(row.source)),
      td('who', row.campaign || row.campaignId || el('span', { class: 'muted' }, 'No campaign named'),
        row.campaign && row.campaignId ? el('span', { class: 'reason' }, row.campaignId) : '',
        note([row.missingDays > 0 && (row.costDays > 0 || row.thin) && `${amount(row.missingDays)} of ${amount(report.days)} days missing`])), ...cells(row)), ...split(row))
    table.append(...lines)
  }
  table.append(el('tr', { class: 'sum' }, td('', 'All'), td('who', note([report.leftOut > 0 && `cost and return leave out ${amount(report.leftOut)} ${report.leftOut === 1 ? 'campaign' : 'campaigns'}`])), ...cells(report.total)), ...split(report.total))
  const breakdown = el('select', { on: { change: () => go(address({ by: breakdown.value })) } }, el('option', { value: '' }, 'Nothing'),
    ...[...new Set([...report.dimensions, ...(by ? [by] : [])])].map((each) => el('option', { value: each, ...(each === by && { selected: '' }) }, dimensionName(each))))
  const choose = el('select', { on: { change: () => go(address({ per: choose.value })) } }, el('option', { value: '' }, 'every outcome'),
    ...[...new Set([...report.steps, ...(per ? [per] : [])])].map((stage) => el('option', { value: stage, ...(stage === per && { selected: '' }) }, stage)))
  const choices = [el('label', {}, 'Break down by', breakdown), el('label', {}, 'Cost per', choose)]
  const range = reviewDisplay.range(report)
  if (report.currencies.length === 1) range.append(` · Currency: ${report.currencies[0]}`)
  section.append(el('div', { class: 'report-meta' },
    el('div', {}, range, notes(
      `Outcomes count on the day they happen, under the credited arrival. Cost per outcome and return compare each campaign's costs with its outcomes on days with cost data. Both are withheld if data covers fewer than half of the ${amount(report.days)} days.`,
      per ? `Cost per outcome counts only "${per}". Return still uses all value.` : '',
      by.startsWith('touch.') ? 'Breakdown uses the credited arrival.' : by.startsWith('outcome.') ? 'Breakdown uses the recorded outcome.' : '',
      by ? 'Costs, clicks and arrivals stay on the campaign row.' : '',
      'Clicks are billed clicks; arrivals are arrivals seen. 0 means known to be none. A dash means no applicable cost or credited value.')),
    report.filling ? el('p', { class: 'banner' }, el('b', {}, 'Outcomes still coming in. '),
      `At the slowest step, 95 in 100 outcomes arrive within ${amount(report.filling.days)} days of the arrival. Costs for arrivals after ${reviewDisplay.day(report.filling.after)} are included, but some outcomes are not.`) : ''))
  const campaigns = el('section', {}, report.rows.length > 0
    ? reviewDisplay.section('Campaigns', el('span', { class: 'meta campaign-pan' }, 'Scroll for more columns'), el('div', { class: 'row' }, ...choices, saved(`channels-${report.from}-${report.to}`, table)))
    : reviewDisplay.section('Campaigns', el('div', { class: 'row' }, ...choices)),
  report.currencies.length > 1 ? el('p', { class: 'apart' }, `Totals mix currencies: ${report.currencies.join(', ')}.`) : '',
  ...(report.rows.length > 3 ? [filters('Campaigns', table, [{ name: 'Source', at: 0 }])] : []), report.rows.length > 0 ? wide('Channels', table) : el('p', { class: 'muted' }, 'No campaign data in this period.'))
  // The same numbers ranked, to see at a glance who brings what.
  const brought = report.rows.filter((row) => row.source !== '(none)')
  if (brought.length > 1) box.append(el('section', {}, el('h2', {}, 'Campaigns compared'), ranked('Campaigns compared', brought, (row) => [sourced(row.source), el('span', { class: 'ranked-what' }, row.campaign || row.campaignId || 'No campaign named')], [
    ...(report.currencies.length <= 1 ? [['Value', (row) => row.value, cash], ['Cost', (row) => (row.costDays === 0 && row.cost === 0 && row.clicks === 0 ? null : row.cost), cash]] : []),
    ['People', (row) => row.people, amount, false], ['Arrivals', (row) => row.visits, amount], ...stages.map((stage) => [stage, (row) => row.stages[stage]?.count ?? 0, amount]),
  ])))
  box.append(campaigns)
  const reachedBy = (name) => (row) => row.stages[name]?.count ?? 0
  if (rows.length > 1) sortable('Campaigns', table, [(row) => row.source, (row) => row.campaign || row.campaignId || null, (row) => (row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0) ? null : row.cost), (row) => (row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0) ? null : row.clicks), (row) => row.visits,
    ...stages.map(reachedBy), (row) => row.people, ...(report.total.missed > 0 ? [(row) => row.missed] : []), (row) => row.value, (row) => row.costPerOutcome, (row) => row.returnOnCost], rows)
  const timed = stages.filter((stage) => report.total.stages[stage].delay)
  if (timed.length > 0) {
    const times = el('table', {}, el('tr', {}, th('Step'), th('Outcomes with an arrival', 'num'), th('Half within', 'num'), th('95 in 100 within', 'num'), th('Inside the window', 'num')))
    for (const stage of timed) {
      const { count, median, p95, inside } = report.total.stages[stage].delay
      times.append(el('tr', {}, td('', stage), td('num', `${amount(count)} of ${amount(report.total.stages[stage].count)}`), td('num', `${amount(median)} days`), td('num', `${amount(p95)} days`),
        td('num share', reviewDisplay.compare(percent(inside), inside))))
    }
    box.append(el('section', {}, el('h2', {}, 'From arrival to each step'), wide('From arrival to each step', times), notes(`Days from the newest arrival to the outcome, over outcomes of ${report.from} to ${report.to} that have one in the year before. An arrival outside the window is counted here and credited with nothing.`)))
  }
  // What outcomes were first worth and are worth now. A step value is a guess until the real amount is known.
  const valued = (change) => [td('num', amount(change.outcomes)), td('num', change.outcomes === change.firstUnknown ? unknown() : money(change.first), change.firstUnknown > 0 && change.firstUnknown < change.outcomes ? el('span', { class: 'reason' }, `of ${amount(change.outcomes - change.firstUnknown)}`) : ''), td('num', money(change.now)), td('num', tally(change.zeroed)), td('num', tally(change.firstUnknown))]
  const heads = () => [th('Outcomes', 'num'), th('First recorded', 'num'), th('Now', 'num'), th('Restated to zero', 'num'), th('First value not recorded', 'num')]
  if (report.total.worth.outcomes > 0) {
    const named = (row) => (row.source === '(none)' ? 'no arrival credited' : `${row.source}${row.campaign || row.campaignId ? `, ${row.campaign || row.campaignId}` : ''}`)
    const byCampaign = el('table', {}, el('tr', {}, th('Campaign'), ...heads()), ...report.rows.filter((row) => row.worth.outcomes > 0).map((row) => el('tr', {}, td('who', named(row)), ...valued(row.worth))), el('tr', { class: 'sum' }, td('', 'All'), ...valued(report.total.worth)))
    const byMonth = el('table', {}, el('tr', {}, th('Month first recorded'), ...heads()), ...report.months.map((each) => el('tr', {}, td('', each.month), ...valued(each))))
    box.append(el('section', {}, el('h2', {}, 'Value: first recorded and now'), el('div', { class: 'panel-grid value-grid' },
      el('section', {}, el('h3', {}, 'By campaign'), wide('Value by campaign', byCampaign)),
      el('section', {}, el('h3', {}, 'By month first recorded'), wide('Value by month of first record', byMonth))),
    notes(`Outcomes from ${reviewDisplay.day(report.from)} to ${reviewDisplay.day(report.to)}. Now includes all outcomes; first recorded includes only known first values. A step's initial value can be restated when the amount collected is known.`)))
  }
  await whatFollowed(box, report, (chosen, days) => address({ step: chosen, within: days }), step, within)
})
