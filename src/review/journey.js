const WHAT = { arrival: 'Arrived', seen: 'Seen', call: 'Call', step: 'Step', value: 'Value changed', consent: 'Consent', decision: 'Decision' }
const SENT = { held: 'held until a call result comes', pending: 'waiting to be sent to', sent: 'sent to', skipped: 'not sent to', failed: 'refused by' }
const CLICKS = [['gclid', 'Google ad click'], ['gbraid', 'Google ad click'], ['wbraid', 'Google ad click'], ['fbclid', 'Meta click id'], ['msclkid', 'Microsoft ad click'], ['ttclid', 'TikTok ad click']]
const worthOf = (value, currency) => `${money(value)}${currency ? ` ${currency}` : ''}`

/** What happened, in words, with the rest of it on lines below. */
function told(entry) {
  const more = (...text) => el('span', { class: 'reason' }, ...text)
  if (entry.kind === 'arrival') {
    const { touch } = entry
    const click = CLICKS.find(([field]) => touch[field])
    return [`From ${entry.source}${touch.campaign || touch.campaignId ? `, ${touch.campaign || touch.campaignId}` : ''}. `, click ? el('span', { class: 'chip' }, click[1]) : touch.medium ? el('span', { class: 'chip' }, touch.medium) : '',
      touch.landing ? more(touch.landing.startsWith('tel:') ? 'filed under the number that was rung' : `landed on ${touch.landing}`) : '', touch.term ? more(`searched ${touch.term}`) : '',
      ...Object.entries(touch.custom ?? {}).map(([name, value]) => more(`${name}: ${value}`))]
  }
  if (entry.kind === 'seen') {
    const kinds = new Map()
    for (const identifier of entry.identifiers) kinds.set(identifier.split(':')[0], (kinds.get(identifier.split(':')[0]) ?? 0) + 1)
    return [entry.event ? entry.event.replaceAll('_', ' ') : 'seen', more(`with ${[...kinds].map(([kind, count]) => (count > 1 ? `${kind} (${count})` : kind)).join(', ')}`)]
  }
  if (entry.kind === 'call') {
    const { call, state, followUp } = entry
    const how = { answered: 'answered by a person', missed: 'missed', voicemail: 'went to voicemail', waiting: 'waiting for a result', unknown: 'not known whether anyone answered' }[state]
    const after = followUp && { open: 'not returned yet', returned: `returned after ${lasted(followUp.delay)}`, 'tried again': `rang again and got through after ${lasted(followUp.delay)}`, hidden: 'hid their number, so it cannot be returned' }[followUp.state]
    return [call.direction === 'outbound' ? 'Outbound ' : 'Inbound ', reviewDisplay.chip(how[0].toUpperCase() + how.slice(1), reviewDisplay.callTone(state)),
      after ? more(`${after}${followUp.attempts > 0 ? `, tried ${amount(followUp.attempts)} ${followUp.attempts === 1 ? 'time' : 'times'}` : ''}`) : '',
      more([call.duration === undefined ? 'length not recorded' : `${amount(Math.round(call.duration))} s`, call.result?.waited === undefined ? '' : `waited ${amount(Math.round(call.result.waited))} s`, call.visitor ? (call.flags.includes('pool') ? 'on the number shown to them' : 'followed a tap') : ''].filter(Boolean).join(', ')),
      ...Object.entries(call.tags ?? {}).map(([name, value]) => more(`${name.replaceAll('_', ' ')}: ${value}`))]
  }
  if (entry.kind === 'step') {
    const { outcome, first, sent } = entry
    const began = first === null || first.at === 0 ? 'first value not recorded' : `first recorded at ${worthOf(first.value, first.currency)}`
    return [el('b', {}, outcome.stage), `, worth ${worthOf(outcome.value, outcome.currency)} now`, first && first.at > 0 && first.value === outcome.value ? '' : more(began),
      ...Object.entries(outcome.tags ?? {}).map(([name, value]) => more(`${name.replaceAll('_', ' ')}: ${value}`)),
      ...(sent.length > 0 ? sent.map((job) => more(el('span', { class: job.state === 'failed' ? 'apart' : '' }, `${SENT[job.state]} ${job.target}`), job.note ? `: ${job.note.replaceAll('_', ' ')}` : '')) : [more('not sent to any ad platform')])]
  }
  if (entry.kind === 'value') return [`${entry.stage}: ${worthOf(entry.from.value, entry.from.currency)} → ${worthOf(entry.to.value, entry.to.currency)}`]
  if (entry.kind === 'consent') return [`Measuring ads ${entry.answer.adUserData ? 'granted' : 'denied'}, personalizing ${entry.answer.adPersonalization ? 'granted' : 'denied'}`, more(entry.answer.source ?? 'where is not recorded')]
  const { decision } = entry
  return [`${ACTIONS[decision.action] ?? decision.action} `, ...decision.about.map((each) => more(each)), more('by ', author(decision.by), decision.reason ? `: ${decision.reason}` : '')]
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
const row = (ties, subject) => (entry) => {
  const date = entry.at > 0 ? new Date(entry.at) : null
  const exact = date?.toISOString()
  const time = date ? el('time', { datetime: exact, title: `${when(entry.at)} · ${exact}` }, date.toLocaleTimeString(undefined, { timeStyle: 'short' })) : unrecorded()
  return el('li', { class: 'timeline-entry' }, el('span', { class: 'num' }, time),
    el('span', {}, el('span', { class: `chip kind ${entry.kind}` }, WHAT[entry.kind])),
    el('div', { class: 'what' }, ...told(entry)), el('div', { class: 'why' }, ...why(entry, ties, subject)))
}
const timespan = (entries) => {
  const times = entries.map((entry) => entry.at).filter((at) => at > 0)
  if (times.length === 0) return []
  const [first, last] = [Math.min(...times), Math.max(...times)]
  return [['First entry', reviewDisplay.time(first)], ['Last entry', reviewDisplay.time(last), last > first ? `${lasted(last - first)} after the first` : '']]
}
/** When each kind of thing happened, one lane a kind, so a gap or a burst shows before the list is read. The list says the same in words. */
function lanes(entries, shown) {
  const dated = shown.filter((entry) => entry.at > 0)
  const kinds = Object.keys(WHAT).filter((kind) => dated.some((entry) => entry.kind === kind))
  // The whole span, whatever is left out, so the dots stay under the first and last told above them.
  const times = entries.map((entry) => entry.at).filter((at) => at > 0)
  const [first, last] = [Math.min(...times), Math.max(...times)]
  if (dated.length === 0 || first === last) return ''
  const drawing = el('div', { class: 'lanes', 'aria-hidden': 'true' })
  for (const kind of kinds) {
    const lane = el('div', { class: 'lane' })
    for (const entry of dated) if (entry.kind === kind) {
      const dot = el('i', { class: kind })
      dot.style.left = `${(100 * (entry.at - first)) / (last - first)}%`
      lane.append(dot)
    }
    drawing.append(el('span', {}, WHAT[kind]), lane)
  }
  return drawing
}
// Kinds left out of the list, kept while the screen is open.
const leaving = new Set()

// One person's timeline, across every subject that is them.
view('journey', 'Journey', async (box, subject) => {
  if (!subject) {
    box.append(el('section', {}, reviewDisplay.heading('Journey'), el('p', { class: 'muted' }, 'Use Find to open a subject.')))
    return
  }
  const journey = await api('GET', `/journey?subject=${encodeURIComponent(subject)}`)
  const top = el('section', {}, reviewDisplay.heading(reviewDisplay.id(subject), el('a', { class: 'link', href: subjectHash(subject) }, 'Account')))
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
  const draw = () => {
    const shown = entries.filter((entry) => !leaving.has(entry.kind))
    strip.replaceChildren(tiles(['Entries loaded', amount(entries.length), next === null ? '' : 'Earlier entries available'], ['Subjects read', amount(subjects.length)], ...timespan(entries)), lanes(entries, shown))
    timeline.replaceChildren(shown.length > 0
      ? el('ol', { class: 'journey', role: 'list' }, ...byDay(shown, row(ties, subject)))
      : el('p', { class: 'timeline-entry muted' }, 'Select an event type to show its entries.'))
  }
  const kinds = el('div', { class: 'row filters', role: 'group', 'aria-label': 'Show' })
  const boxes = () => kinds.replaceChildren(...Object.keys(WHAT).filter((kind) => entries.some((entry) => entry.kind === kind)).map((kind) => {
    const check = el('input', { type: 'checkbox', ...(!leaving.has(kind) && { checked: '' }), on: { change: () => { if (check.checked) leaving.delete(kind); else leaving.add(kind); draw() } } })
    return el('label', {}, check, `${WHAT[kind]} (${amount(entries.filter((entry) => entry.kind === kind).length)})`)
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
