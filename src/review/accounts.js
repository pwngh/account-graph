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

/** The subject in the middle, the subjects tied to it around it, and the ties between them. */
function picture(profile) {
  // Room for 24. The subject's own ties and separations come first, then the rest of its cluster.
  const others = [...new Set([...profile.separated, ...profile.links.map((link) => link.subject), ...(profile.cluster?.members ?? [])])].filter((s) => s !== profile.subject).slice(0, 24)
  const members = new Set(profile.cluster?.members ?? [])
  const spot = new Map([[profile.subject, [300, 170]]])
  others.forEach((subject, i) => {
    const angle = (2 * Math.PI * i) / others.length - Math.PI / 2
    spot.set(subject, [300 + 220 * Math.cos(angle), 170 + 125 * Math.sin(angle)])
  })
  const drawing = svg('svg', { viewBox: '0 0 600 340', role: 'group', 'aria-label': `Ties of ${profile.subject}` })
  const line = (a, b, kind, width, label) => {
    const [from, to] = [spot.get(a), spot.get(b)]
    if (from && to) drawing.append(svg('line', { class: `tie ${kind}`, x1: from[0], y1: from[1], x2: to[0], y2: to[1], 'stroke-width': width }, svg('title', {}, label)))
  }
  // A strong tie that a cut left out of the cluster is drawn like a related one: tied, not joined.
  for (const tie of profile.ties) {
    const joined = tie.level === 'same' && members.has(tie.a) && members.has(tie.b)
    line(tie.a, tie.b, joined ? 'same' : 'related', 1 + 3 * tie.score, `${tie.a} and ${tie.b}: ${joined ? 'joined' : 'tied, not joined'}, ${percent(tie.score)}`)
  }
  for (const [a, b] of [...profile.separated.map((other) => [profile.subject, other]), ...profile.apart]) line(a, b, 'apart', 2, `${a} and ${b}: kept apart`)
  for (const [subject, [x, y]] of spot) {
    const me = subject === profile.subject
    const node = svg('circle', { class: `node${me ? ' me' : members.has(subject) ? ' member' : ''}`, cx: x, cy: y, r: me ? 11 : 8, tabindex: 0, role: 'link', 'aria-label': subject }, svg('title', {}, subject))
    node.addEventListener('click', () => go(subjectHash(subject)))
    node.addEventListener('keydown', (event) => event.key === 'Enter' && go(subjectHash(subject)))
    drawing.append(node, svg('text', { x, y: y + (y < 170 ? -14 : 22), 'text-anchor': 'middle' }, subject.length > 22 ? `${subject.slice(0, 21)}…` : subject))
  }
  return drawing
}

/** Why two are kept apart, in the words of whoever decided it. */
const kept = (verdict) => (verdict?.apart ? [el('span', { class: 'muted' }, 'Decided by '), author(verdict.apart.by), el('span', { class: 'muted' }, `, ${when(verdict.apart.at)}: ${verdict.apart.reason ?? '(no reason recorded)'}`),
  verdict.last.action === 'join' ? el('span', { class: 'reason' }, 'A later decision joined them, which does not undo this one. By ', author(verdict.last.by), `, ${when(verdict.last.at)}`) : ''] : [el('span', { class: 'muted' }, '(no decision recorded)')])

function profileOf(profile) {
  const detail = []
  if (!profile.known) return [el('section', {}, el('h3', {}, profile.subject), el('p', { class: 'muted' }, 'Nothing has been recorded about this subject.'))]
  const size = profile.cluster.members.length
  detail.push(el('section', {}, el('h3', {}, profile.subject),
    el('p', {}, size > 1 ? `In a cluster of ${size} that the graph treats as one person.` : 'On its own. The graph treats it as one person with one account.'),
    profile.cluster.oversized ? el('p', { class: 'apart' }, 'This cluster is larger than the review size. A shared identifier may be joining strangers.') : '',
    el('div', { class: 'row' },
      el('button', { on: { click: () => act('Join as one person', `${profile.subject} and the subject you name will be treated as one person.`, '/join', { a: profile.subject }, 'Join', 'b') } }, 'Join with another…'),
      el('button', { class: 'danger', on: { click: () => act('Forget this subject', `Everything recorded about ${profile.subject} will be deleted. This cannot be undone.`, '/forget', { subject: profile.subject }, 'Delete') } }, 'Forget…'))))

  if (profile.ties.length > 0 || profile.separated.length > 0) detail.push(el('section', {}, el('h2', {}, 'Picture'), picture(profile),
    el('p', { class: 'muted' }, 'Solid: joined. Dashed: tied, not joined. Dotted red: kept apart by a decision. Open a circle to see that subject.')))

  const members = new Set(profile.cluster.members)
  // What was last decided about this subject and another, and whether systems keep reversing it.
  const verdicts = new Map(profile.verdicts.map((verdict) => [`${verdict.a}\n${verdict.b}`, verdict]))
  const verdict = (other) => verdicts.get(profile.subject < other ? `${profile.subject}\n${other}` : `${other}\n${profile.subject}`)
  const contested = (other) => (verdict(other)?.reversals >= 3 ? el('span', { class: 'chip apart', title: 'Find out which system is right, and stop the other from sending.' }, `systems disagree, ${verdict(other).reversals} times`) : '')
  const links = el('table', {}, el('tr', {}, th('Subject'), th('Tie'), th('Score', 'num'), th('Why'), th('')))
  for (const link of profile.links) {
    const inCluster = members.has(link.subject)
    links.append(el('tr', {},
      td('who', open(link.subject)),
      td('', el('span', { class: `chip ${link.level}` }, link.level === 'same' ? (inCluster ? 'same person' : 'strong, not joined') : 'related'), ' ', contested(link.subject)),
      td('num', percent(link.score)),
      td('why', ...reasons(link.reasons)),
      td('', el('button', { on: { click: () => act('Keep these two apart', `${profile.subject} and ${link.subject} will never share a cluster, whatever they share later.`, '/separate', { a: profile.subject, b: link.subject }, 'Keep apart') } }, 'Keep apart'))))
  }
  for (const other of profile.separated) {
    links.append(el('tr', {}, td('who', open(other)), td('', el('span', { class: 'chip apart' }, 'kept apart'), ' ', contested(other)), td(''), td('why', ...kept(verdict(other))),
      td('', el('button', { on: { click: () => act('Allow these two to join again', `${profile.subject} and ${other}`, '/separate', { a: profile.subject, b: other, separated: false }, 'Allow') } }, 'Allow again'))))
  }
  detail.push(el('section', {}, el('h2', {}, 'Ties'), profile.links.length + profile.separated.length > 0 ? wide('Ties', links) : el('p', { class: 'muted' }, 'No other subject shares enough with this one to be tied to it.')))

  if (profile.flows.length > 0) {
    const flows = el('table', {}, el('tr', {}, th('With'), th('Tie'), th('Sent', 'num'), th('Received', 'num'), th('Times', 'num'), th('Last')))
    for (const flow of profile.flows) {
      flows.append(el('tr', {}, td('who', open(flow.subject)),
        td('', el('span', { class: `chip ${flow.relation === 'none' ? '' : flow.relation}` }, flow.relation === 'none' ? 'no tie' : flow.relation === 'same' ? 'same person' : 'related')),
        td('num', `${amount(flow.sent)} ${flow.asset}`), td('num', `${amount(flow.received)} ${flow.asset}`), td('num', flow.count), td('', when(flow.last))))
    }
    const section = el('section', {}, el('h2', {}, 'Money, all time'), wide('Money', flows))
    if (profile.rings.length > 0) {
      section.append(el('h2', {}, 'Rings: value that came back'), el('ul', {}, ...profile.rings.map((ring) => el('li', {},
        ...ring.subjects.flatMap((subject) => [open(subject), ' paid ']), el('span', {}, `${profile.subject}. `),
        el('span', { class: 'muted' }, `${amount(ring.amount)} ${ring.asset} went all the way round. `),
        ring.tied > 0 ? el('span', { class: 'chip apart' }, `${ring.tied} of them in this cluster`) : ''))))
    }
    detail.push(section)
  }

  const history = el('table', {}, el('tr', {}, th('When'), th('Doing'), th('Seen with')))
  for (const sighting of profile.history) history.append(el('tr', {}, td('', when(sighting.at)), td('', sighting.event ?? ''), td('who', sighting.identifier)))
  detail.push(el('section', {}, el('h2', {}, `Sightings, newest ${profile.history.length}`), wide('Sightings', history)))
  return detail
}

const ACTIONS = { ignore: 'Stopped linking through', restore: 'Resumed linking through', separate: 'Kept apart', rejoin: 'Allowed to join', join: 'Joined', forget: 'Forgot', rebuild: 'Rebuilt every cluster', prune: 'Deleted sightings older than' }
const queued = (cluster) => el('li', {}, open(cluster.id), el('span', { class: 'muted' }, ` ${cluster.size} accounts `), cluster.oversized ? el('span', { class: 'chip apart' }, 'review') : '')

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
  return [list, el('p', {}, more)]
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
    return el('li', {}, el('span', {}, `${ACTIONS[d.action] ?? d.action} `), ...(d.action === 'prune' ? [when(Number(d.about[0]))] : d.about).map((each) => el('span', { class: 'reason' }, each)),
      author(d.by), el('span', { class: 'muted' }, `, ${when(d.at)}${d.reason ? `: ${d.reason}` : ''} `),
      d.action === 'ignore' && newest ? el('button', { class: 'link', 'data-key': `decision-${d.seq}`, on: { click: () => act('Resume linking through this identifier', d.about[0], '/ignore', { identifier: d.about[0], ignored: false }, 'Resume') } }, 'undo') : '')
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
  return el('section', {}, el('h2', {}, 'Decisions, newest first'), el('div', { class: 'row' }, pick),
    el('p', { id: 'seal', class: audit.sound ? 'muted' : 'apart' }, audit.sound ? `${amount(page.total)} recorded in all. The record is whole.` : `The record was altered at entry ${audit.brokenAt}.`),
    list, el('p', {}, more))
}

view('accounts', 'Accounts', async (box, subject) => {
  const left = el('div')
  const detail = el('div', { id: 'detail' })
  box.append(el('div', { class: `split${subject ? ' opened' : ''}` }, left, detail))
  const [queue, audit, recent, profile] = await Promise.all([clusterList(), api('GET', '/audit'), api('GET', '/recent'), subject ? api('GET', `/subject?subject=${encodeURIComponent(subject)}`) : undefined])
  const decisions = await decisionList(audit)

  left.append(el('section', {}, el('h2', {}, 'Largest clusters, now'), ...queue))
  left.append(el('section', {}, el('h2', {}, 'Recent changes, newest 30'), el('ul', { id: 'recent' }, ...(recent.length > 0 ? recent.slice(0, 30).map((move) => el('li', {}, open(move.subject),
    el('span', {}, move.to === undefined ? ' was removed ' : move.to === move.subject ? ' is on its own again ' : ' joined '), move.to !== undefined && move.to !== move.subject ? open(move.to) : '',
    el('span', { class: 'muted' }, ` ${when(move.at)}`))) : [el('li', { class: 'muted' }, 'None yet.')]))))
  left.append(decisions)

  detail.append(...(profile ? profileOf(profile) : [el('section', {}, el('p', { class: 'muted' }, 'Open a subject, or pick a cluster, to see who it is tied to and why.'))]))
})
