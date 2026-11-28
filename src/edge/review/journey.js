const WHAT = { visit: 'Visit', sighting: 'Sighting', call: 'Call', text: 'Text', link: 'Link', outcome: 'Outcome', value: 'Value change', consent: 'Consent', decision: 'Decision' }
const SENT = { held: 'Held for a call result', pending: 'Queued for', sent: 'Sent to', skipped: 'Skipped for', failed: 'Rejected by' }
/** It had nothing to send the platform yet, and is tried again until it has. */
const waiting = (job) => job.state === 'pending' && job.note === 'no_match_key'
const CLICKS = [['gclid', 'Google ad click'], ['gbraid', 'Google ad click'], ['wbraid', 'Google ad click'], ['fbclid', 'Meta click id'], ['msclkid', 'Microsoft ad click'], ['ttclid', 'TikTok ad click']]
const worthOf = (value, currency) => `${money(value)}${currency ? ` ${currency}` : ''}`

/** What happened, in words, with the rest of it on lines below. `icon` opens what else is known of a call, and stands after its state. */
function told(entry, icon = '') {
  const more = (...text) => el('span', { class: 'reason' }, ...text)
  const facts = (...text) => text.some(Boolean) ? more(text.filter(Boolean).join(' · ')) : ''
  const tags = (values, rename = (name) => name) => {
    const chips = Object.entries(values ?? {}).map(([name, value]) => reviewDisplay.chip(`${rename(name)}: ${value}`, `tag ${toneOf(name)}`))
    return chips.length ? el('span', { class: 'entry-tags' }, ...chips) : ''
  }
  const words = (name) => name.replaceAll('_', ' ')
  if (entry.kind === 'visit') {
    const { touch } = entry
    const click = CLICKS.find(([field]) => touch[field])
    return [sourced(entry.source), `${touch.campaign || touch.campaignId ? ` · ${touch.campaign || touch.campaignId}` : ''} `,
      click || touch.medium ? reviewDisplay.chip(click ? click[1] : touch.medium, 'muted') : '',
      facts(touch.landing && (touch.landing.startsWith('tel:') ? 'By dialed number' : touch.landing),
        touch.term && `“${touch.term}”`),
      tags(touch.custom)]
  }
  if (entry.kind === 'sighting') {
    const kinds = new Map()
    for (const identifier of entry.identifiers) kinds.set(identifier.split(':')[0], (kinds.get(identifier.split(':')[0]) ?? 0) + 1)
    return [entry.event ? entry.event.replaceAll('_', ' ') : 'sighting', more(`${[...kinds].map(([kind, count]) => (count > 1 ? `${kind} (${count})` : kind)).join(', ')}`)]
  }
  if (entry.kind === 'call') {
    const { call, state } = entry
    // Said to be nobody's inquiry, it waits for nobody.
    const followUp = entry.notLead ? undefined : entry.followUp
    const how = { answered: 'answered', missed: 'missed', voicemail: 'voicemail', waiting: 'waiting for result', unknown: 'unknown result' }[state] ?? 'unknown result'
    const after = followUp && { open: 'Not returned', returned: `Returned after ${lasted(followUp.delay)}${followUp.reported ? (followUp.reporter ? ` (reported by ${followUp.reporter})` : ' (reported)') : ''}`, 'called again': `Called again after ${lasted(followUp.delay)}`, hidden: 'Number withheld' }[followUp.state]
    return [call.direction === 'outbound' ? 'Outbound ' : 'Inbound ', reviewDisplay.chip(how[0].toUpperCase() + how.slice(1), reviewDisplay.callTone(state)), notLead(entry.notLead), icon,
      facts(after && `${after}${followUp.attempts > 0 ? ` · ${amount(followUp.attempts)} ${followUp.attempts === 1 ? 'attempt' : 'attempts'}` : ''}`,
        call.duration === undefined ? '' : `Duration ${amount(Math.round(call.duration))} s`,
        call.result?.waited === undefined ? '' : `Wait ${amount(Math.round(call.result.waited))} s`,
        call.party ? `${call.party.role === 'representative' ? 'Representative' : 'Record holder'} confirmed by ${call.party.by}` : call.visitor && (call.flags.includes('code') ? 'Code' : call.flags.includes('pool') ? 'Tracking number' : 'Tap to call')),
      tags(call.tags, words)]
  }
  if (entry.kind === 'text') {
    const { text, reply } = entry
    const how = text.flags.includes('opt_out') ? 'Asked for no more texts' : text.flags.includes('opt_in') ? 'Asked for texts again' : ''
    const after = reply && { open: 'Not answered', stopped: 'Not answered before they asked for no more texts', replied: `Answered by ${reply.how} after ${lasted(reply.delay)}` }[reply.state]
    return [text.direction === 'outbound' ? 'Sent' : 'Received', notLead(entry.notLead), facts(how, after, text.visitor && (text.flags.includes('code') ? 'Code from the site' : 'Tap to text')), tags(text.tags, words)]
  }
  if (entry.kind === 'link') {
    const { link } = entry
    return [`Link sent${link.purpose ? ` · ${words(link.purpose)}` : ''}`, facts(link.opened === undefined ? 'Not opened' : `Opened after ${lasted(link.opened - link.at)}`, link.openings > 1 && `${amount(link.openings)} times`)]
  }
  if (entry.kind === 'outcome') {
    const { outcome, first, sent } = entry
    const began = first === null || first.at === 0 ? '' : ` · initially ${worthOf(first.value, first.currency)}`
    return [el('b', {}, outcome.stage), outcome.value === 0 ? '' : ` · ${worthOf(outcome.value, outcome.currency)}`, notLead(entry.notLead),
      first && first.at > 0 && first.value === outcome.value && first.currency === outcome.currency ? '' : el('span', { class: 'meta' }, began),
      tags(outcome.tags, words),
      ...(sent.length > 0 ? sent.map((job) => more(el('span', { class: job.state === 'failed' ? 'apart' : '' }, `${waiting(job) ? 'Waiting for an ad click for' : SENT[job.state]}${job.state === 'held' ? ' · ' : ' '}${job.target}`), job.note && !waiting(job) ? `: ${words(job.note)}` : '')) : [])]
  }
  if (entry.kind === 'value') return [el('b', {}, entry.stage), ` · from ${worthOf(entry.from.value, entry.from.currency)} to ${worthOf(entry.to.value, entry.to.currency)}`, entry.to.kind ? el('span', { class: 'meta' }, ` · ${entry.to.kind === 'refund' ? 'Refund' : 'Write-off'}${entry.to.value > entry.from.value ? ' reversed' : ''}`) : '']
  if (entry.kind === 'consent') return [`Ad measurement ${entry.answer.adUserData ? 'granted' : 'denied'} · personalization ${entry.answer.adPersonalization ? 'granted' : 'denied'}`, entry.answer.source ? more(entry.answer.source) : '']
  const { decision } = entry
  return [`${ACTIONS[decision.action] ?? decision.action} ${decision.about.map(reviewDisplay.idText).join(' · ')}`, more(author(decision.by), decision.reason ? ` · ${decision.reason}` : '')]
}

/** Why somebody is this person, in words. */
function tieWords(tie, subject) {
  if (!tie || tie.how === 'self') return ''
  const steps = tie.via.filter((each) => each !== subject)
  const chain = steps.length > 0 ? ` via ${steps.map(reviewDisplay.idText).join(' → ')}` : ''
  return `${tie.how === 'cluster' ? 'Same person' : 'High confidence'}${tie.score === null ? '' : ` · ${percent(tie.score)}`}${tie.kinds.length > 0 ? ` · ${tie.kinds.join(', ')}` : ''}${chain}`
}
/** Whose it is, and why that is this person. */
function why(entry, ties, subject) {
  const words = tieWords(ties[entry.subject], subject)
  return words ? [caller(entry.subject), el('span', { class: 'reason', title: words }, words)] : [caller(entry.subject)]
}

/** A length of a call, as the timeline has it. */
const seconds = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${amount(Math.round(n))} s` : undefined)
const inWords = (name) => String(name).replaceAll('_', ' ')
const tagWords = (tags) => Object.entries(tags ?? {}).map(([name, value]) => `${inWords(name)}: ${value}`).join(' · ')
/** A visit's source and campaign. */
const visitWords = (entry) => cameFrom({ source: entry.source, campaign: entry.touch?.campaign, campaignId: entry.touch?.campaignId })
const CALLED = { answered: 'Answered call', missed: 'Missed call', voicemail: 'Voicemail', waiting: 'Call waiting for a result', unknown: 'Call with no result' }
const CALL_SAYS = {
  answered: ['Answered', ' means your phone system or staff reported that a person spoke to them.'],
  missed: ['Missed', ' means nobody spoke to them and they left no voicemail.'],
  voicemail: ['Voicemail', ' means nobody spoke to them and the call went to voicemail.'],
  waiting: ['Waiting', ' means a result is expected and has not come yet.'],
  unknown: ['Unknown', ' means nothing sent says whether a person answered.'],
}
/** What became of a call nobody answered, in words: when, and how long after. Nothing is said of one that needs nothing. */
function becameOf(call, after, at) {
  if (!after) return []
  const later = typeof after.delay === 'number' ? `${moment(call.at + after.delay)} · ${lasted(after.delay)}${after.reported ? ' · reported, with no call' : ''}` : undefined
  return after.state === 'hidden' ? [['Returned', 'Number withheld']] : after.state === 'open' ? [['Returned', at > call.at ? `Not yet, ${lasted(at - call.at)} so far` : 'Not yet']]
    : [[after.state === 'called again' ? 'Called again' : 'Returned', later]]
}
/** How a call back stands to the limit. In open hours the page cannot tell, so only the limit is said. */
function limitWords(call, after, limits, at) {
  const { returnHours, openHours } = limits ?? {}
  if (!returnHours || !after || after.state === 'hidden') return undefined
  if (openHours) return `${amount(returnHours)} h of open hours`
  const over = (after.delay ?? at - call.at) - returnHours * 3600000
  return Number.isFinite(over) ? `${amount(returnHours)} h · ${over > 0 ? `late by ${lasted(over)}` : after.state === 'open' ? `${lasted(-over)} left` : 'inside it'}` : undefined
}
/** An arrival that is a number dialed, published on one channel, and not a visit to the site. */
const byNumber = (entry) => entry.touch?.landing?.startsWith('tel:')
/** The arrival a call itself was filed as: the caller's, at the moment of the call. */
const lineOf = (entry, call) => byNumber(entry) && entry.at === call.at && entry.subject === call.subject
/** Where a call came from: the arrival it is credited to where the page has that, the visit it was tied to, or the last visit before it, which is said to be no more. */
function arrivalOf(call, entries, credit) {
  if (credit?.source) return ['Came from', cameFrom(credit)]
  const visits = (entries ?? []).filter((entry) => entry.kind === 'visit' && entry.at <= call.at)
  const tied = call.visitor ? visits.filter((entry) => entry.subject === call.visitor).at(-1) : visits.find((entry) => lineOf(entry, call))
  if (tied) return ['Came from', visitWords(tied)]
  const last = visits.findLast((entry) => !byNumber(entry))
  return ['Last visit before', last && `${visitWords(last)} · ${lasted(call.at - last.at)} before`]
}
/** How a call was tied to somebody. */
function tiedBy(call, entries) {
  if (call.party) return `${call.party.role === 'representative' ? 'Representative' : call.party.role === 'self' ? 'Record holder' : 'Said'}, by ${call.party.by ?? 'staff'}${call.party.at ? `, ${moment(call.party.at)}` : ''}`
  if (call.visitor) return `${call.flags?.includes('code') ? 'A code read out' : call.flags?.includes('pool') ? 'Tracking number' : 'Tap to call'}, one visitor`
  return (entries ?? []).some((entry) => entry.kind === 'visit' && lineOf(entry, call)) ? 'The number they dialed' : undefined
}
/** The other calls from the same number to you, before and after. A number that was hidden is nobody's. */
function sameCaller(call, entries, partial) {
  const others = (entries ?? []).filter((entry) => entry.kind === 'call' && entry.call.id !== call.id && entry.call.direction === 'inbound' && entry.call.subject === call.subject)
  const before = others.filter((entry) => entry.at < call.at)
  const next = others.find((entry) => entry.at > call.at)
  const missed = before.filter((entry) => unreached(entry.state)).length
  return [before.length > 0 && `${amount(before.length)}${partial ? '+' : ''} earlier${missed > 0 ? `, ${amount(missed)} missed` : ''}`, next && `next ${moment(next.at)}`].filter(Boolean).join(' · ')
}
/** Everything known of a call that a card has room for. */
function callRows({ call, state, followUp: after, notLead: spurned, entries, partial, credit, limits, at }) {
  const followUp = spurned ? undefined : after
  const [length, wait] = [seconds(call.duration), seconds(call.result?.waited)]
  const tags = Object.entries(call.tags ?? {})
  return [['Called', moment(call.at, true)],
    ['How we know', call.result?.answered !== undefined ? `Reported, ${moment(call.result.recorded) ?? 'at a time not kept'}` : call.result ? 'Reported, but not whether anybody answered' : state === 'waiting' ? 'No result yet' : 'No result was sent'],
    length && wait ? (length === wait ? ['They waited', `${wait}, the whole call`] : ['Duration · wait', `${length} · ${wait}`]) : length ? ['Duration', length] : ['They waited', wait],
    ...becameOf(call, followUp, at), [followUp?.state === 'open' ? 'Attempts so far' : 'Attempts before that', followUp?.attempts > 0 ? amount(followUp.attempts) : undefined], ['Time limit', limitWords(call, followUp, limits, at)],
    arrivalOf(call, entries, credit), ['Tied by', tiedBy(call, entries)], tags.length === 1 ? [inWords(tags[0][0])[0].toUpperCase() + inWords(tags[0][0]).slice(1), tags[0][1]] : ['Tags', tagWords(call.tags)],
    ['Same caller', sameCaller(call, entries, partial)]]
}
const directionOf = (call) => (call.direction === 'outbound' ? 'Outbound' : 'Inbound')
const journeyHash = (subject, call) => `#/journey/${encodeURIComponent(subject)}${call ? `/${encodeURIComponent(call)}` : ''}`
/** A card of one call. `entries` are everything known of the caller, and where the page has not read them yet they are asked for. */
function callCard(data, whole) {
  const { call, state, notLead: spurned, here } = data
  const followUp = spurned ? undefined : data.followUp
  const by = followUp && !followUp.reported ? followUp.by : undefined
  const outbound = call.direction === 'outbound'
  return { title: outbound && unreached(state) ? 'Call not answered' : CALLED[state] ?? 'Call', value: `${directionOf(call)}${spurned ? ` · ${spurned === 'spam' ? 'Spam' : 'Not a lead'}` : ''}`, roomy: true,
    rows: whole ? callRows(data) : callRows(data).slice(0, 3),
    say: [outbound && state === 'answered' ? ['Answered', ' means your phone system or staff reported that they picked up.'] : outbound && state === 'missed' ? ['Missed', ' means nobody picked up.'] : CALL_SAYS[state], !outbound && unreached(state) && !spurned ? 'Returned means a call back that was answered, or a report that they were reached.' : undefined],
    links: whole ? [by && { text: followUp.state === 'returned' ? 'Show Return Call' : 'Show Later Call', href: journeyHash(call.subject, by) }, !here && { text: 'Open Journey', href: journeyHash(call.subject) }, docs('Call Results', 'calls.md#call-results')] : [] }
}
DETAILS.call = {
  now: (data) => (data?.call ? callCard(data, Boolean(data.entries)) : undefined),
  more: (data) => (data?.call && !data.entries ? recent(`/journey?subject=${encodeURIComponent(data.call.subject)}`).then((journey) => {
    const entry = journey.entries.find((each) => each.kind === 'call' && each.call.id === data.call.id)
    const card = callCard({ ...data, ...(entry && { call: entry.call, followUp: entry.followUp, notLead: entry.notLead }), entries: journey.entries, partial: journey.next !== null }, true)
    return { rows: card.rows.slice(3), links: card.links }
  }) : undefined),
}
/** The icon after a call's state. `where` tells one place of a page from another that shows the same call. */
const callDetail = (entry, where, of) => (entry.kind === 'call' ? detail('call', { id: `${entry.call.id} ${where}`, label: `${CALLED[entry.state] ?? 'call'}, ${moment(entry.at)}`, of }) : '')


const dayOf = (at) => (at > 0 ? new Date(at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'No date')
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
const row = (ties, subject, lines, card) => (entry) => {
  const date = entry.at > 0 ? new Date(entry.at) : null
  const exact = date?.toISOString()
  const time = date ? el('time', { datetime: exact, title: `${when(entry.at)} · ${exact}` }, date.toLocaleTimeString(undefined, { timeStyle: 'short' })) : unrecorded()
  const line = el('li', { class: 'timeline-entry' }, el('span', { class: 'num' }, time),
    el('span', {}, el('span', { class: `chip kind ${entry.kind}` }, glyph(looksLike(entry)), WHAT[entry.kind])),
    el('div', { class: 'what' }, ...told(entry, callDetail(entry, 'timeline', () => card(entry)))), el('div', { class: 'why' }, ...why(entry, ties, subject)))
  lines.set(entry, line)
  return line
}
const timespan = (entries) => {
  const times = entries.map((entry) => entry.at).filter((at) => at > 0)
  if (times.length === 0) return []
  const [first, last] = [Math.min(...times), Math.max(...times)]
  return [['First event', reviewDisplay.time(first)], ['Last event', reviewDisplay.time(last), last > first ? `${lasted(last - first)} later` : '']]
}
const MANY = { visit: 'visits', sighting: 'sightings', call: 'calls', text: 'texts', link: 'links', outcome: 'outcomes', value: 'value changes', consent: 'consent answers', decision: 'decisions' }
const DELIVERY = { held: 'Held for a call result', pending: 'Queued', sent: 'Sent', skipped: 'Skipped', failed: 'Rejected' }
const NEAR = 30 * 60000
/** An event in a few words, for a list of several. */
function inShort(entry) {
  switch (entry.kind) {
    case 'visit': return visitWords(entry)
    case 'sighting': return entry.event ? inWords(entry.event) : 'sighting'
    case 'call': return `${directionOf(entry.call)}, ${entry.state === 'waiting' ? 'waiting for result' : entry.state === 'unknown' ? 'no result' : entry.state}${entry.notLead ? `, ${entry.notLead === 'spam' ? 'spam' : 'not a lead'}` : ''}`
    case 'text': return entry.text.direction === 'outbound' ? 'Sent' : 'Received'
    case 'link': return entry.link.purpose ? inWords(entry.link.purpose) : 'Link sent'
    case 'outcome': return `${entry.outcome.stage}${entry.outcome.value > 0 ? ` · ${worthOf(entry.outcome.value, entry.outcome.currency)}` : ''}`
    case 'value': return `${entry.stage} · ${worthOf(entry.to.value, entry.to.currency)}`
    case 'consent': return consentWords(entry.answer)
    default: return ACTIONS[entry.decision?.action] ?? entry.decision?.action
  }
}
const consentWords = (answer) => `measurement ${answer.adUserData ? 'granted' : 'denied'}, personalization ${answer.adPersonalization ? 'granted' : 'denied'}`
/** What else happened around an event: the nearest of each other kind within half an hour, and which way. */
function nearby(entry, entries) {
  return Object.keys(WHAT).filter((kind) => kind !== entry.kind).flatMap((kind) => {
    const near = entries.filter((each) => each.kind === kind && each.at > 0 && Math.abs(each.at - entry.at) <= NEAR).sort((x, y) => Math.abs(x.at - entry.at) - Math.abs(y.at - entry.at))[0]
    return near ? [`${WHAT[kind]} ${near.at === entry.at ? 'at the same time' : `${lasted(Math.abs(near.at - entry.at))} ${near.at < entry.at ? 'before' : 'after'}`}`] : []
  }).join(', ')
}
/** What something was worth, where that is known. */
const worthIn = (value) => (typeof value?.value === 'number' ? worthOf(value.value, value.currency) : undefined)
const granted = (yes) => (yes === undefined || yes === null ? undefined : yes ? 'Granted' : 'Denied')
/** What a kind of event says of itself: the rows shown at once, and those added when it is opened. */
const EVENT_ROWS = {
  visit({ entry }) {
    const touch = entry.touch ?? {}
    const click = CLICKS.find(([field]) => touch[field])
    const referrer = touch.referrer && URL.canParse(touch.referrer) ? new URL(touch.referrer).host : undefined
    return [[['Source', entry.source], ['Campaign', touch.campaign ?? touch.campaignId], ['Click', click?.[1]], ['Keyword', touch.term], ['Page', byNumber(entry) ? 'By dialed number' : touch.landing], ['Tags', tagWords(touch.custom)]],
      [['Medium', touch.medium], ['Ad group', touch.adGroupId], ['Ad', touch.adId], ['Referrer', referrer]]]
  },
  sighting({ entry }) {
    const kinds = new Map()
    for (const identifier of entry.identifiers ?? []) kinds.set(identifier.split(':')[0], (kinds.get(identifier.split(':')[0]) ?? 0) + 1)
    return [[['Event', entry.event && inWords(entry.event)], ['Identifiers', [...kinds].map(([kind, n]) => (n > 1 ? `${kind} (${amount(n)})` : kind)).join(', ')]], []]
  },
  call(data, short) {
    const { state, notLead: spurned } = data.entry
    const followUp = spurned ? undefined : data.entry.followUp
    const call = data.entry.call ?? {}
    if (!short) return [callRows({ ...data, call, state, followUp, notLead: spurned }).slice(1), []]
    const [length, wait] = [seconds(call.duration), seconds(call.result?.waited)]
    return [[['Result', state && `${directionOf(call)}, ${state === 'waiting' ? 'waiting for result' : state === 'unknown' ? 'no result' : state}${spurned ? `, ${spurned === 'spam' ? 'spam' : 'not a lead'}` : ''}`], length && wait ? ['Duration · wait', `${length} · ${wait}`] : length ? ['Duration', length] : ['Wait', wait], ...becameOf(call, followUp, data.at)], []]
  },
  text({ entry, entries }) {
    const text = entry.text ?? {}
    const { reply } = entry
    const after = reply && { open: 'Not answered', stopped: 'They asked for no more first', replied: `By ${reply.how}${typeof reply.delay === 'number' ? ` after ${lasted(reply.delay)}` : ''}` }[reply.state]
    const answers = (entries ?? []).find((each) => each.kind === 'text' && text.id !== undefined && each.reply?.by === text.id && each.reply.how === 'text')
    return [[['Text', text.direction && (text.direction === 'outbound' ? 'Sent' : 'Received')], ['Answered', after], ['Asked to stop', text.flags?.includes('opt_out') ? 'Yes' : text.flags?.includes('opt_in') ? 'Asked for texts again' : undefined]],
      [['Answers', answers && `The text of ${moment(answers.at)}`], ['Tied by', text.visitor && (text.flags?.includes('code') ? 'A code from the site' : 'Tap to text')], ['Tags', tagWords(text.tags)]]]
  },
  link({ entry, at }) {
    const link = entry.link ?? {}
    return [[['Purpose', link.purpose && inWords(link.purpose)], ['Opened', typeof link.opened === 'number' ? `After ${lasted(link.opened - link.at)}` : link.openings === 0 ? 'Not opened' : undefined], ['Times opened', link.openings > 0 ? amount(link.openings) : undefined]],
      [['Expires', moment(link.expires)], ['Still valid', typeof link.expires === 'number' ? (link.expires > at ? 'Yes' : 'No') : undefined]]]
  },
  outcome({ entry }) {
    const outcome = entry.outcome ?? {}
    const { first, sent } = entry
    return [[['Step', outcome.stage], ['Value', outcome.value > 0 ? worthIn(outcome) : undefined], ['First value', first && first.at > 0 && (first.value !== outcome.value || first.currency !== outcome.currency) ? worthIn(first) : undefined], ['Not a lead', entry.notLead && (entry.notLead === 'spam' ? 'Spam' : 'Yes')]],
      [['Tags', tagWords(outcome.tags)], ...(sent ?? []).map((job) => [job.target, `${waiting(job) ? 'Waiting for an ad click' : DELIVERY[job.state] ?? job.state}${job.value > 0 ? ` · ${money(job.value)}` : ''}${job.note && !waiting(job) ? ` · ${inWords(job.note)}` : ''}`])]]
  },
  value({ entry, entries }) {
    const of = (entries ?? []).find((each) => each.kind === 'outcome' && each.outcome?.transactionId === entry.transactionId)
    const lost = entry.to?.kind && `${entry.to.kind === 'refund' ? 'Refund' : 'Write-off'}${entry.to.value > entry.from?.value ? ' reversed' : ''}`
    return [[['From', worthIn(entry.from)], ['To', worthIn(entry.to)], ['Why', lost]], [['Left of it', lost && worthIn(entry.to)], ['Outcome', entry.stage && `${entry.stage}${of ? `, ${moment(of.at)}` : ''}`]]]
  },
  consent({ entry, entries }) {
    const before = (entries ?? []).findLast((each) => each.kind === 'consent' && each.at < entry.at && each.subject === entry.subject)
    return [[['Ad measurement', granted(entry.answer?.adUserData)], ['Ad personalization', granted(entry.answer?.adPersonalization)], ['Source', entry.answer?.source]], [['The one before', before && `${consentWords(before.answer)}, ${moment(before.at)}`]]]
  },
  decision({ entry, entries }) {
    const decision = entry.decision ?? {}
    const about = (each) => [...(each?.about ?? [])].sort().join('\n')
    const later = (entries ?? []).filter((each) => each.kind === 'decision' && each.decision?.seq > decision.seq && about(each.decision) === about(decision)).at(-1)
    return [[['Decision', ACTIONS[decision.action] ?? decision.action], ['About', (decision.about ?? []).map(reviewDisplay.idText).join(', ')], ['By', decision.by && author(decision.by)]],
      [['Reason', decision.reason], ['Later decision', later ? `${ACTIONS[later.decision.action] ?? later.decision.action}, ${moment(later.at)}` : about(decision) ? 'None about the same' : undefined]]]
  },
}
DETAILS['chart.mark'] = {
  now(data, short = false) {
    if (!EVENT_ROWS[data?.entry?.kind] || !(data.entry.at > 0)) return undefined
    const { entry, entries = [], ties = {}, subject } = data
    const [first, rest] = EVENT_ROWS[entry.kind](data, short)
    const before = entries.filter((each) => each.kind === entry.kind && each.at > 0 && each.at < entry.at).at(-1)
    const tie = tieWords(ties[entry.subject], subject)
    const date = new Date(entry.at)
    return { title: WHAT[entry.kind], value: `${date.toLocaleTimeString(undefined, { timeStyle: 'medium' })} · ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      rows: [...first, ...(short ? [] : rest), ['Whose', entry.subject && `${reviewDisplay.idText(entry.subject)}${tie ? ` · ${tie}` : ''}`], ['Around this time', nearby(entry, entries)], [`The ${WHAT[entry.kind].toLowerCase()} before`, before && `${lasted(entry.at - before.at)} earlier`],
        ...(short ? [] : [['UTC', date.toISOString().slice(0, 19).replace('T', ' ')]])],
      foot: 'Click to keep open' }
  },
  // When a sighting was written down, and how many share what it was seen with, as the account has it.
  async more({ entry } = {}) {
    if (entry?.kind !== 'sighting' || !entry.identifiers) return {}
    const profile = await recent(`/subject?subject=${encodeURIComponent(entry.subject)}`)
    const written = Math.max(0, ...(profile.history ?? []).filter((each) => each.at === entry.at && entry.identifiers.includes(each.identifier)).map(({ recorded = 0 }) => recorded))
    const reasons = (profile.links ?? []).flatMap((link) => link.reasons ?? [])
    const shared = new Map()
    for (const identifier of entry.identifiers) {
      const fanout = reasons.find((reason) => reason.identifier === identifier)?.fanout
      const kind = identifier.split(':')[0]
      if (fanout) shared.set(kind, [...(shared.get(kind) ?? []), fanout])
    }
    return { rows: [['Written down', written - entry.at >= 60000 ? `${moment(written)} · ${lasted(written - entry.at)} later` : undefined], ...[...shared].map(([kind, counts]) => [`IDs sharing this ${kind}`, counts.sort((x, y) => y - x).map(amount).join(', ')])] }
  },
}
DETAILS['chart.number'] = {
  now(data) {
    const list = data?.list ?? []
    if (list.length === 0) return undefined
    const time = (at) => new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' })
    const [from, to] = [list[0].at, list.at(-1).at]
    return { title: `${amount(list.length)} ${MANY[list[0].kind]}`, value: dayOf(from) === dayOf(to) ? `${new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(from)} – ${time(to)}` : `${moment(from)} – ${moment(to)}`,
      rows: list.slice(0, 6).map((entry) => [inShort(entry), dayOf(from) === dayOf(to) ? time(entry.at) : moment(entry.at)]),
      say: [list.length > 6 ? `And ${amount(list.length - 6)} more.` : undefined], foot: 'Click to zoom in' }
  },
}
DETAILS['chart.wait'] = {
  now(data) {
    const { call, followUp, pick } = data ?? {}
    if (!call || !(followUp?.delay >= 0)) return undefined
    return { title: `${followUp.state === 'called again' ? 'Called again' : 'Returned'} after ${lasted(followUp.delay)}`,
      rows: [['From', moment(call.at)], ['To', moment(call.at + followUp.delay)], ['Attempts before that', followUp.attempts > 0 ? amount(followUp.attempts) : undefined], ['How we know', followUp.reported ? (followUp.reporter ? `Reported by ${followUp.reporter}, with no call` : 'Reported, with no call') : 'An answered call']],
      links: pick ? [{ text: 'Missed Call', href: location.hash, act: () => pick(call.id) }, !followUp.reported && followUp.by && { text: followUp.state === 'called again' ? 'Later Call' : 'Return Call', href: location.hash, act: () => pick(followUp.by) }] : [],
      foot: 'Click for both calls' }
  },
}
/** How the chart was left, so a refresh draws it the same. */
const charted = { subject: undefined, zoom: 'All', at: undefined, left: undefined }
const DAYS = 86400000
/** How much time fits about 700 points at each zoom. */
const ZOOMS = { All: 0, Month: 30 * DAYS, Week: 7 * DAYS, Day: DAYS }
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
function chart(entries, shown, ties, subject, show, partial) {
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
  const card = el('div', { class: 'told', role: 'region', 'aria-label': 'Selection', hidden: '' })
  const zooming = el('div', { class: 'segments', role: 'group', 'aria-label': 'Zoom' })
  const root = el('div', { class: 'chart' }, el('div', { class: 'chart-head' }, zooming, el('span', { class: 'meta' }, `${reviewDisplay.time(first).textContent} – ${reviewDisplay.time(last).textContent}`)), el('div', { class: 'chart-body' }, names, track, card))
  const order = [...dated].sort((x, y) => x.at - y.at)
  const marks = new Map()
  let perMs = 0
  const aboutMark = (entry) => ({ entry, entries, ties, subject, partial, limits, at: Date.now() })
  const cardOf = (entry) => callFacts(entry, entries, partial)
  /** Opens a call beside the chart by its id, where it is among those shown. */
  const pickCall = (id) => {
    const entry = order.find((each) => each.kind === 'call' && each.call.id === id)
    if (!entry) return notice('That call is not among the events shown.')
    pick(entry, true)
    reach(entry)
  }

  function pick(entry, focus) {
    charted.at = entry && order.indexOf(entry)
    card.hidden = entry === undefined
    const opened = root.classList.contains('picked') !== (entry !== undefined)
    root.classList.toggle('picked', entry !== undefined)
    // The card beside the chart takes its room, or gives it back. The chart is drawn again for that width at once, not a moment after. Then no mark moves from under a pointer and one is brought into view where it now stands.
    if (opened && drawnAt > 0 && track.clientWidth > 0 && track.clientWidth !== drawnAt) {
      draw()
      if (focus) marks.get(entry)?.focus({ preventScroll: true })
      return
    }
    for (const [each, mark] of marks) mark.setAttribute('aria-pressed', String(each === entry))
    if (!entry) return
    const i = order.indexOf(entry)
    const turn = (step, text, label) => el('button', { type: 'button', 'aria-label': label, 'data-key': label, ...((order[i + step] === undefined) && { disabled: '' }), on: { click: () => { pick(order[i + step]); reach(order[i + step]) } } }, text)
    const facts = el('div', {})
    card.replaceChildren(el('div', { class: 'told-head' }, el('span', { class: `chip kind ${entry.kind}` }, glyph(looksLike(entry)), WHAT[entry.kind]), el('span', { class: 'meta' }, `${amount(i + 1)} of ${amount(order.length)}`), turn(-1, '‹', 'Previous'), turn(1, '›', 'Next'), el('button', { type: 'button', class: 'shut', 'aria-label': 'Close', on: { click: () => { pick(); marks.get(entry)?.focus({ preventScroll: true }) } } }, '×')),
      el('p', { class: 'told-when' }, el('b', {}, new Date(entry.at).toLocaleTimeString(undefined, { timeStyle: 'short' })), ` ${dayOf(entry.at)}`),
      el('div', { class: 'what' }, ...told(entry, callDetail(entry, 'chart', () => cardOf(entry))).filter((node) => !node.classList?.contains('reason') && !node.classList?.contains('entry-tags'))), facts,
      el('button', { type: 'button', on: { click: () => show(entry) } }, 'Show in timeline'))
    telling(facts, undefined, Infinity)('chart.mark', () => aboutMark(entry))
    if (focus) marks.get(entry)?.focus({ preventScroll: true })
  }
  /** Scrolls a mark into view, without moving the page. */
  function reach(entry) {
    const x = (entry.at - from) * perMs
    if (x < track.scrollLeft + 40 || x > track.scrollLeft + track.clientWidth - 40) track.scrollTo({ left: x - track.clientWidth / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  /** The width it was last drawn at. */
  let drawnAt = 0
  function draw() {
    const wide = track.clientWidth
    if (wide === 0) return
    drawnAt = wide
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
    // Kept whole at the right edge, and given room, and no number is drawn under it.
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
        // Too near the one before to press either. They are one mark with how many, and a press comes closer.
        if (heap && x - heap.x < 18 && charted.zoom !== 'Day') {
          heap.list.push(entry)
          heap.mark.classList.add('heap')
          heap.mark.replaceChildren(el('span', {}, amount(heap.list.length)))
          heap.mark.setAttribute('aria-label', `${amount(heap.list.length)} of ${WHAT[kind]}, from ${when(heap.list[0].at)}`)
          marks.set(entry, heap.mark)
          continue
        }
        const list = [entry]
        const mark = cards.hintable(el('button', { type: 'button', class: `mark${long > 14 ? ' long' : ''}${looksLike(entry) === 'missed' ? ' missed' : ''}`, 'aria-label': named(entry), 'aria-pressed': 'false', on: { click: () => {
          if (list.length === 1) return pick(list[0])
          const closer = Object.keys(ZOOMS)
          charted.zoom = closer[Math.min(closer.length - 1, closer.indexOf(charted.zoom) + 1)]
          charted.left = list[0].at
          draw()
        } } }, long > 14 ? '' : glyph(looksLike(entry))), () => (list.length === 1 ? 'chart.mark' : 'chart.number'), () => (list.length === 1 ? aboutMark(list[0]) : { list }), () => list.length === 1 && order[charted.at] === list[0])
        mark.style.left = at(entry.at)
        if (long > 14) mark.style.width = `${long.toFixed(1)}px`
        lane.append(mark)
        // From a missed call to when it was returned.
        if (entry.followUp?.delay > 0 && !entry.notLead) {
          const wait = el('button', { type: 'button', class: 'wait', 'data-key': `detail chart.wait ${entry.call.id}`, 'aria-label': `${entry.followUp.state === 'called again' ? 'Called again' : 'Returned'} after ${lasted(entry.followUp.delay)}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: () => cards.press(wait) } })
          wait.about = { key: 'chart.wait', of: () => ({ call: entry.call, followUp: entry.followUp, pick: pickCall }) }
          cards.hintable(wait, () => 'chart.wait', wait.about.of, () => wait.getAttribute('aria-expanded') === 'true')
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
  // Drawn by whoever puts it on the page, as soon as it is there, and again when its width changes. Drawn only once measured, it would be shorter for a moment, and what is under it would move from under the pointer.
  root.begin = draw
  new ResizeObserver(() => track.clientWidth !== drawnAt && draw()).observe(track)
  return root
}
/** What the card of a call in a journey is made from. */
const callFacts = (entry, entries, partial) => ({ call: entry.call, state: entry.state, followUp: entry.followUp, notLead: entry.notLead, entries, partial, limits, at: Date.now(), here: true })
/** Said to be nobody's inquiry, so it is in no count. */
const notLead = (kind) => (kind ? reviewDisplay.chip(kind === 'spam' ? 'Spam' : 'Not a lead') : '')
/** How long a thing lasted, when that is known. */
const spanOf = (entry) => (entry.kind === 'call' && entry.call.duration > 0 ? entry.call.duration * 1000 : 0)
// Kinds left out of the list, kept while the screen is open.
const leaving = new Set()

// One person's timeline, across every subject that is them.
/** The call an address asked for that has been brought into view, so a refresh does not move the page again. */
let broughtTo
view('journey', 'Journey', async (box, subject, wanted) => {
  if (!subject) {
    box.append(el('section', {}, reviewDisplay.heading('Journey'), el('div', { class: 'opening' }, el('h4', {}, 'Select an ID'), el('button', { class: 'primary', on: { click: () => palette.show() } }, 'Search'),
      ...(opened.length > 0 ? [el('div', { class: 'row' }, el('span', { class: 'meta' }, 'Recent'), ...opened.slice(0, 5).map((each) => el('a', { class: 'who-chip', href: `#/journey/${encodeURIComponent(each)}`, title: each }, badge(each), reviewDisplay.idText(each))))] : []))))
    return
  }
  const journey = await api('GET', `/journey?subject=${encodeURIComponent(subject)}`)
  const top = el('section', {}, reviewDisplay.heading(reviewDisplay.id(subject, true), el('a', { class: 'button', href: subjectHash(subject) }, 'Account')))
  box.append(top)
  if (journey.entries.length === 0) {
    top.append(el('p', { class: 'muted' }, 'No events'))
    return
  }
  const subjects = Object.keys(journey.subjects)
  const strip = el('div', {})
  top.append(strip, journey.more > 0 ? el('p', { class: 'muted' }, `${amount(journey.more)} more IDs are not shown.`) : '')
  let entries = journey.entries
  let next = journey.next
  const ties = { ...journey.subjects }
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
    const over = chart(entries, shown, ties, subject, find, next !== null)
    strip.replaceChildren(tiles(['Events', `${amount(entries.length)}${next === null ? '' : '+'}`], [term('IDs', 'journeyIds'), amount(subjects.length)], ...timespan(entries)), over)
    // On a view being made, the load that shows it draws the chart.
    if (over && strip.isConnected) over.begin()
    timeline.replaceChildren(shown.length > 0
      ? el('ol', { class: 'journey', role: 'list' }, ...byDay(shown, row(ties, subject, lines, (entry) => callFacts(entry, entries, next !== null))))
      : el('p', { class: 'timeline-entry muted' }, 'All event types are hidden.'))
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
      Object.assign(ties, page.subjects)
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
  if (!wanted) broughtTo = undefined
  else if (broughtTo !== `${subject} ${wanted}`) {
    broughtTo = `${subject} ${wanted}`
    // Once the view is on the page.
    setTimeout(() => {
      const entry = entries.find((each) => each.kind === 'call' && each.call.id === wanted)
      if (!entry) return notice('That call is not among the newest events.')
      leaving.delete('call')
      if (!lines.get(entry)) draw()
      find(entry)
    })
  }
}, { every: 60_000, subject: true })
