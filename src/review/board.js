const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for a result', unknown: 'not known whether answered' }
const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'a year']]

/** One person: how long they have been here, and what is recorded about them on one line below. */
function person(row, column, at) {
  const arrival = row.source ? [row.source, row.campaign ? ` · ${row.campaign}` : row.campaignId ? ' · ' : '', !row.campaign && row.campaignId ? reviewDisplay.id(row.campaignId) : ''] : ['No arrival credited']
  const call = row.call
  const state = call ? REACHED[call.state] : 'no call recorded'
  return el('li', {},
    el('div', { class: 'top' }, reviewDisplay.subject(row.subject, `#/journey/${encodeURIComponent(row.subject)}`),
      el('span', { class: row.late ? 'chip apart' : 'muted' }, reviewDisplay.time(row.at, at), row.late ? ' · Over limit' : '')),
    el('span', { class: 'reason' }, ...arrival),
    el('div', { class: 'board-meta' }, column.step === null ? el('span', {}, row.step ?? 'No step yet') : '',
      el('span', {}, row.language ?? 'Language (not recorded)'),
      row.value === null ? '' : el('b', {}, `${money(row.value)}${row.currency ? ` ${row.currency}` : ''}`)),
    reviewDisplay.chip(call ? `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} · ${state}` : 'No call recorded', reviewDisplay.callTone(call?.state)))
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
    notes('Each person is in one column: missed calls nobody returned first, then the furthest step they ever reached.'),
    board.columns.length === 1 ? el('p', {}, 'No steps are set, so only missed calls have a column. Set STAGES to your steps, in order.') : ''))
  const columns = board.columns.map((column) => {
    const name = column.step ?? 'Missed, not returned'
    const counts = [`${amount(column.people)} ${column.people === 1 ? 'person' : 'people'}`, column.fresh > 0 && `${amount(column.fresh)} new today`,
      column.late > 0 && `${amount(column.late)} waiting over ${lasted(column.wait)}`, column.done > 0 && `${amount(column.done)} ${column.step === null ? 'returned or got through' : 'went further'} today`]
    const cards = el('ol', { role: 'list' }, ...column.rows.map((row) => person(row, column, board.at)))
    const lane = el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': `${name}: people`, ...(column.rows.length === 0 && { hidden: '' }) }, cards)
    return el('section', { 'aria-label': name, ...(column.people === 0 && { class: 'idle' }) }, el('h2', {}, name),
      el('p', { class: 'counts' }, ...counts.map((count, i) => count ? el('span', i === 2 ? { class: 'apart' } : {}, count) : '')), lane,
      column.people > column.rows.length ? el('p', { class: 'muted board-foot' }, `Showing ${amount(column.rows.length)} of ${amount(column.people)}, longest waiting first.`) : '')
  })
  const boards = el('div', { class: 'board wide', tabindex: 0, role: 'region', 'aria-label': 'Columns' }, ...columns)
  // Empty lanes keep their place without taking the width of a lane with cards.
  boards.style.setProperty('--board-columns', board.columns.map((column) => column.people === 0 ? 'minmax(108px, 124px)' : 'minmax(224px, 1fr)').join(' '))
  box.append(boards)
}, { every: 60_000 })
