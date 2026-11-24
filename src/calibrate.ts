import type { Policy } from './policy.ts'
import type { Reason } from './types.ts'

/** A pair someone has checked by hand, with the reasons the graph gave for it. */
export interface Labeled {
  reasons: readonly Reason[]
  same: boolean
}

export interface Measured {
  /** Checked pairs whose only shared identifiers were of this kind, and how many were one person. */
  alone: { pairs: number; same: number }
  /** Checked pairs that shared this kind at all. */
  any: { pairs: number; same: number }
  /** `alone.same / alone.pairs`: the measured value for the kind's `weight`. Undefined with no pairs. */
  precision: number | undefined
}

/**
 * Measures how often each identifier kind was right, from pairs checked by
 * hand. Score the pairs under a policy with `related: 0` so weak pairs are
 * included, then set each kind's weight from `precision`.
 */
export function measure(labeled: readonly Labeled[]): Record<string, Measured> {
  const out: Record<string, Measured> = {}
  for (const { reasons, same } of labeled) {
    const kinds = new Set(reasons.map((reason) => reason.identifier.slice(0, reason.identifier.indexOf(':'))))
    for (const kind of kinds) {
      const row = (out[kind] ??= { alone: { pairs: 0, same: 0 }, any: { pairs: 0, same: 0 }, precision: undefined })
      row.any.pairs += 1
      if (same) row.any.same += 1
      if (kinds.size > 1) continue
      row.alone.pairs += 1
      if (same) row.alone.same += 1
    }
  }
  for (const row of Object.values(out)) {
    if (row.alone.pairs > 0) row.precision = row.alone.same / row.alone.pairs
  }
  return out
}

export interface Fitted {
  /** The policy with each measured kind's weight replaced. Kinds with no checked pairs keep their weight. */
  policy: Policy
  kinds: Record<string, { before: number; after: number; pairs: number }>
  /** Mean log loss on the checked pairs. Lower is better; `after` should not be above `before`. */
  loss: { before: number; after: number }
  /** Pairs grouped by the score the fitted policy gives them, with how many were truly one person. */
  calibration: { from: number; to: number; pairs: number; predicted: number; actual: number }[]
}

const kindOf = (identifier: string) => identifier.slice(0, identifier.indexOf(':'))
const clamp = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p))

/**
 * Fits each kind's weight to pairs checked by hand, by maximum likelihood
 * under the same formula the graph scores with. Unlike `measure`, it uses
 * pairs that share several kinds at once, so a kind that mostly appears next
 * to a stronger one is not credited with the stronger one's accuracy.
 *
 * Score the pairs with `policy` first, with `related: 0` so weak pairs are
 * kept. Where the policy groups kinds, a pair teaches only the kind that
 * counts for it. `prior` pulls each weight toward its current value; raise it when
 * there are few pairs.
 */
export function fit(labeled: readonly Labeled[], policy: Policy, prior = 1): Fitted {
  // Each reason's evidence is its kind's weight times a multiplier for sharing and time. Keep the multipliers.
  const pairs = labeled.map(({ reasons, same }) => ({
    same,
    parts: reasons
      .filter((reason) => policy.kinds[kindOf(reason.identifier)] && policy.kinds[kindOf(reason.identifier)]!.weight > 0)
      .map((reason) => ({ kind: kindOf(reason.identifier), group: policy.kinds[kindOf(reason.identifier)]!.group, multiplier: Math.min(1, reason.evidence / policy.kinds[kindOf(reason.identifier)]!.weight) })),
  }))
  const kinds = [...new Set(pairs.flatMap((pair) => pair.parts.map((part) => part.kind)))].sort()
  const logit = (w: number) => Math.log(clamp(w) / (1 - clamp(w)))
  const start = Object.fromEntries(kinds.map((kind) => [kind, logit(policy.kinds[kind]!.weight)]))
  const weight = (kind: string, from: Record<string, number>) => 1 / (1 + Math.exp(-from[kind]!))

  type Part = { kind: string; group: string | undefined; multiplier: number }
  /** The parts that count under the given weights: of each group, only the strongest. */
  const counting = (parts: readonly Part[], from: Record<string, number>): readonly Part[] => {
    if (parts.every((part) => part.group === undefined)) return parts
    const best = new Map<string, Part>()
    const strength = (part: Part) => weight(part.kind, from) * part.multiplier
    for (const part of parts) if (part.group !== undefined && !(best.has(part.group) && strength(best.get(part.group)!) >= strength(part))) best.set(part.group, part)
    return parts.filter((part) => part.group === undefined || best.get(part.group) === part)
  }
  const predict = (parts: readonly Part[], from: Record<string, number>) => {
    let coincidence = 1
    for (const part of counting(parts, from)) coincidence *= 1 - weight(part.kind, from) * part.multiplier
    return 1 - coincidence
  }
  const loss = (from: Record<string, number>) => {
    let total = 0
    for (const pair of pairs) {
      const p = clamp(predict(pair.parts, from))
      total -= pair.same ? Math.log(p) : Math.log(1 - p)
    }
    return pairs.length > 0 ? total / pairs.length : 0
  }

  const count = Math.max(1, pairs.length)
  /** What is minimized: the loss, and how far the weights have gone from where they began. */
  const cost = (from: Record<string, number>) => loss(from) + (prior / count) * kinds.reduce((sum, kind) => sum + (from[kind]! - start[kind]!) ** 2, 0)

  // Adam: plain descent crawls when a weight starts near 0 or 1, where the logistic is flat.
  const descend = (from: Record<string, number>) => {
    const theta = { ...from }
    const mean = Object.fromEntries(kinds.map((kind) => [kind, 0]))
    const spread = Object.fromEntries(kinds.map((kind) => [kind, 0]))
    for (let step = 1; step <= 3000; step++) {
      const gradient = Object.fromEntries(kinds.map((kind) => [kind, (2 * prior * (theta[kind]! - start[kind]!)) / count]))
      for (const pair of pairs) {
        const p = clamp(predict(pair.parts, theta))
        const pull = (pair.same ? -1 / p : 1 / (1 - p)) / count
        for (const part of counting(pair.parts, theta)) {
          const w = weight(part.kind, theta)
          // d(score)/d(weight) for this reason, then through the logistic.
          gradient[part.kind]! += pull * ((part.multiplier * (1 - p)) / clamp(1 - w * part.multiplier)) * w * (1 - w)
        }
      }
      for (const kind of kinds) {
        mean[kind] = 0.9 * mean[kind]! + 0.1 * gradient[kind]!
        spread[kind] = 0.999 * spread[kind]! + 0.001 * gradient[kind]! ** 2
        theta[kind]! -= (0.02 * (mean[kind]! / (1 - 0.9 ** step))) / (Math.sqrt(spread[kind]! / (1 - 0.999 ** step)) + 1e-9)
      }
    }
    return theta
  }
  // A kind that another of its group always outweighs is never moved by the pairs. So each grouped kind also gets a start
  // in which the rest of its group is faint, so that it has a chance to win, and the best of the ends is kept.
  const groupOf = (kind: string) => policy.kinds[kind]!.group
  const starts = [start, ...kinds.filter((kind) => kinds.some((other) => other !== kind && groupOf(kind) !== undefined && groupOf(other) === groupOf(kind))).map((kind) => ({ ...start, ...Object.fromEntries(kinds.filter((other) => groupOf(other) === groupOf(kind)).map((other) => [other, logit(other === kind ? 0.9 : 0.01)])) }))]
  const theta = starts.map(descend).reduce((best, next) => (cost(next) < cost(best) ? next : best))

  const fitted: Policy = { ...policy, kinds: { ...policy.kinds } }
  const report: Fitted['kinds'] = {}
  for (const kind of kinds) {
    const after = Math.round(weight(kind, theta) * 1000) / 1000
    ;(fitted.kinds as Record<string, Policy['kinds'][string]>)[kind] = { ...policy.kinds[kind]!, weight: after }
    report[kind] = { before: policy.kinds[kind]!.weight, after, pairs: pairs.filter((pair) => pair.parts.some((part) => part.kind === kind)).length }
  }

  const buckets = Array.from({ length: 5 }, (_, i) => ({ from: i / 5, to: (i + 1) / 5, pairs: 0, predicted: 0, actual: 0 }))
  for (const pair of pairs) {
    const p = predict(pair.parts, theta)
    const bucket = buckets[Math.min(4, Math.floor(p * 5))]!
    bucket.pairs += 1
    bucket.predicted += p
    bucket.actual += pair.same ? 1 : 0
  }
  for (const bucket of buckets) {
    if (bucket.pairs === 0) continue
    bucket.predicted /= bucket.pairs
    bucket.actual /= bucket.pairs
  }
  return { policy: fitted, kinds: report, loss: { before: loss(start), after: loss(theta) }, calibration: buckets.filter((bucket) => bucket.pairs > 0) }
}
