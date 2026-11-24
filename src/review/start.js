for (const [name, { title }] of views) $('views').append(el('a', { href: `#/${name}`, 'data-view': name }, title))

$('token').addEventListener('change', () => { sessionStorage.setItem('token', $('token').value); beat = undefined; load() })
$('by').addEventListener('change', () => localStorage.setItem('by', $('by').value))
$('find').addEventListener('submit', (event) => {
  event.preventDefault()
  // In a view about a subject, the one typed opens there. Elsewhere it opens its account.
  const { name } = place()
  go(`#/${views.get(name).subject ? name : 'accounts'}/${encodeURIComponent($('subject').value.trim())}`)
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
      const found = await api('GET', `/search?q=${encodeURIComponent(text)}`)
      if ($('token').value === token) $('found').replaceChildren(...found.map((subject) => el('option', { value: subject })))
    } catch {}
  }, 200)
})

addEventListener('hashchange', () => load())
document.addEventListener('visibilitychange', look)
setInterval(look, EVERY)
load()
