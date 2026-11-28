// The rows and explanations from the reviewer cards, with their graph reads scoped to one request.
import { zone } from './runtime.server'
import { ACTIONS, WHAT, CLICKS, cameFrom, consentWords, dayOf as dayIn, directionOf, idText, inShort, inWords, journeyHash, lasted, percent, amount, subjectHash, tieWords, unreached, visitWords, waiting, worthOf } from './views/report-words.js'
const money = amount
const dayOf = at => dayIn(at, zone())
const reviewDisplay = { idText, day: day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', {dateStyle:'medium',timeZone:'UTC'}) }
const docs = (text, path) => ({ text, href: '/guide/' + path.split('#')[1] })
const toPart = (text, id) => ({ text, href: '#' + id })
const author = by => by?.startsWith('system:') ? 'system ' + by.slice(7) : by || 'Unknown'
const moment = (at, seconds = false) => typeof at === 'number' && at > 0 ? new Date(at).toLocaleString('en-US', {timeZone:zone(),weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...(seconds && {second:'2-digit',timeZoneName:'short'})}) : undefined
const counted = (n) => (typeof n === 'number' && Number.isFinite(n) ? amount(n) : undefined)

const both = (a, b) => (counted(a) !== undefined && counted(b) !== undefined ? `${amount(a)} · ${amount(b)}` : undefined)
const between = (from, to) => (typeof from === 'number' && typeof to === 'number' ? lasted(Math.max(0, to - from)) : undefined)
const sharePercent = (share) => (share < 0.0001 ? '<0.01%' : `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`)
const goal = (text, met, short = '') => [`Target ${text}, set by you.`, met ? ' Met.' : ` Not met${short ? `: ${short}` : ''}.`]
export function daysBefore({ from, to }) {
  const day = 86400000
  const [start, end] = [from, to].map((each) => Date.parse(`${each}T00:00:00Z`))
  const count = Math.round((end - start) / day) + 1
  return { from: new Date(start - count * day).toISOString().slice(0, 10), to: new Date(start - day).toISOString().slice(0, 10), count }
}
const seconds = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${amount(Math.round(n))} s` : undefined)
const tagWords = (tags) => Object.entries(tags ?? {}).map(([name, value]) => `${inWords(name)}: ${value}`).join(' · ')
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
const MANY = { visit: 'visits', sighting: 'sightings', call: 'calls', text: 'texts', link: 'links', outcome: 'outcomes', value: 'value changes', consent: 'consent answers', decision: 'decisions' }
const DELIVERY = { held: 'Held for a call result', pending: 'Queued', sent: 'Sent', skipped: 'Skipped', failed: 'Rejected' }
const NEAR = 30 * 60000
/** An event in a few words, for a list of several. */
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
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const hourOf = (hour) => new Date(2026, 0, 1, hour % 24).toLocaleTimeString(undefined, { hour: 'numeric' })
const hourSpan = (hour) => `${hourOf(hour)} – ${hourOf(hour + 1)}`
/** The largest of some counts by place, and the places that have it. Nothing where there is none, or where more than two share it, as then no place stands out. */
function peak(counts) {
  const most = Math.max(0, ...counts)
  const at = counts.flatMap((n, i) => (n === most ? [i] : []))
  return most > 0 && at.length <= 2 ? { most, at } : undefined
}
const sumOf = (cells, at, places, ...kinds) => Array.from({ length: places }, (_, i) => (cells ?? []).filter((cell) => at(cell) === i).reduce((sum, cell) => sum + kinds.reduce((all, kind) => all + (cell[kind] ?? 0), 0), 0))

/** The feeds of the graph, as Health names them. */
export const FEEDS = { touches: 'Visits', calls: 'Calls', results: 'Call results', costs: 'Campaign costs' }
export function cardModels(recent) {
  const DETAILS = {}
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
  DETAILS['chart.mark'] = {
    now(data, short = false) {
      if (!EVENT_ROWS[data?.entry?.kind] || !(data.entry.at > 0)) return undefined
      const { entry, entries = [], ties = {}, subject } = data
      const [first, rest] = EVENT_ROWS[entry.kind](data, short)
      const before = entries.filter((each) => each.kind === entry.kind && each.at > 0 && each.at < entry.at).at(-1)
      const tie = tieWords(ties[entry.subject], subject)
      const date = new Date(entry.at)
      return { title: WHAT[entry.kind], value: `${date.toLocaleTimeString('en-US', { timeZone: zone(), timeStyle: 'medium' })} · ${date.toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric' })}`,
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
      const time = (at) => new Date(at).toLocaleTimeString('en-US', { timeZone: zone(), timeStyle: 'short' })
      const [from, to] = [list[0].at, list.at(-1).at]
      return { title: `${amount(list.length)} ${MANY[list[0].kind]}`, value: dayOf(from) === dayOf(to) ? `${new Date(from).toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric' })}, ${time(from)} – ${time(to)}` : `${moment(from)} – ${moment(to)}`,
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
        links: pick ? [{ text: 'Missed Call', href: journeyHash(call.subject, call.id) }, !followUp.reported && followUp.by && { text: followUp.state === 'called again' ? 'Later Call' : 'Return Call', href: journeyHash(call.subject, followUp.by) }] : [],
        foot: 'Click for both calls' }
    },
  }
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
      // A journey reads further than the board, which is of one group. What is only linked to it has no part in the column.
      const of = (kind) => entries.filter((entry) => entry.kind === kind && subjects?.[entry.subject]?.how !== 'linked')
      const ladder = (board?.columns ?? []).map(({ step }) => step).filter((step) => step !== null)
      // When each step was first reached, in the order of the board.
      const first = new Map()
      for (const entry of of('outcome')) if (!entry.notLead && ladder.includes(entry.outcome.stage) && !first.has(entry.outcome.stage)) first.set(entry.outcome.stage, entry)
      const reached = ladder.filter((step) => first.has(step))
      const next = ladder[ladder.indexOf(row.step) + 1]
      const day = (at) => new Date(at).toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric' })
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
  /** The setting that watches each feed, and how its records come. */
  const WATCHED = {
    touches: ['QUIET_TOUCHES_HOURS', 'Visits arrive at any hour.'], calls: ['QUIET_CALLS_HOURS', 'Any call counts, inbound or outbound.'],
    results: ['QUIET_RESULTS_HOURS', 'A result is recorded when your phone system or staff report it.'], costs: ['QUIET_COSTS_HOURS', 'Costs arrive when the platform sends them, which can be a day or more later.'],
  }
  DETAILS['health.feed'] = {
    now({ feed, at, limits, alerts } = {}) {
      if (!feed) return undefined
      const [setting, comes] = WATCHED[feed.name] ?? []
      const open = limits?.openHours && (feed.name === 'calls' || feed.name === 'results')
      const silent = feed.last === null || feed.last === undefined ? undefined : at - feed.last
      const left = silent === undefined || open ? undefined : feed.hours * 3600000 - silent
      const watched = feed.hours > 0
      return { title: FEEDS[feed.name] ?? feed.name, value: feed.quiet ? 'Stale' : watched ? 'OK' : 'Not monitored',
        rows: [['Last record', silent === undefined ? 'None yet' : moment(feed.last)], ['Silent for', silent === undefined ? undefined : lasted(Math.max(0, silent))],
          ['Limit', watched ? `${amount(feed.hours)} h${left === undefined ? '' : left > 0 ? ` · ${lasted(left)} left` : ` · over by ${lasted(-left)}`}` : undefined], ['Counted', watched ? (open ? 'In open hours' : 'Around the clock') : undefined],
          [watched ? 'Set by' : 'Not set', setting]],
        say: [comes, watched ? (alerts ? 'Past the limit an alert is posted, once each time.' : 'Past the limit it is marked stale. ALERT_WEBHOOK is not set, so nothing is posted.') : `Set ${setting} to a number of hours, and it is marked stale past them.`],
        links: [docs('Stale Feeds', 'operations.md#stale-feeds')] }
    },
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
        links: [byHours(), summary?.from && { text: 'Channels', href: '/channels' }] }
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
      // The list is oldest first. Where there is another page, a count is of those listed, unless the last of them is not counted. Then none after it is either.
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
  /** The rows of Call results, each with the field it counts and what it is a share of. Returns are not compared with the days before, as the newest callers have had less time. */
  const RESULTS = {
    Answered: { field: 'answered', of: 'calls' }, Missed: { field: 'missed', of: 'calls', listed: true }, Voicemail: { field: 'voicemail', of: 'calls', listed: true },
    Waiting: { field: 'waiting', of: 'calls' }, Unknown: { field: 'unknown', of: 'calls' },
    Returned: { field: 'returned', of: 'lost', late: true }, 'Called again': { field: 'calledAgain', of: 'lost', late: true }, 'Not a lead': { field: 'notLeads' },
  }
  const OF = { calls: ['All inbound calls', (total) => total.calls], lost: ['Missed and voicemail', (total) => total.missed + total.voicemail] }
  DETAILS['calls.result'] = {
    now({ name, summary, then } = {}) {
      const { field, of, listed, late } = RESULTS[name] ?? {}
      const total = summary?.total
      const count = field && total?.[field]
      const [whole, wholeOf] = of ? [OF[of][0], OF[of][1]] : []
      const all = total && wholeOf ? wholeOf(total) : undefined
      const share = typeof count === 'number' && all > 0 ? count / all : undefined
      const words = (period) => {
        const part = wholeOf?.(period)
        return part > 0 ? `${amount(period[field])} · ${percent(period[field] / part)}` : amount(period[field])
      }
      return { title: name, value: counted(count),
        rows: [['Calls', counted(count)], [whole, counted(all)], ['Share', share === undefined ? undefined : percent(share)], late ? ['', undefined] : previous({ summary, then }, words)],
        sum: share === undefined ? undefined : `${percent(share)} = ${amount(count)} ${name.toLowerCase()} ÷ ${amount(all)} ${of === 'lost' ? 'missed' : all === 1 ? 'call' : 'calls'}`,
        say: [!of && field && 'Calls marked as not a lead are left out of every other count.', late && 'Not compared with the days before: the newest callers have had less time to be reached.'],
        links: [listed && toMissed(), field && docs('Call Results', 'calls.md#call-results')] }
    },
  }
  return DETAILS
}
