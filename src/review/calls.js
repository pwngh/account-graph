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
  const table = el('table', { class: 'hours' }, el('caption', {}, `${name}, by the hour each call began, ${summary.from} to ${summary.to}, ${summary.timeZone}`),
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
  td('num nowrap', lasted(at - call.at)), td('nowrap', when(call.at)),
  ...edge([td('', el('span', { class: `chip ${call.state === 'voicemail' ? '' : 'apart'}` }, call.state === 'voicemail' ? 'voicemail' : 'missed')),
    td('who', call.source ? `${call.source}${call.campaign || call.campaignId ? `, ${call.campaign || call.campaignId}` : ''}` : el('span', { class: 'muted' }, 'no arrival credited')),
    td('num', call.result?.waited === undefined ? unrecorded() : `${amount(Math.round(call.result.waited))} s`), td('num', tally(call.attempts))]),
  ...edge([td('who', call.tags ? Object.entries(call.tags).map(([name, value]) => `${name.replaceAll('_', ' ')} ${value}`).join(', ') : unrecorded()), td('', el('a', { class: 'link', href: `#/journey/${encodeURIComponent(call.subject)}`, title: call.subject }, `${call.subject.slice(0, 18)}…`))]))

// Calls to you: what is still open, how they went, and how many could be placed.
view('calls', 'Calls', async (box, first, last) => {
  const { form, query: asked, resolved } = period('calls', first, last)
  const top = el('section', {}, el('h3', {}, 'Calls'), form)
  box.append(top)
  const [open, summary] = await Promise.all([api('GET', `/calls?${asked}`), api('GET', `/calls/summary?${asked}`)])
  const query = resolved(summary)
  const { total, coverage } = summary
  top.append(el('p', { class: 'muted' }, `${summary.from} to ${summary.to}, days in ${summary.timeZone}. ${amount(total.calls)} ${total.calls === 1 ? 'call' : 'calls'} to you.`),
    notes('Callers are kept as hashes of their numbers, so this screen shows a subject and never a phone number. Find the number in your phone system by the time of the call.', summary.expected ? 'A call counts once a result says a person answered.' : 'No results are expected, so a call with none is counted by its length.'))

  const lost = total.missed + total.voicemail
  if (total.calls > 0) top.append(tiles(['Calls to you', amount(total.calls)], ['Answered', percent(total.answered / total.calls), `${amount(total.answered)} ${summary.expected ? 'by a person' : 'by result or by length'}`],
    ['Missed or voicemail', amount(lost), percent(lost / total.calls)],
    lost > 0 && ['Returned', percent(total.returned / lost), `${amount(total.returned)} of ${amount(lost)}${summary.returnedWithin === null ? '' : `, half within ${lasted(summary.returnedWithin)}`}`],
    ['Still waiting for a call back', `${amount(open.calls.length)}${open.next === null ? '' : ' or more'}`, open.calls[0] ? `oldest ${lasted(open.at - open.calls[0].at)}` : '', open.calls.length > 0 ? 'apart' : 'same']))
  const table = el('table', {}, el('tr', {}, group('When', 2, true), group('What happened', 4), group('Who', 2)), el('tr', {}, th('Age', 'num'), th('Began'), ...edge([th('How'), th('Credited to'), th('Waited', 'num'), th('Tries', 'num')]), ...edge([th('Tags'), th('Caller')])), ...open.calls.map(openRow(open.at)))
  box.append(el('section', {}, el('h2', {}, 'Missed and not returned, oldest first'),
    open.calls.length > 0 ? wide('Missed and not returned', table) : el('p', {}, total.missed + total.voicemail > 0 ? 'None. Every caller who could be rung back has been reached since.' : 'None. No call in these days is known to have been missed.'),
    open.calls.length > 0 ? paged(table, open.next, 'Show more', async (next) => {
      const page = await api('GET', `/calls?${query}&after=${encodeURIComponent(next)}`)
      return { rows: page.calls.map(openRow(page.at)), next: page.next }
    }) : '',
    total.hidden > 0 ? el('p', { class: 'muted' }, `${amount(total.hidden)} more hid their number and cannot be rung back.`) : ''))

  if (total.calls === 0) {
    box.append(el('section', {}, el('p', { class: 'muted' }, 'No call was recorded in these days.')))
    return
  }
  const states = el('table', {}, el('tr', {}, th('How it went'), th('Calls', 'num'), th('Share', 'num'), th('What it means')),
    ...[['Answered', total.answered, total.calls, 'A person spoke to the caller.'], ['Missed', total.missed, total.calls, 'Nobody did.'], ['Voicemail', total.voicemail, total.calls, 'The caller reached voicemail.'],
      ['Waiting', total.waiting, total.calls, 'A result is expected and has not come yet.'], ['Unknown', total.unknown, total.calls, 'Nothing says whether a person answered.'],
      ['Returned', total.returned, lost, `Of those missed or in voicemail, rung back and reached.${summary.returnedWithin === null ? '' : ` Half of them within ${lasted(summary.returnedWithin)}.`}`],
      ['Tried again', total.triedAgain, lost, 'Of those missed or in voicemail, the caller rang again and got through.']].map(([name, count, whole, meaning], i) => el('tr', i === 5 ? { class: 'second' } : {}, td('', name), td('num', tally(count)), td('num share', whole > 0 ? percent(count / whole) : none(), meter(whole > 0 ? count / whole : 0)), td('muted', meaning))))
  box.append(el('section', {}, el('h2', {}, 'How they went'), wide('How calls went', states), saved(`calls-${summary.from}-${summary.to}`, states)))

  const pick = el('select', { 'aria-label': 'Which calls', on: { change: () => { measure = pick.value; grid.replaceChildren(hours(summary)) } } }, ...MEASURES.map(([key, text]) => el('option', { value: key, ...(key === measure && { selected: '' }) }, text)))
  const grid = el('div', { class: 'wide', tabindex: 0, role: 'region', 'aria-label': 'Calls by hour and weekday' }, hours(summary))
  box.append(el('section', {}, el('h2', {}, 'By hour and weekday'), el('div', { class: 'row' }, pick), grid, el('p', { class: 'muted' }, 'Blank: no calls. Darker: more.')))

  box.append(el('section', {}, el('h2', {}, 'How calls were placed'), parts('How calls were placed', [['Tied to a visitor', coverage.visitor, 'Followed a tap on the number, so the call has their arrival.'], ['Filed under a channel', coverage.channel, 'Only the number rung says where it came from.'], ['Neither', coverage.neither, 'The number is not listed and nobody tapped it.']]),
    coverage.noResult > 0 ? el('p', { class: 'muted' }, `${amount(coverage.noResult)} of these have no result.`) : ''))
}, { every: 60_000 })
