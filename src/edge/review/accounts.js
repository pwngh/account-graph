/** The reasons of a tie. A group is headed by the one that counted, and the rest of it is set in below, marked as not counted. */
function reasons(list) {
  const line = (reason) => {
    const [kind] = reason.identifier.split(':')
    return el('span', { class: `reason${reason.counted === false ? ' uncounted' : ''}` }, el('b', {}, kind), ` ${percent(reason.evidence)} · ${reason.fanout} IDs · ${days(reason.gap)} `,
      reason.group === undefined ? '' : reason.counted === false ? `· not counted (${reason.group} group) ` : list.some((other) => other.group === reason.group && other.counted === false) ? `· ${reason.group} group ` : '',
      el('button', { class: 'link', title: reason.identifier, 'data-key': reason.identifier, on: { click: () => act('Ignore identifier', reason.identifier, '/ignore', { identifier: reason.identifier }, 'Ignore') } }, 'Ignore'))
  }
  return list.filter((reason) => reason.counted !== false).flatMap((reason) => [line(reason), ...list.filter((other) => reason.group !== undefined && other.group === reason.group && other.counted === false).map(line)])
}

/** The kinds of subject with a color of their own. */
const BADGES = new Set(['account', 'visitor', 'lead', 'caller', 'contact', 'person'])
/** What kind of subject it is, as its mark on the graph. The name beside it says the same. */
const badge = (subject) => {
  const icon = ICONS[typeOf(subject)]
  return svg('svg', { class: `badge ${BADGES.has(typeOf(subject)) ? typeOf(subject) : ''}`, viewBox: '-11 -11 22 22', 'aria-hidden': 'true', focusable: 'false' }, svg('circle', { r: 10 }), svg('path', { class: icon ? 'line' : '', d: icon ?? PERSON, transform: 'scale(.82)' }))
}

/** Why two are kept apart, in the words of whoever decided it. */
const kept = (verdict) => (verdict?.apart ? [author(verdict.apart.by), el('span', { class: 'muted' }, ` · ${when(verdict.apart.at)}${verdict.apart.reason ? ` · ${verdict.apart.reason}` : ''}`),
  verdict.last.action === 'join' ? el('span', { class: 'reason' }, 'Later joined by ', author(verdict.last.by), `, ${when(verdict.last.at)}. The separation takes precedence.`) : ''] : [unrecorded()])

const TOLD = { accepted: ['Retraction accepted', 'same'], rejected: ['Retraction rejected', 'apart'], not_requested: ['Not requested', 'related'] }
/** What had reached an ad platform of someone just forgotten. It is said once and kept nowhere, so only its button puts it away. */
function sentOn(sent) {
  const table = el('table', {}, el('tr', {}, th('Platform'), th('Conversion'), th('Date'), th('Transaction'), th('Status')),
    ...sent.map((each) => el('tr', {}, td('', sourced(each.target)), td('', each.action), td('nowrap', reviewDisplay.time(each.at)), td('', each.transactionId),
      td('', reviewDisplay.chip(...TOLD[each.state]), each.note ? el('span', { class: 'reason' }, each.note) : ''))))
  const dialog = el('dialog', { class: 'sent-on', closedby: 'none', 'aria-label': 'Data held by ad platforms' }, el('h4', {}, 'Data held by ad platforms'),
    el('p', { class: 'muted' }, sent.some(({ state }) => state !== 'accepted') ? 'This ID was deleted here. Contact these platforms directly about their data. This list is shown once, so save a copy.' : 'This ID was deleted. This list is shown once.'),
    wide('Data held by ad platforms', table), el('div', { class: 'row' }, saved('sent-to-ad-platforms', table), el('button', { class: 'primary', on: { click: () => dialog.close() } }, 'Close')))
  // A browser closes a dialog on a second Escape whatever the first was answered, so the key itself is stopped.
  dialog.addEventListener('keydown', (event) => event.key === 'Escape' && event.preventDefault())
  dialog.addEventListener('cancel', (event) => event.preventDefault())
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  dialog.querySelector('button').focus()
}

function profileOf(profile, more) {
  const detail = []
  const dates = (subject) => {
    if (/^(visitor|caller|call):/.test(subject)) return []
    const { firstSeen, createdAt } = profile.dates?.[subject] ?? {}
    return [['First seen here', firstSeen], ['Created in your system', createdAt]].filter(([, at]) => at !== undefined)
      .map(([label, at]) => el('div', { class: 'meta' }, label + ' ', reviewDisplay.time(at)))
  }
  const title = el('h3', { class: 'page-title' }, badge(profile.subject), reviewDisplay.id(profile.subject, true))
  const own = dates(profile.subject)
  if (!profile.known) return [el('section', {}, el('div', { class: 'page-head' }, title), ...(own.length ? own : [el('p', { class: 'muted' }, 'No records')]))]
  const size = profile.cluster.members.length
  detail.push(el('section', {}, el('div', { class: 'page-head' }, title, explain(), el('div', { class: 'row' },
    el('a', { class: 'button', href: `#/journey/${encodeURIComponent(profile.subject)}` }, 'Journey'),
    el('button', { on: { click: () => act('Join IDs', `${profile.subject} and the other ID will be treated as one person.`, '/join', { a: profile.subject }, 'Join', { otherKey: 'b' }) } }, 'Join with…'),
    el('button', { class: 'danger', on: { click: () => act('Delete data', `All data recorded for ${profile.subject} will be permanently deleted.`, '/forget', { subject: profile.subject, ads: true }, 'Hold to delete', { hold: true, ...(retraction?.targets.length && !retraction.always && { option: { key: 'retract', text: `Ask ${retraction.targets.join(', ')} to retract conversions` } }), done: ({ sent }) => sent.length > 0 && sentOn(sent) }) } }, 'Delete…'))),
  ...own, tiles([term('Linked IDs', 'linkedIds'), amount(size), profile.cluster.oversized ? 'Above review limit' : '', profile.cluster.oversized ? 'apart' : ''],
    profile.links[0] && [term('Strongest link', 'strongest'), percent(Math.max(...profile.links.map((link) => link.score))), `${amount(profile.links.length)} ${profile.links.length === 1 ? 'link' : 'links'}`],
    profile.separated.length > 0 && [term('Separated', 'separated'), amount(profile.separated.length)],
    profile.history[0] && [term('Last seen', 'lastSeen'), reviewDisplay.time(Math.max(...profile.history.map((each) => each.at)), Date.now())],
    profile.consent[0] && [term('Ad consent', 'consent'), profile.consent[0].adUserData && profile.consent[0].adPersonalization ? 'Granted' : profile.consent[0].adUserData || profile.consent[0].adPersonalization ? 'Partial' : 'Denied', profile.consent[0].source ?? '']),
  profile.cluster.limitedByCalls ? el('p', { class: 'banner' }, 'Several call histories fit this group. Some possible matches have been kept apart.') : '',
  profile.cluster.oversized ? el('p', { class: 'banner' }, el('b', {}, 'Large group. '), 'A widely shared identifier may be joining different people. Review the links below.') : ''))

  if (profile.edges.length > 0 || profile.separated.length > 0) detail.push(el('section', {}, el('h2', {}, term('Graph', 'graph')), graphOf(profile, more),
    around(profile).length > ROOM ? el('p', { class: 'muted' }, `Showing ${ROOM} of ${amount(around(profile).length)}. All links are listed below.`) : ''))

  const members = new Set(profile.cluster.members)
  // What was last decided about this subject and another, and whether systems keep reversing it.
  const verdicts = new Map(profile.verdicts.map((verdict) => [`${verdict.a}\n${verdict.b}`, verdict]))
  const verdict = (other) => verdicts.get(profile.subject < other ? `${profile.subject}\n${other}` : `${other}\n${profile.subject}`)
  const contested = (other) => (verdict(other)?.reversals >= 3 ? el('span', { class: 'chip apart', title: `Systems have reversed this decision ${verdict(other).reversals} times` }, 'Conflict') : '')
  const links = el('table', { class: 'links' }, el('tr', {}, th('ID'), th('Status'), ...edge([th(term('Score', 'score'), 'num'), th(term('Evidence', 'evidence'))]), ...edge([th('Action')])))
  const kinds = { same: [], strong: [], related: [], apart: [] }
  for (const link of profile.links) {
    const inCluster = members.has(link.subject)
    kinds[link.level !== 'same' ? 'related' : inCluster ? 'same' : 'strong'].push([link.score, el('tr', {},
      td('who', badge(link.subject), reviewDisplay.subject(link.subject), ...dates(link.subject)),
      td('', el('span', { class: `chip ${link.level}` }, link.level === 'same' ? (inCluster ? 'Same person' : 'High confidence') : 'Related'), ' ', contested(link.subject)),
      ...edge([td('num score', reviewDisplay.compare(percent(link.score), link.score)), td('why', ...reasons(link.reasons))]),
      td('edge', el('button', { on: { click: () => act('Separate IDs', `${profile.subject} and ${link.subject} will be treated as different people.`, '/separate', { a: profile.subject, b: link.subject }, 'Separate') } }, 'Separate')))])
  }
  for (const other of profile.separated) {
    kinds.apart.push([undefined, el('tr', {}, td('who', badge(other), reviewDisplay.subject(other), ...dates(other)), td('', el('span', { class: 'chip apart' }, 'Separated'), ' ', contested(other)), ...edge([td('num score', none()), td('why', ...kept(verdict(other)))]),
      td('edge', el('button', { on: { click: () => act('Remove separation', `${profile.subject} and ${other} can be joined again.`, '/separate', { a: profile.subject, b: other, separated: false }, 'Remove', { undo: true }) } }, 'Remove')))])
  }
  const between = (list) => {
    const scores = list.map(([score]) => score).filter((score) => score !== undefined)
    if (scores.length === 0) return ''
    const [low, high] = [percent(Math.min(...scores)), percent(Math.max(...scores))]
    return low === high ? low : `${low} – ${high}`
  }
  for (const [kind, name, tone] of [['same', 'Same person', 'same'], ['strong', 'High confidence', 'same'], ['related', 'Related', 'related'], ['apart', 'Separated', 'apart']]) links.append(...folding('Links', name, tone, 5, kinds[kind].map(([, row]) => row), between(kinds[kind])))
  detail.push(el('section', {}, el('h2', {}, term('Links', 'links')), ...(profile.links.length + profile.separated.length > 5 ? [filters('Links', links, [
    { name: 'Status', at: 1, read: (cell) => cell.querySelector('.chip').textContent },
    { name: 'Identifier', at: 3, read: (cell) => [...cell.querySelectorAll('.reason:not(.uncounted) > b')].map((each) => each.textContent) },
    { name: 'Type', at: 0, read: (cell) => cell.querySelector('a').textContent.split(':')[0] },
  ])] : []), profile.links.length + profile.separated.length > 0 ? wide('Links', links, true) : el('p', { class: 'muted' }, 'No links')))

  if (profile.flows.length > 0) {
    const moved = (n, asset) => (n > 0 ? `${amount(n)} ${asset}` : tally(0))
    const flows = el('table', {}, el('tr', {}, th('ID'), th('Status'), ...edge([th('Sent', 'num'), th('Received', 'num'), th('Transfers', 'num'), th('Last')])))
    for (const flow of profile.flows) {
      flows.append(el('tr', {}, td('who', open(flow.subject)),
        td('', reviewDisplay.chip(flow.relation === 'none' ? 'Not linked' : flow.relation === 'same' ? 'Same person' : 'Related', flow.relation === 'none' ? '' : flow.relation)),
        ...edge([td('num', moved(flow.sent, flow.asset)), td('num', moved(flow.received, flow.asset)), td('num', amount(flow.count)), td('nowrap', reviewDisplay.time(flow.last))])))
    }
    const section = el('section', {}, el('h2', {}, term('Transfers', 'transfers')), wide('Transfers', flows))
    if (profile.rings.length > 0) {
      section.append(el('h2', {}, term('Circular transfers', 'rings')), el('ul', {}, ...profile.rings.map((ring) => el('li', {},
        ...ring.subjects.flatMap((subject) => [open(subject), ' → ']), reviewDisplay.id(profile.subject, true), ' ',
        el('span', { class: 'muted' }, `${amount(ring.amount)} ${ring.asset} `),
        ring.tied > 0 ? el('span', { class: 'chip apart' }, `${ring.tied} linked to this ID`) : ''))))
    }
    detail.push(section)
  }

  const records = el('div', { class: 'panel-grid profile-grid' })
  if (profile.consent.length > 0) {
    const consent = el('table', {}, el('tr', {}, th('Date'), th('Ad measurement'), th('Ad personalization'), th('Source'), th('Recorded'), th('Status')))
    const word = (granted) => reviewDisplay.chip(granted ? 'Granted' : 'Denied', granted ? 'same' : 'apart')
    for (const [i, answer] of profile.consent.entries()) {
      consent.append(el('tr', {}, td('nowrap', answer.at > 0 ? reviewDisplay.time(answer.at) : unrecorded()), td('', word(answer.adUserData)), td('', word(answer.adPersonalization)),
        td('who', answer.source ?? unrecorded()), td('nowrap', reviewDisplay.time(answer.recorded)), td('', i === 0 ? reviewDisplay.chip('Current') : '')))
    }
    records.append(el('section', {}, el('h2', {}, term('Ad consent', 'consent'), el('span', { class: 'count' }, amount(profile.consent.length))), wide('Ad consent', consent)))
  }

  const history = el('table', {}, el('tr', {}, th('Date'), th('Event'), th('Identifier')))
  for (const sighting of profile.history) history.append(el('tr', {}, td('', reviewDisplay.time(sighting.at)), td('', sighting.event ?? ''), td('who', reviewDisplay.id(sighting.identifier, true))))
  records.append(el('section', {}, el('h2', {}, term('Sightings', 'sightings'), el('span', { class: 'count' }, amount(profile.history.length))),
    ...(profile.history.length > 8 ? [filters('Sightings', history, [{ name: 'Event', at: 1 }, { name: 'Identifier', at: 2, read: (cell) => cell.textContent.split(':')[0] }])] : []), profile.history.length > 0 ? wide('Sightings', history) : el('p', { class: 'muted' }, 'No sightings')))
  detail.push(records)
  return detail
}

const ACTIONS = { ignore: 'Ignored identifier', restore: 'Restored identifier', separate: 'Separated', rejoin: 'Removed separation', join: 'Joined', unjoin: 'Removed join', forget: 'Deleted data', rebuild: 'Rebuilt all groups', prune: 'Deleted sightings before' }
const queued = (cluster) => el('li', { class: 'line' }, badge(cluster.id), caller(cluster.id), el('span', { class: 'muted' }, `${amount(cluster.size)} IDs`), cluster.oversized ? el('span', { class: 'chip apart' }, 'Review') : '')

/** How many clusters are on screen, so a refresh reads that many again. */
let listed = 50
async function clusterList() {
  let clusters = await api('GET', '/clusters')
  while (clusters.length >= 50 && clusters.length < listed) {
    const next = await api('GET', `/clusters?offset=${clusters.length}`)
    clusters = [...clusters, ...next]
    if (next.length < 50) break
  }
  const list = el('ul', { id: 'queue' }, ...(clusters.length > 0 ? clusters.map(queued) : [el('li', { class: 'muted' }, 'None')]))
  // The list comes 50 at a time. A full page means there may be more.
  const more = el('button', { on: { click: async () => {
    // Something else is being opened: this list is about to go.
    if (opening) return
    // A refresh under way would replace the list this page is added to, so it gives way.
    loading += 1
    pending += 1
    more.disabled = true
    try {
      const next = await api('GET', `/clusters?offset=${list.children.length}`)
      list.append(...next.map(queued))
      listed = list.children.length
      more.hidden = next.length < 50
    } catch (error) {
      notice(error.message, true)
    } finally {
      pending -= 1
      more.disabled = false
    }
  } } }, 'Show more')
  more.hidden = clusters.length === 0 || clusters.length % 50 > 0
  return { largest: clusters[0], shown: [scroll('Largest groups', list), el('p', {}, more)] }
}

/** Which decisions to list, and how many are on screen, so a refresh reads the same again. */
const listing = { author: '', shown: 30 }
const decisionPath = (limit, before) => `/decisions?limit=${limit}${listing.author ? `&author=${listing.author}` : ''}${before ? `&before=${before}` : ''}`
async function decisionList(audit) {
  const page = await api('GET', decisionPath(Math.min(500, listing.shown)))
  const seen = new Set()
  const entry = (d) => {
    // Only the newest entry about an identifier can be undone, and only a list of everyone's decisions shows which that is.
    const newest = !listing.author && !seen.has(d.about[0])
    if (d.action === 'ignore' || d.action === 'restore') seen.add(d.about[0])
    const about = d.action === 'prune' ? [reviewDisplay.time(Number(d.about[0]))] : d.about.map((id) => reviewDisplay.id(id, true))
    return el('li', {}, el('b', {}, ACTIONS[d.action] ?? d.action),
      about.length ? el('span', { class: 'reason', title: d.about.join(' · ') }, ...about.flatMap((each, i) => i ? [' · ', each] : [each])) : '',
      el('div', { class: 'meta decision-by', title: d.reason ?? '' }, author(d.by), ' · ', reviewDisplay.time(d.at, Date.now()), d.reason ? `: ${d.reason}` : ''),
      d.action === 'ignore' && newest ? el('button', { class: 'link', 'data-key': `decision-${d.seq}`, on: { click: () => act('Restore identifier', d.about[0], '/ignore', { identifier: d.about[0], ignored: false }, 'Restore', { undo: true }) } }, 'Undo') : '')
  }
  const list = el('ul', { id: 'decisions' }, ...(page.decisions.length > 0 ? page.decisions.map(entry) : [el('li', { class: 'muted' }, listing.author ? 'None' : 'None')]))
  let next = page.next
  const more = el('button', { on: { click: async () => {
    if (opening) return
    const turn = ++loading
    pending += 1
    more.disabled = true
    try {
      const older = await api('GET', decisionPath(50, next))
      // Another list was asked for meanwhile.
      if (turn !== loading) return
      list.append(...older.decisions.map(entry))
      listing.shown = list.children.length
      next = older.next
      more.hidden = next === null
    } catch (error) {
      notice(error.message, true)
    } finally {
      pending -= 1
      more.disabled = false
    }
  } } }, 'Show older')
  more.hidden = next === null
  const pick = el('select', { 'aria-label': 'Author', on: { change: () => { listing.author = pick.value; listing.shown = 30; load() } } },
    ...[['', 'All'], ['people', 'People'], ['system', 'Systems']].map(([value, text]) => el('option', { value, ...(value === listing.author && { selected: '' }) }, text)))
  return el('section', {}, reviewDisplay.section(term('Audit log', 'audit'), pick),
    el('p', { id: 'seal', class: audit.sound ? 'muted' : 'apart' }, audit.sound ? `${amount(page.total)} ${page.total === 1 ? 'entry' : 'entries'} · Verified` : `Altered at entry ${audit.brokenAt}`),
    scroll('Audit log', list), el('p', {}, more))
}

view('accounts', 'Accounts', async (box, subject) => {
  const left = el('div', { class: 'account-rail' })
  const detail = el('div', { id: 'detail' })
  box.append(el('div', { class: `split${subject ? ' opened' : ''}` }, left, detail))
  // The record first: a decision that lands while the rest is read is then newer than what is shown, and refuses one made on it.
  const audit = await api('GET', '/audit')
  box.dataset.seen = audit.head?.seq ?? 0
  const read = (each) => api('GET', `/subject?subject=${encodeURIComponent(each)}`)
  // Whoever was opened out on the graph is read again with it.
  const [queue, recent] = await Promise.all([clusterList(), api('GET', '/recent')])
  // With nobody opened, the largest cluster is drawn: where a reviewer should look first.
  const about = subject || queue.largest?.id
  const spread = drawn.subject === about ? [...drawn.more.keys()] : []
  const [profile, ...more] = await Promise.all([about ? read(about) : undefined, ...spread.map(read)])
  const decisions = await decisionList(audit)

  left.append(el('section', {}, el('h2', {}, term('Largest groups', 'largest')), ...queue.shown))
  left.append(el('section', {}, el('h2', {}, 'Recent changes'), scroll('Recent changes', el('ul', { id: 'recent' }, ...(recent.length > 0 ? recent.slice(0, 30).map((move) => el('li', { class: 'move' }, badge(move.subject), caller(move.subject), el('span', { class: 'meta move-time' }, reviewDisplay.time(move.at, Date.now())),
    el('span', { class: 'move-to' }, el('span', {}, move.to === undefined ? ' removed' : move.to === move.subject ? ' ungrouped' : ' joined '), ...(move.to !== undefined && move.to !== move.subject ? [caller(move.to)] : [])))) : [el('li', { class: 'muted' }, 'None')])))))
  left.append(decisions)

  if (subject) detail.append(...profileOf(profile, more))
  else {
    detail.append(el('section', {}, reviewDisplay.heading('Accounts'), tiles([term('Largest group', 'largest'), queue.largest ? `${amount(queue.largest.size)} IDs` : 'None', queue.largest?.oversized ? 'Above review limit' : '', queue.largest?.oversized ? 'apart' : ''],
      recent[0] && ['Last change', reviewDisplay.time(recent[0].at, Date.now())],
      [term('Audit log', 'record'), audit.sound ? 'Verified' : 'Altered', `${amount(audit.head?.seq ?? 0)} ${audit.head?.seq === 1 ? 'entry' : 'entries'}`, audit.sound ? '' : 'apart'])))
    // It may have been forgotten since the list was read.
    if (profile?.known) detail.append(el('section', {}, reviewDisplay.section('Largest group', caller(profile.subject)), graphOf(profile, more),
      around(profile).length > ROOM ? el('p', { class: 'muted' }, `Showing ${ROOM} of ${amount(around(profile).length)}`) : ''))
  }
}, { subject: true })
