const WHAT = { arrival: 'arrived', seen: 'seen', call: 'call', step: 'step', value: 'value changed', consent: 'consent', decision: 'decision' }
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
    return [call.direction === 'outbound' ? 'You rang them: ' : 'Rang you: ', el('span', { class: `chip ${state === 'answered' ? 'same' : state === 'missed' ? 'apart' : ''}` }, how),
      after ? more(`${after}${followUp.attempts > 0 ? `, tried ${amount(followUp.attempts)} ${followUp.attempts === 1 ? 'time' : 'times'}` : ''}`) : '',
      more([call.duration === undefined ? 'length not recorded' : `${amount(Math.round(call.duration))} s`, call.result?.waited === undefined ? '' : `waited ${amount(Math.round(call.result.waited))} s`, call.visitor ? 'followed a tap' : ''].filter(Boolean).join(', ')),
      ...Object.entries(call.tags ?? {}).map(([name, value]) => more(`${name.replaceAll('_', ' ')}: ${value}`))]
  }
  if (entry.kind === 'step') {
    const { outcome, first, sent } = entry
    const began = first === null || first.at === 0 ? 'first value not recorded' : `first recorded at ${worthOf(first.value, first.currency)}`
    return [el('b', {}, outcome.stage), `, worth ${worthOf(outcome.value, outcome.currency)} now`, first && first.at > 0 && first.value === outcome.value ? '' : more(began),
      ...Object.entries(outcome.tags ?? {}).map(([name, value]) => more(`${name.replaceAll('_', ' ')}: ${value}`)),
      ...(sent.length > 0 ? sent.map((job) => more(el('span', { class: job.state === 'failed' ? 'apart' : '' }, `${SENT[job.state]} ${job.target}`), job.note ? `: ${job.note.replaceAll('_', ' ')}` : '')) : [more('not sent to any ad platform')])]
  }
  if (entry.kind === 'value') return [`${entry.stage}: from ${worthOf(entry.from.value, entry.from.currency)} to ${worthOf(entry.to.value, entry.to.currency)}`, more('written down then')]
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

const dayOf = (at) => (at > 0 ? new Date(at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'When is not recorded')
/** Each day's entries under its name, so the hours read as a day and the gaps between days show. */
const byDay = (entries, draw) => entries.flatMap((entry, i) => [...(i === 0 || dayOf(entry.at) !== dayOf(entries[i - 1].at) ? [el('tr', { class: 'day' }, el('th', { scope: 'rowgroup', colspan: 4 }, dayOf(entry.at)))] : []), draw(entry)])
const row = (ties, subject) => (entry) => el('tr', {}, td('nowrap num', entry.at > 0 ? new Date(entry.at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : ''), td('', el('span', { class: `chip kind ${entry.kind}` }, WHAT[entry.kind])), td('what', ...told(entry)), td('why', ...why(entry, ties, subject)))
// Kinds left out of the list, kept while the screen is open.
const leaving = new Set()

// One person's timeline, across every subject that is them.
view('journey', 'Journey', async (box, subject) => {
  if (!subject) {
    box.append(el('section', {}, el('h3', {}, 'Journey'), el('p', { class: 'muted' }, 'Open a subject above to see everything recorded about that person, in order.')))
    return
  }
  const journey = await api('GET', `/journey?subject=${encodeURIComponent(subject)}`)
  const top = el('section', {}, el('h3', {}, subject), el('p', {}, el('a', { class: 'link', href: subjectHash(subject) }, 'Its account: ties, reasons and decisions')))
  box.append(top)
  if (journey.entries.length === 0) {
    top.append(el('p', { class: 'muted' }, 'Nothing has been recorded about this subject.'))
    return
  }
  const subjects = Object.keys(journey.ties)
  top.append(el('p', { class: 'muted' }, `Everything recorded about this person, oldest first${journey.next === null ? '' : ', newest entries'}, on ${amount(subjects.length)} ${subjects.length === 1 ? 'subject' : 'subjects'}. Each entry says which subject it is on and why that is this person.${journey.more > 0 ? ` ${amount(journey.more)} more subjects of theirs are not read.` : ''}`))
  let entries = journey.entries
  const ties = { ...journey.ties }
  const table = el('table', { class: 'journey' })
  const draw = () => table.replaceChildren(el('tr', {}, th('When', 'num'), th('What'), th('Details'), th('On, and why')), ...byDay(entries.filter((entry) => !leaving.has(entry.kind)), row(ties, subject)))
  const kinds = el('div', { class: 'row', role: 'group', 'aria-label': 'Show' })
  const boxes = () => kinds.replaceChildren(...Object.keys(WHAT).filter((kind) => entries.some((entry) => entry.kind === kind)).map((kind) => {
    const check = el('input', { type: 'checkbox', ...(!leaving.has(kind) && { checked: '' }), on: { change: () => { if (check.checked) leaving.delete(kind); else leaving.add(kind); draw() } } })
    return el('label', {}, check, `${WHAT[kind]} (${amount(entries.filter((entry) => entry.kind === kind).length)})`)
  }))
  boxes()
  draw()
  let next = journey.next
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
  box.append(el('section', {}, kinds, el('p', {}, earlier), wide('Journey', table)))
}, { every: 60_000, subject: true })
