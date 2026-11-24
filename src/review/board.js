const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for a result', unknown: 'not known whether answered' }
const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'a year']]

/** One person: how long they have been here, and what is recorded about them on one line below. */
function person(row, column, at) {
  const told = [...(column.step === null ? [row.step ?? 'no step yet'] : []),
    row.source ? `${row.source}${row.campaign || row.campaignId ? `, ${row.campaign || row.campaignId}` : ''}` : 'no arrival credited',
    row.language ?? 'language (not recorded)',
    row.call ? `${row.call.direction === 'outbound' ? 'you rang' : 'rang'}, ${REACHED[row.call.state]}` : 'no call recorded',
    ...(row.value === null ? [] : [`${money(row.value)}${row.currency ? ` ${row.currency}` : ''}`])]
  return el('li', {}, el('div', { class: 'top' }, el('a', { class: 'link', href: `#/journey/${encodeURIComponent(row.subject)}`, title: row.subject }, row.subject.length > 24 ? `${row.subject.slice(0, 14)}…` : row.subject),
    el('span', { title: `Since ${when(row.at)}`, ...(row.late && { class: 'chip apart' }) }, `${lasted(at - row.at)}${row.late ? ', too long' : ''}`)),
  el('span', { class: 'reason' }, told.join(' · ')))
}

// Everybody once, at the furthest step they reached, with missed calls nobody returned first.
view('board', 'Board', async (box, days = '90') => {
  const board = await api('GET', `/board?days=${encodeURIComponent(days)}`)
  const sum = (of) => board.columns.reduce((total, column) => total + (of(column) ?? 0), 0)
  const [people, late, fresh, moved] = [sum((column) => column.people), sum((column) => column.late), sum((column) => column.fresh), sum((column) => column.done)]
  const pick = el('select', { on: { change: () => go(`#/board/${pick.value}`) } }, ...PERIODS.map(([value, text]) => el('option', { value, ...(value === board.days && { selected: '' }) }, text)))
  box.append(el('section', {}, el('h3', {}, 'Board'),
    el('div', { class: 'row' }, el('label', {}, 'Seen in the last', pick)),
    tiles(['People', amount(people)], ['Waiting too long', amount(late), board.columns.some((column) => column.late !== null) ? '' : 'no limit is set', late > 0 ? 'apart' : ''], ['New today', amount(fresh)], ['Moved on today', amount(moved)]),
    el('p', { class: 'muted' }, `${board.from} to ${board.day}, days in ${board.timeZone}.${board.unplaced > 0 ? ` ${amount(board.unplaced)} more reached only steps that are not in STAGES.` : ''}`),
    notes('Each person is in one column: missed calls nobody returned first, then the furthest step they ever reached.'),
    board.columns.length === 1 ? el('p', {}, 'No steps are set, so only missed calls have a column. Set STAGES to your steps, in order.') : ''))
  const columns = board.columns.map((column) => {
    const name = column.step ?? 'Missed, not returned'
    const counts = [`${amount(column.people)} ${column.people === 1 ? 'person' : 'people'}`, column.fresh > 0 && `${amount(column.fresh)} new today`,
      column.late > 0 && `${amount(column.late)} waiting over ${lasted(column.wait)}`, column.done > 0 && `${amount(column.done)} ${column.step === null ? 'returned or got through' : 'went further'} today`]
    if (column.people === 0) return el('section', { 'aria-label': name, class: 'idle' }, el('h2', {}, name), el('p', { class: 'muted' }, column.done > 0 ? `${amount(column.done)} ${column.step === null ? 'returned or got through' : 'went further'} today` : 'Nobody.'))
    return el('section', { 'aria-label': name }, el('h2', {}, name), el('p', { class: 'counts' }, ...counts.map((count, i) => (count ? el('span', i === 2 ? { class: 'apart' } : {}, count) : ''))),
      column.rows.length > 0 ? el('ol', {}, ...column.rows.map((row) => person(row, column, board.at))) : el('p', { class: 'muted' }, 'Nobody.'),
      column.people > column.rows.length ? el('p', { class: 'muted' }, `The ${amount(column.rows.length)} who have been here longest, of ${amount(column.people)}.`) : '')
  })
  const boards = el('div', { class: 'board', tabindex: 0, role: 'region', 'aria-label': 'Columns' }, ...columns)
  // A step nobody is at keeps its place and takes little of it, so the steps people are at fit on the screen.
  boards.style.gridTemplateColumns = board.columns.map((column) => (column.people === 0 ? 'minmax(72px, 112px)' : 'minmax(168px, 1fr)')).join(' ')
  box.append(boards)
}, { every: 60_000 })
