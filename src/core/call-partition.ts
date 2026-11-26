import type { Edge, IdentifierState, Labels, Pair, Subject } from '../contract/types.ts'
import type { CallEvidence } from './store.ts'
import { UNNAMED, earlierReasons, ruleFor, usable } from './policy.ts'
import type { Policy } from './policy.ts'
import { commonClusters, components, confirmed, conflict, knownOf, crowdedRecords, scorePairs } from './resolve.ts'

type States = Map<string, IdentifierState>
type Groups = Map<Subject, Labels>
type ReadGroups = (subjects: Subject[], edges: Edge[], states: States) => Groups
const keyOf = (row: Pick<Edge, 'subject' | 'identifier'>) => row.subject + '\u0000' + row.identifier

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    const group = groups.get(id)
    if (group) group.push(item)
    else groups.set(id, [item])
  }
  return groups
}

function restore(active: Edge[], rows: readonly CallEvidence[]) {
  const edges = new Map(active.map(edge => [keyOf(edge), { ...edge }]))
  for (const { subject, identifier, at } of rows) {
    const key = keyOf({ subject, identifier })
    const edge = edges.get(key)
    if (!edge) edges.set(key, { subject, identifier, first: at, last: at, count: 1 })
    else {
      edge.first = Math.min(at, edge.first)
      edge.last = Math.max(at, edge.last)
    }
  }
  return [...edges.values()]
}

type Reading = { rows: CallEvidence[]; omitted: CallEvidence[] }

/** Carrier reports on the same line can give the same interval, first sighting and holder count. Read each distinct effect once. */
function repeatedLines(choices: Reading[][], date: (row: CallEvidence) => number | undefined): Reading[][] {
  const separate: Reading[][] = []
  const lines = new Map<string, Reading[][]>()
  for (const variants of choices) {
    const rows = variants.flatMap(reading => reading.rows)
    if (rows.some(row => !/^(phone|voip):/.test(row.identifier))) {
      separate.push(variants)
      continue
    }
    const keys = (rows: CallEvidence[]) => rows.map(row => JSON.stringify([keyOf(row), date(row)])).sort()
    const key = JSON.stringify(variants.map(reading => [keys(reading.rows), keys(reading.omitted)]))
    const same = lines.get(key)
    if (same) same.push(variants)
    else lines.set(key, [variants])
  }
  for (const calls of lines.values()) {
    const variants = calls[0]!
    if (calls.length === 1) {
      separate.push(variants)
      continue
    }
    // At most four alternatives per call. Repeating one adds no evidence. A holder disappears only if every call omits it.
    const readings = new Map<string, Reading>()
    const omittedByKey = groupBy([...new Set(calls.flat().flatMap(reading => reading.omitted))], keyOf)
    for (let mask = 1; mask < 2 ** variants.length; mask++) {
      const selected = variants.filter((_, i) => mask & (1 << i))
      if (selected.length > calls.length) continue
      const shown = new Map(selected.flatMap(reading => reading.rows).map(row => [keyOf(row), row]))
      const absent = [...omittedByKey.keys()].filter(key => selected.every(reading => reading.omitted.some(row => keyOf(row) === key)))
      readings.set(JSON.stringify([[...shown.keys()].sort(), absent.sort()]), { rows: [...shown.values()], omitted: absent.flatMap(key => omittedByKey.get(key)!) })
    }
    separate.push([...readings.values()])
  }
  return separate
}

/** With no decision, relationship or fact to split this component, only a weak bridge could break a surviving match. */
function agreeingFloor(policy: Policy, group: Subject[], edges: Edge[], states: States, pairs: Pair[], named: (subject: Subject) => boolean, labels: Groups) {
  const records = group.filter(named)
  if (policy.records === 'confirmed' && crowdedRecords(records.length)) return
  const known = knownOf(policy, edges, id => states.get(id)?.ignored === true || (ruleFor(policy, id).weight > 0 && !usable(policy, id, states.get(id))))
  const facts = [...known.values()].filter(own => own.facts.size || own.earlier?.facts.size)
  for (const [i, a] of facts.entries()) for (let j = i + 1; j < facts.length; j++) {
    const b = facts[j]!
    if (conflict(policy, a, b) || conflict(policy, a.earlier ?? a, b.earlier ?? b)) return
  }
  if (policy.records === 'confirmed') for (const [i, a] of records.entries()) for (let j = i + 1; j < records.length; j++) {
    const x = known.get(a)
    const y = known.get(records[j]!)
    if (!confirmed(x, y) || !confirmed(x?.earlier ?? x, y?.earlier ?? y)) return
  }
  if (policy.bridge <= policy.same) return labels
  const strong = components(group, pairs.filter(pair => pair.level === 'same' && pair.score >= policy.bridge))
  // A weak bridge can grow another endpoint when more ties are restored. Anonymous pieces go back to their only named piece.
  const one = new Set(records.map(s => strong.get(s))).size === 1
  const namedHomes = new Set(records.map(s => labels.get(s)!.cluster))
  return commonClusters(labels, new Map(group.map(s => [s, { component: group[0]!, cluster: one && namedHomes.has(labels.get(s)!.cluster) ? records[0]! : strong.get(s)! }])))
}

/** A statement can take evidence away, never change which of two separated people gets an unrelated subject. */
export function callGroups(policy: Policy, subjects: Subject[], active: Edge[], withdrawn: readonly CallEvidence[], states: States, apart: [Subject, Subject][], read: ReadGroups, onCut?: (a: Subject, b: Subject) => void, onLimited?: (subjects: Subject[]) => void): Groups {
  const current = read(subjects, active, states)
  if (!withdrawn.length) return current
  const calls = groupBy(withdrawn, row => row.call)
  // When a line check was skipped or its answer was lost in an upgrade, either kind or neither could have been recorded.
  const uncertain = new Set([...calls].filter(([, rows]) => rows.some(row => row.identifier.startsWith('phone:')) && rows.some(row => row.identifier.startsWith('voip:'))).map(([id]) => id))
  const fixed = new Set([...active, ...withdrawn.filter(row => !uncertain.has(row.call))].map(keyOf))
  const possible = groupBy(withdrawn.filter(row => uncertain.has(row.call) && /^(phone|voip):/.test(row.identifier) && !fixed.has(keyOf(row))), keyOf)
  // Dropping an uncertain holder's alternative kind also removes its dilution. The other kinds' denominators stay fixed.
  function counts(omitted: ReadonlySet<CallEvidence> | undefined, original = states) {
    if (!possible.size) return original
    const kept = new Map(original)
    for (const rows of possible.values()) if (!omitted || rows.every(row => omitted.has(row))) {
      const id = rows[0]!.identifier
      const state = kept.get(id)!
      kept.set(id, { ...state, fanout: state.fanout - 1 })
    }
    return kept
  }
  const upperEdges = restore(active, withdrawn)
  const upperStates = counts(undefined)
  // Use every pair that could join, even if one of its reasons can also say they are two people.
  const possiblePairs = scorePairs(policy, upperEdges, upperStates, undefined, 0, earlierReasons).filter(pair => pair.score >= policy.same - 1e-9).map(pair => ({ ...pair, level: 'same' as const }))
  // Name upgrades can keep an old component within reach of a later write.
  for (const [subject, own] of current) if (subject !== own.component) possiblePairs.push({ a: subject, b: own.component, level: 'same', score: 1, reasons: [] })
  const homes = components(subjects, possiblePairs)
  const groups = groupBy(subjects, subject => homes.get(subject)!)
  const observed = new Set(active.map(edge => edge.subject))
  const groupOf = (row: { subject: Subject }) => homes.get(row.subject)!
  const byGroup = groupBy(active, groupOf)
  const withdrawnByGroup = groupBy(withdrawn, groupOf)
  const byIdentifier = groupBy(upperEdges, row => row.identifier)
  const uncertainById = groupBy([...possible.values()].flat(), row => row.identifier)
  const result: Groups = new Map()
  for (const [id, group] of groups) {
    const members = new Set(group)
    const edges = byGroup.get(id) ?? []
    const local = withdrawnByGroup.get(id) ?? []
    const ids = new Set([...edges, ...local].map(row => row.identifier))
    const relevant = new Set([...local, ...[...ids].flatMap(id => uncertainById.get(id) ?? [])].map(row => row.call))
    let labels = new Map(group.map(subject => [subject, current.get(subject)!]))
    if (relevant.size && group.some(subject => current.get(subject)!.cluster !== subject)) {
      // Two rows whose dates are already inside a surviving edge give the same evidence. A note may still say who came first.
      const stable = new Map(edges.map(edge => [keyOf(edge), edge]))
      const first = new Map<Subject, number>()
      for (const edge of edges) if (!edge.identifier.startsWith('review:')) first.set(edge.subject, Math.min(first.get(edge.subject) ?? Infinity, edge.first))
      let choices = [...relevant].map(call => {
        const rows = calls.get(call)!
        const different = rows.filter(row => {
          if (possible.has(keyOf(row))) return true
          if (!members.has(row.subject)) return false
          const edge = stable.get(keyOf(row))
          if (edge && edge.first <= row.at && row.at <= edge.last) return false
          if (row.at < (first.get(row.subject) ?? Infinity)) return true
          // At a related threshold of zero a usable reason can enable corroboration even when its weight is zero.
          return usable(policy, row.identifier, upperStates.get(row.identifier)) && (byIdentifier.get(row.identifier)?.length ?? 0) > 1
        })
        const variants = [{ rows: [] as CallEvidence[], omitted: [] as CallEvidence[] }]
        if (!different.length) return variants
        if (!uncertain.has(call)) return [...variants, { rows: different, omitted: [] }]
        for (const kind of ['phone', 'voip', 'none']) {
          const omitted = different.filter(row => /^(phone|voip):/.test(row.identifier) && !row.identifier.startsWith(kind + ':'))
          variants.push({ rows: different.filter(row => !omitted.includes(row)), omitted })
        }
        return variants
      }).filter(variants => variants.length > 1)
      const count = () => choices.reduce((cost, variants) => cost * variants.length, 1)
      if (count() > 64) choices = repeatedLines(choices, row => {
        if (row.at < (first.get(row.subject) ?? Infinity)) return row.at
        if (Number.isFinite(ruleFor(policy, row.identifier).halfLife) && usable(policy, row.identifier, upperStates.get(row.identifier)) && (byIdentifier.get(row.identifier)?.length ?? 0) > 1) return row.at
        return undefined
      })
      if (count() <= 64) {
        const visit = (position: number, restored: CallEvidence[], omitted: CallEvidence[]) => {
          if (position === choices.length) {
            if (restored.length || omitted.length) labels = commonClusters(labels, read(group, restore(edges, restored.filter(row => members.has(row.subject))), counts(new Set(omitted))))
            return
          }
          for (const choice of choices[position]!) visit(position + 1, [...restored, ...choice.rows], [...omitted, ...choice.omitted])
        }
        visit(0, [], [])
        // A former record can keep a caller out of another's journey even where no decision separated the two.
        if (onCut && choices.length) for (const { a, b } of scorePairs(policy, edges, states)) {
          if (current.get(a)!.cluster === current.get(b)!.cluster && labels.get(a)!.cluster !== labels.get(b)!.cluster) onCut(a, b)
        }
      } else {
        // Bound work inside a write. Keep links that no possible reading can cut. Only this connected component pays for the ambiguity.
        const named = (subject: Subject) => !(policy.unnamed ?? UNNAMED).includes(subject.slice(0, Math.max(0, subject.indexOf(':'))))
        const pairs = scorePairs(policy, edges, states)
        const separations = apart.filter(([a, b]) => members.has(a) && members.has(b))
        const relates = [...ids].some(id => ruleFor(policy, id).relates && usable(policy, id, upperStates.get(id)) && (byIdentifier.get(id)?.length ?? 0) > 1)
        const agreeing = !separations.length && !relates ? agreeingFloor(policy, group, edges, states, pairs, named, labels) : undefined
        if (agreeing) {
          if (group.some(subject => agreeing.get(subject)!.cluster !== labels.get(subject)!.cluster)) {
            onLimited?.(group)
            if (onCut) for (const { a, b } of pairs) if (agreeing.get(a)!.cluster !== agreeing.get(b)!.cluster) onCut(a, b)
          }
          labels = agreeing
        } else {
          onLimited?.(group)
          const constrained = separations.length > 0 || (policy.records === 'confirmed' && group.filter(named).length > 1) ||
            (policy.apart?.length && edges.some(edge => /^(birth|given):/.test(edge.identifier))) ||
            [...ids].some(id => ruleFor(policy, id).relates)
          const strong = pairs.filter(pair => pair.level === 'same' && pair.score >= policy.bridge && pair.reasons.some(reason => reason.identifier.startsWith('review:join-') && reason.evidence >= Math.max(policy.same, policy.bridge)))
          const reviewed = components(group, possiblePairs.filter(pair => members.has(pair.a) && pair.reasons.some(reason => reason.identifier.startsWith('review:join-'))))
          const disputed = new Set(separations.filter(([a, b]) => reviewed.get(a) === reviewed.get(b)).map(([a]) => reviewed.get(a)))
          const loose = (policy.records === 'confirmed' && group.filter(named).length > 1) ||
            (policy.apart?.includes('birth') && new Set(edges.filter(edge => edge.identifier.startsWith('birth:')).map(edge => edge.identifier)).size > 1)
          const safe = constrained ? strong.filter(({ a, b }) => !disputed.has(reviewed.get(a)) && (!loose || (named(a) && named(b)))) :
            pairs.filter(pair => pair.level === 'same' && pair.reasons.some(reason => !ruleFor(policy, reason.identifier).corroborates && !/^(name|named|person|perhaps|ward):/.test(reason.identifier) && reason.evidence >= Math.max(policy.same, policy.bridge)))
          const floor = components(group, safe)
          // A journey or campaign must respect the same boundary as the stored groups.
          if (onCut) for (const { a, b } of pairs) if (floor.get(a) !== floor.get(b)) onCut(a, b)
          labels = commonClusters(labels, new Map(group.map(subject => [subject, { component: id, cluster: floor.get(subject)! }])))
        }
      }
    }
    for (const [subject, own] of labels) if (observed.has(subject)) result.set(subject, { component: id, cluster: own.cluster })
  }
  return result
}
