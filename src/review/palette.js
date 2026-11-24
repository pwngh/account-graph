/** Subjects opened here, newest first, until this screen is closed or signed out of. */
const opened = []
const remember = (subject) => {
  if (opened.includes(subject)) opened.splice(opened.indexOf(subject), 1)
  opened.unshift(subject)
  opened.length = Math.min(opened.length, 8)
}
const KNOWN_KINDS = ['account', 'visitor', 'lead', 'caller', 'contact', 'person']
/** What can be done with whoever is open. Each asks before it does anything, as the buttons of the view do. */
function actions() {
  const { name, parts: [subject] } = place()
  if (!subject || !['accounts', 'journey'].includes(name)) return []
  return [
    name === 'accounts' ? ['Open their journey', () => go(`#/journey/${encodeURIComponent(subject)}`)] : ['Open their account', () => go(subjectHash(subject))],
    ...(name === 'accounts' ? [['Join with another…', () => act('Join as one person', `${subject} and the subject you name will be treated as one person.`, '/join', { a: subject }, 'Join', { otherKey: 'b' })]] : []),
  ].map(([text, run]) => ({ group: subject, text, run, mark: '>' }))
}
/** Whether every letter typed is in a text, in order, and how well: at the start of words and together is better. */
function matched(text, typed) {
  const [whole, part] = [text.toLowerCase(), typed.toLowerCase()]
  let at = -1
  let score = 0
  const places = []
  for (const letter of part) {
    const next = whole.indexOf(letter, at + 1)
    if (next < 0) return undefined
    score += next === at + 1 ? 3 : next === 0 || /[\s:.-]/.test(whole[next - 1]) ? 2 : 0
    places.push(next)
    at = next
  }
  return { score: score - whole.length / 100, places }
}

const palette = el('dialog', { id: 'palette', 'aria-label': 'Find or do' })
{
  const input = el('input', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Find or do', placeholder: 'Find someone, or go somewhere', autocomplete: 'off', spellcheck: 'false' })
  const list = el('div', { id: 'palette-list', role: 'listbox', 'aria-label': 'Results' })
  const keys = (...each) => el('span', {}, ...each.map((key) => el('kbd', {}, key)))
  palette.append(el('div', { class: 'palette-top' }, el('i', { class: 'glass', 'aria-hidden': 'true' }), input, el('kbd', {}, 'esc')), list,
    el('div', { class: 'palette-foot' }, keys('Up', 'Down'), 'to move', keys('Enter'), 'to open'))
  document.body.append(palette)
  let shown = []
  let at = 0
  let people = []
  let waiting
  let looking = false
  let turn = 0

  const commands = () => [
    ...actions(),
    ...[...views].map(([name, { title }]) => ({ group: 'Go to', text: title, run: () => go(`#/${name}`), icon: VIEW_ICONS[name] })),
    { group: 'Go to', text: 'Read this again', run: () => load(), icon: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.6h-2.6' },
  ]
  function draw() {
    const typed = input.value.trim()
    const some = [
      ...people,
      ...(typed ? opened.map((subject) => ({ group: 'Opened here', text: subject, subject, run: () => go(subjectHash(subject)) })).filter(({ subject }) => !people.some((each) => each.subject === subject)) : []),
      ...commands(),
      ...(typed ? [] : opened.map((subject) => ({ group: 'Opened here', text: subject, subject, run: () => go(subjectHash(subject)) }))),
    ]
    const held = some.map((item) => ({ ...item, match: typed && !item.found ? matched(item.text, typed) : { score: 99, places: [] } })).filter((item) => item.match)
    // Groups keep their order; within one, the best match is first.
    const groups = [...new Set(held.map((item) => item.group))]
    shown = groups.flatMap((group) => held.filter((item) => item.group === group).sort((x, y) => (typed ? y.match.score - x.match.score : 0)))
    at = Math.min(at, Math.max(0, shown.length - 1))
    list.replaceChildren(...groups.map((group) => el('div', { role: 'group', 'aria-label': group }, el('p', { class: 'inbox-age' }, group), ...shown.filter((item) => item.group === group).map((item) => {
      const i = shown.indexOf(item)
      const letters = [...item.text].map((letter, n) => (item.match.places.includes(n) ? el('mark', {}, letter) : letter))
      return el('div', { id: `palette-${i}`, class: 'palette-item', role: 'option', 'aria-selected': String(i === at), title: item.text, on: { click: () => choose(i), pointermove: () => { if (at !== i) { at = i; point() } } } }, item.subject ? badge(item.subject) : el('i', { class: 'palette-mark', 'aria-hidden': 'true' }, item.icon ? svg('svg', { viewBox: '0 0 16 16', focusable: 'false' }, svg('path', { d: item.icon })) : item.mark), el('span', {}, ...letters), item.note ? el('span', { class: 'meta' }, item.note) : '')
    }))))
    if (shown.length === 0) list.replaceChildren(el('p', { class: 'muted palette-none' }, looking ? 'Looking.' : 'Nothing by that name.'))
    point()
  }
  function point() {
    for (const [i, item] of [...list.querySelectorAll('.palette-item')].entries()) item.setAttribute('aria-selected', String(i === at))
    if (shown.length > 0) input.setAttribute('aria-activedescendant', `palette-${at}`)
    else input.removeAttribute('aria-activedescendant')
    list.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' })
  }
  function choose(i) {
    const item = shown[i]
    if (!item) return
    palette.close()
    item.run()
  }
  input.addEventListener('input', () => {
    at = 0
    people = []
    clearTimeout(waiting)
    const asked = ++turn
    const text = input.value.trim()
    const token = $('token').value
    looking = Boolean(text && token)
    draw()
    // What is typed may be a phone number or an email, so it is sent in a body and never put in an address.
    if (text && token) waiting = setTimeout(async () => {
      try {
        let { by, subjects } = await find(text)
        // A name is enough, without the kind before it: the kinds of subject there are known to be are tried.
        if (subjects.length === 0 && by === 'subject' && !text.includes(':')) subjects = (await Promise.all(KNOWN_KINDS.map((kind) => find(`${kind}:${text}`)))).flatMap((each) => each.subjects)
        if (asked !== turn || !palette.open || $('token').value !== token) return
        people = subjects.slice(0, 8).map((subject) => ({ group: 'People', text: subject, subject, found: true, note: by === 'subject' ? '' : `by ${by === 'click' ? 'ad click' : by}`, run: () => go(subjectHash(subject)) }))
        looking = false
        draw()
      } catch {
        looking = false
        draw()
      }
    }, 160)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') at = (at + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length)
    else if (event.key === 'Enter') choose(at)
    else return
    event.preventDefault()
    if (event.key !== 'Enter') point()
  })
  // Pressed outside it, it goes.
  palette.addEventListener('click', (event) => event.target === palette && palette.close())
  palette.addEventListener('close', () => {
    turn += 1
    clearTimeout(waiting)
    input.value = ''
    people = []
  })
  palette.show = () => {
    if (palette.open || $('ask').open || !$('token').value) return
    at = 0
    palette.showModal()
    draw()
    input.focus()
  }
}
addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
  event.preventDefault()
  if (palette.open) palette.close()
  else palette.show()
})
