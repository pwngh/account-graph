/** The reasons of a tie. A group is headed by the one that counted, and the rest of it is set in below, marked as not counted. */
function reasons(list) {
  const line = (reason) => {
    const [kind] = reason.identifier.split(':')
    return el('span', { class: `reason${reason.counted === false ? ' uncounted' : ''}` }, el('b', {}, kind), ` ${percent(reason.evidence)}, shared by ${reason.fanout}, ${days(reason.gap)} `,
      reason.group === undefined ? '' : reason.counted === false ? `· not counted, ${reason.group} counts once ` : list.some((other) => other.group === reason.group && other.counted === false) ? `· counts for ${reason.group} ` : '',
      el('button', { class: 'link', title: reason.identifier, 'data-key': reason.identifier, on: { click: () => act('Stop linking through this identifier', reason.identifier, '/ignore', { identifier: reason.identifier }, 'Stop linking') } }, 'stop linking'))
  }
  return list.filter((reason) => reason.counted !== false).flatMap((reason) => [line(reason), ...list.filter((other) => reason.group !== undefined && other.group === reason.group && other.counted === false).map(line)])
}

/** What kind of subject it is, as its mark on the graph. The name beside it says the same. */
const badge = (subject) => {
  const icon = ICONS[typeOf(subject)]
  return svg('svg', { class: 'badge', viewBox: '-11 -11 22 22', 'aria-hidden': 'true', focusable: 'false' }, svg('circle', { r: 10 }), svg('path', { class: icon ? 'line' : '', d: icon ?? PERSON, transform: 'scale(.82)' }))
}

/** Why two are kept apart, in the words of whoever decided it. */
const kept = (verdict) => (verdict?.apart ? [el('span', { class: 'muted' }, 'Decided by '), author(verdict.apart.by), el('span', { class: 'muted' }, `, ${when(verdict.apart.at)}: ${verdict.apart.reason ?? '(no reason recorded)'}`),
  verdict.last.action === 'join' ? el('span', { class: 'reason' }, 'A later decision joined them, which does not undo this one. By ', author(verdict.last.by), `, ${when(verdict.last.at)}`) : ''] : [el('span', { class: 'muted' }, '(no decision recorded)')])

function profileOf(profile, more) {
  const detail = []
  const title = el('h3', { class: 'page-title' }, reviewDisplay.id(profile.subject, true))
  if (!profile.known) return [el('section', {}, el('div', { class: 'page-head' }, title), el('p', { class: 'muted' }, 'No records for this subject.'))]
  const size = profile.cluster.members.length
  detail.push(el('section', {}, el('div', { class: 'page-head' }, title, el('div', { class: 'row' },
    el('a', { class: 'button', href: `#/journey/${encodeURIComponent(profile.subject)}` }, 'Journey'),
    el('button', { on: { click: () => act('Join as one person', `${profile.subject} and the subject you name will be treated as one person.`, '/join', { a: profile.subject }, 'Join', { otherKey: 'b' }) } }, 'Join with another…'),
    el('button', { class: 'danger', on: { click: () => act('Forget this subject', `Everything recorded about ${profile.subject} will be deleted. This cannot be undone.`, '/forget', { subject: profile.subject }, 'Hold to delete', { hold: true }) } }, 'Forget…'))),
  tiles(['Cluster size', `${amount(size)} ${size === 1 ? 'subject' : 'subjects'}`, profile.cluster.oversized ? 'Above the review limit' : '', profile.cluster.oversized ? 'apart' : ''],
    profile.links[0] && ['Strongest tie', percent(Math.max(...profile.links.map((link) => link.score))), `${amount(profile.links.length)} scored ties`],
    profile.separated.length > 0 && ['Kept apart from', amount(profile.separated.length)],
    profile.history[0] && ['Last seen', reviewDisplay.time(Math.max(...profile.history.map((each) => each.at)), Date.now())],
    profile.consent[0] && ['Advertising', profile.consent[0].adUserData && profile.consent[0].adPersonalization ? 'Granted' : profile.consent[0].adUserData || profile.consent[0].adPersonalization ? 'In part' : 'Denied', profile.consent[0].source ?? '']),
  profile.cluster.oversized ? notes('The cluster is above the review limit. A shared identifier may be joining strangers.') : ''))

  if (profile.ties.length > 0 || profile.separated.length > 0) detail.push(el('section', {}, el('h2', {}, 'Graph'), graphOf(profile, more),
    around(profile).length > ROOM ? el('p', { class: 'muted' }, `${ROOM} of ${amount(around(profile).length)} are drawn. The ties are all listed below.`) : ''))

  const members = new Set(profile.cluster.members)
  // What was last decided about this subject and another, and whether systems keep reversing it.
  const verdicts = new Map(profile.verdicts.map((verdict) => [`${verdict.a}\n${verdict.b}`, verdict]))
  const verdict = (other) => verdicts.get(profile.subject < other ? `${profile.subject}\n${other}` : `${other}\n${profile.subject}`)
  const contested = (other) => (verdict(other)?.reversals >= 3 ? el('span', { class: 'chip apart', title: 'Find out which system is right, and stop the other from sending.' }, `systems disagree, ${verdict(other).reversals} times`) : '')
  const links = el('table', {}, el('tr', {}, group('Who', 2, true), group('How strong, and why', 2), el('td', { class: 'edge' })), el('tr', {}, th('Subject'), th('Tie'), ...edge([th('Score', 'num'), th('Why')]), ...edge([th('Action')])))
  const kinds = { same: [], strong: [], related: [], apart: [] }
  for (const link of profile.links) {
    const inCluster = members.has(link.subject)
    kinds[link.level !== 'same' ? 'related' : inCluster ? 'same' : 'strong'].push([link.score, el('tr', {},
      td('who', badge(link.subject), open(link.subject)),
      td('', el('span', { class: `chip ${link.level}` }, link.level === 'same' ? (inCluster ? 'Same person' : 'Strong, not joined') : 'Related'), ' ', contested(link.subject)),
      ...edge([td('num score', reviewDisplay.compare(percent(link.score), link.score)), td('why', ...reasons(link.reasons))]),
      td('edge', el('button', { on: { click: () => act('Keep these two apart', `${profile.subject} and ${link.subject} will never share a cluster, whatever they share later.`, '/separate', { a: profile.subject, b: link.subject }, 'Keep apart') } }, 'Keep apart')))])
  }
  for (const other of profile.separated) {
    kinds.apart.push([undefined, el('tr', {}, td('who', badge(other), open(other)), td('', el('span', { class: 'chip apart' }, 'Kept apart'), ' ', contested(other)), ...edge([td('num score', none()), td('why', ...kept(verdict(other)))]),
      td('edge', el('button', { on: { click: () => act('Allow these two to join again', `${profile.subject} and ${other}`, '/separate', { a: profile.subject, b: other, separated: false }, 'Allow', { undo: true }) } }, 'Allow again')))])
  }
  const between = (list) => {
    const scores = list.map(([score]) => score).filter((score) => score !== undefined)
    if (scores.length === 0) return ''
    const [low, high] = [percent(Math.min(...scores)), percent(Math.max(...scores))]
    return low === high ? low : `${low} to ${high}`
  }
  for (const [kind, name, tone] of [['same', 'Same person', 'same'], ['strong', 'Strong, not joined', 'same'], ['related', 'Related', 'related'], ['apart', 'Kept apart', 'apart']]) links.append(...folding('Ties', name, tone, 5, kinds[kind].map(([, row]) => row), between(kinds[kind])))
  detail.push(el('section', {}, el('h2', {}, 'Ties'), ...(profile.links.length + profile.separated.length > 5 ? [filters('Ties', links, [
    { name: 'Tie', at: 1, read: (cell) => cell.querySelector('.chip').textContent },
    { name: 'Shares', at: 3, read: (cell) => [...cell.querySelectorAll('.reason:not(.uncounted) > b')].map((each) => each.textContent) },
    { name: 'Kind', at: 0, read: (cell) => cell.querySelector('a').textContent.split(':')[0] },
  ])] : []), profile.links.length + profile.separated.length > 0 ? wide('Ties', links, true) : el('p', { class: 'muted' }, 'No ties meet the score threshold.')))

  if (profile.flows.length > 0) {
    const moved = (n, asset) => (n > 0 ? `${amount(n)} ${asset}` : tally(0))
    const flows = el('table', {}, el('tr', {}, group('With whom', 2, true), group('What moved', 4)), el('tr', {}, th('Subject'), th('Tie'), ...edge([th('Sent', 'num'), th('Received', 'num'), th('Times', 'num'), th('Last')])))
    for (const flow of profile.flows) {
      flows.append(el('tr', {}, td('who', open(flow.subject)),
        td('', reviewDisplay.chip(flow.relation === 'none' ? 'No tie' : flow.relation === 'same' ? 'Same person' : 'Related', flow.relation === 'none' ? '' : flow.relation)),
        ...edge([td('num', moved(flow.sent, flow.asset)), td('num', moved(flow.received, flow.asset)), td('num', amount(flow.count)), td('nowrap', reviewDisplay.time(flow.last))])))
    }
    const section = el('section', {}, el('h2', {}, 'Money, all time'), wide('Money', flows))
    if (profile.rings.length > 0) {
      section.append(el('h2', {}, 'Rings: value that came back'), el('ul', {}, ...profile.rings.map((ring) => el('li', {},
        ...ring.subjects.flatMap((subject) => [open(subject), ' paid ']), reviewDisplay.id(profile.subject, true), '. ',
        el('span', { class: 'muted' }, `${amount(ring.amount)} ${ring.asset} went all the way round. `),
        ring.tied > 0 ? el('span', { class: 'chip apart' }, `${ring.tied} of them in this cluster`) : ''))))
    }
    detail.push(section)
  }

  const records = el('div', { class: 'panel-grid profile-grid' })
  if (profile.consent.length > 0) {
    const consent = el('table', {}, el('tr', {}, th('Given'), th('Measure ads'), th('Personalize ads'), th('Source'), th('Recorded'), th('State')))
    const word = (granted) => reviewDisplay.chip(granted ? 'Granted' : 'Denied', granted ? 'same' : 'apart')
    for (const [i, answer] of profile.consent.entries()) {
      consent.append(el('tr', {}, td('nowrap', answer.at > 0 ? reviewDisplay.time(answer.at) : unrecorded()), td('', word(answer.adUserData)), td('', word(answer.adPersonalization)),
        td('who', answer.source ?? unrecorded()), td('nowrap', reviewDisplay.time(answer.recorded)), td('', i === 0 ? reviewDisplay.chip('Current') : '')))
    }
    records.append(el('section', {}, el('h2', {}, `Advertising consent, newest ${amount(profile.consent.length)}`), wide('Advertising consent', consent),
      notes('Advertising consent is not consent to be called or written to.')))
  }

  const history = el('table', {}, el('tr', {}, th('When'), th('Event'), th('Identifier')))
  for (const sighting of profile.history) history.append(el('tr', {}, td('', reviewDisplay.time(sighting.at)), td('', sighting.event ?? ''), td('who', reviewDisplay.id(sighting.identifier, true))))
  records.append(el('section', {}, el('h2', {}, `Sightings, newest ${amount(profile.history.length)}`),
    ...(profile.history.length > 8 ? [filters('Sightings', history, [{ name: 'Event', at: 1 }, { name: 'Identifier', at: 2, read: (cell) => cell.textContent.split(':')[0] }])] : []), profile.history.length > 0 ? wide('Sightings', history) : el('p', { class: 'muted' }, 'No sightings recorded.')))
  detail.push(records)
  return detail
}

const ACTIONS = { ignore: 'Stopped linking through', restore: 'Resumed linking through', separate: 'Kept apart', rejoin: 'Allowed to join', join: 'Joined', forget: 'Forgot', rebuild: 'Rebuilt every cluster', prune: 'Deleted sightings older than' }
const queued = (cluster) => el('li', { class: 'line' }, caller(cluster.id), el('span', { class: 'muted' }, `${amount(cluster.size)} accounts`), cluster.oversized ? el('span', { class: 'chip apart' }, 'review') : '')

/** How many clusters are on screen, so a refresh reads that many again. */
let listed = 50
async function clusterList() {
  let clusters = await api('GET', '/clusters')
  while (clusters.length >= 50 && clusters.length < listed) {
    const next = await api('GET', `/clusters?offset=${clusters.length}`)
    clusters = [...clusters, ...next]
    if (next.length < 50) break
  }
  const list = el('ul', { id: 'queue' }, ...(clusters.length > 0 ? clusters.map(queued) : [el('li', { class: 'muted' }, 'No clusters yet.')]))
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
  return { largest: clusters[0], shown: [scroll('Largest clusters', list), el('p', {}, more)] }
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
      about.length ? el('span', { class: 'reason' }, ...about.flatMap((each, i) => i ? [' · ', each] : [each])) : '',
      el('div', { class: 'meta decision-by' }, author(d.by), ' · ', reviewDisplay.time(d.at, Date.now()), d.reason ? `: ${d.reason}` : ''),
      d.action === 'ignore' && newest ? el('button', { class: 'link', 'data-key': `decision-${d.seq}`, on: { click: () => act('Resume linking through this identifier', d.about[0], '/ignore', { identifier: d.about[0], ignored: false }, 'Resume', { undo: true }) } }, 'undo') : '')
  }
  const list = el('ul', { id: 'decisions' }, ...(page.decisions.length > 0 ? page.decisions.map(entry) : [el('li', { class: 'muted' }, listing.author ? 'None by these.' : 'None yet.')]))
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
  const pick = el('select', { 'aria-label': 'Whose decisions', on: { change: () => { listing.author = pick.value; listing.shown = 30; load() } } },
    ...[['', 'by anyone'], ['people', 'by people'], ['system', 'by systems']].map(([value, text]) => el('option', { value, ...(value === listing.author && { selected: '' }) }, text)))
  return el('section', {}, reviewDisplay.section('Decisions, newest first', pick),
    el('p', { id: 'seal', class: audit.sound ? 'muted' : 'apart' }, audit.sound ? `${amount(page.total)} recorded in all. The record is whole.` : `The record was altered at entry ${audit.brokenAt}.`),
    scroll('Decisions', list), el('p', {}, more))
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

  left.append(el('section', {}, el('h2', {}, 'Largest clusters, now'), ...queue.shown))
  left.append(el('section', {}, el('h2', {}, 'Recent changes, newest 30'), scroll('Recent changes', el('ul', { id: 'recent' }, ...(recent.length > 0 ? recent.slice(0, 30).map((move) => el('li', {}, caller(move.subject),
    el('span', {}, move.to === undefined ? ' was removed ' : move.to === move.subject ? ' is on its own again ' : ' joined '), move.to !== undefined && move.to !== move.subject ? caller(move.to) : '',
    el('span', { class: 'reason' }, reviewDisplay.time(move.at, Date.now())))) : [el('li', { class: 'muted' }, 'No cluster changes recorded.')])))))
  left.append(decisions)

  if (subject) detail.append(...profileOf(profile, more))
  else {
    detail.append(el('section', {}, reviewDisplay.heading('Accounts'), tiles(['Largest cluster', queue.largest ? `${amount(queue.largest.size)} accounts` : 'None yet', queue.largest?.oversized ? 'Above the review limit' : '', queue.largest?.oversized ? 'apart' : ''],
      recent[0] && ['Last change', reviewDisplay.time(recent[0].at, Date.now())],
      ['Record of decisions', audit.sound ? 'Whole' : 'Altered', audit.head ? `${amount(audit.head.seq)} ${audit.head.seq === 1 ? 'decision' : 'decisions'}` : 'no decision yet', audit.sound ? '' : 'apart'])))
    // It may have been forgotten since the list was read.
    if (profile?.known) detail.append(el('section', {}, reviewDisplay.section('Largest cluster', caller(profile.subject)), graphOf(profile, more),
      around(profile).length > ROOM ? el('p', { class: 'muted' }, `${ROOM} of ${amount(around(profile).length)} are drawn.`) : ''))
  }
}, { subject: true })
