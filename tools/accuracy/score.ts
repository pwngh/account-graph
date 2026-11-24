/**
 * Scores what a graph joined against who is who. It knows subjects, people and
 * clusters, and nothing of identifiers, weights or scores.
 */

/** One subject the graph knows, and who it truly is. A browser or a telephone can be more than one person's. */
export interface Truth {
  subject: string
  people: readonly string[]
  /** What was told of it, as told: two subjects with none in common could not be joined by anybody. */
  facts: readonly string[]
}

export interface Count {
  /** Pairs of subjects that are one person. */
  same: number
  /** Of those, pairs that have a fact in common, or a chain of them through that person's other subjects. */
  joinable: number
  /** Of those that are one person, pairs the graph joined. */
  found: number
  /** Of the joinable, pairs the graph joined. */
  foundJoinable: number
  /** Pairs the graph joined that are two people. */
  wrong: number
}

export interface Score {
  all: Count
  /** By the kinds of the two subjects, such as `caller contact`. */
  kinds: Map<string, Count>
  /** People who have a subject only theirs, and how many of them share a cluster with a subject only somebody else's. */
  people: number
  mixed: number
  /** The same of contacts alone: people with a record, and those who share a cluster with somebody else's record. */
  recorded: number
  mixedRecords: number
  /** The same, leaving out two people of whom one spoke for the other. */
  mixedApart: number
  /** Subjects in clusters that hold two or more people who are not joined by a shared browser or telephone. */
  wrongClusters: number
  clusters: number
}

const kindOf = (subject: string) => subject.slice(0, subject.indexOf(':'))
const meets = (a: readonly string[], b: readonly string[]) => a.some((each) => b.includes(each))
const none = (): Count => ({ same: 0, joinable: 0, found: 0, foundJoinable: 0, wrong: 0 })
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** `clusterOf` says what the graph decided. A subject it does not know is in a cluster of its own. */
export function score(truths: readonly Truth[], clusterOf: ReadonlyMap<string, string>, spoke: ReadonlySet<string> = new Set()): Score {
  const all = none()
  const kinds = new Map<string, Count>()
  const count = (a: Truth, b: Truth, what: keyof Count) => {
    const key = [kindOf(a.subject), kindOf(b.subject)].sort().join(' ')
    if (!kinds.has(key)) kinds.set(key, none())
    all[what] += 1
    kinds.get(key)![what] += 1
  }
  const cluster = (each: Truth) => clusterOf.get(each.subject) ?? `alone ${each.subject}`

  const ofPerson = new Map<string, Truth[]>()
  for (const each of truths) for (const person of each.people) push(ofPerson, person, each)
  const seen = new Set<string>()
  for (const own of ofPerson.values()) {
    const group = groups(own)
    for (const [i, a] of own.entries()) {
      for (const b of own.slice(i + 1)) {
        // Two people who share both are one pair, not two.
        const key = [a.subject, b.subject].sort().join('\n')
        if (seen.has(key)) continue
        seen.add(key)
        count(a, b, 'same')
        const joined = cluster(a) === cluster(b)
        if (joined) count(a, b, 'found')
        if (group.get(a) !== group.get(b)) continue
        count(a, b, 'joinable')
        if (joined) count(a, b, 'foundJoinable')
      }
    }
  }

  const clusters = new Map<string, Truth[]>()
  for (const each of truths) push(clusters, cluster(each), each)
  const alone = (each: Truth) => (each.people.length === 1 ? each.people[0] : undefined)
  const owners = new Set(truths.flatMap((each) => alone(each) ?? []))
  const recorded = new Set(truths.flatMap((each) => (kindOf(each.subject) === 'contact' ? each.people : [])))
  const mixed = new Set<string>()
  const mixedRecords = new Set<string>()
  const mixedApart = new Set<string>()
  let wrongClusters = 0
  for (const members of clusters.values()) {
    for (const [i, a] of members.entries()) for (const b of members.slice(i + 1)) if (!meets(a.people, b.people)) count(a, b, 'wrong')
    const records = new Set(members.flatMap((each) => (kindOf(each.subject) === 'contact' ? each.people : [])))
    if (records.size > 1) for (const person of records) mixedRecords.add(person)
    for (const person of records) if ([...records].some((other) => other !== person && !spoke.has(`${person} ${other}`) && !spoke.has(`${other} ${person}`))) mixedApart.add(person)
    const inside = new Set(members.flatMap((each) => alone(each) ?? []))
    if (inside.size < 2) continue
    wrongClusters += 1
    for (const person of inside) mixed.add(person)
  }
  return { all, kinds, people: owners.size, mixed: mixed.size, recorded: recorded.size, mixedRecords: mixedRecords.size, mixedApart: mixedApart.size, wrongClusters, clusters: clusters.size }
}

/** Which of one person's subjects hang together by facts they have in common. */
function groups(own: readonly Truth[]): Map<Truth, number> {
  const holders = new Map<string, Truth[]>()
  for (const each of own) for (const fact of each.facts) push(holders, fact, each)
  const out = new Map<Truth, number>()
  let next = 0
  for (const start of own) {
    if (out.has(start)) continue
    const todo = [start]
    out.set(start, next)
    for (let each = todo.pop(); each; each = todo.pop()) {
      for (const other of each.facts.flatMap((fact) => holders.get(fact)!)) {
        if (out.has(other)) continue
        out.set(other, next)
        todo.push(other)
      }
    }
    next += 1
  }
  return out
}

/** The middle of a figure over independent worlds, and how far it may be off: Student's t at 95%. */
export function interval(values: readonly number[]): { mean: number; low: number; high: number } {
  const n = values.length
  if (n < 2) throw new TypeError('An interval requires two worlds or more')
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const spread = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) / n)
  const t = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093][n - 2] ?? 2.093
  return { mean, low: mean - t * spread, high: mean + t * spread }
}
