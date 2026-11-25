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
  // What was looked for is the reviewer's, as what was asked and shown is.
  for (const id of ['ask-title', 'ask-text', 'ask-effect', 'ask-problem']) $(id).replaceChildren()
  for (const id of ['ask-other', 'ask-reason', 'subject']) $(id).value = ''
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
    const what = by === 'email' ? 'that email' : by === 'phone' ? 'that phone number' : by === 'click' ? 'that ad click' : 'that ID'
    if (subjects.length === 0) return void notice(`No results for ${what}.`)
    $('subject').value = ''
    $('subject').focus()
    notice(`${subjects.length === 20 ? '20 or more' : subjects.length} results for ${what}: ${subjects.join(', ')}`)
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
// The address says which view is open, so the link past the list of views moves the focus and nothing else.
document.querySelector('.skip').addEventListener('click', (event) => { event.preventDefault(); $('view').focus() })
addEventListener('hashchange', () => load())
document.addEventListener('visibilitychange', look)
setInterval(look, EVERY)
load()
