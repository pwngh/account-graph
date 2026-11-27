import { createElement } from 'react'
import { ACTIONS, CLICKS, SENT, amount, idText, lasted, waiting, worthOf } from './report-words.js'

const el = (type, attrs, ...children) => createElement(type, { className: attrs.class }, ...children)
const display = { idText, chip: (text, tone = '') => el('span', { class: 'chip ' + tone }, text), callTone: state => ({ answered: 'same', missed: 'apart', voicemail: 'related', waiting: 'related' })[state] || '' }
const toneOf = name => 'tone' + [...name].reduce((sum, letter) => (sum * 31 + letter.codePointAt(0)) >>> 0, 7) % 6
/** Where something came from: a letter in its color, which is drawn and not text, and its name. */
const sourced = name => el('span', { class: 'sourced' }, createElement('i', { className: 'letter ' + toneOf(name), 'aria-hidden': 'true', 'data-letter': name.slice(0, 1).toUpperCase() }), name)
const author = by => by?.startsWith('system:') ? 'system ' + by.slice(7) : by || 'Unknown'
const notLead = kind => kind ? display.chip(kind === 'spam' ? 'Spam' : 'Not a lead') : ''
/** What happened, in words, with the rest of it on lines below. `icon` opens what else is known of a call, and stands after its state. */
export function told(entry, icon = '') {
  const more = (...text) => el('span', { class: 'reason' }, ...text)
  const facts = (...text) => text.some(Boolean) ? more(text.filter(Boolean).join(' · ')) : ''
  const tags = (values, rename = (name) => name) => {
    const chips = Object.entries(values ?? {}).map(([name, value]) => display.chip(`${rename(name)}: ${value}`, `tag ${toneOf(name)}`))
    return chips.length ? el('span', { class: 'entry-tags' }, ...chips) : ''
  }
  const words = (name) => name.replaceAll('_', ' ')
  if (entry.kind === 'visit') {
    const { touch } = entry
    const click = CLICKS.find(([field]) => touch[field])
    return [sourced(entry.source), `${touch.campaign || touch.campaignId ? ` · ${touch.campaign || touch.campaignId}` : ''} `,
      click || touch.medium ? display.chip(click ? click[1] : touch.medium, 'muted') : '',
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
    const after = followUp && { open: 'Not returned', returned: `Returned after ${lasted(followUp.delay)}${followUp.reported ? ' (reported)' : ''}`, 'called again': `Called again after ${lasted(followUp.delay)}`, hidden: 'Number withheld' }[followUp.state]
    return [call.direction === 'outbound' ? 'Outbound ' : 'Inbound ', display.chip(how[0].toUpperCase() + how.slice(1), display.callTone(state)), notLead(entry.notLead), icon,
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
  return [`${ACTIONS[decision.action] ?? decision.action} ${decision.about.map(display.idText).join(' · ')}`, more(author(decision.by), decision.reason ? ` · ${decision.reason}` : '')]
}
