// What each campaign cost and brought in.
/** A dimension in words: which side it is from matters as much as its name. */
const dimensionName = (by) => (by === 'hour' ? 'Hour' : by === 'weekday' ? 'Weekday' : by.startsWith('touch.') ? `Visit: ${by.slice(6).replaceAll('_', ' ')}` : `Outcome: ${by.slice(8).replaceAll('_', ' ')}`)

const GROUPS = { answer: 'Call result', talk: 'Talk time', language: 'Language', returned: 'Callback' }

/** What followed calls: who reached a step within some days. Asked for only once a step is chosen. */
async function whatFollowed(box, report, address, step, within) {
  const days = Number(within) || 30
  const steps = [...new Set([...report.steps, ...(step ? [step] : [])])]
  // A step reached only after these days is not in the report's list, so any may be typed.
  const pick = el('input', { list: 'steps', value: step, required: '', autocomplete: 'off', placeholder: 'step', size: 14 })
  const known = el('datalist', { id: 'steps' }, ...steps.map((each) => el('option', { value: each })))
  const count = el('input', { type: 'number', min: 1, max: 365, value: days, required: '' })
  const form = el('form', { class: 'row', on: { submit: (event) => { event.preventDefault(); go(address(pick.value.trim(), count.value)) } } },
    el('label', {}, 'Step', pick), known, el('label', {}, 'Days', count), el('button', { class: 'primary' }, 'Apply'))
  const section = el('section', {}, reviewDisplay.section(term('Call outcomes', 'followed'), form))
  box.append(section)
  if (!step) return
  const answer = await api('GET', `/followed?from=${report.from}&to=${report.to}&step=${encodeURIComponent(step)}&days=${days}`)
  const panels = el('div', { class: 'panel-grid' })
  section.append(el('p', { class: 'meta' }, `${answer.step} within ${amount(answer.days)} days of the call · ${reviewDisplay.range(answer).textContent}`), panels)
  for (const group of answer.groups) {
    const rows = group.rows.map((row) => el('tr', {}, td('', row.name), td('num', amount(row.people)), td('num', amount(row.reached)),
      td('num share', reviewDisplay.compare(percent(row.share), row.share))))
    panels.append(el('section', {}, el('h3', {}, group.by === 'returned' ? term(GROUPS.returned, 'callback') : GROUPS[group.by]),
      rows.length > 0 ? wide(GROUPS[group.by], el('table', {}, el('tr', {}, th('Group'), th('People', 'num'), th('Reached', 'num'), th('Rate', 'num')), ...rows))
        : group.suppressed === 0 ? el('p', { class: 'muted' }, 'No data') : '',
      group.suppressed > 0 ? el('p', { class: 'meta' }, `${amount(group.suppressed)} in groups under ${amount(answer.least)}, hidden`) : ''))
  }
  const { first, returned } = answer.excluded
  section.append(el('p', { class: 'meta' }, `Excluded: ${amount(first.already)} already at this step, ${amount(first.running)} still within ${amount(answer.days)} days. Callback: ${amount(returned.already)} already at this step, ${amount(returned.running)} still within ${amount(answer.days)} days, ${amount(returned.through)} called again.`))
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
  const withheld = (row) => el('span', { class: 'muted', title: row === report.total ? 'Insufficient cost data' : `Cost data for ${row.costDays} of ${report.days} days` }, 'Low data')
  const each = (row) => (row.costPerOutcome !== null ? cash(row.costPerOutcome) : row.insufficientData ? withheld(row) : none())
  const back = (row) => (row.returnOnCost !== null ? `${row.returnOnCost.toFixed(1)}×` : row.insufficientData ? withheld(row) : none())
  // A campaign nobody reported a cost for may have cost nothing or anything. Only a number somebody sent is shown as one.
  const spent = (row) => {
    if (row.source === '(none)') return [td('num', none()), td('num', none())]
    return row.costDays === 0 && row.cost === 0 && row.clicks === 0 ? [td('num', unknown()), td('num', unknown())] : [td('num', cash(row.cost)), td('num', amount(row.clicks))]
  }
  // How many people, where that is not how many outcomes: a renewal is a second outcome and not a second person.
  const counted = (step) => (step ? [amount(step.count), step.people === step.count ? '' : el('span', { class: 'reason' }, `${amount(step.people)} ${step.people === 1 ? 'person' : 'people'}`)] : [tally(0)])
  const reached = (row) => edge([...stages.map((stage) => td('num', ...counted(row.stages[stage]))), td('num', tally(row.people)), ...(report.total.missed > 0 ? [td('num', tally(row.missed))] : [])])
  const cells = (row) => [...edge([...spent(row), td('num', tally(row.visits))]), ...reached(row), ...edge([td('num', cash(row.value)), td('num', each(row)), td('num', back(row))])]
  const spurned = (row) => row.notLeads > 0 && `${amount(row.notLeads)} not a lead`
  // A campaign is charged whole, so its cost, clicks and arrivals stay on its own line and are not split.
  const split = (row) => (row.breakdown ?? []).filter((part) => part.outcomes + part.missed + part.notLeads > 0 || part.name === '(not set)').map((part) => el('tr', { class: 'part' }, td(''), td('who', part.name === '(not set)' ? 'Not set' : part.name, part.notLeads > 0 ? el('span', { class: 'reason' }, spurned(part)) : ''), ...edge([td(''), td(''), td('')]), ...reached(part), ...edge([td('num', cash(part.value)), td(''), td('')])))
  const table = el('table', { class: 'campaign-report' }, el('tr', {}, group('Attribution', 2, true), group('Traffic', 3), group('Outcomes', stages.length + 1 + (report.total.missed > 0 ? 1 : 0)), group('Performance', 3)),
    el('tr', {}, th('Source'), th('Campaign'), ...edge([th('Spend', 'num'), th(term('Clicks', 'clicks'), 'num', 'Clicks'), th(term('Visits', 'visits'), 'num', 'Visits')]),
      ...edge([...stages.map((stage) => th(stage, 'num')), th('People', 'num'), ...(report.total.missed > 0 ? [th('Missed', 'num', 'Missed calls')] : [])]),
      ...edge([th('Value', 'num'), th(`Cost / ${per || 'outcome'}`, 'num', per ? `Cost per ${per}` : 'Cost per outcome'), th('ROAS', 'num')])))
  const all = report.total
  if (report.rows.length > 0) section.append(tiles([term('Spend', 'spend'), all.costDays > 0 ? cash(all.cost) : 'No data', all.missingDays > 0 && all.costDays > 0 ? `${amount(all.missingDays)} ${all.missingDays === 1 ? 'day' : 'days'} without data` : '', '', { change: alike && all.missingDays === 0 && then.total.missingDays === 0 && then.total.costDays > 0 ? changed(all.cost, then.total.cost, cash, before) : '' }], [term('Value', 'value'), cash(all.value), `${amount(all.outcomes)} ${all.outcomes === 1 ? 'outcome' : 'outcomes'}`, '', { change: alike && !report.incomplete ? changed(all.value, then.total.value, cash, before, 'up') : '' }], [term('People', 'people'), amount(all.people), `${amount(all.visits)} visits`, '', { change: then.rows.length > 0 && !report.incomplete ? changed(all.people, then.total.people, amount, before, 'up') : '' }],
    [term(per ? `Cost per ${per}` : 'Cost per outcome', 'cost'), all.costPerOutcome !== null ? cash(all.costPerOutcome) : all.insufficientData ? 'Low data' : '—', report.excluded > 0 ? `Excludes ${amount(report.excluded)} ${report.excluded === 1 ? 'campaign' : 'campaigns'}` : ''], [term('ROAS', 'roas'), all.returnOnCost !== null ? `${all.returnOnCost.toFixed(1)}×` : all.insufficientData ? 'Low data' : '—', report.excluded > 0 ? `Excludes ${amount(report.excluded)} ${report.excluded === 1 ? 'campaign' : 'campaigns'}` : ''],
    all.missed > 0 && ['Missed calls', amount(all.missed), '', '', { change: then.rows.length > 0 ? changed(all.missed, then.total.missed, amount, before, 'down') : '' }]))
  const note = (parts) => (parts.some(Boolean) ? el('span', { class: 'reason' }, parts.filter(Boolean).join(' · ')) : '')
  const rows = report.rows.map((row) => ({ row, lines: [] }))
  for (const { row, lines } of rows) {
    lines.push(el('tr', {}, td('', row.source === '(none)' ? el('span', { class: 'muted' }, 'Unattributed') : sourced(row.source)),
      td('who', row.campaign || row.campaignId || none(),
        row.campaign && row.campaignId ? el('span', { class: 'reason' }, row.campaignId) : '',
        note([row.missingDays > 0 && (row.costDays > 0 || row.insufficientData) && `${amount(row.missingDays)} ${row.missingDays === 1 ? 'day' : 'days'} without spend`, spurned(row)])), ...cells(row)), ...split(row))
    table.append(...lines)
  }
  table.append(el('tr', { class: 'sum' }, td('', 'Total'), td('who', note([report.excluded > 0 && `Excludes ${amount(report.excluded)} ${report.excluded === 1 ? 'campaign' : 'campaigns'} with low data`, spurned(report.total)])), ...cells(report.total)), ...split(report.total))
  const breakdown = el('select', { on: { change: () => go(address({ by: breakdown.value })) } }, el('option', { value: '' }, 'None'),
    ...[...new Set([...report.dimensions, ...(by ? [by] : [])])].map((each) => el('option', { value: each, ...(each === by && { selected: '' }) }, dimensionName(each))))
  const choose = el('select', { on: { change: () => go(address({ per: choose.value })) } }, el('option', { value: '' }, 'All outcomes'),
    ...[...new Set([...report.steps, ...(per ? [per] : [])])].map((stage) => el('option', { value: stage, ...(stage === per && { selected: '' }) }, stage)))
  const choices = [el('label', {}, 'Breakdown', breakdown), el('label', {}, 'Cost per', choose)]
  const range = reviewDisplay.range(report)
  if (report.currencies.length === 1) range.append(` · ${report.currencies[0]}`)
  section.append(el('div', { class: 'report-meta' },
    range,
    report.incomplete ? el('p', { class: 'banner' }, el('b', {}, 'Recent results are incomplete. '),
      `Conversions can take up to ${amount(report.incomplete.days)} days (95th percentile). Visits since ${reviewDisplay.day(report.incomplete.after)} may still convert.`) : ''))
  const campaigns = el('section', {}, report.rows.length > 0
    ? reviewDisplay.section(term('Campaigns', 'campaigns', by ? HELP.breakdown[1] : ''), el('span', { class: 'meta campaign-pan' }, 'Scroll for more'), el('div', { class: 'row' }, ...choices, saved(`channels-${report.from}-${report.to}`, table)))
    : reviewDisplay.section('Campaigns', el('div', { class: 'row' }, ...choices)),
  report.currencies.length > 1 ? el('p', { class: 'apart' }, `Multiple currencies: ${report.currencies.join(', ')}`) : '',
  ...(report.rows.length > 3 ? [filters('Campaigns', table, [{ name: 'Source', at: 0 }])] : []), report.rows.length > 0 ? wide('Channels', table) : el('p', { class: 'muted' }, 'No campaigns'))
  // The same numbers ranked, to see at a glance who brings what.
  const brought = report.rows.filter((row) => row.source !== '(none)')
  if (brought.length > 1) box.append(el('section', {}, el('h2', {}, 'Campaign comparison'), ranked('Campaign comparison', brought, (row) => [sourced(row.source), el('span', { class: 'ranked-what' }, row.campaign || row.campaignId || 'Unnamed')], [
    ...(report.currencies.length <= 1 ? [['Value', (row) => row.value, cash], ['Spend', (row) => (row.costDays === 0 && row.cost === 0 && row.clicks === 0 ? null : row.cost), cash]] : []),
    ['People', (row) => row.people, amount, false], ['Visits', (row) => row.visits, amount], ...stages.map((stage) => [stage, (row) => row.stages[stage]?.count ?? 0, amount]),
  ])))
  box.append(campaigns)
  const reachedBy = (name) => (row) => row.stages[name]?.count ?? 0
  if (rows.length > 1) sortable('Campaigns', table, [(row) => row.source, (row) => row.campaign || row.campaignId || null, (row) => (row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0) ? null : row.cost), (row) => (row.source === '(none)' || (row.costDays === 0 && row.cost === 0 && row.clicks === 0) ? null : row.clicks), (row) => row.visits,
    ...stages.map(reachedBy), (row) => row.people, ...(report.total.missed > 0 ? [(row) => row.missed] : []), (row) => row.value, (row) => row.costPerOutcome, (row) => row.returnOnCost], rows)
  // What a platform says it brought, beside what is credited here on the same days. They count by different rules, so neither is marked as wrong.
  if (all.reported) {
    const said = report.rows.filter((row) => row.reported)
    const most = Math.max(...said.flatMap((row) => [row.reported.conversions, row.reported.credited]))
    const pair = ({ conversions, credited }) => el('span', { class: 'claim' }, meter(most > 0 ? conversions / most : 0), meter(most > 0 ? credited / most : 0))
    const line = (name, claim, bars) => [td('who', ...name), td('num', amount(claim.days)), td('bar', bars), ...edge([td('num', amount(claim.conversions)), td('num', tally(claim.credited))]), ...edge([td('num', claim.value === null ? unknown() : cash(claim.value)), td('num', cash(claim.creditedValue))])]
    const claims = el('table', { class: 'claims' }, el('tr', {}, el('td', {}), el('td', {}), el('td', {}), group(per || 'Conversions', 2), group('Value', 2)),
      el('tr', {}, th('Campaign'), th('Days', 'num'), th('Reported / attributed'), ...edge([th('Reported', 'num'), th('Attributed', 'num')]), ...edge([th('Reported', 'num'), th('Attributed', 'num')])),
      ...said.map((row) => el('tr', {}, ...line([sourced(row.source), ' ', row.campaign || row.campaignId || 'Unnamed'], row.reported, pair(row.reported)))),
      ...(said.length > 1 ? [el('tr', { class: 'sum' }, ...line(['Total'], all.reported, ''))] : []))
    box.append(el('section', {}, el('h2', {}, term('Platform-reported conversions', 'reported')), wide('Platform-reported conversions', claims)))
  }
  const timed = stages.filter((stage) => report.total.stages[stage].delay)
  if (timed.length > 0) {
    const times = el('table', {}, el('tr', {}, th('Step'), th('Outcomes', 'num'), th('Median', 'num'), th('95th percentile', 'num'), th('Within window', 'num')))
    for (const stage of timed) {
      const { count, median, p95, inside } = report.total.stages[stage].delay
      times.append(el('tr', {}, td('', stage), td('num', `${amount(count)} of ${amount(report.total.stages[stage].count)}`), td('num', `${amount(median)} days`), td('num', `${amount(p95)} days`),
        td('num share', reviewDisplay.compare(percent(inside), inside))))
    }
    box.append(el('section', {}, el('h2', {}, term('Time to convert', 'delay')), wide('Time to convert', times)))
  }
  // What outcomes were first worth and are worth now. A step value is a guess until the real amount is known.
  const losses = [['refunded', 'Refunded'], ['writtenOff', 'Written off']].filter(([key]) => [report.total.valueChange, ...report.months].some((each) => each[key] !== 0))
  const valued = (change) => [td('num', amount(change.outcomes)), td('num', change.outcomes === change.firstUnknown ? unknown() : money(change.first), change.firstUnknown > 0 && change.firstUnknown < change.outcomes ? el('span', { class: 'reason' }, `of ${amount(change.outcomes - change.firstUnknown)}`) : ''), td('num', money(change.now)), ...losses.map(([key]) => td('num', change[key] === 0 ? tally(0) : money(change[key]))), td('num', tally(change.zeroed)), td('num', tally(change.firstUnknown))]
  const heads = () => [th('Outcomes', 'num'), th('Initial value', 'num'), th('Current value', 'num'), ...losses.map(([, text]) => th(text, 'num')), th('Reduced to zero', 'num'), th('No initial value', 'num')]
  if (report.total.valueChange.outcomes > 0) {
    const named = (row) => (row.source === '(none)' ? 'Unattributed' : `${row.source}${row.campaign || row.campaignId ? ` · ${row.campaign || row.campaignId}` : ''}`)
    const byCampaign = el('table', {}, el('tr', {}, th('Campaign'), ...heads()), ...report.rows.filter((row) => row.valueChange.outcomes > 0).map((row) => el('tr', {}, td('who', named(row)), ...valued(row.valueChange))), el('tr', { class: 'sum' }, td('', 'Total'), ...valued(report.total.valueChange)))
    const byMonth = el('table', {}, el('tr', {}, th('Month'), ...heads()), ...report.months.map((each) => el('tr', {}, td('', each.month), ...valued(each))))
    box.append(el('section', {}, el('h2', {}, term('Value changes', 'changes')), el('div', { class: 'panel-grid value-grid' },
      el('section', {}, el('h3', {}, 'By campaign'), wide('Value by campaign', byCampaign)),
      el('section', {}, el('h3', {}, 'By month'), wide('Value by month', byMonth)))))
  }
  await whatFollowed(box, report, (chosen, days) => address({ step: chosen, within: days }), step, within)
})
