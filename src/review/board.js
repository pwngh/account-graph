const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for a result', unknown: 'not known whether answered' }
const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'a year']]

/** A length of time in its largest unit, for where there is little room. The title beside it has it whole. */
const brief = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 172800000 ? `${Math.round(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)
/** One person: age, recorded facts, then the step and call result when useful. */
function person(row, column, at) {
  const campaign = row.campaign || row.campaignId
  const arrival = row.source ? `${row.source}${campaign ? `, ${campaign}` : ''}` : 'No arrival credited'
  const call = row.call
  const worth = row.value != null ? el('b', {}, `${money(row.value)}${row.currency ? ` ${row.currency}` : ''}`) : ''
  return el('li', {},
    el('div', { class: 'top' }, reviewDisplay.subject(row.subject, `#/journey/${encodeURIComponent(row.subject)}`),
      el('span', { class: row.late ? 'board-age apart' : 'board-age muted' }, el('time', { datetime: new Date(row.at).toISOString(), title: when(row.at) }, brief(at - row.at)), row.late ? ', too long' : '')),
    el('div', { class: 'board-meta reason' }, arrival, row.language ? ` · ${row.language}` : '', worth ? ' · ' : '', worth),
    el('div', { class: 'board-chips' },
      column.step === null && row.step ? reviewDisplay.chip(row.step, 'muted') : '',
      reviewDisplay.chip(call ? `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} · ${REACHED[call.state]}` : 'No call recorded',
        call ? reviewDisplay.callTone(call.state) : 'muted')))
}

// Everybody once, at the furthest step they reached, with missed calls nobody returned first.
view('board', 'Board', async (box, days = '90') => {
  const board = await api('GET', `/board?days=${encodeURIComponent(days)}`)
  const sum = (of) => board.columns.reduce((total, column) => total + (of(column) ?? 0), 0)
  const [people, late, fresh, moved] = [sum((column) => column.people), sum((column) => column.late), sum((column) => column.fresh), sum((column) => column.done)]
  const pick = el('select', { on: { change: () => go(`#/board/${pick.value}`) } }, ...PERIODS.map(([value, text]) => el('option', { value, ...(value === board.days && { selected: '' }) }, text)))
  box.append(el('section', {}, reviewDisplay.heading('Board', el('label', {}, 'Seen in the last', pick)),
    tiles(['People', amount(people)], ['Waiting too long', amount(late), board.columns.some((column) => column.late !== null) ? '' : 'No limit set', late > 0 ? 'apart' : ''], ['New today', amount(fresh)], ['Moved on today', amount(moved)]),
    reviewDisplay.range({ from: board.from, to: board.day, timeZone: board.timeZone }),
    board.unplaced > 0 ? el('p', { class: 'meta' }, `${amount(board.unplaced)} more reached only steps outside STAGES.`) : '',
    notes('Each person is in one column: missed calls nobody returned first, then the furthest step they ever reached.',
      `A highlighted age is over that column’s waiting limit${board.openHours ? ', which is counted in the hours you are open. The age itself is by the clock' : ''}.`),
    board.columns.length === 1 ? el('p', {}, 'No steps are set, so only missed calls have a column. Set STAGES to your steps, in order.') : ''))
  const columns = board.columns.map((column) => {
    const name = column.step ?? 'Missed, not returned'
    const counts = [`${amount(column.people)} ${column.people === 1 ? 'person' : 'people'}`, column.fresh > 0 && `${amount(column.fresh)} new today`,
      column.late > 0 && `${amount(column.late)} waiting over ${lasted(column.wait)}${board.openHours ? ' open' : ''}`, column.done > 0 && `${amount(column.done)} ${column.step === null ? 'returned or got through' : 'went further'} today`]
    const cards = el('ol', { role: 'list' }, ...column.rows.map((row) => person(row, column, board.at)))
    const lane = el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': `${name}: people`, ...(column.rows.length === 0 && { hidden: '' }) }, cards)
    return el('section', { 'aria-label': name, ...(column.people === 0 && { class: 'idle' }) }, el('h2', {}, name),
      el('p', { class: 'counts' }, ...counts.map((count, i) => count ? el('span', i === 2 ? { class: 'apart' } : {}, count) : '')), lane,
      column.people > column.rows.length ? el('p', { class: 'muted board-foot' }, `Showing ${amount(column.rows.length)} of ${amount(column.people)}, longest waiting first.`) : '')
  })
  box.append(el('div', { class: 'board wide', tabindex: 0, role: 'region', 'aria-label': 'Columns' }, ...columns))
}, { every: 60_000 })
