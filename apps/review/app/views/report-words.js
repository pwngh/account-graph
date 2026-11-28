import { subjectPath } from '../navigation.ts'

export const WHAT = { visit: 'Visit', sighting: 'Sighting', call: 'Call', text: 'Text', link: 'Link', outcome: 'Outcome', value: 'Value change', consent: 'Consent', decision: 'Decision' }
export const SENT = { held: 'Held for a call result', pending: 'Queued for', sent: 'Sent to', skipped: 'Skipped for', failed: 'Rejected by' }
/** It had nothing to send the platform yet, and is tried again until it has. */
export const waiting = (job) => job.state === 'pending' && job.note === 'no_match_key'
export const CLICKS = [['gclid', 'Google ad click'], ['gbraid', 'Google ad click'], ['wbraid', 'Google ad click'], ['fbclid', 'Meta click id'], ['msclkid', 'Microsoft ad click'], ['ttclid', 'TikTok ad click']]
export const worthOf = (value, currency) => `${money(value)}${currency ? ` ${currency}` : ''}`
/** Why somebody is this person, in words. */
export function tieWords(tie, subject) {
  if (!tie || tie.how === 'self') return ''
  const steps = tie.via.filter((each) => each !== subject)
  const chain = steps.length > 0 ? ` via ${steps.map(idText).join(' → ')}` : ''
  return `${tie.how === 'cluster' ? 'Same person' : 'High confidence'}${tie.score === null ? '' : ` · ${percent(tie.score)}`}${tie.kinds.length > 0 ? ` · ${tie.kinds.map(within).join(', ')}` : ''}${chain}`
}
/**
 * Why two records are linked, in the words staff use, by the code the graph keeps before the colon of an identifier.
 * Only the codes staff meet have words. Any other is shown as the code it is.
 */
const LINKED = {
  review: 'Joined by staff', email: 'Same email address', phone: 'Same phone number', voip: 'Same internet phone number', device: 'Same browser or app',
  ip: 'Same internet address', address: 'Same postal address', dial: 'Tapped the number on the site just before the call', lease: 'Called a tracking number shown to this one visitor',
  text: 'Gave the code the site showed this one visitor', link: 'Opened a link sent to this person', carry: 'Came from another of your sites in the same browser',
  behalf: 'Speaks for this person', named: 'Same name with the same phone or email',
}
/** What was seen of a record, for a list of its sightings. */
const SEEN = {
  review: 'Joined by staff', email: 'Email address', phone: 'Phone number', voip: 'Internet phone number', device: 'Browser or app', ip: 'Internet address',
  address: 'Postal address', called: 'Name on the record', birth: 'Date of birth', dial: 'Tapped the number before a call', lease: 'Tracking number shown before a call',
  text: 'Code the site showed', link: 'Link opened in a browser', place: 'Place of the visit',
}
const kindOf = identifier => identifier.slice(0, Math.max(0, identifier.indexOf(':'))) || identifier
export const linkedBy = identifier => LINKED[kindOf(identifier)] ?? kindOf(identifier)
export const seenAs = identifier => SEEN[kindOf(identifier)] ?? identifier
/** The same, inside a sentence. A code that has no words stays as it is. */
const within = kind => LINKED[kind] ? LINKED[kind][0].toLowerCase() + LINKED[kind].slice(1) : kind

export function inShort(entry) {
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
export const consentWords = (answer) => `measurement ${answer.adUserData ? 'granted' : 'denied'}, personalization ${answer.adPersonalization ? 'granted' : 'denied'}`
export function lasted(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `${Math.floor(hours / 24)} days${hours % 24 ? ` ${hours % 24} h` : ''}`
}
export const unreached = (state) => state === 'missed' || state === 'voicemail'
export const amount = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const money = amount
export const percent = n => Math.round(100 * n) + '%'
/** A length of time in its largest unit, for where there is little room. The title beside it has it whole. */
export const brief = ms => ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + 'm' : ms < 172800000 ? Math.round(ms / 3600000) + 'h' : Math.floor(ms / 86400000) + 'd'
/** A day of a report, in words. */
export const dayWords = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })
/** How a call ended, as a tone: reached, lost, or not known yet. */
export const callTone = state => ({ answered: 'same', missed: 'apart', voicemail: 'related', waiting: 'related' })[state] ?? ''
/** What the zone's clock reads at a moment, as if it were UTC. Hours and days of a chart are counted on it. */
export function clockOf(at, timeZone = 'UTC') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map(part => [part.type, Number(part.value)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}
const HOUR = 3600000
/**
 * The lines of a chart of time between two moments: at most eight, on whole hours or days of the zone's clock.
 * Each has its place as a share of the span, the words under it, and the day over it where a day begins or the chart does.
 */
export function ticksOf(low, high, timeZone = 'UTC') {
  const span = Math.max(1, high - low)
  const step = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR, 91 * 24 * HOUR, 365 * 24 * HOUR].find(each => span / each <= 8) ?? 365 * 24 * HOUR
  const shift = clockOf(low, timeZone) - low
  const words = (at, options) => new Date(at).toLocaleString('en-US', { timeZone, ...options })
  const ticks = []
  let day
  for (let at = Math.ceil((low + shift) / step) * step - shift; at <= high; at += step) {
    const on = words(at, { weekday: 'short', month: 'short', day: 'numeric' })
    ticks.push({ at, part: (at - low) / span, text: step < 24 * HOUR ? words(at, { hour: 'numeric' }) : words(at, { month: 'short', day: 'numeric' }), over: step < 24 * HOUR && on !== day ? on : undefined })
    day = on
  }
  return ticks
}
/** The time of day, for a row under the heading of its day. */
export const hourOf = (at, timeZone = 'UTC') => new Date(at).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
/** One of six colors for a name, the same each time, so a source or a tag is told apart at a glance. */
export const toneOf = name => 'tone' + [...name].reduce((sum, letter) => (sum * 31 + letter.codePointAt(0)) >>> 0, 7) % 6
export const idText = value => value.length > 24 ? value.slice(0, 18) + '…' : value
export const inWords = name => String(name).replaceAll('_', ' ')
export const cameFrom = row => row?.source ? row.source + (row.campaign || row.campaignId ? ' · ' + (row.campaign ?? row.campaignId) : '') : undefined
export const visitWords = entry => cameFrom({ source: entry.source, campaign: entry.touch?.campaign, campaignId: entry.touch?.campaignId })
export const directionOf = call => call.direction === 'outbound' ? 'Outbound' : 'Inbound'
export const dayOf = (at, timeZone = 'UTC') => at > 0 ? new Date(at).toLocaleDateString('en-US', { timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'No date'
export const subjectHash = subject => subjectPath(subject)
export const journeyHash = (subject, call) => subjectPath(subject, 'journey') + (call ? '#call-' + encodeURIComponent(call) : '')
export const ACTIONS = { ignore: 'Ignored identifier', restore: 'Restored identifier', separate: 'Separated', rejoin: 'Removed separation', join: 'Joined', unjoin: 'Removed join', forget: 'Deleted data', rebuild: 'Rebuilt all groups', prune: 'Deleted sightings before' }

// One fetcher can outlive a revalidation at the same URL. The answer belongs to the render it was requested from.
export function detailReply(card, snapshot, reply) {
  if (!reply || reply.snapshot !== snapshot || (reply.card && reply.card.href !== card.href)) return undefined
  return reply
}
