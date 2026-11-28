// The guide of each view: a few sentences, each with a picture that moves into the next.
// The words, the pictures and the drawing are the original screen's, now kept here.
import { useEffect, useId, useRef, useState } from 'react'
import { ICONS, PERSON } from './cluster-layout.js'
import { GLYPHS, VIEW_ICONS, ViewMark } from './marks'

export const LESSON_ICONS = {
  laptop: 'M3.2 3.5h9.6v7H3.2zM1.6 12.8h12.8', mail: 'M2.2 4h11.6v8.2H2.2zM2.4 4.4 8 8.8l5.6-4.4', ad: 'M3 6.5v3h2l5.5 3v-9L5 6.5ZM12.6 6.4v3.2', page: 'M3.5 2.5h9v11h-9zM6 5.5h4M6 8h4',
  money: GLYPHS.value, check: GLYPHS.result, cross: 'M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2',
  lock: 'M4 7.2h8v6H4zM5.8 7.2V5.4a2.2 2.2 0 0 1 4.4 0v1.8', send: 'M2.5 13 13 8 2.5 3l2 5ZM4.5 8H8', voice: 'M4.6 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM11.4 10.4a2.4 2.4 0 1 0 0-4.8a2.4 2.4 0 0 0 0 4.8ZM4.6 10.4h6.8',
  graph: 'M2.6 4.2a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M10.2 6a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M5.4 12a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0M5.9 4.6l4.4 1M4.7 5.8l1.9 4.6M10.9 7.4l-2.8 3.3', person: 'M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8ZM2.8 13.4c.5-2.5 2.5-3.8 5.2-3.8s4.7 1.3 5.2 3.8',
}

export const GUIDES = {
  accounts: {
    title: 'Identity matching',
    in: { a: ['who', 'account', 'max'], b: ['who', 'account', 'sam'], c: ['who', 'account', 'lee'], d: ['who', 'account', 'ana'], laptop: ['thing', 'laptop', 'device'], desk: ['thing', 'calls', 'office phone'], one: ['box', 'one person', 'same'] },
    steps: [
      ['An ID is anything you track: an account, a browser, a phone number or a contact.', { a: [260, 110] }],
      ['Each sign-in, visit or call records which identifiers the ID was seen with, such as a device.', { a: [160, 110], laptop: [330, 110] }, [['a', 'laptop']]],
      ['When a second ID is seen with the same device, the two share an identifier.', { a: [130, 110], laptop: [260, 110], b: [390, 110] }, [['a', 'laptop'], ['b', 'laptop']]],
      ['The shared identifier links them. The score is the confidence that they are the same person.', { a: [150, 100], b: [370, 100] }, [['a', 'b', 'same', '98%']]],
      ['An identifier shared by many IDs, such as an office phone, carries less weight. Past a limit it carries none.', { a: [90, 55], b: [90, 160], c: [430, 55], d: [430, 160], desk: [260, 100] }, [['a', 'desk', 'faint'], ['b', 'desk', 'faint'], ['c', 'desk', 'faint'], ['d', 'desk', 'faint']]],
      ['Links that reach the join threshold, 90% by default, combine IDs into one person.', { one: [260, 104, 320, 150], a: [180, 100], b: [340, 100] }, [['a', 'b', 'same', '98%']]],
      ['If two IDs are different people, select Separate. They stay separate whatever they share later.', { a: [140, 100], b: [380, 100] }, [['a', 'b', 'apart', 'separated']]],
    ],
  },
  journey: {
    title: 'Customer journey',
    in: { ad: ['thing', 'ad', 'ad'], v: ['who', 'visitor', 'browser'], c: ['who', 'caller', 'caller'], k: ['who', 'contact', 'contact'], one: ['box', 'one person', 'same'], line: ['bar'], m1: ['thing', 'ad', 'visit'], m2: ['thing', 'calls', 'call'], m3: ['thing', 'mail', 'signup'], m4: ['thing', 'check', 'enrolled'] },
    steps: [
      ['A visitor arrives from an ad. At this point only the browser is known.', { ad: [160, 110], v: [350, 110] }, [['ad', 'v']]],
      ['A call comes in. The phone system reports the number and the time.', { v: [180, 110], c: [340, 110] }],
      ['The visitor tapped the phone number just before the call, which links the browser to the caller.', { v: [160, 110], c: [360, 110] }, [['v', 'c', 'same', 'tap to call']]],
      ['A signup from the same browser adds a contact.', { v: [260, 60], c: [130, 160], k: [390, 160] }, [['v', 'c', 'same'], ['v', 'k', 'same']]],
      ['All three IDs resolve to one person.', { one: [260, 115, 330, 204], v: [260, 74], c: [160, 156], k: [360, 156] }, [['v', 'c', 'same'], ['v', 'k', 'same']]],
      ['The journey combines their events into one timeline, with the evidence for each ID.', { line: [260, 110, 420, 2], m1: [90, 110], m2: [200, 110], m3: [300, 110], m4: [430, 110] }],
    ],
  },
  board: {
    title: 'Board',
    in: { c1: ['box', 'Missed', 'apart'], c2: ['box', 'inquiry', ''], c3: ['box', 'call', ''], c4: ['box', 'enrolled', ''], p: ['card', 'person', ''], late: ['card', 'person', 'late'], dot: ['word', 'overdue', 'apart'] },
    steps: [
      ['Columns are the steps configured in STAGES, in order.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170] }],
      ['Each card is one person, across all of their linked IDs.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170], p: [140, 90] }],
      ['A card moves right when the person reaches a later step.', { c2: [140, 115, 110, 170], c3: [260, 115, 110, 170], c4: [380, 115, 110, 170], p: [380, 90] }],
      ['An unreturned missed call takes priority. The card moves to the first column until the caller is reached.', { c1: [80, 115, 110, 170], c2: [200, 115, 110, 170], c3: [320, 115, 110, 170], c4: [440, 115, 110, 170], p: [80, 90] }],
      ['A red dot marks a card that has passed the time limit for its column.', { c1: [80, 115, 110, 170], c2: [200, 115, 110, 170], c3: [320, 115, 110, 170], c4: [440, 115, 110, 170], late: [80, 90], dot: [80, 136] }],
    ],
  },
  decide: {
    title: 'Match review',
    in: { a: ['who', 'account', 'max'], b: ['who', 'account', 'sam'], c: ['who', 'account', 'lee'], d: ['who', 'account', 'ana'], g1: ['box', 'person 1', 'same'], g2: ['box', 'person 2', 'same'], m: ['thing', 'mail', 'email'], l: ['thing', 'laptop', 'device'], one: ['box', 'one person', 'same'] },
    steps: [
      ['Pairs that score between the related and join thresholds wait here for review.', { a: [150, 105], b: [370, 105] }, [['a', 'b', 'related', '78%']]],
      ['High-confidence pairs also appear when one weak link would merge two groups, or when a member was separated.', { g1: [130, 105, 180, 130], g2: [390, 105, 180, 130], a: [95, 100], c: [165, 100], b: [355, 100], d: [425, 100] }, [['a', 'c', 'same'], ['b', 'd', 'same'], ['c', 'b', 'related', 'held']]],
      ['The two IDs are compared side by side. Values they share are highlighted.', { a: [100, 105], b: [420, 105], m: [215, 105], l: [305, 105] }, [['a', 'm', 'same'], ['b', 'l', 'same'], ['m', 'l', 'same']]],
      ['Join treats them as one person.', { one: [260, 105, 330, 150], a: [180, 100], b: [340, 100] }, [['a', 'b', 'same']]],
      ['Separate marks them as different people.', { a: [140, 105], b: [380, 105] }, [['a', 'b', 'apart', 'separated']]],
      ['Skip leaves the pair undecided. Undo reverses the last decision made in this session.', { a: [150, 105], b: [370, 105] }, [['a', 'b', 'related', '78%']]],
    ],
  },
  calls: {
    title: 'Calls',
    in: { c: ['who', 'caller', 'caller'], you: ['thing', 'person', 'staff'], ring: ['thing', 'calls', 'call'], yes: ['word', 'answered', 'same'], no: ['word', 'missed', 'apart'], vm: ['thing', 'voice', 'voicemail'], wait: ['box', 'awaiting callback', 'apart'], back: ['word', 'returned', 'same'], half: ['word', '2 of 4: 50% returned', 'same'], c1: ['who', 'caller', ''], c2: ['who', 'caller', ''], c3: ['who', 'caller', ''], c4: ['who', 'caller', ''], r1: ['word', 'returned', 'same'], r2: ['word', 'returned', 'same'], w3: ['word', 'waiting', 'apart'], w4: ['word', 'waiting', 'apart'] },
    steps: [
      ['Your phone system reports each call and its result.', { c: [130, 110], ring: [260, 110], you: [390, 110] }, [['c', 'ring'], ['ring', 'you', 'faint']]],
      ['Answered: a person picked up.', { c: [130, 100], you: [390, 100], yes: [260, 170] }, [['c', 'you', 'same']]],
      ['Missed: the call reached no one, or went to voicemail.', { c: [130, 100], you: [390, 100], vm: [260, 100], no: [260, 170] }, [['c', 'vm', 'apart']]],
      ['Missed callers are listed until they are reached, longest wait first.', { wait: [260, 112, 380, 130], c1: [140, 120], c2: [220, 120], c3: [300, 120], c4: [380, 120] }],
      ['Returned: you called and they answered. Called again: they called and got through.', { you: [130, 100], c: [390, 100], back: [260, 170] }, [['you', 'c', 'same', 'callback']]],
      ['The returned rate is returned calls divided by missed calls and voicemails.', { c1: [110, 75], c2: [210, 75], c3: [310, 75], c4: [410, 75], r1: [110, 124], r2: [210, 124], w3: [310, 124], w4: [410, 124], half: [260, 185] }],
    ],
  },
  channels: {
    title: 'Attribution',
    in: { ad: ['thing', 'ad', 'ad'], cost: ['word', 'spend $100', ''], v: ['who', 'visitor', 'visitor'], done: ['thing', 'check', 'outcome'], worth: ['word', 'value $300', 'same'], ad2: ['thing', 'ad', 'earlier ad'], o1: ['thing', 'check', ''], o2: ['thing', 'check', ''], o3: ['thing', 'check', ''], o4: ['thing', 'check', ''], each: ['word', '$100 ÷ 4 = $25', ''], back: ['word', '$300 ÷ $100 = 3.0×', 'same'], more: ['word', 'pending', 'related'], now: ['word', 'today', ''], day: ['bar'] },
    steps: [
      ['Spend is the cost each ad platform reports for a campaign.', { ad: [260, 95], cost: [260, 170] }],
      ['A visit is recorded when someone arrives from an ad or campaign link.', { ad: [150, 105], cost: [150, 175], v: [370, 105] }, [['ad', 'v', '', 'visit']]],
      ['An outcome is an event you count, such as an inquiry or a sale, with a value.', { ad: [90, 105], cost: [90, 175], v: [260, 105], done: [430, 105], worth: [430, 175] }, [['ad', 'v'], ['v', 'done']]],
      ['The outcome is attributed to the latest visit that is linked to the person with enough confidence.', { ad2: [80, 50], ad: [80, 160], v: [260, 105], done: [430, 105] }, [['ad2', 'v', 'faint'], ['ad', 'v', 'same', 'latest'], ['v', 'done', 'same']]],
      ['Cost per outcome is spend divided by attributed outcomes.', { ad: [110, 100], o1: [240, 100], o2: [300, 100], o3: [360, 100], o4: [420, 100], each: [260, 180] }, [['ad', 'o1', 'same']]],
      ['ROAS is attributed value divided by spend.', { ad: [160, 75], cost: [160, 144], done: [360, 75], worth: [360, 144], back: [260, 198] }, [['ad', 'done', 'same']]],
      ['Outcomes follow visits by days or weeks, so recent results are incomplete.', { day: [260, 142, 420, 2], o1: [90, 105], o2: [155, 105], o3: [220, 105], more: [345, 105], now: [455, 105] }],
    ],
  },
  health: {
    title: 'System health',
    in: { f1: ['thing', 'ad', 'visits'], f2: ['thing', 'calls', 'calls'], f3: ['thing', 'money', 'costs'], g: ['thing', 'graph', 'server'], q: ['word', 'stale', 'apart'], out: ['thing', 'send', 'ad platform'], no: ['word', 'rejected', 'apart'], e1: ['card', 'Joined', ''], e2: ['card', 'Separated', ''], e3: ['card', 'Joined', ''], k1: ['thing', 'lock', ''], k2: ['thing', 'lock', ''], x: ['word', 'altered', 'apart'] },
    steps: [
      ['Feeds deliver visits, calls, call results and costs.', { f1: [170, 38], f2: [90, 108], f3: [170, 178], g: [370, 110] }, [['f1', 'g'], ['f2', 'g'], ['f3', 'g']]],
      ['A monitored feed is stale when no record arrives within its limit.', { f1: [170, 38], f2: [90, 108], f3: [170, 178], g: [370, 110], q: [225, 108] }, [['f1', 'g'], ['f3', 'g'], ['f2', 'q', 'apart']]],
      ['Conversions are queued and sent to the configured ad platforms.', { g: [150, 110], out: [370, 110] }, [['g', 'out', 'same']]],
      ['A rejected conversion shows the platform response. Fix the cause, then retry.', { g: [150, 100], out: [370, 100], no: [260, 165] }, [['g', 'out', 'apart']]],
      ['Decisions are written to a hash-chained audit log.', { e1: [90, 110], k1: [175, 110], e2: [260, 110], k2: [345, 110], e3: [430, 110] }, [['e1', 'k1'], ['k1', 'e2'], ['e2', 'k2'], ['k2', 'e3']]],
      ['Editing an entry breaks the chain, and verification reports the log as altered.', { e1: [90, 95], k1: [175, 95], e2: [260, 95], k2: [345, 95], e3: [430, 95], x: [260, 160] }, [['e1', 'k1'], ['k1', 'e2'], ['e2', 'k2', 'apart'], ['k2', 'e3']]],
    ],
  },
}

const EXPLAIN = 'M8 14.35a6.35 6.35 0 1 0 0-12.7a6.35 6.35 0 0 0 0 12.7ZM6.2 6.4a1.8 1.8 0 1 1 2.7 1.56c-.6.35-.9.7-.9 1.4M8 11.4h.01'

/** An element of a drawing, with its attributes and what is in it. */
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

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

/**
 * The button beside a page's title that opens its guide. The guide opens over the page with no script, as a list of its sentences.
 * With scripts it is one sentence at a time, with its picture.
 */
export function Guide({ view }) {
  const lesson = GUIDES[view]
  const id = useId()
  const [enhanced, setEnhanced] = useState(false)
  const [at, setAt] = useState(0)
  const box = useRef(null)
  const stage = useRef(null)
  const drawn = useRef(null)
  const forward = useRef(null)
  useEffect(() => setEnhanced(true), [])
  const last = lesson.steps.length - 1
  /** Draws the picture at the first sentence. The guide opens here, or was open already when the page's script arrived. */
  const begin = () => {
    if (!stage.current) return
    const made = scene(lesson)
    stage.current.replaceChildren(made.root)
    drawn.current = made
    setAt(0)
    made.show(0, true)
    forward.current?.focus()
  }
  useEffect(() => { if (enhanced && box.current?.matches(':popover-open')) begin() }, [enhanced])
  const to = n => {
    if (n < 0 || n > last) return
    setAt(n)
    drawn.current?.show(n)
    // A button that can no longer be pressed must not keep the keyboard.
    if (n === 0) forward.current?.focus()
  }
  return <><button type="button" className="explain" title="Guide" aria-label={'Guide: ' + lesson.title} popoverTarget={id}><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d={EXPLAIN}/></svg></button>
    <dialog className="lesson" popover="auto" id={id} aria-label={lesson.title} aria-describedby={enhanced ? id + 'said' : undefined} ref={box} onToggle={event => {
      if (!enhanced) return
      if (event.newState === 'open') begin()
      else {
        drawn.current = null
        stage.current?.replaceChildren()
      }
    }} onKeyDown={event => {
      // Only a bare arrow that has somewhere to go is the guide's. Any other key is the browser's.
      const step = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ? 0 : ({ ArrowRight: 1, ArrowLeft: -1 }[event.key] ?? 0)
      if (!step || !enhanced || at + step < 0 || at + step > last) return
      event.preventDefault()
      to(at + step)
    }}>
      <div className="lesson-top"><ViewMark name={view}/><h4>{lesson.title}</h4><button type="button" className="lesson-shut" aria-label="Close" popoverTarget={id} popoverTargetAction="hide">×</button></div>
      {enhanced ? <><div className="lesson-stage" ref={stage}/><p className="lesson-said" id={id + 'said'} aria-live="polite">{lesson.steps[at][0]}</p>
        <div className="lesson-foot"><span className="lesson-dots" aria-hidden="true">{lesson.steps.map((_, i) => <i key={i} className={i <= at ? 'on' : undefined}/>)}</span><span className="meta">{at + 1} of {lesson.steps.length}</span>
          <button type="button" disabled={at === 0} onClick={() => to(at - 1)}>Back</button><button type="button" className="primary" ref={forward} onClick={() => (at === last ? box.current?.hidePopover() : to(at + 1))}>{at === last ? 'Done' : 'Next'}</button></div></>
        : <ol className="lesson-steps">{lesson.steps.map(([said], i) => <li key={i}>{said}</li>)}</ol>}
    </dialog></>
}
