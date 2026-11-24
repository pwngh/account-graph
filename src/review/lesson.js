// How each view works, a step at a time: one picture that changes, and one sentence that says how.
const LESSON_ICONS = {
  laptop: 'M3.2 3.5h9.6v7H3.2zM1.6 12.8h12.8', mail: 'M2.2 4h11.6v8.2H2.2zM2.4 4.4 8 8.8l5.6-4.4', ad: 'M3 6.5v3h2l5.5 3v-9L5 6.5ZM12.6 6.4v3.2', page: 'M3.5 2.5h9v11h-9zM6 5.5h4M6 8h4',
  money: 'M8 2.2v11.6M11 4.8c-.6-1-1.7-1.5-3-1.5-1.7 0-3 .9-3 2.3 0 3.2 6.2 1.6 6.2 4.8 0 1.4-1.4 2.3-3.2 2.3-1.5 0-2.7-.6-3.3-1.6', check: 'M3 8.4 6.4 11.8 13 4.6', cross: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2',
  lock: 'M4 7.2h8v6H4zM5.8 7.2V5.4a2.2 2.2 0 0 1 4.4 0v1.8', send: 'M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', voice: 'M4.6 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM11.4 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM4.6 10.4h6.8',
  graph: 'M2.6 4.2a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M10.2 6a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M5.4 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M5.9 4.6l4.4 1M4.7 5.8l1.9 4.6M10.9 7.4l-2.8 3.3', person: 'M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8ZM2.8 13.4c.5-2.5 2.5-3.8 5.2-3.8s4.7 1.3 5.2 3.8',
}
/**
 * A lesson names what can be in its picture, then says what is where at each
 * step: [x, y], and for a box its width and height. What a step leaves out
 * fades. A line is between two of them: [one, other, tone, words].
 */
const LESSONS = {
  accounts: {
    in: { a: ['who', 'account', 'max'], b: ['who', 'account', 'sam'], c: ['who', 'account', 'lee'], d: ['who', 'account', 'ana'], laptop: ['thing', 'laptop', 'a laptop'], desk: ['thing', 'calls', 'an office phone'], one: ['box', 'one person', 'same'] },
    steps: [
      ['Here is an account. On its own it tells us nothing about who is behind it.', { a: [260, 110] }],
      ['It logs in on a laptop. We write down that the two were seen together.', { a: [160, 110], laptop: [330, 110] }, [['a', 'laptop']]],
      ['Another account logs in on the very same laptop.', { a: [130, 110], laptop: [260, 110], b: [390, 110] }, [['a', 'laptop'], ['b', 'laptop']]],
      ['Now the two share something. That is a tie. The number is how sure it makes us that they are one person.', { a: [150, 100], b: [370, 100] }, [['a', 'b', 'same', '98%']]],
      ['If many share it, like an office phone, it says little about any two of them. So the number is low, or there is none.', { a: [90, 55], b: [90, 160], c: [430, 55], d: [430, 160], desk: [260, 100] }, [['a', 'desk', 'faint'], ['b', 'desk', 'faint'], ['c', 'desk', 'faint'], ['d', 'desk', 'faint']]],
      ['Sure enough, and the two become one person. How sure is yours to set. It starts at 90%.', { one: [260, 104, 320, 150], a: [180, 100], b: [340, 100] }, [['a', 'b', 'same', '98%']]],
      ['If you know they are two people, press Keep apart. Then nothing they share will ever join them.', { a: [140, 100], b: [380, 100] }, [['a', 'b', 'apart', 'kept apart']]],
    ],
  },
  journey: {
    in: { ad: ['thing', 'ad', 'an ad'], v: ['who', 'visitor', 'a browser'], c: ['who', 'caller', 'a number'], k: ['who', 'contact', 'a name'], one: ['box', 'one person', 'same'], line: ['bar'], m1: ['thing', 'ad', 'clicked'], m2: ['thing', 'calls', 'rang'], m3: ['thing', 'mail', 'signed up'], m4: ['thing', 'check', 'enrolled'] },
    steps: [
      ['Someone clicks an ad. All we know of them is their browser.', { ad: [160, 110], v: [350, 110] }, [['ad', 'v']]],
      ['Later, someone rings. All the phone system knows is a number.', { v: [180, 110], c: [340, 110] }],
      ['They had just tapped your number on the page, in that browser. So the browser and the caller are tied.', { v: [160, 110], c: [360, 110] }, [['v', 'c', 'same', 'tapped, then rang']]],
      ['Then they sign up, in the same browser. Now there is a name too.', { v: [260, 60], c: [130, 160], k: [390, 160] }, [['v', 'c', 'same'], ['v', 'k', 'same']]],
      ['Three ids, but one person.', { one: [260, 115, 330, 204], v: [260, 74], c: [160, 156], k: [360, 156] }, [['v', 'c', 'same'], ['v', 'k', 'same']]],
      ['So everything they did goes on one line, in the order it happened. That is a journey.', { line: [260, 110, 420, 2], m1: [90, 110], m2: [200, 110], m3: [300, 110], m4: [430, 110] }],
    ],
  },
  board: {
    in: { c1: ['box', 'Missed', 'apart'], c2: ['box', 'inquiry', ''], c3: ['box', 'call', ''], c4: ['box', 'enrolled', ''], p: ['card', 'one person', ''], late: ['card', 'one person', 'late'], dot: ['word', 'too long', 'apart'] },
    steps: [
      ['Each column is a step on the way. You choose the steps.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170] }],
      ['Each card is one person. Not one call, and not one click.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170], p: [140, 90] }],
      ['They go a step further, and the card moves right.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170], p: [260, 90] }],
      ['It never goes back. The column is the furthest they ever got.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170], p: [380, 90] }],
      ['One thing comes first: a call you missed and nobody returned. That person waits in the first column until they are reached.', { c1: [80, 115, 110, 170], c2: [200, 115, 110, 170], c3: [320, 115, 110, 170], c4: [440, 115, 110, 170], p: [80, 90] }],
      ['A red dot means they have waited longer than that column allows.', { c1: [80, 115, 110, 170], c2: [200, 115, 110, 170], c3: [320, 115, 110, 170], c4: [440, 115, 110, 170], late: [80, 90], dot: [80, 136] }],
    ],
  },
  decide: {
    in: { a: ['who', 'account', 'max'], b: ['who', 'account', 'sam'], c: ['who', 'account', 'lee'], d: ['who', 'account', 'ana'], g1: ['box', 'one person', 'same'], g2: ['box', 'another', 'same'], m: ['thing', 'mail', 'same email'], l: ['thing', 'laptop', 'same laptop'], one: ['box', 'one person', 'same'] },
    steps: [
      ['Some pairs look alike, but not enough to be joined without you.', { a: [150, 105], b: [370, 105] }, [['a', 'b', 'related', '78%']]],
      ['Others look sure, yet were held back: one thin link would have made two groups into one, or someone in them was kept apart.', { g1: [130, 105, 180, 130], g2: [390, 105, 180, 130], a: [95, 100], c: [165, 100], b: [355, 100], d: [425, 100] }, [['a', 'c', 'same'], ['b', 'd', 'same'], ['c', 'b', 'related', 'held back']]],
      ['So the two are put side by side. What they share is green.', { a: [100, 105], b: [420, 105], m: [215, 105], l: [305, 105] }, [['a', 'm', 'same'], ['b', 'l', 'same'], ['m', 'l', 'same']]],
      ['Join: from now on they are one person.', { one: [260, 105, 330, 150], a: [180, 100], b: [340, 100] }, [['a', 'b', 'same']]],
      ['Keep apart: nothing they share will ever join them.', { a: [140, 105], b: [380, 105] }, [['a', 'b', 'apart', 'kept apart']]],
      ['Not sure? Skip. That decides nothing. Undo takes back the last thing you decided here.', { a: [150, 105], b: [370, 105] }, [['a', 'b', 'related', '78%']]],
    ],
  },
  calls: {
    in: { c: ['who', 'caller', 'a caller'], you: ['thing', 'person', 'you'], ring: ['thing', 'calls', 'rings'], yes: ['word', 'answered', 'same'], no: ['word', 'missed', 'apart'], vm: ['thing', 'voice', 'voicemail'], wait: ['box', 'waiting for a callback', 'apart'], back: ['word', 'returned', 'same'], half: ['word', '2 of 4: 50% returned', 'same'], c1: ['who', 'caller', ''], c2: ['who', 'caller', ''], c3: ['who', 'caller', ''], c4: ['who', 'caller', ''], r1: ['word', 'reached', 'same'], r2: ['word', 'reached', 'same'], w3: ['word', 'waiting', 'apart'], w4: ['word', 'waiting', 'apart'] },
    steps: [
      ['Someone calls you.', { c: [130, 110], ring: [260, 110], you: [390, 110] }, [['c', 'ring'], ['ring', 'you', 'faint']]],
      ['Somebody picks up. The call was answered.', { c: [130, 100], you: [390, 100], yes: [260, 170] }, [['c', 'you', 'same']]],
      ['Nobody picks up. The call was missed. If they leave a message, it is a voicemail.', { c: [130, 100], you: [390, 100], vm: [260, 100], no: [260, 170] }, [['c', 'vm', 'apart']]],
      ['Now that caller is waiting for you. This page lists everyone who waits, longest first.', { wait: [260, 112, 380, 130], c1: [140, 120], c2: [220, 120], c3: [300, 120], c4: [380, 120] }],
      ['You ring back and they answer: returned. Or they ring again and get through: tried again. Either way they no longer wait.', { you: [130, 100], c: [390, 100], back: [260, 170] }, [['you', 'c', 'same', 'you ring back']]],
      ['Returned is a share: of the calls you missed, how many of the callers you have reached.', { c1: [110, 75], c2: [210, 75], c3: [310, 75], c4: [410, 75], r1: [110, 124], r2: [210, 124], w3: [310, 124], w4: [410, 124], half: [260, 185] }],
    ],
  },
  channels: {
    in: { ad: ['thing', 'ad', 'an ad'], cost: ['word', 'cost 100', ''], v: ['who', 'visitor', 'someone'], done: ['thing', 'check', 'enrolls'], worth: ['word', 'worth 300', 'same'], ad2: ['thing', 'ad', 'older ad'], o1: ['thing', 'check', ''], o2: ['thing', 'check', ''], o3: ['thing', 'check', ''], o4: ['thing', 'check', ''], each: ['word', '100 ÷ 4 = 25 each', ''], back: ['word', '300 ÷ 100 = 3.0×', 'same'], more: ['word', 'more to come', 'related'], now: ['word', 'today', ''], day: ['bar'] },
    steps: [
      ['You pay for an ad. What you paid is its cost.', { ad: [260, 95], cost: [260, 170] }],
      ['Someone clicks it and lands on your page. That is an arrival.', { ad: [150, 105], cost: [150, 175], v: [370, 105] }, [['ad', 'v', '', 'arrives']]],
      ['Days later they do what you hoped for. That is an outcome, and it is worth something to you.', { ad: [90, 105], cost: [90, 175], v: [260, 105], done: [430, 105], worth: [430, 175] }, [['ad', 'v'], ['v', 'done']]],
      ['Which ad gets the credit? The newest one they came from before that, if we are sure enough it was them. Only that one.', { ad2: [80, 50], ad: [80, 160], v: [260, 105], done: [430, 105] }, [['ad2', 'v', 'faint'], ['ad', 'v', 'same', 'newest'], ['v', 'done', 'same']]],
      ['Cost per outcome: what the ad cost, shared out over the outcomes it got credit for.', { ad: [110, 100], o1: [240, 100], o2: [300, 100], o3: [360, 100], o4: [420, 100], each: [260, 180] }, [['ad', 'o1', 'same']]],
      ['Return: what those outcomes are worth, over what the ad cost. At 3.0×, every 1 you spent is worth 3.', { ad: [160, 75], cost: [160, 144], done: [360, 75], worth: [360, 144], back: [260, 198] }, [['ad', 'done', 'same']]],
      ['Outcomes come days after the click. So the newest days always look worse than they will turn out.', { day: [260, 142, 420, 2], o1: [90, 105], o2: [155, 105], o3: [220, 105], more: [345, 105], now: [455, 105] }],
    ],
  },
  health: {
    in: { f1: ['thing', 'ad', 'arrivals'], f2: ['thing', 'calls', 'calls'], f3: ['thing', 'money', 'costs'], g: ['thing', 'graph', 'this system'], q: ['word', 'quiet', 'apart'], out: ['thing', 'send', 'ad platform'], no: ['word', 'refused', 'apart'], e1: ['card', 'Joined', ''], e2: ['card', 'Kept apart', ''], e3: ['card', 'Joined', ''], k1: ['thing', 'lock', ''], k2: ['thing', 'lock', ''], x: ['word', 'altered', 'apart'] },
    steps: [
      ['Things come in from your other systems. Each way in is a feed.', { f1: [170, 38], f2: [90, 108], f3: [170, 178], g: [370, 110] }, [['f1', 'g'], ['f2', 'g'], ['f3', 'g']]],
      ['If a feed you watch goes quiet, something outside has stopped. It shows here in red.', { f1: [170, 38], f2: [90, 108], f3: [170, 178], g: [370, 110], q: [225, 108] }, [['f1', 'g'], ['f3', 'g'], ['f2', 'q', 'apart']]],
      ['Outcomes go out again, to the ad platforms, so they learn which clicks worked.', { g: [150, 110], out: [370, 110] }, [['g', 'out', 'same']]],
      ['A platform may refuse one. Read its answer, fix the cause, and press Send again.', { g: [150, 100], out: [370, 100], no: [260, 165] }, [['g', 'out', 'apart']]],
      ['Every decision is written down. Each entry is locked to the one before it.', { e1: [90, 110], k1: [175, 110], e2: [260, 110], k2: [345, 110], e3: [430, 110] }, [['e1', 'k1'], ['k1', 'e2'], ['e2', 'k2'], ['k2', 'e3']]],
      ['Change an old entry and the lock after it no longer fits. Then Record says Altered, not Whole.', { e1: [90, 95], k1: [175, 95], e2: [260, 95], k2: [345, 95], e3: [430, 95], x: [260, 160] }, [['e1', 'k1'], ['k1', 'e2'], ['e2', 'k2', 'apart'], ['k2', 'e3']]],
    ],
  },
}

/** The small print of each view, as it was last read. */
const smallPrint = new Map()
/** Keeps what else there is to know of a view, for its lesson to show. */
const fine = (...texts) => (smallPrint.set(place().name, texts.filter(Boolean)), '')
/** The button that opens the lesson of the view that is open. */
const explain = () => el('button', { type: 'button', class: 'explain', 'data-key': 'explain', on: { click: () => teach(place().name) } }, el('i', { 'aria-hidden': 'true' }), 'How to read this')

/** One picture and what it changes to. Positions go over in between, and a step back goes the same way. */
function scene(lesson) {
  const lines = svg('g')
  const things = svg('g')
  const boxes = svg('g')
  const root = svg('svg', { class: 'scene', viewBox: '0 0 520 230', 'aria-hidden': 'true', focusable: 'false' }, boxes, lines, things)
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const word = (x, y, text, kind = '') => svg('text', { x, y, 'text-anchor': 'middle', class: kind }, text)
  const pill = (text, tone) => {
    const wide = text.length * 7.2 + 20
    return svg('g', { class: `pill ${tone}` }, svg('rect', { x: -wide / 2, y: -12, width: wide, height: 24, rx: 12 }), word(0, 4, text))
  }
  const actors = new Map(Object.entries(lesson.in).map(([id, [kind, what, name = '']]) => {
    let node
    if (kind === 'who') {
      const icon = ICONS[what]
      node = svg('g', { class: `who ${what}` }, svg('circle', { r: 23 }), svg('path', { class: icon ? 'line' : '', d: icon ?? PERSON, transform: 'scale(1.35)' }), word(0, 41, name))
    } else if (kind === 'thing') node = svg('g', { class: 'thing' }, svg('rect', { x: -21, y: -21, width: 42, height: 42, rx: 12 }), svg('path', { d: LESSON_ICONS[what] ?? VIEW_ICONS[what], transform: 'translate(-11 -11) scale(1.375)' }), word(0, 39, name))
    else if (kind === 'box') node = svg('g', { class: `box ${name}` }, svg('rect', { rx: 16 }), svg('text', { class: 'caption', 'text-anchor': 'middle' }, what))
    else if (kind === 'card') node = svg('g', { class: `slip ${name}` }, svg('rect', { x: -44, y: -17, width: 88, height: 34, rx: 9 }), ...(name === 'late' ? [svg('circle', { cx: 35, cy: -8, r: 3.5 })] : []), word(0, 4, what))
    else if (kind === 'word') node = pill(what, name)
    else node = svg('g', { class: 'rail' }, svg('rect', { rx: 1 }))
    ;(kind === 'box' || kind === 'bar' ? boxes : things).append(node)
    return [id, { node, sized: kind === 'box' || kind === 'bar', now: undefined, from: undefined, to: undefined }]
  }))
  const drawn = new Map()
  let frame
  const place = (t) => {
    const mix = (a, b) => a + (b - a) * t
    for (const actor of actors.values()) {
      const { from, to, node } = actor
      if (!from) { node.setAttribute('opacity', 0); continue }
      const now = (actor.now = from.map((each, i) => mix(each, to[i])))
      node.setAttribute('opacity', now[4].toFixed(3))
      node.setAttribute('transform', `translate(${now[0].toFixed(1)} ${now[1].toFixed(1)})`)
      if (actor.sized) {
        const [, , w, h] = now
        const rect = node.firstChild
        for (const [key, value] of Object.entries({ x: -w / 2, y: -h / 2, width: w, height: h })) rect.setAttribute(key, value.toFixed(1))
        node.querySelector('text')?.setAttribute('y', (-h / 2 + 18).toFixed(1))
      }
    }
    for (const line of drawn.values()) {
      const [a, b] = [actors.get(line.a).now, actors.get(line.b).now]
      if (!a || !b) continue
      const grown = mix(line.from, line.to)
      const [x, y] = [a[0] + (b[0] - a[0]) * Math.max(0.001, grown), a[1] + (b[1] - a[1]) * Math.max(0.001, grown)]
      line.now = grown
      for (const [key, value] of Object.entries({ x1: a[0], y1: a[1], x2: x, y2: y })) line.stroke.setAttribute(key, value.toFixed(1))
      line.node.setAttribute('opacity', Math.min(1, grown * 3).toFixed(3))
      line.words?.setAttribute('transform', `translate(${((a[0] + b[0]) / 2).toFixed(1)} ${((a[1] + b[1]) / 2).toFixed(1)})`)
      line.words?.setAttribute('opacity', Math.max(0, grown * 2 - 1).toFixed(3))
    }
  }
  const show = (n, still = calm) => {
    const [, at, joins = []] = lesson.steps[n]
    for (const [id, actor] of actors) {
      const to = at[id] ? [at[id][0], at[id][1], at[id][2] ?? 0, at[id][3] ?? 0, 1] : undefined
      const now = actor.now
      // One that arrives starts a little below where it will be, and one that leaves fades where it is.
      actor.from = now ?? (to && [to[0], to[1] + 14, to[2], to[3], 0])
      if (now && now[4] < 0.02 && to) actor.from = [to[0], to[1] + 14, to[2], to[3], 0]
      actor.to = to ?? (actor.from && [...actor.from.slice(0, 4), 0])
    }
    const keep = new Set()
    for (const [a, b, tone = '', words] of joins) {
      const key = [a, b, tone, words].join('|')
      keep.add(key)
      if (!drawn.has(key)) {
        const stroke = svg('line')
        const node = svg('g', { class: `join ${tone}` }, stroke)
        const said = words ? pill(words, tone) : undefined
        if (said) node.append(said)
        lines.append(node)
        drawn.set(key, { a, b, stroke, node, words: said, now: 0 })
      }
    }
    for (const [key, line] of drawn) {
      line.from = line.now
      line.to = keep.has(key) ? 1 : 0
    }
    cancelAnimationFrame(frame)
    if (still) return place(1)
    const began = performance.now()
    const tick = (time) => {
      const t = Math.min(1, Math.max(0, (time - began) / 750))
      place(1 - (1 - t) ** 3)
      if (t < 1 && root.isConnected) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  }
  return { root, show }
}

/** The lesson of a view, over the page. It moves only when it is asked to. */
function teach(name) {
  const lesson = LESSONS[name]
  const { root, show } = scene(lesson)
  const said = el('p', { class: 'lesson-said', 'aria-live': 'polite' })
  const dots = el('span', { class: 'lesson-dots', 'aria-hidden': 'true' }, ...lesson.steps.map(() => el('i')))
  const count = el('span', { class: 'meta' })
  const back = el('button', { type: 'button', on: { click: () => to(at - 1) } }, 'Back')
  const next = el('button', { type: 'button', class: 'primary', on: { click: () => (at === lesson.steps.length - 1 ? dialog.close() : to(at + 1)) } }, 'Next')
  const texts = smallPrint.get(name) ?? []
  const title = views.get(name).title
  const dialog = el('dialog', { class: 'lesson', 'aria-label': `How to read ${title}` },
    el('div', { class: 'lesson-top' }, viewMark(name), el('h4', {}, `How to read ${title}`), el('button', { type: 'button', class: 'lesson-shut', 'aria-label': 'Close', on: { click: () => dialog.close() } }, '×')),
    el('div', { class: 'lesson-stage' }, root), said, el('div', { class: 'lesson-foot' }, dots, count, back, next),
    texts.length > 0 ? el('details', {}, el('summary', {}, 'The small print'), ...texts.map((text) => el('p', { class: 'muted' }, text))) : '')
  let at = -1
  const to = (n) => {
    if (n < 0 || n >= lesson.steps.length) return
    const first = at < 0
    at = n
    said.textContent = lesson.steps[n][0]
    count.textContent = `${n + 1} of ${lesson.steps.length}`
    back.disabled = n === 0
    next.textContent = n === lesson.steps.length - 1 ? 'Done' : 'Next'
    for (const [i, dot] of [...dots.children].entries()) dot.classList.toggle('on', i <= n)
    show(n, first ? true : undefined)
    // A button that can no longer be pressed must not keep the keyboard.
    if (back.disabled && document.activeElement === back) next.focus()
  }
  dialog.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    to(at + step)
  })
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close())
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  to(0)
  next.focus()
}
