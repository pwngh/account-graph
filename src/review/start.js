for (const [name, { title }] of views) $('views').append(el('a', { href: `#/${name}`, 'data-view': name }, title))

$('token').addEventListener('change', () => { sessionStorage.setItem('token', $('token').value); beat = undefined; load() })
$('by').addEventListener('change', () => localStorage.setItem('by', $('by').value))
$('find').addEventListener('submit', (event) => {
  event.preventDefault()
  const next = subjectHash($('subject').value.trim())
  // Opening what is already open reads it again.
  if (location.hash === next) load()
  else location.hash = next
})

// Suggest subjects as the reviewer types, a moment after the last key.
let typing
$('subject').addEventListener('input', () => {
  clearTimeout(typing)
  typing = setTimeout(async () => {
    const text = $('subject').value.trim()
    if (!text || !$('token').value) return
    try {
      const found = await api('GET', `/search?q=${encodeURIComponent(text)}`)
      $('found').replaceChildren(...found.map((subject) => el('option', { value: subject })))
    } catch {}
  }, 200)
})

addEventListener('hashchange', () => load())
document.addEventListener('visibilitychange', look)
setInterval(look, EVERY)
load()
