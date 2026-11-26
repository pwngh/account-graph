// Force, collision, outline and edge routing from the reviewer graph. The loader computes geometry once for SSR and hydration.
export const PERSON = 'M0-6.2a3 3 0 1 1 0 6a3 3 0 1 1 0-6ZM-5.8 6.2C-5.4 2.6-3 1.4 0 1.4S5.4 2.6 5.8 6.2Z'
export const ICONS = {
  caller: 'M-3.4-6.5h6.8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6.8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM-1.2 4.2h2.4',
  visitor: 'M-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0ZM-6 0H6M0-6C3.2-2.4 3.2 2.4 0 6C-3.2 2.4-3.2-2.4 0-6Z',
  lead: 'M-4 6.5V-6H4.5L2.5-2.5L4.5 1H-4',
}
export const typeOf = (subject) => (subject.includes(':') ? subject.slice(0, subject.indexOf(':')) : '')
export const nameOf = (subject) => {
  const name = subject.slice(typeOf(subject) ? typeOf(subject).length + 1 : 0)
  return name.length > 16 ? `${name.slice(0, 13)}…` : name
}
const pairOf = (a, b) => (a < b ? [a, b] : [b, a])

/** One step of the layout: everything pushes everything away, ties pull, and all of it drifts to the middle, as wide or as tall as the room is. `tall` is how much taller than wide that is. */
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
    node.vx = (node.vx - node.x * home * (tall > 0.83 ? Math.max(2, 2 * tall * tall) : 1) * heat) * 0.62
    node.vy = (node.vy - node.y * home * (tall > 0.83 ? 1 : 2) * heat) * 0.62
    node.x += node.vx
    node.y += node.vy
  }
}

/** How much room is always kept: around discs and names, and between either and a line. */
const GAP = 12
const CLEAR = 8
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
      const part = others.length === 0 ? 1 : 0.55
      node.x += push.x * part
      node.y += push.y * part
      for (const other of others) {
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
        if (node.cluster === id) continue
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
function settle(nodes, edges, tall, until) {
  // It is better to be a little untidy than not to answer a press.
  for (const edge of edges) edge.bend = 0
  for (let i = 0; i < 8 && performance.now() < until; i++) {
    sides(nodes, edges)
    outward(nodes, edges)
    spread(nodes, edges, 24, until)
    const still = [...crowding(nodes, [])].length === 0 || spread(nodes, [], 80, until)
    if (still && route(nodes, edges, until) === 0) return true
    if (performance.now() > until) return false
    for (const edge of edges) edge.bend = 0
    for (const [n, node] of nodes.entries()) {
      node.x = node.x * (tall > 1.2 ? 1.02 : 1.06) + (n % 3) - 1
      node.y = node.y * (tall > 1.2 ? 1.08 : 1.06) + (n % 2)
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
    node.x = Math.cos(turn) * reach * (tall > 1.2 ? 0.7 : tall > 0.83 ? 0.85 : 1.5)
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
/** How far a point is outside a shape, or nothing when it is in it. */
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


export function clusterLayout(profile) {
  const others = [...new Set([...profile.separated, ...profile.links.map(link => link.subject), ...profile.cluster.members])].filter(subject => subject !== profile.subject)
  const members = new Set(profile.cluster.members)
  const ids = [profile.subject, ...others.slice(0, 24)]
  const visible = new Set(ids)
  const edges = new Map()
  const add = (a, b, info) => {
    if (!visible.has(a) || !visible.has(b)) return
    const key = JSON.stringify(pairOf(a, b))
    edges.set(key, { a, b, ...edges.get(key), ...info })
  }
  for (const edge of profile.edges) add(edge.a, edge.b, { kind: edge.level === 'same' && members.has(edge.a) && members.has(edge.b) ? 'joined' : 'related', score: edge.score })
  for (const link of profile.links) {
    const reasons = link.reasons.filter(reason => reason.counted !== false)
    const kinds = reasons[0]?.identifier.split(':')[0]
    add(profile.subject, link.subject, { label: (kinds ? kinds + (reasons.length > 1 ? ' +' + (reasons.length - 1) : '') + ' ' : '') + Math.round(100 * link.score) + '%' })
  }
  for (const [a, b] of [...profile.apart, ...profile.separated.slice(0, 24).map(id => [profile.subject, id])]) add(a, b, { kind: 'apart', label: 'apart' })
  const lines = [...edges.values()]
  const nodes = ids.map((id, i) => {
    const degree = lines.filter(line => line.a === id || line.b === id).length
    const role = i === 0 ? 'me' : profile.separated.includes(id) ? 'apart' : members.has(id) ? 'member' : 'related'
    // The initial server viewport has no canvas. Reserve room for the same abbreviated labels in system fonts.
    return { id, role, cluster: members.has(id) ? profile.cluster.id : undefined, r: i === 0 ? 24 : Math.min(21, 15 + degree),
      wide: Math.max(8 * nameOf(id).length, 7 * typeOf(id).length), side: 'below', vx: 0, vy: 0, x: 0, y: 0 }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const line of lines) Object.assign(line, { from: byId.get(line.a), to: byId.get(line.b) })
  const thick = nodes.length > 5 && lines.length > 2.4 * nodes.length
  const began = performance.now()
  let best
  for (let turn = 0; turn < (thick ? 1 : 12); turn++) {
    nodes.forEach((node, i) => {
      const p = i === 0 ? 0 : 1 + ((i - 1) * (turn % 2 ? 1 : 1 + turn) + turn * 5) % (nodes.length - 1)
      const radius = p === 0 ? 0 : 40 + 9 * p
      Object.assign(node, { x: Math.cos(p * 2.399963) * radius * (turn % 3 ? 1 : -1) + i * 0.7, y: Math.sin(p * 2.399963) * radius + i * 0.3, vx: 0, vy: 0 })
    })
    if (thick) ring(nodes, 0.65)
    else for (let i = 0, heat = 1; i < 320; i++, heat *= 0.985) step(nodes, lines, heat, 0.65)
    const roomy = settle(nodes, lines, 0.65, began + 55)
    const cost = tangle(nodes, lines) + (roomy ? 0 : 1000)
    if (!best || cost < best.cost) best = { cost, spots: nodes.map(({ x, y, side }) => ({ x, y, side })), bends: lines.map(line => line.bend) }
    if (performance.now() - began > 45) break
  }
  nodes.forEach((node, i) => Object.assign(node, best.spots[i]))
  lines.forEach((line, i) => line.bend = best.bends[i])
  const path = points => 'M' + points.map(p => p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('L')
  const boxes = nodes.flatMap(node => shapes(node))
  const paths = lines.map(line => {
    const points = course(line)
    for (const p of points) boxes.push({ ...p, w: 5, h: 5 })
    const [p, q] = [points[Math.floor((points.length - 1) / 2)], points[Math.ceil((points.length - 1) / 2)]]
    return { a: line.a, b: line.b, d: path(points), kind: line.kind, score: line.score, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, label: line.label || Math.round(line.score * 100) + '%' }
  })
  const left = Math.min(...boxes.map(box => box.x - box.w)) - 28
  const top = Math.min(...boxes.map(box => box.y - box.h)) - 24
  const width = Math.max(...boxes.map(box => box.x + box.w)) - left + 28
  const height = Math.max(...boxes.map(box => box.y + box.h)) - top + 24
  return { viewBox: [left, top, width, height].join(' '), total: others.length, paths, hulls: outlines(nodes, lines).filter(hull => hull.clear).map(hull => path(hull.points) + 'Z'),
    nodes: nodes.map(node => {
      const [, label] = shapes(node)
      const { id, x, y, r, role, side } = node
      return { id, x, y, r, role, tx: label.x - x, ty: label.y - y }
    }) }
}
