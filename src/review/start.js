const VIEW_ICONS = {
  accounts: 'M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8ZM2.8 13.4c.5-2.5 2.5-3.8 5.2-3.8s4.7 1.3 5.2 3.8',
  journey: 'M2 8h2.6M11.4 8H14M6.2 8a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0M3.6 3.5v9M12.4 3.5v9',
  board: 'M2.5 3h3v10h-3zM6.8 3h3v6.5h-3zM11 3h3v8.2h-3z',
  decide: 'M8 2.5v11M8 4.2 3.4 5.6M8 4.2l4.6 1.4M1.6 9.4 3.4 5.6l1.8 3.8a1.9 1.9 0 0 1-3.6 0M10.8 9.4l1.8-3.8 1.8 3.8a1.9 1.9 0 0 1-3.6 0',
  calls: 'M3.2 2.8h2.4l1.2 3-1.6 1.1a8 8 0 0 0 3.9 3.9l1.1-1.6 3 1.2v2.4c0 .5-.4.9-.9.9A9.9 9.9 0 0 1 2.3 3.7c0-.5.4-.9.9-.9Z',
  channels: 'M2.5 13.5h11M4 11V7.5M8 11V3M12 11V5.8',
  health: 'M1.8 8.4h2.8l1.7-4.6 3 8.4 1.7-3.8h3.2',
}
for (const [name, { title }] of views) $('views').append(el('a', { href: `#/${name}`, 'data-view': name }, svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: VIEW_ICONS[name] })), title))

const enter = (token) => {
  $('token').value = token
  sessionStorage.setItem('token', token)
  beat = undefined
  edits += 1
  signedIn(undefined)
  // What one reviewer skipped or decided here is not the next one's to undo.
  skipped.clear()
  decided.length = 0
  redrawn()
  drawn.spots.clear()
  drawn.off.clear()
  narrowed.clear()
  opened.length = 0
  inbox.id = charted.subject = undefined
  load()
}
$('token').addEventListener('change', () => enter($('token').value))
$('leave').addEventListener('click', () => {
  enter('')
  $('token').focus()
})
// What is typed may be a phone number or an email, so it is sent in a body and never put in an address.
const find = (text) => api('POST', '/find', { text })
const suggest = (subjects) => $('found').replaceChildren(...subjects.map((subject) => el('option', { value: subject })))
$('find').addEventListener('submit', async (event) => {
  event.preventDefault()
  const asked = ++edits
  const text = $('subject').value.trim()
  const token = $('token').value
  if (!text || !token) return
  // Something typed since, another reviewer, or a view that has put its own subject in the box is newer than this.
  const current = () => edits === asked && $('token').value === token && $('subject').value.trim() === text
  try {
    const { by, subjects } = await find(text)
    if (!current()) return
    // Only what the server answered with is ever put in the address.
    const whole = subjects.length === 1 ? subjects[0] : by === 'subject' && subjects.find((each) => each === text)
    if (whole) return void go(subjectHash(whole))
    suggest(subjects)
    const what = by === 'email' ? 'that email' : by === 'phone' ? 'that phone number' : by === 'click' ? 'that ad click' : 'an id that begins like that'
    if (subjects.length === 0) return void notice(`Nobody has been seen with ${what}.`)
    $('subject').value = ''
    $('subject').focus()
    notice(`${subjects.length === 20 ? 'At least 20' : subjects.length} subjects have ${what}. Pick one from the list: ${subjects.join(', ')}`)
  } catch (error) {
    if (current()) notice(error.message, true)
  }
})

// Suggest subjects as the reviewer types, a moment after the last key.
let typing
$('subject').addEventListener('input', () => {
  const asked = ++edits
  clearTimeout(typing)
  typing = setTimeout(async () => {
    const text = $('subject').value.trim()
    const token = $('token').value
    if (!text || !token || edits !== asked) return
    try {
      const { subjects } = await find(text)
      if (edits === asked && $('token').value === token && $('subject').value.trim() === text) suggest(subjects)
    } catch {}
  }, 200)
})

if (/Mac|iPhone|iPad/.test(navigator.platform)) $('summon-key').textContent = '⌘ K'
$('summon').addEventListener('click', () => palette.show())
addEventListener('hashchange', () => load())
document.addEventListener('visibilitychange', look)
setInterval(look, EVERY)
load()
