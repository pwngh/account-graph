// The demo's stage, over the reviewer screen. It runs after the screen's own scripts and uses what they define.
// Each scene asks the demo server to do what the site, the phone system or the office would, then opens the view it changed.
{
  /** What each state of the phone is, for who cannot read its Spanish. */
  const CAPTIONS = {
    ad: 'They search and see the ad', site: 'They open the firm’s site', calling: 'They call', missed: 'Nobody answers', back: 'Staff call back', talking: 'Staff call back', 'text-form': 'Staff text the intake form', form: 'They open it',
    'form-sent': 'They have sent it', signed: 'They have signed', 'text-time': 'Their call is confirmed', director: 'The director calls', 'text-pay': 'Staff text the enroll-and-pay link', pay: 'They enroll and pay', paid: 'They have paid', 'text-sign': 'Staff text the documents', sign: 'They sign the documents',
  }
  /** The firm's texts, in the order they come, each by the state of the phone that brings it. */
  const TEXTS = [
    ['text-form', 'Tessaly: gracias por hablar con nosotros, Inés. Complete sus datos aquí:', 'tessaly.example/datos'],
    ['signed', 'Revise y firme sus documentos:', 'tessaly.example/firmar'],
    ['text-time', 'Su llamada con M. Ortega es el miércoles a las 11:00.'],
    ['text-pay', 'Inscríbase y pague aquí:', 'tessaly.example/inscripcion'],
  ]
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const handset = () => svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, svg('path', { d: 'M3.4 1.5h2.3l1.2 3.1-1.6 1.2c.8 1.7 2.2 3.1 3.9 3.9l1.2-1.6 3.1 1.2v2.3c0 1-.8 1.8-1.8 1.7C6.5 12.9 3.1 9.5 1.7 3.3 1.6 2.3 2.4 1.5 3.4 1.5Z' }))

  const time = el('span', {})
  const how = el('span', { class: 'how' })
  const clock = el('span', { class: 'clock' })
  const result = el('button', { type: 'button', class: 'result', on: { click: () => at === 0 && !playing && next() } }, el('small', {}, 'Anuncio · tessaly.example'), el('b', {}, 'Su familia es lo primero. Hable con nosotros hoy.'), el('span', {}, 'Divorcio, custodia y manutención. Atención en español.'))
  const site = el('iframe', { title: 'The sample firm on the caller’s phone', tabindex: '-1' })
  const thread = el('div', { class: 'thread' })
  const paper = el('div', { class: 'sheet' })
  const device = el('div', { class: 'device', 'data-state': 'ad' }, el('div', { class: 'screen' },
    el('div', { class: 'bar' }, time, el('i', {})),
    el('div', { class: 'page ad' }, el('div', { class: 'ask' }, 'abogado de divorcio'), result, el('div', { class: 'blank' }, ...Array.from({ length: 9 }, () => el('i', {})))),
    el('div', { class: 'page site' }, site),
    el('div', { class: 'page texts' }, el('div', { class: 'with' }, el('span', { class: 'face' }, 'T'), el('b', {}, 'Tessaly')), thread),
    el('div', { class: 'page paper' }, paper),
    el('div', { class: 'page ringing' }, el('span', { class: 'face' }, 'T'), el('b', {}, 'Tessaly'), how, clock, el('span', { class: 'end' }, handset()))))
  const caption = el('span', {})
  const desk = el('aside', { id: 'stage-desk', 'aria-label': 'The firm’s own screen' })
  const where = el('span', { class: 'where' })
  const title = el('b', {})
  const told = el('span', { class: 'told', role: 'status' })
  /** A button of the bar. Pressed with the mouse it does not keep the focus, so Space goes on running scenes. */
  const press = (name, key, go, kind = '') => el('button', { type: 'button', class: kind, on: { click: (event) => { if (event.detail > 0) event.currentTarget.blur(); go() } } }, name, ' ', el('kbd', {}, key))
  const button = press('Next', 'Space', () => !playing && next(), 'primary')
  const again = press('Restart', 'R', () => restart())
  const bar = el('div', { id: 'stage', role: 'group', 'aria-label': 'Demo scenes' }, where, title, told, el('span', { class: 'keys' }, button, press('Play', 'P', () => play()), again, press('Hide', 'H', () => hide())))
  document.body.append(el('aside', { id: 'stage-phone', 'aria-label': 'The caller’s phone' }, device, el('small', { 'aria-hidden': 'true' }, el('b', {}, 'The caller’s phone'), caption)), bar)
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
        if (now && now.boot !== boot && now.ready) break
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
  let starting = true
  const draw = () => {
    where.textContent = at ? `${at} of ${scenes.length}` : ''
    title.textContent = at ? scenes[at - 1].title : scenes.length ? `${scenes.length} scenes` : ''
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
  document.body.append(light, desk)
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
      const side = $('view').getBoundingClientRect()
      const inner = row.closest('.scroll')?.getBoundingClientRect()
      if (rect.top < 12 || rect.bottom > floor || rect.left < side.left - 1 || rect.right > side.right + 1 && row.closest('.board') || (inner && (rect.top < inner.top || rect.bottom > inner.bottom + 1))) {
        row.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
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

  const pageOf = (state) => (['ad', 'site'].includes(state) ? state : ['calling', 'missed', 'back', 'talking', 'director'].includes(state) ? 'ringing' : state.startsWith('text') ? 'texts' : 'paper')
  /** The texts that have come once the phone is in a state. The last one is new. */
  function texts(state) {
    const last = TEXTS.findIndex(([when]) => when === state)
    thread.replaceChildren(...TEXTS.slice(0, last + 1).map(([, text, link], i) => el('div', { class: i === last ? 'bubble fresh' : 'bubble' }, text, link ? el('span', { class: 'go' }, link) : '')))
  }
  const field = (name, value = '') => el('div', { class: 'field' }, el('small', {}, name), el('span', {}, value))
  const bubble = () => [...thread.querySelectorAll('.go')].at(-1)
  async function tapped(node, ms = 260) {
    node?.classList.add('pressed')
    await wait(ms)
    node?.classList.remove('pressed')
  }
  /** Types words into fields, all done in about the time given. */
  async function type(fields, words, ms = 1100) {
    const all = words.join('').length
    for (const [i, word] of words.entries()) {
      fields[i].classList.add('typing')
      for (let n = 1; n <= word.length; n++) {
        fields[i].lastElementChild.textContent = word.slice(0, n)
        await wait(ms / all)
      }
      fields[i].classList.remove('typing')
    }
  }
  const sheet = (title, text, ...rest) => paper.replaceChildren(el('small', {}, 'Tessaly Derecho Familiar'), el('b', {}, title), el('p', {}, text), ...rest)
  const go = (text) => el('span', { class: 'send' }, text)
  const done = (title, text) => paper.replaceChildren(el('div', { class: 'done' }, svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: 'M6 12.5l4 4 8-9' })), el('b', {}, title), el('p', {}, text)))
  const FORM = [['Dirección', 'Calle Ejemplo 12'], ['Correo', 'ines@example.org'], ['Hijos', 'Dos']]
  /** What they do on the phone before a scene's requests are made. */
  const DOES = {
    site: () => tapped(result),
    talking: async (scene) => {
      if (scene.shown.desk) return
      phone('back')
      await wait(1100)
    },
    form: async () => {
      await tapped(bubble())
      sheet('Sus datos', 'Esta página es de la firma.', ...FORM.map(([name]) => field(name)), go('Enviar'))
      phone('form')
      await wait(500)
    },
    'form-sent': async () => {
      await type([...paper.querySelectorAll('.field')], FORM.map(([, value]) => value))
      await tapped(paper.querySelector('.send'))
    },
    signed: async () => {
      texts('signed')
      phone('text-sign')
      await wait(800)
      await tapped(bubble())
      const signature = svg('svg', { class: 'signature', viewBox: '0 0 200 60', 'aria-hidden': 'true' }, svg('path', { pathLength: 1, d: 'M12 42c10-30 18-30 16-8s8 14 14-4 12-8 10 4 10 8 16-2 12-6 10 4 12 6 20-2 M112 44c4-26 14-38 18-24s-10 34 2 30 14-26 20-24-4 20 8 18 12-12 24-14' }))
      sheet('Acuerdo de representación', 'Revise el documento y firme abajo.', el('div', { class: 'lines' }, ...Array.from({ length: 6 }, () => el('i', {}))), signature, go('Firmar'))
      phone('sign')
      await wait(300)
      signature.classList.add('drawn')
      await wait(1000)
      await tapped(paper.querySelector('.send'))
    },
    director: async () => {
      phone('back')
      how.textContent = 'M. Ortega · Calling you'
      caption.textContent = CAPTIONS.director
      await wait(1200)
    },
    paid: async () => {
      await tapped(bubble())
      sheet('Inscripción', 'Pago inicial de su caso.', field('Total', '$400.00'), field('Pago', 'Tarjeta de prueba'), go('Inscribirse y pagar'))
      phone('pay')
      await wait(900)
      const button = paper.querySelector('.send')
      await tapped(button)
      button.textContent = 'Procesando…'
      await wait(500)
    },
  }
  /** The firm's own screen: what staff type in it, before its requests are made. */
  async function atDesk({ name, fields }) {
    const rows = fields.map(([label]) => field(label))
    desk.replaceChildren(el('div', { class: 'desk-head' }, el('b', {}, name), el('small', {}, 'The firm’s own screen')), ...rows, el('span', { class: 'send' }, 'Save'))
    desk.classList.add('on')
    await wait(350)
    await type(rows, fields.map(([, value]) => value), 1500)
    await tapped(desk.querySelector('.send'))
  }
  async function leaveDesk({ done: words }) {
    desk.querySelector('.send').replaceChildren(words)
    desk.classList.add('saved')
    await wait(700)
    desk.classList.remove('on', 'saved')
  }

  /** How sure the credit of the contact's ad is, as GET /attribute says. It stands in the account while the scenes are about it. */
  const meterFill = el('i', {})
  const creditShare = el('b', {})
  const creditWords = el('span', { class: 'reason' })
  const creditBox = el('div', { class: 'stage-credit' }, el('div', {}, el('span', { class: 'what' }, 'Ad credit of contact:ines-vega'), el('code', {}, 'GET /attribute')), el('div', { class: 'say' }, creditShare, creditWords), el('div', { class: 'scale' }, meterFill, el('u', {}, el('small', {}, '90%'))))
  let credit
  let counting
  function showCredit(now) {
    clearInterval(counting)
    if (!now) {
      credit = undefined
      return creditBox.remove()
    }
    const from = credit?.share ?? 0
    const began = performance.now()
    credit = now
    const paint = (share) => {
      creditShare.textContent = percent(share)
      meterFill.style.width = `${share * 100}%`
    }
    const settle = () => {
      paint(now.share)
      creditBox.classList.toggle('sure', now.campaign !== null)
      creditWords.textContent = now.campaign === null ? 'Not credited. It takes 90%.' : `Credited to ${now.campaign}`
    }
    if (from === now.share) settle()
    else {
      creditBox.classList.remove('sure')
      creditWords.textContent = ''
      counting = setInterval(() => {
        const part = Math.min(1, (performance.now() - began) / 1100)
        paint(from + (now.share - from) * (1 - (1 - part) ** 3))
        if (part === 1) {
          clearInterval(counting)
          settle()
        }
      }, 40)
    }
    stand()
  }
  /** Puts the credit back where a view that was read again has dropped it. */
  function stand() {
    const tiles = credit && place().name === 'accounts' && document.querySelector('#view #detail .tiles, #view .tiles')
    if (tiles && tiles.nextElementSibling !== creditBox) tiles.after(creditBox)
  }
  setInterval(stand, 150)

  let ticking
  let shown = 0
  /** Puts the phone in a state. Calls count up, faster than they were, to how long they lasted. */
  function phone(state, seconds) {
    clearInterval(ticking)
    device.dataset.state = state
    device.dataset.page = pageOf(state)
    caption.textContent = CAPTIONS[state] ?? ''
    how.textContent = { calling: 'Calling…', missed: 'No answer', back: 'Calling you', talking: 'Connected', director: 'M. Ortega · Connected' }[state] ?? ''
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
    [1, () => next()], [4.5, () => next()], [8, () => next()], [15, () => next()], [20, () => next()], [28, () => next()],
    // The moment the story turns on is held.
    [31, () => next()], [39, () => next()], [43.5, () => next()], [49, () => next()], [55, () => next()], [60, () => next()], [63, () => next()], [69, () => next()],
    [74, () => turn(CLIENTS, ['Busqueda: North'])], [82, () => turn('#/journey/contact%3Aines-vega')],
  ]
  const turn = async (address, words) => {
    showCredit()
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
      const shown = scene.shown ?? {}
      spot()
      await DOES[shown.phone]?.(scene)
      if (shown.caption) caption.textContent = shown.caption
      if (shown.desk) await atDesk(shown.desk)
      const began = marks()
      const answer = await fetch('/stage/run', { method: 'POST', headers: { 'x-stage': '1' } })
      const { lines, ms, error, credit: sure } = await answer.json()
      if (!answer.ok) throw new Error(error)
      at += 1
      told.textContent = lines.join(' ')
      bar.dataset.ms = ms
      const state = shown.phone
      if (TEXTS.some(([when]) => when === state)) texts(state)
      if (state === 'form-sent') done('Datos enviados', 'Gracias, Inés.')
      if (state === 'signed') done('Documentos firmados', 'Recibirá una copia.')
      if (state === 'paid') done('Pago recibido', '$400.00 · Tarjeta de prueba')
      if (state && !(shown.desk && state === 'talking')) phone(state, shown.seconds)
      if (shown.desk) await leaveDesk(shown.desk)
      document.body.classList.toggle('with-phone', Boolean(state))
      if (!quiet) {
        await open(scene.stage ?? `#${scene.see[1].split('#')[1]}`, began)
        spot(scene.spot)
      }
      showCredit(sure)
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

  const look = () => fetch('/stage/scenes').then((answer) => answer.json())
  draw()
  look().then(async (answer) => {
    while (!answer.ready) {
      told.textContent = 'Loading sample data…'
      await wait(400)
      answer = await look().catch(() => answer)
    }
    // What was on screen while the data came in holds only part of it.
    if (told.textContent) load()
    told.textContent = ''
    starting = false
    ;({ scenes, next: at, boot } = answer)
    // Opened again half way, the phone is as the last scene left it.
    const state = at === 0 ? 'ad' : scenes[at - 1].shown?.phone
    if (state) {
      document.body.classList.add('with-phone')
      if (TEXTS.some(([when]) => when === state)) texts(state)
      if (pageOf(state) === 'paper') done('Tessaly', '')
      phone(state, scenes[at - 1]?.shown?.seconds)
    }
    draw()
  })
}
