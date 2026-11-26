const REACHED = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for result', unknown: 'unknown result' }
const PERIODS = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']]

/** A length of time in its largest unit, for where there is little room. The title beside it has it whole. */
const brief = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 172800000 ? `${Math.round(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)
/** One person: age, recorded facts, then the step and call result when useful. */
function person(row, column, board) {
  const { at } = board
  const campaign = row.campaign || row.campaignId
  const arrival = row.source ? `${row.source}${campaign ? ` · ${campaign}` : ''}` : 'Unattributed'
  const call = row.call
  const worth = row.value ? el('b', {}, `${money(row.value)}${row.currency ? ` ${row.currency}` : ''}`) : ''
  return el('li', {},
    el('div', { class: 'top' }, reviewDisplay.subject(row.subject, `#/journey/${encodeURIComponent(row.subject)}`),
      el('span', { class: row.late ? 'board-age apart' : 'board-age muted' }, el('time', { datetime: new Date(row.at).toISOString(), title: `${when(row.at)}${row.late ? ', overdue' : ''}` }, brief(at - row.at)), row.late ? el('span', { class: 'sr-only' }, ', overdue') : ''),
      detail('board.person', { id: row.subject, label: `${row.subject}, ${column.step ?? 'missed calls'}`, of: () => ({ row, column, board, limits }) })),
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
      el('span', { class: 'board-age muted' }, el('time', { datetime: new Date(text.at).toISOString(), title: when(text.at) }, brief(at - text.at))),
      detail('board.text', { id: text.subject, label: `${text.subject}, unanswered texts`, of: () => ({ text, at }) })),
    el('div', { class: 'board-meta reason' }, el('span', { title: arrival }, arrival, text.tags?.language ? ` · ${text.tags.language}` : '')),
    el('div', { class: 'board-chips' }, reviewDisplay.chip(`${amount(text.unanswered)} unanswered`, 'related')))
}

/** A column by its name. A step may be named as the column of missed calls is, and is then said to be a step. */
const columnName = (column, board) => column.step === null ? 'Missed calls' : column.step.toLowerCase() === 'missed calls' ? `${column.step}, a step` : column.step
/** The columns a count is made of, in the order of the board. There is room for eight, and the rest are counted together. */
function byColumn(board, of, words = (column) => amount(of(column)), name = (column) => columnName(column)) {
  const some = (board?.columns ?? []).filter((column) => of(column) > 0)
  const rest = some.slice(8)
  return [...some.slice(0, 8).map((column) => [name(column), words(column)]), ...(rest.length > 0 ? [[`And ${amount(rest.length)} more ${rest.length === 1 ? 'column' : 'columns'}`, amount(rest.reduce((sum, column) => sum + of(column), 0))]] : [])]
}
/** Who has been in a column longest, of those that count. Rows are oldest first. */
const longest = (board, holds) => (board?.columns ?? []).flatMap((column) => column.rows.filter(holds).slice(0, 1)).sort((x, y) => x.at - y.at)[0]
const longestRow = (board, holds, name) => {
  const row = longest(board, holds)
  return [name, row && `${reviewDisplay.idText(row.subject)} · ${lasted(board.at - row.at)}`]
}
/** Brings a column into view. */
const toColumn = (board, of) => {
  const at = (board?.columns ?? []).findIndex((each) => of(each) > 0)
  return at >= 0 && toPart(`Show ${board.columns[at].step ?? 'Missed Calls'}`, `column-${at}`)
}
const today = (board) => board?.day && `${reviewDisplay.day(board.day)} · ${board.timeZone}`
DETAILS['board.people'] = { now: ({ board } = {}) => ({ title: 'People', value: board && amount(board.columns.reduce((sum, { people }) => sum + people, 0)),
  rows: [...byColumn(board, ({ people }) => people), longestRow(board, () => true, 'Longest')],
  say: ['Each person is in one column. Missed calls nobody returned come first.'], links: [docs('Board', 'report.md#board')] }) }
DETAILS['board.overdue'] = { now: ({ board } = {}) => ({ title: 'Overdue', value: board && amount(board.columns.reduce((sum, { late }) => sum + (late ?? 0), 0)),
  rows: [...byColumn(board, ({ late }) => late ?? 0, (column) => `${amount(column.late)} of ${amount(column.people)} over ${lasted(column.wait)}`), longestRow(board, ({ late }) => late, 'Longest')],
  say: [['Overdue', ` means longer here than the limit for the column${board?.openHours ? ', counted in open hours' : ''}.`]], links: [toColumn(board, ({ late }) => late ?? 0), docs('Steps', 'report.md#steps')] }) }
DETAILS['board.fresh'] = { now: ({ board } = {}) => ({ title: 'New today', value: board && amount(board.columns.reduce((sum, { fresh }) => sum + fresh, 0)),
  rows: [...byColumn(board, ({ fresh }) => fresh), ['Today', today(board)]],
  say: [['New', ' means they reached the step they are at today, or their oldest missed call came today.']], links: [toColumn(board, ({ fresh }) => fresh), docs('Board', 'report.md#board')] }) }
DETAILS['board.advanced'] = { now: ({ board } = {}) => ({ title: 'Advanced today', value: board && amount(board.columns.reduce((sum, { done }) => sum + (done ?? 0), 0)),
  rows: [...byColumn(board, ({ done }) => done ?? 0, undefined, (column) => `From ${columnName(column)}`), ['Today', today(board)]],
  say: ['Someone leaves a step by reaching a later one, and missed calls by being called back, or by calling again and getting through.'], links: [docs('Board', 'report.md#board')] }) }

DETAILS['board.person'] = {
  now({ row, column, board, limits } = {}) {
    if (!row || !board) return undefined
    const step = column?.step ?? null
    // Open hours have passed more slowly than the clock, so how late is known only without them.
    const over = column?.wait ? board.at - row.at - column.wait : 0
    const limit = column?.wait ? `${lasted(column.wait)}${board.openHours ? ` of open hours${row.late ? ' · overdue' : ''}` : row.late ? ` · overdue by ${lasted(Math.max(0, over))}` : ` · ${lasted(Math.max(0, -over))} left`}` : undefined
    return { title: reviewDisplay.idText(row.subject), value: step ?? 'Missed call', roomy: true,
      rows: [[step === null ? 'Waiting since' : 'At this step since', [moment(row.at), between(row.at, board.at)].filter(Boolean).join(' · ')], [step === null ? 'Limit for a call back' : `Limit for ${step}`, limit]],
      say: [column?.wait ? ['Overdue', ` means longer here than the limit for ${step === null ? 'a call back' : 'this step'}${board.openHours ? ', counted in open hours' : ''}.`] : undefined],
      links: [{ text: 'Open Journey', href: journeyHash(row.subject) }, { text: 'Account', href: subjectHash(row.subject) }] }
  },
  more: ({ row, board } = {}) => row && recent(`/journey?subject=${encodeURIComponent(row.subject)}`).then((journey) => {
    const { entries, subjects } = journey
    const partial = journey.next !== null
    // A journey reads further than the board, which is of one group: what is only linked to it has no part in the column.
    const of = (kind) => entries.filter((entry) => entry.kind === kind && subjects?.[entry.subject]?.how !== 'linked')
    const ladder = (board?.columns ?? []).map(({ step }) => step).filter((step) => step !== null)
    // When each step was first reached, in the order of the board.
    const first = new Map()
    for (const entry of of('outcome')) if (!entry.notLead && ladder.includes(entry.outcome.stage) && !first.has(entry.outcome.stage)) first.set(entry.outcome.stage, entry)
    const reached = ladder.filter((step) => first.has(step))
    const next = ladder[ladder.indexOf(row.step) + 1]
    const day = (at) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const worth = of('outcome').findLast((entry) => entry.outcome.stage === row.step)
    const call = of('call').at(-1)
    const open = of('call').filter((entry) => entry.followUp?.state === 'open' && !entry.notLead)
    const texts = of('text').filter((entry) => entry.reply?.state === 'open' && !entry.notLead).length
    // With earlier events still unread, the first of these may not be the first.
    const visit = partial ? undefined : of('visit').find((entry) => !byNumber(entry))
    const ties = Object.entries(subjects ?? {}).filter(([, tie]) => tie.how !== 'self')
    const strongest = ties.filter(([, tie]) => tie.score !== null).sort(([, x], [, y]) => y.score - x.score)[0]
    const consent = of('consent').at(-1)
    return {
      // With earlier events still unread, neither is the first of a step.
      rows: [['Reached', partial ? undefined : reached.map((step) => `${step} ${day(first.get(step).at)}`).join(' → ')], ['Next step', row.step === null ? undefined : next],
        ['Value', worth?.first && worth.first.at > 0 && row.value !== null && worth.first.value !== row.value ? `${worthOf(row.value, row.currency)} · at first ${worthOf(worth.first.value, worth.first.currency)}` : row.value > 0 ? worthOf(row.value, row.currency) : undefined],
        ['Last call', call && `${inShort(call)}, ${moment(call.at)}${call.followUp?.attempts > 0 && !call.notLead ? ` · ${amount(call.followUp.attempts)} ${call.followUp.attempts === 1 ? 'attempt' : 'attempts'} since` : ''}`],
        ['Texts waiting', texts > 0 ? `${amount(texts)}${partial ? '+' : ''}` : undefined], visit ? ['First visit', `${day(visit.at)} · ${visitWords(visit)}`] : ['Credited to', cameFrom(row)],
        ['IDs', subjects && `${amount(Object.keys(subjects).length)}${partial || journey.more > 0 ? '+' : ''}${strongest ? ` · strongest ${percent(strongest[1].score)}${strongest[1].kinds.length > 0 ? `, ${strongest[1].kinds[0]}` : ''}` : ''}`], ['Consent for ads', consent && consentWords(consent.answer)]],
      links: [open[0] && { text: 'Show Missed Call', href: journeyHash(row.subject, open[0].call.id) }],
    }
  }),
}
DETAILS['board.text'] = {
  now: ({ text, at } = {}) => text && { title: reviewDisplay.idText(text.subject), value: 'Unanswered texts', roomy: true,
    rows: [['Texts waiting', counted(text.unanswered)], ['Came from', cameFrom(text)], ['Tags', tagWords(text.tags)]],
    say: ['A text is answered by a text back, or by a call somebody answered.'], links: [{ text: 'Open Journey', href: journeyHash(text.subject) }, docs('Unanswered Texts', 'calls.md#unanswered-texts')] },
  more: ({ text, at } = {}) => text && recent(`/journey?subject=${encodeURIComponent(text.subject)}`).then(({ entries, next }) => {
    const texts = entries.filter((entry) => entry.kind === 'text' && entry.subject === text.subject)
    const open = texts.filter((entry) => entry.reply?.state === 'open' && !entry.notLead)
    const said = texts.filter((entry) => entry.text.flags?.includes('opt_out') || entry.text.flags?.includes('opt_in')).at(-1)
    const back = texts.findLast((entry) => entry.text.direction === 'outbound')
    const spoke = entries.findLast((entry) => entry.kind === 'call' && entry.subject === text.subject && entry.state === 'answered')
    const last = [back, spoke].filter(Boolean).sort((x, y) => y.at - x.at)[0]
    const ago = (entry) => entry && `${moment(entry.at)} · ${lasted(at - entry.at)} ago`
    return { rows: [['First of them', next === null ? ago(open[0]) : undefined], ['Latest', open.length > 1 ? ago(open.at(-1)) : undefined], ['Asked to stop', said && `${said.text.flags.includes('opt_out') ? 'Yes' : 'Asked for texts again'}, ${moment(said.at)}`], ['Last reply', last && `${last.kind === 'call' ? 'A call' : 'A text'}, ${moment(last.at)}`]] }
  }),
}

const ACTIVE = 'Today is the people active today, with a call or a step, in the time zone of the line under the numbers. Overdue counts only those people.'
// Everybody once, at the furthest step they reached, with missed calls nobody returned first.
view('board', 'Board', async (box, days = '90') => {
  const board = await api('GET', `/board?days=${encodeURIComponent(days)}`)
  const { texts, next: further } = await api('GET', `/texts?from=${board.from}&to=${board.day}`)
  const sum = (of) => board.columns.reduce((total, column) => total + (of(column) ?? 0), 0)
  const [people, late, fresh, moved] = [sum((column) => column.people), sum((column) => column.late), sum((column) => column.fresh), sum((column) => column.done)]
  const about = (key, label) => ({ detail: detail(`board.${key}`, { label, of: () => ({ board }) }) })
  const pick = el('select', { title: ACTIVE, 'aria-describedby': 'board-period', on: { change: () => go(`#/board/${pick.value}`) } }, ...PERIODS.map(([value, text]) => el('option', { value, ...(value === board.days && { selected: '' }) }, text)))
  box.append(el('section', {}, reviewDisplay.heading('Board', el('label', {}, 'Period', pick)),
    tiles([term('People', 'board'), amount(people), '', '', about('people', `People, ${amount(people)}`)],
      [term('Overdue', 'overdue', board.openHours ? 'Limits count open hours.' : ''), amount(late), board.columns.some((column) => column.late !== null) ? '' : 'No limits set', late > 0 ? 'apart' : '', about('overdue', `Overdue, ${amount(late)}`)],
      ['New today', amount(fresh), '', '', about('fresh', `New today, ${amount(fresh)}`)], [term('Advanced today', 'advanced'), amount(moved), '', '', about('advanced', `Advanced today, ${amount(moved)}`)]),
    reviewDisplay.range({ from: board.from, to: board.day, timeZone: board.timeZone }),
    el('p', { class: board.days === 1 ? 'meta' : 'sr-only', id: 'board-period' }, ACTIVE),
    board.unplaced > 0 ? el('p', { class: 'meta' }, `${amount(board.unplaced)} more at steps outside STAGES`) : '',
    board.columns.length === 1 ? el('p', {}, 'Set STAGES to add a column for each step.') : ''))
  const columns = board.columns.map((column, at) => {
    const name = columnName(column)
    const counts = [`${amount(column.people)} ${column.people === 1 ? 'person' : 'people'}`, column.fresh > 0 && `${amount(column.fresh)} new`,
      column.late > 0 && `${amount(column.late)} over ${lasted(column.wait)}`, column.done > 0 && `${amount(column.done)} ${column.step === null ? 'reached' : 'advanced'} today`]
    const cards = el('ol', { role: 'list' }, ...column.rows.map((row) => person(row, column, board)))
    const lane = el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': `${name}: people`, ...(column.rows.length === 0 && { hidden: '' }) }, cards)
    return el('section', { 'aria-label': name, id: `column-${at}`, tabindex: -1, ...(column.people === 0 && { class: 'idle' }) }, el('h2', {}, column.step === null ? term(name, 'missedColumn') : name),
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
