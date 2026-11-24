// The demo's stage, over the reviewer screen. It runs after the screen's own scripts and uses what they define.
// Each scene asks the demo server to do what the site, the phone system or the office would, then opens the view it changed.
{
  /** What the phone shows once a scene has run, and before the first. A scene without one is past the phone. */
  const PHONE = ['ad', 'site', 'calling', 'missed', 'talking']
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const handset = () => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: 'M3.4 1.5h2.3l1.2 3.1-1.6 1.2c.8 1.7 2.2 3.1 3.9 3.9l1.2-1.6 3.1 1.2v2.3c0 1-.8 1.8-1.8 1.7C6.5 12.9 3.1 9.5 1.7 3.3 1.6 2.3 2.4 1.5 3.4 1.5Z' }))

  const time = el('span', {})
  const how = el('span', { class: 'how' })
  const clock = el('span', { class: 'clock' })
  const result = el('button', { type: 'button', class: 'result', on: { click: () => at === 0 && !playing && next() } }, el('small', {}, 'Anuncio · tessaly.example'), el('b', {}, 'Su familia es lo primero. Hable con nosotros hoy.'), el('span', {}, 'Divorcio, custodia y manutención. Atención en español.'))
  const site = el('iframe', { title: 'The sample firm on the caller’s phone', tabindex: '-1' })
  const device = el('div', { class: 'device', 'data-state': 'ad' }, el('div', { class: 'screen' },
    el('div', { class: 'bar' }, time, el('i', {})),
    el('div', { class: 'page ad' }, el('div', { class: 'ask' }, 'abogado de divorcio'), result, el('div', { class: 'blank' }, ...Array.from({ length: 9 }, () => el('i', {})))),
    el('div', { class: 'page site' }, site),
    el('div', { class: 'page ringing' }, el('span', { class: 'face' }, 'T'), el('b', {}, 'Tessaly'), how, clock, el('span', { class: 'end' }, handset()))))
  const where = el('span', { class: 'where' })
  const title = el('b', {})
  const told = el('span', { class: 'told', role: 'status' })
  /** A button of the bar. Pressed with the mouse it does not keep the focus, so Space goes on running scenes. */
  const press = (name, key, go, kind = '') => el('button', { type: 'button', class: kind, on: { click: (event) => { if (event.detail > 0) event.currentTarget.blur(); go() } } }, name, ' ', el('kbd', {}, key))
  const button = press('Next', 'Space', () => !playing && next(), 'primary')
  const again = press('Restart', 'R', () => restart())
  const bar = el('div', { id: 'stage', role: 'group', 'aria-label': 'Demo scenes' }, where, title, told, el('span', { class: 'keys' }, button, press('Play', 'P', () => play()), again, press('Hide', 'H', () => hide())))
  document.body.append(el('aside', { id: 'stage-phone', 'aria-label': 'The caller’s phone' }, device, el('small', { 'aria-hidden': 'true' }, 'The caller’s phone')), bar)
  site.src = STAGE.phone

  let scenes = []
  let at = 0
  let running = false
  let boot
  const hide = () => bar.classList.toggle('away')
  /** Starts the demo over, and comes back once it has: the story is at its beginning. */
  async function restart() {
    if (running || starting) return
    stop()
    starting = true
    told.classList.remove('bad')
    told.textContent = 'Starting over…'
    bar.classList.remove('away')
    draw()
    try {
      const answer = await fetch('/stage/restart', { method: 'POST', headers: { 'x-stage': '1' } })
      if (!answer.ok) throw new Error((await answer.json()).error)
      for (;;) {
        await wait(400)
        const now = await fetch('/stage/scenes').then((answer) => answer.json()).catch(() => undefined)
        if (now && now.boot !== boot) break
      }
      history.replaceState(null, '', location.pathname)
      location.reload()
    } catch (error) {
      starting = false
      told.textContent = `Not started over: ${error.message}`
      told.classList.add('bad')
      draw()
    }
  }
  let starting = false
  const draw = () => {
    where.textContent = at ? `${at} of ${scenes.length}` : ''
    title.textContent = at ? scenes[at - 1].title : `${scenes.length} scenes`
    const over = at > 0 && at >= scenes.length
    button.disabled = running || starting || over
    button.hidden = over
    again.classList.toggle('primary', over)
    again.disabled = running || starting
    Object.assign(bar.dataset, { at, running })
    time.textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  }

  /** What a row says, found in the view: the row that says the first, or the one after it that says the next. */
  function found([first, next]) {
    const rows = [...document.querySelectorAll('#view :is(table.campaign-report tr, .timeline-entry, .board li, .queue-pair, .needs li, .inbox-call)')].filter((row) => row.checkVisibility())
    const from = rows.findIndex((row) => row.textContent.includes(first))
    return next === undefined || from < 0 ? rows[from] : rows.slice(from + 1).find((row) => row.textContent.includes(next))
  }
  const light = el('div', { id: 'stage-light', 'aria-hidden': 'true' })
  document.body.append(light)
  let lit
  /** Lights a row for a moment, and dims the rest. It stays on the row while the view still moves or is read again. */
  function spot(words) {
    clearInterval(lit)
    light.classList.remove('on')
    if (!words) return
    const began = performance.now()
    const place = () => {
      const row = performance.now() - began < 3200 ? found(words) : undefined
      light.classList.toggle('on', Boolean(row))
      if (!row) return performance.now() - began < 3200 ? undefined : clearInterval(lit)
      let rect = row.getBoundingClientRect()
      const floor = innerHeight - (bar.classList.contains('away') ? 16 : innerHeight - bar.getBoundingClientRect().top + 12)
      if (rect.top < 12 || rect.bottom > floor) {
        row.scrollIntoView({ block: 'center', behavior: 'instant' })
        rect = row.getBoundingClientRect()
      }
      // As much of it as can be seen: a wide table is panned within its own frame.
      const frame = (row.closest('.wide, .scroll') ?? $('view')).getBoundingClientRect()
      const [left, right] = [Math.max(rect.left, frame.left), Math.min(rect.right, frame.right)]
      Object.assign(light.style, { left: `${left + scrollX - 8}px`, top: `${rect.top + scrollY - 4}px`, width: `${right - left + 16}px`, height: `${rect.height + 8}px` })
    }
    place()
    lit = setInterval(place, 120)
  }

  let ticking
  let shown = 0
  /** Puts the phone in a state. Calls count up, faster than they were, to how long they lasted. */
  function phone(state, seconds) {
    clearInterval(ticking)
    device.dataset.state = state
    how.textContent = { calling: 'Calling…', missed: 'No answer', back: 'Calling back', talking: 'Connected' }[state] ?? ''
    const show = (n) => { shown = n; clock.textContent = `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` }
    if (seconds === undefined) clock.textContent = ''
    else {
      const began = performance.now()
      // A call that goes on counts on.
      const from = state === 'missed' ? shown : 0
      show(from)
      ticking = setInterval(() => {
        const part = Math.min(1, (performance.now() - began) / 1600)
        show(from + (seconds - from) * part)
        if (part === 1) clearInterval(ticking)
      }, 40)
    }
  }

  /** The ninety seconds of docs/demo.md: when each thing happens, in seconds. */
  const CLIENTS = '#/channels/////30/client'
  const SHOW = [
    [1, () => next()], [5, () => next()], [9.5, () => next()],
    [21, () => turn('#/accounts/visitor%3Av-4821')], [33, () => next()],
    // The listing's call and the client at another office happen unseen, before their week is shown.
    [41.5, () => next(true)], [42.5, () => next(true)], [43.5, () => next()], [54, () => next()],
    [64, () => turn(CLIENTS, ['Busqueda: North'])], [70.5, () => turn('#/channels///outcome.office_served//30/client', ['Busqueda: North', 'river'])],
    [77, () => turn('#/accounts/contact%3Aines-vega')],
  ]
  const turn = async (address, words) => {
    await open(address)
    spot(words)
  }
  let playing
  function stop() {
    playing?.abort()
    playing = undefined
    document.body.classList.remove('playing')
    bar.classList.remove('away')
    draw()
  }
  /** Plays the whole show, once, from the start. A second press stops it. */
  async function play() {
    if (playing) return stop()
    if (at > 0 || running || starting) {
      told.textContent = 'Press R to restart, then P to play.'
      return
    }
    const { signal } = (playing = new AbortController())
    for (let n = 3; n > 0 && !signal.aborted; n--) {
      told.textContent = `Starting in ${n}`
      await wait(1000)
    }
    if (signal.aborted) return
    told.textContent = ''
    document.body.classList.add('playing')
    bar.classList.add('away')
    const began = performance.now()
    for (const [second, go] of SHOW) {
      while (!signal.aborted && performance.now() - began < second * 1000) await wait(50)
      if (signal.aborted) return
      await go()
    }
    while (!signal.aborted && performance.now() - began < 90_000) await wait(100)
    if (!signal.aborted) stop()
  }

  const marks = () => new Set([...document.querySelectorAll('.graph .node')].map(({ node }) => node.id))
  /** Opens a view, and brings in what its graph did not hold before. */
  async function open(address, before) {
    if (location.hash === address) await load()
    else {
      const turn = loading
      location.hash = address
      for (let i = 0; i < 100 && (loading === turn || pending); i++) await wait(40)
    }
    scrollTo({ top: 0 })
    if (!before) return
    for (const each of document.querySelectorAll('.graph .node')) if (!before.has(each.node.id)) each.classList.add('arrive')
    for (const each of document.querySelectorAll('.graph .edge')) if (each.edge && !(before.has(each.edge.a) && before.has(each.edge.b))) for (const part of [each, each.edge.tag]) part?.classList.add('arrive')
  }

  /** Runs the next scene and shows what it changed, or only runs it. */
  async function next(quiet = false) {
    if (running || starting || at >= scenes.length) return
    running = true
    told.classList.remove('bad')
    draw()
    const scene = scenes[at]
    try {
      if (at === 0) {
        result.classList.add('pressed')
        await wait(260)
      }
      if (at === 3) phone('back')
      const began = marks()
      const answer = await fetch('/stage/run', { method: 'POST', headers: { 'x-stage': '1' } })
      const { lines, ms, error } = await answer.json()
      if (!answer.ok) throw new Error(error)
      at += 1
      told.textContent = lines.join(' ')
      bar.dataset.ms = ms
      const state = PHONE[at]
      if (state === 'talking') await wait(1100)
      if (state) phone(state, { calling: 22, missed: 95, talking: 410 }[state])
      document.body.classList.toggle('with-phone', Boolean(state))
      if (!quiet) {
        await open(scene.stage ?? `#${scene.see[1].split('#')[1]}`, began)
        spot(scene.spot)
      }
    } catch (error) {
      told.textContent = `Scene failed: ${error.message}`
      told.classList.add('bad')
    }
    running = false
    draw()
  }

  addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input, select, textarea, dialog')) return
    if (event.code === 'Space' && !event.target.closest('a, button')) {
      event.preventDefault()
      if (!playing) next()
    } else if (event.key === 'h') hide()
    else if (event.key === 'p') play()
    else if (event.key === 'r') restart()
    else if (event.key === 'Escape') stop()
  })
  // A press on the call button of the page in the phone is the second scene.
  addEventListener('message', ({ origin, data }) => { if (origin === new URL(STAGE.phone).origin && data === 'call' && at === 1 && !playing) next() })

  fetch('/stage/scenes').then((answer) => answer.json()).then((answer) => {
    ;({ scenes, next: at, boot } = answer)
    if (at < PHONE.length) {
      document.body.classList.add('with-phone')
      phone(PHONE[at])
    }
    draw()
  })
}
