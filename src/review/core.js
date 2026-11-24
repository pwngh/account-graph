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
  if (gap === 0) return 'same time'
  const count = Math.round(gap / 86400000)
  return count < 1 ? '<1 day apart' : `${count} ${count === 1 ? 'day' : 'days'} apart`
}
const amount = (n) => n.toLocaleString()
const money = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const th = (text, kind, full) => el('th', { scope: 'col', ...(kind && { class: kind }),
  ...(full && { title: full, 'aria-label': full, 'data-csv-label': full }) }, text)
const td = (kind, ...children) => el('td', kind ? { class: kind } : {}, ...children)
// Three things an empty cell may mean, told apart: known to be none, nothing to say, and not recorded.
const none = () => el('span', { class: 'muted' }, '—')
const tally = (n) => (n > 0 ? amount(n) : el('span', { class: 'muted' }, '0'))
const unrecorded = () => el('span', { class: 'muted' }, 'No data')
/** The icon that shows a definition. `id` is its place in HELP, and `more` a sentence that depends on the data. */
const info = (id, more) => el('button', { type: 'button', class: 'info', 'data-help': id, ...(more && { 'data-more': more }), 'aria-label': `About ${HELP[id][0]}`, 'aria-expanded': 'false' }, svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: 'M8 14.2a6.2 6.2 0 1 0 0-12.4a6.2 6.2 0 0 0 0 12.4ZM8 7.4v3.4M8 5.1h.01' })))
/** A term with its definition beside it. */
const term = (text, id, more) => el('span', { class: 'term' }, text, info(id, more))

/** The mark of a view, as the list of views has it. The words beside it say the same. */
const viewMark = (name) => svg('svg', { class: 'mark-view', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: VIEW_ICONS[name] }))
/** What a row is about, as a mark on a tile of its own. */
const tile = (path, tone = '') => el('span', { class: tone ? `tile ${tone}` : 'tile', 'aria-hidden': 'true' }, svg('svg', { viewBox: '0 0 16 16', focusable: 'false' }, svg('path', { d: path })))
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
  range: ({ from, to, timeZone }) => el('p', { class: 'meta' }, `${reviewDisplay.day(from)} – ${reviewDisplay.day(to)} · ${timeZone}`),
  heading: (title, ...controls) => el('div', { class: 'page-head' }, el('h2', { class: 'page-title' }, viewMark(place().name), title), explain(), ...controls),
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
/** The few numbers a view is about, large, each with what it is of. `tone` marks one that needs someone, in words as well as color. */
const tiles = (...list) => el('dl', { class: 'tiles' }, ...list.filter(Boolean).map(([label, value, note = '', tone = '', more]) =>
  el('div', tone ? { class: tone } : {}, el('dt', {}, label), el('dd', {}, el('span', { class: 'tile-line' }, el('b', {}, value), more?.change ?? ''), note ? el('span', { class: 'reason' }, note) : '', more?.bars ?? ''))))
/** The same number of days just before a period. */
function daysBefore({ from, to }) {
  const day = 86400000
  const [start, end] = [from, to].map((each) => Date.parse(`${each}T00:00:00Z`))
  const count = Math.round((end - start) / day) + 1
  return { from: new Date(start - count * day).toISOString().slice(0, 10), to: new Date(start - day).toISOString().slice(0, 10), count }
}
/**
 * How a number stands to what it was in the days before, in words as well as
 * color. `good` says which way is better, and undefined that neither is.
 * A share changes by points: a percent of a percent says something else.
 * Nothing is said where either is not known.
 */
function changed(now, then, words, before, good, points = false) {
  if (now === null || then === null || now === undefined || then === undefined) return ''
  const by = points ? now - then : then === 0 ? (now === 0 ? 0 : undefined) : (now - then) / Math.abs(then)
  const way = by === undefined || by > 0.0049 ? 'up' : by < -0.0049 ? 'down' : 'level'
  const tone = way === 'level' || good === undefined ? '' : (way === good ? 'same' : 'apart')
  const told = by === undefined ? 'new' : way === 'level' ? 'no change' : `${way === 'up' ? '+' : '−'}${Math.abs(by) >= 10 ? `${amount(Math.round(Math.abs(by)))}×` : points ? `${amount(Math.round(Math.abs(by) * 100))} pts` : percent(Math.abs(by))}`
  return el('span', { class: `change ${way} ${tone}`, title: `Previous period: ${words(then)} (${reviewDisplay.day(before.from)} – ${reviewDisplay.day(before.to)})` }, told, el('span', { class: 'sr-only' }, `, previously ${words(then)}`))
}
/** A few numbers as bars, to see their shape. What they are is in the title. */
function shape(values, title) {
  const top = Math.max(...values, 1)
  const drawing = svg('svg', { class: 'shape', viewBox: `0 0 ${values.length * 4} 24`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' }, svg('title', {}, title))
  values.forEach((value, i) => drawing.append(svg('rect', { class: value === 0 ? 'none' : '', x: i * 4 + 0.5, width: 3, y: value === 0 ? 23 : 24 - Math.max(1.5, (24 * value) / top), height: value === 0 ? 1 : Math.max(1.5, (24 * value) / top), rx: 0.6 })))
  return drawing
}
/** Parts left out of a bar, by the bar's label and the part's name, kept while the screen is open. */
const partsOff = new Set()
/**
 * Parts of a whole as one bar, and the same numbers as a list under it.
 * Resting on a part, in either, brings it forward. A part pressed is left
 * out, and the rest are shares of what is left. A part of none keeps its
 * place in the list.
 */
function parts(label, list) {
  const bar = el('div', { class: 'parts', 'aria-hidden': 'true' })
  const legend = el('ul', { class: 'legend', 'aria-label': label })
  const told = el('p', { class: 'meta', role: 'status' })
  const whole = el('p', { class: 'parts-whole' })
  // With nothing to add about any part, the list is a line of labels.
  if (!list.some(([, , note]) => note)) legend.classList.add('labels')
  const root = el('div', { class: 'split-bar' }, whole, bar, legend, told)
  const key = (name) => `${label}\n${name}`
  const light = (i) => {
    // One left out has nothing in the bar to bring forward.
    root.classList.toggle('lit', i !== undefined && !partsOff.has(key(list[i][0])))
    for (const node of root.querySelectorAll('[data-part]')) node.classList.toggle('on', node.dataset.part === String(i))
  }
  const lights = (node, i) => {
    for (const [on, off] of [['pointerenter', 'pointerleave'], ['focusin', 'focusout']]) {
      node.addEventListener(on, () => light(i))
      node.addEventListener(off, () => light())
    }
    return node
  }
  const draw = () => {
    const held = legend.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
    const kept = list.filter(([name]) => !partsOff.has(key(name)))
    const total = kept.reduce((sum, [, n]) => sum + n, 0)
    whole.replaceChildren(el('b', {}, amount(total)), el('span', {}, kept.length < list.length ? ` of ${amount(list.reduce((sum, [, n]) => sum + n, 0))}` : ' total'))
    bar.replaceChildren(...list.flatMap(([name, n], i) => {
      if (n === 0 || partsOff.has(key(name))) return []
      const part = lights(el('span', { class: `part part${i}`, 'data-part': i, title: `${name}: ${amount(n)}, ${percent(n / total)}` }, el('b', {}, percent(n / total))), i)
      part.style.flexGrow = n
      // Its number is inside when there is room for it, and only in the list when there is not.
      part.classList.toggle('roomy', n / total >= 0.09)
      return [part]
    }))
    legend.replaceChildren(...list.map(([name, n, note], i) => {
      const off = partsOff.has(key(name))
      return lights(el('li', { 'data-part': i }, el('button', { type: 'button', 'data-key': `part ${label} ${name}`, 'aria-pressed': String(!off), on: { click: () => {
        if (!partsOff.delete(key(name))) partsOff.add(key(name))
        draw()
        light(i)
      } } }, el('span', { class: `key part${i}`, 'aria-hidden': 'true' }), el('span', { class: 'legend-name' }, el('span', {}, name), note ? el('span', { class: 'reason' }, note) : ''), el('b', {}, tally(n)), el('span', { class: 'muted' }, off ? 'hidden' : total > 0 ? percent(n / total) : '—'))), i)
    }))
    told.textContent = kept.length < list.length ? 'Shares exclude hidden items.' : ''
    if (held) legend.querySelector(`[data-key="${CSS.escape(held)}"]`)?.focus({ preventScroll: true })
  }
  draw()
  return root
}
/** A table that scrolls inside its own box. The box takes the keyboard, so arrow keys can scroll it. */
const wide = (label, table, cards = false) => {
  // Keep both lines of a grouped heading pinned together.
  // Named, as a table read on its own has no heading beside it.
  if (!table.caption) table.setAttribute('aria-label', label)
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
        // A heading over some of the rows spans them all and has no columns of its own.
        if (row.classList.contains('fold')) {
          row.cells[0].setAttribute('role', 'rowheader')
          body.append(row)
          continue
        }
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
$('zone').textContent = `Times in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`

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
  $('name').textContent = me === undefined ? '' : me === null ? 'Service token' : me
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

/** How long a button that cannot be undone is held before it does anything. */
const HOLD = 1200
/**
 * Makes a button one to hold: pressed for a while, by pointer or key, it does
 * what it does, and let go of sooner it does not. A press with no hold, as
 * some assistive tools make it, is asked for a second time. Returns what
 * makes it an ordinary button again.
 */
function held(button) {
  const aside = new AbortController()
  const { signal } = aside
  let timer
  let sure = false
  let through = false
  button.classList.add('hold')
  const start = () => {
    if (timer || button.disabled) return
    button.classList.add('holding')
    timer = setTimeout(() => {
      stop()
      through = true
      button.click()
    }, HOLD)
  }
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
    button.classList.remove('holding')
  }
  button.addEventListener('pointerdown', (event) => event.button === 0 && start(), { signal })
  for (const gone of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) button.addEventListener(gone, stop, { signal })
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    // Enter would press it at once.
    event.preventDefault()
    if (!event.repeat) start()
  }, { signal })
  button.addEventListener('keyup', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      stop()
    }
  }, { signal })
  button.addEventListener('click', (event) => {
    if (through) return void (through = false)
    // A pointer's click is the end of a press let go of too soon. One from nowhere is a tool's, and is asked again.
    if (event.detail === 0 && sure && !document.activeElement?.matches('input')) return
    event.preventDefault()
    // Enter in a field of the question presses its first button, which is nobody's yes.
    if (event.detail === 0 && !document.activeElement?.matches('input')) {
      sure = true
      $('ask-problem').textContent = 'Press again to confirm.'
    } else $('ask-problem').textContent = 'Hold the button to confirm.'
  }, { signal })
  return () => {
    stop()
    aside.abort()
    button.classList.remove('hold')
  }
}
/**
 * Asks the reviewer to confirm, with a reason, and does it. With `wantsOther`,
 * also asks which other subject. The question stays open, with what was typed,
 * until `save` has succeeded or the reviewer cancels. Resolves to what `save`
 * answered, or to undefined when cancelled.
 */
function ask(title, text, confirm, wantsOther, save, hold = false) {
  const ease = hold ? held($('ask-yes')) : () => {}
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
      ease()
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
async function act(title, text, path, body, confirm, { otherKey, undo = false, done, hold = false } = {}) {
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
      $('ask-yes').textContent = 'Continue'
      $('ask-other').oninput = () => {
        $('ask-yes').textContent = confirm
        $('ask-problem').textContent = ''
      }
      throw new Error(`${by ?? 'Another reviewer'} made a decision at ${when(at)}: ${ACTIONS[action] ?? action} ${about.join(' and ')}${why ? `, "${why}"` : ''}.`)
    }
  }, hold)
  // The question is closed, and nothing more is said in it.
  foretelling.abort()
  if (!saved) return refused ? load() : undefined
  // These routes answer with the subjects whose cluster moved. None is a real outcome, so say so.
  done?.(saved.answer)
  const answer = saved.answer?.moved ?? saved.answer?.changes ?? saved.answer
  // Reloading clears the notice, so speak after it. A failed reload has already said why.
  if (await load()) notice(Array.isArray(answer) && answer.length === 0 ? `${title}: saved. No groups changed.` : `${title}: saved.`)
}

/** People by how many subjects each has, in words. */
function people(clusters) {
  if (clusters.length === 1) return clusters[0].size === 1 ? '1 person (1 ID)' : `1 person (${amount(clusters[0].size)} IDs)`
  const sizes = clusters.map(({ size }) => amount(size))
  return `${amount(clusters.length)} people (${sizes.length > 6 ? `${sizes.slice(0, 6).join(', ')} and ${amount(sizes.length - 6)} more` : sizes.join(', ')} IDs)`
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
    say('Calculating…')
    try {
      const { moved, before, after } = await api('POST', '/foresee', { action, ...body, ...(otherKey && { [otherKey]: other }) })
      say(moved === 0 ? 'No groups change.' : `Before: ${people(before)}. After: ${people(after)}.`,
        el('details', {}, el('summary', { class: 'muted' }, 'Details'), ...[['Before', before], ['After', after]].map(([name, list]) => el('span', { class: 'reason' }, el('b', {}, name), ` ${list.map(({ id, size }) => `${id} (${amount(size)})`).join(', ')}`))))
    } catch (error) {
      say(`Preview unavailable: ${error.message}`)
    }
  }
  if (!otherKey) return void tell()
  let waiting
  $('ask-other').addEventListener('input', () => {
    clearTimeout(waiting)
    turn += 1
    const other = $('ask-other').value.trim()
    said.textContent = other ? 'Calculating…' : ''
    if (other) waiting = setTimeout(() => !signal.aborted && tell(other), 300)
  }, { signal })
}

/** Goes to an address. Going where the screen already is reads it again. */
const go = (hash) => (location.hash === hash ? load() : (location.hash = hash))
/** Who decided: a person's name as it is, a system marked as one. */
const author = (by) => (by?.startsWith('system:') ? el('span', { class: 'chip', title: 'Sent by another system' }, `system ${by.slice(7)}`) : el('span', {}, by || 'Unknown'))
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
    if (link.dataset.view === name) {
      link.setAttribute('aria-current', 'page')
      // On a phone the views are a row that scrolls: the one that is open is brought into it.
      $('views').scrollLeft = link.offsetLeft - ($('views').clientWidth - link.offsetWidth) / 2
    } else link.removeAttribute('aria-current')
  }
  document.title = `${views.get(name).title} · Account review`
  if (!$('token').value) {
    $('view').replaceChildren(el('p', { class: 'muted' }, 'Sign in'))
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
    if (!quiet && views.get(name).subject && parts[0]) remember(parts[0])
    loadedAt = readAt = Date.now()
    fresh()
    return true
  } catch (error) {
    if (turn !== loading) return false
    // A reload nobody asked for that fails leaves what is on screen; its age is in the footer.
    if (quiet) fresh(error.message)
    else {
      $('view').replaceChildren(box)
      // A search answered meanwhile has the notice, so the problem is told where the view would be.
      if (edits === sought) notice(error.message, true)
      else box.append(el('p', { class: 'apart', role: 'alert' }, `Problem: ${error.message}`))
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
  const at = loadedAt ? `Updated ${new Date(loadedAt).toLocaleTimeString()}` : ''
  $('fresh').textContent = problem ? `Refresh failed: ${problem}${at && ` · ${at}`}` : at && `${at}${document.hidden || busy() || browsing ? ' · Auto-refresh paused' : ''}`
}
/** Typing or answering a question is not interrupted: the next look finds the change again. */
const busy = () => $('ask').open || palette.open || ($('view').contains(document.activeElement) && document.activeElement.matches('input:not([readonly]), select, textarea'))
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
  } } }, el('label', {}, 'From', from), el('label', {}, 'To', to), el('button', { class: 'primary' }, 'Apply'))
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
  if (minutes < 1) return '<1 min'
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
    const rows = [...table.rows].filter((row) => !row.hidden).map((row) => [...row.cells].map(cell).join(','))
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
// A menu is placed by where its button was, so it goes when the page moves under it.
addEventListener('scroll', () => document.querySelector('.filter-menu:popover-open')?.hidePopover(), { passive: true })
/** A row of a table with a bar of its share behind it. The share is said in the row. */
const behind = (row, part) => {
  row.classList.add('behind')
  row.style.setProperty('--part', `${Math.max(0, Math.min(1, part)) * 100}%`)
  return row
}
/** Which of a list's measures is shown, by the list's name, kept while the screen is open. */
const measured = new Map()
/**
 * Rows ranked by a measure, each with a bar of its share behind its name, and
 * a tab a measure. `measures` gives a name, what a row is worth (null when it
 * is not known), the words for it, and false when one thing may be counted
 * under two rows, so that a share would say what is not so. The bar only repeats the number.
 */
function ranked(label, rows, named, measures, most = 8) {
  const tabs = el('div', { class: 'segments', role: 'group', 'aria-label': `${label}, by` })
  const list = el('ol', { class: 'ranked', role: 'list' })
  const foot = el('div', { class: 'ranked-foot' })
  let all = false
  const draw = () => {
    const [name, value, words, shares = true] = measures.find(([each]) => each === measured.get(label)) ?? measures[0]
    tabs.replaceChildren(...measures.map(([each]) => el('button', { type: 'button', 'data-key': `${label} by ${each}`, 'aria-pressed': String(each === name), on: { click: () => { measured.set(label, each); draw() } } }, each)))
    const known = rows.filter((row) => value(row) !== null && value(row) > 0).sort((x, y) => value(y) - value(x))
    const unknown = rows.filter((row) => value(row) === null).length
    const top = Math.max(...known.map(value), 1)
    const whole = known.reduce((sum, row) => sum + value(row), 0)
    list.replaceChildren(...(all ? known : known.slice(0, most)).map((row) => {
      const bar = el('i', { 'aria-hidden': 'true' })
      bar.style.width = `${(100 * value(row)) / top}%`
      return el('li', {}, bar, el('span', { class: 'ranked-name' }, ...named(row)), el('span', { class: 'ranked-share' }, !shares ? '' : value(row) / whole < 0.005 ? '<1%' : percent(value(row) / whole)), el('b', {}, words(value(row))))
    }))
    if (known.length === 0) list.replaceChildren(el('li', { class: 'muted' }, 'None.'))
    foot.replaceChildren(known.length > most ? el('button', { type: 'button', on: { click: () => { all = !all; draw() } } }, all ? 'Show fewer' : `Show all ${amount(known.length)}`) : '', unknown > 0 ? el('span', { class: 'meta' }, `${amount(unknown)} without data`) : '')
  }
  draw()
  return el('div', { class: 'ranked-box' }, tabs, list, foot)
}
/** A color of its own for a name, the same wherever it is shown. It only helps the eye: the name is always there. */
const toneOf = (name) => `tone${[...name].reduce((sum, letter) => (sum * 31 + letter.codePointAt(0)) >>> 0, 7) % 6}`
/** Where something came from: a letter in its color, which is drawn and not text, and its name. */
const sourced = (name) => el('span', { class: 'sourced' }, el('i', { class: `letter ${toneOf(name)}`, 'aria-hidden': 'true', 'data-letter': name.slice(0, 1).toUpperCase() }), name)
/** How each table was sorted, kept while the screen is open. */
const sorted = new Map()
/**
 * Makes the headings of a table sort it. `columns` gives, for a heading's
 * place, what a row is worth there; null goes last either way. Each of
 * `rows` is a record and the lines it has in the table, which stay together.
 */
function sortable(label, table, columns, rows) {
  const heads = [...table.querySelectorAll('tr')].findLast((row) => row.querySelector('th[scope=col]')).cells
  const body = rows[0]?.lines[0].parentNode
  if (!body) return
  const after = rows.at(-1).lines.at(-1).nextSibling
  const apply = () => {
    const now = sorted.get(label)
    for (const [i, head] of [...heads].entries()) if (columns[i]) head.setAttribute('aria-sort', now?.at === i ? now.way : 'none')
    const value = now && columns[now.at]
    const order = value ? [...rows].sort((x, y) => {
      const [a, b] = [value(x.row), value(y.row)]
      if (a === null || b === null) return (a === null) - (b === null)
      const by = typeof a === 'string' ? a.localeCompare(b) : a - b
      return now.way === 'ascending' ? by : -by
    }) : rows
    for (const { lines } of order) for (const line of lines) body.insertBefore(line, after)
  }
  for (const [i, head] of [...heads].entries()) if (columns[i]) {
    const button = el('button', { type: 'button', class: 'sort', 'data-key': `sort ${label} ${i}`, on: { click: () => {
      const now = sorted.get(label)
      // Largest first, then smallest, then as it came.
      if (now?.at !== i) sorted.set(label, { at: i, way: head.classList.contains('num') ? 'descending' : 'ascending' })
      else if (now.way === (head.classList.contains('num') ? 'descending' : 'ascending')) now.way = now.way === 'ascending' ? 'descending' : 'ascending'
      else sorted.delete(label)
      apply()
    } } }, ...[...head.childNodes].flatMap((node) => (node.classList?.contains('term') ? [node.firstChild] : [node])), el('i', { class: 'way', 'aria-hidden': 'true' }))
    const about = head.querySelector('.info')
    head.replaceChildren(button, ...(about ? [about] : []))
  }
  apply()
}
/** The groups folded away, by table and name, kept while the screen is open. */
const foldedAway = new Set()
/** Rows under a heading that folds them away: its name, how many, and what else there is to say of them. */
function folding(label, name, tone, columns, rows, note = '') {
  if (rows.length === 0) return []
  const key = `${label}\n${name}`
  const button = el('button', { type: 'button', 'data-key': `fold ${name}`, on: { click: () => {
    if (!foldedAway.delete(key)) foldedAway.add(key)
    show()
  } } }, el('i', { class: 'chevron', 'aria-hidden': 'true' }), el('i', { class: `dot ${tone}`, 'aria-hidden': 'true' }), name, el('span', { class: 'count' }, amount(rows.length)), note ? el('span', { class: 'meta' }, note) : '')
  const show = () => {
    const away = foldedAway.has(key)
    button.setAttribute('aria-expanded', String(!away))
    for (const row of rows) row.classList.toggle('folded', away)
  }
  show()
  return [el('tr', { class: 'fold' }, el('th', { scope: 'rowgroup', colspan: columns }, button)), ...rows]
}
/** What each table is narrowed to, by its name, kept while the screen is open. */
const narrowed = new Map()
/**
 * A bar over a table that narrows its rows: words to look for, and the values
 * of the columns named in `by`, each with how many rows have it. What is
 * chosen shows as chips to take away again. It hides rows and reads nothing:
 * rows added later are narrowed too.
 */
function filters(label, table, by) {
  if (!narrowed.has(label)) narrowed.set(label, { words: '', on: {} })
  const state = narrowed.get(label)
  const rows = () => [...table.querySelectorAll('tr')].filter((row) => row.querySelector('td') && !row.querySelector('th') && !row.classList.contains('sum') && !row.classList.contains('part'))
  /** What a row holds in a column: one value, or several when the cell keeps them apart. */
  const values = (row, { at, read }) => {
    const cell = row.cells[at]
    if (!cell) return []
    const found = read ? read(cell, row) : (cell.querySelector('.card-value') ?? cell).textContent.trim()
    return [found].flat().filter(Boolean)
  }
  const find = el('input', { type: 'search', class: 'filter-words', placeholder: `Filter ${label.toLowerCase()}`, 'aria-label': `Filter ${label.toLowerCase()}`, value: state.words, on: { input: () => { state.words = find.value; narrow() } } })
  const chips = el('span', { class: 'filter-chips' })
  const told = el('span', { class: 'meta', role: 'status' })
  const menu = el('div', { class: 'filter-menu', popover: 'auto' })
  const button = el('button', { type: 'button', class: 'filter-add', 'data-key': `filter ${label}` }, '+ Filter')
  button.popoverTargetElement = menu
  const bar = el('div', { class: 'filter-bar', role: 'search', 'aria-label': `Filter ${label.toLowerCase()}` }, find, chips, button, told, menu)
  const chosen = () => Object.entries(state.on).filter(([, list]) => list.length > 0)
  function holds(row, but) {
    const words = state.words.trim().toLowerCase()
    if (words && !row.textContent.toLowerCase().includes(words)) return false
    return chosen().every(([name, list]) => name === but || values(row, by.find((each) => each.name === name) ?? {}).some((value) => list.includes(value)))
  }
  function narrow() {
    const all = rows()
    let left = 0
    for (const row of all) {
      row.hidden = !holds(row)
      if (!row.hidden) left += 1
      // A row split into parts goes with them.
      for (let part = row.nextElementSibling; part?.classList.contains('part'); part = part.nextElementSibling) part.hidden = row.hidden
    }
    for (const fold of table.querySelectorAll('tr.fold')) {
      let here = 0
      for (let row = fold.nextElementSibling; row && !row.classList.contains('fold'); row = row.nextElementSibling) if (!row.hidden) here += 1
      fold.hidden = here === 0
      const count = fold.querySelector('.count')
      if (count.textContent !== amount(here)) count.textContent = amount(here)
    }
    const some = chosen().length > 0 || state.words.trim()
    told.textContent = some ? `${amount(left)} of ${amount(all.length)}` : ''
    chips.replaceChildren(...chosen().flatMap(([name, list]) => list.map((value) => el('button', { type: 'button', class: 'filter-chip', 'aria-label': `Remove ${name} ${value}`, on: { click: () => { state.on[name] = list.filter((each) => each !== value); narrow(); button.focus({ preventScroll: true }) } } }, el('span', {}, name), ` ${value}`, el('i', { 'aria-hidden': 'true' }, '×')))),
      some ? el('button', { type: 'button', class: 'filter-clear', on: { click: () => { state.on = {}; state.words = find.value = ''; narrow(); find.focus({ preventScroll: true }) } } }, 'Clear') : '')
  }
  function fill() {
    const all = rows()
    menu.replaceChildren(...by.map((column) => {
      const counts = new Map()
      for (const row of all) for (const value of values(row, column)) counts.set(value, (counts.get(value) ?? 0) + (holds(row, column.name) ? 1 : 0))
      const on = () => state.on[column.name] ?? []
      return el('fieldset', {}, el('legend', {}, column.name), ...[...counts].sort(([x, n], [y, m]) => m - n || (x < y ? -1 : 1)).slice(0, 12).map(([value, n]) => {
        const check = el('input', { type: 'checkbox', ...(on().includes(value) && { checked: '' }), on: { change: () => { state.on[column.name] = check.checked ? [...on(), value] : on().filter((each) => each !== value); narrow() } } })
        return el('label', {}, check, el('span', {}, value), el('span', { class: 'count' }, amount(n)))
      }))
    }))
  }
  menu.addEventListener('beforetoggle', (event) => { if (event.newState === 'open') fill() })
  menu.addEventListener('toggle', (event) => {
    if (event.newState !== 'open') return
    // Under its button, and never off the side of the window.
    const at = button.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(at.left, innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${at.bottom + menu.offsetHeight + 8 > innerHeight ? Math.max(8, at.top - menu.offsetHeight - 6) : at.bottom + 6}px`
    menu.querySelector('input')?.focus({ preventScroll: true })
  })
  new MutationObserver(narrow).observe(table, { childList: true, subtree: true })
  narrow()
  return bar
}
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
