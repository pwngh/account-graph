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
  const result = el('button', { type: 'button', class: 'result', on: { click: () => at === 0 && next() } }, el('small', {}, 'Anuncio · tessaly.example'), el('b', {}, 'Su familia es lo primero. Hable con nosotros hoy.'), el('span', {}, 'Divorcio, custodia y manutención. Atención en español.'))
  const site = el('iframe', { title: 'The sample firm on the caller’s phone', tabindex: '-1' })
  const device = el('div', { class: 'device', 'data-state': 'ad' }, el('div', { class: 'glass' },
    el('div', { class: 'bar' }, time, el('i', {})),
    el('div', { class: 'page ad' }, el('div', { class: 'ask' }, 'abogado de divorcio'), result, el('div', { class: 'blank' }, ...Array.from({ length: 9 }, () => el('i', {})))),
    el('div', { class: 'page site' }, site),
    el('div', { class: 'page ringing' }, el('span', { class: 'face' }, 'T'), el('b', {}, 'Tessaly'), how, clock, el('span', { class: 'end' }, handset()))))
  const where = el('span', { class: 'where' })
  const title = el('b', {})
  const told = el('span', { class: 'told', role: 'status' })
  const button = el('button', { type: 'button', class: 'primary', on: { click: () => next() } }, 'Next ', el('kbd', {}, 'Space'))
  const bar = el('div', { id: 'stage', role: 'group', 'aria-label': 'Demo scenes' }, where, title, told, button, el('button', { type: 'button', on: { click: () => hide() } }, 'Hide ', el('kbd', {}, 'H')))
  document.body.append(el('aside', { id: 'stage-phone', 'aria-label': 'The caller’s phone' }, device), bar)
  site.src = STAGE.phone

  let scenes = []
  let at = 0
  let running = false
  const hide = () => bar.classList.toggle('away')
  const draw = () => {
    where.textContent = at ? `${at} of ${scenes.length}` : `${scenes.length} scenes`
    title.textContent = at ? scenes[at - 1].title : 'Ready'
    button.disabled = running || at >= scenes.length
    Object.assign(bar.dataset, { at, running })
    time.textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  }

  let ticking
  /** Puts the phone in a state. Calls count up, faster than they were, to how long they lasted. */
  function phone(state, seconds) {
    clearInterval(ticking)
    device.dataset.state = state
    how.textContent = { calling: 'Calling…', missed: 'No answer', back: 'Calling back', talking: 'Connected' }[state] ?? ''
    const show = (n) => { clock.textContent = `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` }
    if (seconds === undefined) clock.textContent = ''
    else {
      const began = performance.now()
      show(0)
      ticking = setInterval(() => {
        const part = Math.min(1, (performance.now() - began) / 1600)
        show(seconds * part)
        if (part === 1) clearInterval(ticking)
      }, 40)
    }
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

  /** Runs the next scene and shows what it changed. */
  async function next() {
    if (running || at >= scenes.length) return
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
      await open(scene.stage ?? `#${scene.see[1].split('#')[1]}`, began)
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
      next()
    } else if (event.key === 'h') hide()
  })
  // A press on the call button of the page in the phone is the second scene.
  addEventListener('message', ({ origin, data }) => { if (origin === new URL(STAGE.phone).origin && data === 'call' && at === 1) next() })

  fetch('/stage/scenes').then((answer) => answer.json()).then((answer) => {
    ;({ scenes, next: at } = answer)
    if (at < PHONE.length) {
      document.body.classList.add('with-phone')
      phone(PHONE[at])
    }
    draw()
  })
}
