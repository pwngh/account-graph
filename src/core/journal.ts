/**
 * What the memory store needs to undo a write, gathered as the write goes.
 *
 * The first time a write reads or changes an entry of a kept map or set, the
 * journal copies every object that entry reaches, one level deep each. Undoing
 * puts each copy back into its own object, so an object two maps share stays
 * shared. A write pays for the entries it uses, not for the whole store.
 *
 * A write begun while another is open is kept on its own. Undone, it puts back
 * only what it changed; ended, what it kept joins the write around it.
 */
export type Journal = { open: Undo | undefined; outer: Undo[] }

type Undo = {
  /** Each object reached, and its contents when first reached. */
  objects: Map<object, unknown[] | Record<string, unknown>>
  /** Each entry used, whether it was there, and what it held. */
  entries: [Map<unknown, unknown> | Set<unknown>, unknown, boolean, unknown][]
  /** The keys used in each collection. `true` when the whole collection was kept. */
  used: Map<object, Set<unknown> | true>
  /** Collections kept whole, with every entry they held. */
  whole: [Map<unknown, unknown> | Set<unknown>, [unknown, unknown][]][]
  /** The order of keys in each collection, kept before the write first deletes one, since an entry put back goes last. */
  order: Map<Map<unknown, unknown> | Set<unknown>, unknown[]>
}

export function createJournal(): Journal {
  return { open: undefined, outer: [] }
}

/** Starts keeping what a write changes, inside the write already open if there is one. */
export function begin(journal: Journal) {
  if (journal.open) journal.outer.push(journal.open)
  journal.open = { objects: new Map(), entries: [], used: new Map(), whole: [], order: new Map() }
}

/** Stops keeping the innermost write. What it kept joins the write around it, or is dropped if there is none. */
export function end(journal: Journal) {
  const inner = journal.open
  journal.open = journal.outer.pop()
  if (inner && journal.open) join(journal.open, inner)
}

/** Puts back everything the innermost write changed, and stops keeping it. The write around it stays open. */
export function undo(journal: Journal) {
  const undo = journal.open
  // Nothing put back here is kept by the write around it, which saw it before.
  journal.open = undefined
  if (undo) putBack(undo)
  journal.open = journal.outer.pop()
}

function putBack(undo: Undo) {
  for (const [object, copy] of undo.objects) {
    if (object instanceof Map) {
      Map.prototype.clear.call(object)
      for (const [key, value] of copy as [unknown, unknown][]) Map.prototype.set.call(object, key, value)
    } else if (object instanceof Set) {
      Set.prototype.clear.call(object)
      for (const value of copy as unknown[]) Set.prototype.add.call(object, value)
    } else if (Array.isArray(object)) {
      object.length = 0
      for (const value of copy as unknown[]) object.push(value)
    } else {
      const fields = copy as Record<string, unknown>
      for (const key of Object.keys(object)) if (!Object.hasOwn(fields, key)) delete (object as Record<string, unknown>)[key]
      Object.assign(object, fields)
    }
  }
  for (const [collection, held] of undo.whole) {
    collection.clear()
    for (const [key, value] of held) collection instanceof Map ? collection.set(key, value) : collection.add(key)
  }
  // An entry is kept from the first time it was used, so it overrides a whole copy made after that.
  for (const [collection, key, had, value] of undo.entries) {
    if (!had) collection.delete(key)
    else if (collection instanceof Map) collection.set(key, value)
    else collection.add(key)
  }
  for (const [collection, keys] of undo.order) {
    const held = keys.filter((key) => collection.has(key)).map((key) => [key, collection instanceof Map ? collection.get(key) : undefined] as const)
    collection.clear()
    for (const [key, value] of held) collection instanceof Map ? collection.set(key, value) : collection.add(key)
  }
}

/**
 * Adds to `outer` what an inner write kept that `outer` had not. What `outer`
 * kept first is older, so it wins. What the inner write found of anything
 * `outer` never used is how it was when `outer` began.
 */
function join(outer: Undo, inner: Undo) {
  for (const [object, copy] of inner.objects) if (!outer.objects.has(object)) outer.objects.set(object, copy)
  for (const entry of inner.entries) {
    const [collection, key] = entry
    let used = outer.used.get(collection)
    if (used === true) continue
    if (!used) outer.used.set(collection, (used = new Set()))
    if (used.has(key)) continue
    used.add(key)
    outer.entries.push(entry)
  }
  for (const [collection, keys] of inner.order) if (!outer.order.has(collection) && outer.used.get(collection) !== true) outer.order.set(collection, keys)
  for (const each of inner.whole) {
    const [collection] = each
    if (outer.used.get(collection) === true) continue
    outer.used.set(collection, true)
    outer.whole.push(each)
  }
}

/** Copies, one level deep, each object `value` reaches that is not copied yet. Frozen objects and class instances never change, so they are left. */
function keep(undo: Undo, value: unknown) {
  const stack = [value]
  while (stack.length > 0) {
    const each = stack.pop()
    if (each === null || typeof each !== 'object' || undo.objects.has(each) || Object.isFrozen(each)) continue
    if (each instanceof Map) {
      const copy = [...Map.prototype.entries.call(each)] as [unknown, unknown][]
      undo.objects.set(each, copy)
      for (const [key, inner] of copy) stack.push(key, inner)
    } else if (each instanceof Set) {
      const copy = [...Set.prototype.values.call(each)]
      undo.objects.set(each, copy)
      for (const inner of copy) stack.push(inner)
    } else if (Array.isArray(each)) {
      const copy = each.slice()
      undo.objects.set(each, copy)
      for (const inner of copy) stack.push(inner)
    } else {
      const prototype = Object.getPrototypeOf(each)
      if (prototype !== Object.prototype && prototype !== null) continue
      const copy = { ...(each as Record<string, unknown>) }
      undo.objects.set(each, copy)
      for (const inner of Object.values(copy)) stack.push(inner)
    }
  }
}

function note(undo: Undo, collection: Map<unknown, unknown> | Set<unknown>, key: unknown) {
  let used = undo.used.get(collection)
  if (used === true) return
  if (!used) undo.used.set(collection, (used = new Set()))
  if (used.has(key)) return
  used.add(key)
  const had = collection instanceof Map ? Map.prototype.has.call(collection, key) : Set.prototype.has.call(collection, key)
  const value = collection instanceof Map ? Map.prototype.get.call(collection, key) : undefined
  undo.entries.push([collection, key, had, value])
  keep(undo, value)
}

/** Keeps the order of a collection's keys before the first key it held is deleted. */
function keepOrder(undo: Undo, collection: Map<unknown, unknown> | Set<unknown>, key: unknown) {
  // A collection kept whole is put back in its order already.
  if (undo.order.has(collection) || undo.used.get(collection) === true) return
  const held = collection instanceof Map ? Map.prototype.has.call(collection, key) : Set.prototype.has.call(collection, key)
  if (held) undo.order.set(collection, collection instanceof Map ? [...Map.prototype.keys.call(collection)] : [...Set.prototype.values.call(collection)])
}

function noteAll(undo: Undo, collection: Map<unknown, unknown> | Set<unknown>) {
  if (undo.used.get(collection) === true) return
  undo.used.set(collection, true)
  const held: [unknown, unknown][] = collection instanceof Map ? [...Map.prototype.entries.call(collection)] as [unknown, unknown][] : [...Set.prototype.values.call(collection)].map((each) => [each, undefined])
  undo.whole.push([collection, held])
  for (const [, value] of held) keep(undo, value)
}

/** A map whose entries a journal keeps while a write is open. Every way to reach a value notes it first. */
export class KeptMap<K, V> extends Map<K, V> {
  readonly #journal: Journal
  constructor(journal: Journal) {
    super()
    this.#journal = journal
  }
  override get(key: K) {
    if (this.#journal.open) note(this.#journal.open, this, key)
    return super.get(key)
  }
  override set(key: K, value: V) {
    if (this.#journal.open) note(this.#journal.open, this, key)
    return super.set(key, value)
  }
  override delete(key: K) {
    if (this.#journal.open) {
      note(this.#journal.open, this, key)
      keepOrder(this.#journal.open, this, key)
    }
    return super.delete(key)
  }
  override clear() {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    super.clear()
  }
  override forEach(each: (value: V, key: K, map: Map<K, V>) => void, self?: unknown) {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    super.forEach(each, self)
  }
  override values() {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    return super.values()
  }
  override entries() {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    return super.entries()
  }
  override [Symbol.iterator]() {
    return this.entries()
  }
  /** The values, left out of the journal. Only for a read that copies what it hands out, so nothing it finds can change. */
  peek() {
    return super.values()
  }
}

/** A set whose members a journal keeps while a write is open. */
export class KeptSet<T> extends Set<T> {
  readonly #journal: Journal
  constructor(journal: Journal) {
    super()
    this.#journal = journal
  }
  override add(value: T) {
    if (this.#journal.open) note(this.#journal.open, this, value)
    return super.add(value)
  }
  override delete(value: T) {
    if (this.#journal.open) {
      note(this.#journal.open, this, value)
      keepOrder(this.#journal.open, this, value)
    }
    return super.delete(value)
  }
  override clear() {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    super.clear()
  }
  override forEach(each: (value: T, again: T, set: Set<T>) => void, self?: unknown) {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    super.forEach(each, self)
  }
  override values() {
    if (this.#journal.open) noteAll(this.#journal.open, this)
    return super.values()
  }
  override [Symbol.iterator]() {
    return this.values()
  }
}
