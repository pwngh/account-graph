const MEASURES = [
  ['calls', 'All calls'], ['answered', 'Answered by a person'], ['missed', 'Missed'], ['voicemail', 'Voicemail'], ['unknown', 'Unknown'], ['waiting', 'Waiting for a result'], ['returned', 'Returned by you'],
]
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
// Which count the table of hours shows, kept while the screen is open.
let measure = 'missed'

/** Hours across, weekdays down, with the number in every cell. The shade only repeats the number, so nothing rests on it. */
function hours(summary) {
  const value = (cell) => cell[measure]
  const at = new Map(summary.cells.map((cell) => [`${cell.weekday} ${cell.hour}`, cell]))
  const most = Math.max(1, ...summary.cells.map(value))
  const name = MEASURES.find(([key]) => key === measure)[1]
  const table = el('table', { class: 'hours' }, el('caption', {}, `${name} · Call start hour · ${summary.timeZone}`),
    el('tr', {}, th(''), ...Array.from({ length: 24 }, (_, hour) => th(String(hour).padStart(2, '0'), 'num')), th('All', 'num')))
  WEEKDAYS.forEach((day, i) => {
    const cells = Array.from({ length: 24 }, (_, hour) => at.get(`${i + 1} ${hour}`))
    const sum = cells.reduce((total, cell) => total + (cell ? value(cell) : 0), 0)
    table.append(el('tr', {}, el('th', { scope: 'row' }, day), ...cells.map((cell, hour) => {
      const n = cell ? value(cell) : 0
      // An hour with no calls at all is blank. An hour with calls and none of this kind says 0.
      return el('td', { class: `num heat${Math.ceil((4 * n) / most)}`, ...(cell && { title: `${day} ${String(hour).padStart(2, '0')}:00, ${name.toLowerCase()}: ${n} of ${cell.calls} calls` }) }, cell ? n : '')
    }), td('num', amount(sum))))
  })
  return table
}

const openRow = (at) => (call) => el('tr', {},
  td('who', reviewDisplay.subject(call.subject, `#/journey/${encodeURIComponent(call.subject)}`)),
  td('nowrap', reviewDisplay.time(call.at, at)),
  td('', reviewDisplay.chip(call.state === 'voicemail' ? 'Voicemail' : 'Missed', reviewDisplay.callTone(call.state))),
  ...edge([td('nowrap', reviewDisplay.time(call.at)),
    td('num', call.result?.waited === undefined ? unrecorded() : `${amount(Math.round(call.result.waited))} s`), td('num', tally(call.attempts))]),
  ...edge([td('who', ...(call.source ? [call.source, call.campaign ? `, ${call.campaign}` : call.campaignId ? ', ' : '', !call.campaign && call.campaignId ? reviewDisplay.id(call.campaignId) : ''] : [el('span', { class: 'muted' }, 'No arrival credited')])),
    td('who', call.tags ? Object.entries(call.tags).map(([name, value]) => `${name.replaceAll('_', ' ')} ${value}`).join(', ') : unrecorded())]))

// Calls to you: what is still open, how they went, and how many could be placed.
view('calls', 'Calls', async (box, first, last) => {
  const { form, query: asked, resolved } = period('calls', first, last)
  const top = el('section', {}, reviewDisplay.heading('Calls', form))
  box.append(top)
  const [open, summary] = await Promise.all([api('GET', `/calls?${asked}`), api('GET', `/calls/summary?${asked}`)])
  const query = resolved(summary)
  const { total, coverage } = summary
  top.append(reviewDisplay.range(summary))

  const lost = total.missed + total.voicemail
  if (total.calls > 0) top.append(tiles(['Calls to you', amount(total.calls)], ['Answered', percent(total.answered / total.calls), `${amount(total.answered)} ${summary.expected ? 'by a person' : 'by result or by length'}`],
    ['Missed or voicemail', amount(lost), percent(lost / total.calls)],
    lost > 0 && ['Returned', percent(total.returned / lost), `${amount(total.returned)} of ${amount(lost)}${summary.returnedWithin === null ? '' : `, half within ${lasted(summary.returnedWithin)}`}`],
    ['Waiting for a callback', `${amount(open.calls.length)}${open.next === null ? '' : ' or more'}`, open.calls[0] ? el('span', {}, 'Oldest: ', reviewDisplay.time(open.calls[0].at, open.at)) : '', open.calls.length > 0 ? 'apart' : 'same']))
  top.append(notes('Caller IDs are hashes, not phone numbers. Look up the number in your phone system by call time.',
    summary.expected ? 'An answer counts when a result says a person answered.' : 'No results are expected. Calls without a result are classified by length.'))
  const table = el('table', {}, el('tr', {}, group('Follow-up queue', 3, true), group('Call details', 3), group('Attribution', 2)),
    el('tr', {}, th('Caller'), th('Age'), th('Result'), ...edge([th('Began'), th('Waited', 'num'), th('Tries', 'num')]), ...edge([th('Credited to'), th('Tags')])),
    ...open.calls.map(openRow(open.at)))
  box.append(el('section', {}, el('h2', {}, 'Missed and not returned, oldest first'),
    open.calls.length > 0 ? wide('Missed and not returned', table) : el('p', { class: 'muted' }, total.calls === 0 ? 'No inbound calls recorded in this period.' : lost > 0 ? 'All callers who could be rung back have since been reached.' : 'No known missed calls in this period.'),
    open.calls.length > 0 ? paged(table, open.next, 'Show more', async (next) => {
      const page = await api('GET', `/calls?${query}&after=${encodeURIComponent(next)}`)
      return { rows: page.calls.map(openRow(page.at)), next: page.next }
    }) : '',
    total.hidden > 0 ? el('p', { class: 'muted' }, `${amount(total.hidden)} more hid their number and cannot be rung back.`) : ''))

  if (total.calls === 0) return
  const states = el('table', {}, el('tr', {}, th('Result'), th('Calls', 'num'), th('Share', 'num'), th('Meaning')),
    ...[['Answered', total.answered, total.calls, summary.expected ? 'A person answered.' : 'Answer by result or length.'],
      ['Missed', total.missed, total.calls, 'No answer.'], ['Voicemail', total.voicemail, total.calls, 'Reached voicemail.'],
      ['Waiting', total.waiting, total.calls, 'Result still expected.'], ['Unknown', total.unknown, total.calls, 'Answer not known.'],
      ['Returned', total.returned, lost, `Reached by callback after a miss or voicemail.${summary.returnedWithin === null ? '' : ` Half within ${lasted(summary.returnedWithin)}.`}`],
      ['Tried again', total.triedAgain, lost, 'Caller rang again and got through after a miss or voicemail.']].map(([name, count, whole, meaning], i) =>
      el('tr', i === 5 ? { class: 'second' } : {}, td('', reviewDisplay.chip(name, reviewDisplay.callTone(name.toLowerCase()))), td('num', tally(count)),
        td('num share', whole > 0 ? reviewDisplay.compare(percent(count / whole), count / whole) : none()), td('muted', meaning))))
  const results = el('section', {}, reviewDisplay.section('Call results', saved(`calls-${summary.from}-${summary.to}`, states)), wide('How calls went', states),
    notes('Returned and tried again are shares of missed calls and voicemail. Other shares are of all inbound calls.'))
  const placement = el('section', {}, el('h2', {}, 'How calls were placed'), parts('How calls were placed', [
    ['Tied to a visitor', coverage.visitor, 'Used a number shown to them or followed a tap.'],
    ['Filed under a channel', coverage.channel, 'Attributed by the number dialed.'],
    ['Neither', coverage.neither, 'Number not listed; no tap.'],
  ]), coverage.noResult > 0 ? el('p', { class: 'meta' }, `${amount(coverage.noResult)} have no result.`) : '')
  box.append(el('div', { class: 'panel-grid call-grid' }, results, placement))

  const pick = el('select', { 'aria-label': 'Which calls', on: { change: () => { measure = pick.value; grid.replaceChildren(hours(summary)) } } }, ...MEASURES.map(([key, text]) => el('option', { value: key, ...(key === measure && { selected: '' }) }, text)))
  const grid = el('div', { class: 'wide', tabindex: 0, role: 'region', 'aria-label': 'Calls by hour and weekday' }, hours(summary))
  box.append(el('section', {}, reviewDisplay.section('By hour and weekday', pick), grid, el('p', { class: 'meta' }, 'Blank: no calls. 0: calls, but none of this result.')))
}, { every: 60_000 })
