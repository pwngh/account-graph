'use strict'
const $ = (id) => document.getElementById(id)
// Everything from the server is shown with textContent, never as markup.
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler)
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : String(child))
  return node
}
const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  for (const child of children) node.append(child instanceof Node ? child : String(child))
  return node
}
const when = (at) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const percent = (score) => `${Math.round(score * 100)}%`
const days = (gap) => {
  if (gap === 0) return 'seen together'
  const count = Math.round(gap / 86400000)
  return count < 1 ? 'seen within a day' : `seen ${count} ${count === 1 ? 'day' : 'days'} apart`
}
const amount = (n) => n.toLocaleString()
const money = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const th = (text, kind) => el('th', { scope: 'col', ...(kind && { class: kind }) }, text)
const td = (kind, ...children) => el('td', kind ? { class: kind } : {}, ...children)
/** A table that scrolls inside its own box. The box takes the keyboard, so arrow keys can scroll it. */
const wide = (label, table) => el('div', { class: 'wide', tabindex: 0, role: 'region', 'aria-label': label }, table)

$('token').value = sessionStorage.getItem('token') ?? ''
$('by').value = localStorage.getItem('by') ?? ''
$('zone').textContent = `Times are shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}, this browser's zone.`

function notice(text, bad = false) {
  $('notice').textContent = text
  $('notice').className = bad ? 'bad' : ''
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${$('token').value}`, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (response.status === 204) return undefined
  const answer = await response.json()
  if (!response.ok) throw new Error(response.status === 401 ? 'The access token was refused.' : answer.error ?? `Request failed with ${response.status}`)
  return answer
}

/**
 * Asks the reviewer to confirm, with a reason. With `wantsOther`, also asks
 * which other subject. Resolves to what was typed, or undefined when cancelled.
 */
function ask(title, text, confirm = 'Confirm', wantsOther = false) {
  $('ask-title').textContent = title
  $('ask-text').textContent = text
  $('ask-yes').textContent = confirm
  $('ask-reason').value = ''
  $('ask-other').value = ''
  $('ask-other').required = wantsOther
  $('ask-other-label').hidden = !wantsOther
  return new Promise((resolve) => {
    const answer = () => ($('ask').returnValue === 'yes' ? { reason: $('ask-reason').value.trim(), other: $('ask-other').value.trim() } : undefined)
    $('ask').addEventListener('close', () => resolve(answer()), { once: true })
    // Clear the last answer first, so closing with Escape can never repeat an earlier "yes".
    $('ask').returnValue = ''
    $('ask').showModal()
  })
}

/** Runs one reviewer action, reloads what is on screen, then says what happened. `otherKey` names the body field for a second subject to ask for. */
async function act(title, text, path, body, confirm, otherKey) {
  const answer = await ask(title, text, confirm, Boolean(otherKey))
  if (answer === undefined) return
  let outcome
  try {
    const moved = await api('POST', path, { ...body, ...(otherKey && { [otherKey]: answer.other }), by: $('by').value.trim() || undefined, reason: answer.reason || undefined })
    // These routes answer with the subjects whose cluster moved. None is a real outcome, so say so.
    outcome = [Array.isArray(moved) && moved.length === 0 ? `${title}: recorded. No cluster changed.` : `${title}: done.`, false]
  } catch (error) {
    outcome = [error.message, true]
  }
  // Reloading clears the notice, so speak after it. A failed reload has already said why.
  if ((await load()) || outcome[1]) notice(...outcome)
}

/** Goes to an address. Going where the screen already is reads it again. */
const go = (hash) => (location.hash === hash ? load() : (location.hash = hash))
/** Who decided: a person's name as it is, a system marked as one. */
const author = (by) => (by?.startsWith('system:') ? el('span', { class: 'chip', title: 'Sent by another system, not decided by a person here' }, `system ${by.slice(7)}`) : el('span', {}, by || '(no name recorded)'))
const subjectHash = (subject) => `#/accounts/${encodeURIComponent(subject)}`
const open = (subject) => el('a', { class: 'link', href: subjectHash(subject) }, subject)

/**
 * The views, in the order of the menu. Each has a `title` and
 * `show(box, ...parts)`, which fills the box from what the address names
 * after the view. What it throws is shown as a problem. A view whose answer
 * depends on the time of day says with `every` how often to read it again,
 * and one that is about a subject says so with `subject`.
 */
const views = new Map()
const view = (name, title, show, { every, subject } = {}) => views.set(name, { title, show, every, subject })

/** The view an address names, with the parts that follow it. Addresses from before views had names still work. */
function place() {
  let hash = location.hash.slice(1)
  if (hash === '!channels') hash = '/channels'
  else if (hash && !hash.startsWith('/')) hash = `/accounts/${hash.replaceAll('/', '%2F')}`
  const [name, ...parts] = hash.split('/').slice(1).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  return views.has(name) ? { name, parts } : { name: 'accounts', parts: [] }
}

/** Which control this is, whatever moves around it or changes beside it: what it is and does, and the subject its row is about. */
const which = (node) => [node.tagName, node.dataset.key, node.matches('a, button') ? node.textContent : '', node.getAttribute('href'), node.getAttribute('aria-label'), node.title, node.closest('tr, li')?.querySelector('a')?.getAttribute('href')].join('\n')

let loading = 0
let pending = 0
/** Loads under way that the reviewer asked for, as against a refresh. */
let opening = 0
/**
 * Fills the view the address names. Resolves to whether it loaded. `tag` is
 * what a look just found: the reload is one nobody asked for, so it gives
 * way to a reviewer who has started typing, and keeps their place.
 */
async function load(tag) {
  const turn = ++loading
  const quiet = tag !== undefined
  const { name, parts } = place()
  for (const link of $('views').children) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  document.title = `${views.get(name).title} · Account review`
  if (!$('token').value) {
    $('view').replaceChildren(el('p', { class: 'muted' }, 'Enter the access token to load.'))
    $('found').replaceChildren()
    beat = loadedAt = undefined
    notice('')
    fresh()
    return false
  }
  const box = el('div')
  pending += 1
  if (!quiet) opening += 1
  try {
    // Read the tag before the view: a change that lands while the view loads is then noticed on the next look.
    const seen = tag ?? (await pulse())
    await views.get(name).show(box, ...parts)
    if (turn !== loading || (quiet && interrupting())) return false
    if (seen) beat = seen
    const held = $('view').contains(document.activeElement) ? which(document.activeElement) : undefined
    const scrolled = quiet ? [...$('view').querySelectorAll('.wide')].map((each) => each.scrollLeft) : []
    $('view').replaceChildren(box)
    ;[...$('view').querySelectorAll('.wide')].forEach((each, i) => (each.scrollLeft = scrolled[i] ?? 0))
    if (held) [...$('view').querySelectorAll('a, button, input, select, [tabindex]')].find((node) => which(node) === held)?.focus({ preventScroll: true })
    if (!quiet) {
      notice('')
      if (views.get(name).subject && parts[0]) $('subject').value = parts[0]
    }
    if (!quiet) browsing = false
    loadedAt = readAt = Date.now()
    fresh()
    return true
  } catch (error) {
    if (turn !== loading) return false
    // A reload nobody asked for that fails leaves what is on screen; its age is in the footer.
    if (quiet) fresh(error.message)
    else {
      $('view').replaceChildren(box)
      notice(error.message, true)
    }
    return false
  } finally {
    pending -= 1
    if (!quiet) opening -= 1
  }
}

// One small request says whether anything changed. Only then is the view read again.
const EVERY = 10_000
let beat
let loadedAt
let readAt = 0
/** Further pages are on screen, which a refresh would take away. */
let browsing = false
/** The tag of what the server holds now, or undefined when it is the one already seen. */
async function pulse() {
  const response = await fetch('/pulse', { cache: 'no-store', headers: { authorization: `Bearer ${$('token').value}`, ...(beat && { 'if-none-match': beat }) } })
  if (response.status === 304) return undefined
  if (response.status === 401) throw new Error('The access token was refused.')
  if (!response.ok) throw new Error(`Request failed with ${response.status}`)
  return response.headers.get('etag')
}
function fresh(problem) {
  const at = loadedAt ? `Current as of ${new Date(loadedAt).toLocaleTimeString()}.` : ''
  $('fresh').textContent = problem ? `Not refreshed: ${problem} ${at}` : document.hidden ? `${at} Paused while this tab is hidden.` : busy() ? `${at} Waiting while a field here has the cursor.` : browsing ? `${at} Not refreshed while further pages are shown. Reload to start again.` : at && `${at} Looks for changes every ${EVERY / 1000} seconds.`
}
/** Typing or answering a question is not interrupted: the next look finds the change again. */
const busy = () => $('ask').open || ($('view').contains(document.activeElement) && document.activeElement.matches('input:not([readonly]), select, textarea'))
const interrupting = () => document.hidden || busy() || browsing
let looking = false
async function look() {
  if (interrupting() || looking || pending || !$('token').value || !loadedAt) return fresh()
  looking = true
  const turn = loading
  try {
    const tag = await pulse()
    // Opened something else meanwhile, or began to type: the tag is not taken, so the next look finds the change again.
    if (turn !== loading || pending || interrupting()) fresh()
    else if (tag) await load(tag)
    // Nothing was written, but ages and deadlines have moved on.
    else if (Date.now() - readAt >= (views.get(place().name).every ?? Infinity)) await load(beat)
    else {
      loadedAt = Date.now()
      fresh()
    }
  } catch (error) {
    fresh(error.message)
  } finally {
    looking = false
  }
}

/**
 * The days an address names, and a form that goes to others. When it names
 * none the server picks the last thirty in its own time zone, and `resolved`
 * puts those in the form.
 */
function period(name, first, last, ...rest) {
  const from = el('input', { type: 'date', value: first ?? '', required: '' })
  const to = el('input', { type: 'date', value: last ?? '', required: '' })
  const form = el('form', { class: 'row', on: { submit: (event) => { event.preventDefault(); go(`#/${name}/${from.value}/${to.value}${rest.some(Boolean) ? `/${rest.map(encodeURIComponent).join('/')}` : ''}`) } } },
    el('label', {}, 'From', from), el('label', {}, 'To', to), el('button', { class: 'primary' }, 'Show'))
  const days = (range) => `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  return {
    form,
    query: [first && `from=${encodeURIComponent(first)}`, last && `to=${encodeURIComponent(last)}`].filter(Boolean).join('&'),
    resolved: (range) => {
      from.value = range.from
      to.value = range.to
      return days(range)
    },
  }
}
/** A length of time in words: the two largest units that matter. */
function lasted(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `${Math.floor(hours / 24)} days${hours % 24 ? ` ${hours % 24} h` : ''}`
}
/** A count of a whole, with its share in words. */
const share = (part, whole) => (whole > 0 ? `${amount(part)} (${percent(part / whole)})` : amount(part))
/** A caller's id is long. Its start is enough to tell it from another, and the whole is in the title and the link. */
const caller = (subject) => el('a', { class: 'link', href: subjectHash(subject), title: subject }, subject.length > 24 ? `${subject.slice(0, 18)}…` : subject)
/** The same table of rows, a page at a time: `fetchPage(next)` answers `{ rows, next }`. */
function paged(table, next, more, fetchPage) {
  const button = el('button', { on: { click: async () => {
    if (opening) return
    const turn = ++loading
    pending += 1
    button.disabled = true
    try {
      const page = await fetchPage(next)
      if (turn !== loading) return
      table.append(...page.rows)
      browsing = true
      next = page.next
      button.hidden = next === null
    } catch (error) {
      notice(error.message, true)
    } finally {
      pending -= 1
      button.disabled = false
    }
  } } }, more)
  button.hidden = next === null
  return el('p', {}, button)
}
