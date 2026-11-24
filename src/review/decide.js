// What this screen passed over and what it decided, until it is closed. Neither is stored: a skip says nothing about the pair.
const skipped = new Set()
const decided = []
/** The pair on screen, which is what the keys act on and what a refresh keeps. Read from the screen: a load that gives way changes nothing. */
const facing = () => $('view').querySelector('section.pair')?.pair
/** The name of a pair picked from the list. */
let picked
const pairName = ({ a, b }) => `${a}\n${b}`

/** What is known of two subjects, line by line beside each other, with what they have alike brought forward. */
function compared(left, right, pair) {
  const kindsOf = ({ history }) => new Set(history.map((sighting) => sighting.identifier.slice(0, sighting.identifier.indexOf(':'))))
  const doing = ({ history }) => new Set(history.map((sighting) => sighting.event).filter(Boolean))
  const [kinds, others] = [kindsOf(left), kindsOf(right)]
  const [did, done] = [doing(left), doing(right)]
  const chips = (mine, theirs) => (mine.size === 0 ? [unrecorded()] : [...mine].sort((x, y) => theirs.has(y) - theirs.has(x)).map((each) => reviewDisplay.chip(each.replaceAll('_', ' '), theirs.has(each) ? 'alike' : 'muted')))
  const cluster = ({ cluster }) => (cluster && cluster.members.length > 1 ? `one of ${amount(cluster.members.length)}${cluster.oversized ? ', larger than the review size' : ''}` : 'on its own')
  const seen = ({ history }) => (history.length === 0 ? [unrecorded()] : [reviewDisplay.time(history.at(-1).at), ' to ', reviewDisplay.time(history[0].at), el('span', { class: 'reason' }, `Newest ${amount(history.length)} sightings`)])
  const apart = ({ separated }) => (separated.length === 0 ? 'From nobody' : `From ${amount(separated.length)}`)
  const who = ({ subject }) => el('div', { class: 'versus-who' }, badge(subject), el('b', {}, open(subject)), el('a', { class: 'link', href: `#/journey/${encodeURIComponent(subject)}` }, 'Journey'))
  const row = (name, one, two) => el('div', { class: 'versus-row', role: 'row' }, el('div', { role: 'cell' }, ...one), el('div', { class: 'versus-name', role: 'rowheader' }, name), el('div', { role: 'cell' }, ...two))
  const shared = [...new Set(pair.reasons.filter((reason) => reason.counted !== false).map((reason) => reason.identifier.split(':')[0]))]
  return el('div', { class: 'versus', role: 'table', 'aria-label': 'The two, side by side' },
    el('div', { class: 'versus-row head', role: 'row' }, el('div', { role: 'columnheader' }, who(left)), el('div', { class: 'versus-score', role: 'columnheader' }, dial(pair.score), el('span', { class: 'meta' }, shared.length > 0 ? `by ${shared.join(', ')}` : '')), el('div', { role: 'columnheader' }, who(right))),
    row('Seen with', chips(kinds, others), chips(others, kinds)),
    row('Doing', chips(did, done), chips(done, did)),
    row('Seen', seen(left), seen(right)),
    row('Cluster', [cluster(left)], [cluster(right)]),
    row('Kept apart', [apart(left)], [apart(right)]))
}
/** A score as a ring around its number. */
function dial(score) {
  const round = 2 * Math.PI * 26
  return svg('svg', { class: 'dial', viewBox: '0 0 64 64', role: 'img', 'aria-label': percent(score) }, svg('circle', { cx: 32, cy: 32, r: 26 }), svg('circle', { class: 'part', cx: 32, cy: 32, r: 26, 'stroke-dasharray': `${(round * score).toFixed(1)} ${round.toFixed(1)}` }), svg('text', { x: 32, y: 37, 'text-anchor': 'middle' }, percent(score)))
}

const choices = {
  join: (pair) => act('Join as one person', `${pair.a} and ${pair.b} will be treated as one person.`, '/join', { a: pair.a, b: pair.b, mark: true }, 'Join', { done: ({ mark }) => decided.unshift({ ...pair, what: 'join', mark }) }),
  apart: (pair) => act('Keep these two apart', `${pair.a} and ${pair.b} will never share a cluster, whatever they share later.`, '/separate', { a: pair.a, b: pair.b }, 'Keep apart', { done: () => decided.unshift({ ...pair, what: 'apart' }) }),
  skip: (pair) => { skipped.add(pairName(pair)); load() },
}

/** Takes a decision back with a new one: a separation is withdrawn, and the mark a join left links no longer. Nothing is erased: the record shows both. */
function undo(entry) {
  if (!entry) return
  const gone = () => decided.splice(decided.indexOf(entry), 1)
  if (entry.what === 'apart') return act('Allow these two to join again', `${entry.a} and ${entry.b}`, '/separate', { a: entry.a, b: entry.b, separated: false }, 'Allow', { undo: true, done: gone })
  return act('Undo the join', `${entry.a} and ${entry.b} will no longer be linked by that decision.`, '/ignore', { identifier: entry.mark }, 'Undo', { undo: true, done: gone })
}

// Pairs that share something and were not joined, one at a time, strongest first.
view('decide', 'Decide', async (box) => {
  // The record first, so a decision that lands while the rest is read refuses one made on it.
  box.dataset.seen = (await api('GET', '/decisions?limit=1')).decisions[0]?.seq ?? 0
  const found = await api('GET', `/undecided?limit=${Math.min(500, 50 + skipped.size)}`)
  const queue = found.pairs.filter((pair) => !skipped.has(pairName(pair)))
  const kept = picked ?? (facing() && pairName(facing()))
  const pair = queue.find((each) => pairName(each) === kept) ?? queue[0]
  const passed = found.pairs.length - queue.length
  const reset = () => {
    skipped.clear()
    load()
  }
  box.append(el('section', {}, reviewDisplay.heading('Decide',
    passed > 0 ? el('button', { on: { click: reset } }, 'Show them again') : ''),
  tiles(['Related, not joined', amount(found.total), 'Strongest first'], ['Subjects checked', amount(found.seen), 'From the newest 10,000 sightings'],
    passed > 0 && ['Skipped', amount(passed), 'Until this screen is closed']),
  notes('Only subjects in the newest 10,000 sightings are checked. Pairs of subjects not seen in those sightings are not listed.')))

  const rail = el('div', { class: 'queue-rail scroll', tabindex: 0, role: 'region', 'aria-label': 'Next' })
  const kindsIn = (each) => [...new Set(each.reasons.filter((reason) => reason.counted !== false).map((reason) => reason.identifier.split(':')[0]))].join(', ')
  const card = (each) => el('button', { type: 'button', class: 'queue-pair', 'data-key': pairName(each), ...(each === pair && { 'aria-current': 'true' }), on: { click: async () => { picked = pairName(each); await load(); picked = undefined } } },
    el('span', { class: 'queue-names' }, el('span', { title: each.a }, reviewDisplay.idText(each.a)), el('span', { title: each.b }, reviewDisplay.idText(each.b))), el('b', {}, percent(each.score)), el('span', { class: 'meta' }, kindsIn(each)), meter(each.score))
  const strong = queue.filter((each) => each.level === 'same')
  const weak = queue.filter((each) => each.level !== 'same')
  for (const [name, list] of [['Strong, held apart by a cut', strong], ['Related', weak]]) if (list.length > 0) rail.append(el('p', { class: 'inbox-age' }, name, el('span', { class: 'count' }, amount(list.length))), ...list.slice(0, 40).map(card), list.length > 40 ? el('p', { class: 'meta queue-more' }, `${amount(list.length - 40)} more after these.`) : '')

  if (pair) {
    const [left, right] = await Promise.all([pair.a, pair.b].map((subject) => api('GET', `/subject?subject=${encodeURIComponent(subject)}`)))
    const button = (kind, key, text, name) => el('button', { class: `choice ${kind}`, title: `Key ${key.toUpperCase()}`, 'aria-keyshortcuts': key, on: { click: () => choices[name](pair) } }, text, el('kbd', {}, key.toUpperCase()))
    const at = queue.indexOf(pair)
    const here = el('section', { class: 'pair', 'aria-label': 'This pair' },
      el('div', { class: 'pair-top' }, reviewDisplay.chip(pair.level === 'same' ? 'Strong, kept in two clusters by a cut' : 'Related', pair.level), el('span', { class: 'meta' }, `${amount(at + 1)} of ${amount(queue.length)} here`)),
      compared(left, right, pair),
      el('div', { class: 'pair-why' }, el('p', { class: 'inbox-age' }, 'What they share'), ...reasons(pair.reasons)),
      el('p', { class: 'pair-effect', role: 'status' }),
      el('div', { class: 'choices' }, button('primary', 'j', 'Join', 'join'), button('danger', 'k', 'Keep apart', 'apart'), button('', 's', 'Skip', 'skip'),
        el('button', { class: 'choice quiet', title: 'Key U', 'aria-keyshortcuts': 'u', ...(decided.length === 0 && { disabled: '' }), on: { click: () => undo(decided[0]) } }, 'Undo last', el('kbd', {}, 'U'))))
    here.pair = pair
    const said = here.querySelector('.pair-effect')
    // What joining would make of them, worked out and not done. The pair can be decided without it.
    api('POST', '/foresee', { action: 'join', a: pair.a, b: pair.b }).then(({ moved, after }) => { said.textContent = moved === 0 ? 'Joining them would change no cluster.' : `Joined, they would be ${people(after)}.` }, () => {})
    box.append(el('div', { class: 'deck' }, rail, here))
    // Once it is on the page, the one in front is brought into view in the queue, without moving the page.
    setTimeout(() => {
      const now = rail.querySelector('[aria-current]')
      if (now && (now.offsetTop < rail.scrollTop || now.offsetTop + now.offsetHeight > rail.scrollTop + rail.clientHeight)) rail.scrollTop = now.offsetTop - rail.clientHeight / 2
    })
  } else box.append(el('section', {}, el('p', { class: 'muted' }, found.total === 0 ? 'No unjoined ties among the subjects checked.' : 'Every pair in this list was skipped.')))

  if (decided.length > 0) box.append(el('section', {}, el('h2', {}, 'Decided here, newest first'), el('ul', { class: 'decided' }, ...decided.map((entry) => el('li', {}, reviewDisplay.chip(entry.what === 'join' ? 'Joined' : 'Kept apart', entry.what === 'join' ? 'same' : 'apart'), open(entry.a), ' and ', open(entry.b), ' ',
    el('button', { class: 'link', 'data-key': `undo-${entry.what}-${pairName(entry)}`, on: { click: () => undo(entry) } }, 'undo'))))))
})

addEventListener('keydown', (event) => {
  if (place().name !== 'decide' || $('ask').open || pending > 0 || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.target.closest('input, select, textarea, dialog')) return
  const name = { j: 'join', k: 'apart', s: 'skip' }[event.key.toLowerCase()]
  if (event.key.toLowerCase() === 'u') undo(decided[0])
  else if (name && facing()) choices[name](facing())
  else return
  event.preventDefault()
})
