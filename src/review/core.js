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

const subjectHash = (subject) => `#/accounts/${encodeURIComponent(subject)}`
const open = (subject) => el('a', { class: 'link', href: subjectHash(subject) }, subject)

/**
 * The views, in the order of the menu. Each has a `title` and
 * `show(box, ...parts)`, which fills the box from what the address names
 * after the view. What it throws is shown as a problem.
 */
const views = new Map()
const view = (name, title, show) => views.set(name, { title, show })

/** The view an address names, with the parts that follow it. Addresses from before views had names still work. */
function place() {
  let hash = location.hash.slice(1)
  if (hash === '!channels') hash = '/channels'
  else if (hash && !hash.startsWith('/')) hash = `/accounts/${hash}`
  const [name, ...parts] = hash.split('/').slice(1).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  return views.has(name) ? { name, parts } : { name: 'accounts', parts: [] }
}

/** What can take the keyboard in the view, to find the same place again after a reload. */
const stops = () => [...$('view').querySelectorAll('a, button, input, select, [tabindex]')]

let loading = 0
/** Fills the view the address names. Resolves to whether it loaded. */
async function load({ quiet = false } = {}) {
  const turn = ++loading
  const { name, parts } = place()
  for (const link of $('views').children) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  document.title = `${views.get(name).title} · Account review`
  if (!$('token').value) return false
  const box = el('div')
  try {
    // Read what the pulse says first: a change that lands while the view loads is then noticed on the next look.
    const seen = await pulse()
    await views.get(name).show(box, ...parts)
    if (turn !== loading) return false
    if (seen) beat = seen
    const held = quiet ? stops().indexOf(document.activeElement) : -1
    const scrolled = quiet ? [...$('view').querySelectorAll('.wide')].map((each) => each.scrollLeft) : []
    $('view').replaceChildren(box)
    ;[...$('view').querySelectorAll('.wide')].forEach((each, i) => (each.scrollLeft = scrolled[i] ?? 0))
    if (held >= 0) stops()[held]?.focus({ preventScroll: true })
    if (!quiet) notice('')
    loadedAt = Date.now()
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
  }
}

// One small request says whether anything changed. Only then is the view read again.
const EVERY = 10_000
let beat
let loadedAt
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
  $('fresh').textContent = problem ? `Not refreshed: ${problem} ${at}` : document.hidden ? `${at} Paused while this tab is hidden.` : busy() ? `${at} Waiting while you type.` : at && `${at} Looks for changes every ${EVERY / 1000} seconds.`
}
/** Typing or answering a question is not interrupted: the next look finds the change again. */
const busy = () => $('ask').open || ($('view').contains(document.activeElement) && document.activeElement.matches('input, select, textarea'))
let looking = false
async function look() {
  if (document.hidden || looking || busy() || !$('token').value || !loadedAt) return fresh()
  looking = true
  try {
    if (await pulse()) await load({ quiet: true })
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
