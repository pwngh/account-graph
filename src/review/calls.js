const MEASURES = [
  ['calls', 'All calls'], ['answered', 'Answered'], ['missed', 'Missed'], ['voicemail', 'Voicemail'], ['unknown', 'Unknown'], ['waiting', 'Waiting for result'], ['returned', 'Returned'],
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
  const table = el('table', { class: 'hours' }, el('caption', {}, `${name} · ${reviewDisplay.day(summary.from)} – ${reviewDisplay.day(summary.to)} · ${summary.timeZone}`),
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

/** Which missed call is open beside the list and which are listed, kept while the screen is open. */
const inbox = { id: undefined, state: 'all' }
const credited = (call) => (call.source ? `${call.source}${call.campaign || call.campaignId ? ` · ${call.campaign ?? call.campaignId}` : ''}` : 'Unattributed')
/** Calls by how long they have waited, so the list reads as what is late and what is fresh. */
const ages = (at) => [['Today', (call) => at - call.at < 86400000], ['This week', (call) => at - call.at < 7 * 86400000], ['Older', () => true]]

/**
 * Missed calls nobody returned: the list, the caller's story so far, and what
 * is known of the call, side by side. Arrow keys walk the list.
 */
function missedCalls(open, at) {
  const calls = [...open]
  const list = el('div', { class: 'inbox-list scroll', role: 'listbox', tabindex: 0, 'aria-label': 'Missed calls' })
  const story = el('div', { class: 'inbox-story' })
  const facts = el('div', { class: 'inbox-facts' })
  const choose = el('div', { class: 'segments', role: 'group', 'aria-label': 'Result' })
  const root = el('div', { class: 'inbox' }, el('div', { class: 'inbox-side' }, choose, list), story, facts)
  let asked = 0

  const shown = () => calls.filter((call) => inbox.state === 'all' || call.state === inbox.state)
  function draw() {
    const held = list.contains(document.activeElement)
    const some = shown()
    if (!some.some((call) => call.id === inbox.id)) inbox.id = some[0]?.id
    choose.replaceChildren(...[['all', 'All'], ['missed', 'Missed'], ['voicemail', 'Voicemail']].map(([state, text]) => el('button', { type: 'button', 'data-key': `calls ${state}`, 'aria-pressed': String(inbox.state === state), on: { click: () => { inbox.state = state; draw() } } }, text, el('span', { class: 'count' }, amount(calls.filter((call) => state === 'all' || call.state === state).length)))))
    const groups = ages(at).map(([name, holds]) => [name, holds])
    const left = new Set(some)
    // The oldest waits longest, so it is first in its group and the oldest group is first.
    const parts = groups.map(([name, holds]) => [name, [...left].filter((call) => holds(call) && left.delete(call))]).reverse()
    list.replaceChildren(...parts.filter(([, each]) => each.length > 0).map(([name, each]) => el('div', { role: 'group', 'aria-label': name }, el('p', { class: 'inbox-age' }, name, el('span', { class: 'count' }, amount(each.length))), ...each.map(line))))
    if (some.length === 0) list.replaceChildren(el('p', { class: 'muted inbox-age' }, 'None'))
    if (held) list.querySelector('[aria-selected=true]')?.focus({ preventScroll: true })
    tell()
  }
  const line = (call) => el('div', { class: 'inbox-call', role: 'option', tabindex: call.id === inbox.id ? 0 : -1, 'aria-selected': String(call.id === inbox.id), on: { click: () => pick(call) } },
    tile(call.state === 'voicemail' ? 'M4.6 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM11.4 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM4.6 10.4h6.8' : 'M4.5 4.5 8 8l4.2-4.2M4.5 4.5v3M4.5 4.5h3M3 12.5c3-2.4 7-2.4 10 0', call.state === 'voicemail' ? 'related' : 'apart'), el('span', { class: 'inbox-who' }, reviewDisplay.idText(call.subject)), el('span', { class: 'inbox-time' }, reviewDisplay.time(call.at, at)),
    el('span', { class: 'inbox-from' }, `${call.state === 'voicemail' ? 'Voicemail' : 'Missed'} · ${credited(call)}`), call.attempts > 0 ? el('span', { class: 'chip' }, `${amount(call.attempts)} ${call.attempts === 1 ? 'attempt' : 'attempts'}`) : '')
  function pick(call) {
    inbox.id = call.id
    for (const each of list.querySelectorAll('.inbox-call')) { each.setAttribute('aria-selected', 'false'); each.tabIndex = -1 }
    draw()
    const now = list.querySelector('[aria-selected=true]')
    if (list.contains(document.activeElement) || document.activeElement === document.body) now?.focus({ preventScroll: true })
    now?.scrollIntoView({ block: 'nearest' })
  }
  list.addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    // In the order on screen, which is by age.
    const rows = [...list.querySelectorAll('.inbox-call')]
    rows[rows.findIndex((row) => row.getAttribute('aria-selected') === 'true') + step]?.click()
  })
  async function tell() {
    const call = calls.find((each) => each.id === inbox.id)
    const turn = ++asked
    if (!call) return void (story.replaceChildren(), facts.replaceChildren())
    const copied = el('span', { class: 'meta', role: 'status' })
    facts.replaceChildren(el('dl', {}, ...[['Called', reviewDisplay.time(call.at)], ['Wait', call.result?.waited === undefined ? unrecorded() : `${amount(Math.round(call.result.waited))} s`],
      ['Attempts', tally(call.attempts)], ['Source', call.source ? credited(call) : el('span', { class: 'muted' }, 'Unattributed')],
      ...(call.tags ? Object.entries(call.tags).map(([name, value]) => [name.replaceAll('_', ' '), String(value)]) : [])].flatMap(([name, value]) => [el('dt', {}, name), el('dd', {}, value)])),
    el('div', { class: 'row' }, el('button', { type: 'button', on: { click: async () => {
      try {
        await navigator.clipboard.writeText(when(call.at))
        copied.textContent = 'Copied'
      } catch {
        copied.textContent = when(call.at)
      }
    } } }, 'Copy time'), copied))
    const head = el('div', { class: 'inbox-head' }, el('div', {}, el('b', {}, term(reviewDisplay.id(call.subject), 'callerId')), el('p', { class: 'meta' }, call.state === 'voicemail' ? 'Voicemail · ' : 'Missed · ', reviewDisplay.time(call.at, at))),
      el('a', { class: 'button primary', href: `#/journey/${encodeURIComponent(call.subject)}` }, 'Open journey'), el('a', { class: 'button', href: subjectHash(call.subject) }, 'Account'))
    story.replaceChildren(head, el('div', { class: 'waiting-lines', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')))
    try {
      const journey = await api('GET', `/journey?subject=${encodeURIComponent(call.subject)}`)
      if (turn !== asked) return
      const entries = [...journey.entries].reverse()
      const subjects = Object.keys(journey.ties).length
      story.replaceChildren(head, el('p', { class: 'inbox-age' }, 'History', el('span', { class: 'count' }, `${amount(entries.length)}${journey.next === null ? '' : '+'}`), subjects > 1 ? el('span', { class: 'meta' }, ` · ${amount(subjects)} IDs`) : ''),
        el('ol', { class: 'story', role: 'list' }, ...entries.slice(0, 14).map((entry) => el('li', { class: `${entry.kind}${entry.kind === 'call' && entry.call.id === call.id ? ' this' : ''}` }, glyph(entry.kind), el('div', { class: 'what' }, ...told(entry)), el('span', { class: 'meta' }, reviewDisplay.time(entry.at > 0 ? entry.at : null, at))))),
        entries.length > 14 ? el('p', { class: 'meta' }, `${amount(entries.length - 14)} more in the journey`) : '')
    } catch (error) {
      if (turn === asked) story.replaceChildren(head, el('p', { class: 'apart' }, `History unavailable: ${error.message}`))
    }
  }
  // A page more of them, as a table would take it.
  root.appendRows = (...more) => { calls.push(...more); draw() }
  draw()
  return root
}

// Calls to you: what is still open, how they went, and how many could be placed.
view('calls', 'Calls', async (box, first, last) => {
  const { form, query: asked, resolved } = period('calls', first, last)
  const top = el('section', {}, reviewDisplay.heading('Calls', form))
  box.append(top)
  const [open, summary] = await Promise.all([api('GET', `/calls?${asked}`), api('GET', `/calls/summary?${asked}`)])
  const before = daysBefore(summary)
  const then = (await api('GET', `/calls/summary?from=${before.from}&to=${before.to}`)).total
  // With no calls in the days before there is nothing to compare with: it may be before any were kept.
  const against = (now, was, words, good, points) => (then.calls > 0 ? changed(now, was, words, before, good, points) : '')
  const byHour = (kind) => Array.from({ length: 24 }, (_, hour) => summary.cells.filter((cell) => cell.hour === hour).reduce((sum, cell) => sum + cell[kind], 0))
  const query = resolved(summary)
  const { total, coverage } = summary
  top.append(reviewDisplay.range(summary))

  const lost = total.missed + total.voicemail
  // Returns are not compared: the newest callers have had less time to be rung back.
  const lostThen = then.missed + then.voicemail
  const part = (n, whole) => (whole > 0 ? n / whole : null)
  if (total.calls > 0) top.append(tiles(
    [term('Inbound calls', 'inbound'), amount(total.calls), '', '', { change: against(total.calls, then.calls, amount), bars: shape(byHour('calls'), 'Calls by starting hour') }],
    [term('Answered', summary.expected ? 'answered' : 'answeredLength'), percent(total.answered / total.calls), `${amount(total.answered)} of ${amount(total.calls)}`, '', { change: against(part(total.answered, total.calls), part(then.answered, then.calls), percent, 'up', true) }],
    [term('Missed', 'missed'), amount(lost), `${percent(lost / total.calls)}${summary.closed ? ` · ${amount(summary.closed.missed + summary.closed.voicemail)} after hours` : ''}`, '', { change: against(lost, lostThen, amount, 'down'), bars: shape(byHour('missed').map((n, hour) => n + byHour('voicemail')[hour]), 'Missed calls by starting hour') }],
    lost > 0 && [term('Returned', 'returned'), percent(total.returned / lost), `${amount(total.returned)} of ${amount(lost)}${summary.returnedWithin === null ? '' : ` · median ${lasted(summary.returnedWithin)}`}`],
    [term('Awaiting callback', 'awaiting'), `${amount(open.calls.length)}${open.next === null ? '' : '+'}`, open.calls[0] ? el('span', {}, 'Oldest ', reviewDisplay.time(open.calls[0].at, open.at)) : '', open.calls.length > 0 ? 'apart' : 'same']))
  const queue = open.calls.length > 0 ? missedCalls(open.calls, open.at) : undefined
  box.append(el('section', {}, el('h2', {}, 'Missed calls'),
    queue ?? el('p', { class: 'muted' }, total.calls === 0 ? 'No inbound calls' : lost > 0 ? 'All missed callers have been reached.' : 'No missed calls'),
    queue ? paged(queue, open.next, 'Show more', async (next) => {
      const page = await api('GET', `/calls?${query}&after=${encodeURIComponent(next)}`)
      return { rows: page.calls, next: page.next }
    }) : '',
    total.hidden > 0 ? el('p', { class: 'muted' }, `${amount(total.hidden)} more with a withheld number`) : ''))

  if (total.calls === 0) return
  const states = el('table', {}, el('tr', {}, th('Result'), th('Calls', 'num'), th('Share', 'num'), th('Detail')),
    ...[['Answered', total.answered, total.calls, ''],
      ['Missed', total.missed, total.calls, ''], ['Voicemail', total.voicemail, total.calls, ''],
      ['Waiting', total.waiting, total.calls, 'Result not received yet'], ['Unknown', total.unknown, total.calls, 'Result unavailable'],
      ['Returned', total.returned, lost, [summary.returnedWithin !== null && `Median ${lasted(summary.returnedWithin)}`, total.told > 0 && `${amount(total.told)} reported by another system`].filter(Boolean).join(' · ')],
      ['Called again', total.triedAgain, lost, 'Caller got through later'],
      ...(total.notLeads > 0 ? [['Not a lead', total.notLeads, 0, 'Excluded from other counts']] : [])].map(([name, count, whole, meaning], i) =>
      behind(el('tr', i === 5 ? { class: 'second' } : {}, td('', reviewDisplay.chip(name, reviewDisplay.callTone(name.toLowerCase()))), td('num', tally(count)),
        td('num share', whole > 0 ? percent(count / whole) : none()), td('muted', meaning)), whole > 0 ? count / whole : 0)))
  const results = el('section', {}, reviewDisplay.section(term('Call results', 'callResults'), saved(`calls-${summary.from}-${summary.to}`, states)), wide('Call results', states))
  const placement = el('section', {}, el('h2', {}, term('Call attribution', 'attribution')), parts('Call attribution', [
    ['Visitor', coverage.visitor],
    ['Phone number', coverage.channel],
    ['Unmatched', coverage.neither],
  ]), coverage.noResult > 0 ? el('p', { class: 'meta' }, `${amount(coverage.noResult)} without a result`) : '')
  box.append(el('div', { class: 'panel-grid call-grid' }, results, placement))

  const pick = el('select', { 'aria-label': 'Result', on: { change: () => { measure = pick.value; grid.replaceChildren(hours(summary)) } } }, ...MEASURES.map(([key, text]) => el('option', { value: key, ...(key === measure && { selected: '' }) }, text)))
  const grid = el('div', { class: 'wide', tabindex: 0, role: 'region', 'aria-label': 'Calls by hour' }, hours(summary))
  box.append(el('section', {}, reviewDisplay.section(term('Calls by hour', 'heat'), pick), grid))
}, { every: 60_000 })
