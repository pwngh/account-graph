const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for result', unknown: 'unknown result' }
const PERIODS = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']]

/** A length of time in its largest unit, for where there is little room. The title beside it has it whole. */
const brief = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 172800000 ? `${Math.round(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)
/** One person: age, recorded facts, then the step and call result when useful. */
function person(row, column, at) {
  const campaign = row.campaign || row.campaignId
  const arrival = row.source ? `${row.source}${campaign ? ` · ${campaign}` : ''}` : 'Unattributed'
  const call = row.call
  const worth = row.value ? el('b', {}, `${money(row.value)}${row.currency ? ` ${row.currency}` : ''}`) : ''
  return el('li', {},
    el('div', { class: 'top' }, reviewDisplay.subject(row.subject, `#/journey/${encodeURIComponent(row.subject)}`),
      el('span', { class: row.late ? 'board-age apart' : 'board-age muted' }, el('time', { datetime: new Date(row.at).toISOString(), title: `${when(row.at)}${row.late ? ', overdue' : ''}` }, brief(at - row.at)), row.late ? el('span', { class: 'sr-only' }, ', overdue') : '')),
    el('div', { class: 'board-meta reason' }, el('span', { title: `${arrival}${row.language ? ` · ${row.language}` : ''}` }, arrival, row.language ? ` · ${row.language}` : ''), worth),
    el('div', { class: 'board-chips' },
      column.step === null && row.step ? reviewDisplay.chip(row.step, 'muted') : '',
      reviewDisplay.chip(call ? `${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} · ${REACHED[call.state]}` : 'No calls',
        call ? reviewDisplay.callTone(call.state) : 'muted')))
}

/** A sender nobody has answered: how long ago they wrote, where they came from, and how many texts wait. */
function unanswered(text, at) {
  const campaign = text.campaign || text.campaignId
  const arrival = text.source ? `${text.source}${campaign ? ` · ${campaign}` : ''}` : 'Unattributed'
  return el('li', {},
    el('div', { class: 'top' }, reviewDisplay.subject(text.subject, `#/journey/${encodeURIComponent(text.subject)}`),
      el('span', { class: 'board-age muted' }, el('time', { datetime: new Date(text.at).toISOString(), title: when(text.at) }, brief(at - text.at)))),
    el('div', { class: 'board-meta reason' }, el('span', { title: arrival }, arrival, text.tags?.language ? ` · ${text.tags.language}` : '')),
    el('div', { class: 'board-chips' }, reviewDisplay.chip(`${amount(text.unanswered)} unanswered`, 'related')))
}

// Everybody once, at the furthest step they reached, with missed calls nobody returned first.
view('board', 'Board', async (box, days = '90') => {
  const board = await api('GET', `/board?days=${encodeURIComponent(days)}`)
  const { texts, next: further } = await api('GET', `/texts?from=${board.from}&to=${board.day}`)
  const sum = (of) => board.columns.reduce((total, column) => total + (of(column) ?? 0), 0)
  const [people, late, fresh, moved] = [sum((column) => column.people), sum((column) => column.late), sum((column) => column.fresh), sum((column) => column.done)]
  const pick = el('select', { on: { change: () => go(`#/board/${pick.value}`) } }, ...PERIODS.map(([value, text]) => el('option', { value, ...(value === board.days && { selected: '' }) }, text)))
  box.append(el('section', {}, reviewDisplay.heading('Board', el('label', {}, 'Period', pick)),
    tiles([term('People', 'board'), amount(people)], [term('Overdue', 'overdue', board.openHours ? 'Limits count open hours.' : ''), amount(late), board.columns.some((column) => column.late !== null) ? '' : 'No limits set', late > 0 ? 'apart' : ''], ['New today', amount(fresh)], [term('Advanced today', 'advanced'), amount(moved)]),
    reviewDisplay.range({ from: board.from, to: board.day, timeZone: board.timeZone }),
    board.unplaced > 0 ? el('p', { class: 'meta' }, `${amount(board.unplaced)} more at steps outside STAGES`) : '',
    board.columns.length === 1 ? el('p', {}, 'Set STAGES to add a column for each step.') : ''))
  const columns = board.columns.map((column) => {
    const name = column.step ?? 'Missed calls'
    const counts = [`${amount(column.people)} ${column.people === 1 ? 'person' : 'people'}`, column.fresh > 0 && `${amount(column.fresh)} new`,
      column.late > 0 && `${amount(column.late)} over ${lasted(column.wait)}`, column.done > 0 && `${amount(column.done)} ${column.step === null ? 'reached' : 'advanced'} today`]
    const cards = el('ol', { role: 'list' }, ...column.rows.map((row) => person(row, column, board.at)))
    const lane = el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': `${name}: people`, ...(column.rows.length === 0 && { hidden: '' }) }, cards)
    return el('section', { 'aria-label': name, ...(column.people === 0 && { class: 'idle' }) }, el('h2', {}, column.step === null ? term(name, 'missedColumn') : name),
      el('p', { class: 'counts' }, ...counts.map((count, i) => count ? el('span', i === 2 ? { class: 'apart' } : {}, count) : '')), lane,
      column.people > column.rows.length ? el('p', { class: 'muted board-foot' }, `${amount(column.rows.length)} of ${amount(column.people)}`) : '')
  })
  if (texts.length > 0) {
    // Beside the missed calls, which wait for the same people to be reached.
    const missed = board.columns.findIndex((column) => column.step === null)
    columns.splice(missed + 1, 0, el('section', { 'aria-label': 'Unanswered texts' }, el('h2', {}, term('Unanswered texts', 'textsColumn')),
      el('p', { class: 'counts' }, el('span', {}, `${amount(texts.length)}${further ? '+' : ''} ${texts.length === 1 ? 'person' : 'people'}`)),
      el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': 'Unanswered texts: people' }, el('ol', { role: 'list' }, ...texts.map((text) => unanswered(text, board.at))))))
  }
  box.append(el('div', { class: 'board wide', tabindex: 0, role: 'region', 'aria-label': 'Columns' }, ...columns))
}, { every: 60_000 })
