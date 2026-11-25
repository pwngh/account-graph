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
/** When something was, as a card says it. To the second, it names the zone too: the hours of a report may be in another. */
const moment = (at, seconds = false) => (typeof at === 'number' && at > 0 ? new Date(at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds && { second: '2-digit', timeZoneName: 'short' }), ...(new Date(at).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) }) : undefined)
/** Where an arrival came from, in words. */
const cameFrom = (row) => (row?.source ? `${row.source}${row.campaign || row.campaignId ? ` · ${row.campaign ?? row.campaignId}` : ''}` : undefined)
/** A share as a target is written: whole percents where it is one, and never 0% for one that is more than nothing. */
const sharePercent = (share) => (share < 0.0001 ? '<0.01%' : `${(share * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`)
/** A target and whether it is met. Nothing is said where the firm set none. */
const goal = (text, met, short = '') => [`Target ${text}, set by you.`, met ? ' Met.' : ` Not met${short ? `: ${short}` : ''}.`]

/** What the screen's own routes answered within the last minute, so two cards that ask the same ask once. */
const lately = new Map()
/** How often it was let go before its time, because what it was read from has changed. */
let lapses = 0
function lapse() {
  lately.clear()
  lapses += 1
}
function recent(path) {
  const held = lately.get(path)
  // A timer is late on a machine that slept, so the age is looked at as well.
  if (held && Date.now() - held.at < 60_000) return held.answer
  const asked = { at: Date.now(), answer: api('GET', path) }
  const drop = () => lately.get(path) === asked && lately.delete(path)
  lately.set(path, asked)
  asked.answer.catch(drop)
  setTimeout(drop, 60_000)
  return asked.answer
}
/** Puts away everything a card shows or holds: whoever signs in next is shown what they ask for themselves. */
function forgetCards() {
  cards.close()
  lapse()
  broughtTo = undefined
}

/** The icon that opens a card. `of` gives what the card is made from, when it is made, and `id` tells one from another of its kind. */
function detail(key, { label, id = '', of }) {
  const button = el('button', { type: 'button', class: 'detail', 'data-key': `detail ${key} ${id}`, 'aria-label': `Details of ${label}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: () => cards.press(button) } })
  button.about = { key, of }
  return button
}

/**
 * Fills a box with what a card says, and goes on to ask for the rest. Filled
 * again, what was fetched stays until it has been fetched anew, or for half a
 * second where it was read before something changed. Boxes that are one box
 * share `turns`: an answer is drawn only while its turn is the newest.
 */
function telling(box, settled = () => {}, most = 10, turns = { now: 0 }) {
  let last
  let rest
  let lapsed
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
    const asked = ++turns.now
    const data = of()
    const now = data && DETAILS[key].now(data, short)
    if (!now) return false
    const more = short ? undefined : DETAILS[key].more?.(data)
    const outdated = rest !== undefined && lapsed !== lapses
    const began = lapses
    // What nobody has to wait for is said at once.
    draw(now, more !== undefined && rest === undefined, undefined, short)
    const late = outdated && more !== undefined ? setTimeout(() => {
      if (asked !== turns.now) return
      rest = undefined
      draw(now, true)
    }, 500) : undefined
    more?.then((found) => {
      clearTimeout(late)
      if (asked !== turns.now) return
      rest = found ?? {}
      lapsed = began
      draw(now)
    }, (error) => {
      clearTimeout(late)
      if (asked !== turns.now) return
      rest = undefined
      draw(now, false, error.message)
    })
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
  /** Every card is drawn in this one, so each opening and each closing ends the turn of what was asked before. */
  const turns = { now: 0 }
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
  const narrow = matchMedia('(max-width: 520px)')
  function stand(box, by) {
    if (!by?.isConnected) return
    const at = by.getBoundingClientRect()
    // On a phone it is a sheet at the foot of the screen, and the page is moved up so that what it is of stays in sight above it.
    // The page is made as much longer as the sheet is tall, so that this can be done at its end too.
    if (narrow.matches) {
      const sheet = box.getBoundingClientRect()
      document.body.style.setProperty('--sheet', `${Math.ceil(sheet.height)}px`)
      if (sheet.height > 0 && at.bottom + 8 > sheet.top) {
        by.style.scrollMarginBottom = `${Math.ceil(sheet.height) + 8}px`
        by.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      }
      return
    }
    const [under, over] = [innerHeight - at.bottom - 16, at.top - 16]
    box.style.maxHeight = ''
    const below = box.offsetHeight <= under || under >= over
    // As tall as the side it is on and no taller, its padding and border counted, so the icon is never covered. The rest of a long card is scrolled to.
    const room = Math.max(below ? under : over, 96)
    box.style.maxHeight = `${room}px`
    const extra = box.offsetHeight - room
    if (extra > 0) box.style.maxHeight = `${Math.max(48, room - extra)}px`
    box.style.left = `${Math.max(8, Math.min(at.left - 14, innerWidth - box.offsetWidth - 8))}px`
    box.style.top = `${Math.max(8, below ? at.bottom + 8 : at.top - box.offsetHeight - 8)}px`
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
    tell = telling(body, () => stand(card, from), 10, turns)
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
    turns.now += 1
    if (card.matches(':popover-open')) card.hidePopover()
    button?.setAttribute('aria-expanded', 'false')
    if (back && button?.isConnected) button.focus({ preventScroll: true })
    for (const part of [title, worth, body]) part.replaceChildren()
    hide()
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
    for (const part of [hintTitle, hintWorth, hintBody]) part.replaceChildren()
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
  addEventListener('hashchange', () => close())
  addEventListener('scroll', (event) => {
    if (!card.contains(event.target)) stand(card, from)
    // The focus brings a mark into view by scrolling, so the short card goes along with it.
    if (hinted && !hint.contains(event.target)) stand(hint, hinted)
  }, { passive: true, capture: true })
  addEventListener('resize', () => { stand(card, from); hide() })
  return { press: (button) => (from === button ? close(true) : open(button)), close, hintable }
})()
