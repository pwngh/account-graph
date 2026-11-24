// What this screen passed over and what it decided, until it is closed. Neither is stored: a skip says nothing about the pair.
const skipped = new Set()
const decided = []
/** The pair on screen, which is what the keys act on and what a refresh keeps. Read from the screen: a load that gives way changes nothing. */
const facing = () => $('view').querySelector('section.pair')?.pair
/** The name of a pair picked from the list. */
let picked
const pairName = ({ a, b }) => `${a}\n${b}`

/** One of the two, from what was last recorded about it. */
function side(profile) {
  const { subject, history } = profile
  const count = (list) => Object.entries(list.reduce((out, each) => ({ ...out, [each]: (out[each] ?? 0) + 1 }), {})).sort(([, x], [, y]) => y - x).map(([name, n]) => `${name} (${amount(n)})`).join(', ')
  const own = [...new Set(history.map((sighting) => sighting.identifier))].map((identifier) => identifier.slice(0, identifier.indexOf(':')))
  const part = (name, ...told) => [el('dt', {}, name), el('dd', {}, ...told)]
  return el('section', { 'aria-label': subject }, el('div', { class: 'section-head' }, el('h3', {}, open(subject)),
    el('a', { class: 'link', href: `#/journey/${encodeURIComponent(subject)}` }, 'Journey')),
    el('dl', {}, ...part('Cluster', profile.cluster && profile.cluster.members.length > 1 ? `one of ${amount(profile.cluster.members.length)}${profile.cluster.oversized ? ', larger than the review size' : ''}` : 'on its own'),
      ...part('Seen', ...(history.length === 0 ? [unrecorded()] : [
        reviewDisplay.time(history.at(-1).at), ' to ', reviewDisplay.time(history[0].at), el('span', { class: 'reason' }, `Newest ${amount(history.length)} sightings`),
      ])),
      ...part('Doing', count(history.map((sighting) => sighting.event ?? '(not recorded)')) || '(not recorded)'),
      ...part('Seen with', count(own) || '(not recorded)'),
      ...part('Kept apart', profile.separated.length === 0 ? 'From nobody' : `From ${amount(profile.separated.length)}`)))
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

  if (pair) {
    const [left, right] = await Promise.all([pair.a, pair.b].map((subject) => api('GET', `/subject?subject=${encodeURIComponent(subject)}`)))
    const button = (kind, key, text, name) => el('button', { ...(kind && { class: kind }), title: `Key ${key.toUpperCase()}`, 'aria-keyshortcuts': key, on: { click: () => choices[name](pair) } }, `${text} (${key.toUpperCase()})`)
    const actions = el('div', { class: 'row' }, button('primary', 'j', 'Join', 'join'), button('danger', 'k', 'Keep apart', 'apart'), button('', 's', 'Skip', 'skip'),
      el('button', { title: 'Key U', 'aria-keyshortcuts': 'u', ...(decided.length === 0 && { disabled: '' }), on: { click: () => undo(decided[0]) } }, 'Undo last (U)'))
    const here = el('section', { class: 'pair', 'aria-label': 'This pair' }, reviewDisplay.section('This pair', actions),
      el('div', { class: 'row' }, reviewDisplay.chip(pair.level === 'same' ? 'Strong, kept in two clusters by a cut' : 'Related', pair.level),
        el('b', {}, reviewDisplay.compare(percent(pair.score), pair.score))),
      el('div', { class: 'why' }, ...reasons(pair.reasons)),
      el('div', { class: 'sides' }, side(left), side(right)))
    here.pair = pair
    box.append(here)
  } else box.append(el('section', {}, el('p', { class: 'muted' }, found.total === 0 ? 'No unjoined ties among the subjects checked.' : 'Every pair in this list was skipped.')))

  const lists = el('div', { class: 'panel-grid' })
  if (decided.length > 0) lists.append(el('section', {}, el('h2', {}, 'Decided here, newest first'), el('ul', {}, ...decided.map((entry) => el('li', {}, entry.what === 'join' ? 'Joined ' : 'Kept apart ', open(entry.a), ' and ', open(entry.b), ' ',
    el('button', { class: 'link', 'data-key': `undo-${entry.what}-${pairName(entry)}`, on: { click: () => undo(entry) } }, 'undo'))))))
  const rest = queue.filter((each) => each !== pair)
  if (rest.length > 0) {
    const table = el('table', {}, el('tr', {}, th('First subject'), th('Second subject'), th('Score', 'num'), th('Evidence'), th('Action')), ...rest.slice(0, 20).map((each) => el('tr', {}, td('who', open(each.a)), td('who', open(each.b)), td('num score', reviewDisplay.compare(percent(each.score), each.score)),
      td('', [...new Set(each.reasons.filter((reason) => reason.counted !== false).map((reason) => reason.identifier.split(':')[0]))].join(', ')),
      td('', el('button', { class: 'link', 'data-key': pairName(each), on: { click: async () => { picked = pairName(each); await load(); picked = undefined } } }, 'look')))))
    lists.append(el('section', {}, el('h2', {}, `Next${rest.length > 20 ? ', first 20' : ''}`), wide('Next', table, true)))
  }
  if (lists.childElementCount > 0) box.append(lists)
})

addEventListener('keydown', (event) => {
  if (place().name !== 'decide' || $('ask').open || pending > 0 || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.target.closest('input, select, textarea, dialog')) return
  const name = { j: 'join', k: 'apart', s: 'skip' }[event.key.toLowerCase()]
  if (event.key.toLowerCase() === 'u') undo(decided[0])
  else if (name && facing()) choices[name](facing())
  else return
  event.preventDefault()
})
