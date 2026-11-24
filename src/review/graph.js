/** The most drawn around one subject, and in all once others have been opened out. */
const ROOM = 24
const MOST = 90
/** Everyone to draw around a subject: its own ties and separations first, then the rest of its cluster. */
const around = (profile) => [...new Set([...profile.separated, ...profile.links.map((link) => link.subject), ...(profile.cluster?.members ?? [])])].filter((each) => each !== profile.subject)

/** What was done to the graph on screen, so a refresh draws it as it was left: where each stands, what was moved, opened out, picked and hidden. */
const drawn = { subject: undefined, spots: new Map(), pins: new Set(), more: new Map(), off: new Set(), camera: undefined, chosen: undefined, left: false, still: 0 }
function redrawn(subject) {
  if (drawn.subject === subject) return
  Object.assign(drawn, { subject, pins: new Set(), more: new Map(), camera: undefined, chosen: undefined })
}
/** The screen is not read again under a hand that is moving something or about to press twice, nor while the graph fills it. */
const holding = () => performance.now() < drawn.still || document.fullscreenElement !== null || $('view').querySelector('.graph.held') !== null

const KINDS = { joined: 'Joined', related: 'Tied only', apart: 'Kept apart' }
const PERSON = 'M0-6.2a3 3 0 1 1 0 6a3 3 0 1 1 0-6ZM-5.8 6.2C-5.4 2.6-3 1.4 0 1.4S5.4 2.6 5.8 6.2Z'
const ICONS = {
  caller: 'M-3.4-6.5h6.8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6.8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM-1.2 4.2h2.4',
  visitor: 'M-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM-6 0H6M0-6C3.2-2.4 3.2 2.4 0 6C-3.2 2.4-3.2-2.4 0-6Z',
  lead: 'M-4 6.5V-6H4.5L2.5-2.5L4.5 1H-4',
}
const typeOf = (subject) => (subject.includes(':') ? subject.slice(0, subject.indexOf(':')) : '')
const nameOf = (subject) => {
  const name = subject.slice(typeOf(subject) ? typeOf(subject).length + 1 : 0)
  return name.length > 16 ? `${name.slice(0, 13)}…` : name
}
const pairOf = (a, b) => (a < b ? [a, b] : [b, a])

/** Who and what to draw, from the subject's profile and those opened out from it. */
function gathered(profile) {
  const all = [profile, ...drawn.more.values()]
  const nodes = new Map()
  const edges = new Map()
  const cluster = new Map()
  for (const each of all) {
    for (const id of [each.subject, ...around(each).slice(0, ROOM)]) if (!nodes.has(id) && nodes.size < MOST) nodes.set(id, { id, from: each.subject })
    for (const member of each.cluster.members) cluster.set(member, each.cluster.id)
  }
  const edge = (from, to, more) => {
    if (!nodes.has(from) || !nodes.has(to)) return
    const [a, b] = pairOf(from, to)
    edges.set(`${a}\n${b}`, { a, b, reasons: [], ...edges.get(`${a}\n${b}`), ...more })
  }
  for (const each of all) {
    // A strong tie that a cut left out of the cluster is drawn like a related one: tied, not joined.
    for (const tie of each.ties) edge(tie.a, tie.b, { score: tie.score, kind: tie.level === 'same' && cluster.has(tie.a) && cluster.get(tie.a) === cluster.get(tie.b) ? 'joined' : 'related' })
    for (const link of each.links) edge(each.subject, link.subject, { reasons: link.reasons.filter((reason) => reason.counted !== false) })
  }
  // A decision stands over any tie.
  for (const each of all) for (const [a, b] of [...each.separated.map((other) => [each.subject, other]), ...each.apart]) edge(a, b, { kind: 'apart' })
  const own = cluster.get(profile.subject)
  for (const node of nodes.values()) {
    const tie = edges.get(pairOf(profile.subject, node.id).join('\n'))
    node.cluster = cluster.get(node.id)
    node.tie = tie
    node.role = node.id === profile.subject ? 'me' : tie?.kind === 'apart' ? 'apart' : node.cluster === own ? 'member' : tie ? 'related' : 'far'
    node.degree = [...edges.values()].filter((each) => each.a === node.id || each.b === node.id).length
    node.r = node.role === 'me' ? 24 : Math.min(21, 15 + node.degree)
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

/** One step of the layout: everything pushes everything away, ties pull, and all of it drifts to the middle, as wide or as tall as the room is. */
function step(nodes, edges, heat, tall) {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      const dx = b.x - a.x || 0.1 * (i - j)
      const dy = b.y - a.y || 0.1
      const far = Math.max(1, Math.hypot(dx, dy))
      const strangers = a.cluster === undefined || a.cluster !== b.cluster
      // Names are wider than they are tall, so two side by side need more room than one above the other.
      const room = 92 + 40 * Math.abs(dx / far)
      const push = heat * ((strangers ? 16000 : 6500) / (far * far) + (far < room ? (room - far) * 0.22 : 0))
      a.vx -= (push * dx) / far
      a.vy -= (push * dy) / far
      b.vx += (push * dx) / far
      b.vy += (push * dy) / far
    }
  }
  for (const { from, to, kind, score } of edges) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const far = Math.max(1, Math.hypot(dx, dy))
    const pull = heat * (kind === 'joined' ? 0.07 * (far - 205 + 30 * score) : kind === 'related' ? 0.05 * (far - 270) : 0.025 * (far - 310))
    for (const [node, way] of [[from, 1], [to, -1]]) {
      node.vx += (way * pull * dx) / far
      node.vy += (way * pull * dy) / far
    }
  }
  // A line that runs through someone it has nothing to do with reads as theirs, so they step off it.
  for (const { from, to } of edges) for (const node of nodes) {
    if (node === from || node === to) continue
    const [ex, ey] = [to.x - from.x, to.y - from.y]
    const t = ((node.x - from.x) * ex + (node.y - from.y) * ey) / Math.max(1, ex * ex + ey * ey)
    if (t < 0.05 || t > 0.95) continue
    const [dx, dy] = [node.x - from.x - t * ex, node.y - from.y - t * ey]
    const far = Math.max(0.5, Math.hypot(dx, dy))
    if (far > 46) continue
    const push = (heat * 0.3 * (46 - far)) / far
    node.vx += push * dx
    node.vy += push * dy
    for (const end of [from, to]) {
      end.vx -= (push * dx) / 3
      end.vy -= (push * dy) / 3
    }
  }
  for (const node of nodes) {
    const home = node.role === 'me' ? 0.06 : 0.012
    node.vx = (node.vx - node.x * home * (tall ? 2 : 1) * heat) * 0.62
    node.vy = (node.vy - node.y * home * (tall ? 1 : 2) * heat) * 0.62
    if (node.held || drawn.pins.has(node.id)) node.vx = node.vy = 0
    node.x += node.vx
    node.y += node.vy
  }
}

/** How hard a layout is to read: lines that cross or run through someone, and strangers inside an outline that is not theirs. */
function tangle(nodes, edges) {
  let cost = 0
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  edges.forEach((one, i) => {
    for (const two of edges.slice(i + 1)) {
      if (one.from === two.from || one.from === two.to || one.to === two.from || one.to === two.to) continue
      if (side(one.from, one.to, two.from) !== side(one.from, one.to, two.to) && side(two.from, two.to, one.from) !== side(two.from, two.to, one.to)) cost += 1
    }
    for (const node of nodes) if (node !== one.from && node !== one.to) {
      const [ex, ey] = [one.to.x - one.from.x, one.to.y - one.from.y]
      const t = ((node.x - one.from.x) * ex + (node.y - one.from.y) * ey) / Math.max(1, ex * ex + ey * ey)
      if (t > 0 && t < 1 && Math.hypot(node.x - one.from.x - t * ex, node.y - one.from.y - t * ey) < 34) cost += 3
    }
  })
  for (const { margin } of outlines(nodes, edges)) if (margin !== 42) cost += margin ? 1 : 8
  return cost
}

/** The outline around points, in order. */
function outline(points) {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y)
  const half = (list) => {
    const out = []
    for (const p of list) {
      while (out.length > 1 && (out.at(-1).x - out.at(-2).x) * (p.y - out.at(-2).y) <= (out.at(-1).y - out.at(-2).y) * (p.x - out.at(-2).x)) out.pop()
      out.push(p)
    }
    return out.slice(0, -1)
  }
  return [...half(sorted), ...half(sorted.reverse())]
}
/** How far a point is outside a shape: nothing when it is in it. */
function beyond(p, shape) {
  const sides = shape.map((a, i) => [a, shape[(i + 1) % shape.length]])
  if (shape.length > 2 && sides.every(([a, b]) => (b.x - a.x) * (p.y - a.y) >= (b.y - a.y) * (p.x - a.x))) return 0
  return Math.min(...sides.map(([a, b]) => {
    const [ex, ey] = [b.x - a.x, b.y - a.y]
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / Math.max(1, ex * ex + ey * ey)))
    return Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey)
  }))
}

/** The outline of each cluster that has two or more drawn, and how wide a margin it can have without taking in anyone else: none at all when it cannot help it. */
function outlines(nodes, edges) {
  const clusters = new Map()
  for (const node of nodes) if (node.cluster !== undefined) clusters.set(node.cluster, [...(clusters.get(node.cluster) ?? []), node])
  return [...clusters].filter(([id, list]) => list.length > 1 && !edges.some((edge) => edge.kind === 'apart' && edge.from.cluster === id && edge.to.cluster === id)).map(([id, list]) => {
    const points = outline(list)
    const strangers = nodes.filter((node) => node.cluster !== id).map((node) => beyond(node, points) - node.r)
    return { id, points, margin: [42, 36, 30].find((margin) => strangers.every((far) => far > margin + 2)) }
  })
}

/**
 * The subject, whoever it is tied to or kept from, and the ties between them.
 * Every one can be picked, moved and opened, and opened out to show its own
 * ties. The tables under it say the same in words.
 */
function graphOf(profile, more) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const me = profile.subject
  const root = el('div', { class: 'graph' })
  const hulls = svg('g', {})
  const lines = svg('g', {})
  const dots = svg('g', {})
  const tags = svg('g', {})
  const camera = svg('g', {}, hulls, lines, dots, tags)
  const paper = svg('svg', { role: 'group', 'aria-label': `Ties of ${me}` }, camera)
  const card = el('div', { class: 'card', hidden: '', role: 'region', 'aria-label': 'Picked' })
  const legend = el('div', { class: 'keys', role: 'group', 'aria-label': 'Show' })
  const tools = el('div', { class: 'tools' })
  root.append(paper, legend, tools, card)
  let nodes = []
  let edges = []
  let byId = new Map()
  let size = { w: 0, h: 0 }
  let heat = 0
  let glide
  let running = false
  let later

  const near = (id) => new Set([id, ...edges.filter((each) => each.a === id || each.b === id).flatMap((each) => [each.a, each.b])])
  const shared = (edge) => `${edge.score === undefined ? '' : percent(edge.score)}${edge.reasons.length > 0 ? ` by ${edge.reasons.map((reason) => reason.identifier.split(':')[0]).join(' and ')}` : ''}`
  const together = (edge) => edge.from.cluster !== undefined && edge.from.cluster === edge.to.cluster
  const said = (edge) => (edge.kind === 'apart' ? `kept apart by a decision${edge.score === undefined ? '' : `, which stands over a tie of ${shared(edge)}`}` : `${edge.kind === 'joined' ? 'joined' : together(edge) ? 'tied, joined through others' : 'tied, not joined'}, ${shared(edge)}`)
  const verdict = (a, b) => [profile, ...drawn.more.values()].flatMap((each) => each.verdicts).find((each) => each.a === a && each.b === b)

  /** Everything is put where the layout has it. Answers whether the view is still on its way to showing it all. */
  function place(ease = false) {
    for (const node of nodes) {
      node.mark.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
      drawn.spots.set(node.id, { x: node.x, y: node.y })
    }
    for (const edge of edges) {
      for (const line of edge.lines) for (const [name, value] of [['x1', edge.from.x], ['y1', edge.from.y], ['x2', edge.to.x], ['y2', edge.to.y]]) line.setAttribute(name, value.toFixed(1))
      edge.tag.setAttribute('transform', `translate(${(edge.from.x + (edge.to.x - edge.from.x) * edge.along).toFixed(1)} ${(edge.from.y + (edge.to.y - edge.from.y) * edge.along).toFixed(1)})`)
    }
    // An outline that would also take in someone else says what is not so, and is left out.
    hulls.replaceChildren(...outlines(nodes, edges).filter(({ margin }) => margin)
      .map(({ id, points, margin }) => svg('path', { 'stroke-width': margin * 2, class: id === byId.get(me).cluster ? 'mine' : '', d: `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z` })))
    const from = drawn.camera
    const to = from && (from.held || performance.now() < drawn.still) ? from : fitted()
    const part = ease && from && !from.held ? 0.16 : 1
    drawn.camera = from ? { held: from.held, ...Object.fromEntries(['x', 'y', 'k'].map((name) => [name, from[name] + (to[name] - from[name]) * part])) } : { ...to, held: false }
    const { x, y, k } = drawn.camera
    camera.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(3)})`)
    paper.classList.toggle('small', k < 0.62)
    if (!running) word()
    return Math.abs(to.x - x) + Math.abs(to.y - y) + 400 * Math.abs(to.k - k) > 0.5
  }
  /** Puts the words of a line where they cover nobody's name and no other line's words, as near its middle as there is room. */
  function word() {
    const taken = nodes.flatMap((node) => {
      const wide = Math.max(nameOf(node.id).length, typeOf(node.id).length) * 3.6 + 4
      return [{ l: node.x - node.r - 4, r: node.x + node.r + 4, t: node.y - node.r - 4, b: node.y + node.r + 4 }, { l: node.x - wide, r: node.x + wide, t: node.y + node.r, b: node.y + node.r + 34 }]
    })
    for (const edge of edges) {
      if (!edge.mark.classList.contains('worded') && !edge.mark.classList.contains('lit')) continue
      const spot = (t) => ({ x: edge.from.x + (edge.to.x - edge.from.x) * t, y: edge.from.y + (edge.to.y - edge.from.y) * t })
      const box = ({ x, y }) => ({ l: x - edge.wide / 2, r: x + edge.wide / 2, t: y - 10, b: y + 10 })
      const free = (one) => !taken.some((two) => one.l < two.r && two.l < one.r && one.t < two.b && two.t < one.b)
      edge.along = [0.5, 0.45, 0.55, 0.4, 0.6, 0.34, 0.66, 0.28, 0.72].find((t) => free(box(spot(t)))) ?? 0.5
      taken.push(box(spot(edge.along)))
      const { x, y } = spot(edge.along)
      edge.tag.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    }
  }
  /** The whole graph, in the middle of the room beside the card. */
  function fitted() {
    const [left, right, top, bottom] = [Math.min, Math.max, Math.min, Math.max].map((pick, i) => pick(...nodes.map((node) => (glide ? node.end : node)[i < 2 ? 'x' : 'y'])))
    // Room is left for what lies over the paper: the keys and tools, and the card when someone is picked.
    const narrow = root.classList.contains('narrow')
    const over = { top: narrow ? legend.offsetHeight + 8 : 0, right: !narrow && !card.hidden ? 300 : 0, bottom: 44 + (narrow && document.fullscreenElement === root && !card.hidden ? card.offsetHeight + 8 : 0) }
    const [w, h] = [size.w - over.right, size.h - over.top - over.bottom]
    const k = Math.max(0.25, Math.min(1.3, w / (right - left + 130), h / (bottom - top + 116)))
    return { k, x: w / 2 + (card.classList.contains('left') ? over.right : 0) - (k * (left + right)) / 2, y: over.top + h / 2 - k * ((top + bottom) / 2 + 12) }
  }
  function run() {
    if (running) return
    running = true
    let seen
    const frame = (now) => {
      if (!root.isConnected) return void (running = false)
      const passed = Math.min(now - (seen ?? now), 50)
      seen = now
      if (performance.now() < drawn.still) return void requestAnimationFrame(frame)
      if (glide) {
        glide.gone += passed
        const t = Math.min(1, glide.gone / 650)
        const eased = 1 - (1 - t) ** 3
        for (const node of nodes) {
          node.x = node.start.x + (node.end.x - node.start.x) * eased
          node.y = node.start.y + (node.end.y - node.start.y) * eased
        }
        if (t === 1) glide = undefined
      } else {
        if (heat > 0.02) step(nodes, edges, heat, size.w < size.h * 1.2)
        heat *= 0.97
      }
      const moving = place(true)
      if (moving || glide || heat > 0.02) return void requestAnimationFrame(frame)
      running = false
      word()
    }
    requestAnimationFrame(frame)
  }

  /** Makes the marks, works out where they come to rest, and moves them there from where they were. With `keep`, whoever has a place keeps it. */
  function draw(keep = false) {
    glide = undefined
    ;({ nodes, edges } = gathered(profile))
    byId = new Map(nodes.map((node) => [node.id, node]))
    nodes.forEach((node, i) => {
      const from = drawn.spots.get(node.id) ?? drawn.spots.get(node.from) ?? { x: 0, y: 0 }
      const turn = i * 2.399963
      node.known = drawn.spots.has(node.id)
      node.start = { ...from }
      node.x = from.x + (node.known || node.id === me ? 0 : Math.cos(turn) * (40 + 9 * i))
      node.y = from.y + (node.known || node.id === me ? 0 : Math.sin(turn) * (40 + 9 * i))
      node.vx = node.vy = 0
    })
    for (const edge of edges) Object.assign(edge, { from: byId.get(edge.a), to: byId.get(edge.b) })
    // Left as it was when everything on it already had a place.
    if (!nodes.every((node) => node.known)) {
      // Where they start decides how they end, so a few starts are tried and the one easiest to read is kept.
      const starts = nodes.some((node) => node.known) ? 1 : nodes.length <= 30 ? 12 : 3
      const first = nodes.map(({ x, y }) => ({ x, y }))
      let best
      for (let turn = 0; turn < starts; turn++) {
        nodes.forEach((node, i) => {
          const from = first[i === 0 ? 0 : 1 + ((i - 1) * (turn % 2 ? 1 : 1 + turn) + turn * 5) % (nodes.length - 1)]
          Object.assign(node, starts === 1 ? first[i] : { x: from.x * (turn % 3 ? 1 : -1), y: from.y }, { vx: 0, vy: 0 })
        })
        // Two may have been given one place, which would never part them.
        nodes.forEach((node, i) => { if (!node.known) { node.x += i * 0.7; node.y += i * 0.3 } else node.held = keep })
        for (let i = 0, warm = 1; i < 320; i++, warm *= 0.985) step(nodes, edges, warm, size.w < size.h * 1.2)
        const cost = starts === 1 ? 0 : tangle(nodes, edges)
        if (!best || cost < best.cost) best = { cost, spots: nodes.map(({ x, y }) => ({ x, y })) }
        if (cost === 0) break
      }
      nodes.forEach((node, i) => Object.assign(node, best.spots[i], { held: false }))
    }
    const roomy = edges.length <= 9
    lines.replaceChildren(...edges.map((edge) => {
      const width = edge.kind === 'apart' ? 1.5 : 1 + 2 * (edge.score ?? 0)
      edge.lines = [svg('line', { class: 'line', 'stroke-width': width.toFixed(1) }), svg('line', { class: 'reach' })]
      const words = edge.kind === 'apart' ? 'apart' : `${edge.reasons[0] ? `${edge.reasons[0].identifier.split(':')[0]}${edge.reasons.length > 1 ? ` +${edge.reasons.length - 1}` : ''} ` : ''}${percent(edge.score)}`
      const wide = words.length * 6.1 + 12
      Object.assign(edge, { wide, along: 0.5 })
      edge.tag = svg('g', { class: `tag ${edge.kind}${roomy ? ' worded' : ''}` }, svg('rect', { x: -wide / 2, y: -9, width: wide, height: 18, rx: 9 }), svg('text', { 'text-anchor': 'middle', y: 4 }, words))
      edge.mark = svg('g', { class: `edge ${edge.kind}${roomy ? ' worded' : ''}` }, ...edge.lines, svg('title', {}, `${edge.a} and ${edge.b}: ${said(edge)}`))
      edge.mark.addEventListener('pointerenter', () => !running && light(new Set([edge.a, edge.b]), edge))
      edge.mark.addEventListener('pointerleave', () => light())
      return edge.mark
    }))
    tags.replaceChildren(...edges.map((edge) => edge.tag))
    dots.replaceChildren(...nodes.map((node) => {
      const icon = ICONS[typeOf(node.id)]
      const role = { me: 'this subject', member: 'same person', apart: 'kept apart', related: 'tied, not joined', far: 'tied through another' }[node.role]
      node.mark = svg('g', { class: `node ${node.role}`, tabindex: 0, role: 'button', 'aria-label': `${node.id}, ${role}`, 'aria-pressed': String(drawn.chosen === node.id) },
        svg('circle', { class: 'halo', r: node.r + 7 }), svg('circle', { class: 'disc', r: node.r }),
        svg('path', { class: icon ? 'icon line' : 'icon', d: icon ?? PERSON, transform: `scale(${(node.r / 15).toFixed(2)})` }),
        node.role === 'apart' ? svg('path', { class: 'no', d: `M${-node.r * 0.71} ${node.r * 0.71}L${node.r * 0.71} ${-node.r * 0.71}` }) : '',
        svg('text', { class: 'name', 'text-anchor': 'middle', y: node.r + 16 }, nameOf(node.id)), svg('text', { class: 'type', 'text-anchor': 'middle', y: node.r + 29 }, typeOf(node.id)), svg('title', {}, node.id))
      node.mark.node = node
      node.mark.addEventListener('pointerenter', () => !running && light(near(node.id)))
      node.mark.addEventListener('pointerleave', () => light())
      node.mark.addEventListener('focus', () => light(near(node.id)))
      node.mark.addEventListener('blur', () => light())
      node.mark.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          chosen(node.id)
        } else if (event.key === 'Escape') choose()
        else return
        event.preventDefault()
      })
      // A press that came from no pointer, as a screen reader makes it. Those that did are told apart from a drag below.
      node.mark.addEventListener('click', (event) => event.detail === 0 && chosen(node.id))
      return node.mark
    }))
    legend.replaceChildren(...Object.entries(KINDS).filter(([kind]) => edges.some((edge) => edge.kind === kind)).map(([kind, text]) => {
      const button = el('button', { type: 'button', class: kind, 'aria-pressed': String(!drawn.off.has(kind)), on: { click: () => {
        if (!drawn.off.delete(kind)) drawn.off.add(kind)
        button.setAttribute('aria-pressed', String(!drawn.off.has(kind)))
        hide()
      } } }, svg('svg', { viewBox: '0 0 22 8', 'aria-hidden': 'true' }, svg('line', { x1: 1, x2: 21, y1: 4, y2: 4 })), text, el('span', { class: 'muted' }, amount(edges.filter((edge) => edge.kind === kind).length)))
      return button
    }))
    hide()
    if (!byId.has(drawn.chosen)) drawn.chosen = undefined
    tell()
    const moved = nodes.some((node) => Math.hypot(node.x - node.start.x, node.y - node.start.y) > 0.5)
    if (!moved || calm) return size.w > 0 ? place() : undefined
    for (const node of nodes) {
      node.end = { x: node.x, y: node.y }
      Object.assign(node, node.start)
    }
    glide = { gone: 0 }
    if (size.w > 0) run()
  }
  function hide() {
    for (const edge of edges) for (const mark of [edge.mark, edge.tag]) mark.classList.toggle('off', drawn.off.has(edge.kind))
    for (const node of nodes) node.mark.classList.toggle('alone', node.id !== me && !edges.some((edge) => (edge.a === node.id || edge.b === node.id) && !drawn.off.has(edge.kind)))
  }
  /** Brings some forward and lets the rest fall back. Nothing named goes back to whoever is picked. */
  function light(some, only) {
    const lit = some ?? (drawn.chosen === undefined ? undefined : near(drawn.chosen))
    const about = some ? [...some][0] : drawn.chosen
    paper.classList.toggle('dimmed', lit !== undefined)
    for (const node of nodes) node.mark.classList.toggle('lit', lit?.has(node.id) ?? false)
    for (const edge of edges) for (const mark of [edge.mark, edge.tag]) mark.classList.toggle('lit', only ? edge === only : lit !== undefined && (edge.a === about || edge.b === about))
    word()
  }
  /** Picks one, or whoever was picked no longer. The view moves to make room after `wait`, so a second press is not made on someone else. */
  function choose(id, wait = 0) {
    drawn.chosen = id === drawn.chosen ? undefined : id
    for (const node of nodes) node.mark.setAttribute('aria-pressed', String(node.id === drawn.chosen))
    const node = byId.get(drawn.chosen)
    drawn.left = node !== undefined && node.x * drawn.camera.k + drawn.camera.x > size.w - 330
    tell()
    // Until then nothing moves, so a second press is made on the same one.
    drawn.still = performance.now() + wait
    clearTimeout(later)
    root.classList.toggle('waiting', wait > 0)
    later = setTimeout(() => {
      root.classList.remove('waiting')
      if (root.isConnected) calm ? place() : run()
    }, wait)
  }
  /** Picked by no pointer, so what is told is where the focus goes. */
  const chosen = (id) => {
    choose(id)
    if (!card.hidden) card.querySelector('button').focus({ preventScroll: true })
  }
  const shut = () => {
    const was = byId.get(drawn.chosen)?.mark
    choose(drawn.chosen)
    was?.focus({ preventScroll: true })
  }
  card.addEventListener('keydown', (event) => event.key === 'Escape' && shut())
  /** The card: who is picked, how they stand to the subject, and what can be done. */
  function tell() {
    light()
    const node = byId.get(drawn.chosen)
    card.hidden = node === undefined
    card.classList.toggle('left', drawn.left)
    if (!node) return
    const { tie } = node
    const mine = profile.links.find((link) => link.subject === node.id)
    card.replaceChildren(
      el('button', { class: 'shut', type: 'button', 'aria-label': 'Close', on: { click: shut } }, '×'),
      el('b', { class: 'title' }, node.id),
      node.role === 'me' ? el('p', { class: 'muted' }, 'This subject') : el('p', {}, el('span', { class: `chip ${node.role === 'member' ? 'same' : node.role === 'far' ? '' : node.role}` }, node.role === 'member' ? 'same person' : node.role === 'apart' ? 'kept apart' : node.role === 'related' ? 'tied, not joined' : 'tied through another')),
      tie && tie.kind !== 'apart' ? el('span', { class: 'reason' }, el('b', {}, me), ` ${said(tie)}`) : '',
      ...(tie?.kind === 'apart' ? [el('p', {}, ...kept(verdict(tie.a, tie.b))), tie.score === undefined ? '' : el('p', { class: 'muted' }, `What ties it to ${me} otherwise, ${percent(tie.score)}`)] : []),
      tie?.score === undefined ? '' : meter(tie.score),
      ...(mine ? reasons(mine.reasons) : node.role === 'member' ? [el('span', { class: 'reason' }, 'No tie of its own to this subject. Joined through others.')] : []),
      ...edges.filter((edge) => edge.from === node || edge.to === node).filter((edge) => edge !== tie).map((edge) => el('span', { class: 'reason' }, el('b', {}, edge.from === node ? edge.b : edge.a), ` ${said(edge)}`, ...(edge.kind === 'apart' ? ['. ', ...kept(verdict(edge.a, edge.b))] : []))),
      el('div', { class: 'row' },
        node.id === me ? '' : el('button', { class: 'primary', type: 'button', on: { click: () => go(subjectHash(node.id)) } }, 'Open'),
        node.id === me ? '' : el('button', { type: 'button', 'data-key': 'ties', on: { click: (event) => outward(node.id, event.currentTarget) } }, drawn.more.has(node.id) ? 'Hide its ties' : 'Show its ties'),
        mine ? el('button', { type: 'button', on: { click: () => act('Keep these two apart', `${me} and ${node.id} will never share a cluster, whatever they share later.`, '/separate', { a: me, b: node.id }, 'Keep apart') } }, 'Keep apart') : ''))
  }
  /** Draws someone's own ties too, or takes them away again. */
  async function outward(id, button) {
    if (opening) return
    const held = document.activeElement === button
    if (!drawn.more.delete(id)) {
      // A refresh under way would replace the graph this is added to, so it gives way.
      const turn = ++loading
      pending += 1
      button.disabled = true
      try {
        const found = await api('GET', `/subject?subject=${encodeURIComponent(id)}`)
        if (turn !== loading || !root.isConnected) return
        if (found.known) drawn.more.set(id, found)
      } catch (error) {
        return turn === loading ? notice(error.message, true) : undefined
      } finally {
        pending -= 1
        button.disabled = false
      }
    }
    // Whatever had the focus is made anew, and has it again. One that was turned off meanwhile had lost it to nobody.
    const at = document.activeElement
    const name = (control) => control.dataset.key ?? control.textContent
    const kept = card.contains(at) ? name(at) : held && at === document.body && drawn.chosen === id ? 'ties' : undefined
    draw()
    if (kept !== undefined) [...card.querySelectorAll('button')].find((control) => name(control) === kept)?.focus({ preventScroll: true })
  }

  // Moving: one pointer moves a subject or the paper, two zoom.
  const zoom = (factor, x = size.w / 2, y = size.h / 2, dx = 0, dy = 0) => {
    const from = drawn.camera
    const k = Math.max(0.2, Math.min(3, from.k * factor))
    drawn.camera = { k, x: x + dx - ((x - from.x) * k) / from.k, y: y + dy - ((y - from.y) * k) / from.k, held: true }
    place()
  }
  const at = (event) => {
    const box = paper.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }
  const down = new Map()
  let grip
  let tapped
  paper.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    down.set(event.pointerId, at(event))
    paper.setPointerCapture(event.pointerId)
    root.classList.add('held')
    if (down.size > 1) {
      if (grip?.node) grip.node.held = false
      grip = undefined
    }
    else grip = { node: event.target.closest('.node')?.node, from: at(event), moved: false, camera: { ...drawn.camera } }
  })
  paper.addEventListener('pointermove', (event) => {
    if (!down.has(event.pointerId)) return
    const now = at(event)
    if (down.size === 2) {
      const [other] = [...down].filter(([id]) => id !== event.pointerId).map(([, spot]) => spot)
      const was = down.get(event.pointerId)
      zoom(Math.hypot(now.x - other.x, now.y - other.y) / Math.max(1, Math.hypot(was.x - other.x, was.y - other.y)), (was.x + other.x) / 2, (was.y + other.y) / 2, (now.x - was.x) / 2, (now.y - was.y) / 2)
    }
    down.set(event.pointerId, now)
    if (!grip) return
    const [dx, dy] = [now.x - grip.from.x, now.y - grip.from.y]
    if (!grip.moved && Math.hypot(dx, dy) < 4) return
    grip.moved = true
    // A drag is no first press of two.
    tapped = undefined
    drawn.still = 0
    // What is being moved stays still on the paper otherwise, so the view does not slide under the hand.
    drawn.camera = { ...drawn.camera, held: true }
    if (!grip.node) {
      drawn.camera = { ...grip.camera, x: grip.camera.x + dx, y: grip.camera.y + dy, held: true }
      return place()
    }
    glide = undefined
    grip.node.held = true
    drawn.pins.add(grip.node.id)
    grip.node.x = (now.x - drawn.camera.x) / drawn.camera.k
    grip.node.y = (now.y - drawn.camera.y) / drawn.camera.k
    if (calm) place()
    else {
      heat = Math.max(heat, 0.35)
      run()
    }
  })
  paper.addEventListener('pointerup', (event) => {
    if (grip && !grip.moved) {
      const { node } = grip
      if (node && tapped?.id === node.id && event.timeStamp - tapped.at < 400) go(subjectHash(node.id))
      else if (node) choose(node.id, 420)
      else if (drawn.chosen !== undefined) choose()
      tapped = node && { id: node.id, at: event.timeStamp }
    }
  })
  // However a pointer goes, its hold goes with it, and the graph is let go of with the last.
  paper.addEventListener('lostpointercapture', (event) => {
    down.delete(event.pointerId)
    if (grip?.node) grip.node.held = false
    grip = undefined
    if (down.size === 0) root.classList.remove('held')
  })
  // A wheel scrolls the page, as anywhere else on it. With Ctrl or Cmd, or pinched, it zooms.
  paper.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && document.fullscreenElement !== root) return
    event.preventDefault()
    const { x, y } = at(event)
    zoom(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.004)), x, y)
  }, { passive: false })
  const tool = (text, label, click) => el('button', { type: 'button', 'aria-label': label, title: label, on: { click } }, text)
  tools.append(tool('+', 'Zoom in', () => zoom(1.25)), tool('−', 'Zoom out', () => zoom(0.8)), tool('Reset', 'Put everything back where it was and show all of it', () => {
    drawn.pins.clear()
    drawn.spots.clear()
    drawn.camera = undefined
    draw()
  }))
  if (document.fullscreenEnabled) tools.append(tool('Full screen', 'Fill the screen, or stop', () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen())))

  // Nothing here changes what is on screen until the load that made it has taken the screen, so one that gives way leaves no trace.
  root.begin = () => {
    const same = drawn.subject === me
    redrawn(me)
    for (const each of more) if (drawn.more.has(each.subject)) if (each.known) drawn.more.set(each.subject, each); else drawn.more.delete(each.subject)
    const measure = () => {
      // Narrow, the card has no room beside anyone and stands under the paper.
      root.classList.toggle('narrow', root.clientWidth <= 720)
      size = { w: paper.clientWidth, h: paper.clientHeight }
      if (size.w > 0) paper.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`)
      if (size.w === 0 || nodes.length === 0) return
      place()
      if (glide) run()
    }
    measure()
    draw(same)
    new ResizeObserver(measure).observe(paper)
  }
  return root
}
