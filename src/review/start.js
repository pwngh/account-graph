for (const [name, { title }] of views) $('views').append(el('a', { href: `#/${name}`, 'data-view': name }, title))

const enter = (token) => {
  $('token').value = token
  sessionStorage.setItem('token', token)
  beat = undefined
  signedIn(undefined)
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
  const text = $('subject').value.trim()
  const token = $('token').value
  if (!text || !token) return
  try {
    const { by, subjects } = await find(text)
    if ($('token').value !== token || $('subject').value.trim() !== text) return
    if (by === 'subject') return void go(subjectHash(subjects.length === 1 ? subjects[0] : text))
    if (subjects.length === 1) return void go(subjectHash(subjects[0]))
    suggest(subjects)
    if (subjects.length === 0) return void notice(`Nobody has been seen with that ${by === 'email' ? 'email' : 'phone number'}.`)
    $('subject').value = ''
    $('subject').focus()
    notice(`${subjects.length === 20 ? 'At least 20' : subjects.length} subjects have that ${by === 'email' ? 'email' : 'phone number'}. Pick one from the list: ${subjects.join(', ')}`)
  } catch (error) {
    notice(error.message, true)
  }
})

// Suggest subjects as the reviewer types, a moment after the last key.
let typing
$('subject').addEventListener('input', () => {
  clearTimeout(typing)
  typing = setTimeout(async () => {
    const text = $('subject').value.trim()
    const token = $('token').value
    if (!text || !token) return
    try {
      const { subjects } = await find(text)
      if ($('token').value === token && $('subject').value.trim() === text) suggest(subjects)
    } catch {}
  }, 200)
})

addEventListener('hashchange', () => load())
document.addEventListener('visibilitychange', look)
setInterval(look, EVERY)
load()
