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
const th = (text, kind, full) => el('th', { scope: 'col', ...(kind && { class: kind }),
  ...(full && { title: full, 'aria-label': full, 'data-csv-label': full }) }, text)
const td = (kind, ...children) => el('td', kind ? { class: kind } : {}, ...children)
// Three things an empty cell may mean, told apart: known to be none, nothing to say, and not recorded.
const none = () => el('span', { class: 'muted' }, '—')
const tally = (n) => (n > 0 ? amount(n) : el('span', { class: 'muted' }, '0'))
const unrecorded = () => el('span', { class: 'muted' }, '(not recorded)')

const reviewDisplay = {
  idText: (value) => value.length > 24 ? `${value.slice(0, 18)}…` : value,
  id: (value, full = false) => el('span', { title: value }, full ? value : reviewDisplay.idText(value)),
  subject: (value, href = subjectHash(value)) => el('a', { class: 'link', href, title: value }, reviewDisplay.idText(value)),
  time: (at, now) => {
    if (at === null || at === undefined) return unrecorded()
    const date = new Date(at)
    const compact = date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    const exact = date.toISOString()
    const words = now === undefined ? compact : `${lasted(Math.abs(now - at))}${now >= at ? ' ago' : ' from now'}`
    return el('time', { datetime: exact, title: `${when(at)} · ${exact}` }, words)
  },
  day: (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }),
  range: ({ from, to, timeZone }) => el('p', { class: 'meta' }, `${reviewDisplay.day(from)} – ${reviewDisplay.day(to)} · Days in ${timeZone}`),
  heading: (title, ...controls) => el('div', { class: 'page-head' }, el('h2', { class: 'page-title' }, title), ...controls),
  section: (title, ...controls) => el('div', { class: 'section-head' }, el('h2', {}, title), ...controls),
  chip: (text, tone = '') => el('span', { class: tone ? `chip ${tone}` : 'chip' }, text),
  callTone: (state) => ({ answered: 'same', missed: 'apart', voicemail: 'related', waiting: 'related' })[state] ?? '',
  compare: (label, fraction) => el('span', { class: 'compare' }, meter(fraction), el('span', {}, label)),
}
/** Columns that belong together: the first carries the line that sets them apart, and a heading spans them. */
const edge = ([cell, ...rest]) => (cell.classList.add('edge'), [cell, ...rest])
const group = (text, columns, first) => el('th', { scope: 'col', colspan: columns, class: first ? 'group' : 'edge group' }, text)
/** A share drawn as a bar beside its number. The number says it; the bar only lets rows be compared. */
const meter = (share, marks = []) => {
  const at = (n) => Math.max(0, Math.min(1, n)) * 100
  const bar = svg('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none', focusable: 'false' },
    svg('rect', { class: 'track', x: 0, y: 2, width: 100, height: 4 }),
    svg('rect', { class: 'fill', x: 0, y: 2, width: at(share), height: 4 }),
    ...marks.map(([share, name]) => svg('line', { class: name, x1: at(share), x2: at(share), y1: 0, y2: 8, 'vector-effect': 'non-scaling-stroke' })))
  return el('span', { class: marks.length ? 'meter scale' : 'meter', 'aria-hidden': 'true' }, bar)
}
/** Notes on how a view is worked out, there for whoever wants them and not in the way of the numbers. */
const notes = (...texts) => el('details', {}, el('summary', { class: 'muted' }, 'How to read this'), ...texts.map((text) => el('p', { class: 'muted' }, text)))
/** The few numbers a view is about, large, each with what it is of. `tone` marks one that needs someone, in words as well as color. */
const tiles = (...list) => el('dl', { class: 'tiles' }, ...list.filter(Boolean).map(([label, value, note = '', tone = '']) =>
  el('div', tone ? { class: tone } : {}, el('dt', {}, label), el('dd', {}, el('b', {}, value), note ? el('span', { class: 'reason' }, note) : ''))))
/** Parts of a whole as one bar, and the same numbers as a list under it. A part of none keeps its place in the list. */
function parts(label, list) {
  const whole = list.reduce((sum, [, n]) => sum + n, 0)
  const drawing = svg('svg', { viewBox: '0 0 100 12', preserveAspectRatio: 'none', focusable: 'false' })
  let soFar = 0
  list.forEach(([, n], i) => {
    if (n === 0) return
    drawing.append(svg('rect', { class: `part${i}`, x: 100 * soFar / whole, y: 0, width: 100 * n / whole, height: 12 }))
    soFar += n
  })
  const bar = el('div', { class: 'parts', 'aria-hidden': 'true' }, drawing)
  return el('div', { class: 'part-summary' }, bar, el('ul', { class: 'legend', 'aria-label': label }, ...list.map(([name, n, note], i) => el('li', {}, el('span', { class: `key part${i}`, 'aria-hidden': 'true' }),
    el('span', {}, name, note ? el('span', { class: 'reason' }, note) : ''), el('b', {}, tally(n)), el('span', { class: 'muted' }, whole > 0 ? percent(n / whole) : '—')))))
}
/** A table that scrolls inside its own box. The box takes the keyboard, so arrow keys can scroll it. */
const wide = (label, table, cards = false) => {
  // Keep both lines of a grouped heading pinned together.
  const heading = el('thead')
  const rows = [...table.children].filter((node) => node.tagName !== 'CAPTION' && node.tagName !== 'COLGROUP')
  for (const row of rows) {
    if (row.tagName !== 'TR' || !row.querySelector('th[scope=col]')) break
    if (!heading.parentNode) table.insertBefore(heading, row)
    heading.append(row)
  }
  if (cards) {
    // These rows keep their headers in the accessibility tree even when laid out as cards.
    table.classList.add('table-cards')
    table.setAttribute('role', 'table')
    heading.setAttribute('role', 'rowgroup')
    for (const row of heading.rows) {
      row.setAttribute('role', 'row')
      for (const cell of row.cells) cell.setAttribute('role', cell.tagName === 'TH' ? 'columnheader' : 'cell')
    }
    const prefix = `review-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const heads = [...heading.lastElementChild.cells]
    heads.forEach((cell, i) => { cell.id = `${prefix}-col-${i + 1}` })
    const body = el('tbody', { role: 'rowgroup' })
    table.append(body)
    table.appendRows = (...added) => {
      for (const row of added) {
        row.setAttribute('role', 'row')
        for (const [i, cell] of [...row.cells].entries()) {
          cell.setAttribute('role', 'cell')
          cell.setAttribute('headers', heads[i].id)
          const value = el('div', { class: 'card-value' }, ...cell.childNodes)
          cell.append(el('span', { class: 'card-label', 'aria-hidden': 'true' }, heads[i].textContent), value)
        }
        body.append(row)
      }
    }
    table.appendRows(...rows.filter((row) => row.tagName === 'TR' && row.parentNode === table))
  }
  return el('div', { class: 'wide', tabindex: 0, role: 'region', 'aria-label': label }, table)
}
/** A long list that scrolls in its own box, so what follows it is not far below. */
const scroll = (label, list) => el('div', { class: 'scroll', tabindex: 0, role: 'region', 'aria-label': label }, list)

$('token').value = sessionStorage.getItem('token') ?? ''
$('zone').textContent = `Browser time: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`

function notice(text, bad = false) {
  $('notice').textContent = text
  $('notice').className = bad ? 'bad' : ''
}

/** Whose token this is: a reviewer's name, null for the service token, undefined until the server has said. */
let me
/** Shows who decides, in place of the token. The name is the server's answer, never something typed here. */
function signedIn(answer) {
  me = answer
  $('token-label').hidden = me !== undefined
  $('who').hidden = me === undefined
  $('name').textContent = me === undefined ? '' : me === null ? 'Service token: decisions here carry no name' : `Deciding as ${me}`
}

async function api(method, path, body) {
  const token = $('token').value
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  })
  if (response.status === 204) return undefined
  const answer = await response.json()
  // One refused after someone else has signed in says nothing of them.
  if (response.status === 401 && $('token').value === token) signedIn(undefined)
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'The access token was refused.' : answer.error ?? `Request failed with ${response.status}`), { status: response.status, answer })
  return answer
}

/**
 * Asks the reviewer to confirm, with a reason, and does it. With `wantsOther`,
 * also asks which other subject. The question stays open, with what was typed,
 * until `save` has succeeded or the reviewer cancels. Resolves to what `save`
 * answered, or to undefined when cancelled.
 */
function ask(title, text, confirm, wantsOther, save) {
  $('ask-title').textContent = title
  $('ask-text').textContent = text
  $('ask-yes').textContent = confirm
  $('ask-reason').value = ''
  $('ask-other').value = ''
  $('ask-other').required = wantsOther
  $('ask-other-label').hidden = !wantsOther
  $('ask-problem').textContent = ''
  $('ask-other').oninput = null
  const dialog = $('ask')
  let saved
  let saving = false
  const working = (now) => {
    saving = now
    for (const id of ['ask-yes', 'ask-no', 'ask-reason', 'ask-other']) $(id).disabled = now
  }
  const submit = async (event) => {
    if (event.submitter?.value === 'no') return
    event.preventDefault()
    if (saving) return
    $('ask-problem').textContent = ''
    working(true)
    try {
      saved = { answer: await save({ reason: $('ask-reason').value.trim(), other: $('ask-other').value.trim() }) }
    } catch (error) {
      $('ask-problem').textContent = `Not saved: ${error.message}`
    }
    working(false)
    if (saved) dialog.close()
    else $('ask-reason').focus()
  }
  // What is being saved cannot be called back, so Escape waits for the answer.
  const cancel = (event) => saving && event.preventDefault()
  const form = dialog.querySelector('form')
  form.addEventListener('submit', submit)
  dialog.addEventListener('cancel', cancel)
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      form.removeEventListener('submit', submit)
      dialog.removeEventListener('cancel', cancel)
      resolve(saved)
    }, { once: true })
    dialog.showModal()
  })
}

/**
 * Runs one reviewer action, reloads what is on screen, then says what
 * happened. `otherKey` names the body field for a second subject to ask for.
 * A decision says which was the newest when the view was read, so one made on
 * an outdated view is refused. The question then shows the newer one and can be
 * answered again, knowing it. An undo is not refused: it is about a decision already made.
 * `done` is told the answer, before the reload.
 */
async function act(title, text, path, body, confirm, { otherKey, undo = false, done } = {}) {
  foretell(path, body, otherKey)
  const shown = undo ? undefined : $('view').firstElementChild?.dataset.seen
  // The newer decisions this question has shown, by the other subject it named at the time: one seen says nothing of another.
  const told = new Map()
  let refused = false
  const saved = await ask(title, text, confirm, Boolean(otherKey), async ({ reason, other }) => {
    const seen = told.get(other) ?? shown
    try {
      return await api('POST', path, { ...body, ...(otherKey && { [otherKey]: other }), ...(seen !== undefined && { seen: Number(seen) }), ...(reason && { reason }) })
    } catch (error) {
      if (error.status !== 409) throw error
      refused = true
      const { seq, by, at, action, about, reason: why } = error.answer.decision
      // Shown here, it has been seen.
      told.set(other, seq)
      $('ask-yes').textContent = 'Decide anyway'
      $('ask-other').oninput = () => {
        $('ask-yes').textContent = confirm
        $('ask-problem').textContent = ''
      }
      throw new Error(`${by ?? 'Someone'} decided first, ${when(at)}: ${ACTIONS[action] ?? action} ${about.join(' and ')}${why ? `, "${why}"` : ''}.`)
    }
  })
  // The question is closed, and nothing more is said in it.
  foretelling.abort()
  if (!saved) return refused ? load() : undefined
  // These routes answer with the subjects whose cluster moved. None is a real outcome, so say so.
  done?.(saved.answer)
  const answer = saved.answer?.moved ?? saved.answer
  // Reloading clears the notice, so speak after it. A failed reload has already said why.
  if (await load()) notice(Array.isArray(answer) && answer.length === 0 ? `${title}: recorded. No cluster changed.` : `${title}: done.`)
}

/** People by how many subjects each has, in words. */
function people(clusters) {
  if (clusters.length === 1) return clusters[0].size === 1 ? 'one subject on its own' : `one person of ${amount(clusters[0].size)} subjects`
  const sizes = clusters.map(({ size }) => amount(size))
  return `${amount(clusters.length)} people, of ${sizes.length > 6 ? `${sizes.slice(0, 6).join(', ')} and ${amount(sizes.length - 6)} more` : `${sizes.slice(0, -1).join(', ')} and ${sizes.at(-1)}`} subjects`
}
let foretelling
/** Says in the question what the decision would do, worked out by the server and not made. With a subject still to be named, once it is. The question can be answered without it. */
function foretell(path, body, otherKey) {
  foretelling?.abort()
  const { signal } = (foretelling = new AbortController())
  const said = $('ask-effect')
  said.textContent = ''
  const action = { '/join': 'join', '/separate': 'separate', '/ignore': 'ignore' }[path]
  if (!action) return
  let turn = 0
  const tell = async (other) => {
    const asked = ++turn
    const say = (...told) => !signal.aborted && asked === turn && said.replaceChildren(...told)
    say('Working out what this would do.')
    try {
      const { moved, before, after } = await api('POST', '/foresee', { action, ...body, ...(otherKey && { [otherKey]: other }) })
      say(moved === 0 ? 'No cluster would change.' : `Now ${people(before)}. After this, ${people(after)}. ${amount(moved)} ${moved === 1 ? 'subject changes' : 'subjects change'} cluster.`,
        el('details', {}, el('summary', { class: 'muted' }, 'Which clusters'), ...[['Now', before], ['After', after]].map(([name, list]) => el('span', { class: 'reason' }, el('b', {}, name), ` ${list.map(({ id, size }) => `${id} (${amount(size)})`).join(', ')}`))))
    } catch (error) {
      say(`What this would do is not known: ${error.message}`)
    }
  }
  if (!otherKey) return void tell()
  let waiting
  $('ask-other').addEventListener('input', () => {
    clearTimeout(waiting)
    turn += 1
    const other = $('ask-other').value.trim()
    said.textContent = other ? 'Working out what this would do.' : ''
    if (other) waiting = setTimeout(() => !signal.aborted && tell(other), 300)
  }, { signal })
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
/** Which notes these are, whatever sections come and go around them. */
const fold = (node) => {
  const section = node.closest('section')
  return `${section?.querySelector('h2, h3')?.textContent}\n${[...(section?.querySelectorAll('details') ?? [])].indexOf(node)}`
}

/** Counts what the reviewer does in the Find box. */
let edits = 0
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
  const sought = edits
  for (const link of $('views').children) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  document.title = `${views.get(name).title} · Account review`
  if (!$('token').value) {
    $('view').replaceChildren(el('p', { class: 'muted' }, 'Enter your access token.'))
    $('found').replaceChildren()
    signedIn(undefined)
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
    if (me === undefined) {
      const { reviewer } = await api('GET', '/me')
      if (turn !== loading) return false
      signedIn(reviewer)
    }
    await views.get(name).show(box, ...parts)
    if (turn !== loading || (quiet && interrupting())) return false
    if (seen) beat = seen
    const held = $('view').contains(document.activeElement) ? which(document.activeElement) : undefined
    const scrolled = quiet ? [...$('view').querySelectorAll('.wide, .scroll')].map((each) => [each.scrollLeft, each.scrollTop]) : []
    const unfolded = quiet ? [...$('view').querySelectorAll('details[open]')].map(fold) : []
    $('view').replaceChildren(box)
    for (const each of box.querySelectorAll('.graph')) each.begin()
    ;[...$('view').querySelectorAll('.wide, .scroll')].forEach((each, i) => ([each.scrollLeft, each.scrollTop] = scrolled[i] ?? [0, 0]))
    for (const each of $('view').querySelectorAll('details')) each.open = unfolded.includes(fold(each))
    if (held) [...$('view').querySelectorAll('a, button, input, select, [tabindex]')].find((node) => which(node) === held)?.focus({ preventScroll: true })
    if (!quiet) {
      // What was typed since is a search of the reviewer's, and stays, as does what was answered.
      if (edits === sought) notice('')
      if (views.get(name).subject && parts[0] && edits === sought) $('subject').value = parts[0]
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
  const token = $('token').value
  const response = await fetch('/pulse', { cache: 'no-store', headers: { authorization: `Bearer ${token}`, ...(beat && { 'if-none-match': beat }) } })
  if (response.status === 304) return undefined
  if (response.status === 401) {
    if ($('token').value === token) signedIn(undefined)
    throw new Error('The access token was refused.')
  }
  if (!response.ok) throw new Error(`Request failed with ${response.status}`)
  return response.headers.get('etag')
}
function fresh(problem) {
  const at = loadedAt ? `Current as of ${new Date(loadedAt).toLocaleTimeString()}.` : ''
  $('fresh').textContent = problem ? `Not refreshed: ${problem} ${at}` : document.hidden ? `${at} Paused while this tab is hidden.` : busy() ? `${at} Waiting while a field here has the cursor.` : browsing ? `${at} Not refreshed while further pages are shown. Reload to start again.` : at && `${at} Looks for changes every ${EVERY / 1000} seconds.`
}
/** Typing or answering a question is not interrupted: the next look finds the change again. */
const busy = () => $('ask').open || ($('view').contains(document.activeElement) && document.activeElement.matches('input:not([readonly]), select, textarea'))
const interrupting = () => document.hidden || busy() || browsing || holding()
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
  const form = el('form', { class: 'row period', on: { submit: (event) => {
    event.preventDefault()
    go(`#/${name}/${from.value}/${to.value}${rest.some(Boolean) ? `/${rest.map(encodeURIComponent).join('/')}` : ''}`)
  } } }, el('label', {}, 'From', from), el('label', {}, 'To', to), el('button', { class: 'primary' }, 'Show'))
  const shortcuts = el('span', { class: 'row presets' })
  form.append(shortcuts)
  const days = (range) => `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
  return {
    form,
    query: [first && `from=${encodeURIComponent(first)}`, last && `to=${encodeURIComponent(last)}`].filter(Boolean).join('&'),
    resolved: (range) => {
      from.value = range.from
      to.value = range.to
      // Counted from today in the server's zone, which is the one its days are in, and worked out when pressed: a screen may be open past midnight.
      const spans = () => {
        const part = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: range.timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Date.now()).map(({ type, value }) => [type, value]))
        const today = `${part.year}-${part.month}-${part.day}`
        const ago = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10)
        return { Today: [today, today], Yesterday: [ago(1), ago(1)], '7 days': [ago(6), today], '30 days': [ago(29), today], 'This month': [`${today.slice(0, 8)}01`, today] }
      }
      shortcuts.replaceChildren(...Object.entries(spans()).map(([label, [start, end]]) => el('button', { type: 'button', 'aria-pressed': String(start === range.from && end === range.to), on: { click: () => {
        ;[from.value, to.value] = spans()[label]
        form.requestSubmit()
      } } }, label)))
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
/**
 * A button that saves a table as it is shown. A spreadsheet runs a cell that
 * starts like a formula, and names in a table are written by others, so such a cell starts with a quote.
 */
function saved(name, table) {
  const cell = (node) => {
    const parts = node.dataset.csvLabel ?? [...node.childNodes].map((each) => each.textContent.trim()).filter(Boolean).join(' · ')
    const text = /^\s*[=+\-@\uff1d\uff0b\uff0d\uff20]/.test(parts) && !/^-?\d+(\.\d+)?$/.test(parts) ? `'${parts}` : parts
    return `"${text.replaceAll('"', '""')}"${','.repeat(node.colSpan - 1)}`
  }
  return el('p', { class: 'table-export' }, el('button', { type: 'button', on: { click: () => {
    const rows = [...table.rows].map((row) => [...row.cells].map(cell).join(','))
    // A mark that says it is UTF-8, without which Excel reads it as something else.
    const address = URL.createObjectURL(new Blob(['\ufeff', rows.join('\r\n'), '\r\n'], { type: 'text/csv' }))
    el('a', { href: address, download: `${name}.csv` }).click()
    setTimeout(() => URL.revokeObjectURL(address), 10_000)
  } } }, 'Save as CSV'))
}
/** A count of a whole, with its share in words. */
const share = (part, whole) => (whole > 0 ? `${amount(part)} (${percent(part / whole)})` : amount(part))
/** A caller's id is long. Its start is enough to tell it from another, and the whole is in the title and the link. */
const caller = (subject) => reviewDisplay.subject(subject)
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
      if (table.appendRows) table.appendRows(...page.rows)
      else table.append(...page.rows)
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
