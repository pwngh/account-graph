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
  return `${tie.how === 'cluster' ? 'Same person' : 'High confidence'}${tie.score === null ? '' : ` · ${percent(tie.score)}`}${tie.kinds.length > 0 ? ` · ${tie.kinds.join(', ')}` : ''}${chain}`
}
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
export const idText = value => value.length > 24 ? value.slice(0, 18) + '…' : value
export const inWords = name => String(name).replaceAll('_', ' ')
export const cameFrom = row => row?.source ? row.source + (row.campaign || row.campaignId ? ' · ' + (row.campaign ?? row.campaignId) : '') : undefined
export const visitWords = entry => cameFrom({ source: entry.source, campaign: entry.touch?.campaign, campaignId: entry.touch?.campaignId })
export const directionOf = call => call.direction === 'outbound' ? 'Outbound' : 'Inbound'
export const dayOf = at => at > 0 ? new Date(at).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'No date'
export const subjectHash = subject => '/accounts/' + encodeURIComponent(subject)
export const journeyHash = (subject, call) => '/journey/' + encodeURIComponent(subject) + (call ? '#call-' + encodeURIComponent(call) : '')
export const ACTIONS = { ignore: 'Ignored identifier', restore: 'Restored identifier', separate: 'Separated', rejoin: 'Removed separation', join: 'Joined', unjoin: 'Removed join', forget: 'Deleted data', rebuild: 'Rebuilt all groups', prune: 'Deleted sightings before' }

// One fetcher can outlive a revalidation at the same URL. The answer belongs to the render it was requested from.
export function detailReply(card, snapshot, reply) {
  if (!reply || reply.snapshot !== snapshot || (reply.card && reply.card.href !== card.href)) return undefined
  return reply
}
