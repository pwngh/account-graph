function reasons(list) {
  return list.map((reason) => {
    const [kind] = reason.identifier.split(':')
    return el('span', { class: 'reason' }, el('b', {}, kind), ` ${percent(reason.evidence)}, shared by ${reason.fanout}, ${days(reason.gap)} `,
      el('button', { class: 'link', title: reason.identifier, on: { click: () => act('Stop linking through this identifier', reason.identifier, '/ignore', { identifier: reason.identifier }, 'Stop linking') } }, 'stop linking'))
  })
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
  for (const other of profile.separated) line(profile.subject, other, 'apart', 2, `${profile.subject} and ${other}: kept apart by a reviewer`)
  for (const [subject, [x, y]] of spot) {
    const me = subject === profile.subject
    const node = svg('circle', { class: `node${me ? ' me' : members.has(subject) ? ' member' : ''}`, cx: x, cy: y, r: me ? 11 : 8, tabindex: 0, role: 'link', 'aria-label': subject }, svg('title', {}, subject))
    node.addEventListener('click', () => go(subjectHash(subject)))
    node.addEventListener('keydown', (event) => event.key === 'Enter' && go(subjectHash(subject)))
    drawing.append(node, svg('text', { x, y: y + (y < 170 ? -14 : 22), 'text-anchor': 'middle' }, subject.length > 22 ? `${subject.slice(0, 21)}…` : subject))
  }
  return drawing
}

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
    el('p', { class: 'muted' }, 'Solid: joined. Dashed: tied, not joined. Dotted red: kept apart by a reviewer. Open a circle to see that subject.')))

  const members = new Set(profile.cluster.members)
  const links = el('table', {}, el('tr', {}, th('Subject'), th('Tie'), th('Score', 'num'), th('Why'), th('')))
  for (const link of profile.links) {
    const inCluster = members.has(link.subject)
    links.append(el('tr', {},
      td('who', open(link.subject)),
      td('', el('span', { class: `chip ${link.level}` }, link.level === 'same' ? (inCluster ? 'same person' : 'strong, not joined') : 'related')),
      td('num', percent(link.score)),
      td('why', ...reasons(link.reasons)),
      td('', el('button', { on: { click: () => act('Keep these two apart', `${profile.subject} and ${link.subject} will never share a cluster, whatever they share later.`, '/separate', { a: profile.subject, b: link.subject }, 'Keep apart') } }, 'Keep apart'))))
  }
  for (const other of profile.separated) {
    links.append(el('tr', {}, td('who', open(other)), td('', el('span', { class: 'chip apart' }, 'kept apart')), td(''), td('muted', 'A reviewer decided these are different people.'),
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
    try {
      const next = await api('GET', `/clusters?offset=${list.children.length}`)
      list.append(...next.map(queued))
      listed = list.children.length
      more.hidden = next.length < 50
    } catch (error) {
      notice(error.message, true)
    }
  } } }, 'Show more')
  more.hidden = clusters.length === 0 || clusters.length % 50 > 0
  return [list, el('p', {}, more)]
}

view('accounts', 'Accounts', async (box, subject) => {
  const left = el('div')
  const detail = el('div', { id: 'detail' })
  box.append(el('div', { class: `split${subject ? ' opened' : ''}` }, left, detail))
  const [queue, decisions, audit, recent, profile] = await Promise.all([clusterList(), api('GET', '/decisions'), api('GET', '/audit'), api('GET', '/recent'), subject ? api('GET', `/subject?subject=${encodeURIComponent(subject)}`) : undefined])

  left.append(el('section', {}, el('h2', {}, 'Largest clusters, now'), ...queue))
  left.append(el('section', {}, el('h2', {}, 'Recent changes, newest 30'), el('ul', { id: 'recent' }, ...(recent.length > 0 ? recent.slice(0, 30).map((move) => el('li', {}, open(move.subject),
    el('span', {}, move.to === undefined ? ' was removed ' : move.to === move.subject ? ' is on its own again ' : ' joined '), move.to !== undefined && move.to !== move.subject ? open(move.to) : '',
    el('span', { class: 'muted' }, ` ${when(move.at)}`))) : [el('li', { class: 'muted' }, 'None yet.')]))))
  // An ignore can be undone unless a later decision already restored that identifier.
  const restoredAt = new Map(decisions.filter((d) => d.action === 'restore').map((d) => [d.about[0], d.seq]))
  left.append(el('section', {}, el('h2', {}, 'Decisions, newest 30'),
    el('p', { id: 'seal', class: audit.sound ? 'muted' : 'apart' }, audit.sound ? `${decisions.length} recorded. The record is whole.` : `The record was altered at entry ${audit.brokenAt}.`),
    el('ul', { id: 'decisions' }, ...decisions.slice(-30).reverse().map((d) => el('li', {},
      el('span', {}, `${ACTIONS[d.action] ?? d.action} `), ...(d.action === 'prune' ? [when(Number(d.about[0]))] : d.about).map((each) => el('span', { class: 'reason' }, each)),
      el('span', { class: 'muted' }, `${when(d.at)}${d.by ? `, ${d.by}` : ''}${d.reason ? `: ${d.reason}` : ''} `),
      d.action === 'ignore' && !(restoredAt.get(d.about[0]) > d.seq) ? el('button', { class: 'link', on: { click: () => act('Resume linking through this identifier', d.about[0], '/ignore', { identifier: d.about[0], ignored: false }, 'Resume') } }, 'undo') : '')))))

  detail.append(...(profile ? profileOf(profile) : [el('section', {}, el('p', { class: 'muted' }, 'Open a subject, or pick a cluster, to see who it is tied to and why.'))]))
})
