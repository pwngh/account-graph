// The detail cards: what is behind a number or a row, opened from an icon beside it.

/**
 * What each card says, by what it is of. `now` is made from what the page
 * already holds, and `more`, where there is one, from what is asked for when
 * the card opens. Either may leave anything out, and what is not known is
 * left out: a row of nothing is not shown. `rows` are a name and a value,
 * `sum` is a line of arithmetic, `say` is sentences, the first of a pair in
 * bold, and `links` are words with an address or with what to do here.
 */
const DETAILS = {}
/** The project's own pages. A card links to nowhere else outside the screen. */
const DOCS = 'https://github.com/pwngh/account-graph/blob/main/docs/'
const docs = (text, page) => ({ text, href: `${DOCS}${page}` })
/** A link to a part of the view that is open. */
const toPart = (text, id) => ({ text, href: location.hash.startsWith('#/') ? location.hash : '#/accounts', act: () => {
  const part = $(id)
  part?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  part?.focus({ preventScroll: true })
} })
const linkable = (href) => typeof href === 'string' && (href.startsWith('#/') || href.startsWith(DOCS))
/** What a row may say. Nothing known is no row. */
const isKnown = (value) => value !== undefined && value !== null && value !== '' && value !== false

/** A count, where there is one. A number nobody knows is no row, and one known to be none says 0. */
const counted = (n) => (typeof n === 'number' && Number.isFinite(n) ? amount(n) : undefined)
/** Two counts in one row, where both are known. */
const both = (a, b) => (counted(a) !== undefined && counted(b) !== undefined ? `${amount(a)} · ${amount(b)}` : undefined)
/** How long between two times, where both are known. */
const between = (from, to) => (typeof from === 'number' && typeof to === 'number' ? lasted(Math.max(0, to - from)) : undefined)
/** When something was, as a card says it. */
const moment = (at, seconds = false) => (typeof at === 'number' && at > 0 ? new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds && { second: '2-digit' }), ...(new Date(at).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) }) : undefined)
/** Where an arrival came from, in words. */
const cameFrom = (row) => (row?.source ? `${row.source}${row.campaign || row.campaignId ? ` · ${row.campaign ?? row.campaignId}` : ''}` : undefined)
/** A target and whether it is met. Nothing is said where the firm set none. */
const goal = (text, met, short = '') => [`Target ${text}, set by you.`, met ? ' Met.' : ` Not met${short ? `: ${short}` : ''}.`]

/** What the screen's own routes answered within the last minute, so two cards that ask the same ask once. */
const lately = new Map()
function recent(path) {
  for (const [each, { at }] of lately) if (Date.now() - at >= 60_000) lately.delete(each)
  const asked = lately.get(path) ?? { at: Date.now(), answer: api('GET', path) }
  if (!lately.has(path)) {
    lately.set(path, asked)
    asked.answer.catch(() => lately.get(path) === asked && lately.delete(path))
  }
  return asked.answer
}

/** The icon that opens a card. `of` gives what the card is made from, when it is made, and `id` tells one from another of its kind. */
function detail(key, { label, id = '', of }) {
  const button = el('button', { type: 'button', class: 'detail', 'data-key': `detail ${key} ${id}`, 'aria-label': `Details of ${label}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: () => cards.press(button) } },
    svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('circle', { cx: 8, cy: 8, r: 6.6 }), svg('path', { d: 'M5.2 5.9h5.6M5.2 8.2h5.6M5.2 10.5h3.4' })))
  button.about = { key, of }
  return button
}

/**
 * Fills a box with what a card says, and goes on to ask for the rest. Filled
 * again, what was fetched stays until it has been fetched anew.
 */
function telling(box, settled = () => {}, most = 10) {
  let turn = 0
  let last
  let rest
  const draw = (now, waiting, failed, brief) => {
    const part = (name) => [...(now[name] ?? []), ...(rest?.[name] ?? [])]
    const held = box.contains(document.activeElement) ? which(document.activeElement) : undefined
    const rows = part('rows').filter(([, value]) => isKnown(value)).slice(0, most)
    const say = part('say').filter(isKnown).slice(0, 3)
    const links = (brief ? [] : part('links')).filter((link) => link && linkable(link.href))
    const sum = rest?.sum ?? now.sum
    box.replaceChildren(
      rows.length > 0 ? el('dl', { class: 'detail-rows' }, ...rows.map(([name, value]) => el('div', {}, el('dt', {}, name), el('dd', {}, value)))) : '',
      waiting ? el('div', { class: 'waiting-lines', role: 'status', 'aria-label': 'Loading' }, el('i'), el('i'), el('i')) : '',
      failed ? el('p', { class: 'detail-failed', role: 'alert' }, `Not available: ${failed} `, el('button', { type: 'button', on: { click: () => tell(...last) } }, 'Retry')) : '',
      sum ? el('code', { class: 'detail-sum' }, sum) : '',
      say.length > 0 ? el('p', { class: 'detail-say' }, ...say.flatMap((each, i) => [i > 0 ? ' ' : '', ...(Array.isArray(each) ? [el('b', {}, each[0]), each[1] ?? ''] : [each])])) : '',
      links.length > 0 ? el('p', { class: 'detail-links' }, ...links.map(linked)) : '')
    if (held) ([...box.querySelectorAll('a, button')].find((node) => which(node) === held) ?? box.closest('[tabindex]'))?.focus({ preventScroll: true })
    settled()
  }
  /** Says what there is of some data. False when there is nothing to say it of. */
  function tell(key, of, short = false) {
    last = [key, of, short]
    const asked = ++turn
    const data = of()
    const now = data && DETAILS[key].now(data, short)
    if (!now) return false
    const more = short ? undefined : DETAILS[key].more?.(data)
    // What nobody has to wait for is said at once.
    draw(now, more !== undefined && rest === undefined, undefined, short)
    more?.then((found) => {
      if (asked !== turn) return
      rest = found ?? {}
      draw(now)
    }, (error) => asked === turn && draw(now, false, error.message))
    return now
  }
  return tell
}
/** A link of a card. One inside the screen opens in place, and one outside it says so. */
function linked({ text, href, act }) {
  if (!href.startsWith('#/')) return el('a', { href, target: '_blank', rel: 'noopener' }, text, svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: 'M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3 7.5 8.5' })), el('span', { class: 'sr-only' }, ', opens in a new tab'))
  return el('a', { href, on: { click: (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    cards.close()
    if (act) return act()
    // Asked for again, what it leads to is brought into view again.
    broughtTo = undefined
    go(href)
  } } }, text)
}

const cards = (() => {
  const title = el('h4', { id: 'card-title' })
  const worth = el('span', { class: 'detail-worth' })
  const shut = el('button', { type: 'button', class: 'detail-shut', 'aria-label': 'Close', on: { click: () => close(true) } }, '×')
  const body = el('div', { class: 'detail-body' })
  const card = el('div', { id: 'card', popover: 'manual', role: 'dialog', 'aria-labelledby': 'card-title', tabindex: -1 }, el('div', { class: 'detail-head' }, title, worth, shut), body)
  const hintTitle = el('b', {})
  const hintWorth = el('span', { class: 'detail-worth' })
  const hintBody = el('div', {})
  const hint = el('div', { id: 'hint', popover: 'manual', role: 'tooltip' }, el('div', { class: 'detail-head' }, hintTitle, hintWorth), hintBody)
  document.body.append(card, hint)
  let from
  let tell
  let hinted
  let aimed
  let gone
  let timer
  const resting = { x: -1, y: -1 }
  addEventListener('pointermove', ({ clientX, clientY }) => Object.assign(resting, { x: clientX, y: clientY }), { passive: true })

  /** Under what it is of, or over it where there is more room, and never off the window. */
  function stand(box, by) {
    if (!by?.isConnected) return
    const at = by.getBoundingClientRect()
    const [under, over] = [innerHeight - at.bottom - 16, at.top - 16]
    box.style.maxHeight = ''
    const below = box.offsetHeight <= under || under >= over
    box.style.maxHeight = `${Math.max(below ? under : over, Math.min(240, innerHeight - 16))}px`
    box.style.left = `${Math.max(8, Math.min(at.left - 14, innerWidth - box.offsetWidth - 8))}px`
    box.style.top = `${Math.max(8, Math.min(below ? at.bottom + 8 : at.top - box.offsetHeight - 8, innerHeight - box.offsetHeight - 8))}px`
  }
  /** Says it, or says there is nothing to say. */
  function show() {
    const now = tell(from.about.key, from.about.of)
    if (!now) return false
    title.textContent = now.title ?? ''
    worth.replaceChildren(now.value ?? '')
    card.classList.toggle('roomy', Boolean(now.roomy))
    return true
  }
  function open(button) {
    close()
    from = button
    tell = telling(body, () => stand(card, from))
    if (!card.matches(':popover-open')) card.showPopover()
    if (!show()) return close()
    stand(card, from)
    card.scrollTop = 0
    from.setAttribute('aria-expanded', 'true')
    card.focus({ preventScroll: true })
  }
  function close(back = false) {
    clearTimeout(gone)
    gone = undefined
    const button = from
    from = tell = undefined
    if (card.matches(':popover-open')) card.hidePopover()
    button?.setAttribute('aria-expanded', 'false')
    if (back && button?.isConnected) button.focus({ preventScroll: true })
    body.replaceChildren()
  }

  /** The short card of a mark: shown while it is pointed at or has the keyboard. `unless` says when it would only repeat what is open. */
  function hintable(mark, key, of, unless = () => false) {
    const begin = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!mark.isConnected || unless() || hinted === mark) return
        hide()
        aimed = mark
        const now = telling(hintBody)(key(), of, true)
        if (!now) return
        hinted = mark
        hintTitle.textContent = now.title ?? ''
        hintWorth.replaceChildren(now.value ?? '')
        if (now.foot) hintBody.append(el('p', { class: 'meta' }, now.foot))
        mark.setAttribute('aria-describedby', 'hint')
        hint.showPopover()
        stand(hint, mark)
      }, 180)
    }
    // Only a pointer that moves points at something: a mark may also move under one that rests.
    mark.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse' || (event.clientX === resting.x && event.clientY === resting.y) || aimed === mark) return
      aimed = mark
      begin()
    })
    mark.addEventListener('pointerleave', leave)
    mark.addEventListener('focus', () => mark.matches(':focus-visible') && begin())
    mark.addEventListener('blur', hide)
    mark.addEventListener('click', hide)
    return mark
  }
  // Long enough to cross from the mark to the card, which stays while it is pointed at.
  function leave() {
    aimed = undefined
    clearTimeout(timer)
    timer = setTimeout(() => !hinted?.matches(':focus-visible') && hide(), 160)
  }
  function hide() {
    aimed = undefined
    clearTimeout(timer)
    hinted?.removeAttribute('aria-describedby')
    hinted = undefined
    if (hint.matches(':popover-open')) hint.hidePopover()
  }
  hint.addEventListener('pointerenter', () => clearTimeout(timer))
  hint.addEventListener('pointerleave', leave)

  // Read again, the view has other nodes: the card finds its icon by its key and is made again from what that holds.
  new MutationObserver(() => {
    if (hinted && !hinted.isConnected) hide()
    if (!from || from.isConnected) return
    const { key } = from.dataset
    const next = [...$('view').querySelectorAll('button[data-key]')].find((each) => each.about && each.dataset.key === key)
    // The chart draws its marks once it has been measured, which is a moment after the rest.
    if (!next) return void (gone ??= setTimeout(() => { gone = undefined; if (from && !from.isConnected) close() }, 200))
    from = next
    from.setAttribute('aria-expanded', 'true')
    if (!show()) close()
  }).observe($('view'), { childList: true, subtree: true })
  addEventListener('click', (event) => {
    if (!from || event.composedPath().includes(card) || event.target.closest?.('button[aria-haspopup=dialog]')) return
    // A press on nothing in particular puts the focus back. One on a control leaves it there.
    const now = document.activeElement
    close(now === document.body || now.tabIndex < 0 || card.contains(now))
  })
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (from || hinted)) {
      event.preventDefault()
      event.stopPropagation()
      if (from) close(true)
      else hide()
    } else if (event.key === 'Tab' && from && card.contains(document.activeElement)) {
      // The card is at the end of the page and belongs beside its icon, so leaving it either way goes back there.
      const inside = [...card.querySelectorAll('a, button')]
      if (document.activeElement === (event.shiftKey ? inside[0] : inside.at(-1)) || (event.shiftKey && document.activeElement === card)) {
        event.preventDefault()
        from.focus({ preventScroll: true })
      }
    }
  }, true)
  // A question or the palette takes the whole screen.
  addEventListener('focusin', (event) => from && event.target.closest?.('dialog') && close())
  addEventListener('hashchange', () => { close(); hide() })
  addEventListener('scroll', (event) => {
    if (!card.contains(event.target)) stand(card, from)
    // The focus brings a mark into view by scrolling, so the short card goes along with it.
    if (hinted && !hint.contains(event.target)) stand(hint, hinted)
  }, { passive: true, capture: true })
  addEventListener('resize', () => { stand(card, from); hide() })
  return { press: (button) => (from === button ? close(true) : open(button)), close, hintable }
})()
