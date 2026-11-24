const WHAT = { arrival: 'Arrived', seen: 'Seen', call: 'Call', step: 'Step', value: 'Value changed', consent: 'Consent', decision: 'Decision' }
const SENT = { held: 'held until a call result comes', pending: 'waiting to be sent to', sent: 'sent to', skipped: 'not sent to', failed: 'refused by' }
const CLICKS = [['gclid', 'Google ad click'], ['gbraid', 'Google ad click'], ['wbraid', 'Google ad click'], ['fbclid', 'Meta click id'], ['msclkid', 'Microsoft ad click'], ['ttclid', 'TikTok ad click']]
const worthOf = (value, currency) => `${money(value)}${currency ? ` ${currency}` : ''}`

/** What happened, in words, with the rest of it on lines below. */
function told(entry) {
  const more = (...text) => el('span', { class: 'reason' }, ...text)
  const facts = (...text) => text.some(Boolean) ? more(text.filter(Boolean).join(' · ')) : ''
  const tags = (values, rename = (name) => name) => {
    const chips = Object.entries(values ?? {}).map(([name, value]) => reviewDisplay.chip(`${rename(name)}: ${value}`, `tag ${toneOf(name)}`))
    return chips.length ? el('span', { class: 'entry-tags' }, ...chips) : ''
  }
  const words = (name) => name.replaceAll('_', ' ')
  if (entry.kind === 'arrival') {
    const { touch } = entry
    const click = CLICKS.find(([field]) => touch[field])
    return ['From ', sourced(entry.source), `${touch.campaign || touch.campaignId ? `, ${touch.campaign || touch.campaignId}` : ''}. `,
      click || touch.medium ? reviewDisplay.chip(click ? click[1] : touch.medium, 'muted') : '',
      facts(touch.landing && (touch.landing.startsWith('tel:') ? 'filed under the number that was rung' : `landed on ${touch.landing}`),
        touch.term && `searched ${touch.term}`),
      tags(touch.custom)]
  }
  if (entry.kind === 'seen') {
    const kinds = new Map()
    for (const identifier of entry.identifiers) kinds.set(identifier.split(':')[0], (kinds.get(identifier.split(':')[0]) ?? 0) + 1)
    return [entry.event ? entry.event.replaceAll('_', ' ') : 'seen', more(`with ${[...kinds].map(([kind, count]) => (count > 1 ? `${kind} (${count})` : kind)).join(', ')}`)]
  }
  if (entry.kind === 'call') {
    const { call, state, followUp } = entry
    const how = { answered: 'answered by a person', missed: 'missed', voicemail: 'went to voicemail', waiting: 'waiting for a result', unknown: 'not known whether anyone answered' }[state] ?? 'not known whether anyone answered'
    const after = followUp && { open: 'not returned yet', returned: `returned after ${lasted(followUp.delay)}${followUp.told ? ', as your own system reported' : ''}`, 'tried again': `rang again and got through after ${lasted(followUp.delay)}`, hidden: 'hid their number, so it cannot be returned' }[followUp.state]
    return [call.direction === 'outbound' ? 'Outbound ' : 'Inbound ', reviewDisplay.chip(how[0].toUpperCase() + how.slice(1), reviewDisplay.callTone(state)), notLead(entry.notLead),
      facts(after && `${after}${followUp.attempts > 0 ? `, tried ${amount(followUp.attempts)} ${followUp.attempts === 1 ? 'time' : 'times'}` : ''}`,
        call.duration === undefined ? 'length not recorded' : `${amount(Math.round(call.duration))} s`,
        call.result?.waited === undefined ? '' : `waited ${amount(Math.round(call.result.waited))} s`,
        call.visitor && (call.flags.includes('pool') ? 'on the number shown to them' : 'followed a tap')),
      tags(call.tags, words)]
  }
  if (entry.kind === 'step') {
    const { outcome, first, sent } = entry
    const began = first === null || first.at === 0 ? 'first value not recorded' : `first recorded at ${worthOf(first.value, first.currency)}`
    return [el('b', {}, outcome.stage), `, worth ${worthOf(outcome.value, outcome.currency)} now`, notLead(entry.notLead),
      first && first.at > 0 && first.value === outcome.value && first.currency === outcome.currency ? '' : el('span', { class: 'meta' }, ` · ${began}`),
      tags(outcome.tags, words),
      ...(sent.length > 0 ? sent.map((job) => more(el('span', { class: job.state === 'failed' ? 'apart' : '' }, `${SENT[job.state]} ${job.state === 'held' ? 'for ' : ''}${job.target}`), job.note ? `: ${words(job.note)}` : '')) : [more('not sent to any ad platform')])]
  }
  if (entry.kind === 'value') return [`${entry.stage}: from ${worthOf(entry.from.value, entry.from.currency)} to ${worthOf(entry.to.value, entry.to.currency)}`, el('span', { class: 'meta' }, entry.to.kind ? ` · ${entry.to.value > entry.from.value ? 'taken back: ' : ''}${entry.to.kind === 'refund' ? 'refunded' : 'written off'} · written down then` : ' · written down then')]
  if (entry.kind === 'consent') return [`Measuring ads ${entry.answer.adUserData ? 'granted' : 'denied'}, personalizing ${entry.answer.adPersonalization ? 'granted' : 'denied'}`, more(entry.answer.source ?? 'where is not recorded')]
  const { decision } = entry
  return [`${ACTIONS[decision.action] ?? decision.action} ${decision.about.join(' · ')}`, more('by ', author(decision.by), decision.reason ? `: ${decision.reason}` : '')]
}

/** Whose it is, and why that is this person. */
function why(entry, ties, subject) {
  const tie = ties[entry.subject]
  if (tie.how === 'self') return [el('span', { class: 'muted' }, 'this subject')]
  const steps = tie.via.filter((each) => each !== subject)
  const chain = steps.length > 0 ? `, through ${steps.join(', then ')}` : ''
  return [caller(entry.subject), el('span', { class: 'reason' }, `${tie.how === 'cluster' ? 'same person' : 'strong tie, in another cluster'}${tie.score === null ? ', no path scored' : `, ${percent(tie.score)}`}${tie.kinds.length > 0 ? ` by ${tie.kinds.join(' and ')}` : ''}${chain}`)]
}

const dayOf = (at) => (at > 0 ? new Date(at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'Date not recorded')
/** Keep the day's events together without making people pan to read a line. */
function byDay(entries, draw) {
  const days = []
  let list
  for (const [i, entry] of entries.entries()) {
    if (i === 0 || dayOf(entry.at) !== dayOf(entries[i - 1].at)) {
      list = el('ol', { role: 'list' })
      days.push(el('li', { class: 'day' }, el('h3', {}, dayOf(entry.at)), list))
    }
    list.append(draw(entry))
  }
  return days
}
const row = (ties, subject, lines) => (entry) => {
  const date = entry.at > 0 ? new Date(entry.at) : null
  const exact = date?.toISOString()
  const time = date ? el('time', { datetime: exact, title: `${when(entry.at)} · ${exact}` }, date.toLocaleTimeString(undefined, { timeStyle: 'short' })) : unrecorded()
  const line = el('li', { class: 'timeline-entry' }, el('span', { class: 'num' }, time),
    el('span', {}, el('span', { class: `chip kind ${entry.kind}` }, glyph(entry.kind), WHAT[entry.kind])),
    el('div', { class: 'what' }, ...told(entry)), el('div', { class: 'why' }, ...why(entry, ties, subject)))
  lines.set(entry, line)
  return line
}
const timespan = (entries) => {
  const times = entries.map((entry) => entry.at).filter((at) => at > 0)
  if (times.length === 0) return []
  const [first, last] = [Math.min(...times), Math.max(...times)]
  return [['First entry', reviewDisplay.time(first)], ['Last entry', reviewDisplay.time(last), last > first ? `${lasted(last - first)} after the first` : '']]
}
/** How the chart was left, so a refresh draws it the same. */
const charted = { subject: undefined, zoom: 'All', at: undefined, left: undefined }
const DAYS = 86400000
/** How much time fits about 700 points at each zoom. */
const ZOOMS = { All: 0, Month: 30 * DAYS, Week: 7 * DAYS, Day: DAYS }
const GLYPHS = {
  arrival: 'M-5 4L5 0L-5 -4L-2.5 0Z', seen: 'M-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z', call: 'M-5-3.5h10v7h-10Z', step: 'M0-6L6 0L0 6L-6 0Z', value: 'M0-4.5L4.5 0L0 4.5L-4.5 0Z',
  consent: 'M-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0Z', decision: 'M-4.5 6V-6H5L2.5-2.5L5 1H-2.5V6Z',
}
const glyph = (kind) => svg('svg', { class: `glyph ${kind}`, viewBox: '-8 -8 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: GLYPHS[kind] }))
/** What to call a mark: what it is, in a few words, and when. */
const named = (entry) => `${WHAT[entry.kind]}, ${when(entry.at)}`

/** The lines that rule the chart: each a time and what it is called, far enough apart to read. */
function rules(from, to, perMs) {
  const steps = [[3600000, 'hour'], [6 * 3600000, 'hour'], [DAYS, 'day'], [7 * DAYS, 'day'], [30 * DAYS, 'month'], [91 * DAYS, 'month'], [365 * DAYS, 'year']]
  const [size, unit] = steps.find(([ms]) => ms * perMs >= 64) ?? steps.at(-1)
  const at = new Date(from)
  if (unit === 'hour') at.setHours(0, 0, 0, 0)
  else if (unit === 'day') {
    at.setHours(0, 0, 0, 0)
    if (size > DAYS) at.setDate(at.getDate() - ((at.getDay() + 6) % 7))
  } else at.setMonth(unit === 'year' ? 0 : size > 31 * DAYS ? at.getMonth() - (at.getMonth() % 3) : at.getMonth(), 1), at.setHours(0, 0, 0, 0)
  const out = []
  // Moved on by the calendar, so a day on which the clocks change is still one day.
  for (; at.getTime() <= to && out.length < 2000;) {
    out.push({ at: at.getTime(), text: at.toLocaleString(undefined, unit === 'hour' ? { hour: 'numeric' } : unit === 'day' ? { day: 'numeric' } : unit === 'month' ? { month: 'short' } : { year: 'numeric' }),
      over: unit === 'hour' ? at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : unit === 'day' ? at.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : unit === 'month' ? String(at.getFullYear()) : '' })
    if (unit === 'hour') at.setHours(at.getHours() + size / 3600000)
    else if (unit === 'day') at.setDate(at.getDate() + size / DAYS)
    else if (unit === 'month') at.setMonth(at.getMonth() + (size > 31 * DAYS ? 3 : 1))
    else at.setFullYear(at.getFullYear() + 1)
  }
  return out
}

/**
 * The journey over time: a lane a kind, the calendar over it, and a line at
 * now. A mark opens what it was beside the chart. The list under it says the
 * same, in order.
 */
function chart(entries, shown, ties, subject, show) {
  const dated = shown.filter((entry) => entry.at > 0)
  const times = entries.map((entry) => entry.at).filter((at) => at > 0)
  if (dated.length === 0 || times.length === 0) return ''
  if (charted.subject !== subject) Object.assign(charted, { subject, zoom: 'All', at: undefined, left: undefined })
  const [first, last] = [Math.min(...times), Math.max(...dated.map((entry) => entry.at + spanOf(entry)), ...times)]
  const now = Date.now()
  // Now is on the chart when it is not far past the last of them; else it would be mostly empty.
  const until = now - last < (last - first) * 0.35 ? Math.max(last, now) : last
  const room = Math.max((until - first) * 0.06, 3600000)
  const [from, to] = [first - room, until + room]
  const kinds = Object.keys(WHAT).filter((kind) => dated.some((entry) => entry.kind === kind))
  const names = el('div', { class: 'names' }, el('div', { class: 'ruler' }), ...kinds.map((kind) => el('div', { class: 'name' }, glyph(kind), el('span', {}, WHAT[kind]), el('span', { class: 'count' }, amount(dated.filter((entry) => entry.kind === kind).length)))))
  const canvas = el('div', { class: 'canvas' })
  const track = el('div', { class: 'track', tabindex: 0, role: 'group', 'aria-label': 'Journey over time' }, canvas)
  const card = el('div', { class: 'told', role: 'region', 'aria-label': 'What is picked', hidden: '' })
  const zooming = el('div', { class: 'segments', role: 'group', 'aria-label': 'How much at once' })
  const root = el('div', { class: 'chart' }, el('div', { class: 'chart-head' }, zooming, el('span', { class: 'meta' }, `${reviewDisplay.time(first).textContent} – ${reviewDisplay.time(last).textContent}`)), el('div', { class: 'chart-body' }, names, track, card))
  const order = [...dated].sort((x, y) => x.at - y.at)
  const marks = new Map()
  let perMs = 0

  function pick(entry, focus) {
    charted.at = entry && order.indexOf(entry)
    for (const [each, mark] of marks) mark.setAttribute('aria-pressed', String(each === entry))
    card.hidden = entry === undefined
    root.classList.toggle('picked', entry !== undefined)
    if (!entry) return
    const i = order.indexOf(entry)
    const turn = (step, text, label) => el('button', { type: 'button', 'aria-label': label, 'data-key': label, ...((order[i + step] === undefined) && { disabled: '' }), on: { click: () => { pick(order[i + step]); reach(order[i + step]) } } }, text)
    card.replaceChildren(el('div', { class: 'told-head' }, el('span', { class: `chip kind ${entry.kind}` }, glyph(entry.kind), WHAT[entry.kind]), el('span', { class: 'meta' }, `${amount(i + 1)} of ${amount(order.length)}`), turn(-1, '‹', 'The one before'), turn(1, '›', 'The one after'), el('button', { type: 'button', class: 'shut', 'aria-label': 'Close', on: { click: () => { pick(); marks.get(entry)?.focus({ preventScroll: true }) } } }, '×')),
      el('p', { class: 'told-when' }, el('b', {}, new Date(entry.at).toLocaleTimeString(undefined, { timeStyle: 'short' })), ` ${dayOf(entry.at)}`),
      el('div', { class: 'what' }, ...told(entry)), el('p', { class: 'told-on' }, ...why(entry, ties, subject)),
      el('button', { type: 'button', on: { click: () => show(entry) } }, 'Show in the list'))
    if (focus) marks.get(entry)?.focus({ preventScroll: true })
  }
  /** Scrolls a mark into view, without moving the page. */
  function reach(entry) {
    const x = (entry.at - from) * perMs
    if (x < track.scrollLeft + 40 || x > track.scrollLeft + track.clientWidth - 40) track.scrollTo({ left: x - track.clientWidth / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  function draw() {
    const wide = track.clientWidth
    if (wide === 0) return
    const fit = wide / (to - from)
    perMs = charted.zoom === 'All' ? fit : Math.max(fit, 700 / ZOOMS[charted.zoom])
    canvas.style.width = `${Math.round((to - from) * perMs)}px`
    const at = (time) => `${((time - from) * perMs).toFixed(1)}px`
    const ruler = el('div', { class: 'ruler' })
    const grid = el('div', { class: 'grid', 'aria-hidden': 'true' })
    let over
    const ruled = rules(from, to, perMs)
    const inside = ruled.filter((rule) => rule.at >= from)
    // What the left edge is in, when its own line is off to the left.
    const before = ruled.findLast((rule) => rule.at < from)
    if (before && (inside.length === 0 || (inside[0].at - from) * perMs > 90)) {
      ruler.append(el('span', { class: 'tick edge' }, el('b', {}, before.over || before.text)))
      over = before.over
    }
    // Kept whole at the right edge, and given room: no number is drawn under it.
    const pin = now >= from && now <= to ? Math.min((now - from) * perMs, (to - from) * perMs - 26) : NaN
    for (const rule of inside) {
      const left = (rule.at - from) * perMs
      const covered = left + 34 > pin - 24 && left < pin + 24
      const tick = el('span', { class: 'tick' }, rule.over === over ? '' : el('b', {}, rule.over), el('span', covered ? { class: 'sr-only' } : {}, rule.text))
      over = rule.over
      const line = el('i')
      tick.style.left = line.style.left = at(rule.at)
      ruler.append(tick)
      grid.append(line)
    }
    // Days no one works, when a day is wide enough to see.
    if (DAYS * perMs > 14) for (const day = new Date(from); day.getTime() < to; day.setDate(day.getDate() + 1)) {
      day.setHours(0, 0, 0, 0)
      if (day.getDay() % 6 !== 0) continue
      const shade = el('i', { class: 'weekend' })
      shade.style.left = at(Math.max(from, day.getTime()))
      shade.style.width = `${DAYS * perMs}px`
      grid.append(shade)
    }
    if (now >= from && now <= to) {
      const line = el('i', { class: 'now' })
      const pill = el('span', { class: 'today' }, 'Now')
      line.style.left = at(now)
      pill.style.left = `${pin.toFixed(1)}px`
      grid.append(line)
      ruler.append(pill)
    }
    marks.clear()
    const lanes = kinds.map((kind) => {
      const lane = el('div', { class: `lane ${kind}` })
      let heap
      for (const entry of order) if (entry.kind === kind) {
        const x = (entry.at - from) * perMs
        const long = spanOf(entry) * perMs
        // Too near the one before to press either: they are one mark with how many, and a press comes closer.
        if (heap && x - heap.x < 18 && charted.zoom !== 'Day') {
          heap.list.push(entry)
          heap.mark.classList.add('heap')
          heap.mark.replaceChildren(el('span', {}, amount(heap.list.length)))
          heap.mark.setAttribute('aria-label', `${amount(heap.list.length)} of ${WHAT[kind]}, from ${when(heap.list[0].at)}`)
          marks.set(entry, heap.mark)
          continue
        }
        const list = [entry]
        const mark = el('button', { type: 'button', class: `mark${long > 14 ? ' long' : ''}${entry.state === 'missed' || entry.state === 'voicemail' ? ' missed' : ''}`, 'aria-label': named(entry), title: named(entry), 'aria-pressed': 'false', on: { click: () => {
          if (list.length === 1) return pick(list[0])
          const closer = Object.keys(ZOOMS)
          charted.zoom = closer[Math.min(closer.length - 1, closer.indexOf(charted.zoom) + 1)]
          charted.left = list[0].at
          draw()
        } } }, long > 14 ? '' : glyph(kind))
        mark.style.left = at(entry.at)
        if (long > 14) mark.style.width = `${long.toFixed(1)}px`
        lane.append(mark)
        // From a missed call to when it was returned.
        if (entry.followUp?.delay > 0) {
          const wait = el('i', { class: 'wait', title: `${entry.followUp.state} after ${lasted(entry.followUp.delay)}` })
          wait.style.left = at(entry.at)
          wait.style.width = `${(entry.followUp.delay * perMs).toFixed(1)}px`
          lane.prepend(wait)
        }
        marks.set(entry, mark)
        heap = { x, list, mark }
      }
      return lane
    })
    canvas.replaceChildren(ruler, grid, ...lanes)
    zooming.replaceChildren(...Object.entries(ZOOMS).filter(([name, ms]) => name === 'All' || (700 / ms > fit && (to - from) * (700 / ms) < 120000)).map(([name]) => el('button', { type: 'button', 'aria-pressed': String(name === charted.zoom), 'data-key': `zoom ${name}`, on: { click: () => {
      // Closer is closer to something: whoever is picked, or the mark nearest the middle.
      const middle = from + (track.scrollLeft + track.clientWidth / 2) / perMs
      charted.left = (order[charted.at] ?? order.reduce((best, each) => (Math.abs(each.at - middle) < Math.abs(best.at - middle) ? each : best))).at
      charted.zoom = name
      draw()
    } } }, name)))
    track.scrollLeft = (((charted.left ?? until) - from) * perMs) - track.clientWidth / 2
    pick(order[charted.at])
  }
  track.addEventListener('scroll', () => { if (perMs) charted.left = from + (track.scrollLeft + track.clientWidth / 2) / perMs })
  track.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key]
    if (event.key === 'Escape') return pick()
    if (!step || !event.target.classList.contains('mark')) return
    event.preventDefault()
    const next = order[(charted.at ?? [...marks].findIndex(([, mark]) => mark === event.target)) + step]
    if (next) { pick(next, true); reach(next) }
  })
  new ResizeObserver(() => draw()).observe(track)
  return root
}
/** Said to be nobody's inquiry, so it is in no count. */
const notLead = (kind) => (kind ? reviewDisplay.chip(kind === 'spam' ? 'Spam, not counted' : 'No lead, not counted') : '')
/** How long a thing lasted, when that is known. */
const spanOf = (entry) => (entry.kind === 'call' && entry.call.duration > 0 ? entry.call.duration * 1000 : 0)
// Kinds left out of the list, kept while the screen is open.
const leaving = new Set()

// One person's timeline, across every subject that is them.
view('journey', 'Journey', async (box, subject) => {
  if (!subject) {
    box.append(el('section', {}, reviewDisplay.heading('Journey'), el('div', { class: 'opening' }, el('h4', {}, 'Whose journey?'), el('button', { class: 'primary', on: { click: () => palette.show() } }, 'Find someone'),
      ...(opened.length > 0 ? [el('div', { class: 'row' }, el('span', { class: 'meta' }, 'Opened here'), ...opened.slice(0, 5).map((each) => el('a', { class: 'who-chip', href: `#/journey/${encodeURIComponent(each)}`, title: each }, badge(each), reviewDisplay.idText(each))))] : []))))
    return
  }
  const journey = await api('GET', `/journey?subject=${encodeURIComponent(subject)}`)
  const top = el('section', {}, reviewDisplay.heading(reviewDisplay.id(subject, true), el('a', { class: 'button', href: subjectHash(subject) }, 'Account')))
  box.append(top)
  if (journey.entries.length === 0) {
    top.append(el('p', { class: 'muted' }, 'No events recorded for this subject.'))
    return
  }
  const subjects = Object.keys(journey.ties)
  const strip = el('div', {})
  top.append(strip, journey.more > 0 ? el('p', { class: 'muted' }, `${amount(journey.more)} more subjects of theirs are not read.`) : '')
  let entries = journey.entries
  let next = journey.next
  const ties = { ...journey.ties }
  const timeline = el('div', { class: 'wide timeline', tabindex: 0, role: 'region', 'aria-label': 'Journey' })
  const lines = new Map()
  /** Brings a line of the list into view, and marks it for a moment. */
  const find = (entry) => {
    const line = lines.get(entry)
    line?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    line?.classList.add('found')
    setTimeout(() => line?.classList.remove('found'), 1600)
  }
  const draw = () => {
    lines.clear()
    const shown = entries.filter((entry) => !leaving.has(entry.kind))
    strip.replaceChildren(tiles(['Entries loaded', amount(entries.length), next === null ? '' : 'Earlier entries available'], ['Subjects read', amount(subjects.length)], ...timespan(entries)), chart(entries, shown, ties, subject, find))
    timeline.replaceChildren(shown.length > 0
      ? el('ol', { class: 'journey', role: 'list' }, ...byDay(shown, row(ties, subject, lines)))
      : el('p', { class: 'timeline-entry muted' }, 'Select an event type to show its entries.'))
  }
  const kinds = el('div', { class: 'row filters', role: 'group', 'aria-label': 'Show' })
  const boxes = () => kinds.replaceChildren(...Object.keys(WHAT).filter((kind) => entries.some((entry) => entry.kind === kind)).map((kind) => {
    const check = el('input', { type: 'checkbox', ...(!leaving.has(kind) && { checked: '' }), on: { change: () => { if (check.checked) leaving.delete(kind); else leaving.add(kind); draw() } } })
    return el('label', {}, check, glyph(kind), WHAT[kind], el('span', { class: 'count' }, amount(entries.filter((entry) => entry.kind === kind).length)))
  }))
  boxes()
  draw()
  const earlier = el('button', { on: { click: async () => {
    if (opening) return
    const turn = ++loading
    pending += 1
    earlier.disabled = true
    try {
      const page = await api('GET', `/journey?subject=${encodeURIComponent(subject)}&before=${next}`)
      if (turn !== loading) return
      entries = [...page.entries, ...entries]
      Object.assign(ties, page.ties)
      next = page.next
      browsing = true
      earlier.hidden = next === null
      boxes()
      draw()
    } catch (error) {
      notice(error.message, true)
    } finally {
      pending -= 1
      earlier.disabled = false
    }
  } } }, 'Show earlier')
  earlier.hidden = next === null
  box.append(el('section', {}, reviewDisplay.section('Timeline', earlier), kinds, timeline))
}, { every: 60_000, subject: true })
