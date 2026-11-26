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
  const list = el('div', { class: 'inbox-list scroll', role: 'grid', tabindex: 0, 'aria-label': 'Missed calls' })
  const story = el('div', { class: 'inbox-story' })
  const facts = el('div', { class: 'inbox-facts' })
  const choose = el('div', { class: 'segments', role: 'group', 'aria-label': 'Result' })
  const empty = el('p', { class: 'muted inbox-age', hidden: '' }, 'None')
  const root = el('div', { class: 'inbox' }, el('div', { class: 'inbox-side' }, choose, list, empty), story, facts)
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
    list.replaceChildren(...parts.filter(([, each]) => each.length > 0).map(([name, each]) => el('div', { role: 'rowgroup', 'aria-label': `${name}, ${amount(each.length)}` }, el('p', { class: 'inbox-age', 'aria-hidden': 'true' }, name, el('span', { class: 'count' }, amount(each.length))), ...each.map(line))))
    // A grid holds rows and nothing else, so with none it is not there.
    list.hidden = some.length === 0
    empty.hidden = !list.hidden
    if (held) list.querySelector('[aria-selected=true]')?.focus({ preventScroll: true })
    tell()
  }
  /** What the card of one of them is made from. Its history is asked for when it is opened, as the story beside the list is. */
  const factsOf = (call) => ({ call, state: call.state, followUp: { state: 'open', attempts: call.attempts }, credit: call, limits, at })
  const icon = (call, where) => callDetail({ kind: 'call', call, state: call.state, at: call.at }, where, () => factsOf(call))
  const line = (call) => {
    const about = icon(call, 'list')
    // Walked with the arrow keys, the list has one place for the Tab key: the call that is open, and its icon.
    about.tabIndex = call.id === inbox.id ? 0 : -1
    return el('div', { class: 'inbox-call', role: 'row', tabindex: call.id === inbox.id ? 0 : -1, 'aria-selected': String(call.id === inbox.id), on: { click: (event) => about.contains(event.target) || pick(call) } },
      el('span', { class: 'inbox-cell', role: 'gridcell' }, tile(call.state === 'voicemail' ? LESSON_ICONS.voice : GLYPHS.missed, call.state === 'voicemail' ? 'related' : 'apart'), el('span', { class: 'inbox-who' }, reviewDisplay.idText(call.subject)), el('span', { class: 'inbox-time' }, reviewDisplay.time(call.at, at)),
        el('span', { class: 'inbox-from' }, `${call.state === 'voicemail' ? 'Voicemail' : 'Missed'} · ${credited(call)}`), call.attempts > 0 ? el('span', { class: 'chip' }, `${amount(call.attempts)} ${call.attempts === 1 ? 'attempt' : 'attempts'}`) : ''),
      el('span', { role: 'gridcell' }, about))
  }
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
    const head = el('div', { class: 'inbox-head' }, el('div', {}, el('b', {}, term(reviewDisplay.id(call.subject), 'callerId')), el('p', { class: 'meta' }, call.state === 'voicemail' ? 'Voicemail · ' : 'Missed · ', reviewDisplay.time(call.at, at), icon(call, 'story'))),
      el('a', { class: 'button primary', href: `#/journey/${encodeURIComponent(call.subject)}` }, 'Open journey'), el('a', { class: 'button', href: subjectHash(call.subject) }, 'Account'))
    story.replaceChildren(head, el('div', { class: 'waiting-lines', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')))
    try {
      const journey = await api('GET', `/journey?subject=${encodeURIComponent(call.subject)}`)
      if (turn !== asked) return
      const entries = [...journey.entries].reverse()
      const subjects = Object.keys(journey.subjects).length
      story.replaceChildren(head, el('p', { class: 'inbox-age' }, 'History', el('span', { class: 'count' }, `${amount(entries.length)}${journey.next === null ? '' : '+'}`), subjects > 1 ? el('span', { class: 'meta' }, ` · ${amount(subjects)} IDs`) : ''),
        el('ol', { class: 'story', role: 'list' }, ...entries.slice(0, 14).map((entry) => el('li', { class: `${entry.kind}${entry.kind === 'call' && entry.call.id === call.id ? ' this' : ''}` }, glyph(looksLike(entry)), el('div', { class: 'what' }, ...told(entry, callDetail(entry, 'history', () => ({ ...callFacts(entry, journey.entries, journey.next !== null), here: false, at })))), el('span', { class: 'meta' }, reviewDisplay.time(entry.at > 0 ? entry.at : null, at))))),
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

const hourOf = (hour) => new Date(2026, 0, 1, hour % 24).toLocaleTimeString(undefined, { hour: 'numeric' })
const hourSpan = (hour) => `${hourOf(hour)} – ${hourOf(hour + 1)}`
/** The largest of some counts by place, and the places that have it. Nothing where there is none, or where more than two share it, as then no place stands out. */
function peak(counts) {
  const most = Math.max(0, ...counts)
  const at = counts.flatMap((n, i) => (n === most ? [i] : []))
  return most > 0 && at.length <= 2 ? { most, at } : undefined
}
const sumOf = (cells, at, places, ...kinds) => Array.from({ length: places }, (_, i) => (cells ?? []).filter((cell) => at(cell) === i).reduce((sum, cell) => sum + kinds.reduce((all, kind) => all + (cell[kind] ?? 0), 0), 0))
/** What the periods before this one came to: the one the page compares with, and three more as long. Where one has no calls, the one after it may be when calls began to be kept, so neither is a period to hold against. */
async function earlier(summary, then) {
  const ranges = [daysBefore(summary)]
  while (ranges.length < 4) ranges.push(daysBefore(ranges.at(-1)))
  const others = await Promise.all(ranges.slice(1).map(({ from, to }) => recent(`/calls/summary?from=${from}&to=${to}`)))
  const all = [then, ...others.map(({ total }) => total)]
  const empty = all.findIndex((total) => !(total?.calls > 0))
  const held = empty < 0 ? all : all.slice(0, Math.max(0, empty - 1))
  // Too few to be a range anybody could hold a number against.
  return held.length >= 2 && held.reduce((sum, { calls }) => sum + calls, 0) >= 20 ? held : []
}
async function lastPeriods({ summary, then }, value, words) {
  const held = summary ? (await earlier(summary, then)).map(value) : []
  if (held.length === 0) return {}
  const [least, most] = [Math.min(...held), Math.max(...held)].map(words)
  return { rows: [[`Your last ${amount(held.length)} periods`, least === most ? least : `${least} – ${most}`]] }
}
const previous = ({ summary, then }, words) => [summary?.from ? `Previous ${daysBefore(summary).count === 1 ? 'day' : `${amount(daysBefore(summary).count)} days`}` : '', then?.calls > 0 ? words(then) : undefined]
/** The zone the hours of a report are in, for a card that names one of them. */
const zoneOf = (summary, hour) => ['Hours are in', hour && summary?.timeZone]
const toMissed = () => toPart('View Missed Calls', 'calls-missed')
const byHours = () => toPart('Calls by Hour', 'calls-hours')
DETAILS['calls.inbound'] = {
  now({ summary, then } = {}) {
    const { total, cells } = summary ?? {}
    const hours = sumOf(cells, (cell) => cell.hour, 24, 'calls')
    const [hour, day] = [peak(hours), peak(sumOf(cells, (cell) => cell.weekday - 1, 7, 'calls'))]
    const began = hours.findIndex((n) => n > 0)
    return { title: 'Inbound calls', value: counted(total?.calls),
      rows: [['Inbound calls', counted(total?.calls)], ['Not a lead, left out', counted(total?.notLeads)], ['First hour with a call', began < 0 ? undefined : hourSpan(began)],
        ['Busiest hour', hour && `${hour.at.map(hourSpan).join(', ')} · ${amount(hour.most)}`], ['Busiest weekday', day && `${day.at.map((i) => WEEKDAYS[i]).join(', ')} · ${amount(day.most)}`],
        ['Missed, number withheld', counted(total?.hidden)], zoneOf(summary, began >= 0), previous({ summary, then }, ({ calls }) => amount(calls))],
      say: ['If visits held and calls fell, check the numbers shown on the site.'],
      links: [byHours(), summary?.from && { text: 'Channels', href: `#/channels/${summary.from}/${summary.to}` }] }
  },
  more: (data) => lastPeriods(data ?? {}, ({ calls }) => calls, amount),
}
DETAILS['calls.answered'] = {
  now({ summary, then, goals } = {}) {
    const { total, cells } = summary ?? {}
    const rate = total?.calls > 0 ? total.answered / total.calls : undefined
    // An hour of fewer calls says nothing of the hour.
    const weakest = (cells ?? []).filter(({ calls, answered }) => calls >= 5 && answered / calls < rate).sort((x, y) => x.answered / x.calls - y.answered / y.calls || y.calls - x.calls)[0]
    const target = goals?.answered
    const short = target && rate !== undefined ? Math.max(1, Math.ceil(target * total.calls - total.answered - 1e-9)) : 0
    return { title: 'Answered', value: rate === undefined ? undefined : percent(rate),
      rows: [['Answered by a person', counted(total?.answered)], ['All inbound calls', counted(total?.calls)], ['Missed · voicemail', both(total?.missed, total?.voicemail)],
        ['Waiting · unknown result', both(total?.waiting, total?.unknown)], ['Weakest hour, of 5 calls or more', weakest && `${WEEKDAYS[weakest.weekday - 1]} ${hourSpan(weakest.hour)}, ${amount(weakest.answered)} of ${amount(weakest.calls)}`], zoneOf(summary, weakest),
        previous({ summary, then }, ({ answered, calls }) => percent(answered / calls))],
      sum: rate === undefined ? undefined : `${percent(rate)} = ${amount(total.answered)} answered ÷ ${amount(total.calls)} ${total.calls === 1 ? 'call' : 'calls'}`,
      say: [target && rate !== undefined && goal(sharePercent(target), rate >= target, `${amount(short)} more answered ${short === 1 ? 'call' : 'calls'} would reach it`), 'If calls hold steady and this falls, look for the hours in Calls by Hour.'],
      links: [toMissed(), byHours(), docs('Call Results', 'calls.md#call-results')] }
  },
  more: (data) => lastPeriods(data ?? {}, ({ answered, calls }) => answered / calls, percent),
}
DETAILS['calls.missed'] = {
  now({ summary } = {}) {
    const { total, closed, cells } = summary ?? {}
    const lost = total && total.missed + total.voicemail
    const after = closed ? closed.missed + closed.voicemail : undefined
    const hour = peak(sumOf(cells, (cell) => cell.hour, 24, 'missed', 'voicemail'))
    return { title: 'Missed', value: counted(lost),
      rows: [['Missed', counted(total?.missed)], ['Voicemail', counted(total?.voicemail)], ['After hours', counted(after)], ['In open hours', counted(after === undefined ? undefined : lost - after)],
        ['Returned', counted(total?.returned)], ['Called again', counted(total?.calledAgain)], ['Number withheld', counted(total?.hidden)], ['Peak hour', hour && `${hour.at.map(hourSpan).join(', ')} · ${amount(hour.most)}`], zoneOf(summary, hour)],
      sum: total?.calls > 0 ? `${percent(lost / total.calls)} = ${amount(lost)} missed ÷ ${amount(total.calls)} ${total.calls === 1 ? 'call' : 'calls'}` : undefined,
      say: ['Nobody spoke to these callers. Voicemails are counted with them.', closed ? ['In open hours', ' counts those who called while you were open.'] : undefined],
      links: [toMissed(), docs('Opening Hours', 'operations.md#opening-hours')] }
  },
}
DETAILS['calls.returned'] = {
  now({ summary, goals, limits } = {}) {
    const { total, returnedWithin } = summary ?? {}
    const lost = total && total.missed + total.voicemail
    const rate = lost > 0 ? total.returned / lost : undefined
    // The target is of those who could be called back: not those who hid their number and were not reached, nor those who got through by themselves.
    const open = total && lost - total.returned - total.calledAgain - total.hidden
    const callable = total && total.returned + open
    const target = callable > 0 ? goals?.returned : undefined
    const short = target ? Math.max(1, Math.ceil(target * callable - total.returned - 1e-9)) : 0
    return { title: 'Returned', value: rate === undefined ? undefined : percent(rate),
      rows: [['Returned', counted(total?.returned)], ['Reported, with no call', counted(total?.reported)], ['Called again', counted(total?.calledAgain)], ['Still open', counted(open)],
        ['Number withheld', counted(total?.hidden)], ['Median time to return', typeof returnedWithin === 'number' ? lasted(returnedWithin) : undefined], ['Time limit', limits?.returnHours ? `${amount(limits.returnHours)} h${limits.openHours ? ' of open hours' : ''}` : undefined]],
      sum: rate === undefined ? undefined : `${percent(rate)} = ${amount(total.returned)} returned ÷ ${amount(lost)} missed`,
      say: [target && goal(`${sharePercent(target)} of those who could be called back`, total.returned / callable >= target, `${amount(total.returned)} of ${amount(callable)} were returned, and ${amount(short)} more would reach it`), 'Not compared with the days before: the newest callers have had less time to be reached.'],
      links: [toPart('Awaiting Callback', 'calls-missed'), docs('Missed Callers', 'operations.md#missed-callers')] }
  },
}
DETAILS['calls.awaiting'] = {
  now({ open, goals, limits } = {}) {
    const calls = open?.calls ?? []
    const more = open?.next !== null && open?.next !== undefined
    // The list is oldest first. Where there is another page, a count is of those listed, unless the last of them is not counted: then none after it is either.
    const some = (holds, first = false) => (open ? `${amount(calls.filter(holds).length)}${more && !(first && calls.length > 0 && !holds(calls.at(-1))) ? ` of the first ${amount(calls.length)}` : ''}` : undefined)
    const over = (hours) => (call) => open.at - call.at > hours * 3600000
    const target = goals?.callbackHours
    const oldest = calls[0]
    return { title: 'Awaiting callback', value: open ? `${amount(calls.length)}${more ? '+' : ''}` : undefined,
      rows: [['Awaiting callback', open ? `${amount(calls.length)}${more ? ' or more' : ''}` : undefined], ['Oldest', oldest && `${moment(oldest.at)} · ${lasted(open.at - oldest.at)} ago`],
        // In open hours the page cannot tell, so it does not.
        [`Past the limit of ${limits?.returnHours} h`, limits?.returnHours && !limits.openHours ? some(over(limits.returnHours), true) : undefined],
        ['Voicemail', some(({ state }) => state === 'voicemail')], ['Tried already', some(({ attempts }) => attempts > 0)], ['Credited to a source', some(({ source }) => source)]],
      say: [target && calls.length > 0 && goal(`${amount(target)} h by the clock`, !over(target)(oldest), `${some(over(target), true)} ${calls.filter(over(target)).length === 1 ? 'has' : 'have'} waited longer`), 'Callers who withheld their number cannot be called back and are not here.'],
      links: [toMissed()] }
  },
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
  const facts = { summary, then, open, goals, limits }
  const about = (key, label) => detail(`calls.${key}`, { label, of: () => facts })
  if (total.calls > 0) top.append(tiles(
    [term('Inbound calls', 'inbound'), amount(total.calls), '', '', { change: against(total.calls, then.calls, amount), detail: about('inbound', `Inbound calls, ${amount(total.calls)}`), bars: shape(byHour('calls'), 'Calls by starting hour') }],
    [term('Answered', summary.expected ? 'answered' : 'answeredLength'), percent(total.answered / total.calls), `${amount(total.answered)} of ${amount(total.calls)}`, '', { change: against(part(total.answered, total.calls), part(then.answered, then.calls), percent, 'up', true), detail: about('answered', `Answered, ${percent(total.answered / total.calls)}`) }],
    [term('Missed', 'missed'), amount(lost), `${percent(lost / total.calls)}${summary.closed ? ` · ${amount(summary.closed.missed + summary.closed.voicemail)} after hours` : ''}`, '', { change: against(lost, lostThen, amount, 'down'), detail: about('missed', `Missed, ${amount(lost)}`), bars: shape(byHour('missed').map((n, hour) => n + byHour('voicemail')[hour]), 'Missed calls by starting hour') }],
    lost > 0 && [term('Returned', 'returned'), percent(total.returned / lost), `${amount(total.returned)} of ${amount(lost)}${summary.returnedWithin === null ? '' : ` · median ${lasted(summary.returnedWithin)}`}`, '', { detail: about('returned', `Returned, ${percent(total.returned / lost)}`) }],
    [term('Awaiting callback', 'awaiting'), `${amount(open.calls.length)}${open.next === null ? '' : '+'}`, open.calls[0] ? el('span', {}, 'Oldest ', reviewDisplay.time(open.calls[0].at, open.at)) : '', open.calls.length > 0 ? 'apart' : 'same', { detail: about('awaiting', `Awaiting callback, ${amount(open.calls.length)}${open.next === null ? '' : '+'}`) }]))
  const queue = open.calls.length > 0 ? missedCalls(open.calls, open.at) : undefined
  box.append(el('section', { id: 'calls-missed', tabindex: -1 }, el('h2', {}, 'Missed calls'),
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
      ['Returned', total.returned, lost, [summary.returnedWithin !== null && `Median ${lasted(summary.returnedWithin)}`, total.reported > 0 && `${amount(total.reported)} reported by another system`].filter(Boolean).join(' · ')],
      ['Called again', total.calledAgain, lost, 'Caller got through later'],
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
  box.append(el('section', { id: 'calls-hours', tabindex: -1 }, reviewDisplay.section(term('Calls by hour', 'heat'), pick), grid))
}, { every: 60_000 })
