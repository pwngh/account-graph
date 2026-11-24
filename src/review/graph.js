/** The most drawn around one subject, and in all once others have been opened out. */
const ROOM = 24
const MOST = 90
/** Everyone to draw around a subject: its own ties and separations first, then the rest of its cluster. */
const around = (profile) => [...new Set([...profile.separated, ...profile.links.map((link) => link.subject), ...(profile.cluster?.members ?? [])])].filter((each) => each !== profile.subject)

/** What was done to the graph on screen, so a refresh draws it as it was left: where each stands, what was moved, opened out, picked and hidden. */
const drawn = { subject: undefined, spots: new Map(), pins: new Set(), more: new Map(), off: new Set(), camera: undefined, chosen: undefined, left: false, still: 0, least: 0, whole: false }
function redrawn(subject) {
  if (drawn.subject === subject) return
  Object.assign(drawn, { subject, pins: new Set(), more: new Map(), camera: undefined, chosen: undefined, whole: false })
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
    node.wide = Math.max(widthOf(nameOf(node.id), node.role === 'me' ? '600 14px' : '600 13px'), widthOf(typeOf(node.id), '400 12px'))
    node.side = drawn.spots.get(node.id)?.side ?? 'below'
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
      const room = 110 + (a.wide + b.wide) / 3 * Math.abs(dx / far)
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
    const pull = heat * (kind === 'joined' ? 0.07 * (far - 215 + 30 * score) : kind === 'related' ? 0.05 * (far - 270) : 0.025 * (far - 310))
    for (const [node, way] of [[from, 1], [to, -1]]) {
      node.vx += (way * pull * dx) / far
      node.vy += (way * pull * dy) / far
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

/** How much room is always kept: around discs and names, and between either and a line. */
const GAP = 12
const CLEAR = 8
let ruler
const widths = new Map()
/** How wide a text is, from the browser's own fonts and not from how many letters it has. */
function widthOf(text, font) {
  const key = `${font}\n${text}`
  if (!widths.has(key)) {
    if (widths.size > 2000) widths.clear()
    ruler ??= document.createElement('canvas').getContext('2d')
    ruler.font = `${font} ${getComputedStyle(document.body).fontFamily}`
    widths.set(key, Math.ceil(ruler.measureText(text).width))
  }
  return widths.get(key)
}
/** Where a name may stand by its disc. */
const SIDES = ['below', 'above', 'right', 'left']
/** What a subject takes up: its disc with the ring around it, and its name. Each is a middle and half of its size. */
function shapes(node, side = node.side) {
  const ring = node.r + (node.role === 'me' ? 11 : 9)
  const [w, h] = [node.wide / 2 + 2, 18]
  const [dx, dy] = side === 'below' ? [0, ring - 1 + h] : side === 'above' ? [0, -ring + 1 - h] : side === 'right' ? [ring + 4 + w, 0] : [-ring - 4 - w, 0]
  return [{ x: node.x, y: node.y, w: ring, h: ring, round: true }, { x: node.x + dx, y: node.y + dy, w, h, round: false }]
}
/** How far two boxes are into each other, and along which way they part soonest. */
function overlap(one, two, gap = 0) {
  const [dx, dy] = [two.x - one.x, two.y - one.y]
  const [ox, oy] = [one.w + two.w + gap - Math.abs(dx), one.h + two.h + gap - Math.abs(dy)]
  if (ox <= 0 || oy <= 0) return undefined
  return ox < oy ? { x: Math.sign(dx || 1) * ox, y: 0 } : { x: 0, y: Math.sign(dy || 1) * oy }
}
/** The stretch of a line that is inside a box, as shares of the line, or undefined. */
function crossing(from, to, box, gap = 0) {
  let [enter, leave] = [0, 1]
  for (const [start, way, middle, half] of [[from.x, to.x - from.x, box.x, box.w + gap], [from.y, to.y - from.y, box.y, box.h + gap]]) {
    if (Math.abs(way) < 1e-9) {
      if (Math.abs(start - middle) >= half) return undefined
      continue
    }
    const [a, b] = [(middle - half - start) / way, (middle + half - start) / way]
    enter = Math.max(enter, Math.min(a, b))
    leave = Math.min(leave, Math.max(a, b))
  }
  return enter < leave ? [enter, leave] : undefined
}
/** How to move a box off a line it has nothing to do with, or undefined when it is clear of it. */
function offLine(from, to, box, gap) {
  const [ex, ey] = [to.x - from.x, to.y - from.y]
  const long = Math.max(1, Math.hypot(ex, ey))
  const [nx, ny] = [-ey / long, ex / long]
  const far = (box.x - from.x) * nx + (box.y - from.y) * ny
  if (box.round) {
    const t = Math.max(0, Math.min(1, ((box.x - from.x) * ex + (box.y - from.y) * ey) / (long * long)))
    if (Math.hypot(box.x - from.x - t * ex, box.y - from.y - t * ey) >= box.w + gap) return undefined
  } else if (!crossing(from, to, box, gap)) return undefined
  const need = (box.round ? box.w : Math.abs(nx) * box.w + Math.abs(ny) * box.h) + gap - Math.abs(far)
  if (need <= 0) return undefined
  const way = far < 0 ? -1 : 1
  return { x: nx * way * need, y: ny * way * need }
}
/** What is too near to what: each with how the second would move to be clear. */
function* crowding(nodes, edges) {
  const taken = nodes.map((node) => shapes(node))
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (Math.abs(nodes[i].x - nodes[j].x) > 360 || Math.abs(nodes[i].y - nodes[j].y) > 200) continue
    for (const one of taken[i]) for (const two of taken[j]) {
      const push = overlap(one, two, GAP)
      if (push) yield { push, node: nodes[j], others: [nodes[i]] }
    }
  }
  for (const { from, to, bend } of edges) for (let i = 0; i < nodes.length; i++) {
    if (bend || nodes[i] === from || nodes[i] === to) continue
    for (const box of taken[i]) {
      if (box.x + box.w + CLEAR < Math.min(from.x, to.x) || box.x - box.w - CLEAR > Math.max(from.x, to.x) || box.y + box.h + CLEAR < Math.min(from.y, to.y) || box.y - box.h - CLEAR > Math.max(from.y, to.y)) continue
      const push = offLine(from, to, box, CLEAR)
      if (push) yield { push, node: nodes[i], others: [from, to] }
    }
  }
}
/** Moves whatever is too near apart, a little at a time, until nothing is. What was put somewhere by hand gives way last. */
function spread(nodes, edges, rounds, until = Infinity) {
  for (let round = 0; round < rounds && performance.now() < until; round++) {
    let moved = false
    for (const { push, node, others } of crowding(nodes, edges)) {
      moved = true
      const still = (each) => each.held || (drawn.pins.has(each.id) && round < rounds / 2)
      const part = others.length === 0 || others.every(still) ? 1 : still(node) ? 0 : 0.55
      if (!still(node)) {
        node.x += push.x * part
        node.y += push.y * part
      }
      for (const other of others) if (!still(other) && part < 1) {
        other.x -= (push.x * (1 - part)) / (others.length === 2 ? 1.6 : 1)
        other.y -= (push.y * (1 - part)) / (others.length === 2 ? 1.6 : 1)
      }
    }
    if (!moved) return true
  }
  return false
}
/** Puts each name on the side of its disc where the fewest lines leave and nobody else is. */
function sides(nodes, edges) {
  for (const node of nodes) {
    const own = edges.filter((edge) => edge.from === node || edge.to === node)
    const cost = (side) => {
      const [, name] = shapes(node, side)
      let sum = side === 'below' ? 0 : side === 'above' ? 0.2 : 0.3
      for (const { from, to } of own) if (crossing(from, to, name, 3)) sum += 1
      for (const other of nodes) if (other !== node) for (const box of shapes(other)) if (overlap(name, box, GAP)) sum += 4
      for (const edge of edges) if (!own.includes(edge) && crossing(edge.from, edge.to, name, CLEAR)) sum += 3
      return sum
    }
    const costs = SIDES.map(cost)
    // A name stays where it is unless another side is plainly better, so nothing flickers.
    const best = SIDES[costs.indexOf(Math.min(...costs))]
    if (Math.min(...costs) < costs[SIDES.indexOf(node.side)] - 0.5) node.side = best
  }
}
/** Moves whoever stands in an outline that is not theirs out of it. */
function outward(nodes, edges) {
  for (let round = 0; round < 12; round++) {
    let moved = false
    for (const { id, points } of outlines(nodes, edges)) {
      const middle = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length }
      for (const node of nodes) {
        if (node.cluster === id || node.held || drawn.pins.has(node.id)) continue
        if (Math.min(...corners(shapes(node)).map((p) => beyond(p, points))) >= MARGIN + CLEAR) continue
        const [dx, dy] = [node.x - middle.x, node.y - middle.y]
        const long = Math.max(1, Math.hypot(dx, dy))
        node.x += (dx / long) * 48
        node.y += (dy / long) * 48
        moved = true
      }
    }
    if (!moved) return
  }
}
/** A line as points along it: straight, or bent to one side by so much at its middle. */
function course({ from, to, bend = 0 }, sides = bend) {
  const long = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y))
  const [nx, ny] = [-(to.y - from.y) / long, (to.x - from.x) / long]
  const count = sides ? 24 : 1
  return Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count
    const off = sides * 4 * t * (1 - t)
    return { x: from.x + (to.x - from.x) * t + nx * off, y: from.y + (to.y - from.y) * t + ny * off }
  })
}
/** Whether a course is clear of every disc and name but those at its own ends. */
function freeOf(edge, points, taken) {
  const [l, r, t, b] = [Math.min, Math.max, Math.min, Math.max].map((pick, i) => pick(...points.map((p) => (i < 2 ? p.x : p.y))))
  // Most are nowhere near it, and that is quickly seen.
  const near = (box) => box.x + box.w + CLEAR > l && box.x - box.w - CLEAR < r && box.y + box.h + CLEAR > t && box.y - box.h - CLEAR < b
  return taken.every(({ node, boxes }) => node === edge.from || node === edge.to || boxes.every((box) => !near(box) || points.every((p, i) => {
    if (i === 0) return true
    if (box.round) return apartFrom(points[i - 1], p, box) >= box.w + CLEAR - 4
    return !crossing(points[i - 1], p, box, CLEAR - 4)
  })))
}
/** How far a point is from a stretch of line. */
function apartFrom(a, b, p) {
  const [ex, ey] = [b.x - a.x, b.y - a.y]
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / Math.max(1, ex * ex + ey * ey)))
  return Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey)
}
/** Bends each line that runs through someone around them, as little as will do. Answers how many it could not. */
function route(nodes, edges, until = performance.now() + 250) {
  for (const edge of edges) edge.bend = 0
  if (performance.now() > until) return edges.length
  const taken = nodes.map((node) => ({ node, boxes: shapes(node) }))
  const left = new Map()
  let stuck = 0
  for (const [n, edge] of edges.entries()) {
    // Out of time, the rest stay straight.
    if (performance.now() > until) return stuck + edges.length - n
    const long = Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y)
    const ways = [0, 0.1, -0.1, 0.18, -0.18, 0.26, -0.26, 0.36, -0.36, 0.48, -0.48, 0.62, -0.62].map((part) => part * Math.max(160, long))
    // Best is one that also keeps off the names at its own ends and leaves them apart from other lines. A line may have to do without.
    // A straight way that will do is taken at once when there are many.
    const clear = edges.length > 60 && freeOf(edge, course(edge, 0), taken) ? [0] : ways.filter((sides) => freeOf(edge, course(edge, sides), taken))
    const leaves = (sides) => {
      const points = course(edge, sides)
      const [a, b] = [points[1], points.at(-2)]
      return [[edge.from, Math.atan2(a.y - edge.from.y, a.x - edge.from.x)], [edge.to, Math.atan2(b.y - edge.to.y, b.x - edge.to.x)]]
    }
    const named = clear.filter((sides) => [edge.from, edge.to].every((node) => {
      const [, name] = shapes(node)
      return course(edge, sides).every((p, i, all) => i === 0 || !crossing(all[i - 1], p, name, 3))
    }))
    const alone = (sides) => leaves(sides).every(([node, angle]) => (left.get(node) ?? []).every((other) => Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other))) > 0.16))
    const worse = (sides) => Math.abs(sides) / long + (named.includes(sides) ? 0 : 0.3) + (alone(sides) ? 0 : 0.2)
    const way = clear.length > 0 ? clear.reduce((best, sides) => (worse(sides) < worse(best) ? sides : best)) : undefined
    for (const [node, angle] of leaves(way ?? 0)) left.set(node, [...(left.get(node) ?? []), angle])
    edge.bend = way ?? 0
    if (way === undefined) stuck += 1
  }
  return stuck
}
/** Gives everything its room: names to their best side, then apart, lines around what is in their way, and wider only when that is not enough. */
function settle(nodes, edges, tries = 40) {
  // It is better to be a little untidy than not to answer a press.
  const until = performance.now() + 700
  for (const edge of edges) edge.bend = 0
  for (let i = 0; i < tries && performance.now() < until; i++) {
    sides(nodes, edges)
    outward(nodes, edges)
    spread(nodes, edges, 24, until)
    const still = [...crowding(nodes, [])].length === 0 || spread(nodes, [], 80, until)
    if (still && route(nodes, edges, until) === 0) return true
    if (performance.now() > until) return false
    for (const edge of edges) edge.bend = 0
    for (const [n, node] of nodes.entries()) {
      node.x = node.x * 1.06 + (n % 3) - 1
      node.y = node.y * 1.06 + (n % 2)
    }
  }
  route(nodes, edges, until)
  return false
}

/** Everyone in a ring, and whoever is not of the subject's cluster in a wider one. */
function ring(nodes, tall) {
  const own = nodes[0].cluster
  const inner = nodes.filter((node) => node.cluster === own)
  const round = (list, reach) => list.forEach((node, i) => {
    const turn = (i / list.length) * 2 * Math.PI - Math.PI / 2
    node.x = Math.cos(turn) * reach * (tall ? 0.85 : 1.5)
    node.y = Math.sin(turn) * reach
  })
  const reach = Math.max(130, inner.length * 19)
  round(inner, reach)
  round(nodes.filter((node) => node.cluster !== own), reach + 170)
}
/** How hard a layout is to read: how often lines cross, and how far it reaches. */
function tangle(nodes, edges) {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
  let cost = 0
  edges.forEach((one, i) => {
    for (const two of edges.slice(i + 1)) {
      if (one.from === two.from || one.from === two.to || one.to === two.from || one.to === two.to) continue
      if (side(one.from, one.to, two.from) !== side(one.from, one.to, two.to) && side(two.from, two.to, one.from) !== side(two.from, two.to, one.to)) cost += 1
    }
  })
  const reach = Math.max(...nodes.map((node) => Math.hypot(node.x, node.y)))
  return cost + reach / 120 + edges.reduce((sum, edge) => sum + Math.abs(edge.bend) / 40, 0) + outlines(nodes, edges).filter(({ clear }) => !clear).length * 3
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

/** Points around boxes, close enough together to draw an outline through. */
const corners = (boxes) => boxes.flatMap(({ x, y, w, h, round }) => (round ? [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({ x: x + w * Math.cos((n * Math.PI) / 4), y: y + h * Math.sin((n * Math.PI) / 4) })) : [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => ({ x: x + dx * w, y: y + dy * h }))))
const MARGIN = 14
/** The outline of each cluster that has two or more drawn, around their discs and names, and whether it is clear of everyone else. */
function outlines(nodes, edges) {
  const clusters = new Map()
  for (const node of nodes) if (node.cluster !== undefined) clusters.set(node.cluster, [...(clusters.get(node.cluster) ?? []), node])
  return [...clusters].filter(([id, list]) => list.length > 1 && !edges.some((edge) => edge.kind === 'apart' && edge.from.cluster === id && edge.to.cluster === id)).map(([id, list]) => {
    const points = outline(list.flatMap((node) => corners(shapes(node))))
    return { id, points, clear: nodes.every((node) => node.cluster === id || corners(shapes(node)).every((p) => beyond(p, points) > MARGIN + 2)) }
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
  const stage = el('div', { class: 'stage' }, paper, card)
  root.append(stage, el('div', { class: 'bar' }, legend, tools))
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

  /** The part of a line that is drawn: from clear of one disc, and of its name if the line leaves that way, to clear of the other. */
  function span(edge) {
    const fine = course(edge).length > 2 ? course(edge) : Array.from({ length: 49 }, (_, i) => ({ x: edge.from.x + ((edge.to.x - edge.from.x) * i) / 48, y: edge.from.y + ((edge.to.y - edge.from.y) * i) / 48 }))
    const within = (near) => {
      const [, name] = shapes(near)
      const room = near.r + (near.role === 'me' ? 12 : 4)
      return (p) => Math.hypot(p.x - near.x, p.y - near.y) < room || (Math.abs(p.x - name.x) < name.w + 3 && Math.abs(p.y - name.y) < name.h + 2)
    }
    // Walked in small steps from each end to the last place that is still within, and on to just past it.
    const walk = (points, near) => {
      const inside = within(near)
      const [, name] = shapes(near)
      for (let i = points.length - 1; i > 0; i--) {
        const [out, back] = [points[i], points[i - 1]]
        if (!inside(back) && i > 1) {
          // Across a corner of the name, with neither end in it.
          if (crossing(back, out, name, 2)) return points.slice(i)
          continue
        }
        let [lo, hi] = [0, 1]
        for (let n = 0; n < 12; n++) {
          const mid = (lo + hi) / 2
          if (inside({ x: back.x + (out.x - back.x) * mid, y: back.y + (out.y - back.y) * mid })) lo = mid
          else hi = mid
        }
        return [{ x: back.x + (out.x - back.x) * hi, y: back.y + (out.y - back.y) * hi }, ...points.slice(i)]
      }
      return points
    }
    return walk(walk(fine, edge.from).reverse(), edge.to).reverse()
  }
  /** A place along a drawn line, by share of its length. */
  function along(points, share) {
    const longs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
    let left = share * longs.reduce((sum, long) => sum + long, 0)
    for (const [i, long] of longs.entries()) {
      if (left <= long && long > 0) return { x: points[i].x + ((points[i + 1].x - points[i].x) * left) / long, y: points[i].y + ((points[i + 1].y - points[i].y) * left) / long }
      left -= long
    }
    return points.at(-1)
  }
  /** Everything is put where the layout has it. Answers whether the view is still on its way to showing it all. */
  function place(ease = false) {
    for (const node of nodes) {
      node.mark.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
      const [, name] = shapes(node)
      const anchor = node.side === 'right' ? 'start' : node.side === 'left' ? 'end' : 'middle'
      const x = name.x - node.x + (node.side === 'right' ? -name.w : node.side === 'left' ? name.w : 0)
      for (const [text, y] of [[node.texts[0], name.y - node.y - 2], [node.texts[1], name.y - node.y + 13]]) for (const [key, value] of [['x', x.toFixed(1)], ['y', y.toFixed(1)], ['text-anchor', anchor]]) text.setAttribute(key, value)
      drawn.spots.set(node.id, { x: node.x, y: node.y, side: node.side })
    }
    for (const edge of edges) {
      edge.span = span(edge)
      const d = `M${edge.span.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}`
      for (const line of edge.lines) line.setAttribute('d', d)
      const spot = along(edge.span, edge.along)
      edge.tag.setAttribute('transform', `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})`)
    }
    // An outline that would also take in someone else says what is not so, and is left out.
    hulls.replaceChildren(...outlines(nodes, edges).filter(({ clear }) => clear)
      .map(({ id, points }) => svg('path', { 'stroke-width': MARGIN * 2, class: id === byId.get(me).cluster ? 'mine' : '', d: `M${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L')}Z` })))
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
    const taken = nodes.flatMap((node) => shapes(node))
    for (const edge of edges) {
      const told = edge.mark.classList.contains('worded') || edge.mark.classList.contains('lit')
      if (!told || edge.mark.classList.contains('off') || !edge.span) continue
      const spot = (t) => ({ ...along(edge.span, t), w: edge.wide / 2, h: 10 })
      const free = (box) => !taken.some((other) => overlap(box, other, 4)) && !edges.some((other) => other !== edge && !other.mark.classList.contains('off') && other.span && other.span.some((p, i) => i > 0 && crossing(other.span[i - 1], p, box, 2)))
      const at = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86].find((t) => free(spot(t)))
      // With no room anywhere on its line its words are left to the card and the title.
      edge.tag.classList.toggle('full', at === undefined)
      if (at === undefined) continue
      edge.along = at
      taken.push(spot(at))
      const { x, y } = spot(at)
      edge.tag.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    }
  }
  /** The whole graph, in the middle of the room beside the card. */
  function fitted() {
    const boxes = [...nodes.flatMap((node) => shapes(glide ? { ...node, ...node.end } : node)), ...edges.flatMap((edge) => (edge.bend ? course(glide ? { from: edge.from.end, to: edge.to.end, bend: edge.bend } : edge).map((p) => ({ ...p, w: 4, h: 4 })) : []))]
    const [left, right, top, bottom] = [Math.min(...boxes.map((box) => box.x - box.w)), Math.max(...boxes.map((box) => box.x + box.w)), Math.min(...boxes.map((box) => box.y - box.h)), Math.max(...boxes.map((box) => box.y + box.h))]
    // Room is left for the card when it lies over the paper. Nothing else does.
    const narrow = root.classList.contains('narrow')
    const over = { right: !narrow && !card.hidden ? 300 : 0, bottom: narrow && document.fullscreenElement === root && !card.hidden ? card.offsetHeight + 8 : 0 }
    const [w, h] = [size.w - over.right, size.h - over.bottom]
    const whole = Math.max(0.1, Math.min(1.25, w / (right - left + 56), h / (bottom - top + 48)))
    // Never so small that names cannot be read: the subject in the middle, and the rest by panning.
    const k = drawn.whole ? whole : Math.max(0.55, whole)
    const [cx, cy] = k === whole ? [(left + right) / 2, (top + bottom) / 2] : [byId.get(me).x, byId.get(me).y]
    return { k, x: w / 2 + (card.classList.contains('left') ? over.right : 0) - k * cx, y: h / 2 - k * cy }
  }
  /** Whether something was moved by hand since everything last had its room. */
  let loose = false
  function rest() {
    loose = false
    const start = nodes.map(({ x, y }) => ({ x, y }))
    settle(nodes, edges)
    nodes.forEach((node, i) => {
      Object.assign(node, { start: start[i], end: { x: node.x, y: node.y } }, calm ? {} : start[i])
    })
    if (!calm) glide = { gone: 0 }
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
        if (heat > 0.02) {
          step(nodes, edges, heat, size.w < size.h * 1.2)
          spread(nodes, [], 3)
          // With many, lines are straight while something moves, and bend again once it rests.
          if (nodes.length <= 40) route(nodes, edges)
          else for (const edge of edges) edge.bend = 0
        }
        heat *= 0.97
        // Let go of and at rest: whatever is still too near is moved apart, for all to see.
        if (heat <= 0.02 && loose && !nodes.some((node) => node.held)) rest()
      }
      const moving = place(true)
      if (moving || glide || heat > 0.02) return void requestAnimationFrame(frame)
      running = false
      word()
      if (document.activeElement?.node && dots.contains(document.activeElement)) reveal(document.activeElement.node)
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
      node.start = { x: from.x, y: from.y }
      node.x = from.x + (node.known || node.id === me ? 0 : Math.cos(turn) * (40 + 9 * i))
      node.y = from.y + (node.known || node.id === me ? 0 : Math.sin(turn) * (40 + 9 * i))
      node.vx = node.vy = 0
    })
    for (const edge of edges) Object.assign(edge, { from: byId.get(edge.a), to: byId.get(edge.b) })
    const thick = nodes.length > 5 && edges.length > 2.4 * nodes.length
    paper.classList.toggle('thick', thick)
    // Left as it was when everything on it already had a place.
    if (!nodes.every((node) => node.known)) {
      // Where they start decides how they end, so a few starts are tried and the one easiest to read is kept.
      let starts = nodes.some((node) => node.known) ? 1 : nodes.length <= 30 ? 12 : 1
      let again = false
      if (thick) starts = 1
      const first = nodes.map(({ x, y }) => ({ x, y }))
      let best
      const began = performance.now()
      for (let turn = 0; turn < starts; turn++) {
        nodes.forEach((node, i) => {
          const from = first[i === 0 ? 0 : 1 + ((i - 1) * (turn % 2 ? 1 : 1 + turn) + turn * 5) % (nodes.length - 1)]
          Object.assign(node, starts === 1 ? first[i] : { x: from.x * (turn % 3 ? 1 : -1), y: from.y }, { vx: 0, vy: 0 })
        })
        // Two may have been given one place, which would never part them.
        nodes.forEach((node, i) => { if (!node.known) { node.x += i * 0.7; node.y += i * 0.3 } else node.held = keep })
        // Where nearly everyone is tied to everyone, a ring shows who and the lines cross in the middle, away from names.
        if (thick && !keep) ring(nodes, size.w < size.h * 1.2)
        else for (let i = 0, warm = 1; i < 320; i++, warm *= 0.985) step(nodes, edges, warm, size.w < size.h * 1.2)
        const roomy = settle(nodes, edges)
        // Where they were left may have no way out. Then they start over, as if none had a place.
        if (!roomy && starts === 1 && !keep && !again && !thick) {
          again = true
          starts = 8
          turn = 0
          first.forEach((spot, n) => Object.assign(spot, n === 0 ? { x: 0, y: 0 } : { x: Math.cos(n * 2.399963) * (60 + 11 * n), y: Math.sin(n * 2.399963) * (60 + 11 * n) }))
        }
        const cost = tangle(nodes, edges) + (roomy ? 0 : 1000)
        if (!best || cost < best.cost) best = { cost, spots: nodes.map(({ x, y, side }) => ({ x, y, side })), bends: edges.map((edge) => edge.bend) }
        // A phone gets fewer tries, not a longer wait.
        if (performance.now() - began > (best.cost < 1000 ? 250 : 1500)) break
      }
      nodes.forEach((node, i) => Object.assign(node, best.spots[i], { held: false }))
      edges.forEach((edge, i) => (edge.bend = best.bends[i]))
    } else if (!crowding(nodes, []).next().done || route(nodes, edges) > 0) settle(nodes, edges)
    const roomy = edges.length <= 9
    lines.replaceChildren(...edges.map((edge) => {
      const width = edge.kind === 'apart' ? 1.5 : 1 + 2 * (edge.score ?? 0)
      edge.lines = [svg('path', { class: 'line', 'stroke-width': width.toFixed(1) }), svg('path', { class: 'flow' }), svg('path', { class: 'reach' })]
      const words = edge.kind === 'apart' ? 'apart' : `${edge.reasons[0] ? `${edge.reasons[0].identifier.split(':')[0]}${edge.reasons.length > 1 ? ` +${edge.reasons.length - 1}` : ''} ` : ''}${percent(edge.score)}`
      Object.assign(edge, { wide: widthOf(words, '400 12px') + 14, along: 0.5 })
      edge.tag = svg('g', { class: `tag ${edge.kind}${roomy ? ' worded' : ''}` }, svg('rect', { x: -edge.wide / 2, y: -10, width: edge.wide, height: 20, rx: 10 }), svg('text', { 'text-anchor': 'middle', y: 4 }, words))
      edge.mark = svg('g', { class: `edge ${edge.kind}${roomy ? ' worded' : ''}` }, ...edge.lines, svg('title', {}, `${edge.a} and ${edge.b}: ${said(edge)}`))
      edge.mark.edge = edge
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
        ...(node.texts = [svg('text', { class: 'name' }, nameOf(node.id)), svg('text', { class: 'type' }, typeOf(node.id))]), svg('title', {}, node.id))
      node.mark.node = node
      node.mark.addEventListener('pointerenter', () => !running && light(near(node.id)))
      node.mark.addEventListener('pointerleave', () => light())
      node.mark.addEventListener('focus', () => {
        light(near(node.id))
        reveal(node)
      })
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
      const button = el('button', { type: 'button', class: kind, 'data-key': kind, 'aria-pressed': String(!drawn.off.has(kind)), on: { click: () => {
        if (!drawn.off.delete(kind)) drawn.off.add(kind)
        button.setAttribute('aria-pressed', String(!drawn.off.has(kind)))
        hide()
        light()
      } } }, svg('svg', { viewBox: '0 0 22 8', 'aria-hidden': 'true' }, svg('line', { x1: 1, x2: 21, y1: 4, y2: 4 })), text, el('span', { class: 'muted' }, amount(edges.filter((edge) => edge.kind === kind).length)))
      return button
    }))
    if (edges.some((edge) => edge.score !== undefined)) {
      const least = el('input', { type: 'range', min: 0, max: 100, step: 5, value: drawn.least, 'aria-label': 'Weakest tie drawn, in percent', on: { input: () => {
        drawn.least = Number(least.value)
        shown.textContent = drawn.least > 0 ? `${drawn.least}% and over` : 'Any strength'
        hide()
        light()
      } } })
      const shown = el('span', {}, drawn.least > 0 ? `${drawn.least}% and over` : 'Any strength')
      legend.append(el('label', { class: 'least' }, least, shown))
    }
    // Places of those no longer drawn are not kept: a long day opens many.
    for (const id of drawn.spots.keys()) if (!byId.has(id)) drawn.spots.delete(id)
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
  const hidden = (edge) => drawn.off.has(edge.kind) || (edge.kind !== 'apart' && edge.score * 100 < drawn.least)
  /** The strongest chain of ties from the subject to another, as the lines it goes by. */
  function chain(id) {
    const best = new Map([[me, { score: 1, by: [] }]])
    const open = new Set([me])
    while (open.size > 0) {
      const at = [...open].reduce((a, b) => (best.get(b).score > best.get(a).score ? b : a))
      open.delete(at)
      for (const edge of edges) {
        if (edge.kind === 'apart' || hidden(edge) || (edge.a !== at && edge.b !== at)) continue
        const next = edge.a === at ? edge.b : edge.a
        const score = best.get(at).score * edge.score
        if (score > (best.get(next)?.score ?? 0)) {
          best.set(next, { score, by: [...best.get(at).by, edge] })
          open.add(next)
        }
      }
    }
    return best.get(id)?.by ?? []
  }
  /** Brings one that has the focus onto the paper, if it is off it. */
  function reveal(node) {
    if (!drawn.camera || glide) return
    const { x, y, k } = drawn.camera
    // What lies under the card cannot be seen either.
    const under = !card.hidden && !root.classList.contains('narrow') ? 300 : 0
    const off = (at, low, high) => Math.max(0, low + 60 - at) - Math.max(0, at - (high - 60))
    const left = card.classList.contains('left')
    const [dx, dy] = [off(node.x * k + x, left ? under : 0, left ? size.w : size.w - under), off(node.y * k + y, 0, size.h)]
    if (dx === 0 && dy === 0) return
    drawn.camera = { x: x + dx, y: y + dy, k, held: true }
    place()
  }
  function hide() {
    for (const edge of edges) for (const mark of [edge.mark, edge.tag]) mark.classList.toggle('off', hidden(edge))
    for (const node of nodes) node.mark.classList.toggle('alone', node.id !== me && !edges.some((edge) => (edge.a === node.id || edge.b === node.id) && !hidden(edge)))
  }
  /** Brings some forward and lets the rest fall back. Nothing named goes back to whoever is picked. */
  function light(some, only) {
    const lit = some ?? (drawn.chosen === undefined ? undefined : near(drawn.chosen))
    const about = some ? [...some][0] : drawn.chosen
    paper.classList.toggle('dimmed', lit !== undefined)
    for (const node of nodes) node.mark.classList.toggle('lit', lit?.has(node.id) ?? false)
    for (const edge of edges) for (const mark of [edge.mark, edge.tag]) mark.classList.toggle('lit', only ? edge === only : lit !== undefined && (edge.a === about || edge.b === about))
    const path = drawn.chosen === undefined || some ? [] : chain(drawn.chosen)
    if (drawn.chosen !== undefined) onward()
    let at = me
    for (const edge of edges) edge.mark.classList.remove('path', 'back')
    for (const edge of path) {
      // The flow runs from the subject outward, whichever way round the line was drawn.
      edge.mark.classList.add('path', ...(edge.a === at ? [] : ['back']))
      at = edge.a === at ? edge.b : edge.a
    }
    for (const edge of path) for (const node of [edge.from, edge.to]) node.mark.classList.add('lit')
    for (const edge of path) for (const mark of [edge.mark, edge.tag]) mark.classList.add('lit')
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
  const path = el('span', { class: 'reason' })
  /** The strongest way there by the ties now drawn, when it is by way of others. */
  function onward() {
    const way = chain(drawn.chosen).reduce((on, edge) => [...on, edge.a === on.at(-1) ? edge.b : edge.a], [me])
    path.hidden = way.length < 3
    path.replaceChildren(`Strongest drawn way from ${me}: `, el('b', {}, way.slice(1).join(', then ')))
  }
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
      path,
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
    const name = (control) => control.node?.id ?? control.dataset.key ?? control.getAttribute('aria-label') ?? control.textContent
    const kept = root.contains(at) ? name(at) : held && at === document.body && drawn.chosen === id ? 'ties' : undefined
    draw()
    if (kept !== undefined) [...root.querySelectorAll('button, input, .node')].find((control) => name(control) === kept)?.focus({ preventScroll: true })
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
    root.classList.remove('waiting')
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
    loose = true
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
    if (calm && loose) {
      rest()
      place()
    } else if (loose && !running) {
      heat = Math.max(heat, 0.021)
      run()
    }
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
    drawn.whole = true
    draw()
  }))
  if (document.fullscreenEnabled) tools.append(tool('Full screen', 'Fill the screen, or stop', () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen())))

  // Nothing here changes what is on screen until the load that made it has taken the screen, so one that gives way leaves no trace.
  root.begin = () => {
    const same = drawn.subject === me
    redrawn(me)
    root.style.setProperty('--tall', `${Math.round(Math.max(520, Math.min(860, 420 + 14 * (around(profile).length + 1))))}px`)
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
